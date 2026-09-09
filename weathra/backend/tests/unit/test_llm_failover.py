"""Tasks 28.6 and 28.9 — the client factory, and bounded infrastructure failover.

The failover tests are mostly about what must *not* happen. A loop that walked on any failure would
pass a "does it fail over" test perfectly and would be the exact behaviour `specs/model-policy`
forbids: try increasingly capable models until the answer looks acceptable. So each ineligible
class gets its own test, and the eligible set is asserted as a whole so that adding a status to the
enum does not silently enlarge it.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from weathra.agents.llm.base import Completion, LLMClient, Message
from weathra.agents.llm.factory import build_for_resolution
from weathra.agents.llm.failover import FAILOVER_ELIGIBLE, FailoverClient
from weathra.agents.llm.openrouter import OPENROUTER_PROVIDER_ID
from weathra.config import Settings
from weathra.domain.entitlements import CallRole, PolicyId, Resolution
from weathra.domain.errors import (
    AgentNotConfigured,
    ProviderNotFound,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    ValidationFailed,
)
from weathra.domain.evidence import InferenceStatus
from weathra.entitlements.records import CapabilityTier, CatalogEntry, CatalogStatus

GATEWAY = OPENROUTER_PROVIDER_ID


def _entry(key: str) -> CatalogEntry:
    return CatalogEntry(
        catalog_key=key,
        gateway_provider=GATEWAY,
        gateway_model=f"testvendor/{key}",
        display_name=key,
        capability_roles=(CallRole.ROUTING, CallRole.SYNTHESIS),
        capability_tier=CapabilityTier.ECONOMY,
        supports_structured_output=True,
        context_window=1000,
        input_price_per_million=Decimal("0"),
        output_price_per_million=Decimal("0"),
        price_currency="USD",
        pricing_recorded_on=date(2026, 9, 9),
        status=CatalogStatus.ENABLED,
        is_free_tier=True,
    )


def _resolution(key: str = "first") -> Resolution:
    return Resolution(
        policy_id=PolicyId("balanced"),
        catalog_key=key,
        gateway_provider=GATEWAY,
        gateway_model=f"testvendor/{key}",
        reason="selected " + key,
        call_role=CallRole.SYNTHESIS,
    )


class _Scripted:
    """A client that raises what it is told to, then answers."""

    def __init__(self, model_id: str, outcomes: Sequence[Exception | str]) -> None:
        self.provider_id = GATEWAY
        self.model_id = model_id
        self._outcomes = list(outcomes)
        self.calls = 0

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        self.calls += 1
        outcome = self._outcomes.pop(0) if self._outcomes else "ok"
        if isinstance(outcome, Exception):
            raise outcome
        return Completion(text=outcome, provider_id=self.provider_id, model_id=self.model_id)

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        self.calls += 1
        outcome = self._outcomes.pop(0) if self._outcomes else "{}"
        if isinstance(outcome, Exception):
            raise outcome
        return schema.model_validate({})


def _failover(
    outcomes_by_model: dict[str, list[Exception | str]],
    *,
    remaining: Sequence[str] = (),
    max_models: int = 3,
) -> tuple[FailoverClient, dict[str, _Scripted]]:
    built: dict[str, _Scripted] = {}

    def build(resolution: Resolution) -> LLMClient:
        client = _Scripted(
            resolution.gateway_model, outcomes_by_model.get(resolution.catalog_key, [])
        )
        built[resolution.catalog_key] = client
        return client

    primary = build(_resolution("first"))
    return (
        FailoverClient(
            primary,
            resolution=_resolution("first"),
            remaining=[_entry(key) for key in remaining],
            build=build,
            max_models=max_models,
        ),
        built,
    )


async def _ask(client: FailoverClient) -> Completion:
    return await client.complete(system="s", messages=[Message.user("q")])


# =========================================================================== 28.6 the factory


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "supabase_url": "https://test.supabase.co",
        "openrouter_api_key": "test-credential-never-sent",
    }
    values.update(overrides)
    return Settings(**values)


def test_the_factory_binds_the_resolved_model_to_the_instance() -> None:
    """The model is a constructor argument, so one process can hold several."""
    http = httpx.AsyncClient()
    client = build_for_resolution(_resolution("chosen"), http=http, settings=_settings())
    assert client.model_id == "testvendor/chosen"
    assert client.provider_id == OPENROUTER_PROVIDER_ID


def test_two_call_roles_may_hold_two_models_on_one_gateway() -> None:
    """`specs/model-policy`: a plan may map routing and synthesis to different policies, so one run
    can legitimately need two clients — same gateway, different model."""
    http = httpx.AsyncClient()
    settings = _settings()
    routing = build_for_resolution(
        _resolution("cheap").model_copy(update={"call_role": CallRole.ROUTING}),
        http=http,
        settings=settings,
    )
    synthesis = build_for_resolution(_resolution("frontier"), http=http, settings=settings)

    assert routing.provider_id == synthesis.provider_id
    assert routing.model_id != synthesis.model_id
    assert (routing.model_id, synthesis.model_id) == ("testvendor/cheap", "testvendor/frontier")


def test_the_factory_refuses_a_gateway_it_does_not_know() -> None:
    unknown = _resolution().model_copy(update={"gateway_provider": "some-other-gateway"})
    with pytest.raises(ProviderNotFound, match="not a registered inference gateway"):
        build_for_resolution(unknown, http=httpx.AsyncClient(), settings=_settings())


def test_the_factory_still_refuses_to_build_without_a_credential() -> None:
    """The guard that keeps every non-agent capability working with no key configured."""
    with pytest.raises(AgentNotConfigured):
        build_for_resolution(
            _resolution(),
            http=httpx.AsyncClient(),
            settings=Settings(supabase_url="https://test.supabase.co"),
        )


# =========================================================================== 28.9 what may advance


def test_the_eligible_set_is_exactly_the_infrastructure_failures() -> None:
    """Asserted as a whole so a status added to the enum cannot join it by accident."""
    eligible = {
        InferenceStatus.MODEL_UNAVAILABLE,
        InferenceStatus.PROVIDER_ERROR,
        InferenceStatus.TIMEOUT,
    }
    assert eligible == FAILOVER_ELIGIBLE
    assert InferenceStatus.RATE_LIMITED not in FAILOVER_ELIGIBLE
    assert InferenceStatus.INVALID_OUTPUT not in FAILOVER_ELIGIBLE
    assert InferenceStatus.NOT_CONFIGURED not in FAILOVER_ELIGIBLE


async def test_the_primary_serving_records_one_attempt_and_moves_nothing() -> None:
    client, built = _failover({"first": ["answered"]}, remaining=["second"])
    completion = await _ask(client)

    assert completion.text == "answered"
    assert [a.catalog_key for a in client.attempts] == ["first"]
    assert client.attempts[0].status is InferenceStatus.SERVED
    assert not client.failed_over
    assert "second" not in built, "an unneeded candidate must not even be constructed"


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (
            ProviderUnavailable("withdrawn", details={"status": 404}),
            InferenceStatus.MODEL_UNAVAILABLE,
        ),
        (ProviderUnavailable("broken", details={"status": 502}), InferenceStatus.PROVIDER_ERROR),
        (ProviderTimeout("slow"), InferenceStatus.TIMEOUT),
    ],
)
async def test_an_infrastructure_failure_moves_to_the_next_candidate(
    failure: Exception, expected: InferenceStatus
) -> None:
    client, _built = _failover(
        {"first": [failure], "second": ["answered by the second"]}, remaining=["second"]
    )
    completion = await _ask(client)

    assert completion.text == "answered by the second"
    assert [a.catalog_key for a in client.attempts] == ["first", "second"]
    assert client.attempts[0].status is expected
    assert client.attempts[1].status is InferenceStatus.SERVED
    assert client.failed_over
    assert client.resolution.catalog_key == "second", "the record must name what actually served"
    assert "failed over to second" in client.resolution.reason


async def test_a_gateway_rate_limit_never_changes_the_model() -> None:
    """429 is a property of the account. Another model changes only who gets blamed."""
    client, built = _failover(
        {"first": [ProviderRateLimited("slow down", details={"status": 429})], "second": ["x"]},
        remaining=["second"],
    )
    with pytest.raises(ProviderRateLimited):
        await _ask(client)

    assert [a.catalog_key for a in client.attempts] == ["first"]
    assert client.attempts[0].status is InferenceStatus.RATE_LIMITED
    assert "second" not in built


async def test_invalid_output_never_changes_the_model() -> None:
    """The model answered. Quality may not select a model — that is the whole rule."""
    client, built = _failover(
        {"first": [ValidationFailed("bad json")], "second": ["x"]}, remaining=["second"]
    )
    with pytest.raises(ValidationFailed):
        await _ask(client)

    assert [a.status for a in client.attempts] == [InferenceStatus.INVALID_OUTPUT]
    assert "second" not in built


async def test_a_missing_credential_never_changes_the_model() -> None:
    client, built = _failover(
        {"first": [AgentNotConfigured("no key")], "second": ["x"]}, remaining=["second"]
    )
    with pytest.raises(AgentNotConfigured):
        await _ask(client)
    assert "second" not in built


async def test_failover_is_bounded_by_the_configured_maximum() -> None:
    outage = ProviderUnavailable("down", details={"status": 503})
    client, _built = _failover(
        {"first": [outage], "second": [outage], "third": ["never reached"]},
        remaining=["second", "third"],
        max_models=2,
    )
    with pytest.raises(ProviderUnavailable):
        await _ask(client)

    assert [a.catalog_key for a in client.attempts] == ["first", "second"]
    assert len(client.attempts) == 2, "the bound counts the first attempt"


async def test_a_bound_of_one_means_no_failover_at_all() -> None:
    client, built = _failover(
        {"first": [ProviderTimeout("slow")], "second": ["x"]},
        remaining=["second"],
        max_models=1,
    )
    with pytest.raises(ProviderTimeout):
        await _ask(client)
    assert "second" not in built


async def test_exhausting_every_candidate_raises_rather_than_inventing_an_answer() -> None:
    outage = ProviderUnavailable("down", details={"status": 500})
    client, _built = _failover(
        {"first": [outage], "second": [outage]}, remaining=["second"], max_models=5
    )
    with pytest.raises(ProviderUnavailable):
        await _ask(client)

    assert [a.status for a in client.attempts] == [
        InferenceStatus.PROVIDER_ERROR,
        InferenceStatus.PROVIDER_ERROR,
    ]
    assert not any(a.served for a in client.attempts)


async def test_a_caller_never_reaches_a_candidate_it_was_not_given() -> None:
    """The entitlement guarantee, which is a property of what was passed in.

    A Free-plan caller's resolution carries only their own policy's candidates, so there is no call
    the loop could make to reach a Pro or Premium model — it has no list to reach it from.
    """
    client, built = _failover({"first": [ProviderTimeout("slow")]}, remaining=[])
    with pytest.raises(ProviderTimeout):
        await _ask(client)

    assert set(built) == {"first"}
    assert not client.failed_over


async def test_every_attempt_is_recorded_with_its_model_outcome_and_reason() -> None:
    client, _built = _failover(
        {
            "first": [ProviderUnavailable("gone", details={"status": 404})],
            "second": ["answered"],
        },
        remaining=["second"],
    )
    await _ask(client)

    first, second = client.attempts
    assert first.attempt_number == 1 and second.attempt_number == 2
    assert first.gateway_model == "testvendor/first"
    assert second.gateway_model == "testvendor/second"
    assert first.http_status == 404
    assert first.error_code == "provider_unavailable"
    assert first.latency_ms is not None and first.latency_ms >= 0
    assert second.status is InferenceStatus.SERVED


async def test_a_second_call_does_not_retry_a_candidate_already_known_to_be_down() -> None:
    """The list is consumed, so a run that failed over while routing does not re-try it later."""
    outage = ProviderUnavailable("down", details={"status": 503})
    client, _built = _failover(
        {"first": [outage], "second": ["one", "two"]}, remaining=["second"], max_models=3
    )
    assert (await _ask(client)).text == "one"
    assert (await _ask(client)).text == "two"
    assert [a.catalog_key for a in client.attempts] == ["first", "second", "second"]


def test_the_wrapper_satisfies_the_client_contract() -> None:
    client, _built = _failover({"first": ["x"]})
    assert isinstance(client, LLMClient)
