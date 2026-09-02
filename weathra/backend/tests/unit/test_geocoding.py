"""Group 6 — location resolution: by name, by region-qualified name, by coordinates, and by search.

Against recorded payloads from the live geocoding API, so the region-qualifier and ambiguity logic
is exercised against the shape and ranking Open-Meteo actually returns — including the ten
near-identical "Reykjavik" entries that make "count the results" the wrong ambiguity test.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx
import pytest

from tests.provider_support import fixture, json_transport, provider_settings
from weathra.domain.errors import LocationNotFound, ValidationFailed
from weathra.domain.location import Ambiguous, Location, Resolution, Resolved
from weathra.geocoding.base import DEFAULT_SEARCH_LIMIT, Geocoder
from weathra.geocoding.open_meteo import (
    GEOCODING_URL,
    OpenMeteoGeocoder,
    normalize_query,
    split_qualifier,
)


def geocoder(payload: Mapping[str, Any], **settings: object) -> OpenMeteoGeocoder:
    return OpenMeteoGeocoder(settings=provider_settings(**settings), client=json_transport(payload))


def routed(mapping: Mapping[str, Mapping[str, Any]]) -> OpenMeteoGeocoder:
    """A geocoder whose responses depend on which endpoint is called."""

    def handler(request: httpx.Request) -> httpx.Response:
        for fragment, payload in mapping.items():
            if fragment in str(request.url):
                return httpx.Response(200, json=payload)
        raise AssertionError(f"unexpected request to {request.url}")

    return OpenMeteoGeocoder(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


# =========================================================================== 6.1 the contract


def test_the_real_geocoder_satisfies_the_protocol() -> None:
    assert isinstance(geocoder(fixture("geocode_reykjavik")), Geocoder)


def test_a_stub_satisfies_the_protocol() -> None:
    class StubGeocoder:
        async def resolve(self, query: str) -> Resolution:
            raise NotImplementedError

        async def resolve_coordinates(self, latitude: float, longitude: float) -> Location:
            raise NotImplementedError

        async def search(
            self, query: str, *, limit: int = DEFAULT_SEARCH_LIMIT
        ) -> tuple[Location, ...]:
            raise NotImplementedError

    assert isinstance(StubGeocoder(), Geocoder)


# =========================================================================== 6.2 by name


async def test_a_unique_place_name_resolves_to_one_location() -> None:
    """Ten upstream results, one actual place — the identifier is what decides."""
    resolution = await geocoder(fixture("geocode_reykjavik")).resolve("Reykjavik")

    assert isinstance(resolution, Resolved)
    assert resolution.location.display_name == "Reykjavik"
    assert resolution.location.timezone == "Atlantic/Reykjavik"
    assert resolution.location.country_code == "IS"
    assert resolution.location.identifier


async def test_an_ambiguous_name_reports_its_candidates() -> None:
    resolution = await geocoder(fixture("geocode_springfield")).resolve("Springfield")

    assert isinstance(resolution, Ambiguous)
    assert len(resolution.candidates) >= 2
    regions = {candidate.region for candidate in resolution.candidates}
    assert {"Illinois", "Missouri"} <= regions
    for candidate in resolution.candidates:
        assert candidate.country is not None, "a candidate must be distinguishable"


async def test_an_ambiguous_result_is_not_a_single_location() -> None:
    resolution = await geocoder(fixture("geocode_springfield")).resolve("Springfield")
    assert not isinstance(resolution, Resolved)
    assert resolution.kind == "ambiguous"


async def test_a_region_qualifier_selects_the_right_place() -> None:
    resolution = await geocoder(fixture("geocode_springfield")).resolve("Springfield, Illinois")

    assert isinstance(resolution, Resolved)
    assert resolution.location.region == "Illinois"


async def test_a_country_code_qualifier_also_works() -> None:
    resolution = await geocoder(fixture("geocode_springfield")).resolve("Springfield, Illinois, US")
    assert isinstance(resolution, Resolved)
    assert resolution.location.region == "Illinois"


async def test_a_qualifier_matching_nothing_is_unresolvable() -> None:
    """Not "the nearest Springfield": the caller asked for one in Iceland and there is none."""
    with pytest.raises(LocationNotFound) as caught:
        await geocoder(fixture("geocode_springfield")).resolve("Springfield, Iceland")
    assert "Iceland" in caught.value.message


async def test_casing_and_surrounding_whitespace_are_tolerated() -> None:
    payload = fixture("geocode_new_york")
    plain = await geocoder(payload).resolve("New York")
    messy = await geocoder(payload).resolve("  new YORK  ")

    assert isinstance(plain, Resolved | Ambiguous)
    if isinstance(plain, Resolved):
        assert isinstance(messy, Resolved)
        assert plain.location.identifier == messy.location.identifier
    else:
        assert isinstance(messy, Ambiguous)
        assert [c.identifier for c in plain.candidates] == [c.identifier for c in messy.candidates]


async def test_an_unknown_name_is_unresolvable_with_no_candidates() -> None:
    with pytest.raises(LocationNotFound) as caught:
        await geocoder(fixture("geocode_none")).resolve("zzzzqqqqxxxx")
    assert caught.value.code == "location_not_found"
    assert "candidates" not in caught.value.details


async def test_an_empty_query_is_a_validation_failure_not_a_lookup() -> None:
    for query in ("", "   "):
        with pytest.raises(ValidationFailed) as caught:
            await geocoder(fixture("geocode_none")).resolve(query)
        assert caught.value.details["field"] == "location"


async def test_the_query_is_sent_upstream_without_its_qualifier() -> None:
    seen: list[httpx.QueryParams] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params)
        return httpx.Response(200, json=fixture("geocode_springfield"))

    resolver = OpenMeteoGeocoder(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await resolver.resolve("Springfield, Illinois")

    assert seen[0]["name"] == "Springfield", "the qualifier is matched locally, not sent upstream"
    assert GEOCODING_URL.endswith("/search")


async def test_a_result_with_no_timezone_is_dropped_rather_than_defaulted() -> None:
    """Every window is resolved from the location's zone, so one without a zone is unusable."""
    payload = {
        "results": [
            {"name": "Nowhere", "latitude": 1.0, "longitude": 1.0},
            {
                "name": "Somewhere",
                "latitude": 2.0,
                "longitude": 2.0,
                "timezone": "Europe/Berlin",
            },
        ]
    }
    resolution = await geocoder(payload).resolve("anywhere")
    assert isinstance(resolution, Resolved)
    assert resolution.location.display_name == "Somewhere"


async def test_an_upstream_result_with_a_bad_coordinate_is_dropped() -> None:
    payload = {
        "results": [
            {"name": "Broken", "latitude": 999.0, "longitude": 0.0, "timezone": "UTC"},
            {"name": "Fine", "latitude": 0.0, "longitude": 0.0, "timezone": "UTC"},
        ]
    }
    resolution = await geocoder(payload).resolve("anywhere")
    assert isinstance(resolution, Resolved)
    assert resolution.location.display_name == "Fine"


# =========================================================================== 6.3 coordinates


async def test_valid_coordinates_resolve_with_a_timezone() -> None:
    resolver = geocoder(fixture("timezone_lookup_reykjavik"))
    location = await resolver.resolve_coordinates(64.15, -21.94)

    assert location.timezone == "Atlantic/Reykjavik"
    assert location.latitude == 64.15
    assert location.longitude == -21.94
    assert location.elevation_metres is not None


async def test_resolving_by_coordinates_uses_the_caller_s_own_point() -> None:
    """Open-Meteo answers with its grid point; the caller asked about theirs."""
    location = await geocoder(fixture("timezone_lookup_reykjavik")).resolve_coordinates(
        64.15, -21.94
    )
    assert (location.latitude, location.longitude) == (64.15, -21.94)


async def test_the_same_place_by_name_and_by_coordinates_shares_an_identifier() -> None:
    """The requirement from specs/location-resolution, across both real code paths."""
    resolver = routed(
        {
            "geocoding-api": fixture("geocode_reykjavik"),
            "api.open-meteo.com": fixture("timezone_lookup_reykjavik"),
        }
    )
    by_name = await resolver.resolve("Reykjavik")
    assert isinstance(by_name, Resolved)
    by_coordinates = await resolver.resolve_coordinates(
        by_name.location.latitude, by_name.location.longitude
    )
    assert by_coordinates.identifier == by_name.location.identifier


async def test_an_out_of_range_latitude_names_the_field() -> None:
    resolver = geocoder(fixture("timezone_lookup_reykjavik"))
    with pytest.raises(ValidationFailed) as caught:
        await resolver.resolve_coordinates(95.0, 0.0)
    assert caught.value.details["field"] == "latitude"
    assert caught.value.details["value"] == 95.0


async def test_an_out_of_range_longitude_names_the_field() -> None:
    resolver = geocoder(fixture("timezone_lookup_reykjavik"))
    with pytest.raises(ValidationFailed) as caught:
        await resolver.resolve_coordinates(0.0, -181.0)
    assert caught.value.details["field"] == "longitude"


async def test_an_out_of_range_coordinate_makes_no_upstream_call() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("validation must happen before any upstream call")

    resolver = OpenMeteoGeocoder(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ValidationFailed):
        await resolver.resolve_coordinates(95.0, 0.0)


async def test_a_coordinate_lookup_asks_for_the_timezone() -> None:
    seen: list[httpx.QueryParams] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params)
        return httpx.Response(200, json=fixture("timezone_lookup_reykjavik"))

    resolver = OpenMeteoGeocoder(
        settings=provider_settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await resolver.resolve_coordinates(64.15, -21.94)
    assert seen[0]["timezone"] == "auto"


# =========================================================================== caching


async def test_a_repeat_resolution_is_served_from_cache() -> None:
    resolver = geocoder(fixture("geocode_reykjavik"))
    await resolver.resolve("Reykjavik")
    await resolver.resolve("Reykjavik")
    assert resolver.upstream_calls == 1


async def test_the_cache_key_ignores_casing_and_whitespace() -> None:
    resolver = geocoder(fixture("geocode_reykjavik"))
    await resolver.resolve("Reykjavik")
    await resolver.resolve("  reykjavik ")
    assert resolver.upstream_calls == 1


async def test_a_qualified_query_shares_the_cache_entry_of_its_bare_name() -> None:
    """The qualifier is matched locally, so both queries need the same upstream result."""
    resolver = geocoder(fixture("geocode_springfield"))
    await resolver.resolve("Springfield")
    await resolver.resolve("Springfield, Illinois")
    assert resolver.upstream_calls == 1


async def test_a_stale_cache_entry_is_refetched() -> None:
    now = 1_000.0
    resolver = OpenMeteoGeocoder(
        settings=provider_settings(cache_geocoding_ttl_seconds=60),
        client=json_transport(fixture("geocode_reykjavik")),
        clock=lambda: now,
    )
    await resolver.resolve("Reykjavik")
    now += 61
    await resolver.resolve("Reykjavik")
    assert resolver.upstream_calls == 2


async def test_a_zero_ttl_disables_the_geocoding_cache() -> None:
    resolver = OpenMeteoGeocoder(
        settings=provider_settings(cache_geocoding_ttl_seconds=0),
        client=json_transport(fixture("geocode_reykjavik")),
    )
    await resolver.resolve("Reykjavik")
    await resolver.resolve("Reykjavik")
    assert resolver.upstream_calls == 2


# =========================================================================== 6.4 search


async def test_search_returns_ranked_candidates_within_the_limit() -> None:
    results = await geocoder(fixture("geocode_san")).search("san", limit=3)
    assert 0 < len(results) <= 3
    assert all(isinstance(result, Location) for result in results)


async def test_search_honours_a_larger_limit_too() -> None:
    results = await geocoder(fixture("geocode_san")).search("san", limit=10)
    assert len(results) <= 10


async def test_search_has_a_documented_default_limit() -> None:
    results = await geocoder(fixture("geocode_san")).search("san")
    assert DEFAULT_SEARCH_LIMIT == 10
    assert len(results) <= DEFAULT_SEARCH_LIMIT


async def test_search_with_no_matches_returns_an_empty_list_not_an_error() -> None:
    assert await geocoder(fixture("geocode_none")).search("zzzzqqqqxxxx") == ()


async def test_search_with_an_empty_query_returns_nothing() -> None:
    assert await geocoder(fixture("geocode_none")).search("   ") == ()


async def test_a_zero_limit_is_a_validation_failure() -> None:
    with pytest.raises(ValidationFailed) as caught:
        await geocoder(fixture("geocode_san")).search("san", limit=0)
    assert caught.value.details["field"] == "limit"


async def test_search_does_not_return_the_same_place_twice() -> None:
    results = await geocoder(fixture("geocode_reykjavik")).search("Reykjavik", limit=10)
    identifiers = [result.identifier for result in results]
    assert len(identifiers) == len(set(identifiers))


# =========================================================================== helpers


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("New York", "new york"),
        ("  new YORK  ", "new york"),
        ("new\tYork", "new york"),
        ("REYKJAVIK", "reykjavik"),
    ],
)
def test_query_normalization(raw: str, expected: str) -> None:
    assert normalize_query(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Springfield", ("Springfield", None)),
        ("Springfield, Illinois", ("Springfield", "Illinois")),
        ("Frankfurt, Hesse, Germany", ("Frankfurt", "Hesse, Germany")),
        ("  Springfield ,  Illinois  ", ("Springfield", "Illinois")),
        ("Springfield,", ("Springfield", None)),
    ],
)
def test_qualifier_splitting(raw: str, expected: tuple[str, str | None]) -> None:
    assert split_qualifier(raw) == expected
