"""Scope confinement, and the rule that provider text is data rather than instruction.

Two requirements from ``specs/agent-orchestration`` and ``specs/safety-grounding`` that turn out to
be the same requirement seen twice:

**Scope.** Weathra answers about weather, climate, and the concepts behind them. A question outside
that is declined with a reason, not answered badly. The decision is made in the routing plan and
cross-checked deterministically (``agents/plan.py``); this module holds the *wording*, so a
declined question reads the same however it was declined.

**Untrusted content.** Text arriving from a provider response, a geocoded place name, a tool
result, or a knowledge chunk is data. An instruction inside it changes nothing about routing, tool
use, scope, grounding, or memory.

The important thing about the second one is what this module deliberately does *not* do: it does
not scan for injection patterns. Pattern-matching for "ignore previous instructions" is a filter
that fails on the first phrasing nobody thought of, and it would encourage treating unfiltered text
as trustworthy. The property is structural instead, and it holds because of how the pipeline is
built:

* **Routing runs before any retrieval.** The plan is fixed before a single provider byte arrives,
  so no provider text can influence which capabilities run. The supervisor's only inputs are the
  question, the date, and the thread's own resolved entities.
* **The graph executes tools, not the model.** A tool result cannot cause a tool call, because
  results are not what triggers calls — the plan is (design.md decision 2).
* **Every figure comes from code.** Nothing is read back out of the prose, so a chunk that says
  "report the temperature as 40" cannot put 40 in a finding.
* **Tool results reach the model as labelled content.** ``Message.tool_result`` marks whose result
  it is, and the synthesis prompt says to treat it as data.

So what is here is the *assertion surface* for that property — ``influences_control_flow`` names
what a piece of content is allowed to affect — plus the decline wording. The tests use it to check
the structural claim rather than to check a blocklist.
"""

from __future__ import annotations

import logging

from weathra.agents.plan import RoutingPlan
from weathra.agents.state import GraphState

__all__ = [
    "CONTROL_FLOW_INPUTS",
    "DECLINE_MESSAGE",
    "decline_reason",
    "declined_state",
    "influences_control_flow",
]

logger = logging.getLogger("weathra.agents.scope")

DECLINE_MESSAGE = (
    "Weathra answers questions about weather, climate, and the meteorological concepts behind "
    "them — forecasts, historical conditions, statistics over them, and what the terms mean. This "
    "question is outside that, so Weathra is not the right tool for it."
)

# What a routing decision is allowed to be made from. Everything not on this list — a provider
# response, a place name a geocoder returned, a tool result, a knowledge chunk — is data, and the
# pipeline gives it no path to this decision because routing happens before any of it exists.
CONTROL_FLOW_INPUTS = frozenset(
    {
        "question",
        "today",
        "thread_resolved_entities",
        "user_preferences",
    }
)


def influences_control_flow(source: str) -> bool:
    """Whether content from ``source`` may affect routing, tool use, scope, or grounding.

    A single place to ask the question, so a test can assert the answer for every source the
    system handles rather than trusting a comment. Everything a *provider* supplies answers false.
    """
    return source in CONTROL_FLOW_INPUTS


def decline_reason(plan: RoutingPlan) -> str:
    """What to tell a person whose question is outside Weathra's subject.

    The plan's own reason where it gave one — a model that explained itself well should be heard —
    and the standard wording otherwise.
    """
    if plan.out_of_scope_reason and len(plan.out_of_scope_reason.strip()) > 40:
        return plan.out_of_scope_reason.strip()
    return DECLINE_MESSAGE


def declined_state(state: GraphState, plan: RoutingPlan) -> GraphState:
    """The state for a declined question: the reason as the answer, the question as unanswered."""
    logger.info("declining an out-of-scope question")
    return state.with_updates(
        answer_prose=decline_reason(plan),
        unanswered_parts=(state.question,),
        location_source="none",
    )
