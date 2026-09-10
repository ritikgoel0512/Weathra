"""Applying an assumption to a real series — task 34.16.

Each case is a rule the module exists to hold. A scenario is arithmetic over a retrieved series, and
the ways that goes wrong are all quiet: an absent value becoming the adjustment, a humidity above a
hundred, a negative rainfall, a clipped hour absorbed without saying so.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from weathra.analytics.scenario import ScenarioAssumptions, apply_assumptions
from weathra.domain.weather import Granularity, Measure, Series, SeriesEntry


def series(*values: dict[Measure, float | None]) -> Series:
    start = datetime(2026, 9, 10, tzinfo=UTC)
    return Series(
        granularity=Granularity.HOURLY,
        units={
            Measure.TEMPERATURE: "°C",
            Measure.PRECIPITATION: "mm",
            Measure.RELATIVE_HUMIDITY: "%",
            Measure.WIND_SPEED: "km/h",
        },
        entries=tuple(
            SeriesEntry(
                time_utc=start + timedelta(hours=index),
                time_local=start + timedelta(hours=index),
                values=value,
            )
            for index, value in enumerate(values)
        ),
    )


def test_an_offset_moves_every_reported_value_and_nothing_else() -> None:
    baseline = series({Measure.TEMPERATURE: 10.0}, {Measure.TEMPERATURE: 12.0})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=2.5))

    assert [entry.values[Measure.TEMPERATURE] for entry in scenario.entries] == [12.5, 14.5]
    assert measures[0].baseline_mean == pytest.approx(11.0)
    assert measures[0].scenario_mean == pytest.approx(13.5)
    assert measures[0].difference == pytest.approx(2.5)
    assert measures[0].method == "+2.50 added to each reported value"


def test_a_percentage_scales_rather_than_adds() -> None:
    baseline = series({Measure.PRECIPITATION: 2.0}, {Measure.PRECIPITATION: 4.0})

    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(precipitation_percent=50.0)
    )

    assert [entry.values[Measure.PRECIPITATION] for entry in scenario.entries] == [3.0, 6.0]
    assert "scaled by +50.0%" in measures[0].method


def test_an_absent_value_stays_absent() -> None:
    """Adding to nothing is not the adjustment. The hour is excluded and counted."""
    baseline = series({Measure.TEMPERATURE: 10.0}, {Measure.TEMPERATURE: None})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=3.0))

    assert scenario.entries[1].values[Measure.TEMPERATURE] is None
    assert measures[0].points_used == 1
    assert measures[0].points_excluded == 1


def test_a_physical_bound_is_applied_and_the_crossing_is_counted() -> None:
    """Relative humidity cannot exceed a hundred, and an hour clipped there says so."""
    baseline = series({Measure.RELATIVE_HUMIDITY: 95.0}, {Measure.RELATIVE_HUMIDITY: 50.0})

    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(relative_humidity_delta=20.0)
    )

    assert scenario.entries[0].values[Measure.RELATIVE_HUMIDITY] == 100.0
    assert scenario.entries[1].values[Measure.RELATIVE_HUMIDITY] == 70.0
    assert measures[0].clipped == 1


def test_precipitation_and_wind_cannot_be_driven_negative() -> None:
    baseline = series({Measure.PRECIPITATION: 1.0, Measure.WIND_SPEED: 5.0})

    scenario, _ = apply_assumptions(
        baseline,
        ScenarioAssumptions(precipitation_percent=-100.0, wind_speed_delta=-40.0),
    )

    assert scenario.entries[0].values[Measure.PRECIPITATION] == 0.0
    assert scenario.entries[0].values[Measure.WIND_SPEED] == 0.0


def test_a_measure_no_assumption_addressed_passes_through_untouched() -> None:
    baseline = series({Measure.TEMPERATURE: 10.0, Measure.WIND_SPEED: 12.0})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=1.0))

    assert scenario.entries[0].values[Measure.WIND_SPEED] == 12.0
    assert [measure.measure for measure in measures] == [Measure.TEMPERATURE]


def test_no_assumptions_changes_nothing() -> None:
    """The baseline is the scenario when nothing was supposed. Same shape, same values."""
    baseline = series({Measure.TEMPERATURE: 10.0})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions())

    assert scenario.entries[0].values == baseline.entries[0].values
    assert measures == ()


def test_the_result_is_deterministic() -> None:
    """Same arguments, same answer — `specs/deterministic-analytics`, and what makes a scenario
    reproducible rather than a roll of the dice."""
    baseline = series({Measure.TEMPERATURE: 10.0}, {Measure.TEMPERATURE: None})
    assumptions = ScenarioAssumptions(temperature_delta=2.0, precipitation_percent=10.0)

    assert apply_assumptions(baseline, assumptions) == apply_assumptions(baseline, assumptions)


def test_the_scenario_keeps_the_instants_and_units_of_its_baseline() -> None:
    baseline = series({Measure.TEMPERATURE: 10.0}, {Measure.TEMPERATURE: 11.0})

    scenario, _ = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=1.0))

    assert scenario.granularity == baseline.granularity
    assert scenario.units == baseline.units
    assert [entry.time_utc for entry in scenario.entries] == [
        entry.time_utc for entry in baseline.entries
    ]
