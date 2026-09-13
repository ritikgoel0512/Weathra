"""Comparing saved places — the arithmetic, with nothing around it.

Each case is a way a cross-location summary quietly lies: a city ranked coldest because its
provider was unreachable, a "comparison" drawn from one reading, a driest city reported where every
value is zero.
"""

from __future__ import annotations

from weathra.analytics.saved_places import PlaceReading, compare_places
from weathra.domain.weather import Measure

UNITS = {
    Measure.TEMPERATURE: "°C",
    Measure.PRECIPITATION: "mm",
    Measure.WIND_SPEED: "km/h",
}


def reading(saved_id: str, name: str, **values: float | None) -> PlaceReading:
    return PlaceReading(
        saved_id=saved_id,
        name=name,
        values={Measure(measure): value for measure, value in values.items()},
        units=UNITS,
    )


def test_one_place_is_not_a_comparison() -> None:
    """A table with one row in it is not a comparison, and the screen should say so in words."""
    assert compare_places([reading("a", "London", temperature=18.4)]) is None


def test_the_extremes_are_named_with_the_reading_that_put_them_there() -> None:
    found = compare_places(
        [
            reading("a", "London", temperature=18.4, precipitation=0.2, wind_speed=13.0),
            reading("b", "Berlin", temperature=21.1, precipitation=0.0, wind_speed=22.5),
        ]
    )
    assert found is not None
    assert found.warmest is not None and found.warmest.name == "Berlin"
    assert found.warmest.value == 21.1
    assert found.warmest.unit == "°C"
    assert found.coolest is not None and found.coolest.name == "London"
    assert found.temperature_spread == 2.7
    assert found.wettest is not None and found.wettest.name == "London"
    assert found.windiest is not None and found.windiest.name == "Berlin"
    assert found.reporting_precipitation == 1


def test_a_place_with_no_reading_is_absent_rather_than_ranked_lowest() -> None:
    """A city ranked coldest for want of a reading is a silent provider becoming cold weather."""
    found = compare_places(
        [
            reading("a", "London", temperature=18.4),
            reading("b", "Berlin", temperature=21.1),
            reading("c", "Oslo", temperature=None),
        ]
    )
    assert found is not None
    assert found.coolest is not None and found.coolest.name == "London"
    assert found.compared == 3, "three places were compared"
    assert "Oslo" not in {found.warmest.name, found.coolest.name}  # type: ignore[union-attr]


def test_a_measure_only_one_place_reported_is_not_ranked() -> None:
    """ "The windiest of one" is a statement about nothing to have been windier than."""
    found = compare_places(
        [
            reading("a", "London", temperature=18.4, wind_speed=13.0),
            reading("b", "Berlin", temperature=21.1),
        ]
    )
    assert found is not None
    assert found.warmest is not None, "both reported a temperature"
    assert found.windiest is None, "only one reported wind"


def test_nothing_is_reported_as_driest_where_every_reading_is_zero() -> None:
    """Precipitation is zero almost everywhere, so a driest city would be reporting a tie."""
    found = compare_places(
        [
            reading("a", "London", precipitation=0.0),
            reading("b", "Berlin", precipitation=0.0),
        ]
    )
    assert found is not None
    assert found.reporting_precipitation == 0
    assert found.wettest is not None and found.wettest.value == 0.0
    assert found.temperature_spread is None, "nobody reported a temperature"
