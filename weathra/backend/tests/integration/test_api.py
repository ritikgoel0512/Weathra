"""Group 15 and 16 — the HTTP API, through the real app.

Every test drives ``build_app``: the real lifespan, the real middleware, the real error handlers,
the real routers, the real MCP tool layer and analytics. The weather provider and geocoder are
stubs, the inference client is a script, and the tokens are minted locally — so the suite needs no
network, no Supabase, and no inference credential (design.md decision 20).

`db` because the app opens a request-scoped session on every route: even a public forecast needs a
transaction to read the caller's preferences from, and running against SQLite would test different
Row Level Security than the one that ships.
"""

from __future__ import annotations

import json
import re
import uuid
from contextlib import AbstractAsyncContextManager

import pytest

from tests.agent_support import BERLIN, MUNICH, StubGeocoder, stub_provider
from tests.api_support import ApiFactory, ApiHarness, capturing, harness
from tests.auth_support import USER_A, USER_B, TokenFactory
from tests.provider_support import stub_capabilities
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.api.classification import Access, classifications
from weathra.api.middleware import REQUEST_ID_HEADER, RequestIdFilter
from weathra.api.streaming import StreamEventType
from weathra.domain.errors import ProviderRateLimited, ProviderTimeout, ProviderUnavailable
from weathra.domain.weather import Granularity, Measure

pytestmark = pytest.mark.db

# A configuration identifier, by shape rather than by name: `SCREAMING_SNAKE_CASE` of two or more
# parts. By shape because a list of names only ever covers the variables that exist today, and the
# property being asserted is that *no* such identifier reaches a person reading a weather screen.
# The frontend carries the same pattern in `lib/api/errors.ts`, as the second line of the same
# defence.
CONFIGURATION_SHAPED = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")

PREFIX = "/api/v1"


def with_inference(api_factory: ApiFactory) -> AbstractAsyncContextManager[ApiHarness]:
    """The same app with a credential configured, so the agent routes are reachable."""
    return api_factory(openrouter_api_key="test-credential-never-sent")


def _plan(*steps: PlanStep, **kwargs: object) -> dict:
    return RoutingPlan(steps=steps, reason="a scripted plan", **kwargs).model_dump(mode="json")


# =========================================================================== 15.1 the app


async def test_the_app_starts_and_shuts_down_cleanly(api_factory: ApiFactory) -> None:
    """The harness ran the real lifespan to get here; this asserts what it built."""
    async with api_factory() as api:
        assert api.app.state.engines is not None
        assert api.app.state.tools is not None, "the in-process MCP client connected"
        assert api.app.state.token_validator is not None
        assert api.app.state.inference is not None
        assert not api.app.state.inference.built, "no credential means no client is constructed"


async def test_the_schema_is_served_under_the_version_prefix(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/openapi.json")
        assert response.status_code == 200
        assert response.json()["info"]["title"] == "Weathra"


async def test_the_interactive_documentation_is_served(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        for path in (f"{PREFIX}/docs", f"{PREFIX}/redoc"):
            response = await api.client.get(path)
            assert response.status_code == 200, path
            assert "text/html" in response.headers["content-type"]


async def test_cors_permits_the_authorization_header_from_a_configured_origin(
    api_factory: ApiFactory,
) -> None:
    """SSE and every protected call need it; a browser will not send one otherwise."""
    async with api_factory() as api:
        response = await api.client.options(
            f"{PREFIX}/weather/forecast",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert "authorization" in response.headers["access-control-allow-headers"].lower()


async def test_cors_does_not_permit_an_unconfigured_origin(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/health", headers={"Origin": "https://not-configured.example"}
        )
        # The request still succeeds server-side; what matters is that the browser is not told it may
        # read the response.
        assert "access-control-allow-origin" not in response.headers


async def test_the_configured_origins_are_never_a_wildcard(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        assert "*" not in api.settings.cors_allowed_origins


# =========================================================================== 15.4 classification


async def test_every_route_in_the_schema_is_classified(api_factory: ApiFactory) -> None:
    """``specs/http-api``: the classification appears in the schema's security metadata."""
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()

        for path, operations in schema["paths"].items():
            for method, operation in operations.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                assert "security" in operation, f"{method.upper()} {path} carries no classification"


async def test_the_schema_classification_matches_the_declared_one(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()
        declared = {entry.path: entry.access for entry in classifications()}

        for path, operations in schema["paths"].items():
            relative = path[len(PREFIX) :]
            expected = declared.get(relative)
            assert expected is not None, f"{relative} is in the app but not in the table"

            for method, operation in operations.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                secured = bool(operation.get("security"))
                assert secured == (expected is Access.PROTECTED), (
                    f"{method.upper()} {relative} is {'secured' if secured else 'open'} in the schema "
                    f"but {expected.value} in the table"
                )


async def test_the_declared_table_has_no_paths_the_app_does_not_serve(
    api_factory: ApiFactory,
) -> None:
    """The table cannot claim to classify an endpoint that does not exist."""
    async with api_factory() as api:
        schema = (await api.client.get(f"{PREFIX}/openapi.json")).json()
        served = {path[len(PREFIX) :] for path in schema["paths"]}
        declared = {entry.path for entry in classifications()}
        assert declared - served == set(), f"declared but not served: {sorted(declared - served)}"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/weather/changes"),
        ("POST", "/agent/ask"),
        ("POST", "/agent/stream"),
        ("GET", "/me"),
        ("GET", "/me/preferences"),
        ("PUT", "/me/preferences"),
        ("DELETE", "/me/preferences"),
        ("GET", "/me/locations"),
        ("POST", "/me/locations"),
        ("DELETE", "/me/locations/some-id"),
        ("DELETE", "/me/data"),
        ("GET", "/evidence/some-id"),
        ("GET", "/threads"),
        ("GET", "/threads/some-id"),
        ("DELETE", "/threads/some-id"),
    ],
)
async def test_every_protected_route_refuses_an_unauthenticated_request(
    api_factory: ApiFactory, method: str, path: str
) -> None:
    async with api_factory() as api:
        response = await api.client.request(method, f"{PREFIX}{path}", json={})
        assert response.status_code == 401, f"{method} {path} answered {response.status_code}"
        assert response.json()["error"]["code"] == "token_missing"
        assert response.headers.get("www-authenticate", "").startswith("Bearer")


@pytest.mark.parametrize(
    ("method", "path", "params"),
    [
        ("GET", "/health", {}),
        ("GET", "/ready", {}),
        ("GET", "/locations/search", {"query": "Berlin"}),
        ("GET", "/locations/resolve", {"query": "Berlin"}),
        ("GET", "/weather/current", {"location": "Berlin"}),
        ("GET", "/weather/forecast", {"location": "Berlin", "days": 3}),
        (
            "GET",
            "/weather/history",
            {"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07"},
        ),
        ("GET", "/weather/analysis", {"location": "Berlin", "days": 3}),
        (
            "GET",
            "/weather/history/baseline/comparison",
            {"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07", "years": 2},
        ),
    ],
)
async def test_every_public_route_succeeds_without_a_token(
    api_factory: ApiFactory, method: str, path: str, params: dict
) -> None:
    async with api_factory() as api:
        response = await api.client.request(method, f"{PREFIX}{path}", params=params)
        assert response.status_code == 200, f"{path} answered {response.text[:200]}"


# =========================================================================== 15.2 errors


async def test_every_error_uses_the_one_envelope(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Atlantis"}
        )
        assert response.status_code == 404

        body = response.json()
        assert set(body) == {"error"}
        assert set(body["error"]) == {"code", "message", "details", "request_id"}
        assert body["error"]["code"] == "location_not_found"
        assert body["error"]["request_id"] == response.headers[REQUEST_ID_HEADER]


async def test_fastapis_own_validation_error_becomes_the_same_envelope_at_400(
    api_factory: ApiFactory,
) -> None:
    """One error shape, so a client does not have to know which endpoints produce which."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": "many"}
        )

        assert response.status_code == 400, "not FastAPI's 422"
        body = response.json()
        assert body["error"]["code"] == "validation_failed"
        assert body["error"]["details"]["fields"]


async def test_a_validation_error_does_not_echo_the_input_back(api_factory: ApiFactory) -> None:
    """A malformed body may carry anything, including something pasted into the wrong field."""
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={"criterion": "warmest", "unexpected_field": "sk-secret-value-pasted-here"},
        )
        assert response.status_code == 400
        assert "sk-secret-value-pasted-here" not in response.text


@pytest.mark.parametrize(
    ("failure", "expected_status", "expected_code"),
    [
        (ProviderUnavailable("upstream is down"), 502, "provider_unavailable"),
        (ProviderTimeout("upstream is slow"), 504, "provider_timeout"),
        (ProviderRateLimited("slow down"), 429, "provider_rate_limited"),
    ],
)
async def test_each_upstream_condition_maps_to_its_own_status(
    token_factory: TokenFactory,
    migrated_database: str,
    clean_database: None,
    failure: Exception,
    expected_status: int,
    expected_code: str,
) -> None:
    """Distinguishable, because they call for different responses from a client."""
    async with harness(
        factory=token_factory,
        database_url=migrated_database,
        provider=stub_provider(failure=failure),
    ) as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code


async def test_an_unauthenticated_request_is_401_and_a_forbidden_one_is_404(
    api_factory: ApiFactory,
) -> None:
    """404 rather than 403 for someone else's record — see the evidence endpoint's docstring."""
    async with api_factory() as api:
        unauthenticated = await api.client.get(f"{PREFIX}/me")
        assert unauthenticated.status_code == 401

        foreign = await api.client.get(
            f"{PREFIX}/evidence/{uuid.uuid4()}", headers=api.authorize(subject=USER_A)
        )
        assert foreign.status_code == 404
        assert foreign.json()["error"]["code"] == "evidence_not_found"


async def test_an_expired_token_is_refused_with_its_own_code(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/me", headers=api.bearer(api.factory.expired(subject=USER_A))
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_expired"


async def test_no_error_body_carries_token_material(api_factory: ApiFactory) -> None:
    """Checked against the actual token, not against a pattern."""
    async with api_factory() as api:
        token = api.factory.expired(subject=USER_A)
        response = await api.client.get(f"{PREFIX}/me", headers=api.bearer(token))

        assert response.status_code == 401
        assert token not in response.text
        assert token.split(".")[1] not in response.text, "not even the payload segment"


async def test_an_unrouted_path_is_the_same_envelope(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/nothing-here")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "route_not_found"


# =========================================================================== 15.3 middleware


async def test_the_response_carries_a_request_id(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/health")
        assert response.headers[REQUEST_ID_HEADER].startswith("req_")


async def test_a_client_supplied_request_id_is_used(api_factory: ApiFactory) -> None:
    """So a person's network tab and Weathra's logs share an identifier."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/health", headers={REQUEST_ID_HEADER: "frontend-abc-123"}
        )
        assert response.headers[REQUEST_ID_HEADER] == "frontend-abc-123"


async def test_a_hostile_client_supplied_id_is_sanitized(api_factory: ApiFactory) -> None:
    """A newline in a log line is a forged log record, not a formatting problem."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/health",
            headers={REQUEST_ID_HEADER: "abc\r\nINFO evil: injected"},
        )
        returned = response.headers[REQUEST_ID_HEADER]
        assert "\n" not in returned
        assert "\r" not in returned
        assert " " not in returned


async def test_the_same_id_appears_in_the_error_body_and_the_header(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast",
            params={"location": "Atlantis"},
            headers={REQUEST_ID_HEADER: "correlate-me"},
        )
        assert response.headers[REQUEST_ID_HEADER] == "correlate-me"
        assert response.json()["error"]["request_id"] == "correlate-me"


async def test_the_access_log_records_the_request_without_credentials(
    api_factory: ApiFactory, caplog: pytest.LogCaptureFixture
) -> None:
    """Endpoint, outcome, duration, provider, cache, acting user — and no token."""
    async with api_factory() as api:
        token = api.factory.valid(subject=USER_A)
        with capturing(caplog, logger_name="weathra.api.access"):
            await api.client.get(
                f"{PREFIX}/weather/forecast",
                params={"location": "Berlin", "days": 3},
                headers=api.bearer(token),
            )

        records = [record for record in caplog.records if record.name == "weathra.api.access"]
        assert records, "one access line per request"
        record = records[-1]

        assert record.endpoint.endswith("/weather/forecast")  # type: ignore[attr-defined]
        assert record.outcome == "ok"  # type: ignore[attr-defined]
        assert record.duration_ms >= 0.0  # type: ignore[attr-defined]
        assert record.user_id == USER_A, "the subject, so 'which user' is answerable"  # type: ignore[attr-defined]
        assert record.weather_provider == "stub"  # type: ignore[attr-defined]
        assert record.cache in {"hit", "miss"}  # type: ignore[attr-defined]

        for line in (record.getMessage(), json.dumps(record.__dict__, default=str)):
            assert token not in line, "no token in any log record"
            assert "@example.test" not in line, "and no email either — the subject is enough"


async def test_a_failed_request_still_produces_an_access_line(
    api_factory: ApiFactory, caplog: pytest.LogCaptureFixture
) -> None:
    async with api_factory() as api:
        with capturing(caplog, logger_name="weathra.api.access"):
            await api.client.get(f"{PREFIX}/weather/forecast", params={"location": "Atlantis"})

        record = [r for r in caplog.records if r.name == "weathra.api.access"][-1]
        assert record.outcome == "error"  # type: ignore[attr-defined]
        assert record.status_code == 404  # type: ignore[attr-defined]


async def test_a_log_record_from_deep_in_the_stack_carries_the_request_id(
    api_factory: ApiFactory, caplog: pytest.LogCaptureFixture
) -> None:
    """The contextvar's purpose: no parameter threaded through every call."""
    async with api_factory() as api:
        handler_filter = RequestIdFilter()
        caplog.handler.addFilter(handler_filter)
        try:
            with capturing(caplog):
                await api.client.get(
                    f"{PREFIX}/weather/forecast",
                    params={"location": "Atlantis"},
                    headers={REQUEST_ID_HEADER: "deep-correlation"},
                )
        finally:
            caplog.handler.removeFilter(handler_filter)

        tagged = [
            record
            for record in caplog.records
            if getattr(record, "request_id", None) == "deep-correlation"
        ]
        assert tagged, "at least one record carried the id without being handed it"


# =========================================================================== 15.5 locations


async def test_location_search_returns_ranked_candidates(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/locations/search", params={"query": "lisb", "limit": 5}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["count"] >= 1
        assert body["results"][0]["display_name"] == "Lisbon"


async def test_a_search_with_no_matches_is_a_successful_empty_answer(
    api_factory: ApiFactory,
) -> None:
    """A search box showing "no results" is not an error condition."""
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/locations/search", params={"query": "zzzzz"})
        assert response.status_code == 200
        assert response.json()["count"] == 0
        assert "does not substitute" in response.json()["note"]


async def test_a_unique_resolution_returns_one_location(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/locations/resolve", params={"query": "Berlin"})
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "resolved"
        assert body["location"]["display_name"] == "Berlin"
        assert body["location"]["timezone"] == "Europe/Berlin"


async def test_an_ambiguous_resolution_is_a_success_distinguishable_from_a_single_one(
    token_factory: TokenFactory, migrated_database: str, clean_database: None
) -> None:
    springfields = (
        BERLIN.model_copy(update={"display_name": "Springfield", "region": "Illinois"}),
        MUNICH.model_copy(update={"display_name": "Springfield", "region": "Missouri"}),
    )
    async with harness(
        factory=token_factory,
        database_url=migrated_database,
        geocoder=StubGeocoder(ambiguous=springfields),
    ) as api:
        response = await api.client.get(
            f"{PREFIX}/locations/resolve", params={"query": "Springfield"}
        )

    assert response.status_code == 200, "an ambiguous name is not a failure"
    body = response.json()
    assert body["kind"] == "ambiguous", "and a client branches on a field, not on a shape"
    assert len(body["candidates"]) == 2
    assert {candidate["region"] for candidate in body["candidates"]} == {"Illinois", "Missouri"}
    assert "does not pick one for you" in body["message"]


async def test_an_unresolvable_name_is_a_not_found_error(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/locations/resolve", params={"query": "Atlantis"})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "location_not_found"


async def test_resolution_by_coordinates(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/locations/resolve", params={"latitude": 52.52, "longitude": 13.41}
        )
        assert response.status_code == 200
        assert response.json()["location"]["display_name"] == "Berlin"


async def test_supplying_both_a_name_and_coordinates_is_refused(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/locations/resolve",
            params={"query": "Berlin", "latitude": 52.52, "longitude": 13.41},
        )
        assert response.status_code == 400
        assert "not both" in response.json()["error"]["message"]


# =========================================================================== 15.6 weather


async def test_current_conditions_carry_their_full_attribution(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/weather/current", params={"location": "Berlin"})
        assert response.status_code == 200

        attribution = response.json()["attribution"]
        assert attribution["location"]["display_name"] == "Berlin"
        assert attribution["provider"] == "stub"
        assert attribution["units"] == "metric"
        assert attribution["retrieved_at"]
        assert attribution["from_cache"] is False
        assert attribution["data_class"] == "current", "labelled current, never forecast"


async def test_a_forecast_by_coordinates(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast",
            params={"latitude": 52.52, "longitude": 13.41, "days": 3},
        )
        assert response.status_code == 200
        assert response.json()["horizon_days"] == 3


async def test_a_forecast_carries_uncertainty(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )
        uncertainty = response.json()["uncertainty"]
        assert uncertainty["horizon"], "a confidence band per horizon point"
        assert uncertainty["basis"], "and the basis it was derived from"
        assert "not a multi-provider consensus" in uncertainty["basis"]


async def test_an_unknown_provider_lists_the_registered_ones(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "provider": "hand-waving"}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "provider_not_found"
        assert "open-meteo" in response.json()["error"]["message"]


async def test_a_zero_day_horizon_is_rejected_with_no_upstream_call(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        before = api.provider.forecast_calls
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 0}
        )
        assert response.status_code == 400
        assert api.provider.forecast_calls == before, "refused before the provider was called"


async def test_an_over_long_horizon_is_refused_with_the_maximum_stated(
    api_factory: ApiFactory,
) -> None:
    """Refused, never truncated: 16 days returned for a 20-day request answers a different question."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 30}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsupported_horizon"
        # The stub declares a 10-day maximum, and the message states *its* limit rather than a
        # number written into the endpoint — which is the point of refusing here rather than in a
        # query annotation.
        maximum = api.provider.capabilities().maximum_forecast_days
        assert str(maximum) in response.json()["error"]["message"]
        assert "30" in response.json()["error"]["message"], "and what was asked for"


async def test_an_authenticated_callers_unit_preference_is_applied_and_disclosed(
    api_factory: ApiFactory,
) -> None:
    """The one thing a public endpoint reads about a user (``specs/authentication``)."""
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)

        updated = await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )
        assert updated.status_code == 200

        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}, headers=headers
        )
        attribution = response.json()["attribution"]
        assert attribution["units"] == "imperial"
        assert attribution["units_source"] == "preferences"


async def test_an_explicit_unit_request_beats_the_saved_preference(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )

        response = await api.client.get(
            f"{PREFIX}/weather/forecast",
            params={"location": "Berlin", "days": 3, "units": "metric"},
            headers=headers,
        )
        assert response.json()["attribution"]["units"] == "metric"
        assert response.json()["attribution"]["units_source"] == "request"


async def test_an_anonymous_caller_gets_the_documented_defaults(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )
        assert response.json()["attribution"]["units"] == "metric"
        assert response.json()["attribution"]["units_source"] == "default"


# =========================================================================== 15.7 history


async def test_history_is_labelled_as_observations(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history",
            params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["data_class"] == "historical_observation"
        assert body["daily"]["entries"]
        assert body["covered_period"]


async def test_a_period_comparison_compares_two_past_windows(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history/comparison",
            params={
                "location": "Berlin",
                "earlier_start": "2025-05-01",
                "earlier_end": "2025-05-07",
                "later_start": "2025-06-01",
                "later_end": "2025-06-07",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["data_class"] == "historical_observation", "not a forecast-accuracy score"
        assert body["earlier"], "the earlier period's statistics"
        assert body["later"], "the later period's"
        assert body["deltas"], "and the difference between them"
        assert body["statistics_applied"], "computed on a shared basis"
        assert body["lengths_differ"] is False, "same-length windows, so nothing to warn about"


async def test_a_baseline_reports_the_years_it_used(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history/baseline",
            params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07", "years": 5},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["years_requested"] == 5
        assert body["years_used"], "which years went in, not just the count"


async def test_a_period_is_placed_against_the_baseline_of_the_years_before_it(
    api_factory: ApiFactory,
) -> None:
    """Task 21.3's HTTP surface for `specs/historical-weather`'s comparison-against-baseline."""
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history/baseline/comparison",
            params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07", "years": 3},
        )
        assert response.status_code == 200, response.text[:300]
        body = response.json()

        # The baseline travels with the comparison, years included, so the reader can check it.
        assert body["baseline"]["years_used"], "which years went in"
        assert body["baseline"]["years_requested"] == 3
        assert "not an official climate normal" in body["baseline"]["labelling"]

        # Every figure is computed by the analytics layer and states its method.
        assert body["difference"]["method"]
        assert body["z_score"]["method"]
        assert body["characterization"]

        # Both sides are observations, so nothing here is a forecast-accuracy score.
        assert body["observed_data_class"] == "historical_observation"
        assert body["forecast_side_caveat"] is None

        # The baseline is built from the years *before* the period, never including it.
        assert 2025 not in body["baseline"]["years_used"]


async def test_a_baseline_comparison_outside_coverage_is_refused_rather_than_estimated(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history/baseline/comparison",
            params={"location": "Berlin", "start": "1600-01-01", "end": "1600-01-07"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "range_outside_coverage"
        assert "baseline" not in response.text, "no half-built comparison escapes"


async def test_a_range_before_the_archive_is_rejected(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history",
            params={"location": "Berlin", "start": "1600-01-01", "end": "1600-01-07"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "range_outside_coverage"


# =========================================================================== 15.8 analysis


async def test_analysis_reports_method_and_point_count_per_figure(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
        )
        assert response.status_code == 200

        findings = response.json()["findings"]
        assert findings
        for finding in findings:
            assert finding["method"], f"{finding['statistic']} states no method"
            assert finding["points_used"] is not None
            assert finding["points_excluded"] is not None


async def test_analysis_with_thresholds(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/analysis",
            params={"location": "Berlin", "days": 7, "above": "temperature_max:12"},
        )
        assert response.status_code == 200

        thresholds = response.json()["thresholds"]
        assert len(thresholds) == 1
        report = thresholds[0]
        assert report["statement"], "the plain sentence a reader sees"
        assert report["method"]
        assert report["points_used"] > 0
        assert report["points_excluded"] == 0, "a missing day is excluded and counted, not ignored"
        assert report["crossed"] == bool(report["crossings"])


async def test_a_malformed_threshold_is_refused_with_what_went_wrong(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/analysis",
            params={"location": "Berlin", "above": "not-a-measure:25"},
        )
        assert response.status_code == 400
        assert "not a measure Weathra knows" in response.json()["error"]["message"]


async def test_a_non_computable_statistic_is_reported_unavailable_while_others_return(
    token_factory: TokenFactory, migrated_database: str, clean_database: None
) -> None:
    """An absent measure is a real answer with a reason, not a zero and not a failed request."""

    async with harness(
        factory=token_factory,
        database_url=migrated_database,
        # A provider that reports temperature but no precipitation: the precipitation statistics
        # then have nothing to compute over and must say so rather than reporting zero rainfall.
        provider=stub_provider(
            capabilities=stub_capabilities(
                measures={
                    Granularity.HOURLY: (Measure.TEMPERATURE,),
                    Granularity.DAILY: (Measure.TEMPERATURE_MAX,),
                }
            )
        ),
    ) as api:
        response = await api.client.get(
            f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
        )

    assert response.status_code == 200
    findings = response.json()["findings"]
    computed = [finding for finding in findings if finding["status"] == "computed"]
    unavailable = [finding for finding in findings if finding["status"] != "computed"]

    assert computed, "the statistics that could be computed still were"
    for finding in unavailable:
        assert finding["reason"], "and the ones that could not say why"
        assert finding["value"] is None, "never a zero standing in for a missing measure"


# =========================================================================== 15.9 comparison


async def test_a_three_location_comparison(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={"criterion": "warmest", "locations": ["Berlin", "Munich", "Lisbon"], "days": 3},
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["candidates"]) == 3
        assert body["criterion"] == "warmest"
        assert body["mode"] == "locations"
        assert [candidate["rank"] for candidate in body["candidates"]] == sorted(
            candidate["rank"] for candidate in body["candidates"]
        )
        assert body["candidates"][0]["label"], "the winner is named"
        assert body["candidates"][0]["supporting"], "and carries the statistics behind its score"


async def test_a_historical_comparison(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={
                "criterion": "wettest",
                "locations": ["Berlin", "Munich"],
                "start": "2025-06-01",
                "end": "2025-06-07",
            },
        )
        assert response.status_code == 200
        assert response.json()["data_class"] == "historical_observation"


async def test_a_day_level_comparison(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={"criterion": "driest", "location": "Berlin", "days": 5},
        )
        assert response.status_code == 200
        assert response.json()["mode"] == "days"
        assert len(response.json()["candidates"]) >= 1


async def test_a_single_location_comparison_is_refused(api_factory: ApiFactory) -> None:
    """Comparing one thing against nothing is a request that does not mean anything."""
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison", json={"criterion": "warmest", "locations": ["Berlin"]}
        )
        assert response.status_code == 400
        assert "not a comparison" in response.json()["error"]["message"]


async def test_a_historical_comparison_needs_both_dates(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={"criterion": "warmest", "locations": ["Berlin", "Munich"], "start": "2025-06-01"},
        )
        assert response.status_code == 400
        assert "both `start` and `end`" in response.json()["error"]["message"]


# =========================================================================== 15.11 /me


async def test_the_first_call_creates_the_profile(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/me", headers=api.authorize(subject=USER_A))
        assert response.status_code == 200

        body = response.json()
        assert body["user_id"] == USER_A
        assert body["created_now"] is True
        assert body["email"], "echoed from the token, not read from a table"
        assert body["preferences"]["unit_system"] == "metric"
        assert body["preferences"]["sources"]["unit_system"] == "default"


async def test_a_subsequent_call_does_not_recreate_it(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        first = await api.client.get(f"{PREFIX}/me", headers=headers)
        second = await api.client.get(f"{PREFIX}/me", headers=headers)

        assert first.json()["created_now"] is True
        assert second.json()["created_now"] is False
        assert second.json()["profile_created_at"] == first.json()["profile_created_at"]


async def test_the_current_user_response_carries_no_credential_material(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        token = api.factory.valid(subject=USER_A)
        response = await api.client.get(f"{PREFIX}/me", headers=api.bearer(token))

        assert token not in response.text
        for forbidden in ("access_token", "refresh_token", "password", "secret", "api_key"):
            assert forbidden not in response.text.lower()


# =========================================================================== 15.12 preferences


async def test_preferences_are_read_and_updated(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)

        initial = await api.client.get(f"{PREFIX}/me/preferences", headers=headers)
        assert initial.json()["sources"]["unit_system"] == "default"

        updated = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"unit_system": "imperial", "forecast_horizon_days": 10},
            headers=headers,
        )
        assert updated.status_code == 200
        assert updated.json()["unit_system"] == "imperial"
        assert updated.json()["sources"]["unit_system"] == "chosen"
        assert updated.json()["forecast_horizon_days"] == 10


async def test_a_default_location_preference_is_stored_canonically(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        response = await api.client.put(
            f"{PREFIX}/me/preferences", json={"default_location": "Berlin"}, headers=headers
        )
        assert response.status_code == 200
        stored = response.json()["default_location"]
        assert stored["display_name"] == "Berlin"
        assert stored["timezone"] == "Europe/Berlin", "the resolved place, not the query text"


async def test_a_default_location_can_be_named_by_coordinates(api_factory: ApiFactory) -> None:
    """A caller holding a resolved place addresses it by where it is, not by what it is called.

    The stored value is still the canonical location — resolution is what gives it its timezone and
    its identifier — but nothing is asked of the *name* geocoder, so nothing depends on a name
    existing or on a ranking staying put.
    """
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        response = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"latitude": 52.52, "longitude": 13.405},
            headers=headers,
        )
        assert response.status_code == 200
        stored = response.json()["default_location"]
        # Resolution still happens — that is where the timezone comes from, and it is what makes
        # the stored value canonical rather than whatever the caller typed. What does not happen is
        # a *name* lookup.
        assert stored["timezone"] == "Europe/Berlin"
        assert stored["display_name"] == "Berlin", "coordinates resolved to the canonical place"
        assert api.geocoder.resolve_calls == [], "a name lookup was made for a place already known"


async def test_a_place_with_only_a_coordinate_label_can_become_the_default(
    api_factory: ApiFactory,
) -> None:
    """The production bug, in one test.

    A place resolved from coordinates that reverse geocoding cannot name is called
    ``"48.14, 11.58"`` — the geocoder's own coordinate label, which is a perfectly good *display*
    name and no kind of place name. Settings then offered it as the default and sent it back as
    text, and the geocoder was asked for a city called "48.14, 11.58". It answered, correctly, that
    no location matches it: a location Weathra had already resolved, stored, and put on screen was
    one whose preference could not be saved.

    Both halves are asserted. The name path still refuses that string, because it should — it is
    not a place name and pretending otherwise would mean guessing. Sending the coordinates stores
    the same place, identified identically, with no name involved.
    """
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)

        # Coordinates no gazetteer names — which in production is *every* coordinate: Open-Meteo
        # has no reverse geocoding, so `resolve_coordinates` always labels a place with its
        # coordinates. Every location saved by coordinates therefore had this bug, not a few of them.
        unnamed = {"latitude": 12.3456, "longitude": -45.6789}
        saved = await api.client.post(f"{PREFIX}/me/locations", json=unnamed, headers=headers)
        assert saved.status_code in (200, 201)
        place = saved.json()["location"]
        assert place["display_name"] == "12.35, -45.68", "the geocoder's coordinate label"

        refused = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"default_location": place["display_name"]},
            headers=headers,
        )
        assert refused.status_code == 404
        assert refused.json()["error"]["code"] == "location_not_found"

        accepted = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"latitude": place["latitude"], "longitude": place["longitude"]},
            headers=headers,
        )
        assert accepted.status_code == 200
        stored = accepted.json()["default_location"]
        assert (stored["latitude"], stored["longitude"]) == (
            place["latitude"],
            place["longitude"],
        ), "a different place was stored"
        assert accepted.json()["sources"]["default_location"] == "chosen"

        # And it is still there on the next read, which is what the Dashboard asks for: the
        # contradiction of a saved location beside "No default location saved" was this save
        # failing, not the Dashboard reading the wrong thing.
        reread = await api.client.get(f"{PREFIX}/me/preferences", headers=headers)
        assert reread.json()["default_location"]["display_name"] == place["display_name"]


async def test_a_default_location_refuses_a_name_and_a_pair_that_disagree(
    api_factory: ApiFactory,
) -> None:
    """A name and a coordinate pair naming *different* places is a question, not an instruction.

    Berlin is not at 48.14, 11.58, and storing either of the two would record one place while the
    caller believed the other. What changed in task 34.10 is only that agreement is now possible: a
    pair that matches one of the name's own candidates has chosen between them, which is what lets a
    stored default carry a canonical name instead of a coordinate string. Disagreement is still
    refused, and this is the case that says so.
    """
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        response = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={"default_location": "Berlin", "latitude": 48.14, "longitude": 11.58},
            headers=headers,
        )
        assert response.status_code == 400
        assert "not two different places" in response.json()["error"]["message"]


async def test_a_default_location_accepts_a_name_and_the_pair_it_resolved_to(
    api_factory: ApiFactory,
) -> None:
    """The pair chooses among the name's candidates, and the stored default keeps the name.

    Coordinates alone could only ever store the point, and the backend names a point after itself —
    which is how a stored default came to read "48.1374, 11.5755" where `specs/memory` wants the
    canonical name. Task 34.10.
    """
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        response = await api.client.put(
            f"{PREFIX}/me/preferences",
            json={
                "default_location": "Berlin",
                "latitude": BERLIN.latitude,
                "longitude": BERLIN.longitude,
            },
            headers=headers,
        )

    assert response.status_code == 200
    stored = response.json()["default_location"]
    assert stored["display_name"] == BERLIN.display_name
    assert stored["display_name"] != f"{BERLIN.latitude:.4f}, {BERLIN.longitude:.4f}"


async def test_a_default_location_refuses_half_a_coordinate_pair(api_factory: ApiFactory) -> None:
    """One coordinate is not a place, and must not be read as "leave it alone" either."""
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        response = await api.client.put(
            f"{PREFIX}/me/preferences", json={"latitude": 48.14}, headers=headers
        )
        assert response.status_code == 400
        assert "both latitude and longitude" in response.json()["error"]["message"]


async def test_clearing_a_preference_restores_the_default(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )

        cleared = await api.client.put(
            f"{PREFIX}/me/preferences", json={"clear_unit_system": True}, headers=headers
        )
        assert cleared.json()["unit_system"] == "metric"
        assert cleared.json()["sources"]["unit_system"] == "default"


async def test_deleting_preferences_returns_the_defaults_that_now_apply(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )

        deleted = await api.client.delete(f"{PREFIX}/me/preferences", headers=headers)
        assert deleted.status_code == 200
        assert deleted.json()["unit_system"] == "metric"
        assert not any(source == "chosen" for source in deleted.json()["sources"].values())


async def test_saved_locations_are_added_listed_and_removed(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)

        created = await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin", "label": "Home"}, headers=headers
        )
        assert created.status_code == 201
        assert created.json()["label"] == "Home"
        assert created.json()["location"]["display_name"] == "Berlin"
        saved_id = created.json()["id"]

        listed = await api.client.get(f"{PREFIX}/me/locations", headers=headers)
        assert listed.json()["count"] == 1
        assert listed.json()["limit"] == api.settings.saved_locations_limit

        removed = await api.client.delete(f"{PREFIX}/me/locations/{saved_id}", headers=headers)
        assert removed.status_code == 204

        after = await api.client.get(f"{PREFIX}/me/locations", headers=headers)
        assert after.json()["count"] == 0


async def test_saving_the_same_place_twice_does_not_duplicate_it(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        first = await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin", "label": "Home"}, headers=headers
        )
        second = await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin", "label": "Flat"}, headers=headers
        )

        assert first.json()["id"] == second.json()["id"]
        listed = await api.client.get(f"{PREFIX}/me/locations", headers=headers)
        assert listed.json()["count"] == 1
        assert listed.json()["locations"][0]["label"] == "Flat"


async def test_two_users_preferences_and_locations_are_isolated(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        first = api.authorize(subject=USER_A)
        second = api.authorize(subject=USER_B)

        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=first
        )
        await api.client.post(f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=first)

        theirs = await api.client.get(f"{PREFIX}/me/preferences", headers=second)
        assert theirs.json()["unit_system"] == "metric"
        assert theirs.json()["sources"]["unit_system"] == "default"

        their_locations = await api.client.get(f"{PREFIX}/me/locations", headers=second)
        assert their_locations.json()["count"] == 0


async def test_a_cross_user_mutation_is_refused_without_disclosure(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        owner = api.authorize(subject=USER_A)
        intruder = api.authorize(subject=USER_B)

        created = await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=owner
        )
        saved_id = created.json()["id"]

        refused = await api.client.delete(f"{PREFIX}/me/locations/{saved_id}", headers=intruder)
        absent = await api.client.delete(f"{PREFIX}/me/locations/{uuid.uuid4()}", headers=intruder)

        assert refused.status_code == 404
        assert refused.json()["error"]["code"] == absent.json()["error"]["code"]
        assert refused.json()["error"]["message"] == absent.json()["error"]["message"]

        still_there = await api.client.get(f"{PREFIX}/me/locations", headers=owner)
        assert still_there.json()["count"] == 1


async def test_an_identity_asserting_header_does_not_override_the_token(
    api_factory: ApiFactory,
) -> None:
    """``specs/memory``: a supplied identifier is ignored, and the token's subject is the scope."""
    async with api_factory() as api:
        from weathra.auth.deps import IDENTITY_ASSERTING_HEADERS

        headers = {**api.authorize(subject=USER_A)}
        for header in IDENTITY_ASSERTING_HEADERS:
            headers[header] = USER_B

        response = await api.client.get(f"{PREFIX}/me", headers=headers)
        assert response.status_code == 200
        assert response.json()["user_id"] == USER_A, "the token's subject, not the header's"


# =========================================================================== 15.15 health


async def test_health_reports_alive_and_depends_on_nothing(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["version"]


async def test_readiness_names_every_dependency(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/ready")
        assert response.status_code == 200

        reported = {entry["name"] for entry in response.json()["dependencies"]}
        assert reported == {
            "weather_provider",
            "database",
            "vector_store",
            "mcp_server",
            "authentication_provider",
            "inference_provider",
            "conversation_memory",
        }


async def test_readiness_is_healthy_when_only_inference_is_unconfigured(
    api_factory: ApiFactory,
) -> None:
    """``specs/agent-orchestration``: every non-agent capability works without a credential."""
    async with api_factory() as api:
        response = await api.client.get(f"{PREFIX}/ready")
        body = response.json()

        assert body["ready"] is True
        inference = next(
            entry for entry in body["dependencies"] if entry["name"] == "inference_provider"
        )
        assert inference["configured"] is False
        assert inference["required"] is False
        assert "OPENROUTER_API_KEY" in inference["detail"]


async def test_neither_health_endpoint_discloses_key_material(api_factory: ApiFactory) -> None:
    """Naming a *variable* is required; disclosing its value is forbidden.

    ``/ready`` says "set OPENROUTER_API_KEY", which is what ``specs/agent-orchestration`` asks for
    — so the assertion is about credential *values*, not about the substring "api_key". A check
    that banned the variable name would have to be turned off the first time the endpoint did its
    job.
    """
    async with api_factory(openrouter_api_key="sk-test-secret-value") as api:
        for path in (f"{PREFIX}/health", f"{PREFIX}/ready"):
            body = (await api.client.get(path)).text

            assert "sk-test-secret-value" not in body, f"{path} disclosed the credential"
            for forbidden in ("eyJ", "service_role", "-----BEGIN"):
                assert forbidden not in body, f"{path} disclosed {forbidden}"

            # Not the credential's shape either: no prefix a reader could use to recognise it.
            assert "sk-" not in body


# =========================================================================== 15.10 /ask


async def test_the_agent_endpoint_returns_the_envelope_and_its_evidence(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )

        response = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert response.status_code == 200, response.text[:400]

        body = response.json()
        answer = body["answer"]
        assert answer["answer_prose"] == "Berlin looks mild."
        assert answer["prose_data_class"] == "ai_interpretation"
        assert answer["findings"]
        assert answer["evidence"]["tool_calls"]
        assert answer["evidence"]["agents"]
        assert answer["llm_provider"] == "fake"
        assert answer["llm_model"] == "weathra-fake-1"
        assert answer["grounding"]["method"]
        assert body["evidence_id"], "the record was stored"


async def test_a_follow_up_in_an_owned_thread_states_what_it_resolved_to(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=USER_A)

        api.script(
            json_responses=[
                _plan(
                    PlanStep(
                        capability=Capability.FORECAST,
                        reason="both places",
                        locations=("Berlin", "Munich"),
                        days=3,
                    )
                )
            ],
            completions=["Berlin and Munich are similar."],
        )
        first = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Compare Berlin and Munich", "create_thread": True},
            headers=headers,
        )
        assert first.status_code == 200, first.text[:400]
        thread_id = first.json()["thread_id"]
        assert thread_id

        api.script(
            json_responses=[
                _plan(PlanStep(capability=Capability.FORECAST, reason="follow-up", days=1))
            ],
            completions=["Munich is warmer."],
        )
        follow_up = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Which one is warmer tomorrow?", "thread_id": thread_id},
            headers=headers,
        )
        assert follow_up.status_code == 200, follow_up.text[:400]

        resolved = follow_up.json()["answer"]["resolved"]
        assert resolved["location_source"] == "thread"
        assert {place["display_name"] for place in resolved["locations"]} == {"Berlin", "Munich"}
        assert "previous question" in resolved["statement"]


async def test_a_foreign_thread_is_refused_without_disclosing_it_exists(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin"))
            ],
            completions=["Mild."],
        )
        owned = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?", "create_thread": True},
            headers=api.authorize(subject=USER_A),
        )
        thread_id = owned.json()["thread_id"]

        intruder = api.authorize(subject=USER_B)
        refused = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Which one is warmer?", "thread_id": thread_id},
            headers=intruder,
        )
        absent = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Which one is warmer?", "thread_id": str(uuid.uuid4())},
            headers=intruder,
        )

        assert refused.status_code == 404
        assert refused.json()["error"]["code"] == absent.json()["error"]["code"]
        assert refused.json()["error"]["message"] == absent.json()["error"]["message"]
        assert thread_id not in refused.text


async def test_an_unauthenticated_ask_is_401(api_factory: ApiFactory) -> None:
    async with with_inference(api_factory) as api:
        response = await api.client.post(f"{PREFIX}/agent/ask", json={"question": "Berlin?"})
        assert response.status_code == 401


async def test_with_no_credential_ask_is_503_and_a_public_endpoint_still_succeeds(
    api_factory: ApiFactory,
) -> None:
    """The requirement in one test: the agent surface reports itself, everything else works."""
    async with api_factory() as api:
        refused = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert refused.status_code == 503
        assert refused.json()["error"]["code"] == "agent_not_configured"
        # The message is for the person on the weather screen; the diagnosis is in `details` and in
        # the log. It named the environment variable until 2026-09-08, when a signed-in visitor was
        # shown an instruction they could not act on about a variable they should not have to know
        # exists. What the surface owes them is that the rest of Weathra is unaffected.
        message = refused.json()["error"]["message"]
        assert "OPENROUTER_API_KEY" not in message
        assert not CONFIGURATION_SHAPED.search(message), message
        assert "unaffected" in message
        assert refused.json()["error"]["details"]["missing"] == "inference_credential"

        public = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )
        assert public.status_code == 200


# =========================================================================== 15.13 evidence


async def test_an_evidence_record_is_retrievable(api_factory: ApiFactory) -> None:
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=USER_A)

        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )
        asked = await api.client.post(
            f"{PREFIX}/agent/ask", json={"question": "Berlin?"}, headers=headers
        )
        evidence_id = asked.json()["evidence_id"]

        response = await api.client.get(f"{PREFIX}/evidence/{evidence_id}", headers=headers)
        assert response.status_code == 200

        body = response.json()
        assert body["question"] == "Berlin?"
        assert body["evidence"]["tool_calls"]
        assert body["llm_provider"] == "fake"


async def test_an_unknown_and_a_foreign_evidence_id_answer_identically(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )
        asked = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        evidence_id = asked.json()["evidence_id"]

        intruder = api.authorize(subject=USER_B)
        foreign = await api.client.get(f"{PREFIX}/evidence/{evidence_id}", headers=intruder)
        unknown = await api.client.get(f"{PREFIX}/evidence/{uuid.uuid4()}", headers=intruder)

        assert foreign.status_code == unknown.status_code == 404
        assert foreign.json()["error"]["code"] == unknown.json()["error"]["code"]
        assert foreign.json()["error"]["message"] == unknown.json()["error"]["message"]


# =========================================================================== 15.14 deletion


async def test_account_deletion_removes_the_callers_data_and_confirms_it(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=USER_A)

        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )
        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
        )
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )
        await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?", "create_thread": True},
            headers=headers,
        )

        deleted = await api.client.delete(f"{PREFIX}/me/data", headers=headers)
        assert deleted.status_code == 200

        body = deleted.json()
        assert body["removed"]["saved_locations"] == 1
        assert body["removed"]["preferences"] == 1
        assert body["removed"]["threads"] == 1
        assert body["removed"]["agent_runs"] == 1
        assert body["total"] >= 4
        assert "Supabase Auth" in body["note"], "the note says what deletion does not cover"

        assert (await api.client.get(f"{PREFIX}/me/locations", headers=headers)).json()[
            "count"
        ] == 0


async def test_one_users_deletion_leaves_anothers_records_standing(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        first = api.authorize(subject=USER_A)
        second = api.authorize(subject=USER_B)

        for headers in (first, second):
            await api.client.put(
                f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
            )
            await api.client.post(
                f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
            )

        await api.client.delete(f"{PREFIX}/me/data", headers=first)

        theirs = await api.client.get(f"{PREFIX}/me/locations", headers=second)
        assert theirs.json()["count"] == 1
        preferences = await api.client.get(f"{PREFIX}/me/preferences", headers=second)
        assert preferences.json()["unit_system"] == "imperial"


async def test_shared_data_survives_an_account_deletion(api_factory: ApiFactory) -> None:
    """The corpus and the location-keyed snapshots are nobody's personal data."""
    async with api_factory() as api:
        from sqlalchemy import text

        from weathra.db.session import privileged_session

        headers = api.authorize(subject=USER_A)
        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            await session.execute(
                text(
                    "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                    "VALUES ('doc-1', 'Dew point', 'concepts', 'authored', 'hash')"
                )
            )

        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
        )
        await api.client.delete(f"{PREFIX}/me/data", headers=headers)

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            documents = await session.scalar(text("SELECT count(*) FROM knowledge_documents"))
        assert documents == 1


# =========================================================================== 16 streaming


def _events(payload: str) -> list[tuple[str, dict]]:
    """Parse an SSE body into (event name, data) pairs."""
    parsed: list[tuple[str, dict]] = []
    for block in payload.strip().split("\n\n"):
        if not block.strip():
            continue
        name = ""
        data = "{}"
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        parsed.append((name, json.loads(data)))
    return parsed


async def test_the_stream_emits_typed_events_in_order_and_terminates(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )

        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "What is the forecast for Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        events = _events(response.text)
        names = [name for name, _ in events]

        assert names[0] == StreamEventType.ROUTING.value
        assert names[-1] == StreamEventType.FINAL.value, (
            "the stream ends with an explicit completion"
        )
        assert names.count(StreamEventType.FINAL.value) == 1
        assert StreamEventType.ERROR.value not in names
        assert StreamEventType.AGENT_START.value in names
        assert StreamEventType.TOOL_START.value in names
        assert StreamEventType.TOOL_END.value in names
        assert StreamEventType.ANSWER_DELTA.value in names

        # Every event carries correlation and ordering fields.
        sequences = [data["sequence"] for _, data in events]
        assert sequences == sorted(sequences)
        assert len(set(sequences)) == len(sequences), "monotonic and unique"
        assert all(data["request_id"] for _, data in events)
        assert len({data["request_id"] for _, data in events}) == 1


async def test_the_final_event_carries_the_answer_and_the_evidence_id(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )

        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        name, data = _events(response.text)[-1]

        assert name == StreamEventType.FINAL.value
        assert data["answer"]["answer_prose"] == "Berlin looks mild."
        assert data["answer"]["evidence"]["tool_calls"]
        assert data["evidence_id"]


async def test_an_unauthenticated_stream_is_401_with_no_run_started(
    api_factory: ApiFactory,
) -> None:
    """A 401 with the normal envelope, not a 200 whose first event says so."""
    async with with_inference(api_factory) as api:
        fake = api.script(
            json_responses=[
                _plan(PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin"))
            ],
            completions=["Mild."],
        )

        response = await api.client.post(f"{PREFIX}/agent/stream", json={"question": "Berlin?"})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "token_missing"
        assert fake.call_count == 0, "no run was begun"


async def test_an_authenticated_stream_applies_the_callers_preferences(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        headers = api.authorize(subject=USER_A)
        await api.client.put(
            f"{PREFIX}/me/preferences", json={"unit_system": "imperial"}, headers=headers
        )

        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )
        response = await api.client.post(
            f"{PREFIX}/agent/stream", json={"question": "Berlin?"}, headers=headers
        )

        _, final = _events(response.text)[-1]
        assert final["answer"]["resolved"]["unit_system"] == "imperial"
        assert final["answer"]["resolved"]["units_source"] == "preferences"


async def test_a_mid_run_failure_emits_a_terminal_error_and_closes(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        # A plan the graph accepts, then a synthesis call that fails: the run is under way when it goes.
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=[],
        )

        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert response.status_code == 200

        events = _events(response.text)
        names = [name for name, _ in events]
        assert names[-1] == StreamEventType.ERROR.value, "a terminal error, not a truncated stream"
        assert names.count(StreamEventType.FINAL.value) == 0
        assert events[-1][1]["code"]
        assert events[-1][1]["message"]


async def test_an_unconfigured_agent_stream_is_503_rather_than_a_stream(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "agent_not_configured"


async def test_the_stream_works_cross_origin_with_the_authorization_header(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )

        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Berlin?"},
            headers={
                **api.authorize(subject=USER_A),
                "Origin": "http://localhost:3000",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert _events(response.text)[-1][0] == StreamEventType.FINAL.value


async def test_the_stream_sets_headers_that_prevent_buffering(
    api_factory: ApiFactory,
) -> None:
    """An intermediary that buffered would hold every event until the run finished."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Mild."],
        )
        response = await api.client.post(
            f"{PREFIX}/agent/stream",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert "no-cache" in response.headers["cache-control"]
        assert "no-transform" in response.headers["cache-control"]
        assert response.headers["x-accel-buffering"] == "no"


async def test_the_agent_budget_sits_below_the_token_lifetime(api_factory: ApiFactory) -> None:
    """``specs/http-api``: a stream must not outlive the credential that authorized it.

    Asserted against the configured values rather than described in a comment, so a deployment that
    raised the budget past the token lifetime fails here.
    """
    async with api_factory() as api:
        settings = api.settings
        token_lifetime_seconds = 3_600.0  # Supabase's default access-token lifetime

        assert settings.agent_wall_clock_budget_seconds < token_lifetime_seconds, (
            "the agent budget must sit below the access-token lifetime"
        )
        assert settings.http_timeout_seconds < settings.agent_wall_clock_budget_seconds, (
            "one upstream call must not be able to consume the whole run's budget"
        )


async def test_every_public_capability_serves_with_no_credential_while_the_agent_refuses(
    api_factory: ApiFactory,
) -> None:
    """Task 13.5 at the endpoint level: the whole claim in one test.

    The harness has no inference credential. Every public capability answers, RAG retrieval works
    (embedding is local, search is a database query), and only the agent surface reports itself
    unavailable — naming the variable to set.
    """
    async with api_factory() as api:
        assert not api.settings.inference_configured

        forecast = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )
        history = await api.client.get(
            f"{PREFIX}/weather/history",
            params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07"},
        )
        analysis = await api.client.get(
            f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
        )
        comparison = await api.client.post(
            f"{PREFIX}/weather/comparison",
            json={"criterion": "warmest", "locations": ["Berlin", "Munich"], "days": 3},
        )
        locations = await api.client.get(f"{PREFIX}/locations/resolve", params={"query": "Berlin"})

        for name, response in (
            ("forecast", forecast),
            ("history", history),
            ("analysis", analysis),
            ("comparison", comparison),
            ("locations", locations),
        ):
            assert response.status_code == 200, f"{name} failed: {response.text[:200]}"

        # RAG retrieval, through the same session the API uses, with no credential in sight.
        from weathra.auth.rls import administrative_session, session_for
        from weathra.rag.ingest import load_corpus
        from weathra.rag.retrieve import retrieve
        from weathra.rag.store import ingest_corpus

        embedder = api.app.state.embedder
        async with administrative_session(api.app.state.engines) as admin:
            await ingest_corpus(
                admin, embedder=embedder, settings=api.settings, documents=load_corpus()
            )
        async with session_for(api.app.state.engines, None) as session:
            found = await retrieve(
                session, embedder=embedder, settings=api.settings, query="dew point"
            )
        assert found.found_any, "knowledge retrieval needs no inference credential"

        # And the agent surface, alone, refuses — naming what is missing.
        refused = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?"},
            headers=api.authorize(subject=USER_A),
        )
        assert refused.status_code == 503
        assert refused.json()["error"]["code"] == "agent_not_configured"
        # Named for whoever operates the service, in `details`; never for the person reading it.
        message = refused.json()["error"]["message"]
        assert not CONFIGURATION_SHAPED.search(message), message
        assert refused.json()["error"]["details"]["missing"] == "inference_credential"
        assert not api.app.state.inference.built, "no client was ever constructed"
