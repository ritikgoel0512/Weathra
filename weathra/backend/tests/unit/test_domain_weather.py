"""Task 2.3 — the normalized weather model: dual timestamps, series-level units, absent-as-null,
and a data class on every result."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from tests import factories as f
from weathra.domain.weather import (
    DAILY_AGGREGATES,
    INSTANTANEOUS_MEASURES,
    AttributedResult,
    CurrentConditions,
    DataClass,
    Forecast,
    Granularity,
    HistoricalObservations,
    Measure,
    Period,
    Series,
    SeriesEntry,
    UnitSystem,
    unit_for,
    units_map,
)

# The twelve measures specs/weather-providers requires the normalized model to define.
REQUIRED_MEASURES = {
    "temperature",
    "apparent_temperature",
    "precipitation",
    "precipitation_probability",
    "wind_speed",
    "wind_gust",
    "wind_direction",
    "relative_humidity",
    "dew_point",
    "surface_pressure",
    "cloud_cover",
    "uv_index",
}


# --------------------------------------------------------------------------- measures and units


def test_every_required_measure_is_defined() -> None:
    assert {measure.value for measure in INSTANTANEOUS_MEASURES} == REQUIRED_MEASURES


def test_daily_aggregates_are_defined_per_measure() -> None:
    """Daily entries additionally define per-measure aggregates where a provider supplies them."""
    aggregates = {measure.value for measure in DAILY_AGGREGATES}
    assert {
        "temperature_max",
        "temperature_min",
        "precipitation_sum",
        "wind_gust_max",
    } <= aggregates


@pytest.mark.parametrize("measure", list(Measure), ids=[m.value for m in Measure])
@pytest.mark.parametrize("unit_system", list(UnitSystem))
def test_every_measure_resolves_to_a_unit(measure: Measure, unit_system: UnitSystem) -> None:
    assert unit_for(measure, unit_system)


def test_metric_is_the_default_expression() -> None:
    assert unit_for(Measure.TEMPERATURE, UnitSystem.METRIC) == "°C"
    assert unit_for(Measure.PRECIPITATION, UnitSystem.METRIC) == "mm"
    assert unit_for(Measure.WIND_SPEED, UnitSystem.METRIC) == "km/h"


def test_imperial_units_reflect_that_choice() -> None:
    assert unit_for(Measure.TEMPERATURE, UnitSystem.IMPERIAL) == "°F"
    assert unit_for(Measure.PRECIPITATION, UnitSystem.IMPERIAL) == "in"
    assert unit_for(Measure.WIND_SPEED, UnitSystem.IMPERIAL) == "mph"


def test_a_daily_aggregate_carries_its_base_measure_unit() -> None:
    assert unit_for(Measure.TEMPERATURE_MAX, UnitSystem.IMPERIAL) == "°F"
    assert unit_for(Measure.PRECIPITATION_SUM, UnitSystem.IMPERIAL) == "in"


def test_units_map_covers_exactly_the_requested_measures() -> None:
    mapping = units_map((Measure.TEMPERATURE, Measure.PRECIPITATION), UnitSystem.METRIC)
    assert mapping == {Measure.TEMPERATURE: "°C", Measure.PRECIPITATION: "mm"}


# --------------------------------------------------------------------------- series entries


def test_an_entry_carries_both_timestamp_forms() -> None:
    entry = f.series({Measure.TEMPERATURE: [4.0]}).entries[0]
    assert entry.time_utc.tzinfo is UTC
    assert entry.time_local.utcoffset() == timedelta(hours=1)  # Berlin, March, CET
    assert entry.time_utc == entry.time_local


def test_the_local_timestamp_serializes_with_its_offset() -> None:
    entry = f.series({Measure.TEMPERATURE: [4.0]}).entries[0]
    payload = json.loads(entry.model_dump_json())
    assert payload["time_utc"].endswith("Z") or payload["time_utc"].endswith("+00:00")
    assert payload["time_local"].endswith("+01:00")


def test_mismatched_timestamps_are_rejected() -> None:
    with pytest.raises(ValidationError, match="same instant"):
        SeriesEntry(
            time_utc=datetime(2026, 3, 2, 0, 0, tzinfo=UTC),
            time_local=datetime(2026, 3, 2, 5, 0, tzinfo=UTC),
            values={},
        )


def test_a_naive_timestamp_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SeriesEntry(
            time_utc=datetime(2026, 3, 2, 0, 0),
            time_local=datetime(2026, 3, 2, 0, 0),
            values={},
        )


# --------------------------------------------------------------------------- absent values


def test_an_absent_measure_serializes_as_null_rather_than_zero() -> None:
    """The requirement from specs/weather-providers, asserted on the wire shape."""
    entry = f.series(
        {Measure.TEMPERATURE: [4.0], Measure.PRECIPITATION_PROBABILITY: [None]}
    ).entries[0]
    payload = json.loads(entry.model_dump_json())
    assert payload["values"]["precipitation_probability"] is None
    assert payload["values"]["precipitation_probability"] != 0
    assert payload["values"]["temperature"] == 4.0


def test_an_absent_measure_keeps_its_declared_unit() -> None:
    """ "Declared but not supplied" must be tellable from "never asked for"."""
    built = f.series({Measure.TEMPERATURE: [4.0], Measure.WIND_GUST: [None]})
    assert built.unit(Measure.WIND_GUST) == "km/h"
    assert built.supplies(Measure.WIND_GUST) is False
    assert built.unit(Measure.UV_INDEX) is None


def test_absent_values_are_counted_not_coerced() -> None:
    built = f.series({Measure.TEMPERATURE: [4.0, None, 6.0, None]})
    assert built.usable_count(Measure.TEMPERATURE) == 2
    assert built.absent_count(Measure.TEMPERATURE) == 2
    assert built.values_for(Measure.TEMPERATURE) == (4.0, None, 6.0, None)


def test_a_measure_with_some_values_is_supplied() -> None:
    built = f.series({Measure.PRECIPITATION: [None, 1.2, None]})
    assert built.supplies(Measure.PRECIPITATION) is True


def test_entry_helpers_distinguish_absent_from_zero() -> None:
    built = f.series({Measure.PRECIPITATION: [0.0, None]})
    assert built.entries[0].has(Measure.PRECIPITATION) is True
    assert built.entries[0].value(Measure.PRECIPITATION) == 0.0
    assert built.entries[1].has(Measure.PRECIPITATION) is False
    assert built.entries[1].value(Measure.PRECIPITATION) is None


# --------------------------------------------------------------------------- series invariants


def test_a_series_carries_its_units_once() -> None:
    built = f.series({Measure.TEMPERATURE: [1.0, 2.0]})
    assert built.units == {Measure.TEMPERATURE: "°C"}
    assert built.measures == (Measure.TEMPERATURE,)
    assert len(built) == 2


def test_entries_must_be_ordered_by_utc_instant() -> None:
    early = datetime(2026, 3, 2, 0, 0, tzinfo=UTC)
    late = datetime(2026, 3, 3, 0, 0, tzinfo=UTC)
    with pytest.raises(ValidationError, match="strictly ordered"):
        Series(
            granularity=Granularity.DAILY,
            units={Measure.TEMPERATURE: "°C"},
            entries=(
                SeriesEntry(time_utc=late, time_local=late, values={}),
                SeriesEntry(time_utc=early, time_local=early, values={}),
            ),
        )


def test_an_entry_cannot_carry_an_undeclared_measure() -> None:
    moment = datetime(2026, 3, 2, 0, 0, tzinfo=UTC)
    with pytest.raises(ValidationError, match="does not declare a unit"):
        Series(
            granularity=Granularity.DAILY,
            units={Measure.TEMPERATURE: "°C"},
            entries=(
                SeriesEntry(time_utc=moment, time_local=moment, values={Measure.WIND_GUST: 40.0}),
            ),
        )


def test_an_empty_series_is_representable() -> None:
    """Retrieval may legitimately return nothing; the analytics layer is what refuses to analyse it."""
    built = Series(granularity=Granularity.HOURLY, units={Measure.TEMPERATURE: "°C"})
    assert len(built) == 0
    assert built.supplies(Measure.TEMPERATURE) is False


# --------------------------------------------------------------------------- periods


def test_a_period_carries_utc_and_local_bounds() -> None:
    window = f.daily_period(datetime(2026, 3, 2, 0, 0, tzinfo=UTC), 7)
    assert window.duration_hours == 168.0
    assert window.start_local.utcoffset() == timedelta(hours=1)
    assert window.timezone == "Europe/Berlin"


def test_an_inverted_period_is_rejected() -> None:
    with pytest.raises(ValidationError, match="must not precede"):
        f.period(datetime(2026, 3, 9, tzinfo=UTC), datetime(2026, 3, 2, tzinfo=UTC))


def test_period_local_bounds_must_be_the_same_instants() -> None:
    with pytest.raises(ValidationError, match="same instant"):
        Period(
            start_utc=datetime(2026, 3, 2, 0, 0, tzinfo=UTC),
            end_utc=datetime(2026, 3, 9, 0, 0, tzinfo=UTC),
            start_local=datetime(2026, 3, 2, 6, 0, tzinfo=UTC),
            end_local=datetime(2026, 3, 9, 0, 0, tzinfo=UTC),
            timezone="Europe/Berlin",
        )


def test_period_containment_is_half_open() -> None:
    window = f.period(datetime(2026, 3, 2, tzinfo=UTC), datetime(2026, 3, 3, tzinfo=UTC))
    assert window.contains(datetime(2026, 3, 2, tzinfo=UTC))
    assert window.contains(datetime(2026, 3, 2, 23, 59, tzinfo=UTC))
    assert not window.contains(datetime(2026, 3, 3, tzinfo=UTC))


# --------------------------------------------------------------------------- attributed results


def test_current_conditions_carry_every_attribution_field() -> None:
    conditions = f.current_conditions({Measure.TEMPERATURE: 7.5, Measure.WIND_SPEED: 12.0})
    assert conditions.data_class is DataClass.CURRENT
    assert conditions.provider == "open-meteo"
    assert conditions.unit_system is UnitSystem.METRIC
    assert conditions.retrieved_at.tzinfo is UTC
    assert conditions.from_cache is False
    assert conditions.units[Measure.TEMPERATURE] == "°C"
    assert conditions.location.display_name == "Berlin"


def test_current_conditions_are_not_labelled_forecast() -> None:
    conditions = f.current_conditions({Measure.TEMPERATURE: 7.5})
    assert conditions.data_class is not DataClass.FORECAST
    with pytest.raises(ValidationError):
        CurrentConditions(**{**conditions.model_dump(), "data_class": DataClass.FORECAST})


def test_current_conditions_carry_both_observation_timestamp_forms() -> None:
    conditions = f.current_conditions({Measure.TEMPERATURE: 7.5})
    assert conditions.observed_at_utc == conditions.observed_at_local
    assert conditions.observed_at_local.utcoffset() == timedelta(hours=1)


def test_forecast_carries_hourly_and_daily_series_with_its_window() -> None:
    hourly = f.series({Measure.TEMPERATURE: [1.0] * 48}, granularity=Granularity.HOURLY)
    daily = f.series({Measure.TEMPERATURE_MAX: [5.0] * 7})
    built = f.forecast(hourly=hourly, daily=daily)
    assert built.data_class is DataClass.FORECAST
    assert len(built.hourly) == 48
    assert len(built.daily) == 7
    assert built.horizon_days == 7
    assert built.period.duration_hours == 168.0


def test_forecast_rejects_a_series_at_the_wrong_granularity() -> None:
    daily = f.series({Measure.TEMPERATURE_MAX: [5.0] * 7})
    with pytest.raises(ValidationError, match="hourly series"):
        Forecast(
            location=f.BERLIN,
            provider="open-meteo",
            unit_system=UnitSystem.METRIC,
            retrieved_at=f.RETRIEVED_AT,
            from_cache=False,
            period=f.daily_period(datetime(2026, 3, 2, tzinfo=UTC), 7),
            horizon_days=7,
            hourly=daily,
            daily=daily,
        )


def test_historical_observations_are_labelled_historical() -> None:
    built = f.historical(daily=f.series({Measure.TEMPERATURE_MEAN: [3.0] * 28}))
    assert built.data_class is DataClass.HISTORICAL_OBSERVATION
    assert built.is_partial is False
    assert built.unavailable_note is None


def test_partial_historical_coverage_must_state_what_is_unavailable() -> None:
    """The archive's reporting lag case from specs/historical-weather."""
    requested = f.daily_period(datetime(2026, 2, 1, tzinfo=UTC), 28)
    covered = f.daily_period(datetime(2026, 2, 1, tzinfo=UTC), 23)

    built = f.historical(
        daily=f.series({Measure.TEMPERATURE_MEAN: [3.0] * 23}),
        requested=requested,
        covered=covered,
        unavailable_note="2026-02-24 to 2026-02-28 is not yet in the archive.",
    )
    assert built.is_partial is True
    assert "not yet in the archive" in (built.unavailable_note or "")

    with pytest.raises(ValidationError, match="must state which part"):
        f.historical(
            daily=f.series({Measure.TEMPERATURE_MEAN: [3.0] * 23}),
            requested=requested,
            covered=covered,
        )


def test_covered_period_cannot_exceed_the_requested_one() -> None:
    with pytest.raises(ValidationError, match="within the requested period"):
        f.historical(
            daily=f.series({Measure.TEMPERATURE_MEAN: [3.0]}),
            requested=f.daily_period(datetime(2026, 2, 1, tzinfo=UTC), 7),
            covered=f.daily_period(datetime(2026, 2, 1, tzinfo=UTC), 30),
            unavailable_note="n/a",
        )


@pytest.mark.parametrize(
    ("build", "expected"),
    [
        (lambda: f.current_conditions({Measure.TEMPERATURE: 1.0}), DataClass.CURRENT),
        (lambda: f.forecast(), DataClass.FORECAST),
        (
            lambda: f.historical(daily=f.series({Measure.TEMPERATURE_MEAN: [1.0]})),
            DataClass.HISTORICAL_OBSERVATION,
        ),
    ],
    ids=["current", "forecast", "historical"],
)
def test_every_result_carries_a_data_class(
    build: Callable[[], CurrentConditions | Forecast | HistoricalObservations],
    expected: DataClass,
) -> None:
    assert build().data_class is expected


@pytest.mark.parametrize(
    "build",
    [
        lambda: f.current_conditions({Measure.TEMPERATURE: 1.0}),
        lambda: f.forecast(),
        lambda: f.historical(daily=f.series({Measure.TEMPERATURE_MEAN: [1.0]})),
    ],
    ids=["current", "forecast", "historical"],
)
def test_every_result_carries_provider_units_retrieval_time_and_cache_status(
    build: Callable[[], AttributedResult],
) -> None:
    result = build()
    assert result.provider
    assert result.unit_system in set(UnitSystem)
    assert result.retrieved_at.tzinfo is UTC
    assert result.from_cache in (True, False)


def test_cache_status_propagates_to_the_result() -> None:
    assert f.current_conditions({Measure.TEMPERATURE: 1.0}, from_cache=True).from_cache is True


def test_a_non_utc_retrieval_time_is_rejected() -> None:
    with pytest.raises(ValidationError, match="retrieved_at must be expressed in UTC"):
        f.current_conditions(
            {Measure.TEMPERATURE: 1.0},
            retrieved_at=datetime(2026, 3, 1, 13, 0, tzinfo=f.BERLIN.zoneinfo),
        )


def test_results_round_trip_through_json() -> None:
    original = f.historical(
        daily=f.series({Measure.TEMPERATURE_MEAN: [3.0, None, 5.0]}),
        unavailable_note=None,
    )
    restored = HistoricalObservations.model_validate_json(original.model_dump_json())
    assert restored == original


def test_results_are_frozen() -> None:
    conditions = f.current_conditions({Measure.TEMPERATURE: 1.0})
    with pytest.raises(ValidationError):
        conditions.provider = "other"  # type: ignore[misc]
