"""The supervisor: the one node where the model gets to decide anything.

Design.md decision 2. The model is asked for a routing plan as a JSON object validated against
``RoutingPlan``. It is not asked *how* to retrieve or compute; it is asked which capabilities the
question needs, in what order, and why. Everything the plan says is then executed by code.

**Three outcomes, in order of preference.**

1. A valid plan. Recorded with ``routing_source = "model"`` and the model's own reason.
2. An invalid plan, corrected on retry. ``complete_json`` handles this: it sends the validation
   error back and spends another attempt, bounded by ``LLM_JSON_MAX_ATTEMPTS``. A capability
   outside the catalog lands here — the enum rejects it, and the error the model gets back lists
   the four valid names (``specs/agent-orchestration``: an out-of-catalog request returns an error
   rather than executing anything).
3. Repeated failure, or no model at all. The deterministic keyword router runs and the record says
   ``deterministic_fallback``. The person gets an answer; the reader gets told how it was routed.

**The scope cross-check runs one way only.** A model that declares a question out of scope is not
taken at its word when the question is plainly about weather — that would let a weak model refuse
"will it rain in Berlin tomorrow?". It does *not* run the other way. Overriding a model that
decided a question *is* in scope would mean a keyword list vetoing a language model at the one
thing a language model is better at: "Berlin for two days?" contains no weather word at all and is
obviously a forecast question, and a vocabulary check confident enough to refuse it would refuse a
great many real questions.

The asymmetry is the point, and it follows from which error costs more. A false "in scope" spends
one retrieval on a question that turns out not to need it, and the synthesis prompt still confines
the answer. A false "out of scope" refuses a question Weathra could have answered, which is the
failure a person actually notices. So the check only ever moves toward answering — and a run with
no model still declines non-weather questions, because the deterministic router makes that
judgement itself.

**The system prompt names the catalog and nothing else.** No model identifier, no vendor
vocabulary, no tool-calling protocol — the capabilities and their parameters, which is the whole of
what a routing decision needs.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from weathra.agents.llm.base import LLMClient, Message
from weathra.agents.plan import (
    Capability,
    RoutingPlan,
    fallback_plan,
    looks_like_weather,
)
from weathra.agents.state import GraphState
from weathra.domain.errors import (
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    ValidationFailed,
)
from weathra.domain.evidence import AgentName, AgentStep, StepStatus

__all__ = ["ROUTING_SYSTEM_PROMPT", "catalog_capabilities", "route"]

logger = logging.getLogger("weathra.agents.supervisor")

ROUTING_SYSTEM_PROMPT = """\
You are the routing supervisor for Weathra, a weather intelligence service. You decide which of \
Weathra's capabilities a question needs. You do not answer the question, retrieve any data, or \
compute anything: other components do that, deterministically.

The capabilities available to you, and nothing else:

- "forecast" — current conditions and forecasts for the days ahead, for one or more places.
  Parameters: location or locations, days (1-16), criterion (for a comparison).
- "historical" — observed weather over a past date range, from the archive.
  Parameters: location or locations, start_date and end_date (ISO dates).
- "analytics" — deterministic statistics over a series another step retrieved: means, extremes,
  percentiles, totals, trends, anomalies. Parameters: statistics, measure. Set
  uses_previous_result to true, because analytics always computes over an earlier step's data.
- "rag" — explains a meteorological concept from Weathra's knowledge base.
  Parameters: concept.

Rules:

- Route only to those four names. Anything else will be rejected.
- Order the steps as they must run. An analytics step must come after the step whose data it uses,
  with uses_previous_result set to true.
- Steps that are independent of each other may share the same parallel_group integer, and will
  then run concurrently. Never put a step in the same group as a step it depends on.
- For a multi-part question, add one step per part and set question_part to the part it answers.
- If part of the question is something no capability above can address, list it in
  unanswerable_parts. Do not invent a capability for it, and do not silently ignore it.
- If the question is not about weather, climate, or the concepts behind them, set in_scope to
  false, give out_of_scope_reason, and route to nothing.
- Give a short reason for each step and for the plan as a whole. A person may read them.
"""


def _plan_request(state: GraphState, *, today: datetime) -> list[Message]:
    """The conversation the routing decision is made from.

    The date is supplied because "tomorrow" and "last week" are unanswerable without it, and a
    model asked to guess at today's date will guess.
    """
    context: dict[str, object] = {"today": today.date().isoformat()}
    if state.locations:
        # Context from a previous turn, so a follow-up can be routed without re-stating the place.
        context["locations_already_established"] = [
            location.qualified_name for location in state.locations
        ]
    if state.thread_id:
        context["is_follow_up"] = True

    return [
        Message.user(f"Context: {json.dumps(context)}"),
        Message.user(f"Question: {state.question}"),
    ]


async def route(
    state: GraphState,
    *,
    client: LLMClient | None,
    now: datetime | None = None,
) -> GraphState:
    """Decide which capabilities the question needs, and record how the decision was made.

    ``client`` may be ``None``: the deterministic router then runs on its own. That is how offline
    evaluation and a memory-degraded run still route, and it keeps "the model influences routing"
    from becoming "the model is required to route".
    """
    moment = now or datetime.now(UTC)
    started = moment
    plan: RoutingPlan | None = None
    source = "deterministic_fallback"
    attempts = 0
    note: str | None = None

    if client is not None:
        attempts = 1
        try:
            plan = await client.complete_json(
                system=ROUTING_SYSTEM_PROMPT,
                messages=_plan_request(state, today=moment),
                schema=RoutingPlan,
            )
            source = "model"
        except ValidationFailed as exc:
            # Every bounded retry inside complete_json is spent. The question still gets answered.
            note = f"The model could not produce a valid plan ({exc}); routed deterministically."
            logger.warning("routing fell back to the deterministic router: %s", exc)
        except (ProviderTimeout, ProviderRateLimited, ProviderUnavailable) as exc:
            note = f"The inference provider was unavailable ({exc.code}); routed deterministically."
            logger.warning("routing fell back to the deterministic router: %s", exc.code)

    if plan is None:
        plan = fallback_plan(state.question, now=moment)

    plan, override = _cross_check_scope(state.question, plan)
    if override:
        note = f"{note + ' ' if note else ''}{override}"

    reason = plan.reason if note is None else f"{plan.reason} {note}"
    step = AgentStep(
        sequence=state.next_step_sequence,
        agent=AgentName.SUPERVISOR,
        status=StepStatus.SUCCEEDED,
        started_at=started,
        duration_ms=max(0.0, (datetime.now(UTC) - started).total_seconds() * 1000.0),
        reason=reason,
    )

    logger.info(
        "routed via %s to %s",
        source,
        ", ".join(capability.value for capability in plan.capabilities) or "nothing",
    )

    return state.with_step(step).with_updates(
        plan=plan,
        routing_source=source,
        routing_attempts=attempts,
        unanswered_parts=plan.unanswerable_parts,
    )


def _cross_check_scope(question: str, plan: RoutingPlan) -> tuple[RoutingPlan, str | None]:
    """Override a refusal the question plainly contradicts. Never the other way.

    See the module docstring: a weak model refusing "will it rain in Berlin tomorrow?" is a bad
    answer to a good question, and that is the error worth correcting. A model that decided a
    question *is* in scope is left alone, because a keyword list is not better than a language
    model at reading a question — and "Berlin for two days?" has no weather word in it.
    """
    if not plan.in_scope and looks_like_weather(question):
        logger.info("overriding an out-of-scope decision: the question uses weather vocabulary")
        return (
            fallback_plan(question),
            "The model judged this out of scope, but the question is about weather, so Weathra "
            "answered it.",
        )

    return plan, None


def catalog_capabilities() -> tuple[str, ...]:
    """The capability names the supervisor offers. Used by the catalog-constraint tests."""
    return tuple(capability.value for capability in Capability)
