"""Task 32.5 — initiating a comparison, and reading one back.

Three routes. The interesting one is the first, and what makes it interesting is the order it does
things in:

1. **resolve the candidates** against the catalog — an absent or disabled entry is refused here,
   with a structured error naming the reason, *before* a client exists;
2. **check the bounds** — too many models or too many cases is refused, naming the bound;
3. **admit against the internal allowance** — a lab run is internal traffic and is refused with the
   standard quota error when that allowance is spent;
4. **only then** build clients and call a gateway.

`specs/model-lab` requires "no language model call is made" for a selection outside the allowlist,
and that is only true because steps 1 to 3 come first and each of them raises. An implementation
that built the clients up front and validated afterwards would satisfy every test about the
response and none about the bill.

**The lab writes its records administratively and runs its cells as the administrator.** Those are
two different sessions on purpose: the run and result rows are operational, and the request role
holds `SELECT` on them and nothing else, so persistence is privileged like every other
administrative write. The *cells* are ordinary agent runs and use the administrator's own
restricted session, so Row Level Security applies to them exactly as to any request — which is
what `specs/model-lab` means by "the lab bypasses no security control".
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Inference, Places, Quota, Tools, engines_of
from weathra.api.middleware import annotate
from weathra.api.routers.admin.deps import AdministrativeSession
from weathra.auth.deps import AdministrativePrincipal
from weathra.auth.profiles import ensure_profile
from weathra.auth.rls import session_for
from weathra.db.session import request_session
from weathra.domain.entitlements import LAB_COMPARISON_POLICY, CallRole, Resolution
from weathra.domain.errors import NotFound
from weathra.domain.usage import UsageEvent
from weathra.entitlements.quotas import QuotaSubject
from weathra.lab.compare import (
    CandidateRun,
    LabRunner,
    resolve_candidates,
    select_lab_cases,
)
from weathra.lab.records import ComparisonResultRecord, ComparisonRunRecord, LabRecords
from weathra.telemetry.usage import BackgroundUsageRecorder, record_events

__all__ = ["router"]

logger = logging.getLogger("weathra.api.admin.lab")

router = APIRouter(prefix="/admin", tags=["administration"])

RunId = Annotated[str, Path(min_length=1, max_length=64, description="A comparison run.")]


class LabRunRequest(BaseModel):
    """What to compare, and over what.

    Named ``LabRun...`` rather than ``Comparison...`` because ``routers/comparison.py`` already
    publishes a ``ComparisonRequest`` for comparing *places*. Two schemas with one name are
    mangled into module paths in the generated contract, which is neither a legal TypeScript
    identifier nor a name anyone would want on a screen's props.

    Exactly one of *question* or a dataset selection. Not both, because a comparison that ran an
    ad-hoc question *and* a dataset subset would produce two incomparable halves under one run
    identifier, and a reader could not tell which half a figure came from.
    """

    model_config = ConfigDict(extra="forbid")

    catalog_keys: tuple[str, ...] = Field(min_length=1, max_length=10)
    question: str | None = Field(default=None, min_length=1, max_length=2_000)
    category: str | None = None
    case_id: str | None = None


class LabRunResponse(BaseModel):
    """A run and its results, as an administrator reads them."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run: ComparisonRunRecord
    partial: bool = Field(
        default=False,
        description="Whether a bound stopped the run before every cell completed. The completed "
        "cells are the results below; nothing is estimated for the rest.",
    )
    completed_cells: tuple[str, ...] = ()


class LabRunListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    runs: tuple[ComparisonRunRecord, ...]


@router.post(
    "/lab/comparisons",
    response_model=LabRunResponse,
    status_code=201,
    summary="Run one question or dataset subset across several models",
)
async def start_comparison(
    request: Request,
    body: LabRunRequest,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    inference: Inference,
    tools: Tools,
    geocoder: Places,
    quota: Quota,
) -> LabRunResponse:
    """Compare the selected models, and record what each one did.

    Every call this makes is internal usage attributed to the initiating administrator: the quota
    subject is the internal one, the allowance spent is the internal allowance, and no product
    plan's consumption changes.
    """
    annotate(request, acting_user_id=principal.user_id)

    # 1. The allowlist. Refused before a client exists, so no gateway call is made.
    candidates = await resolve_candidates(session, catalog_keys=body.catalog_keys)

    # 2. The bounds. Also before anything runs.
    settings = inference.settings
    runner = LabRunner(settings)
    plan = runner.plan(
        candidates=candidates,
        question=body.question,
        category=body.category,
        case_id=body.case_id,
    )

    # 3. The internal allowance. A lab run is internal traffic, so it is admitted as the internal
    #    subject and refused with the standard quota error when that allowance is spent.
    admission = await quota.admit(QuotaSubject.internal())

    questions: dict[str, str] = {}
    if plan.question is None:
        questions = {
            case.case_id: case.questions[0]
            for case in select_lab_cases(category=body.category, case_id=body.case_id)
            if case.questions
        }

    records = LabRecords(session)
    run_id = await records.open_run(
        initiated_by=principal.user_id,
        candidate_catalog_keys=plan.candidate_catalog_keys,
        catalog_state={
            entry.catalog_key: {
                "gateway_model": entry.gateway_model,
                "status": entry.status.value,
                "capability_tier": entry.capability_tier.value,
            }
            for entry in candidates
        },
        dataset_version=plan.dataset_version,
        question=plan.question,
        commit_sha=None,
    )

    engines = engines_of(request)
    recorder: BackgroundUsageRecorder = request.app.state.usage_recorder
    emitted: list[UsageEvent] = []

    def record(events: Sequence[UsageEvent]) -> None:
        """Collect the lab's usage events, and write them the way the request path does.

        Collected as well as written because the run record references them: `specs/model-lab`
        requires a result to name the usage events it produced, and reading them back out of the
        table afterwards would be a second query racing a background write.
        """
        emitted.extend(events)

        async def write(batch: Sequence[UsageEvent]) -> int:
            async with request_session(
                engines.request_sessionmaker,
                claims=principal.claims,
                restricted_role=settings.database_restricted_role,
            ) as own:
                await ensure_profile(own, principal)
                return await record_events(own, batch)

        recorder.schedule(events, write)

    try:
        clients = {
            entry.catalog_key: inference.lab_client(
                _lab_resolution(entry.catalog_key, entry.gateway_provider, entry.gateway_model),
                principal=principal,
                run_id=run_id,
                recorder=record,
            )
            for entry in candidates
        }
        # The administrator's own restricted session, so the cells run under the same policies as
        # any request. Never the administrative one they were authorized with.
        async with session_for(engines, principal) as own:
            comparison = await runner.execute(
                plan,
                principal=principal,
                clients=clients,
                tools=tools,
                geocoder=geocoder,
                questions=questions,
                context=None,
                time_budget_seconds=settings.model_lab_time_budget_seconds,
            )
            del own  # opened so the cells run under it; the graph holds no session of its own

        for cell in comparison.runs:
            await records.record_result(run_id, _result_of(cell, emitted))
        await records.close_run(run_id, status=comparison.status)
    finally:
        await quota.finish(admission, reached_gateway=bool(emitted))

    written = await records.run(run_id)
    assert written is not None  # opened a moment ago in this transaction
    return LabRunResponse(
        run=written,
        partial=comparison.status == "partial",
        completed_cells=comparison.completed_cells(),
    )


@router.get(
    "/lab/comparisons",
    response_model=LabRunListResponse,
    summary="List recent model comparisons",
)
async def list_comparisons(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> LabRunListResponse:
    annotate(request, acting_user_id=principal.user_id)
    runs = await LabRecords(session).runs(limit=limit)
    return LabRunListResponse(count=len(runs), runs=runs)


@router.get(
    "/lab/comparisons/{run_id}",
    response_model=LabRunResponse,
    summary="Read one comparison and its per-model results",
)
async def read_comparison(
    request: Request,
    run_id: RunId,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
) -> LabRunResponse:
    """One run's results, readable after a compared model has been disabled.

    That is the point of keeping them: "what did this model score before we withdrew it" is the
    question a withdrawal makes people ask.
    """
    annotate(request, acting_user_id=principal.user_id)
    found = await LabRecords(session).run(run_id)
    if found is None:
        raise NotFound("No comparison run with that identifier.", details={"run_id": run_id})
    return LabRunResponse(
        run=found,
        partial=found.status == "partial",
        completed_cells=tuple(f"{result.catalog_key}:{result.case_id}" for result in found.results),
    )


def _lab_resolution(catalog_key: str, provider: str, model: str) -> Resolution:
    """The resolution a lab cell records: a pinned model, and a context that is not a policy.

    ``LAB_COMPARISON_POLICY`` rather than a real policy identifier, because a comparison names its
    model directly. Recording a policy here would make an aggregate report the model as serving a
    plan it has never been mapped to.
    """
    return Resolution(
        policy_id=LAB_COMPARISON_POLICY,
        catalog_key=catalog_key,
        gateway_provider=provider,
        gateway_model=model,
        reason="model lab comparison: the model was named by the administrator, not resolved",
        call_role=CallRole.SYNTHESIS,
    )


def _result_of(cell: CandidateRun, emitted: Sequence[UsageEvent]) -> ComparisonResultRecord:
    """One cell, as the record keeps it. Unmeasured stays unmeasured.

    Tokens and cost come from the usage events this cell produced, summed rather than counted
    again — `specs/llm-telemetry` records them once, and a second count would be a second set of
    numbers to disagree with. A cell whose gateway reported no tokens records null, not zero: it
    has not been shown to have used none.
    """
    mine = [
        event
        for event in emitted
        if event.request_id is not None and event.catalog_key == cell.catalog_key
    ]
    prompt = _summed(event.prompt_tokens for event in mine)
    completion = _summed(event.completion_tokens for event in mine)
    total = _summed(event.total_tokens for event in mine)
    costs = [event.estimated_cost for event in mine if event.estimated_cost is not None]

    return ComparisonResultRecord(
        catalog_key=cell.catalog_key,
        gateway_model=cell.gateway_model,
        case_id=cell.case_id,
        policy_id=cell.policy_id or str(LAB_COMPARISON_POLICY),
        latency_ms=cell.latency_ms,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        estimated_cost=sum(costs, Decimal(0)) if costs else None,
        succeeded=cell.succeeded,
        usage_event_ids=tuple(event.event_id for event in mine),
        agent_run_id=cell.agent_run_id,
    )


def _summed(values: Iterable[int | None]) -> int | None:
    """The sum, or ``None`` where nothing reported a count. Never a zero standing in for silence."""
    present = [value for value in values if value is not None]
    return sum(present) if present else None
