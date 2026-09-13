"""What a watch is in, and what changed since it was last looked at — arithmetic, and nothing more.

`specs/deterministic-analytics` puts every computed figure in this package, and a watch is a
computed figure like any other: one comparison against one number, the same answer every time, with
no I/O, no clock of its own and no language model. What makes it a *watch* rather than a reading is
only that somebody stated the threshold in advance.

**It monitors on a schedule and says so.** Nothing here claims a live feed. An evaluation is a
statement about one instant — the moment a provider series was retrieved and compared — and it is
recorded with that moment attached. The states below are named for what was found, not for what is
happening.

**A null is not a no, and it is not a failure either.** Three different things end a check without
an answer: the provider reported nothing for the measure (`NO_READING`), the retrieval itself did
not complete (`DEGRADED`), and the watch has never been checked (`PENDING`). Collapsing any of them
into "the condition was not met" would make a silent provider look like calm weather, which is the
one mistake a monitoring product must never make.

**No severity is derived.** The approved screen colours a watch by how alarming it is, and Weathra
has no rule that converts "3 °C above your threshold" into a severity — that is meteorology this
system does not do, and `specs/safety-grounding` keeps the severity claim behind the agent's
referral. A watch is met or it is not, and how far past the threshold it sits is printed as a
figure rather than translated into a word.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.weather import Measure, Series, SeriesEntry

__all__ = [
    "CHANGE_FLOOR",
    "HEADLINE",
    "WatchChange",
    "WatchCrossing",
    "WatchOutcome",
    "WatchState",
    "changes_between",
    "conditions_at",
    "crossing_in",
    "evidence_for",
    "holds",
    "outcome_for",
    "state_for",
]


class WatchState(StrEnum):
    """What a watch was in at its last evaluation.

    Six, because six different things are true of a watch and a screen that showed four of them
    would have to lie about the other two. `PAUSED` is a property of the watch rather than of a
    reading and therefore outranks everything else; `PENDING` means no evaluation exists yet.
    """

    MET = "met"
    NOT_MET = "not_met"
    NO_READING = "no_reading"
    DEGRADED = "degraded"
    PAUSED = "paused"
    PENDING = "pending"


# The smallest movement in each measure that is worth recording as a change.
#
# Below these a "change" is the provider re-running its model and landing a hair away, and an
# activity feed that reported every one of them would bury the transitions that matter. Each is
# roughly the precision the measure is read at rather than a statistical threshold — there is no
# distribution here to test against, and pretending otherwise would be the invented statistic this
# module exists without.
CHANGE_FLOOR: dict[Measure, float] = {
    Measure.TEMPERATURE: 0.5,
    Measure.APPARENT_TEMPERATURE: 0.5,
    Measure.PRECIPITATION: 0.2,
    Measure.PRECIPITATION_PROBABILITY: 5.0,
    Measure.RELATIVE_HUMIDITY: 3.0,
    Measure.WIND_SPEED: 2.0,
    Measure.WIND_GUST: 3.0,
}

# How far the first crossing must move before it is worth saying so. An hourly series cannot
# resolve anything finer, so anything under an hour is the same hour reported twice.
CROSSING_FLOOR = timedelta(hours=1)


def holds(*, comparison: str, threshold: float, value: float | None) -> bool | None:
    """Whether the condition held. Pure, and null where there was nothing to compare.

    One comparison. A language model asked to perform it would be slower, dearer and occasionally
    wrong, and there is no reading of "above" that needs interpreting.
    """
    if value is None:
        return None
    return value > threshold if comparison == "above" else value < threshold


def state_for(*, enabled: bool, evaluated: bool, met: bool | None, degraded: bool) -> WatchState:
    """The six states, resolved in the one order that makes each of them reachable.

    Paused first because a disabled watch is not being checked at all, so whatever its last reading
    said is no longer a statement about now. Then degraded, because a failed retrieval is a fact
    about Weathra rather than about the weather, and reporting it as "no reading" would blame the
    provider for our own outage.
    """
    if not enabled:
        return WatchState.PAUSED
    if not evaluated:
        return WatchState.PENDING
    if degraded:
        return WatchState.DEGRADED
    if met is None:
        return WatchState.NO_READING
    return WatchState.MET if met else WatchState.NOT_MET


class WatchCrossing(BaseModel):
    """The first instant in a retrieved window at which a condition holds, if any does."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    at_utc: datetime
    at_local: datetime
    value: float


class WatchOutcome(BaseModel):
    """One evaluation's arithmetic: what was read, whether it held, and by how much.

    `margin` is signed towards the condition — positive where the reading is on the watched side of
    the threshold, negative where it is not — so "1.3 above" and "1.3 below" are one number and a
    direction rather than two fields that can disagree.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    comparison: str
    threshold: float
    unit: str | None = None
    value: float | None = None
    met: bool | None = None
    margin: float | None = Field(
        default=None,
        description="Signed towards the condition: positive when the reading satisfies it.",
    )
    matched_at_utc: datetime | None = None
    matched_at_local: datetime | None = None
    peak: float | None = Field(
        default=None, description="The extreme the window reaches on the watched side."
    )
    crossing: WatchCrossing | None = None
    points_used: int = Field(default=0, ge=0)


def _reading(series: Series, measure: Measure) -> SeriesEntry | None:
    """The entry a watch is evaluated against: the first hour the provider reported the measure for.

    The first *reported* hour rather than the first hour, because a series that opens with a gap in
    one measure is a series with a gap, not a series with no reading — and the nearest thing an
    hourly forecast has to "now" is its first usable point.
    """
    for entry in series.entries:
        if entry.values.get(measure) is not None:
            return entry
    return None


def crossing_in(
    series: Series, *, measure: Measure, comparison: str, threshold: float
) -> WatchCrossing | None:
    """The first instant in the window at which the condition holds.

    A count of one hour out of a retrieved series, not a prediction of when something will happen:
    the series is the provider's, and what is reported is which of its instants is the first to sit
    past the number somebody typed.
    """
    for entry in series.entries:
        value = entry.values.get(measure)
        if value is None:
            continue
        if holds(comparison=comparison, threshold=threshold, value=value):
            return WatchCrossing(at_utc=entry.time_utc, at_local=entry.time_local, value=value)
    return None


def _peak(series: Series, *, measure: Measure, comparison: str) -> float | None:
    """The extreme the window reaches on the side the watch cares about."""
    values = [value for entry in series.entries if (value := entry.values.get(measure)) is not None]
    if not values:
        return None
    return max(values) if comparison == "above" else min(values)


def outcome_for(
    series: Series, *, measure: Measure, comparison: str, threshold: float
) -> WatchOutcome:
    """One evaluation, from one retrieved series. Every figure below is read or subtracted."""
    entry = _reading(series, measure)
    value = None if entry is None else entry.values.get(measure)
    met = holds(comparison=comparison, threshold=threshold, value=value)

    margin: float | None = None
    if value is not None:
        # Signed towards the condition, so a screen never has to pair a magnitude with a word.
        margin = value - threshold if comparison == "above" else threshold - value

    return WatchOutcome(
        measure=measure,
        comparison=comparison,
        threshold=threshold,
        unit=series.units.get(measure),
        value=value,
        met=met,
        margin=margin,
        matched_at_utc=None if entry is None else entry.time_utc,
        matched_at_local=None if entry is None else entry.time_local,
        peak=_peak(series, measure=measure, comparison=comparison),
        crossing=crossing_in(series, measure=measure, comparison=comparison, threshold=threshold),
        points_used=sum(1 for e in series.entries if e.values.get(measure) is not None),
    )


# ------------------------------------------------------------------ saying what was found


def _places(unit: str | None) -> int:
    """How many decimals a figure in this unit is read at. The same table the screens use."""
    key = (unit or "").strip().lower()
    if key in {"%", "mm", "cm", "°c", "°f", "km/h", "mph", "m/s", "kn", "hpa"}:
        return 1
    return 1


def _figure(value: float, unit: str | None) -> str:
    rendered = f"{round(value, _places(unit)):g}"
    return f"{rendered} {unit}" if unit else rendered


def evidence_for(outcome: WatchOutcome, *, provider: str | None, place: str) -> str:
    """One sentence explaining why the watch is where it is, built from the figures above.

    Deterministic and assembled, never generated. The endpoint's own contract refuses to spend
    somebody's model allowance on a comparison, and a sentence a model wrote about a threshold it
    did not evaluate would be the one place in this product where the prose could contradict the
    number printed beside it.
    """
    named = provider or "The provider"
    if outcome.value is None:
        return (
            f"{named} reported no {outcome.measure.value.replace('_', ' ')} for {place} in the "
            "retrieved window, so this watch has no reading to compare against its threshold."
        )

    when = (
        ""
        if outcome.matched_at_local is None
        else f" at {outcome.matched_at_local:%H:%M on %-d %B}"
    )
    reading = _figure(outcome.value, outcome.unit)
    threshold = _figure(outcome.threshold, outcome.unit)
    distance = _figure(abs(outcome.margin or 0.0), outcome.unit)
    side = "above" if (outcome.margin or 0.0) >= 0 else "below"
    if outcome.comparison == "below":
        side = "below" if (outcome.margin or 0.0) >= 0 else "above"

    verdict = "is met" if outcome.met else "is not met"
    return (
        f"The {place} {outcome.measure.value.replace('_', ' ')} watch {verdict}. {named} reports "
        f"{reading}{when}, {distance} {side} the {threshold} threshold."
    )


# ------------------------------------------------------------------ what changed


class WatchChange(BaseModel):
    """One difference between an evaluation and the one before it.

    `kind` is a stable identifier a screen branches on; `summary` is the sentence a person reads,
    assembled from the two figures it came from. Nothing here is a judgement about the weather.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: str
    summary: str
    previous_state: WatchState | None = None
    new_state: WatchState | None = None
    delta: float | None = None
    unit: str | None = None


def changes_between(
    *,
    previous: WatchOutcome | None,
    previous_state: WatchState | None,
    current: WatchOutcome,
    current_state: WatchState,
    place: str,
) -> tuple[WatchChange, ...]:
    """Every deterministic difference between two successive evaluations of one watch.

    A first evaluation has nothing to differ from and produces nothing — the watch's creation is
    already an event, and "changed from nothing" is not a change. Ordered most consequential first,
    because a screen showing three of them should show the three that matter.
    """
    if previous is None or previous_state is None:
        return ()

    changes: list[WatchChange] = []

    if current_state is not previous_state:
        changes.append(
            WatchChange(
                kind=_transition_kind(previous_state, current_state),
                summary=_transition_summary(previous_state, current_state, place),
                previous_state=previous_state,
                new_state=current_state,
            )
        )

    floor = CHANGE_FLOOR.get(current.measure, 0.0)
    if (
        previous.value is not None
        and current.value is not None
        and abs(current.value - previous.value) >= floor
    ):
        delta = current.value - previous.value
        changes.append(
            WatchChange(
                kind="reading_moved",
                summary=(
                    f"The watched {current.measure.value.replace('_', ' ')} moved "
                    f"{'+' if delta > 0 else '-'}{_figure(abs(delta), current.unit)} since the "
                    f"previous evaluation, to {_figure(current.value, current.unit)}."
                ),
                delta=delta,
                unit=current.unit,
            )
        )

    crossing = _crossing_change(previous, current)
    if crossing is not None:
        changes.append(crossing)

    return tuple(changes)


# The states in which Weathra has no answer, as opposed to an answer of "no".
_SILENT = frozenset({WatchState.NO_READING, WatchState.DEGRADED})


def _transition_kind(previous: WatchState, new: WatchState) -> str:
    """What to call a move between two states, in the order that keeps each name true.

    **Losing the reading is tested before the condition clearing, and the order is load-bearing.**
    A watch that was met and is now degraded has not *cleared* — nothing about the weather is known
    to have changed; we stopped being able to look. Reporting that as "condition cleared" is the
    precise lie this module exists to prevent, and it is the lie a reader would act on, because
    "cleared" is the word that means it is safe to stop paying attention.
    """
    if new in _SILENT:
        return "reading_lost"
    if previous in _SILENT:
        return "reading_recovered"
    if new is WatchState.MET:
        return "condition_met"
    if previous is WatchState.MET:
        return "condition_cleared"
    return "state_changed"


def _transition_summary(previous: WatchState, new: WatchState, place: str) -> str:
    words = {
        WatchState.MET: "met",
        WatchState.NOT_MET: "not met",
        WatchState.NO_READING: "without a reading",
        WatchState.DEGRADED: "unavailable",
        WatchState.PAUSED: "paused",
        WatchState.PENDING: "not yet checked",
    }
    return f"The {place} watch changed from {words[previous]} to {words[new]}."


def _crossing_change(previous: WatchOutcome, current: WatchOutcome) -> WatchChange | None:
    """Whether the first instant past the threshold moved, appeared or went away."""
    before, after = previous.crossing, current.crossing

    if before is None and after is not None:
        return WatchChange(
            kind="crossing_appeared",
            summary=(
                f"The retrieved window now crosses the threshold, first at "
                f"{after.at_local:%H:%M on %-d %B}."
            ),
        )
    if before is not None and after is None:
        return WatchChange(
            kind="crossing_cleared",
            summary="The retrieved window no longer crosses the threshold at any hour.",
        )
    if before is None or after is None:
        return None

    moved = after.at_utc - before.at_utc
    if abs(moved) < CROSSING_FLOOR:
        return None
    hours = abs(moved).total_seconds() / 3600
    return WatchChange(
        kind="crossing_moved",
        summary=(
            f"The first threshold crossing moved {hours:g} hour{'' if hours == 1 else 's'} "
            f"{'later' if moved > timedelta(0) else 'earlier'}, to "
            f"{after.at_local:%H:%M on %-d %B}."
        ),
        delta=moved.total_seconds() / 3600,
        unit="h",
    )


# The measures a watched place's card shows beside its watches. Not configurable and not the
# provider's whole list: these four are what "what is it like there" means, every one of them is
# reported by the hourly series a watch is already evaluated against, and reading them costs nothing
# because the series is in hand. A measure the provider did not report stays absent.
HEADLINE: tuple[Measure, ...] = (
    Measure.TEMPERATURE,
    Measure.PRECIPITATION,
    Measure.WIND_SPEED,
    Measure.RELATIVE_HUMIDITY,
)


def conditions_at(series: Series, at: datetime | None) -> dict[Measure, float]:
    """The headline measures at one instant of a retrieved series.

    Taken from the same hour the watch itself was read from, so a card saying "26.3 °C" and a watch
    saying "26.3 °C is above your threshold" are quoting one reading rather than two that happen to
    be close. Where the instant is not in the series — or there is none — the first reported hour
    stands in, which is the same hour `outcome_for` would have used.
    """
    entry = next((e for e in series.entries if e.time_utc == at), None) if at else None
    if entry is None:
        entry = series.entries[0] if series.entries else None
    if entry is None:
        return {}
    return {
        measure: value for measure in HEADLINE if (value := entry.values.get(measure)) is not None
    }


def distinct_locations(identifiers: Sequence[str]) -> int:
    """How many places a set of watches covers. One line, in one place, so two panels agree."""
    return len(set(identifiers))
