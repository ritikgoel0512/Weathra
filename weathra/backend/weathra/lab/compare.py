"""Task 32.1, 32.3 and 32.4 — running a comparison so that only the model varies.

**What "only the model varies" costs, and why it is worth it.** Three candidates asked the same
question by three independent runs are not comparable: each resolves its own location, fetches its
own forecast, and computes its own figures, so a difference between them may be a difference in the
weather rather than in the model. So an ad-hoc comparison retrieves **once** and replays that
retrieval to every candidate, and a dataset comparison runs over one selection of cases fixed
before the first candidate starts. The pinned configuration is recorded once for the whole run,
because a record that repeated it per candidate could not prove it was the same.

**Bounds are refusals, not truncations — except the clock, which is a partial result.** Too many
models or too many cases is refused before anything runs, naming the bound, because the caller can
fix it and re-ask. The wall clock cannot be known in advance, so exhausting it stops the comparison
between candidates and returns what completed. Never mid-candidate: a candidate scored over half
its cases is a fabricated measurement wearing a real number.

**A candidate that fails does not end the comparison.** Its failure is that candidate's outcome for
those cases, which is a result rather than an absence of one.

**No privilege of its own.** The comparison runs the graph the way a request does, on the
administrator's own restricted session, and reads the dataset and fixtures. It never reads another
person's question, thread, memory, preference, saved location, evidence record or usage event —
there is no code path here that could, which is asserted over the source rather than promised.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.context import ContextSources
from weathra.agents.graph import RunDependencies, run_agent
from weathra.agents.llm.base import LLMClient
from weathra.agents.state import GraphState
from weathra.config import Settings
from weathra.domain.entitlements import CallRole
from weathra.domain.errors import ValidationFailed, WeathraError
from weathra.domain.evidence import InferenceStatus
from weathra.domain.identity import Principal
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.policies import PolicyStore
from weathra.entitlements.records import CatalogEntry, CatalogStatus
from weathra.evaluation.cases import DATASET_VERSION, Category, EvaluationCase, load_dataset
from weathra.geocoding.base import Geocoder
from weathra.mcp.client import McpToolClient

__all__ = [
    "CandidateRun",
    "ComparisonPlan",
    "LabComparison",
    "LabRunner",
    "resolve_candidates",
    "select_lab_cases",
]

logger = logging.getLogger("weathra.lab.compare")

# The identifier an ad-hoc question's single case is recorded under, so a result row always names a
# case and a reader can tell the two shapes apart at a glance.
AD_HOC_CASE_ID = "ad-hoc"


class ComparisonPlan(BaseModel):
    """What a comparison will do, checked against the bounds before it does any of it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    candidate_catalog_keys: tuple[str, ...]
    case_ids: tuple[str, ...]
    question: str | None = None
    dataset_version: str | None = None
    category: str | None = None

    @property
    def cells(self) -> int:
        return len(self.candidate_catalog_keys) * len(self.case_ids)


class CandidateRun(BaseModel):
    """One candidate's outcome on one case, as the lab measured it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str
    gateway_model: str
    case_id: str
    succeeded: bool
    latency_ms: float | None = None
    answer: str = ""
    policy_id: str | None = None
    failure_code: str | None = Field(
        default=None,
        description="The WeathraError code, or the exception type. Never a provider's message.",
    )
    attempts: int = Field(default=0, ge=0)
    served_attempts: int = Field(default=0, ge=0)
    agent_run_id: str | None = None


class LabComparison(BaseModel):
    """A whole comparison: the plan it ran, what each cell did, and whether it finished."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    plan: ComparisonPlan
    runs: tuple[CandidateRun, ...]
    started_at: datetime
    completed_at: datetime
    budget_exhausted: bool = False

    @property
    def status(self) -> str:
        """The status the run record is closed with.

        ``partial`` where the clock stopped it or a candidate produced nothing; ``failed`` only
        where *nothing* completed, because a comparison in which one of four models worked has
        told you something and calling that a failure would be wrong.
        """
        if not any(run.succeeded for run in self.runs):
            return "failed"
        if self.budget_exhausted or len(self.runs) < self.plan.cells:
            return "partial"
        return "completed"

    def completed_cells(self) -> tuple[str, ...]:
        """Which model-and-case results completed, named — what a partial result must report."""
        return tuple(f"{run.catalog_key}:{run.case_id}" for run in self.runs)


@dataclass(frozen=True, slots=True)
class _SharedRetrieval:
    """One retrieval, replayed to every candidate.

    The whole reason an ad-hoc comparison is fair. Held as the *question* plus the tools and
    geocoder the first run used, so every candidate asks the same upstream and the cache answers
    the second and third from what the first fetched — which is what makes "every model saw the
    same retrieved data" true rather than likely.
    """

    question: str
    tools: McpToolClient
    geocoder: Geocoder


def select_lab_cases(
    *, category: str | None = None, case_id: str | None = None
) -> tuple[EvaluationCase, ...]:
    """The dataset subset a comparison will run, resolved once for every candidate.

    Its own function rather than the runner's `select_cases` because the lab refuses differently:
    a category nobody has is a caller error with a structured message here, where in a CI run it
    is a crash nobody sees until the log.
    """
    cases = load_dataset()
    if category is not None:
        try:
            wanted = Category(category)
        except ValueError:
            raise ValidationFailed(
                f"{category!r} is not an evaluation category.",
                details={
                    "field": "category",
                    "known": sorted(item.value for item in Category),
                },
            ) from None
        cases = tuple(case for case in cases if case.category is wanted)
    if case_id is not None:
        cases = tuple(case for case in cases if case.case_id == case_id)

    if not cases:
        raise ValidationFailed(
            "The selection matched no evaluation case.",
            details={"field": "cases", "category": category, "case_id": case_id},
        )
    return cases


async def resolve_candidates(
    session: AsyncSession,
    *,
    catalog_keys: Sequence[str] | None = None,
    policy_id: str | None = None,
) -> tuple[CatalogEntry, ...]:
    """The catalog entries a comparison will run, from an explicit set or from a policy.

    `specs/evaluation` requires the runner to accept either. A policy's candidates are read
    through the group 27 store rather than assembled here, so the set a comparison evaluates is
    the set the resolver would actually walk.

    Refuses an absent or disabled entry with a structured error naming the reason, and refuses it
    *before* anything is executed — `specs/model-lab` requires no gateway call to be made for a
    selection outside the allowlist, which is only true if the check comes first.
    """
    if (catalog_keys is None) == (policy_id is None):
        raise ValidationFailed(
            "A comparison names either a set of catalog entries or one policy, and exactly one.",
            details={"field": "candidates"},
        )

    catalog = CatalogStore(session)
    if policy_id is not None:
        policy = await PolicyStore(session).require(policy_id)
        wanted: Sequence[str] = policy.candidate_catalog_keys
    else:
        assert catalog_keys is not None  # the exclusive check above
        wanted = catalog_keys

    if not wanted:
        raise ValidationFailed(
            "A comparison needs at least one candidate.", details={"field": "candidates"}
        )

    resolved: list[CatalogEntry] = []
    for key in wanted:
        entry = await catalog.get(key)
        if entry is None:
            raise ValidationFailed(
                f"{key!r} is not in the model catalog, so it cannot be compared.",
                details={"field": "candidates", "catalog_key": key, "reason": "absent"},
            )
        if entry.status is not CatalogStatus.ENABLED:
            raise ValidationFailed(
                f"{key!r} is {entry.status.value} in the catalog, so it cannot be compared.",
                details={
                    "field": "candidates",
                    "catalog_key": key,
                    "reason": "disabled",
                    "status": entry.status.value,
                },
            )
        resolved.append(entry)
    return tuple(resolved)


class LabRunner:
    """Runs a comparison within the configured bounds.

    Holds no session and no principal: it is handed the candidates, the clients and the graph's
    dependencies, and it runs them. Persistence and authorization belong to its callers, which is
    what lets the whole matrix be exercised with fake clients and no database.
    """

    __slots__ = ("_settings",)

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    # ---------------------------------------------------------------- the bounds

    def plan(
        self,
        *,
        candidates: Sequence[CatalogEntry],
        question: str | None = None,
        category: str | None = None,
        case_id: str | None = None,
    ) -> ComparisonPlan:
        """Check the bounds and fix the selection, before anything is executed.

        Both refusals name the bound and the request, so a caller can correct it rather than
        bisect it. `specs/model-lab` requires the refusal to happen before any gateway call, which
        is only true because this runs first and raises.
        """
        if not candidates:
            raise ValidationFailed(
                "A comparison needs at least one candidate.", details={"field": "candidates"}
            )
        if len(candidates) > self._settings.model_lab_max_models:
            raise ValidationFailed(
                f"A comparison may put at most {self._settings.model_lab_max_models} models "
                f"against each other; {len(candidates)} were selected.",
                details={
                    "field": "candidates",
                    "bound": "model_lab_max_models",
                    "limit": self._settings.model_lab_max_models,
                    "requested": len(candidates),
                },
            )
        if (question is None) == (category is None and case_id is None):
            raise ValidationFailed(
                "A comparison runs one ad-hoc question or a dataset selection, and exactly one.",
                details={"field": "question"},
            )

        case_ids: tuple[str, ...]
        if question is not None:
            case_ids = (AD_HOC_CASE_ID,)
            dataset_version = None
        else:
            cases = select_lab_cases(category=category, case_id=case_id)
            if len(cases) > self._settings.model_lab_max_cases:
                raise ValidationFailed(
                    f"A comparison may run at most {self._settings.model_lab_max_cases} cases per "
                    f"candidate; the selection holds {len(cases)}.",
                    details={
                        "field": "cases",
                        "bound": "model_lab_max_cases",
                        "limit": self._settings.model_lab_max_cases,
                        "requested": len(cases),
                    },
                )
            case_ids = tuple(case.case_id for case in cases)
            dataset_version = DATASET_VERSION

        return ComparisonPlan(
            candidate_catalog_keys=tuple(entry.catalog_key for entry in candidates),
            case_ids=case_ids,
            question=question,
            dataset_version=dataset_version,
            category=category,
        )

    # ---------------------------------------------------------------- the run

    async def execute(
        self,
        plan: ComparisonPlan,
        *,
        principal: Principal,
        clients: dict[str, LLMClient],
        tools: McpToolClient,
        geocoder: Geocoder,
        questions: dict[str, str] | None = None,
        context: ContextSources | None = None,
        time_budget_seconds: float | None = None,
    ) -> LabComparison:
        """Run every cell of the matrix, or as many as the clock allows.

        *principal* is the initiating administrator, and every cell runs as them.
        `specs/model-lab` requires the lab to execute "under the same authentication,
        authorization, ownership, and Row Level Security rules as any other request" — so it acts
        as somebody, and the only defensible somebody is the person who asked for it.

        *clients* is one already-bound client per candidate, built by the caller from the catalog
        entry. The graph is handed a bound client rather than a broker on purpose: a lab run
        compares *named* models, so nothing here may resolve one — and `RunDependencies.llm` is
        the seam that already means "somebody chose this before the run began".
        """
        started = datetime.now(UTC)
        budget = time_budget_seconds or self._settings.model_lab_time_budget_seconds
        deadline = time.monotonic() + budget
        asked = questions or {}
        runs: list[CandidateRun] = []
        exhausted = False

        for catalog_key in plan.candidate_catalog_keys:
            client = clients.get(catalog_key)
            if client is None:  # pragma: no cover - the router builds one per candidate
                raise ValidationFailed(
                    f"No client was built for {catalog_key!r}.",
                    details={"field": "candidates", "catalog_key": catalog_key},
                )

            for case_id in plan.case_ids:
                if time.monotonic() >= deadline:
                    exhausted = True
                    logger.info("lab budget of %.0fs reached after %d cell(s)", budget, len(runs))
                    break

                question = plan.question if case_id == AD_HOC_CASE_ID else asked.get(case_id)
                if question is None:  # pragma: no cover - the caller supplies one per case
                    continue
                runs.append(
                    await self._cell(
                        catalog_key=catalog_key,
                        case_id=case_id,
                        question=question,
                        principal=principal,
                        client=client,
                        tools=tools,
                        geocoder=geocoder,
                        context=context,
                    )
                )
            if exhausted:
                break

        return LabComparison(
            plan=plan,
            runs=tuple(runs),
            started_at=started,
            completed_at=datetime.now(UTC),
            budget_exhausted=exhausted,
        )

    async def _cell(
        self,
        *,
        catalog_key: str,
        case_id: str,
        question: str,
        principal: Principal,
        client: LLMClient,
        tools: McpToolClient,
        geocoder: Geocoder,
        context: ContextSources | None,
    ) -> CandidateRun:
        """One model, one case. A failure here is this cell's outcome and nothing else's.

        Caught broadly and recorded as a classification rather than a message: a provider's text
        can carry a payload, and a comparison record is read by people and archived.
        """
        began = time.perf_counter()
        state = GraphState.begin(
            question=question,
            request_id=f"lab-{catalog_key}-{case_id}",
            principal=principal,
            thread_id=None,
            requested_unit_system=None,
            started_at=datetime.now(UTC),
        )
        dependencies = RunDependencies(
            settings=self._settings,
            tools=tools,
            geocoder=geocoder,
            # A bound client, never a broker: a lab run compares named models, so nothing in it
            # may resolve one.
            llm=client,
            context=context,
        )

        try:
            result = await run_agent(state, dependencies)
        except WeathraError as failure:
            return CandidateRun(
                catalog_key=catalog_key,
                gateway_model=client.model_id,
                case_id=case_id,
                succeeded=False,
                latency_ms=(time.perf_counter() - began) * 1000.0,
                failure_code=failure.code,
            )
        except Exception as failure:
            logger.warning(
                "lab cell %s:%s failed: %s", catalog_key, case_id, type(failure).__name__
            )
            return CandidateRun(
                catalog_key=catalog_key,
                gateway_model=client.model_id,
                case_id=case_id,
                succeeded=False,
                latency_ms=(time.perf_counter() - began) * 1000.0,
                failure_code=type(failure).__name__,
            )

        attempts = result.envelope.evidence.inference_attempts
        return CandidateRun(
            catalog_key=catalog_key,
            gateway_model=client.model_id,
            case_id=case_id,
            succeeded=True,
            latency_ms=(time.perf_counter() - began) * 1000.0,
            answer=result.envelope.answer_prose,
            policy_id=next((attempt.policy_id for attempt in attempts if attempt.policy_id), None),
            attempts=len(attempts),
            served_attempts=sum(
                1 for attempt in attempts if attempt.status is InferenceStatus.SERVED
            ),
        )


def call_roles() -> tuple[CallRole, ...]:
    """The roles a lab client must satisfy. Both, because the graph asks for both."""
    return (CallRole.ROUTING, CallRole.SYNTHESIS)
