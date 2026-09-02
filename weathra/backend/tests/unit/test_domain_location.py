"""Task 2.2 — the canonical location, its stable identifier, and both resolution variants."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from weathra.domain.errors import ValidationFailed
from weathra.domain.location import (
    Ambiguous,
    Location,
    Resolution,
    Resolved,
    location_identifier,
    validate_coordinates,
)

REYKJAVIK = {
    "display_name": "Reykjavík",
    "latitude": 64.1466,
    "longitude": -21.9426,
    "timezone": "Atlantic/Reykjavik",
    "country": "Iceland",
    "country_code": "is",
    "elevation_metres": 61.0,
}


def test_a_valid_location_carries_every_required_field() -> None:
    location = Location(**REYKJAVIK)
    assert location.display_name == "Reykjavík"
    assert location.latitude == 64.1466
    assert location.longitude == -21.9426
    assert location.timezone == "Atlantic/Reykjavik"
    assert location.country_code == "IS"
    assert location.identifier


def test_optional_fields_may_be_absent() -> None:
    location = Location(display_name="Nowhere", latitude=0.0, longitude=0.0, timezone="UTC")
    assert location.region is None
    assert location.country is None
    assert location.country_code is None
    assert location.elevation_metres is None


def test_locations_are_frozen() -> None:
    location = Location(**REYKJAVIK)
    with pytest.raises(ValidationError):
        location.latitude = 0.0  # type: ignore[misc]


@pytest.mark.parametrize("latitude", [90.5, -90.5, 95.0, 1000.0])
def test_out_of_range_latitude_is_rejected(latitude: float) -> None:
    with pytest.raises(ValidationError) as caught:
        Location(display_name="x", latitude=latitude, longitude=0.0, timezone="UTC")
    assert "latitude" in str(caught.value)


@pytest.mark.parametrize("longitude", [180.5, -180.5, 1000.0])
def test_out_of_range_longitude_is_rejected(longitude: float) -> None:
    with pytest.raises(ValidationError) as caught:
        Location(display_name="x", latitude=0.0, longitude=longitude, timezone="UTC")
    assert "longitude" in str(caught.value)


@pytest.mark.parametrize(("latitude", "longitude"), [(90.0, 180.0), (-90.0, -180.0), (0.0, 0.0)])
def test_range_bounds_are_inclusive(latitude: float, longitude: float) -> None:
    assert Location(display_name="edge", latitude=latitude, longitude=longitude, timezone="UTC")


def test_validate_coordinates_names_the_offending_field() -> None:
    with pytest.raises(ValidationFailed) as caught:
        validate_coordinates(95.0, 0.0)
    assert caught.value.details["field"] == "latitude"
    assert caught.value.details["value"] == 95.0
    assert "95.0" in caught.value.message

    with pytest.raises(ValidationFailed) as caught:
        validate_coordinates(0.0, -181.0)
    assert caught.value.details["field"] == "longitude"


def test_validate_coordinates_returns_a_valid_pair() -> None:
    assert validate_coordinates(64.15, -21.94) == (64.15, -21.94)


def test_unknown_timezone_is_rejected() -> None:
    with pytest.raises(ValidationError, match="not a known IANA timezone"):
        Location(display_name="x", latitude=0.0, longitude=0.0, timezone="Mars/Olympus_Mons")


def test_zoneinfo_is_available_for_window_resolution() -> None:
    assert Location(**REYKJAVIK).zoneinfo.key == "Atlantic/Reykjavik"


def test_display_name_and_region_are_stripped() -> None:
    location = Location(
        display_name="  New York  ",
        latitude=40.71,
        longitude=-74.01,
        timezone="America/New_York",
        region="  New York  ",
    )
    assert location.display_name == "New York"
    assert location.region == "New York"


def test_qualified_name_distinguishes_a_shared_place_name() -> None:
    springfield = Location(
        display_name="Springfield",
        latitude=39.80,
        longitude=-89.64,
        timezone="America/Chicago",
        region="Illinois",
        country="United States",
        country_code="US",
    )
    assert springfield.qualified_name == "Springfield, Illinois, US"


# --------------------------------------------------------------------- the stable identifier


def test_same_place_by_name_and_by_coordinates_shares_one_identifier() -> None:
    """The requirement from specs/location-resolution, stated as the two real paths.

    Geocoding "Reykjavik" returns 64.1466, -21.9426. A caller typing coordinates supplies
    64.15, -21.94. Both are the same place and must carry the same identifier.
    """
    by_name = Location(**REYKJAVIK)
    by_coordinates = Location(
        display_name="64.15, -21.94",
        latitude=64.15,
        longitude=-21.94,
        timezone="Atlantic/Reykjavik",
    )
    assert by_name.identifier == by_coordinates.identifier
    assert by_name.is_same_place(by_coordinates)


def test_identifier_is_independent_of_the_display_name_and_metadata() -> None:
    first = Location(**REYKJAVIK)
    second = Location(
        display_name="Reykjavik Capital Region",
        latitude=REYKJAVIK["latitude"],
        longitude=REYKJAVIK["longitude"],
        timezone="Atlantic/Reykjavik",
        region="Capital Region",
    )
    assert first.identifier == second.identifier


def test_identifier_distinguishes_genuinely_different_places() -> None:
    berlin = Location(
        display_name="Berlin", latitude=52.52, longitude=13.41, timezone="Europe/Berlin"
    )
    munich = Location(
        display_name="Munich", latitude=48.14, longitude=11.58, timezone="Europe/Berlin"
    )
    assert berlin.identifier != munich.identifier
    assert not berlin.is_same_place(munich)


def test_identifier_is_stable_across_repeated_computation() -> None:
    assert location_identifier(64.1466, -21.9426) == location_identifier(64.1466, -21.9426)


def test_identifier_does_not_split_on_the_sign_of_zero() -> None:
    assert location_identifier(0.0, 0.0) == location_identifier(-0.0, -0.0)
    assert location_identifier(-0.001, 0.001) == location_identifier(0.0, 0.0)


def test_identifier_shape_is_readable_and_prefixed() -> None:
    assert location_identifier(64.1466, -21.9426) == "loc:64.15,-21.94"


# --------------------------------------------------------------------- resolution variants


def test_resolved_variant() -> None:
    resolved = Resolved(query="Reykjavik", location=Location(**REYKJAVIK))
    assert resolved.kind == "resolved"
    assert resolved.location.display_name == "Reykjavík"


def test_ambiguous_variant_carries_distinguishing_detail() -> None:
    ambiguous = Ambiguous(
        query="Springfield",
        candidates=(
            Location(
                display_name="Springfield",
                latitude=39.80,
                longitude=-89.64,
                timezone="America/Chicago",
                region="Illinois",
                country="United States",
                country_code="US",
            ),
            Location(
                display_name="Springfield",
                latitude=37.21,
                longitude=-93.30,
                timezone="America/Chicago",
                region="Missouri",
                country="United States",
                country_code="US",
            ),
        ),
    )
    assert ambiguous.kind == "ambiguous"
    assert len(ambiguous.candidates) == 2
    assert {candidate.region for candidate in ambiguous.candidates} == {"Illinois", "Missouri"}


def test_ambiguity_requires_at_least_two_candidates() -> None:
    """One candidate is a resolution, not an ambiguity."""
    with pytest.raises(ValidationError):
        Ambiguous(query="Reykjavik", candidates=(Location(**REYKJAVIK),))


def test_ambiguous_candidates_must_be_distinct_places() -> None:
    same = Location(**REYKJAVIK)
    with pytest.raises(ValidationError, match="distinct places"):
        Ambiguous(query="Reykjavik", candidates=(same, same))


def test_resolution_union_discriminates_on_kind() -> None:
    adapter: TypeAdapter[Resolution] = TypeAdapter(Resolution)

    resolved = adapter.validate_python(
        {"kind": "resolved", "query": "Reykjavik", "location": REYKJAVIK}
    )
    assert isinstance(resolved, Resolved)

    ambiguous = adapter.validate_python(
        {
            "kind": "ambiguous",
            "query": "Springfield",
            "candidates": [
                {**REYKJAVIK, "display_name": "A"},
                {**REYKJAVIK, "display_name": "B", "latitude": 37.21, "longitude": -93.30},
            ],
        }
    )
    assert isinstance(ambiguous, Ambiguous)


def test_resolution_round_trips_through_json() -> None:
    adapter: TypeAdapter[Resolution] = TypeAdapter(Resolution)
    original: Resolution = Resolved(query="Reykjavik", location=Location(**REYKJAVIK))
    restored = adapter.validate_json(adapter.dump_json(original))
    assert restored == original
