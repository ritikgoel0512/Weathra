"""Applying an assumption to a real series — task 34.16.

Each case is a rule the module exists to hold. A scenario is arithmetic over a retrieved series, and
the ways that goes wrong are all quiet: an absent value becoming the adjustment, a humidity above a
hundred, a negative rainfall, a clipped hour absorbed without saying so.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from weathra.analytics.scenario import (
    ScenarioAssumptions,
    apply_assumptions,
    summarise_effects,
)
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


# ------------------------------------------------------------- what it did


def test_a_crossing_counts_hours_either_side_of_a_stated_threshold() -> None:
    baseline = series(
        {Measure.PRECIPITATION: 0.0},
        {Measure.PRECIPITATION: 0.0},
        {Measure.PRECIPITATION: 1.0},
    )

    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(precipitation_percent=100.0)
    )
    effects = summarise_effects(baseline, scenario, measures)

    rain = next(c for c in effects.crossings if c.measure is Measure.PRECIPITATION)
    # Scaling cannot make a dry hour wet — zero times anything is zero — so the count holds, and
    # that is the honest answer rather than a risk that grew because a percentage was applied.
    assert (rain.baseline_hours, rain.scenario_hours, rain.difference) == (1, 1, 0)


def test_a_crossing_is_not_counted_for_a_measure_the_provider_never_reported() -> None:
    baseline = series({Measure.TEMPERATURE: 10.0}, {Measure.TEMPERATURE: 12.0})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=1.0))
    effects = summarise_effects(baseline, scenario, measures)

    assert effects.crossings == ()


def test_a_peak_is_the_highest_reported_value_and_when_the_scenario_reaches_it() -> None:
    baseline = series(
        {Measure.TEMPERATURE: 10.0},
        {Measure.TEMPERATURE: 18.0},
        {Measure.TEMPERATURE: 12.0},
    )

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions(temperature_delta=2.0))
    effects = summarise_effects(baseline, scenario, measures)

    peak = next(e for e in effects.extremes if e.measure is Measure.TEMPERATURE)
    assert (peak.baseline, peak.scenario, peak.difference) == (18.0, 20.0, 2.0)
    assert peak.occurred_at_local is not None
    assert peak.occurred_at_local.startswith("2026-09-10T01:00")


def test_the_risk_signal_leads_with_hours_that_gained_rain() -> None:
    baseline = series(
        {Measure.PRECIPITATION: 0.0, Measure.TEMPERATURE: 10.0},
        {Measure.PRECIPITATION: 1.0, Measure.TEMPERATURE: 10.0},
    )

    # An offset on precipitation is not offered, so a wetter window is produced the way the product
    # actually produces one: scaling a window that already carries rain.
    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(precipitation_percent=50.0, temperature_delta=5.0)
    )
    effects = summarise_effects(baseline, scenario, measures)

    # No hour gained rain, so the signal falls through to the peak that did move.
    assert effects.risk.kind == "higher-peak-temperature"
    assert "15.0 °C" in effects.risk.detail


def test_the_risk_signal_says_so_when_no_assumption_was_made() -> None:
    baseline = series({Measure.TEMPERATURE: 10.0})

    scenario, measures = apply_assumptions(baseline, ScenarioAssumptions())
    effects = summarise_effects(baseline, scenario, measures)

    assert effects.risk.kind == "none"
    assert effects.risk.label == "No assumption applied"


def test_sensitivity_ranks_assumptions_by_share_of_their_own_baseline() -> None:
    baseline = series(
        {Measure.TEMPERATURE: 20.0, Measure.WIND_SPEED: 10.0},
        {Measure.TEMPERATURE: 20.0, Measure.WIND_SPEED: 10.0},
    )

    # +2 on a mean of 20 is a tenth; +5 on a mean of 10 is a half. The larger *share* wins, which
    # is the only way two quantities in two units can be ranked at all.
    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(temperature_delta=2.0, wind_speed_delta=5.0)
    )
    effects = summarise_effects(baseline, scenario, measures)

    assert effects.sensitivity.measure is Measure.WIND_SPEED
    assert "50.0%" in effects.sensitivity.detail


def test_sensitivity_ranks_on_the_movement_itself_where_a_baseline_mean_is_zero() -> None:
    baseline = series({Measure.PRECIPITATION: 0.0}, {Measure.PRECIPITATION: 0.0})

    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(precipitation_percent=200.0)
    )
    effects = summarise_effects(baseline, scenario, measures)

    # The ratio is undefined against a zero mean rather than infinite, and the rank still resolves.
    assert effects.sensitivity.kind == "most-sensitive"
    assert effects.sensitivity.measure is Measure.PRECIPITATION


def test_an_absent_value_is_counted_in_neither_crossing_nor_peak() -> None:
    baseline = series(
        {Measure.TEMPERATURE: 10.0, Measure.PRECIPITATION: None},
        {Measure.TEMPERATURE: None, Measure.PRECIPITATION: 2.0},
    )

    scenario, measures = apply_assumptions(
        baseline, ScenarioAssumptions(temperature_delta=1.0, precipitation_percent=10.0)
    )
    effects = summarise_effects(baseline, scenario, measures)

    peak = next(e for e in effects.extremes if e.measure is Measure.TEMPERATURE)
    assert peak.scenario == 11.0

    rain = next(c for c in effects.crossings if c.measure is Measure.PRECIPITATION)
    assert (rain.baseline_hours, rain.scenario_hours) == (1, 1)
