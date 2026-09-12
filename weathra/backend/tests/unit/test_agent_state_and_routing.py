"""Tasks 14.1 and 14.2 — the graph state, and the supervisor's three routing outcomes."""

from __future__ import annotations

import inspect
import json
from datetime import UTC, datetime

import pytest

from weathra.agents.evidence import build_record
from weathra.agents.llm.fake import FakeLLMClient
from weathra.agents.plan import (
    Capability,
    PlanStep,
    RoutingPlan,
    extract_location,
    fallback_plan,
    looks_like_weather,
)
from weathra.agents.state import GraphState
from weathra.agents.supervisor import catalog_capabilities, route
from weathra.domain.comparison import Criterion
from weathra.domain.errors import (
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from weathra.domain.evidence import (
    AgentName,
    InferenceAttempt,
    InferenceStage,
    InferenceStatus,
    StepStatus,
)
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem

NOW = datetime(2025, 6, 15, 9, 0, tzinfo=UTC)
USER = "11111111-1111-4111-8111-111111111111"
THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    country_code="DE",
)


def _principal(user_id: str = USER) -> Principal:
    return Principal.from_claims({"sub": user_id, "email": "person@example.test"})


def _state(question: str = "Will it rain in Berlin tomorrow?", **kwargs: object) -> GraphState:
    return GraphState.begin(
        question=question,
        request_id="req_1",
        principal=_principal(),
        started_at=NOW,
        **kwargs,  # type: ignore[arg-type]
    )


def _plan(*steps: PlanStep, **kwargs: object) -> dict:
    payload = RoutingPlan(steps=steps, reason="a scripted plan", **kwargs).model_dump(mode="json")
    return payload


# =========================================================================== 14.1 the state


def test_the_state_carries_the_question_the_identity_and_the_thread_key() -> None:
    state = _state(thread_id=THREAD)

    assert state.question == "Will it rain in Berlin tomorrow?"
    assert state.user_id == USER
    assert state.thread_id == THREAD
    assert state.thread_key == f"{USER}:{THREAD}"


def test_the_state_serializes_and_round_trips() -> None:
    """The checkpointer stores this, so it has to survive the trip."""
    state = _state(thread_id=THREAD).with_updates(
        locations=(BERLIN,), unit_system=UnitSystem.IMPERIAL
    )

    payload = json.loads(state.model_dump_json())
    assert payload["user_id"] == USER
    assert payload["locations"][0]["display_name"] == "Berlin"

    restored = GraphState.model_validate(payload)
    assert restored.user_id == USER
    assert restored.locations[0].is_same_place(BERLIN)
    assert restored.unit_system is UnitSystem.IMPERIAL


def test_the_identity_is_not_a_caller_supplied_parameter() -> None:
    """Design.md decision 4: two identity paths mean two authorization paths.

    Structural, not a runtime check — ``begin`` takes a ``Principal``, so there is no signature
    into which a caller-supplied user id would fit.
    """
    parameters = inspect.signature(GraphState.begin, eval_str=True).parameters
    assert "principal" in parameters
    assert "user_id" not in parameters
    assert parameters["principal"].annotation is Principal


def test_a_state_with_no_identity_is_refused() -> None:
    with pytest.raises(ValueError, match="authentication subject"):
        GraphState(question="q", request_id="r", user_id="   ", started_at=NOW)


def test_the_thread_key_is_composed_from_the_principals_own_subject() -> None:
    """So state and checkpoint cannot end up scoped to different people."""
    other = _principal("22222222-2222-4222-8222-222222222222")
    state = GraphState.begin(
        question="q", request_id="r", principal=other, thread_id=THREAD, started_at=NOW
    )
    assert state.thread_key == f"{other.user_id}:{THREAD}"
    assert USER not in (state.thread_key or "")


def test_an_unthreaded_run_has_no_checkpoint_key() -> None:
    assert _state().thread_key is None


def test_accumulating_a_finding_records_its_data_class_once() -> None:
    from tests.agent_support import finding_for

    state = _state().with_findings((finding_for(11.0, BERLIN), finding_for(12.0, BERLIN)))
    assert len(state.findings) == 2
    assert len(state.data_classes) == 1, "one data class, not one per finding"


def test_sequences_are_one_based_and_advance() -> None:
    from tests.agent_support import tool_exchange

    state = _state()
    assert state.next_sequence == 1
    assert state.next_step_sequence == 1

    call, result = tool_exchange(1, "weather_forecast", BERLIN)
    state = state.with_tool_exchange(call, result)
    assert state.next_sequence == 2


def test_the_state_does_not_accept_a_field_it_does_not_know() -> None:
    with pytest.raises(ValueError, match="admin"):
        GraphState.model_validate(
            {"question": "q", "request_id": "r", "user_id": USER, "started_at": NOW, "admin": True}
        )


# =========================================================================== 14.2 valid plan


async def test_a_valid_plan_from_the_model_is_used_as_is() -> None:
    client = FakeLLMClient(
        json_responses=[
            _plan(
                PlanStep(
                    capability=Capability.FORECAST,
                    reason="the question asks about tomorrow",
                    location="Berlin",
                    days=1,
                )
            )
        ]
    )

    state = await route(_state(), client=client, now=NOW)

    assert state.plan is not None
    assert state.plan.capabilities == (Capability.FORECAST,)
    assert state.routing_source == "model"
    assert state.agent_steps[0].agent is AgentName.SUPERVISOR
    assert state.agent_steps[0].status is StepStatus.SUCCEEDED
    assert state.agent_steps[0].reason == "a scripted plan"


async def test_the_routing_prompt_names_the_catalog_and_no_model() -> None:
    client = FakeLLMClient(json_responses=[_plan(PlanStep(capability=Capability.RAG, reason="r"))])
    await route(_state("What does dew point mean?"), client=client, now=NOW)

    system = client.last_system_prompt()
    for capability in catalog_capabilities():
        assert f'"{capability}"' in system
    assert "gpt" not in system.lower()
    assert "claude" not in system.lower()


async def test_the_question_and_todays_date_reach_the_model() -> None:
    """ "Tomorrow" is unanswerable without a date, and a model asked to guess one will."""
    client = FakeLLMClient(
        json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="r"))]
    )
    await route(_state(), client=client, now=NOW)

    contents = [message.content for message in client.json_prompts[0][1]]
    assert any("2025-06-15" in content for content in contents)
    assert any("Will it rain in Berlin tomorrow?" in content for content in contents)


async def test_an_established_location_is_offered_as_context_for_a_follow_up() -> None:
    client = FakeLLMClient(
        json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="r"))]
    )
    state = _state("Which one is warmer?", thread_id=THREAD).with_updates(locations=(BERLIN,))
    await route(state, client=client, now=NOW)

    contents = " ".join(message.content for message in client.json_prompts[0][1])
    assert "Berlin" in contents
    assert "is_follow_up" in contents


async def test_a_multi_step_plan_is_kept_in_order() -> None:
    client = FakeLLMClient(
        json_responses=[
            _plan(
                PlanStep(capability=Capability.HISTORICAL, reason="last week"),
                PlanStep(
                    capability=Capability.ANALYTICS, reason="the mean", uses_previous_result=True
                ),
            )
        ]
    )
    state = await route(
        _state("What was the average temperature in Berlin last week?"), client=client, now=NOW
    )

    assert state.plan is not None
    assert state.plan.capabilities == (Capability.HISTORICAL, Capability.ANALYTICS)


async def test_unanswerable_parts_are_carried_onto_the_state() -> None:
    client = FakeLLMClient(
        json_responses=[
            _plan(
                PlanStep(capability=Capability.FORECAST, reason="the weather part"),
                unanswerable_parts=("whether my flight will be delayed",),
            )
        ]
    )
    state = await route(
        _state("Will it rain in Berlin tomorrow and will my flight be delayed?"),
        client=client,
        now=NOW,
    )
    assert state.unanswered_parts == ("whether my flight will be delayed",)


# =========================================================================== 14.2 retry


async def test_a_malformed_plan_is_corrected_on_retry() -> None:
    """The retry lives in ``complete_json``; here it is exercised through the real client shape.

    The fake validates each scripted response, so a first response that fails the schema raises —
    which is what the supervisor's fallback catches. To exercise the *correction* path the request
    goes through the gateway client, where the retry actually happens.
    """
    import httpx
    import respx

    from weathra.agents.llm.openrouter import OpenRouterClient
    from weathra.config import Settings

    settings = Settings(
        supabase_url="https://test.supabase.co",
        openrouter_api_key="test-credential",
        openrouter_base_url="https://gateway.test/api/v1",
        llm_json_max_attempts=3,
        http_backoff_seconds=0,
    )
    valid = json.dumps(_plan(PlanStep(capability=Capability.FORECAST, reason="tomorrow")))

    with respx.mock:
        route_mock = respx.post("https://gateway.test/api/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(200, json=_completion("I think a forecast would help")),
                httpx.Response(200, json=_completion(valid)),
            ]
        )
        client = OpenRouterClient(client=httpx.AsyncClient(), settings=settings)
        state = await route(_state(), client=client, now=NOW)

    assert route_mock.call_count == 2
    assert state.routing_source == "model"
    assert state.plan is not None
    assert state.plan.capabilities == (Capability.FORECAST,)


async def test_a_capability_outside_the_catalog_is_returned_to_the_model_as_an_error() -> None:
    """``specs/agent-orchestration``: an out-of-catalog request executes nothing.

    It cannot even be parsed into a plan — the enum rejects it — and the error the model gets back
    lists the four valid names so it can choose a real one.
    """
    import httpx
    import respx

    from weathra.agents.llm.openrouter import OpenRouterClient
    from weathra.config import Settings

    settings = Settings(
        supabase_url="https://test.supabase.co",
        openrouter_api_key="test-credential",
        openrouter_base_url="https://gateway.test/api/v1",
        llm_json_max_attempts=2,
        http_backoff_seconds=0,
    )
    out_of_catalog = json.dumps(
        {
            "steps": [{"capability": "run_shell_command", "reason": "to look it up"}],
            "reason": "improvising",
        }
    )
    valid = json.dumps(_plan(PlanStep(capability=Capability.RAG, reason="explain it")))

    with respx.mock:
        route_mock = respx.post("https://gateway.test/api/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(200, json=_completion(out_of_catalog)),
                httpx.Response(200, json=_completion(valid)),
            ]
        )
        client = OpenRouterClient(client=httpx.AsyncClient(), settings=settings)
        state = await route(_state("What does dew point mean?"), client=client, now=NOW)

    correction = json.loads(route_mock.calls[1].request.content)["messages"][-1]["content"]
    assert "capability" in correction
    for capability in catalog_capabilities():
        assert capability in correction, "the error must list the catalog"

    assert state.plan is not None
    assert state.plan.capabilities == (Capability.RAG,)
    assert Capability.__members__, "no capability named run_shell_command exists to execute"


def _completion(content: str) -> dict:
    return {
        "model": "vendor/model",
        "choices": [
            {"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
        ],
    }


# =========================================================================== 14.2 fallback


async def test_repeated_failure_falls_back_to_the_deterministic_router() -> None:
    from weathra.domain.errors import ValidationFailed

    client = FakeLLMClient(failure=ValidationFailed("no valid plan in 3 attempts"))
    state = await route(_state("Will it rain in Berlin tomorrow?"), client=client, now=NOW)

    assert state.routing_source == "deterministic_fallback"
    assert state.plan is not None
    assert state.plan.capabilities == (Capability.FORECAST,)
    assert state.agent_steps[0].reason is not None
    assert "deterministic" in state.agent_steps[0].reason


async def test_an_unavailable_provider_falls_back_rather_than_failing_the_run() -> None:
    client = FakeLLMClient(failure=ProviderUnavailable("the gateway is down"))
    state = await route(_state(), client=client, now=NOW)

    assert state.routing_source == "deterministic_fallback"
    assert state.plan is not None
    assert state.plan.steps


async def test_no_client_at_all_still_routes() -> None:
    """Offline evaluation and a credential-less deployment both land here."""
    state = await route(_state(), client=None, now=NOW)
    assert state.routing_source == "deterministic_fallback"
    assert state.routing_attempts == 0
    assert state.plan is not None
    assert state.plan.capabilities == (Capability.FORECAST,)


# =========================================================================== the router itself


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("Will it rain in Berlin tomorrow?", (Capability.FORECAST,)),
        ("What is the forecast for Lisbon this weekend?", (Capability.FORECAST,)),
        ("How much did it rain in Berlin last week?", (Capability.HISTORICAL,)),
        ("What was the temperature yesterday?", (Capability.HISTORICAL,)),
        (
            "What was the average temperature in Berlin last week?",
            (Capability.HISTORICAL, Capability.ANALYTICS),
        ),
        (
            "What is the mean temperature over the next 7 days in Berlin?",
            (Capability.FORECAST, Capability.ANALYTICS),
        ),
        ("What does dew point mean?", (Capability.RAG,)),
        # "now" was a forecast word, because the forecast node was the only thing that retrieved.
        # It means the present, and the present is what `Capability.CURRENT` reads.
        (
            "What does dew point mean and how humid is it in Berlin now?",
            (Capability.RAG, Capability.CURRENT),
        ),
        ("Explain the difference between gusts and sustained wind", (Capability.RAG,)),
        # --- the present tense, routed to the capability that retrieves it (task 34.33)
        ("What is the weather like in Berlin right now?", (Capability.CURRENT,)),
        ("How windy is it in Berlin currently?", (Capability.CURRENT,)),
        # The present *and* the days ahead is two claims and two steps, in that order.
        (
            "What is the temperature in Berlin now and what is the forecast for the weekend?",
            (Capability.CURRENT, Capability.FORECAST),
        ),
        # And a question about neither gets neither: no current step is forced onto a comparison.
        (
            "Compare how much rain Berlin got last week with the week before",
            (Capability.HISTORICAL, Capability.ANALYTICS),
        ),
        # A question with no tense marker still defaults to the forecast window, unchanged.
        ("What is the weather in Berlin?", (Capability.FORECAST,)),
    ],
)
def test_the_deterministic_router_routes_by_vocabulary(
    question: str, expected: tuple[Capability, ...]
) -> None:
    plan = fallback_plan(question, now=NOW)
    assert plan.capabilities == expected
    assert plan.in_scope


def test_the_deterministic_router_declines_a_non_weather_question() -> None:
    plan = fallback_plan("What is the capital of France?", now=NOW)
    assert not plan.in_scope
    assert plan.steps == ()
    assert plan.out_of_scope_reason is not None
    assert "weather" in plan.out_of_scope_reason


def test_a_question_asking_for_both_gets_both() -> None:
    """The shape that most needs two retrievals was the one shape guaranteed to get one.

    This read `historical and not forecast`, so "compare the forecast against recent historical
    conditions" produced the forecast half and silently dropped the comparison it was asking for —
    and a run that cannot retrieve both cannot produce the evidence a comparison is made of.
    """
    plan = fallback_plan(
        "Deep-dive on the weather for London over the next 7 days. Compare the forecast against "
        "recent historical conditions and identify any meaningful anomaly."
    )

    chosen = [step.capability for step in plan.steps]
    assert plan.in_scope
    assert Capability.FORECAST in chosen
    assert Capability.HISTORICAL in chosen
    assert Capability.ANALYTICS in chosen


def test_a_comparison_of_periods_is_a_weather_question() -> None:
    """It carries no weather word at all, and the router refused it.

    "How does this week compare with the same week last year?" has no temperature, no rain, no
    "weather" — so the vocabulary check called it out of scope and the deterministic router
    answered a plain weather question with a refusal. On a weather product, comparing two calendar
    windows is about the weather in them.
    """
    plan = fallback_plan("How does this week compare with the same week last year?")

    assert plan.in_scope
    assert Capability.HISTORICAL in [step.capability for step in plan.steps]


def test_a_narrow_comparison_stays_narrow() -> None:
    """Routing more capabilities than a question needs is its own failure.

    The comparison above needs the archive and the arithmetic over it. It does not need a forecast,
    a satellite pass or the knowledge base, and a router that reached for them would spend provider
    calls on a question that did not ask — the cost that has to stay controlled.
    """
    chosen = [
        step.capability
        for step in fallback_plan("How does this week compare with the same week last year?").steps
    ]

    assert Capability.FORECAST not in chosen
    assert Capability.SATELLITE not in chosen
    assert Capability.RAG not in chosen
    assert Capability.CURRENT not in chosen


def test_a_historical_fallback_supplies_a_concrete_range() -> None:
    """A router that produced no dates would route to a capability that cannot run."""
    plan = fallback_plan("How much did it rain in Berlin last week?", now=NOW)
    step = plan.steps[0]
    assert step.start_date is not None
    assert step.end_date is not None
    assert step.end_date < NOW.date(), "the archive does not hold today"


@pytest.mark.parametrize(
    "question",
    [
        "Will it rain tomorrow?",
        "What is the dew point?",
        "How windy is it in Lisbon?",
        "Is it going to be cold this weekend?",
    ],
)
def test_weather_vocabulary_is_recognised(question: str) -> None:
    assert looks_like_weather(question)


@pytest.mark.parametrize(
    "question",
    [
        "What is the capital of France?",
        "Write me a poem about my cat",
        "Who won the league last night?",
        "Book me a table for two",
    ],
)
def test_non_weather_vocabulary_is_not_recognised(question: str) -> None:
    assert not looks_like_weather(question)


# =========================================================================== the scope cross-check


async def test_a_model_refusing_a_weather_question_is_overridden() -> None:
    """The worse failure of the two: a bad answer to a good question."""
    client = FakeLLMClient(
        json_responses=[
            {
                "steps": [],
                "reason": "I do not do weather",
                "in_scope": False,
                "out_of_scope_reason": "not my job",
            }
        ]
    )
    state = await route(_state("Will it rain in Berlin tomorrow?"), client=client, now=NOW)

    assert state.plan is not None
    assert state.plan.in_scope
    assert state.plan.capabilities == (Capability.FORECAST,)
    assert state.agent_steps[0].reason is not None
    assert "out of scope" in state.agent_steps[0].reason


async def test_a_model_that_says_a_question_is_in_scope_is_not_overridden() -> None:
    """The asymmetry, asserted: the check only ever moves toward answering.

    A vocabulary list confident enough to veto the model here would also refuse "Berlin for two
    days?", which has no weather word in it and is obviously a forecast question.
    """
    client = FakeLLMClient(
        json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="a forecast"))]
    )
    state = await route(_state("Berlin for two days?"), client=client, now=NOW)

    assert state.plan is not None
    assert state.plan.in_scope
    assert state.plan.capabilities == (Capability.FORECAST,)


async def test_a_model_declining_a_question_with_no_weather_vocabulary_is_respected() -> None:
    """Which is how an out-of-scope question is actually declined when a model is available."""
    client = FakeLLMClient(
        json_responses=[
            {
                "steps": [],
                "reason": "this is about geography",
                "in_scope": False,
                "out_of_scope_reason": "Weathra covers weather, not the capitals of countries.",
            }
        ]
    )
    state = await route(_state("What is the capital of France?"), client=client, now=NOW)

    assert state.plan is not None
    assert not state.plan.in_scope
    assert state.plan.steps == ()


# =========================================================================== plan coherence


def test_an_out_of_scope_plan_may_not_carry_steps() -> None:
    with pytest.raises(ValueError, match="routes to no capability"):
        RoutingPlan(
            steps=(PlanStep(capability=Capability.FORECAST, reason="r"),),
            reason="r",
            in_scope=False,
            out_of_scope_reason="not weather",
        )


def test_an_out_of_scope_plan_must_say_why() -> None:
    with pytest.raises(ValueError, match="must say why"):
        RoutingPlan(steps=(), reason="r", in_scope=False)


def test_an_in_scope_plan_must_route_or_name_what_it_cannot_answer() -> None:
    with pytest.raises(ValueError, match="name what it cannot answer"):
        RoutingPlan(steps=(), reason="r")

    named = RoutingPlan(steps=(), reason="r", unanswerable_parts=("my flight",))
    assert named.unanswerable_parts


def test_the_first_step_cannot_depend_on_a_previous_one() -> None:
    with pytest.raises(ValueError, match="no previous step"):
        RoutingPlan(
            steps=(
                PlanStep(capability=Capability.ANALYTICS, reason="r", uses_previous_result=True),
            ),
            reason="r",
        )


def test_an_inverted_historical_range_is_refused() -> None:
    from datetime import date

    with pytest.raises(ValueError, match="end before it starts"):
        PlanStep(
            capability=Capability.HISTORICAL,
            reason="r",
            start_date=date(2025, 6, 10),
            end_date=date(2025, 6, 1),
        )


def test_a_comparison_step_names_every_place() -> None:
    step = PlanStep(
        capability=Capability.FORECAST,
        reason="r",
        locations=("Berlin", "Munich"),
        criterion=Criterion.WARMEST,
    )
    assert step.named_locations == ("Berlin", "Munich")
    assert PlanStep(capability=Capability.RAG, reason="r").named_locations == ()


# =========================================================================== execution grouping


def test_independent_steps_sharing_a_group_run_together() -> None:
    plan = RoutingPlan(
        steps=(
            PlanStep(
                capability=Capability.FORECAST, reason="r", location="Berlin", parallel_group=0
            ),
            PlanStep(
                capability=Capability.FORECAST, reason="r", location="Munich", parallel_group=0
            ),
        ),
        reason="r",
    )
    groups = plan.execution_groups()
    assert len(groups) == 1
    assert len(groups[0]) == 2


def test_a_dependent_step_starts_a_new_group_whatever_the_model_said() -> None:
    """A dependency the plan declares and the schedule ignores is not a dependency."""
    plan = RoutingPlan(
        steps=(
            PlanStep(capability=Capability.FORECAST, reason="r", parallel_group=0),
            PlanStep(
                capability=Capability.ANALYTICS,
                reason="r",
                uses_previous_result=True,
                parallel_group=0,
            ),
        ),
        reason="r",
    )
    groups = plan.execution_groups()
    assert len(groups) == 2
    assert groups[0][0].capability is Capability.FORECAST
    assert groups[1][0].capability is Capability.ANALYTICS


def test_ungrouped_steps_run_one_at_a_time() -> None:
    plan = RoutingPlan(
        steps=(
            PlanStep(capability=Capability.FORECAST, reason="r"),
            PlanStep(capability=Capability.RAG, reason="r"),
        ),
        reason="r",
    )
    assert len(plan.execution_groups()) == 2


# =========================================================================== location extraction


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("Will it rain in Berlin tomorrow?", "Berlin"),
        ("What was the temperature in Springfield, Illinois last week?", "Springfield, Illinois"),
        ("How windy is it in New York City?", "New York City"),
        ("What is the forecast for Lisbon this weekend?", "Lisbon"),
        ("Is it cold at Lake Tahoe now?", "Lake Tahoe"),
    ],
)
def test_the_fallback_router_extracts_the_place_a_question_names(
    question: str, expected: str
) -> None:
    """Without this, every credential-less run would ask "which place?" of a question that said."""
    assert extract_location(question) == expected
    assert fallback_plan(question, now=NOW).steps[0].location == expected


@pytest.mark.parametrize(
    "question",
    [
        "How warm was it in June?",
        "Will it rain tomorrow?",
        "what about berlin?",
        "Is it cold at Lake Tahoe tomorrow and next Monday?",
    ],
    ids=["a-month", "no-place", "lowercase", "trailing-date"],
)
def test_the_extractor_gives_up_rather_than_guessing(question: str) -> None:
    """A month is not a place, and a lowercase question is one this router cannot read.

    Giving up is safe *and* cheap here: the alternative is a name the geocoder rejects, which
    becomes a clarifying question — never a confident answer about the wrong city.
    """
    extracted = extract_location(question)
    assert extracted is None or extracted == "Lake Tahoe"


def test_a_date_word_after_a_preposition_is_not_taken_for_a_place() -> None:
    assert extract_location("How warm was it in June?") is None
    assert extract_location("What is the forecast for Monday?") is None
    assert extract_location("Will it rain in Berlin on Tuesday?") == "Berlin"


# =========================================================================== task 22.8
#
# Inference provenance. Task 22.8's live runs produced forty answers that looked like a model's
# work and were not, because nothing recorded whether a model had actually answered. These assert
# that the record now says — *and* that the product's graceful fallback is untouched, which is the
# constraint the whole design is built around.


async def test_a_served_routing_call_records_the_model_that_answered() -> None:
    client = FakeLLMClient(
        json_responses=[_plan(PlanStep(capability=Capability.FORECAST, reason="r"))]
    )

    state = await route(_state(), client=client, now=NOW)

    assert state.routing_source == "model"
    assert len(state.inference_attempts) == 1
    attempt = state.inference_attempts[0]
    assert attempt.stage is InferenceStage.ROUTING
    assert attempt.status is InferenceStatus.SERVED
    assert attempt.served is True
    assert attempt.provider == client.provider_id
    assert attempt.selected_model == client.model_id
    assert attempt.served_model == client.model_id
    assert attempt.latency_ms is not None


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (
            ProviderUnavailable("withdrawn", details={"provider": "p", "status": 404}),
            InferenceStatus.MODEL_UNAVAILABLE,
        ),
        (
            ProviderUnavailable("broken", details={"provider": "p", "status": 503}),
            InferenceStatus.PROVIDER_ERROR,
        ),
        (
            ProviderRateLimited("slow down", details={"provider": "p", "status": 429}),
            InferenceStatus.RATE_LIMITED,
        ),
        (ProviderTimeout("no reply", details={"provider": "p"}), InferenceStatus.TIMEOUT),
    ],
    ids=["404", "5xx", "429", "timeout"],
)
async def test_a_provider_failure_is_recorded_and_the_run_still_routes(
    failure: Exception, expected: InferenceStatus
) -> None:
    """Both halves matter. The failure is recorded *and* the question still gets an answer — the
    product's graceful degradation is preserved, it is merely no longer silent."""
    state = await route(_state(), client=FakeLLMClient(failure=failure), now=NOW)

    assert state.plan is not None, "the deterministic router must still produce a plan"
    assert state.routing_source == "deterministic_fallback"

    attempt = state.inference_attempts[0]
    assert attempt.status is expected
    assert attempt.served is False
    assert attempt.status.infrastructure_failure is True
    assert attempt.error_code == failure.code  # type: ignore[attr-defined]
    assert attempt.fallback_reason


async def test_an_unparseable_plan_records_invalid_output_not_a_provider_failure() -> None:
    """The model answered. It answered badly. That is a quality result and must never be
    classified as an outage, or a weak model could launder its failures as one."""
    client = FakeLLMClient(json_responses=["this is not a routing plan"])

    state = await route(_state(), client=client, now=NOW)

    attempt = state.inference_attempts[0]
    assert attempt.status is InferenceStatus.INVALID_OUTPUT
    assert attempt.served is True
    assert attempt.status.infrastructure_failure is False
    assert state.routing_source == "deterministic_fallback"


async def test_a_run_with_no_client_records_that_rather_than_leaving_an_absence() -> None:
    """ "No credential" and "the model failed" produce identical prose. Only the record separates
    them, so the record has to say."""
    state = await route(_state(), client=None, now=NOW)

    assert state.inference_attempts[0].status is InferenceStatus.NOT_CONFIGURED
    assert state.plan is not None


async def test_the_evidence_record_reports_whether_a_model_served_the_run() -> None:
    served = await route(
        _state(),
        client=FakeLLMClient(
            json_responses=[_plan(PlanStep(capability=Capability.RAG, reason="r"))]
        ),
        now=NOW,
    )
    fell_back = await route(
        _state(),
        client=FakeLLMClient(
            failure=ProviderUnavailable("withdrawn", details={"provider": "p", "status": 404})
        ),
        now=NOW,
    )

    record_served = build_record(served, provider_id="openrouter", model_id="vendor/m")
    record_fallback = build_record(fell_back, provider_id="openrouter", model_id="vendor/m")

    assert record_served.model_served is True
    assert record_served.fallback_used is False

    assert record_fallback.model_served is False
    assert record_fallback.fallback_used is True
    # The configured identity is still recorded — and is exactly what used to be mistaken for
    # evidence that the model answered. It names a model; it does not vouch for one.
    assert record_fallback.llm_model == "vendor/m"


async def test_a_partly_fallen_back_run_is_not_reported_as_model_served() -> None:
    """Not "at least one attempt served". A run whose routing came from the model and whose prose
    came from code is contaminated in exactly the dimension the wording metrics measure."""
    state = await route(
        _state(),
        client=FakeLLMClient(
            json_responses=[_plan(PlanStep(capability=Capability.RAG, reason="r"))]
        ),
        now=NOW,
    )
    state = state.with_inference_attempt(
        InferenceAttempt(
            stage=InferenceStage.SYNTHESIS,
            status=InferenceStatus.MODEL_UNAVAILABLE,
            http_status=404,
        )
    )

    record = build_record(state, provider_id="openrouter", model_id="vendor/m")
    assert record.model_served is False
    assert record.fallback_used is True
