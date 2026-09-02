"""The run: route, resolve, execute the plan, synthesize, check grounding, assemble.

This is the orchestration design.md decision 2 describes, in the order it describes it. The model
influences two things — the routing plan and the wording — and nothing else. Every figure, label,
unit, attribution, and data class in the result was placed by code between those two points.

**Why an explicit sequence rather than a LangGraph node graph.** The stages here are strictly
ordered and every branch is data-dependent, not structural: route, resolve, then execute whatever
the plan said, then synthesize. Expressing that as nodes and conditional edges would add a
declaration layer whose only job is to reproduce this order, and would put the parallel-group
scheduling — which is the one genuinely interesting bit of control flow — behind an abstraction
that makes it harder to read. LangGraph earns its place in the *checkpointer* (design.md decision
11), which is where the library does something a hand-rolled version would get wrong. It is not
load-bearing for a linear pipeline, and pretending otherwise would be architecture for its own
sake.

**Parallel where the plan says so.** Independent steps in the same group run concurrently through
``asyncio.gather``; a step that uses a previous result always starts a new batch. Concurrency is
safe because nodes return new states rather than mutating one, so the results are merged
afterwards rather than raced into.

**Every exit is labelled.** Out of scope, a clarifying question, a budget exhausted, a part that
nothing could answer, a provider that failed mid-run — each produces an envelope that says which
it was. There is no path that returns a confident answer to a question the run could not address.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from weathra.agents.budget import Budget
from weathra.agents.context import ContextSources, resolve_context
from weathra.agents.evidence import assemble_envelope, build_record
from weathra.agents.grounding import check_grounding
from weathra.agents.llm.base import LLMClient
from weathra.agents.nodes.analytics import run_analytics
from weathra.agents.nodes.knowledge import KnowledgeRetriever, run_knowledge
from weathra.agents.nodes.retrieval import run_forecast, run_historical
from weathra.agents.nodes.support import record_step
from weathra.agents.nodes.synthesize import synthesize
from weathra.agents.observer import RunObserver
from weathra.agents.plan import Capability, PlanStep
from weathra.agents.safety import assess
from weathra.agents.scope import declined_state
from weathra.agents.state import GraphState
from weathra.agents.supervisor import route
from weathra.config import Settings
from weathra.domain.evidence import AgentName, AnswerEnvelope, GroundingReport, StepStatus
from weathra.domain.weather import DataClass, UncertaintyStatement
from weathra.geocoding.base import Geocoder
from weathra.mcp.client import McpToolClient
from weathra.memory.degradation import MemoryStatus
from weathra.weather.uncertainty import describe_uncertainty_for

__all__ = ["AgentRunResult", "RunDependencies", "run_agent"]

logger = logging.getLogger("weathra.agents.graph")


@dataclass(frozen=True, slots=True)
class RunDependencies:
    """Everything a run needs from outside. Most of it is optional, and each absence is meaningful.

    * no ``llm`` — no inference credential: routing is deterministic and the prose is code-written;
    * no ``knowledge`` — no knowledge store reachable: a conceptual step reports that;
    * no ``context`` stores — an unauthenticated or memory-degraded run: defaults apply and the
      answer says so.
    """

    settings: Settings
    tools: McpToolClient
    geocoder: Geocoder
    llm: LLMClient | None = None
    knowledge: KnowledgeRetriever | None = None
    context: ContextSources | None = None


@dataclass(frozen=True, slots=True)
class AgentRunResult:
    """The envelope, and the state it came from for a caller that wants to record more."""

    envelope: AnswerEnvelope
    state: GraphState
    memory: MemoryStatus

    @property
    def grounding(self) -> GroundingReport:
        return self.envelope.grounding


async def run_agent(
    state: GraphState,
    dependencies: RunDependencies,
    *,
    now: datetime | None = None,
    observer: RunObserver | None = None,
) -> AgentRunResult:
    """Answer one question, and return an envelope that says exactly what happened.

    ``observer`` witnesses the run's progress for the streaming endpoint. It is a Protocol
    (``agents/observer.py``) rather than the SSE emitter itself, because the graph sits below the
    API layer and an orchestration that knew about server-sent events could only be used behind
    one. It cannot influence the run: every call returns ``None`` and none is awaited.
    """
    started = now or state.started_at
    # The wall-clock bound measures *real* elapsed time, so it starts here rather than from
    # ``state.started_at``. The two are the same in production; they differ when a caller supplies
    # a fixed logical instant, and a budget that treated a logical timestamp as a stopwatch would
    # declare a run out of time before it began.
    budget = Budget.from_settings(dependencies.settings)

    # ---------------------------------------------------------------- route
    working = await route(state, client=dependencies.llm, now=started)
    budget.spend()
    plan = working.plan
    if plan is None:  # pragma: no cover - `route` always sets a plan
        raise RuntimeError("routing produced no plan, which route() is required to prevent")

    if observer is not None:
        observer.routing(
            capabilities=[capability.value for capability in plan.capabilities],
            source=working.routing_source,
            reason=plan.reason,
        )

    if not plan.in_scope:
        # Declined before anything is retrieved, so there is no figure to be mistaken for an
        # answer to a question Weathra does not cover.
        return _finish(declined_state(working, plan), dependencies, declined=True)

    # ---------------------------------------------------------------- resolve
    resolution = await resolve_context(
        working, plan, geocoder=dependencies.geocoder, sources=dependencies.context
    )
    working = resolution.state

    if resolution.needs_clarification:
        # Asked rather than assumed. No capability runs, and no figure is produced to be mistaken
        # for an answer to the question that was not asked.
        return _finish(working, dependencies, memory=resolution.memory, asked=True)

    # ---------------------------------------------------------------- execute
    for group in plan.execution_groups():
        state_of_budget = budget.check()
        if state_of_budget.exhausted:
            working = _mark_partial(working, plan, group, state_of_budget.reason)
            break

        working = await _run_group(working, group, dependencies, observer)
        budget.spend(len(group))

    working = working.with_updates(steps_used=budget.steps_used)

    # ---------------------------------------------------------------- synthesize
    # Assessed from the question *and* from what was actually retrieved: the referral depends on
    # the question, and whether a severity claim is permitted depends on the data
    # (``agents/safety.py``).
    safety = assess(working.question, retrieved_fields=_retrieved_field_names(working))

    if observer is not None:
        observer.agent_start(AgentName.SYNTHESIS.value)
    working = await synthesize(working, client=dependencies.llm, safety=safety)
    if observer is not None:
        _report_last_step(observer, working)
        if working.answer_prose:
            observer.answer_delta(working.answer_prose)

    return _finish(working, dependencies, memory=resolution.memory)


# =========================================================================== execution


async def _run_group(
    state: GraphState,
    group: tuple[PlanStep, ...],
    dependencies: RunDependencies,
    observer: RunObserver | None = None,
) -> GraphState:
    """Run one batch of steps, concurrently when there is more than one.

    Concurrent steps each start from the same state and return their own; the results are merged
    afterwards. That is only safe because nodes never mutate — which is why ``GraphState``'s
    accumulators all return copies.
    """
    if len(group) == 1:
        return await _run_step(state, group[0], dependencies, observer)

    logger.info("running %d steps concurrently", len(group))
    results = await asyncio.gather(
        *(_run_step(state, step, dependencies, observer) for step in group),
        return_exceptions=False,
    )
    return _merge(state, tuple(results))


async def _run_step(
    state: GraphState,
    step: PlanStep,
    dependencies: RunDependencies,
    observer: RunObserver | None = None,
) -> GraphState:
    """Dispatch one plan step to its capability node, reporting its start and end."""
    if observer is not None:
        observer.agent_start(step.capability.value, reason=step.reason)

    finished = await _dispatch(state, step, dependencies)

    if observer is not None:
        _report_last_step(observer, finished)
        _report_new_tool_calls(observer, before=state, after=finished)
    return finished


async def _dispatch(state: GraphState, step: PlanStep, dependencies: RunDependencies) -> GraphState:
    """The capability node for one step."""
    if step.capability is Capability.FORECAST:
        return await run_forecast(state, step, client=dependencies.tools)

    if step.capability is Capability.HISTORICAL:
        return await run_historical(state, step, client=dependencies.tools)

    if step.capability is Capability.ANALYTICS:
        return await run_analytics(state, step, client=dependencies.tools)

    if step.capability is Capability.RAG:
        if dependencies.knowledge is None:
            return record_step(
                state.with_failure(
                    "Weathra's knowledge base is not available in this deployment, so the concept "
                    "could not be explained from it."
                ),
                agent=AgentName.RAG,
                started_at=datetime.now(UTC),
                status=StepStatus.SKIPPED,
                reason="No knowledge retriever is configured.",
            )
        return await run_knowledge(state, step, retrieve=dependencies.knowledge)

    # Unreachable while ``Capability`` is a closed enum, which is the point: a capability outside
    # the catalog cannot be parsed into a plan, so there is no path from a model's proposal to here.
    raise AssertionError(f"no node is registered for capability {step.capability!r}")


def _retrieved_field_names(state: GraphState) -> set[str]:
    """Every top-level field name the run's tool results carry.

    What the severity guard reads: a claim about how severe conditions will be is permitted only
    where the data carries a field describing it, and this is where "what fields does the data
    actually have" is answered.
    """
    names: set[str] = set()
    for result in state.tool_results:
        if result.ok and result.payload:
            names.update(result.payload)
    for payload in state.analytics_payloads:
        names.update(payload)
    return names


def _report_last_step(observer: RunObserver, state: GraphState) -> None:
    """Report the step a node just recorded, from the record rather than from a guess."""
    if not state.agent_steps:  # pragma: no cover - every node records one
        return
    step = state.agent_steps[-1]
    observer.agent_end(step.agent.value, status=step.status.value, duration_ms=step.duration_ms)


def _report_new_tool_calls(observer: RunObserver, *, before: GraphState, after: GraphState) -> None:
    """Report the calls a node made, read from what it recorded.

    After the fact rather than around each call, which costs an ordering nicety and buys something
    better: what is reported is exactly what went into the evidence record, so a client's progress
    log and the audit trail cannot disagree.
    """
    for call, result in zip(
        after.tool_calls[len(before.tool_calls) :],
        after.tool_results[len(before.tool_results) :],
        strict=True,
    ):
        observer.tool_start(call.tool, agent=call.agent.value)
        observer.tool_end(call.tool, ok=result.ok, duration_ms=call.duration_ms)


def _merge(base: GraphState, results: tuple[GraphState, ...]) -> GraphState:
    """Combine the states concurrent steps returned, keeping every record exactly once.

    Each result is ``base`` plus that step's own additions, so the merge takes the tail of each
    accumulator past what ``base`` already held. Renumbering the sequences afterwards keeps the
    evidence record's uniqueness invariant true — two steps that ran at once both thought they were
    next.
    """
    merged = base

    for result in results:
        for call, tool_result in zip(
            result.tool_calls[len(base.tool_calls) :],
            result.tool_results[len(base.tool_results) :],
            strict=True,
        ):
            sequence = merged.next_sequence
            merged = merged.with_tool_exchange(
                call.model_copy(update={"sequence": sequence}),
                tool_result.model_copy(update={"sequence": sequence}),
            )

        for retrieval in result.retrievals[len(base.retrievals) :]:
            merged = merged.with_retrieval(retrieval)

        findings = result.findings[len(base.findings) :]
        if findings:
            merged = merged.with_findings(findings)

        citations = result.citations[len(base.citations) :]
        if citations:
            merged = merged.with_citations(citations)

        for payload in result.analytics_payloads[len(base.analytics_payloads) :]:
            kind = str(payload.get("kind", "statistics"))
            merged = merged.with_analytics(kind, {k: v for k, v in payload.items() if k != "kind"})

        for failure in result.failures[len(base.failures) :]:
            merged = merged.with_failure(failure)

        for step in result.agent_steps[len(base.agent_steps) :]:
            merged = merged.with_step(
                step.model_copy(update={"sequence": merged.next_step_sequence})
            )

    return merged


def _mark_partial(
    state: GraphState,
    plan: object,
    unrun: tuple[PlanStep, ...],
    reason: str | None,
) -> GraphState:
    """Record that a bound stopped the run, and name the steps that did not get to run.

    Named rather than counted: "the historical part was not reached" tells a person what is missing
    from the answer, and "1 step skipped" does not.
    """
    skipped = tuple(
        step.question_part or f"the {step.capability.value} part of the question" for step in unrun
    )
    working = state.with_updates(
        partial=True,
        partial_reason=reason or "A bound was reached before the run completed.",
    )
    for part in skipped:
        working = working.with_failure(f"{part} was not reached before the run's limit.")
    return working


# =========================================================================== finishing


def _finish(
    state: GraphState,
    dependencies: RunDependencies,
    *,
    memory: MemoryStatus | None = None,
    declined: bool = False,
    asked: bool = False,
) -> AgentRunResult:
    """Check grounding, build the record, and assemble the envelope.

    A declined or clarifying run skips the grounding *audit* — there is no answer to audit — but
    still carries a report saying so, because an envelope with no grounding report would be an
    answer whose provenance was simply not stated.
    """
    provider_id = dependencies.llm.provider_id if dependencies.llm else None
    model_id = dependencies.llm.model_id if dependencies.llm else None

    if declined or asked:
        grounded = state
        report = GroundingReport(
            verified=True,
            method="No figures were produced, so there was nothing to ground.",
            figures_checked=0,
            note=(
                "Weathra declined this question as outside what it covers."
                if declined
                else "Weathra asked for a clarification instead of answering."
            ),
        )
    else:
        grounded, report = check_grounding(state)

    record = build_record(grounded, provider_id=provider_id, model_id=model_id)

    return AgentRunResult(
        envelope=assemble_envelope(
            grounded,
            grounding=report,
            record=record,
            uncertainty=_uncertainty_for(grounded),
            provider_id=provider_id,
            model_id=model_id,
        ),
        state=grounded,
        memory=memory or MemoryStatus(),
    )


def _uncertainty_for(state: GraphState) -> UncertaintyStatement | None:
    """An uncertainty statement whenever the answer contains a forecast figure.

    ``specs/forecast-analysis`` requires one for every forecast, and the envelope's own validator
    enforces it — so this is where "did this answer include a forecast" is decided, once.
    """
    forecasts = [
        retrieval
        for retrieval in state.retrievals
        if retrieval.data_class is DataClass.FORECAST and retrieval.series is not None
    ]
    if not forecasts:
        return None

    # The longest window, when several were retrieved: the horizon a reader should be warned about
    # is the furthest one any figure in the answer came from.
    furthest = max(forecasts, key=lambda retrieval: len(retrieval.series.entries))  # type: ignore[union-attr]
    return describe_uncertainty_for(
        furthest.series,  # type: ignore[arg-type]
        provider=furthest.provider,
        retrieved_at=furthest.retrieved_at,
    )
