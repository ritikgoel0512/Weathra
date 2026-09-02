"""Assembling the evidence record and the answer envelope, and persisting the run.

``specs/agent-orchestration`` sets the bar for the record: the agents that ran and in what order,
each tool call with its arguments, each tool result, each analytics result with its method, each
retrieved chunk with its document identifier, the provider and model used, the data classes
involved, and per-step timings — *sufficient for a reader to verify every figure and claim in the
answer without re-running the question*.

That last clause is the design constraint. It is why the record carries the tool payloads rather
than a summary of them, and why a finding carries its method and point count rather than only its
value: "the mean was 11.9 °C over 7 days, arithmetic mean, 7 points used, 0 excluded" is checkable
and "the mean was 11.9 °C" is not.

**The envelope's division of labour.** ``answer_prose`` is the model's, labelled
``ai_interpretation``. Everything else — findings, units, attributions, resolved context,
uncertainty, the grounding report — was placed by code. Nothing is read back out of the prose.

**Persistence is owned by the acting user.** The ``agent_runs`` row goes in through the
ownership-enforcing repository under the request session, so the owner is the token's subject and
Row Level Security applies behind it. The write is wrapped in a savepoint: an evidence record that
fails to store must not take the answer down with it, because the person asked about the weather
and got an answer.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.agents.state import GraphState
from weathra.db.models import AgentRun
from weathra.domain.evidence import (
    AnswerEnvelope,
    EvidenceRecord,
    GroundingReport,
    ResolvedContext,
)
from weathra.domain.identity import Principal
from weathra.domain.weather import UncertaintyStatement
from weathra.memory.availability import reporting_unavailable

__all__ = ["assemble_envelope", "build_record", "persist_run"]

logger = logging.getLogger("weathra.agents.evidence")


def build_record(
    state: GraphState,
    *,
    provider_id: str | None,
    model_id: str | None,
    completed_at: datetime | None = None,
) -> EvidenceRecord:
    """Everything the run did, in the shape a reader can check it from."""
    finished = completed_at or datetime.now(UTC)

    return EvidenceRecord(
        request_id=state.request_id,
        thread_id=state.thread_id,
        question=state.question,
        routing_reason=_routing_reason(state),
        routing_source=state.routing_source,
        agents=state.agent_steps,
        tool_calls=state.tool_calls,
        tool_results=state.tool_results,
        # The statistic, anomaly, and trend objects live inside the tool payloads on
        # ``tool_results``, which is where a reader following a figure back will look for them.
        # Duplicating them into typed tuples here would mean two copies that can disagree.
        analytics_results=(),
        anomaly_reports=(),
        trend_reports=(),
        citations=state.citations,
        attributions=state.attributions,
        data_classes=state.data_classes,
        llm_provider=provider_id,
        llm_model=model_id,
        started_at=state.started_at,
        completed_at=finished,
        total_duration_ms=max(0.0, (finished - state.started_at).total_seconds() * 1000.0),
        steps_used=state.steps_used,
        partial=state.partial,
        partial_reason=state.partial_reason,
    )


def _routing_reason(state: GraphState) -> str | None:
    """The supervisor's own stated reason, from the step it recorded."""
    for step in state.agent_steps:
        if step.agent.value == "supervisor":
            return step.reason
    return state.plan.reason if state.plan else None


def assemble_envelope(
    state: GraphState,
    *,
    grounding: GroundingReport,
    record: EvidenceRecord,
    uncertainty: UncertaintyStatement | None = None,
    provider_id: str | None = None,
    model_id: str | None = None,
) -> AnswerEnvelope:
    """The response, with every field placed by code except the prose."""
    return AnswerEnvelope(
        request_id=state.request_id,
        thread_id=state.thread_id,
        answer_prose=state.answer_prose,
        findings=state.findings,
        uncertainty=uncertainty,
        attribution=state.attributions,
        resolved=_resolved_context(state),
        grounding=grounding,
        evidence=record,
        clarification_question=state.clarification_question,
        unanswered_parts=_unanswered(state),
        llm_provider=provider_id,
        llm_model=model_id,
    )


def _resolved_context(state: GraphState) -> ResolvedContext:
    """What the run decided the question was about, and where each part came from."""
    period = state.period
    if period is None:
        for retrieval in state.retrievals:
            if retrieval.period is not None:
                period = retrieval.period
                break

    return ResolvedContext(
        locations=state.locations,
        period=period,
        unit_system=state.unit_system.value,
        criterion=state.plan.steps[0].criterion.value
        if state.plan and state.plan.steps and state.plan.steps[0].criterion
        else None,
        location_source=state.location_source,
        units_source=state.units_source,
        statement=state.context_statement,
    )


def _unanswered(state: GraphState) -> tuple[str, ...]:
    """Named unanswered parts and recorded failures, de-duplicated, in order.

    Both, because they are the same thing to a reader: a part of the question that has no answer.
    One came from the plan and one from a step that could not complete, and silently dropping
    either is what ``specs/agent-orchestration`` forbids.
    """
    seen: list[str] = []
    for entry in (*state.unanswered_parts, *state.failures):
        if entry and entry not in seen:
            seen.append(entry)
    return tuple(seen)


async def persist_run(
    session: AsyncSession,
    principal: Principal,
    envelope: AnswerEnvelope,
    *,
    weather_provider: str | None = None,
) -> str | None:
    """Store the run under the acting user, returning its id.

    **Owned by the token's subject, never by anything a caller supplied.** The user id comes from
    the principal, and the request session's Row Level Security is the second gate behind that.

    Wrapped in a savepoint on purpose: the person asked about the weather and has an answer. An
    evidence record that cannot be stored is worth logging and worth reporting as a missing
    evidence id — it is not worth failing the answer over, and without the savepoint a constraint
    violation here would abort the request's whole transaction.
    """
    run = AgentRun(
        user_id=principal.user_id,
        thread_id=envelope.thread_id,
        request_id=envelope.request_id,
        question=envelope.evidence.question,
        answer_prose=envelope.answer_prose or None,
        envelope=_jsonable(envelope, exclude={"evidence"}),
        evidence=_jsonable(envelope.evidence),
        llm_provider=envelope.llm_provider,
        llm_model=envelope.llm_model,
        weather_provider=weather_provider or _first_provider(envelope),
        duration_ms=envelope.evidence.total_duration_ms,
        partial=envelope.evidence.partial,
    )

    try:
        async with reporting_unavailable("agent_runs"), session.begin_nested():
            session.add(run)
            await session.flush()
    except Exception:
        logger.exception("the evidence record for %s could not be stored", envelope.request_id)
        return None

    logger.info("stored evidence record %s for %s", run.id, principal)
    return run.id


def _jsonable(model: BaseModel, *, exclude: set[str] | None = None) -> dict[str, Any]:
    """A model as JSON-safe primitives, for a JSONB column."""
    dumped: dict[str, Any] = model.model_dump(mode="json", exclude=exclude or set())
    return dumped


def _first_provider(envelope: AnswerEnvelope) -> str | None:
    """The weather provider the run used, for the row's own column."""
    return envelope.attribution[0].provider if envelope.attribution else None
