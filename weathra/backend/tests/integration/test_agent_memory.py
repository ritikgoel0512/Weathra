"""Tasks 14.8, 14.11, 14.12 — evidence persistence, follow-up context, and preference defaults.

`db` tests, because all three are about rows: the evidence record is a row the acting user owns,
thread context is a row Row Level Security covers, and a saved default location is a row read under
the request session. Every session is opened as a principal under the restricted role, so nothing
here passes because it ran privileged.

The language model is scripted and the weather provider is a stub; everything between them is the
real pipeline.
"""

from __future__ import annotations

import json
import uuid
from datetime import date

import pytest
from sqlalchemy import text

from tests.agent_support import BERLIN, MUNICH, NOW, StubGeocoder, connected_tools
from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.agents.context import ContextSources
from weathra.agents.evidence import persist_run
from weathra.agents.graph import AgentRunResult, RunDependencies, run_agent
from weathra.agents.llm.fake import FakeLLMClient
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.agents.state import GraphState
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.errors import ThreadNotFound
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.preferences import PreferenceStore
from weathra.memory.threads import ThreadStore, WindowMemory

pytestmark = pytest.mark.db


def _principal(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


def _plan(*steps: PlanStep, **kwargs: object) -> dict:
    return RoutingPlan(steps=steps, reason="a scripted plan", **kwargs).model_dump(mode="json")


def _client(plan: dict, *, prose: str = "A scripted explanation.") -> FakeLLMClient:
    return FakeLLMClient(json_responses=[plan], completions=[prose])


def _settings(db_settings: Settings) -> Settings:
    """Agent settings pointed at the test database."""
    return db_settings.model_copy(
        update={"mcp_transport": "in-process", "agent_max_steps": 12, "http_backoff_seconds": 0}
    )


def _state(question: str, user_id: str, **kwargs: object) -> GraphState:
    return GraphState.begin(
        question=question,
        request_id=f"req_{uuid.uuid4().hex[:8]}",
        principal=_principal(user_id),
        started_at=NOW,
        **kwargs,  # type: ignore[arg-type]
    )


# =========================================================================== 14.8 persistence


async def test_the_evidence_record_is_complete_and_owned_by_the_acting_user(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The bar ``specs/agent-orchestration`` sets, checked field by field."""
    settings = _settings(db_settings)
    user = new_user_id()
    client = _client(
        _plan(
            PlanStep(
                capability=Capability.HISTORICAL,
                reason="the question is about last week",
                location="Berlin",
                start_date=date(2025, 6, 1),
                end_date=date(2025, 6, 7),
            ),
            PlanStep(
                capability=Capability.ANALYTICS,
                reason="the question asks for a mean",
                statistics=("mean",),
                uses_previous_result=True,
            ),
        )
    )

    async with connected_tools(settings=settings) as tools:
        result = await run_agent(
            _state("What was the mean temperature in Berlin last week?", user),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    record = result.envelope.evidence
    assert record.agents, "the agents that ran"
    assert record.agents_in_order == tuple(step.agent for step in record.agents)
    assert record.tool_calls, "each tool call"
    assert all(call.arguments for call in record.tool_calls), "with its arguments"
    assert record.tool_results, "each tool result"
    assert record.citations == (), "no knowledge was needed for this question"
    assert record.attributions, "who supplied the data"
    assert record.data_classes, "what kind of data it was"
    assert record.llm_provider == "fake"
    assert record.llm_model == "weathra-fake-1"
    assert all(step.duration_ms >= 0.0 for step in record.agents), "per-step timings"
    assert record.total_duration_ms >= 0.0
    assert record.routing_reason
    assert record.steps_used > 0

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        run_id = await persist_run(session, _principal(user), result.envelope)

    assert run_id is not None

    async with session_as(engines, user) as session:
        row = (
            await session.execute(
                text(
                    "SELECT user_id, request_id, question, llm_provider, evidence, envelope "
                    "FROM agent_runs WHERE id = :id"
                ),
                {"id": run_id},
            )
        ).one()

    assert str(row[0]) == user, "owned by the token's subject"
    assert row[1] == result.envelope.request_id
    assert row[3] == "fake"
    assert row[4]["tool_calls"], "the stored record carries the calls"
    assert row[5]["findings"], "and the stored envelope carries the findings"


async def test_a_figure_in_the_answer_is_locatable_in_the_evidence(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "Verify every figure without re-running the question" — this is that property.

    The figure is taken from the answer's own findings, then found again in the stored record's
    tool payloads, which is the path a reader follows.
    """
    settings = _settings(db_settings)
    user = new_user_id()
    client = _client(
        _plan(
            PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3),
            PlanStep(
                capability=Capability.ANALYTICS,
                reason="r",
                statistics=("mean", "maximum"),
                uses_previous_result=True,
            ),
        )
    )

    async with connected_tools(settings=settings) as tools:
        result = await run_agent(
            _state("Mean and maximum in Berlin?", user),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        run_id = await persist_run(session, _principal(user), result.envelope)

        stored = await session.scalar(
            text("SELECT evidence FROM agent_runs WHERE id = :id"), {"id": run_id}
        )

    computed = next(
        finding
        for finding in result.envelope.findings
        if finding.method and finding.value is not None
    )
    serialized = json.dumps(stored)

    assert f"{computed.value}" in serialized, "the figure itself is in the record"
    assert computed.method is not None
    assert computed.method in serialized, "so is the method that produced it"
    assert computed.attribution.provider in serialized, "and who supplied the data"


async def test_one_users_run_is_not_visible_to_another(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    settings = _settings(db_settings)
    owner = new_user_id()
    other = new_user_id()
    client = _client(
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=1))
    )

    async with connected_tools(settings=settings) as tools:
        result = await run_agent(
            _state("Berlin?", owner),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        run_id = await persist_run(session, _principal(owner), result.envelope)

    async with session_as(engines, other) as session:
        await insert_profile(session, other)
        found = await session.scalar(
            text("SELECT count(*) FROM agent_runs WHERE id = :id"), {"id": run_id}
        )
    assert found == 0, "Row Level Security hides another user's run"


async def test_a_failed_evidence_write_does_not_take_the_answer_down(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The savepoint's whole purpose: the person asked about the weather and has an answer.

    The write fails because the thread id names a thread that does not exist, which violates the
    foreign key — a plausible way for this to fail in production.
    """
    settings = _settings(db_settings)
    user = new_user_id()
    client = _client(
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=1))
    )

    async with connected_tools(settings=settings) as tools:
        result = await run_agent(
            _state("Berlin?", user, thread_id=str(uuid.uuid4())),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        run_id = await persist_run(session, _principal(user), result.envelope)

        # The transaction is still usable, which is what the savepoint bought.
        still_alive = await session.scalar(text("SELECT 1"))

    assert run_id is None, "the write failed and said so"
    assert still_alive == 1
    assert result.envelope.findings, "and the answer is intact"


# =========================================================================== 14.11 follow-ups


async def _run(
    engines: Engines,
    settings: Settings,
    user: str,
    question: str,
    plan: dict,
    *,
    thread_id: str | None = None,
    prose: str = "A scripted explanation.",
    requested_unit_system: UnitSystem | None = None,
    focus: Location | None = None,
) -> AgentRunResult:
    """One agent run, with the acting user's own memory stores attached."""
    async with session_as(engines, user) as session, connected_tools(settings=settings) as tools:
        principal = _principal(user)
        result = await run_agent(
            GraphState.begin(
                question=question,
                request_id=f"req_{uuid.uuid4().hex[:8]}",
                principal=principal,
                thread_id=thread_id,
                requested_unit_system=requested_unit_system,
                focus=focus,
                started_at=NOW,
            ),
            RunDependencies(
                settings=settings,
                tools=tools,
                geocoder=StubGeocoder(),
                llm=_client(plan, prose=prose),
                context=ContextSources(
                    threads=ThreadStore(session, principal, settings),
                    preferences=PreferenceStore(session, principal, settings),
                    thread_id=thread_id,
                ),
            ),
        )
        # Record what the turn resolved, the way the API route will.
        if thread_id and result.state.locations:
            await ThreadStore(session, principal, settings).record(
                thread_id,
                locations=list(result.state.locations),
                unit_system=result.state.unit_system,
            )
        return result


async def test_the_berlin_munich_follow_up_resolves_from_thread_context(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "Compare Berlin and Munich" then "Which one is warmer tomorrow?" — the spec's scenario."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, _principal(user), settings).create()

    await _run(
        engines,
        settings,
        user,
        "Compare Berlin and Munich",
        _plan(
            PlanStep(
                capability=Capability.FORECAST,
                reason="both places",
                locations=("Berlin", "Munich"),
                days=3,
            )
        ),
        thread_id=thread.id,
    )

    # The follow-up names no place at all.
    follow_up = await _run(
        engines,
        settings,
        user,
        "Which one is warmer tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="the follow-up", days=1)),
        thread_id=thread.id,
    )

    resolved = follow_up.envelope.resolved
    assert resolved is not None
    assert {location.display_name for location in resolved.locations} == {"Berlin", "Munich"}
    assert resolved.location_source == "thread"
    assert resolved.statement is not None
    assert "previous question" in resolved.statement
    assert follow_up.envelope.findings


async def test_a_unit_preference_is_carried_forward_into_a_follow_up(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, _principal(user), settings).create()

    await _run(
        engines,
        settings,
        user,
        "Berlin in Fahrenheit please",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)),
        thread_id=thread.id,
        requested_unit_system=UnitSystem.IMPERIAL,
    )

    follow_up = await _run(
        engines,
        settings,
        user,
        "What about precipitation?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=3)),
        thread_id=thread.id,
    )

    assert follow_up.envelope.resolved is not None
    assert follow_up.envelope.resolved.unit_system == "imperial"
    assert follow_up.envelope.resolved.units_source == "thread"
    assert follow_up.envelope.evidence.tool_calls[0].arguments["units"] == "imperial"


async def test_an_unresolvable_reference_produces_a_question_rather_than_a_guess(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """An empty thread plus a question that names no place: ask, do not pick a plausible city."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, _principal(user), settings).create()

    result = await _run(
        engines,
        settings,
        user,
        "Which one is warmer tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        thread_id=thread.id,
    )

    assert result.envelope.clarification_question is not None
    assert "Which place" in result.envelope.clarification_question
    assert result.envelope.findings == ()
    assert result.envelope.evidence.tool_calls == ()


async def test_a_second_users_follow_up_resolves_only_against_their_own_context(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    settings = _settings(db_settings)
    first = new_user_id()
    second = new_user_id()

    async with session_as(engines, first) as session:
        await insert_profile(session, first)
        first_thread = await ThreadStore(session, _principal(first), settings).create()
    async with session_as(engines, second) as session:
        await insert_profile(session, second)
        second_thread = await ThreadStore(session, _principal(second), settings).create()

    await _run(
        engines,
        settings,
        first,
        "Compare Berlin and Munich",
        _plan(
            PlanStep(
                capability=Capability.FORECAST,
                reason="r",
                locations=("Berlin", "Munich"),
                days=3,
            )
        ),
        thread_id=first_thread.id,
    )

    # The second user's own empty thread resolves to nothing, not to the first user's cities.
    result = await _run(
        engines,
        settings,
        second,
        "Which one is warmer tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        thread_id=second_thread.id,
    )

    assert result.envelope.clarification_question is not None
    assert result.envelope.findings == ()
    assert "Berlin" not in (result.envelope.clarification_question or "")


async def test_a_foreign_thread_id_is_refused_before_the_graph_runs(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The ownership gate, from the agent surface's side."""
    settings = _settings(db_settings)
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        thread = await ThreadStore(session, _principal(owner), settings).create()

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)
        with pytest.raises(ThreadNotFound):
            await ThreadStore(session, _principal(intruder), settings).open(thread.id)


# =========================================================================== 14.12 preferences


async def test_a_saved_default_location_is_used_and_disclosed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Used *and disclosed*: a person can tell that from Weathra having guessed."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), settings).update(default_location=BERLIN)

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(BERLIN)
    assert resolved.location_source == "preferences"
    assert resolved.statement is not None
    assert "saved default" in resolved.statement
    assert result.envelope.findings


async def test_an_explicit_place_beats_the_saved_default(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Someone who asks about Munich while their default is Berlin means Munich."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), settings).update(default_location=BERLIN)

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain in Munich tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Munich", days=1)),
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(MUNICH)
    assert resolved.location_source == "request"


async def test_a_saved_unit_preference_applies_and_is_disclosed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), settings).update(
            unit_system=UnitSystem.IMPERIAL
        )

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain in Berlin tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=1)),
    )

    assert result.envelope.resolved is not None
    assert result.envelope.resolved.unit_system == "imperial"
    assert result.envelope.resolved.units_source == "preferences"
    assert result.envelope.evidence.tool_calls[0].arguments["units"] == "imperial"


async def test_an_ambiguous_location_is_presented_as_candidates_not_chosen(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    settings = _settings(db_settings)
    user = new_user_id()
    springfields = (
        BERLIN.model_copy(update={"display_name": "Springfield", "region": "Illinois"}),
        MUNICH.model_copy(update={"display_name": "Springfield", "region": "Missouri"}),
    )

    async with session_as(engines, user) as session, connected_tools(settings=settings) as tools:
        await insert_profile(session, user)
        principal = _principal(user)
        result = await run_agent(
            _state("What is the weather in Springfield?", user),
            RunDependencies(
                settings=settings,
                tools=tools,
                geocoder=StubGeocoder(ambiguous=springfields),
                llm=_client(
                    _plan(
                        PlanStep(
                            capability=Capability.FORECAST,
                            reason="r",
                            location="Springfield",
                            days=1,
                        )
                    )
                ),
                context=ContextSources(preferences=PreferenceStore(session, principal, settings)),
            ),
        )

    question = result.envelope.clarification_question
    assert question is not None
    assert "Illinois" in question
    assert "Missouri" in question
    assert result.envelope.findings == ()
    assert result.envelope.evidence.tool_calls == ()


async def test_no_location_anywhere_asks_and_says_it_checked_the_saved_default(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The message distinguishes "you have no default" from "you did not say", which matters."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
    )

    question = result.envelope.clarification_question
    assert question is not None
    assert "no default location is saved" in question
    assert result.envelope.findings == ()


async def test_a_thread_context_location_beats_the_saved_default(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The conversation is more recent than the profile, so it wins."""
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        principal = _principal(user)
        await PreferenceStore(session, principal, settings).update(default_location=BERLIN)
        thread = await ThreadStore(session, principal, settings).create()
        await ThreadStore(session, principal, settings).record(
            thread.id,
            locations=[MUNICH],
            window=WindowMemory(kind="forecast_days", days=3, label="the next 3 days"),
        )

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        thread_id=thread.id,
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(MUNICH)
    assert resolved.location_source == "thread"


# ============================================================ the conversation's focus


async def test_a_conversation_focus_answers_a_question_that_names_no_place(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The Analyst's FOCUS control, doing the one thing it exists to do.

    Nothing else in this run points anywhere: no place in the question, no thread, no saved
    default. Before the focus existed this was the clarification case, and a person whose account
    had no default had no way at all to get an answer without retyping the place into every
    question.
    """
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        focus=BERLIN,
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(BERLIN)
    assert resolved.location_source == "focus"
    assert resolved.statement is not None
    assert "focus you set" in resolved.statement
    assert result.envelope.clarification_question is None
    assert result.envelope.findings


async def test_a_place_named_in_the_question_beats_the_focus(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "How about Munich?" with the focus on Berlin means Munich.

    The focus is what the conversation is pointed at; naming a place is a more recent choice than
    setting one, so it overrides without the person having to move the control first.
    """
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)

    result = await _run(
        engines,
        settings,
        user,
        "How about Munich?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Munich", days=1)),
        focus=BERLIN,
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(MUNICH)
    assert resolved.location_source == "request"


async def test_the_focus_beats_the_thread_and_the_saved_default(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Both of the weaker sources are present and both are overridden.

    A person who moves the focus to Munich mid-conversation has said something about *this*
    question that neither the earlier turn nor a preference set months ago can contradict.
    """
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        principal = _principal(user)
        await PreferenceStore(session, principal, settings).update(default_location=BERLIN)
        thread = await ThreadStore(session, principal, settings).create()
        await ThreadStore(session, principal, settings).record(thread.id, locations=[BERLIN])

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        thread_id=thread.id,
        focus=MUNICH,
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.locations[0].is_same_place(MUNICH)
    assert resolved.location_source == "focus"


async def test_no_focus_leaves_every_weaker_source_exactly_as_it_was(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The regression guard for adding a tier: absent, it must change nothing.

    The saved default still resolves and still discloses itself, which is the whole of what this
    run did before the focus was introduced.
    """
    settings = _settings(db_settings)
    user = new_user_id()

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), settings).update(default_location=BERLIN)

    result = await _run(
        engines,
        settings,
        user,
        "Will it rain tomorrow?",
        _plan(PlanStep(capability=Capability.FORECAST, reason="r", days=1)),
        focus=None,
    )

    resolved = result.envelope.resolved
    assert resolved is not None
    assert resolved.location_source == "preferences"
    assert resolved.statement is not None
    assert "saved default" in resolved.statement
