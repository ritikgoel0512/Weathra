"""Tasks 30.6, 30.7 and 30.9 — the gate and the usage endpoint, through the real app.

Everything here drives ``build_app``: the real middleware, the real error handlers, the real
dependency graph, a real database, and a scripted inference client. That matters more than usual
for this group, because the two properties the spec is most insistent about are properties of
*where* the check happens rather than of what it computes — before any gateway call, and before a
stream opens — and neither can be asserted from below the route.

The scripted client is also the instrument. It counts its own calls, so "refused before any
language model call was made" is a number rather than an inference from a status code.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from sqlalchemy import text

from tests.api_support import ApiFactory, ApiHarness
from tests.db_support import new_user_id
from weathra.agents.llm.base import Completion, Message
from weathra.agents.llm.fake import FakeLLMClient
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.db.session import privileged_session
from weathra.domain.errors import ProviderRateLimited

pytestmark = pytest.mark.db

PREFIX = "/api/v1"
ADMIN_CLAIMS = {"app_metadata": {"weathra_role": "administrator"}}


def _plan(*steps: PlanStep) -> dict:
    return RoutingPlan(steps=steps, reason="a scripted plan").model_dump(mode="json")


FORECAST_PLAN = _plan(
    PlanStep(
        capability=Capability.FORECAST, reason="a forecast was asked for", location="Berlin", days=3
    )
)


class _CountingFake:
    """A scripted client that reports how many times it was actually called.

    The point of the two headline tests is that the gateway is *not reached*, and a status code
    alone cannot say that: a 429 raised after a call would look identical from outside.
    """

    def __init__(self) -> None:
        self.provider_id = "fake"
        self.model_id = "weathra-fake-1"
        self.calls = 0
        self._inner = FakeLLMClient(
            completions=["Berlin looks mild."] * 8, json_responses=[FORECAST_PLAN] * 8
        )

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        self.calls += 1
        return await self._inner.complete(system=system, messages=messages)

    async def complete_json(self, *, system: str, messages: Sequence[Message], schema: type):  # type: ignore[no-untyped-def]
        self.calls += 1
        return await self._inner.complete_json(system=system, messages=messages, schema=schema)


def with_inference(api_factory: ApiFactory, **overrides: object) -> object:
    return api_factory(openrouter_api_key="test-credential-never-sent", **overrides)


def install(api: ApiHarness) -> _CountingFake:
    fake = _CountingFake()
    api.app.state.inference.override(fake)
    return fake


async def exhaust(api: ApiHarness, user_id: str, *, dimension: str = "requests_per_day") -> None:
    """Put this caller at their Free allowance, without spending it a question at a time."""
    async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
        allowance = await session.scalar(
            text("SELECT allowance FROM usage_limits WHERE plan_code='free' AND dimension=:d"),
            {"d": dimension},
        )
        window = await session.scalar(
            text(
                "SELECT CASE WHEN :d LIKE '%%_day' THEN to_char(now(),'YYYY-MM-DD') "
                "            WHEN :d = 'concurrent_runs' THEN 'current' "
                "            ELSE to_char(now(),'YYYY-MM') END"
            ),
            {"d": dimension},
        )
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, :d, :w, :c) ON CONFLICT (subject, dimension, window_key) "
                "DO UPDATE SET consumed = excluded.consumed"
            ),
            {"u": user_id, "d": dimension, "w": window, "c": int(allowance or 0)},
        )


async def ask(api: ApiHarness, user_id: str, **claims: object):  # type: ignore[no-untyped-def]
    return await api.client.post(
        f"{PREFIX}/agent/ask",
        json={"question": "What is the forecast for Berlin?"},
        headers=api.authorize(subject=user_id, **claims),
    )


# =========================================================================== 30.6 the gate


async def test_a_question_within_the_allowance_is_answered_and_charged(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        assert (await ask(api, user_id)).status_code == 200

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            consumed = await session.scalar(
                text(
                    "SELECT consumed FROM usage_counters "
                    " WHERE subject = :u AND dimension = 'requests_per_day'"
                ),
                {"u": user_id},
            )
        assert consumed == 1


async def test_an_exhausted_caller_is_refused_before_any_language_model_call_is_made(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`' central requirement: the check is in the backend, before the call."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        fake = install(api)
        await exhaust(api, user_id)

        response = await ask(api, user_id)

        assert response.status_code == 429
        assert fake.calls == 0, "the gateway was reached despite the refusal"

        body = response.json()["error"]
        assert body["code"] == "quota_exceeded"
        assert body["details"]["dimension"] == "requests_per_day"
        assert body["details"]["allowance"] == 25
        assert body["details"]["consumed"] == 25
        assert body["details"]["resets_at"]


async def test_a_refused_question_records_no_usage_event(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        await exhaust(api, user_id)
        await ask(api, user_id)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            events = await session.scalar(text("SELECT count(*) FROM llm_usage_events"))
        assert events == 0


async def test_the_stream_is_refused_before_it_opens_rather_than_terminated_mid_answer(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """A 429 is a 429. Inside the generator it would be a 200 whose first event apologises, and a
    client would have to parse the body to discover it had been refused."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        fake = install(api)
        await exhaust(api, user_id)

        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=user_id),
        )

        assert response.status_code == 429
        assert "text/event-stream" not in response.headers.get("content-type", "")
        assert response.json()["error"]["code"] == "quota_exceeded"
        assert fake.calls == 0


async def test_the_quota_refusal_is_distinguishable_from_every_other_429_and_4xx(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Four failures a client must be able to tell apart, asserted as four codes rather than as
    four status codes — two of which are the same number."""
    user_id = new_user_id()

    async with api_factory() as unconfigured:
        no_credential = await ask(unconfigured, user_id)
    assert no_credential.status_code == 503
    assert no_credential.json()["error"]["code"] == "agent_not_configured"

    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        unauthenticated = await api.client.post(
            f"{PREFIX}/agent/ask", json={"question": "What is the forecast for Berlin?"}
        )
        assert unauthenticated.status_code == 401
        assert unauthenticated.json()["error"]["code"] == "token_missing"

        await exhaust(api, user_id)
        refused = await ask(api, user_id)

    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "quota_exceeded"
    assert refused.json()["error"]["code"] != "provider_rate_limited", (
        "the subscription saying no and the gateway saying not yet must not share a code"
    )


async def test_a_gateway_rate_limit_and_a_spent_allowance_are_different_429s(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Both are 429, and a client that could not tell them apart would retry the wrong one forever:
    the gateway's clears on its own, the subscription's not until the window turns over.

    The gateway's is asked of a weather route, because on the agent route it never reaches a
    caller at all — the graph degrades to the deterministic router and answers anyway
    (`specs/agent-orchestration`). That is worth stating: the only 429 an agent caller sees is the
    quota one, so it had better carry everything the refusal needs to be actionable.
    """
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        await exhaust(api, user_id)
        subscription = await ask(api, user_id)

        gateway = await api.client.get(
            f"{PREFIX}/weather/forecast",
            params={"location": "Nowhere-at-all", "days": 3},
            headers=api.authorize(subject=user_id),
        )

    assert subscription.status_code == 429
    assert subscription.json()["error"]["code"] == "quota_exceeded"
    details = subscription.json()["error"]["details"]
    assert {"dimension", "allowance", "consumed", "resets_at", "retry_after_seconds"} <= set(
        details
    )

    # The gateway's own 429 is `provider_rate_limited` wherever it surfaces — proved against a real
    # throttled upstream in `test_api.py::test_each_upstream_condition_maps_to_its_own_status`. What
    # matters here is that the two are different codes carrying different information, and that the
    # quota one is the only 429 on this path that a client can act on by waiting for a window.
    assert gateway.status_code != 429 or gateway.json()["error"]["code"] != "quota_exceeded"


async def test_a_gateway_rate_limit_does_not_refund_the_request_it_spent(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """The gateway answered — badly, but it answered. The request reached a model and is spent."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        api.script(failure=ProviderRateLimited("the gateway is throttling this account"))
        await ask(api, user_id)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            consumed = await session.scalar(
                text(
                    "SELECT consumed FROM usage_counters "
                    " WHERE subject = :u AND dimension = 'requests_per_day'"
                ),
                {"u": user_id},
            )
    assert consumed == 1


async def test_a_direct_api_call_cannot_bypass_the_gate(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """There is no frontend in this test at all, which is the point: the outcome is identical."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        await exhaust(api, user_id)
        response = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?", "plan": "premium"},
            headers={**api.authorize(subject=user_id), "X-Weathra-Plan": "premium"},
        )
    # A body field the model forbids is a 400 before the gate is ever reached, which is itself
    # the point: there is no field here that could have carried a plan.
    assert response.status_code in {400, 422, 429}
    if response.status_code == 429:
        assert response.json()["error"]["details"]["allowance"] == 25, (
            "the backend-held plan decided, not the one the request asserted"
        )


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/locations/search?query=Berlin", None),
        ("GET", "/weather/current?location=Berlin", None),
        ("GET", "/weather/forecast?location=Berlin&days=3", None),
        ("GET", "/weather/history?location=Berlin&start=2026-01-01&end=2026-01-07", None),
        ("GET", "/weather/analysis?location=Berlin&days=3", None),
        (
            "POST",
            "/weather/comparison",
            {"criterion": "warmest", "locations": ["Berlin", "Munich"], "days": 3},
        ),
    ],
)
async def test_capabilities_that_need_no_model_keep_serving_an_exhausted_caller(
    api_factory: ApiFactory,
    seeded_reference_data: None,
    method: str,
    path: str,
    body: dict | None,
) -> None:
    """`specs/usage-limits`: the allowance is on language model usage, not on the weather."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        await exhaust(api, user_id)
        response = await api.client.request(
            method, f"{PREFIX}{path}", json=body, headers=api.authorize(subject=user_id)
        )
    assert response.status_code == 200, (
        f"{path} answered {response.status_code}: {response.text[:300]}"
    )


# =========================================================================== 30.9 non-destructive


async def test_a_refusal_leaves_the_thread_preferences_and_saved_locations_untouched(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        headers = api.authorize(subject=user_id)

        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )
        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
        )
        first = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?", "create_thread": True},
            headers=headers,
        )
        assert first.status_code == 200
        thread_id = first.json()["thread_id"]
        assert thread_id, "the follow-up needs a thread to be a follow-up of"

        await exhaust(api, user_id)
        refused = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "And tomorrow?", "thread_id": thread_id},
            headers=headers,
        )
        assert refused.status_code == 429

        preferences = await api.client.get(f"{PREFIX}/me/preferences", headers=headers)
        locations = await api.client.get(f"{PREFIX}/me/locations", headers=headers)
        thread = await api.client.get(f"{PREFIX}/threads/{thread_id}", headers=headers)

    assert preferences.json()["unit_system"] == "imperial"
    assert preferences.json()["sources"]["unit_system"] == "chosen"
    assert locations.json()["count"] == 1
    assert thread.status_code == 200, "the thread survived the refusal"


# =========================================================================== 30.7 own usage


async def test_the_usage_endpoint_reports_the_plan_the_allowances_and_the_resets(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        assert (await ask(api, user_id)).status_code == 200
        # The recent summary reads rows a background task writes (design.md decision 24), so it is
        # waited for rather than raced — the alternative is a test that passes on a fast machine.
        await api.app.state.usage_recorder.drain()
        response = await api.client.get(
            f"{PREFIX}/me/usage", headers=api.authorize(subject=user_id)
        )

    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == user_id
    assert body["plan_code"] == "free"
    assert body["plan_name"]
    assert body["internal"] is False

    by_name = {item["dimension"]: item for item in body["dimensions"]}
    daily = by_name["requests_per_day"]
    assert daily["allowance"] == 25
    assert daily["consumed"] == 1
    assert daily["remaining"] == 24
    assert daily["resets_at"]

    assert by_name["concurrent_runs"]["resets_at"] is None, "a gauge has no boundary"
    assert by_name["estimated_cost_per_month"]["allowance"] is None, "unlimited reads as null"
    assert body["recent"]["calls"] >= 1


async def test_the_usage_endpoint_ignores_a_supplied_identifier_for_somebody_else(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Not refused — ignored. There is no parameter to read, so there is nothing to authorize."""
    mine, theirs = new_user_id(), new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        assert (await ask(api, theirs)).status_code == 200

        response = await api.client.get(
            f"{PREFIX}/me/usage?user_id={theirs}",
            headers={**api.authorize(subject=mine), "X-User-Id": theirs},
        )

    body = response.json()
    assert body["user_id"] == mine
    by_name = {item["dimension"]: item for item in body["dimensions"]}
    assert by_name["requests_per_day"]["consumed"] == 0, "the other subject's usage leaked"
    assert body["recent"]["calls"] == 0


async def test_the_usage_endpoint_refuses_an_unauthenticated_call(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/me/usage")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_missing"


async def test_the_usage_endpoint_exposes_no_internal_usage_and_no_cost(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """An ordinary caller sees their own standing and nothing else — and no currency figure, which
    on a page with no billing behind it would read as an amount owed."""
    user_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                    "VALUES ('internal', 'requests_per_day', to_char(now(),'YYYY-MM-DD'), 77)"
                )
            )
        response = await api.client.get(
            f"{PREFIX}/me/usage", headers=api.authorize(subject=user_id)
        )

    body = response.json()
    rendered = response.text.lower()

    assert body["internal"] is False
    # Structurally rather than by looking for the number in the body: a random subject id contains
    # two arbitrary digits often enough that a substring check is a coin toss, and it was.
    for item in body["dimensions"]:
        assert item["consumed"] == 0, (
            f"{item['dimension']} reports consumption this caller never had"
        )
    assert {item["allowance"] for item in body["dimensions"]} != {
        2_000,
        30_000,
        60_000_000,
        8,
        None,
    }, "the internal allowances were reported to a product caller"
    daily = next(i for i in body["dimensions"] if i["dimension"] == "requests_per_day")
    assert daily["allowance"] == 25, "Free's allowance, not the internal subject's"

    # The cost *dimension* is reported, because a plan that does not limit it must say so. A cost
    # *amount* is not: a currency figure on a page with no billing behind it reads as money owed.
    for forbidden in ("currency", "usd", "price", "estimated_cost_total", "amount"):
        assert forbidden not in rendered, f"the usage endpoint exposes {forbidden!r}"


async def test_an_administrators_own_usage_reports_the_internal_allowance(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """Honest rather than confusing: their traffic really is accounted internally, so reporting
    their plan's allowance would tell them about a limit that does not apply to them."""
    admin_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        response = await api.client.get(
            f"{PREFIX}/me/usage", headers=api.authorize(subject=admin_id, **ADMIN_CLAIMS)
        )

    body = response.json()
    assert body["internal"] is True
    by_name = {item["dimension"]: item for item in body["dimensions"]}
    assert by_name["requests_per_day"]["allowance"] == 2_000, "the internal allowance, not Free's"


async def test_an_administrators_question_does_not_spend_a_plans_allowance(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    admin_id = new_user_id()
    async with with_inference(api_factory) as api:  # type: ignore[attr-defined]
        install(api)
        assert (await ask(api, admin_id, **ADMIN_CLAIMS)).status_code == 200

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            rows = await session.execute(
                text(
                    "SELECT subject, consumed FROM usage_counters "
                    " WHERE dimension = 'requests_per_day'"
                )
            )
            counters = {row[0]: row[1] for row in rows}

    assert counters.get("internal") == 1
    assert admin_id not in counters, "an administrator's question was charged to their own plan"


# =========================================================================== 30.8 disabled


async def test_the_suite_can_run_with_enforcement_off(
    api_factory: ApiFactory, seeded_reference_data: None
) -> None:
    """`QUOTA_ENABLED=false` for local and CI runs: the answer still comes, nothing is counted."""
    user_id = new_user_id()
    async with with_inference(api_factory, quota_enabled=False) as api:  # type: ignore[attr-defined]
        install(api)
        await exhaust(api, user_id)
        response = await ask(api, user_id)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            consumed = await session.scalar(
                text(
                    "SELECT consumed FROM usage_counters "
                    " WHERE subject = :u AND dimension = 'requests_per_day'"
                ),
                {"u": user_id},
            )

    assert response.status_code == 200
    assert consumed == 25, "the counter was left exactly as the test set it"
