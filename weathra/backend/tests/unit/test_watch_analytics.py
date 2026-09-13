"""What a watch concluded, and what moved since — the arithmetic, with nothing around it.

Each case here is a way a monitoring product lies quietly. A silent provider reported as calm
weather. A failed retrieval reported as a reading. A transition recorded twice because the state was
recomputed rather than remembered. A "change" that is the provider's model landing a hair away from
where it landed last hour. None of those fail loudly; every one of them puts a wrong word on a
screen somebody is relying on.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from weathra.analytics.watch import (
    WatchOutcome,
    WatchState,
    changes_between,
    conditions_at,
    crossing_in,
    evidence_for,
    holds,
    outcome_for,
    state_for,
)
from weathra.domain.weather import Granularity, Measure, Series, SeriesEntry

START = datetime(2026, 9, 13, 12, tzinfo=UTC)


def series(*values: dict[Measure, float | None]) -> Series:
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
                time_utc=START + timedelta(hours=index),
                time_local=START + timedelta(hours=index),
                values=value,
            )
            for index, value in enumerate(values)
        ),
    )


def outcome(**overrides: object) -> WatchOutcome:
    base: dict[str, object] = {
        "measure": Measure.TEMPERATURE,
        "comparison": "above",
        "threshold": 25.0,
        "unit": "°C",
    }
    return WatchOutcome.model_validate(base | overrides)


# ------------------------------------------------------------------ the comparison


@pytest.mark.parametrize(
    ("comparison", "threshold", "value", "expected"),
    [
        ("above", 25.0, 26.3, True),
        ("above", 25.0, 25.0, False),
        ("below", 5.0, 4.2, True),
        ("below", 5.0, 5.0, False),
    ],
)
def test_the_threshold_is_exclusive_in_both_directions(
    comparison: str, threshold: float, value: float, expected: bool
) -> None:
    """Exactly at the threshold is not past it, and that holds whichever way the watch points."""
    assert holds(comparison=comparison, threshold=threshold, value=value) is expected


def test_no_reading_is_null_rather_than_unmet() -> None:
    """The one mistake a monitoring product must never make: a silent provider as calm weather."""
    assert holds(comparison="above", threshold=25.0, value=None) is None


# ------------------------------------------------------------------ the six states


@pytest.mark.parametrize(
    ("enabled", "evaluated", "met", "degraded", "expected"),
    [
        (False, True, True, False, WatchState.PAUSED),
        (True, False, None, False, WatchState.PENDING),
        (True, True, None, True, WatchState.DEGRADED),
        (True, True, None, False, WatchState.NO_READING),
        (True, True, True, False, WatchState.MET),
        (True, True, False, False, WatchState.NOT_MET),
    ],
)
def test_every_state_is_reachable_and_paused_outranks_a_stale_reading(
    enabled: bool, evaluated: bool, met: bool | None, degraded: bool, expected: WatchState
) -> None:
    """A paused watch is not being checked, so its last reading is no longer a claim about now."""
    assert state_for(enabled=enabled, evaluated=evaluated, met=met, degraded=degraded) is expected


def test_a_failed_retrieval_is_degraded_rather_than_no_reading() -> None:
    """Blaming the provider for our own outage is a different sentence from the true one."""
    assert state_for(enabled=True, evaluated=True, met=None, degraded=True) is WatchState.DEGRADED


# ------------------------------------------------------------------ one evaluation


def test_the_reading_is_the_first_hour_the_provider_actually_reported() -> None:
    """A series that opens with a gap has a gap, not an absent measure."""
    found = outcome_for(
        series({Measure.TEMPERATURE: None}, {Measure.TEMPERATURE: 26.3}),
        measure=Measure.TEMPERATURE,
        comparison="above",
        threshold=25.0,
    )
    assert found.value == 26.3
    assert found.matched_at_utc == START + timedelta(hours=1)
    assert found.points_used == 1


def test_the_margin_is_signed_towards_the_condition_in_both_directions() -> None:
    """One number and a direction, so no screen has to pair a magnitude with the right word."""
    above = outcome_for(
        series({Measure.TEMPERATURE: 26.3}),
        measure=Measure.TEMPERATURE,
        comparison="above",
        threshold=25.0,
    )
    below = outcome_for(
        series({Measure.TEMPERATURE: 26.3}),
        measure=Measure.TEMPERATURE,
        comparison="below",
        threshold=25.0,
    )
    assert above.margin == pytest.approx(1.3)
    assert above.met is True
    # The same reading against the same number, watched the other way: the sign flips with it.
    assert below.margin == pytest.approx(-1.3)
    assert below.met is False


def test_the_first_crossing_is_the_first_hour_past_the_threshold() -> None:
    crossing = crossing_in(
        series(
            {Measure.TEMPERATURE: 22.0},
            {Measure.TEMPERATURE: 24.9},
            {Measure.TEMPERATURE: 26.1},
            {Measure.TEMPERATURE: 27.4},
        ),
        measure=Measure.TEMPERATURE,
        comparison="above",
        threshold=25.0,
    )
    assert crossing is not None
    assert crossing.at_utc == START + timedelta(hours=2)
    assert crossing.value == 26.1


def test_a_window_that_never_crosses_reports_no_crossing_rather_than_its_peak() -> None:
    found = outcome_for(
        series({Measure.TEMPERATURE: 19.0}, {Measure.TEMPERATURE: 21.0}),
        measure=Measure.TEMPERATURE,
        comparison="above",
        threshold=25.0,
    )
    assert found.crossing is None
    assert found.peak == 21.0, "the peak is still real; it just is not a crossing"


def test_the_peak_follows_the_direction_the_watch_points() -> None:
    """A watch for cold wants the lowest the window reaches, not the highest."""
    cold = outcome_for(
        series({Measure.TEMPERATURE: 4.0}, {Measure.TEMPERATURE: -2.0}),
        measure=Measure.TEMPERATURE,
        comparison="below",
        threshold=0.0,
    )
    assert cold.peak == -2.0


def test_the_conditions_come_from_the_hour_the_watch_was_read_from() -> None:
    """The card and the watch quote one reading, not two that happen to be close."""
    window = series(
        {Measure.TEMPERATURE: 20.0, Measure.WIND_SPEED: 8.0},
        {Measure.TEMPERATURE: 26.3, Measure.WIND_SPEED: 14.0},
    )
    assert conditions_at(window, START + timedelta(hours=1)) == {
        Measure.TEMPERATURE: 26.3,
        Measure.WIND_SPEED: 14.0,
    }


# ------------------------------------------------------------------ the evidence sentence


def test_the_evidence_names_the_provider_the_reading_and_the_distance() -> None:
    """Assembled from the figures, never generated: the prose cannot contradict the number."""
    sentence = evidence_for(
        outcome_for(
            series({Measure.TEMPERATURE: 26.3}),
            measure=Measure.TEMPERATURE,
            comparison="above",
            threshold=25.0,
        ),
        provider="Open-Meteo",
        place="London",
    )
    assert "Open-Meteo" in sentence
    assert "26.3 °C" in sentence
    assert "25 °C" in sentence
    assert "1.3 °C above" in sentence
    assert "is met" in sentence


def test_the_evidence_for_a_silent_provider_claims_no_reading() -> None:
    sentence = evidence_for(
        outcome_for(
            series({Measure.WIND_SPEED: 10.0}),
            measure=Measure.TEMPERATURE,
            comparison="above",
            threshold=25.0,
        ),
        provider="Open-Meteo",
        place="London",
    )
    assert "no temperature" in sentence
    assert "no reading" in sentence


# ------------------------------------------------------------------ what changed


def test_a_first_evaluation_has_nothing_to_differ_from() -> None:
    """ "Changed from nothing" is not a change; the watch's creation is already its own event."""
    assert (
        changes_between(
            previous=None,
            previous_state=None,
            current=outcome(value=26.3, met=True, margin=1.3),
            current_state=WatchState.MET,
            place="London",
        )
        == ()
    )


def test_a_condition_becoming_met_is_recorded_as_that_and_not_as_a_generic_change() -> None:
    changes = changes_between(
        previous=outcome(value=24.0, met=False, margin=-1.0),
        previous_state=WatchState.NOT_MET,
        current=outcome(value=26.3, met=True, margin=1.3),
        current_state=WatchState.MET,
        place="London",
    )
    kinds = [change.kind for change in changes]
    assert kinds[0] == "condition_met"
    assert changes[0].previous_state is WatchState.NOT_MET
    assert changes[0].new_state is WatchState.MET


def test_a_condition_clearing_is_its_own_kind() -> None:
    changes = changes_between(
        previous=outcome(value=26.3, met=True, margin=1.3),
        previous_state=WatchState.MET,
        current=outcome(value=23.0, met=False, margin=-2.0),
        current_state=WatchState.NOT_MET,
        place="London",
    )
    assert changes[0].kind == "condition_cleared"


def test_losing_and_recovering_a_reading_are_both_events() -> None:
    lost = changes_between(
        previous=outcome(value=26.3, met=True),
        previous_state=WatchState.NOT_MET,
        current=outcome(),
        current_state=WatchState.DEGRADED,
        place="London",
    )
    assert lost[0].kind == "reading_lost"

    recovered = changes_between(
        previous=outcome(),
        previous_state=WatchState.DEGRADED,
        current=outcome(value=22.0, met=False),
        current_state=WatchState.NOT_MET,
        place="London",
    )
    assert recovered[0].kind == "reading_recovered"


def test_an_unchanged_state_records_no_transition() -> None:
    """The evaluator writes transitions, so a repeated state must not write the same event twice."""
    changes = changes_between(
        previous=outcome(value=26.3, met=True),
        previous_state=WatchState.MET,
        current=outcome(value=26.4, met=True),
        current_state=WatchState.MET,
        place="London",
    )
    assert [change.kind for change in changes] == [], (
        "0.1 °C is under the floor, and the state did not move: there is nothing to report"
    )


def test_a_movement_under_the_floor_is_the_model_landing_a_hair_away() -> None:
    """An activity feed that reported every re-run would bury the transitions that matter."""
    assert (
        changes_between(
            previous=outcome(value=26.3, met=True),
            previous_state=WatchState.MET,
            current=outcome(value=26.6, met=True),
            current_state=WatchState.MET,
            place="London",
        )
        == ()
    )


def test_a_movement_past_the_floor_is_reported_with_its_signed_size() -> None:
    changes = changes_between(
        previous=outcome(value=22.0, met=False),
        previous_state=WatchState.NOT_MET,
        current=outcome(value=24.5, met=False),
        current_state=WatchState.NOT_MET,
        place="London",
    )
    assert len(changes) == 1
    assert changes[0].kind == "reading_moved"
    assert changes[0].delta == pytest.approx(2.5)
    assert "+2.5 °C" in changes[0].summary


def test_a_crossing_that_moves_by_less_than_an_hour_is_the_same_hour_twice() -> None:
    """An hourly series cannot resolve anything finer, so nothing under an hour is a movement."""
    before = outcome(
        value=22.0,
        crossing={"at_utc": START, "at_local": START, "value": 26.0},
    )
    after = outcome(
        value=22.0,
        crossing={"at_utc": START, "at_local": START, "value": 26.2},
    )
    assert [
        change.kind
        for change in changes_between(
            previous=before,
            previous_state=WatchState.NOT_MET,
            current=after,
            current_state=WatchState.NOT_MET,
            place="London",
        )
    ] == []


def test_a_crossing_moving_earlier_says_so_and_by_how_much() -> None:
    later = START + timedelta(hours=5)
    before = outcome(value=22.0, crossing={"at_utc": later, "at_local": later, "value": 26.0})
    after = outcome(value=22.0, crossing={"at_utc": START, "at_local": START, "value": 26.0})

    changes = changes_between(
        previous=before,
        previous_state=WatchState.NOT_MET,
        current=after,
        current_state=WatchState.NOT_MET,
        place="London",
    )
    moved = next(change for change in changes if change.kind == "crossing_moved")
    assert "5 hours earlier" in moved.summary
    assert moved.delta == pytest.approx(-5.0)


def test_a_window_that_starts_or_stops_crossing_is_reported_either_way() -> None:
    appeared = changes_between(
        previous=outcome(value=22.0),
        previous_state=WatchState.NOT_MET,
        current=outcome(value=22.0, crossing={"at_utc": START, "at_local": START, "value": 26.0}),
        current_state=WatchState.NOT_MET,
        place="London",
    )
    assert any(change.kind == "crossing_appeared" for change in appeared)

    cleared = changes_between(
        previous=outcome(value=22.0, crossing={"at_utc": START, "at_local": START, "value": 26.0}),
        previous_state=WatchState.NOT_MET,
        current=outcome(value=22.0),
        current_state=WatchState.NOT_MET,
        place="London",
    )
    assert any(change.kind == "crossing_cleared" for change in cleared)
