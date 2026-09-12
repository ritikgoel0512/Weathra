"""The location-resolution precedence, walked directly and without a database.

`tests/integration/test_agent_memory.py` proves the same precedence *through a real run against
real stores*, which is the stronger test and the one that catches a store returning something the
walk did not expect. It is marked `db` and so runs only where a PostgreSQL is available.

This suite exists beside it because the precedence is a decision table, and a decision table wants
a test per row that can be run anywhere in under a second — including on a machine with no
database, which is where the Analyst's own changes get made. The stores are fakes here for exactly
that reason: what is under test is the *order*, not the reading.

The order, and the one thing each row is here to stop:

    request      a place in the question           — a stated place is never overridden
    focus        the conversation's FOCUS control  — a chosen place beats a remembered one
    thread       what an earlier turn resolved     — a conversation beats a months-old preference
    preferences  the saved default location        — used, and disclosed as a default
    none         a clarifying question             — never a plausible city picked quietly

The saved *locations* list appears nowhere in it, deliberately: see `agents/context.py`.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from tests.agent_support import BERLIN, MUNICH, StubGeocoder
from weathra.agents.context import ContextSources, resolve_context
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.agents.state import GraphState
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.preferences import PreferenceSource, PreferenceView
from weathra.memory.threads import ResolvedEntities

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=UTC)


def _principal() -> Principal:
    return Principal(user_id="00000000-0000-4000-8000-000000000001", claims={})


def _plan(*, location: str | None = None) -> RoutingPlan:
    """A one-step forecast plan, optionally naming a place the way the router would."""
    return RoutingPlan(
        reason="the question asks about the days ahead",
        steps=(
            PlanStep(
                capability=Capability.FORECAST,
                reason="the question asks about the days ahead",
                location=location,
                days=3,
            ),
        )
    )


def _state(question: str, *, focus: Location | None = None) -> GraphState:
    return GraphState.begin(
        question=question,
        request_id="req_precedence",
        principal=_principal(),
        focus=focus,
        started_at=NOW,
    )


class _Preferences:
    """A preference store that is only ever read, standing in for the real one."""

    def __init__(self, default_location: Location | None) -> None:
        self._view = PreferenceView(
            unit_system=UnitSystem.METRIC,
            forecast_horizon_days=7,
            default_location=default_location,
            sources={
                "unit_system": PreferenceSource.DEFAULT,
                "forecast_horizon_days": PreferenceSource.DEFAULT,
                "default_location": (
                    PreferenceSource.CHOSEN if default_location else PreferenceSource.DEFAULT
                ),
            },
        )

    @property
    def defaults(self) -> PreferenceView:
        return self._view

    async def read(self) -> PreferenceView:
        return self._view


class _Threads:
    """A thread store whose projection is whatever the row under test needs it to be."""

    def __init__(self, locations: tuple[Location, ...]) -> None:
        self._entities = ResolvedEntities(locations=locations)

    async def entities(self, thread_id: str) -> ResolvedEntities:
        return self._entities


def _sources(
    *, default: Location | None = None, thread: tuple[Location, ...] = ()
) -> ContextSources:
    return ContextSources(
        threads=_Threads(thread) if thread else None,  # type: ignore[arg-type]
        preferences=_Preferences(default),  # type: ignore[arg-type]
        thread_id="thread_1" if thread else None,
    )


async def _resolve(
    question: str,
    *,
    named: str | None = None,
    focus: Location | None = None,
    default: Location | None = None,
    thread: tuple[Location, ...] = (),
) -> GraphState:
    outcome = await resolve_context(
        _state(question, focus=focus),
        _plan(location=named),
        geocoder=StubGeocoder(),
        sources=_sources(default=default, thread=thread),
    )
    return outcome.state


# =========================================================================== one row each


async def test_a_place_in_the_question_wins_over_everything_else() -> None:
    """Every weaker source is present and set to Berlin; the question says Munich."""
    state = await _resolve(
        "How about Munich?", named="Munich", focus=BERLIN, default=BERLIN, thread=(BERLIN,)
    )

    assert state.location_source == "request"
    assert state.locations[0].is_same_place(MUNICH)
    assert state.clarification_question is None


async def test_the_focus_wins_over_the_thread_and_the_saved_default() -> None:
    """A place the person just chose beats two they are merely remembered by."""
    state = await _resolve(
        "What should I expect over the next few days?",
        focus=MUNICH,
        default=BERLIN,
        thread=(BERLIN,),
    )

    assert state.location_source == "focus"
    assert state.locations[0].is_same_place(MUNICH)
    assert state.context_statement is not None
    assert "focus you set" in state.context_statement


async def test_the_thread_wins_over_the_saved_default() -> None:
    """A conversation that established Munich is a stronger claim than a months-old default."""
    state = await _resolve(
        "What should I expect over the next few days?", default=BERLIN, thread=(MUNICH,)
    )

    assert state.location_source == "thread"
    assert state.locations[0].is_same_place(MUNICH)


async def test_the_saved_default_applies_and_says_that_it_did() -> None:
    """Used *and* disclosed: a default that hid itself would read as a guess."""
    state = await _resolve("What should I expect over the next few days?", default=BERLIN)

    assert state.location_source == "preferences"
    assert state.locations[0].is_same_place(BERLIN)
    assert state.context_statement is not None
    assert "saved default" in state.context_statement


async def test_nothing_anywhere_asks_rather_than_picking() -> None:
    """The load-bearing row. No location, and no invented one."""
    state = await _resolve("What should I expect over the next few days?")

    assert state.location_source == "none"
    assert state.locations == ()
    assert state.clarification_question is not None
    assert "Which place" in state.clarification_question


@pytest.mark.parametrize("focus", [BERLIN, MUNICH])
async def test_a_focus_alone_is_enough_to_answer(focus: Location) -> None:
    """The gap this tier was added to close.

    An account with no saved default asking a question that names no place had exactly one
    outcome before the focus existed — a clarification — however many places it had saved. That
    is the production defect the 2026-09-12 review rejected the screen for.
    """
    state = await _resolve("What should I expect over the next few days?", focus=focus)

    assert state.location_source == "focus"
    assert state.locations[0].is_same_place(focus)
    assert state.clarification_question is None
