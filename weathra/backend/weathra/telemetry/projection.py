"""Turning a recorded inference attempt into a usage event, and computing nothing twice.

Task 29.9 states the rule this module exists to keep: *project* the attempts the run already
recorded rather than deriving a second, parallel record. The evidence record's `InferenceAttempt`
is the authority for what happened — stage, attempt number, outcome, provider, selected and served
model, provider status, latency — and the model policy layer already enriched each one with the
policy, catalog key and plan that produced it.

So this module reads. It does not resolve a plan, look up a policy, consult the catalog for a
model, or re-classify a failure. Each of those would be a second derivation of a fact that already
exists, and the two would agree right up until the catalog changed — at which point telemetry would
start describing *the decision it would make now* rather than the one that actually happened.

The one thing it computes is cost, and only because cost is not a decision: it is arithmetic over
token counts the gateway reported and the price the catalog held at the time. The price has to be
passed in for exactly that reason.

**What it deliberately cannot carry.** There is no parameter here for prompt text, completion text
or a retrieved passage, and `UsageEvent` forbids unknown fields. A table with no content in it
cannot leak content, and the way that is kept true is that the function which fills it has nowhere
to put any.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from weathra.domain.entitlements import CONFIGURED_FALLBACK_POLICY, CallRole, PlanCode, PolicyId
from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.domain.usage import FailureClass, SubjectKind, UsageEvent, UsageStatus
from weathra.telemetry.context import CallContext
from weathra.telemetry.cost import estimate

__all__ = ["FAILURE_BY_STATUS", "project_attempt", "project_run"]

# How an inference outcome maps onto the telemetry classification. Two vocabularies exist because
# they answer different questions — `InferenceStatus` is what the *run* saw, `FailureClass` is how
# a failure is *counted* — and this table is the single place they meet, so a status added to one
# cannot silently acquire a meaning in the other.
FAILURE_BY_STATUS: dict[InferenceStatus, FailureClass] = {
    InferenceStatus.TIMEOUT: FailureClass.TIMEOUT,
    InferenceStatus.RATE_LIMITED: FailureClass.GATEWAY_RATE_LIMIT,
    InferenceStatus.MODEL_UNAVAILABLE: FailureClass.TRANSPORT,
    InferenceStatus.PROVIDER_ERROR: FailureClass.TRANSPORT,
    InferenceStatus.INVALID_OUTPUT: FailureClass.SCHEMA_VALIDATION,
    InferenceStatus.NOT_CONFIGURED: FailureClass.AUTH_CONFIG,
}

# The call role each recorded stage belongs to. `InferenceStage` and `CallRole` carry the same two
# names on purpose (design.md decision 22), and mapping them here rather than assuming the strings
# match keeps a rename in one from silently mis-attributing every event.
ROLE_BY_STAGE: dict[InferenceStage, CallRole] = {
    InferenceStage.ROUTING: CallRole.ROUTING,
    InferenceStage.SYNTHESIS: CallRole.SYNTHESIS,
}


def project_attempt(
    attempt: InferenceAttempt,
    context: CallContext,
    *,
    input_price_per_million: Decimal | None = None,
    output_price_per_million: Decimal | None = None,
    price_currency: str | None = None,
    pricing_recorded_on: date | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    total_tokens: int | None = None,
    event_id: str | None = None,
    retried_event_id: str | None = None,
    created_at: datetime | None = None,
) -> UsageEvent | None:
    """One recorded attempt as one usage event, or ``None`` where there is nothing to record.

    ``None`` for an attempt that never reached a gateway — a run with no inference credential
    records a `NOT_CONFIGURED` attempt so the evidence record can say why the prose was
    code-written, and no gateway call happened, so there is no *usage* to account for. Writing a
    row for it would put a call that never occurred into a call count.

    Token counts arrive as arguments rather than being read off the attempt, because the attempt
    does not carry them: the gateway reports usage on the completion, and only the client that made
    the call ever sees it. Unknown stays ``None`` all the way down, and never becomes zero.
    """
    if attempt.status is InferenceStatus.NOT_CONFIGURED:
        return None
    if attempt.provider is None:
        # Nothing was called. The evidence record still carries the attempt; usage does not.
        return None

    role = ROLE_BY_STAGE.get(attempt.stage)
    if role is None:  # pragma: no cover - both stages are mapped above
        return None

    served = attempt.status is InferenceStatus.SERVED
    cost = estimate(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        input_price_per_million=input_price_per_million,
        output_price_per_million=output_price_per_million,
        currency=price_currency,
    )

    return UsageEvent(
        event_id=event_id or str(uuid.uuid4()),
        user_id=context.user_id,
        subject_kind=context.subject_kind,
        agent_run_id=context.agent_run_id,
        request_id=context.request_id,
        # Straight from the attempt the model policy layer already enriched. Nothing here asks the
        # catalog what the model *is now*.
        catalog_key=attempt.catalog_key or context.catalog_key,
        gateway_provider=attempt.provider,
        gateway_model=attempt.served_model or attempt.selected_model or context.gateway_model,
        policy_id=PolicyId(attempt.policy_id) if attempt.policy_id else CONFIGURED_FALLBACK_POLICY,
        plan=_plan_of(attempt, context),
        call_role=role,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        estimated_cost=cost.amount if cost else None,
        cost_currency=cost.currency if cost else None,
        pricing_date=pricing_recorded_on if cost else None,
        latency_ms=attempt.latency_ms if attempt.latency_ms is not None else 0.0,
        status=UsageStatus.SUCCESS if served else UsageStatus.FAILURE,
        failure_class=None if served else _failure_of(attempt.status),
        attempt=attempt.attempt_number,
        retried_event_id=retried_event_id,
        created_at=created_at or datetime.now(UTC),
    )


def _plan_of(attempt: InferenceAttempt, context: CallContext) -> PlanCode | None:
    """The plan the call was made under, or ``None`` where the event is internal.

    An internal event carries no plan by construction — `UsageEvent` refuses one — because internal
    work is accounted against the internal allowance and must never be attributed to a tier.
    """
    if context.subject_kind is SubjectKind.INTERNAL or context.user_id is None:
        return None
    recorded = attempt.plan or (context.plan.value if context.plan else None)
    return PlanCode(recorded) if recorded else PlanCode.FREE


def _failure_of(status: InferenceStatus) -> FailureClass:
    """The telemetry classification of a non-served outcome.

    Defaults to ``UNCLASSIFIED`` rather than guessing: a status this table does not know about is
    a failure whose kind nobody has decided yet, and saying so is more useful than assigning it to
    whichever neighbour looks closest.
    """
    return FAILURE_BY_STATUS.get(status, FailureClass.UNCLASSIFIED)


def project_run(
    attempts: tuple[InferenceAttempt, ...], context: CallContext
) -> tuple[UsageEvent, ...]:
    """Every recorded attempt of one run, as events, in the order they happened.

    One event per attempt, which is what makes a failover legible afterwards: a run whose first
    candidate timed out and whose second answered produces two rows, and the pair reconstructs the
    call. Collapsing them would hide the outage and misreport the latency of the answer.

    Token counts and pricing are absent here on purpose. This is the projection an
    already-completed run produces from its evidence record — the per-call path that *does* see the
    gateway's usage is `agents/llm/instrumented.py`, which projects the same way with the numbers
    filled in. Both go through `project_attempt`, so the two cannot classify the same attempt
    differently.
    """
    events: list[UsageEvent] = []
    for attempt in attempts:
        event = project_attempt(attempt, context)
        if event is not None:
            events.append(event)
    return tuple(events)
