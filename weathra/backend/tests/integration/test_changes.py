"""The What Changed? endpoint — the HTTP exposure of task 8.7's comparison capability.

`db`, like every other API test: the route opens a request-scoped session, and the comparison it
delegates to reads and writes the shared ``forecast_snapshots`` table, which has no in-memory
equivalent worth testing against.

The tests here are about the *route*, not about the comparison — the comparison's own rules (matching
days by local date, the per-measure insignificance margin, the no-prior-snapshot answer) are proved
against the domain in ``tests/integration/test_snapshots.py``. What this file proves is that the
endpoint hands the retrieved forecast to that capability and returns what it produced, that the three
answers a caller can get are distinguishable, and that an unauthenticated request never reaches a
provider.
"""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from tests.agent_support import BERLIN, StubGeocoder, stub_provider
from tests.api_support import ApiFactory, ApiHarness, harness
from tests.auth_support import USER_A, TokenFactory
from weathra.auth.rls import administrative_session, session_for
from weathra.domain.errors import ProviderRateLimited, ProviderTimeout, ProviderUnavailable
from weathra.domain.identity import Principal
from weathra.domain.weather import Forecast, UnitSystem
from weathra.weather import snapshots
from weathra.weather.snapshots import SnapshotCaptureResult, capture

pytestmark = pytest.mark.db

PREFIX = "/api/v1"
CHANGES = f"{PREFIX}/weather/changes"

# The stub's forecasts are retrieved at a fixed instant, so an "earlier" snapshot is anchored
# relative to it rather than to a clock.
STUB_RETRIEVED_AT = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
YESTERDAY = STUB_RETRIEVED_AT - timedelta(days=1)


@pytest.fixture
def api_factory(
    token_factory: TokenFactory, migrated_database: str, clean_database: None
) -> ApiFactory:
    def build(**overrides: Any) -> AbstractAsyncContextManager[ApiHarness]:
        return harness(factory=token_factory, database_url=migrated_database, **overrides)

    return build


async def earlier_forecast(*, daily_values: list[float]) -> Forecast:
    """A forecast of the same window the harness's provider will return, retrieved a day sooner.

    Built by asking a second stub for the same location, horizon, and units, so the location,
    window, provider, and unit system match exactly — which is what ``previous_snapshot`` keys on.
    Only the figures and the retrieval time differ, which is what makes a comparison possible.

    ``forecast_start`` has to match the harness's too, and is passed rather than left to default:
    the harness starts its forecast today, so a second stub on the default fixed date describes a
    different window and ``previous_snapshot`` correctly finds nothing to compare against.
    """
    retrieved = await stub_provider(
        daily_values=daily_values, forecast_start=date.today()
    ).forecast(BERLIN, days=7, unit_system=UnitSystem.METRIC)
    return retrieved.model_copy(update={"retrieved_at": YESTERDAY})


async def seed(api: ApiHarness, forecast: Forecast) -> None:
    """Record a snapshot the way a request would: through the restricted, claims-bound session."""
    actor = Principal.from_claims(
        {"sub": USER_A, "email": "a@example.test", "email_verified": True}
    )
    async with session_for(api.app.state.engines, actor) as session:
        result = await capture(session, forecast)
    assert result.stored, result.reason


# ============================================================== a populated comparison


async def test_an_authenticated_request_reports_movement_against_an_earlier_snapshot(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        # 8.0 yesterday against the harness stub's 11.0 today: a 3.0 °C move, well outside the
        # 0.5 °C materiality margin the domain applies.
        await seed(api, await earlier_forecast(daily_values=[8.0] * 7))

        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == 200, response.text[:300]
        body = response.json()

        assert body["comparison_available"] is True
        assert body["previous_retrieved_at"] is not None
        assert body["current_retrieved_at"] is not None
        assert body["previous_retrieved_at"] < body["current_retrieved_at"]

        material = [change for change in body["changes"] if change["material"]]
        assert material, "an earlier snapshot 3 °C cooler must produce material movement"
        highs = [change for change in material if change["measure"] == "temperature_max"]
        assert highs, material
        assert highs[0]["previous"] == 8.0
        assert highs[0]["current"] == 11.0
        assert highs[0]["change"] == pytest.approx(3.0)
        assert highs[0]["unit"]
        assert highs[0]["statement"]


async def test_a_populated_comparison_carries_its_provenance_and_data_class(
    api_factory: ApiFactory,
) -> None:
    """``specs/web-ui`` renders provider, location, window, and retrieval time beside the figures."""
    async with api_factory() as api:
        await seed(api, await earlier_forecast(daily_values=[8.0] * 7))

        body = (
            await api.client.get(
                CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
            )
        ).json()

        assert body["provider"] == "stub"
        assert body["unit_system"] == "metric"
        assert body["data_class"] == "forecast"
        assert body["location"]["display_name"] == BERLIN.display_name
        assert body["period"]["start_local"] and body["period"]["end_local"]
        assert body["statement"]


# ================================================================ no earlier snapshot


async def test_a_window_with_nothing_earlier_says_so_rather_than_reporting_no_movement(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == 200, response.text[:300]
        body = response.json()

        assert body["comparison_available"] is False
        assert body["previous_retrieved_at"] is None
        assert body["changes"] == [], "no earlier snapshot is not a set of zero deltas"
        assert "nothing to compare against" in body["statement"]
        # And the successful shape is still complete, so a client renders the same section.
        assert body["provider"] and body["location"] and body["period"]


# ============================================================= comparison unavailable


@pytest.mark.parametrize(
    ("failure", "expected_status"),
    [
        (ProviderUnavailable("the provider is unreachable"), 502),
        (ProviderTimeout("the provider timed out"), 504),
        (ProviderRateLimited("the provider is rate-limiting"), 429),
    ],
    ids=["unavailable", "timeout", "rate-limited"],
)
async def test_a_comparison_that_cannot_be_obtained_is_an_error_in_the_standard_envelope(
    api_factory: ApiFactory, failure: Exception, expected_status: int
) -> None:
    """ "We could not ask" is a failure, and must not arrive looking like "nothing to compare"."""
    async with api_factory(provider=stub_provider(failure=failure), geocoder=StubGeocoder()) as api:
        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == expected_status, response.text[:300]
        body = response.json()
        assert set(body) == {"error"}
        assert set(body["error"]) == {"code", "message", "details", "request_id"}
        assert body["error"]["code"] == failure.code  # type: ignore[attr-defined]
        # Nothing here can be mistaken for a comparison.
        assert "comparison_available" not in response.text


async def test_an_unresolvable_location_is_a_not_found_in_the_same_envelope(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            CHANGES, params={"location": "Atlantis"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "location_not_found"


# ================================================================== unauthenticated


async def test_an_unauthenticated_request_is_refused_before_any_provider_is_called(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(CHANGES, params={"location": "Berlin"})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_missing"
        assert response.headers.get("www-authenticate", "").startswith("Bearer")
        assert api.provider.forecast_calls == 0, "the refusal happens at the dependency"

        async with administrative_session(api.app.state.engines) as admin:
            assert await admin.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 0


async def test_an_expired_token_is_refused_with_its_own_code(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            CHANGES,
            params={"location": "Berlin"},
            headers=api.bearer(api.factory.expired()),
        )

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_expired"
        assert api.provider.forecast_calls == 0


# =========================================== the route delegates rather than computes


async def test_the_route_delegates_the_comparison_to_the_domain_capability(
    api_factory: ApiFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The response *is* ``compare_with_previous``'s result, and the route computed no part of it.

    The spy wraps the real capability rather than replacing it, so the assertion is that the route
    calls it once, with the forecast it retrieved, and returns exactly what came back — not that
    some function with the right name was reachable.
    """
    from weathra.api.routers import changes as route

    calls: list[Forecast] = []
    produced: list[Any] = []

    async def spy(session: Any, forecast: Forecast, **kwargs: Any) -> Any:
        calls.append(forecast)
        report = await snapshots.compare_with_previous(session, forecast, **kwargs)
        produced.append(report)
        return report

    monkeypatch.setattr(route, "compare_with_previous", spy)

    async with api_factory() as api:
        await seed(api, await earlier_forecast(daily_values=[8.0] * 7))

        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == 200, response.text[:300]
        assert len(calls) == 1, "the comparison is asked for exactly once"
        assert calls[0].provider == "stub"
        assert calls[0].location.identifier == BERLIN.identifier
        # The body is the capability's own result, field for field — nothing added, nothing derived.
        assert response.json() == produced[0].model_dump(mode="json")


async def test_the_retrieval_is_recorded_so_a_later_request_has_something_to_compare(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )
        assert response.status_code == 200

        async with administrative_session(api.app.state.engines) as admin:
            rows = (
                await admin.execute(
                    text("SELECT location_id, provider, unit_system FROM forecast_snapshots")
                )
            ).all()

        assert len(rows) == 1
        assert rows[0][0] == BERLIN.identifier
        assert rows[0][1] == "stub"
        assert rows[0][2] == "metric"


async def test_a_snapshot_that_cannot_be_recorded_does_not_fail_the_response(
    api_factory: ApiFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``specs/forecast-analysis``: a storage failure is logged and the answer still returned."""
    from weathra.api.routers import changes as route

    async def refuses(session: Any, forecast: Forecast) -> SnapshotCaptureResult:
        return SnapshotCaptureResult(stored=False, reason="snapshot storage failed (Simulated)")

    monkeypatch.setattr(route, "capture", refuses)

    async with api_factory() as api:
        response = await api.client.get(
            CHANGES, params={"location": "Berlin"}, headers=api.authorize(subject=USER_A)
        )

        assert response.status_code == 200, response.text[:300]
        assert response.json()["comparison_available"] is False


# ============================================================== the caller's own settings


async def test_the_units_and_horizon_come_from_the_signed_in_person_when_not_supplied(
    api_factory: ApiFactory,
) -> None:
    """The same preference resolution every weather route uses, so the briefing is theirs."""
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        updated = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"unit_system": "imperial", "forecast_horizon_days": 3},
            headers=headers,
        )
        assert updated.status_code == 200, updated.text[:300]

        body = (
            await api.client.get(CHANGES, params={"location": "Berlin"}, headers=headers)
        ).json()

        assert body["unit_system"] == "imperial"
        assert body["period"]["start_local"] and body["period"]["end_local"]
