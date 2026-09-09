"""Task 32.6 to 32.8 — one comparison, several candidates, everything else held still.

`specs/evaluation` is precise about what a candidate comparison is and is not. It is the *existing*
dataset, runner and metric definitions applied once per candidate. It is not a separate procedure
with its own scoring, because a second scoring path is a second set of numbers that will eventually
disagree with the first, and the disagreement will surface as a promotion decision nobody can
defend.

So this module is deliberately thin. It selects the cases **once**, snapshots the configuration
**once**, and calls `execute_run` per candidate with the model as the only thing that differs. What
it adds is the three things a comparison needs and a single run does not:

* **the pinned configuration, stated once** — dataset version, weather fixtures, corpus, embedding
  model, analytics and commit belong to the comparison rather than to each candidate, and a record
  that repeated them per candidate could not prove they were the same;
* **isolation of failure** — a candidate that raises or times out is recorded as that candidate's
  outcome and the comparison continues, because the point of comparing four models is not lost
  when one of them is broken;
* **the five criteria** — `evaluation/criteria.py` computes them from what each run recorded, and
  the comparison reports them side by side.

**Nothing here chooses a model.** It produces evidence; promotion is a separate authorized write
(`specs/model-lab`). The two are kept apart on purpose: a comparison that could promote would make
"the lab changed production" a thing that can happen by accident.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.domain.errors import ValidationFailed
from weathra.entitlements.records import CatalogEntry
from weathra.evaluation.cases import DATASET_VERSION, EvaluationCase
from weathra.evaluation.criteria import SelectionCriteria, compute_criteria
from weathra.evaluation.metrics import CaseOutcome
from weathra.evaluation.provisioning import EvaluationMode
from weathra.evaluation.runner import RunResult, execute_run, select_cases
from weathra.lab.compare import resolve_candidates

__all__ = [
    "CandidateOutcome",
    "ModelComparison",
    "PinnedConfiguration",
    "compare_candidates",
    # Re-exported: candidate resolution belongs to `lab/` because the administrative router needs
    # it and may not reach this package, and a caller here should not have to know that.
    "resolve_candidates",
]

logger = logging.getLogger("weathra.evaluation.model_compare")


class PinnedConfiguration(BaseModel):
    """Everything a comparison holds fixed, stated once for the whole run.

    Once, and not per candidate, because that is the claim: two candidates scored against
    different fixtures are not comparable, and a record that repeated the fields per candidate
    could describe that state without contradicting itself.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset_version: str
    mode: EvaluationMode
    weather_provider: str
    embedding_model: str
    commit_sha: str | None = None
    category_filter: str | None = None
    case_filter: str | None = None
    case_ids: tuple[str, ...] = Field(
        default=(), description="The exact cases every candidate ran, in order."
    )


class CandidateOutcome(BaseModel):
    """One candidate's whole showing: its run, its criteria, or the failure that stopped it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str
    gateway_model: str
    completed: bool
    criteria: SelectionCriteria | None = None
    metrics: dict[str, float | None] = Field(default_factory=dict)
    cases_scored: int = Field(default=0, ge=0)
    passed: bool | None = None
    failure: str | None = Field(
        default=None,
        description="The failure classification, where the candidate did not complete. Never a "
        "provider's message, which may carry a payload.",
    )


class ModelComparison(BaseModel):
    """A whole comparison: what was held fixed, and what each candidate did with it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    configuration: PinnedConfiguration
    candidates: tuple[CandidateOutcome, ...]
    started_at: datetime
    completed_at: datetime
    budget_exhausted: bool = Field(
        default=False,
        description="Whether the wall-clock budget stopped the comparison before every candidate "
        "ran. The result is partial and names what completed.",
    )

    @property
    def is_partial(self) -> bool:
        return self.budget_exhausted or any(not item.completed for item in self.candidates)

    def completed_keys(self) -> tuple[str, ...]:
        return tuple(item.catalog_key for item in self.candidates if item.completed)

    def differences(self, first: str, second: str) -> dict[str, dict[str, float | None]]:
        """Each recorded measure's difference between two candidates.

        `specs/model-lab` asks for the difference per measure rather than a verdict, and the
        distinction is the point: a difference is a measured fact, and which of two models is
        better is a judgement somebody has to make and record.
        """
        left = self._candidate(first)
        right = self._candidate(second)
        measures = sorted(set(left.metrics) | set(right.metrics))
        return {
            measure: {
                first: left.metrics.get(measure),
                second: right.metrics.get(measure),
                "difference": _difference(left.metrics.get(measure), right.metrics.get(measure)),
            }
            for measure in measures
        }

    def _candidate(self, catalog_key: str) -> CandidateOutcome:
        for item in self.candidates:
            if item.catalog_key == catalog_key:
                return item
        raise KeyError(f"{catalog_key!r} was not a candidate in this comparison.")


def _difference(left: float | None, right: float | None) -> float | None:
    """Null where either side is unmeasured. Subtracting from an absence invents a number."""
    if left is None or right is None:
        return None
    return right - left


# =========================================================================== the comparison


async def compare_candidates(
    settings: Settings,
    candidates: Sequence[CatalogEntry],
    *,
    mode: EvaluationMode = EvaluationMode.OFFLINE,
    category: str | None = None,
    case_id: str | None = None,
    cases: Sequence[EvaluationCase] | None = None,
    time_budget_seconds: float | None = None,
) -> ModelComparison:
    """Run every candidate over the same cases and score each with the existing metrics.

    The bounds are enforced by the caller that has the settings to enforce them with
    (`lab/compare.py`); what this enforces is the wall clock, because only the loop knows how much
    of it is left. A budget reached mid-comparison stops before the next candidate and returns a
    partial result naming what completed — never a truncated candidate scored as though it had
    finished, which would be a fabricated measurement.
    """
    selected = (
        tuple(cases) if cases is not None else select_cases(category=category, case_id=case_id)
    )
    if not selected:
        raise ValidationFailed(
            "The selection matched no evaluation case.", details={"field": "cases"}
        )

    started = datetime.now(UTC)
    deadline = (time.monotonic() + time_budget_seconds) if time_budget_seconds else None
    outcomes: list[CandidateOutcome] = []
    exhausted = False
    pinned: PinnedConfiguration | None = None

    for entry in candidates:
        if deadline is not None and time.monotonic() >= deadline:
            exhausted = True
            logger.info("comparison budget reached; %d candidate(s) ran", len(outcomes))
            break

        outcome, configuration = await _run_candidate(
            settings,
            entry,
            mode=mode,
            category=category,
            case_id=case_id,
            cases=selected,
        )
        outcomes.append(outcome)
        pinned = pinned or configuration

    return ModelComparison(
        configuration=pinned
        or PinnedConfiguration(
            dataset_version=DATASET_VERSION,
            mode=mode,
            weather_provider=settings.default_weather_provider,
            embedding_model=settings.embedding_model_id,
            category_filter=category,
            case_filter=case_id,
            case_ids=tuple(case.case_id for case in selected),
        ),
        candidates=tuple(outcomes),
        started_at=started,
        completed_at=datetime.now(UTC),
        budget_exhausted=exhausted,
    )


async def _run_candidate(
    settings: Settings,
    entry: CatalogEntry,
    *,
    mode: EvaluationMode,
    category: str | None,
    case_id: str | None,
    cases: Sequence[EvaluationCase],
) -> tuple[CandidateOutcome, PinnedConfiguration | None]:
    """One candidate's run, with its failure caught rather than propagated.

    `specs/evaluation`: a model that fails or times out does not abort the comparison. Caught
    broadly on purpose — the failure of one candidate is data about that candidate, and letting it
    end the comparison would throw away the three results that did complete.

    Only the exception *type* is recorded. A provider's message can carry a payload, and a
    comparison record is read by people and archived by CI.
    """
    try:
        result = await execute_run(
            settings,
            mode=mode,
            category=category,
            case_id=case_id,
            # Both halves of the same pin: the catalog key is what a live run resolves through
            # (validated against the catalog, no plan read), and the gateway identifier is what an
            # offline run records so a candidate's results are attributed to that candidate.
            pinned_catalog_key=entry.catalog_key,
            pinned_model=entry.gateway_model,
            cases=cases,
        )
    except asyncio.CancelledError:  # pragma: no cover - a cancelled comparison is not a candidate
        raise
    except Exception as failure:
        logger.warning(
            "candidate %s did not complete: %s", entry.catalog_key, type(failure).__name__
        )
        return (
            CandidateOutcome(
                catalog_key=entry.catalog_key,
                gateway_model=entry.gateway_model,
                completed=False,
                failure=type(failure).__name__,
            ),
            None,
        )

    return (
        CandidateOutcome(
            catalog_key=entry.catalog_key,
            gateway_model=entry.gateway_model,
            completed=True,
            criteria=compute_criteria(
                catalog_key=entry.catalog_key,
                gateway_model=result.configuration.llm_model or entry.gateway_model,
                outcomes=_outcomes_of(result),
                cases=cases,
                metrics=result.metrics,
                input_price_per_million=Decimal(str(entry.input_price_per_million)),
                output_price_per_million=Decimal(str(entry.output_price_per_million)),
                currency=entry.price_currency,
            ),
            metrics={name: result.metrics.results[name].value for name in result.metrics.results},
            cases_scored=result.metrics.cases_scored,
            passed=result.thresholds.passed,
        ),
        PinnedConfiguration(
            dataset_version=result.configuration.dataset_version,
            mode=result.configuration.mode,
            weather_provider=result.configuration.weather_provider,
            embedding_model=result.configuration.embedding_model,
            commit_sha=result.configuration.commit_sha,
            category_filter=category,
            case_filter=case_id,
            case_ids=tuple(case.case_id for case in cases),
        ),
    )


def _outcomes_of(result: RunResult) -> tuple[CaseOutcome, ...]:
    """Rebuild the scoring records from what the run recorded.

    The runner keeps `CaseRecord`s, which are the archived shape; the criteria are computed from
    `CaseOutcome`s, which are the scoring shape. Rebuilding rather than re-executing is what makes
    a stored comparison re-scorable — the same property `specs/evaluation` asks of a stored run.
    """
    return tuple(
        CaseOutcome(
            case_id=record.case_id,
            category=record.category,
            answer=record.answer,
            latency_ms=record.latency_ms,
            http_status=record.http_status,
            error=record.error,
            inference_attempts=record.inference_attempts,
            tools_called=tuple(
                call.get("tool", "")
                for call in record.evidence.get("tool_calls", [])
                if isinstance(call, dict)
            ),
        )
        for record in result.cases
    )
