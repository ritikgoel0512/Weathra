"""Tasks 13.1 to 13.5 — the language-model contract, the fake, and the OpenRouter client.

Every test here is offline. The gateway is a respx route; the credential is a made-up string that
never leaves the process. That is the point of design.md decision 3: ``specs/agent-orchestration``
requires the suite to run with no inference credential and no network access, so the suite has to
be able to prove the gateway client works without either.
"""

from __future__ import annotations

import json
from typing import Literal

import httpx
import pytest
import respx
from pydantic import BaseModel, ConfigDict, Field

from weathra.agents.llm.base import (
    Completion,
    LLMClient,
    Message,
    Role,
    TokenUsage,
    classify_inference_failure,
    extract_json_object,
    system_message,
    user_message,
    validate_against,
)
from weathra.agents.llm.fake import FakeLLMClient, ScriptExhausted
from weathra.agents.llm.openrouter import OPENROUTER_PROVIDER_ID, OpenRouterClient
from weathra.agents.llm.registry import LLMProvider, available_providers, build_client
from weathra.config import Settings
from weathra.domain.errors import (
    AgentNotConfigured,
    ProviderNotFound,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    ValidationFailed,
)
from weathra.domain.evidence import InferenceStatus

BASE_URL = "https://gateway.test/api/v1"
COMPLETIONS = f"{BASE_URL}/chat/completions"
MODEL = "vendor/some-model:free"


class Routing(BaseModel):
    """A routing decision, standing in for the supervisor's real one."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    capability: Literal["forecast", "historical", "analytics", "rag"]
    location: str = Field(min_length=1)
    days: int = Field(ge=1, le=16)


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "supabase_url": "https://test.supabase.co",
        "openrouter_api_key": "test-credential-never-sent-anywhere",
        "openrouter_base_url": BASE_URL,
        "llm_model": MODEL,
        "llm_max_retries": 1,
        "http_backoff_seconds": 0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _client(settings: Settings | None = None) -> OpenRouterClient:
    resolved = settings or _settings()
    return OpenRouterClient(client=httpx.AsyncClient(), settings=resolved)


def _reply(content: str, *, model: str = MODEL, usage: dict[str, int] | None = None) -> dict:
    body: dict = {
        "id": "gen-1",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
    }
    if usage is not None:
        body["usage"] = usage
    return body


# =========================================================================== 13.1 the contract


def test_the_fake_satisfies_the_protocol() -> None:
    """Structurally, with no inheritance: the fake is an implementation, not a mock of one."""
    assert isinstance(FakeLLMClient(), LLMClient)


def test_the_openrouter_client_satisfies_the_protocol() -> None:
    assert isinstance(_client(), LLMClient)


def test_the_protocol_is_the_two_methods_and_the_identity() -> None:
    """A contract this small is what makes substituting an implementation a settings change.

    Methods and declared attributes are checked separately because a Protocol's annotated-only
    members do not appear in ``dir``.
    """
    methods = {name for name in vars(LLMClient) if not name.startswith("_")}
    assert methods == {"complete", "complete_json"}
    assert set(LLMClient.__annotations__) == {"provider_id", "model_id"}


def test_messages_are_weathras_own_shape() -> None:
    assert user_message("hello").role is Role.USER
    assert system_message("be careful").role is Role.SYSTEM
    assert Message.tool_result("get_forecast", "{}").name == "get_forecast"
    assert Message.assistant("done").role is Role.ASSISTANT


def test_a_message_refuses_a_field_it_does_not_know() -> None:
    """So a vendor's schema cannot be smuggled in through a dict."""
    with pytest.raises(ValueError, match="tool_calls"):
        Message.model_validate({"role": "assistant", "content": "x", "tool_calls": []})


def test_unreported_token_usage_is_absent_not_zero() -> None:
    """A zero would enter an evidence record as a measured fact."""
    usage = TokenUsage()
    assert usage.total_tokens is None
    assert not usage.reported


def test_a_completion_names_who_produced_it() -> None:
    completion = Completion(text="warm", provider_id="openrouter", model_id=MODEL)
    assert (completion.provider_id, completion.model_id) == ("openrouter", MODEL)
    assert not completion.truncated
    assert Completion(text="w", provider_id="p", model_id="m", finish_reason="length").truncated


# =========================================================================== 13.2 the fake


async def test_the_fake_drives_a_scripted_prose_completion() -> None:
    client = FakeLLMClient(completions=["Berlin is 11 °C tomorrow."])
    completion = await client.complete(system="be terse", messages=[user_message("Berlin?")])

    assert completion.text == "Berlin is 11 °C tomorrow."
    assert completion.provider_id == "fake"
    assert client.call_count == 1
    assert client.last_system_prompt() == "be terse"


async def test_the_fake_drives_a_scripted_routing_decision() -> None:
    client = FakeLLMClient(
        json_responses=[{"capability": "forecast", "location": "Berlin", "days": 3}]
    )
    decision = await client.complete_json(
        system="route this", messages=[user_message("Berlin next 3 days?")], schema=Routing
    )

    assert decision.capability == "forecast"
    assert decision.location == "Berlin"
    assert decision.days == 3
    assert client.json_prompts[0][2] is Routing


async def test_the_fake_accepts_a_model_instance_and_still_validates_it() -> None:
    client = FakeLLMClient(
        json_responses=[Routing(capability="analytics", location="Lisbon", days=7)]
    )
    decision = await client.complete_json(system="", messages=[], schema=Routing)
    assert decision.capability == "analytics"


async def test_the_fake_accepts_realistic_mess_as_a_scripted_string() -> None:
    """Which is how the fenced-and-prefaced case gets exercised without a live model."""
    client = FakeLLMClient(
        json_responses=[
            'Here is the plan:\n```json\n{"capability": "rag", "location": "x", "days": 1}\n```'
        ]
    )
    decision = await client.complete_json(system="", messages=[], schema=Routing)
    assert decision.capability == "rag"


async def test_the_fake_rejects_a_scripted_object_the_schema_forbids() -> None:
    """Otherwise the fake would be more permissive than the thing it stands in for."""
    client = FakeLLMClient(
        json_responses=[{"capability": "tea-leaves", "location": "x", "days": 1}]
    )
    with pytest.raises(ValidationFailed, match="capability"):
        await client.complete_json(system="", messages=[], schema=Routing)


async def test_running_off_the_end_of_the_script_is_a_test_failure() -> None:
    """An extra model call in a step-budgeted graph is a finding, not something to paper over."""
    client = FakeLLMClient(completions=["one"])
    await client.complete(system="", messages=[])
    with pytest.raises(ScriptExhausted, match="extra call"):
        await client.complete(system="", messages=[])


async def test_the_fake_records_every_message_it_was_handed() -> None:
    client = FakeLLMClient(completions=["ok"])
    await client.complete(
        system="s", messages=[user_message("q"), Message.tool_result("get_forecast", "{}")]
    )
    assert client.all_content() == ["q", "{}"]


# =========================================================================== 13.3 the gateway


@respx.mock
async def test_a_prose_completion_over_the_gateway() -> None:
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(
            200, json=_reply("Berlin is 11 °C.", usage={"prompt_tokens": 40, "total_tokens": 55})
        )
    )

    completion = await _client().complete(system="be terse", messages=[user_message("Berlin?")])

    assert completion.text == "Berlin is 11 °C."
    assert completion.provider_id == OPENROUTER_PROVIDER_ID
    assert completion.model_id == MODEL
    assert completion.usage.total_tokens == 55
    assert completion.usage.completion_tokens is None, "an unreported count stays absent"

    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == MODEL
    assert sent["messages"][0] == {"role": "system", "content": "be terse"}
    assert sent["messages"][1] == {"role": "user", "content": "Berlin?"}


@respx.mock
async def test_a_json_completion_over_the_gateway() -> None:
    respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(
            200,
            json=_reply('{"capability": "forecast", "location": "Berlin", "days": 3}'),
        )
    )

    decision = await _client().complete_json(
        system="route this", messages=[user_message("Berlin?")], schema=Routing
    )
    assert decision == Routing(capability="forecast", location="Berlin", days=3)


@respx.mock
async def test_the_json_prompt_carries_the_schema() -> None:
    """So a model has something to conform to rather than a description of one."""
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(
            200, json=_reply('{"capability": "rag", "location": "x", "days": 1}')
        )
    )
    await _client().complete_json(system="route", messages=[], schema=Routing)

    system = json.loads(route.calls[0].request.content)["messages"][0]["content"]
    assert "single JSON object" in system
    assert "capability" in system, "the schema itself must be in the prompt"


@respx.mock
async def test_the_credential_travels_in_a_header_and_never_in_the_url() -> None:
    route = respx.post(COMPLETIONS).mock(return_value=httpx.Response(200, json=_reply("ok")))
    await _client().complete(system="", messages=[])

    request = route.calls[0].request
    assert request.headers["Authorization"].startswith("Bearer ")
    assert "test-credential" not in str(request.url), "a credential in a URL lands in access logs"


@respx.mock
async def test_the_model_the_gateway_actually_served_is_what_gets_reported() -> None:
    """A fallback route is visible in the evidence record rather than hidden by the request."""
    respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(200, json=_reply("ok", model="vendor/substituted-model"))
    )
    completion = await _client().complete(system="", messages=[])
    assert completion.model_id == "vendor/substituted-model"


@respx.mock
async def test_a_tool_result_is_labelled_and_carried_as_content() -> None:
    """Data, never instruction: the graph runs the tools and hands back what they said."""
    route = respx.post(COMPLETIONS).mock(return_value=httpx.Response(200, json=_reply("ok")))
    await _client().complete(
        system="", messages=[Message.tool_result("get_forecast", '{"max": 11.0}')]
    )

    sent = json.loads(route.calls[0].request.content)["messages"][1]
    assert sent["role"] == "user"
    assert sent["content"] == 'Result of tool get_forecast:\n{"max": 11.0}'


@respx.mock
async def test_a_timeout_surfaces_as_a_timeout() -> None:
    respx.post(COMPLETIONS).mock(side_effect=httpx.ReadTimeout("too slow"))
    with pytest.raises(ProviderTimeout) as raised:
        await _client().complete(system="", messages=[])
    assert raised.value.code == "provider_timeout"


@respx.mock
async def test_a_429_surfaces_as_rate_limiting_distinct_from_unavailability() -> None:
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(429, json={"error": "slow down"}))
    with pytest.raises(ProviderRateLimited) as raised:
        await _client().complete(system="", messages=[])
    assert raised.value.code == "provider_rate_limited"
    assert "slow down" not in str(raised.value), "an upstream body is not ours to forward"


@respx.mock
async def test_a_401_surfaces_as_a_configuration_error_not_an_outage() -> None:
    """The row that matters: a rejected credential is fixed on a settings screen, not by waiting."""
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(401, json={"error": {"message": "invalid api key"}})
    )
    with pytest.raises(AgentNotConfigured) as raised:
        await _client().complete(system="", messages=[])

    assert raised.value.code == "agent_not_configured"
    assert "OPENROUTER_API_KEY" in str(raised.value)
    assert "invalid api key" not in str(raised.value)
    assert route.call_count == 1, "a rejected credential must not be retried"


@respx.mock
async def test_a_403_is_treated_the_same_way() -> None:
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(403))
    with pytest.raises(AgentNotConfigured):
        await _client().complete(system="", messages=[])


@respx.mock
async def test_a_5xx_is_retried_and_then_reported_unavailable() -> None:
    route = respx.post(COMPLETIONS).mock(return_value=httpx.Response(503))
    with pytest.raises(ProviderUnavailable):
        await _client().complete(system="", messages=[])
    assert route.call_count == 2, "one retry, per llm_max_retries=1"


@respx.mock
async def test_a_transient_5xx_followed_by_success_succeeds() -> None:
    respx.post(COMPLETIONS).mock(
        side_effect=[httpx.Response(503), httpx.Response(200, json=_reply("recovered"))]
    )
    completion = await _client().complete(system="", messages=[])
    assert completion.text == "recovered"


@respx.mock
async def test_a_reply_with_no_choices_is_a_failure_not_an_empty_answer() -> None:
    """An empty string in an answer reads as Weathra having nothing to say."""
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(200, json={"model": MODEL}))
    with pytest.raises(ProviderUnavailable, match="no completion"):
        await _client().complete(system="", messages=[])


@respx.mock
async def test_a_choice_with_no_text_is_also_a_failure() -> None:
    respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(
            200, json={"model": MODEL, "choices": [{"message": {"role": "assistant"}}]}
        )
    )
    with pytest.raises(ProviderUnavailable, match="no text"):
        await _client().complete(system="", messages=[])


# =========================================================================== 13.4 JSON enforcement


@pytest.mark.parametrize(
    "reply",
    [
        '{"capability": "forecast", "location": "Berlin", "days": 3}',
        '```json\n{"capability": "forecast", "location": "Berlin", "days": 3}\n```',
        '```\n{"capability": "forecast", "location": "Berlin", "days": 3}\n```',
        'Here is the plan:\n{"capability": "forecast", "location": "Berlin", "days": 3}',
        '  \n {"capability": "forecast", "location": "Berlin", "days": 3}  \n',
    ],
    ids=["bare", "fenced-json", "fenced-plain", "prefaced", "padded"],
)
def test_a_json_object_is_recovered_from_however_the_model_wrapped_it(reply: str) -> None:
    assert extract_json_object(reply)["location"] == "Berlin"


@pytest.mark.parametrize(
    "reply",
    ["", "I would rather not.", "{", '{"capability": "forecast",}', "[1, 2, 3]"],
    ids=["empty", "prose", "truncated", "trailing-comma", "array"],
)
def test_malformed_json_is_a_failure_rather_than_a_repair(reply: str) -> None:
    """Guessing at what a malformed routing decision meant is how a confident wrong answer starts."""
    with pytest.raises(ValidationFailed):
        extract_json_object(reply)


def test_a_validation_error_names_the_field_so_a_model_can_correct_it() -> None:
    """ "expected one of forecast, historical…" is correctable; "invalid" is not."""
    with pytest.raises(ValidationFailed) as raised:
        validate_against({"capability": "forecast", "location": "Berlin", "days": 99}, Routing)
    assert "days" in str(raised.value)
    assert "16" in str(raised.value)


@respx.mock
async def test_malformed_json_is_corrected_on_a_retry() -> None:
    route = respx.post(COMPLETIONS).mock(
        side_effect=[
            httpx.Response(200, json=_reply("I think Berlin, probably three days")),
            httpx.Response(
                200, json=_reply('{"capability": "forecast", "location": "Berlin", "days": 3}')
            ),
        ]
    )

    decision = await _client().complete_json(system="route", messages=[], schema=Routing)

    assert decision.days == 3
    assert route.call_count == 2

    # The retry carries the model's own reply and then the error, in that order.
    second = json.loads(route.calls[1].request.content)["messages"]
    assert second[-2]["content"] == "I think Berlin, probably three days"
    assert second[-2]["role"] == "assistant"
    assert "not accepted" in second[-1]["content"]
    assert second[-1]["role"] == "user"


@respx.mock
async def test_a_schema_violation_is_corrected_on_a_retry() -> None:
    """Well-formed JSON that the schema rejects gets the same treatment as malformed JSON."""
    route = respx.post(COMPLETIONS).mock(
        side_effect=[
            httpx.Response(200, json=_reply('{"capability": "tea-leaves", "location": "x"}')),
            httpx.Response(200, json=_reply('{"capability": "rag", "location": "x", "days": 1}')),
        ]
    )
    decision = await _client().complete_json(system="route", messages=[], schema=Routing)

    assert decision.capability == "rag"
    assert "capability" in json.loads(route.calls[1].request.content)["messages"][-1]["content"]


@respx.mock
async def test_repeated_failure_raises_after_the_configured_attempts() -> None:
    """Bounded: the budget belongs to the person waiting."""
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(200, json=_reply("never valid"))
    )
    settings = _settings(llm_json_max_attempts=3)

    with pytest.raises(ValidationFailed) as raised:
        await _client(settings).complete_json(system="route", messages=[], schema=Routing)

    assert route.call_count == 3
    assert "3 attempts" in str(raised.value)
    assert raised.value.details["schema"] == "Routing"


@respx.mock
async def test_valid_json_first_time_costs_one_call() -> None:
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(
            200, json=_reply('{"capability": "rag", "location": "x", "days": 1}')
        )
    )
    await _client().complete_json(system="route", messages=[], schema=Routing)
    assert route.call_count == 1


# =========================================================================== 13.5 lazy construction


def test_no_credential_means_construction_raises_and_names_what_is_missing() -> None:
    settings = Settings(supabase_url="https://test.supabase.co")
    assert not settings.inference_configured

    with pytest.raises(AgentNotConfigured) as raised:
        build_client(httpx.AsyncClient(), settings)

    assert "OPENROUTER_API_KEY" in str(raised.value)
    assert raised.value.details["missing"] == "OPENROUTER_API_KEY"


def test_the_error_says_the_other_capabilities_still_work() -> None:
    """Because they do, and an operator reading only this message should know it."""
    with pytest.raises(AgentNotConfigured) as raised:
        build_client(httpx.AsyncClient(), Settings(supabase_url="https://test.supabase.co"))
    message = str(raised.value)
    for capability in ("forecast", "history", "analytics", "comparison", "locations"):
        assert capability in message


def test_the_provider_does_not_construct_a_client_until_it_is_asked() -> None:
    """The whole reason it is lazy: an unconfigured agent surface is not a startup failure."""
    provider = LLMProvider(httpx.AsyncClient(), Settings(supabase_url="https://test.supabase.co"))

    assert not provider.built
    assert not provider.configured

    with pytest.raises(AgentNotConfigured):
        provider.get()


def test_a_configured_provider_builds_once_and_caches() -> None:
    provider = LLMProvider(httpx.AsyncClient(), _settings())
    assert provider.configured
    assert not provider.built

    first = provider.get()
    assert provider.built
    assert provider.get() is first


def test_readiness_reports_whether_inference_is_configured_without_the_credential() -> None:
    provider = LLMProvider(httpx.AsyncClient(), _settings())
    reported = {
        "configured": provider.configured,
        "provider": provider.provider_id,
        "model": provider.model_id,
    }
    assert reported == {"configured": True, "provider": "openrouter", "model": MODEL}
    assert "test-credential-never-sent-anywhere" not in json.dumps(reported)


def test_an_unknown_provider_name_lists_the_registered_ones() -> None:
    with pytest.raises(ProviderNotFound) as raised:
        build_client(httpx.AsyncClient(), _settings(llm_provider="hand-waving"))
    assert "openrouter" in str(raised.value)


def test_the_fake_is_not_reachable_through_configuration() -> None:
    """A deployment must not be able to answer a weather question from a script."""
    assert "fake" not in available_providers()
    with pytest.raises(ProviderNotFound):
        build_client(httpx.AsyncClient(), _settings(llm_provider="fake"))


def test_a_provider_can_be_overridden_with_the_fake_for_tests() -> None:
    provider = LLMProvider(httpx.AsyncClient(), Settings(supabase_url="https://test.supabase.co"))
    fake = FakeLLMClient(completions=["scripted"])
    provider.override(fake)
    assert provider.get() is fake


# =========================================================================== task 22.8
#
# Failure classification. The Task 22.8 live runs failed because a withdrawn model's 404 and a
# model that answered badly were indistinguishable by the time anything downstream looked. These
# assert the distinction at the layer that first knows it.


@pytest.mark.parametrize(
    ("response", "expected", "expected_status"),
    [
        (httpx.Response(404, json={"error": "no endpoints found"}), "model_unavailable", 404),
        (httpx.Response(503), "provider_error", 503),
        (httpx.Response(500), "provider_error", 500),
        (httpx.Response(400, json={"error": "bad request"}), "provider_error", 400),
    ],
    ids=["404-withdrawn", "503", "500", "400"],
)
@respx.mock
async def test_a_gateway_status_classifies_to_its_own_inference_outcome(
    response: httpx.Response, expected: str, expected_status: int
) -> None:
    """A 404 is a withdrawn model; a 5xx is a broken gateway. Both arrive as ProviderUnavailable,
    and only the recorded status tells them apart — which is the whole of the Task 22.8 defect."""
    respx.post(COMPLETIONS).mock(return_value=response)

    with pytest.raises(ProviderUnavailable) as caught:
        await _client().complete(system="s", messages=[user_message("q")])

    status, http_status = classify_inference_failure(caught.value)
    assert status.value == expected
    assert http_status == expected_status
    assert status.infrastructure_failure is True
    assert status.served is False


@respx.mock
async def test_a_rate_limit_classifies_apart_from_unavailability() -> None:
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(429))

    with pytest.raises(ProviderRateLimited) as caught:
        await _client().complete(system="s", messages=[user_message("q")])

    status, http_status = classify_inference_failure(caught.value)
    assert status is InferenceStatus.RATE_LIMITED
    assert http_status == 429
    assert status is not InferenceStatus.PROVIDER_ERROR


@respx.mock
async def test_a_timeout_and_a_connection_failure_both_classify_as_timeout() -> None:
    """Two transport realities, one condition to everyone downstream: no reply arrived."""
    respx.post(COMPLETIONS).mock(side_effect=httpx.ConnectTimeout("slow"))
    with pytest.raises(ProviderTimeout) as timed_out:
        await _client().complete(system="s", messages=[user_message("q")])
    assert classify_inference_failure(timed_out.value)[0] is InferenceStatus.TIMEOUT

    respx.post(COMPLETIONS).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ProviderUnavailable) as unreachable:
        await _client().complete(system="s", messages=[user_message("q")])
    status, http_status = classify_inference_failure(unreachable.value)
    assert status is InferenceStatus.TIMEOUT
    assert http_status is None, "a reachability failure has no HTTP status to report"


@respx.mock
async def test_invalid_output_classifies_as_served_not_as_a_provider_failure() -> None:
    """The single most important line in the classifier.

    The model answered. It answered with something that is not a routing plan, which is a *quality*
    result. Classifying it as infrastructure would let a weak model launder its failures as an
    outage — the exact mirror of the defect this work exists to fix.
    """
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(200, json=_reply("not json at all")))

    with pytest.raises(ValidationFailed) as caught:
        await _client(_settings(llm_json_max_attempts=1)).complete_json(
            system="s", messages=[user_message("q")], schema=Routing
        )

    status, _ = classify_inference_failure(caught.value)
    assert status is InferenceStatus.INVALID_OUTPUT
    assert status.served is True
    assert status.infrastructure_failure is False


@respx.mock
async def test_a_rejected_credential_stays_a_configuration_fault() -> None:
    """Not an outage and not a failover trigger: retrying sends the same bad key again."""
    respx.post(COMPLETIONS).mock(return_value=httpx.Response(401))

    with pytest.raises(AgentNotConfigured) as caught:
        await _client().complete(system="s", messages=[user_message("q")])

    status, _ = classify_inference_failure(caught.value)
    assert status is InferenceStatus.NOT_CONFIGURED
    assert status.infrastructure_failure is False


@respx.mock
async def test_a_retry_after_within_the_ceiling_is_honoured() -> None:
    """The gateway knows when its window opens and we do not. Sub-second linear backoff cannot
    clear a per-minute rate limit however many times it is repeated."""
    route = respx.post(COMPLETIONS).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"}),
            httpx.Response(200, json=_reply("recovered")),
        ]
    )

    completion = await _client(_settings(llm_rate_limit_max_wait_seconds=30.0)).complete(
        system="s", messages=[user_message("q")]
    )

    assert completion.text == "recovered"
    assert route.call_count == 2


@respx.mock
async def test_a_retry_after_beyond_the_ceiling_stops_rather_than_waiting() -> None:
    """Bounded patience. A delay longer than we are willing to make a caller wait is reported,
    not slept through and not disguised as more attempts."""
    route = respx.post(COMPLETIONS).mock(
        return_value=httpx.Response(429, headers={"Retry-After": "600"})
    )

    with pytest.raises(ProviderRateLimited) as caught:
        await _client(_settings(llm_rate_limit_max_wait_seconds=5.0)).complete(
            system="s", messages=[user_message("q")]
        )

    assert route.call_count == 1, "a delay beyond the ceiling must not be retried"
    assert caught.value.details["retry_after_seconds"] == 600.0
    assert classify_inference_failure(caught.value)[0] is InferenceStatus.RATE_LIMITED
