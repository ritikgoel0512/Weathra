"""Weather watches: the conditions one person asked Weathra to check, and what it found.

Owner-scoped like every other store in this package — the session carries the acting subject and the
policy on ``weather_watches`` returns nothing to a query about anybody else, so a caller cannot read
or write another person's watch whatever identifier they supply.

**Evaluated on a schedule, and the record says when.** A watch is checked by the scheduled
evaluator (`memory/watch_monitoring.py`, invoked from a cron job), when it is created, and when
somebody presses refresh. What is stored is the *result of that check at that moment* —
`last_evaluated_at` beside `last_value`, `last_met` and `state`. The distinction between "the wind
is above your threshold" and "the wind was, when the schedule last reached it" is the whole honesty
of the feature, and it lives in those columns together. Nothing here claims a live feed.

**A null result is not a negative one.** Before the first evaluation there is no answer; where the
provider reported nothing for the measure there is still no answer. Neither is "the condition was
not met", and a boolean that collapsed all three would make a silent provider look like calm
weather.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.analytics.watch import WatchState, holds
from weathra.domain.errors import NotFound, ValidationFailed
from weathra.domain.identity import Principal
from weathra.domain.location import Location, location_identifier
from weathra.domain.weather import Measure

__all__ = [
    "COLUMNS",
    "WATCHABLE",
    "WatchRecord",
    "WatchStore",
    "evaluate_watch",
    "record_from",
    "set_watch_state",
]

# The measures a watch may name.
#
# Deliberately a short allowlist rather than "any measure the provider might send": a watch is a
# promise to check something, and promising to check a measure Open-Meteo does not report for a
# place would be a watch that could never do anything but stay null. Each of these is an
# instantaneous quantity the forecast series carries.
WATCHABLE: frozenset[Measure] = frozenset(
    {
        Measure.TEMPERATURE,
        Measure.APPARENT_TEMPERATURE,
        Measure.PRECIPITATION,
        Measure.PRECIPITATION_PROBABILITY,
        Measure.RELATIVE_HUMIDITY,
        Measure.WIND_SPEED,
        Measure.WIND_GUST,
    }
)

COMPARISONS: frozenset[str] = frozenset({"above", "below"})

# Every column a `WatchRecord` is built from, in the order `_record` reads them. One constant
# rather than five copies of the same list: a column added to the table and to four of the five
# statements is a bug that only shows up on whichever path was missed.
COLUMNS = (
    "id, location, label, measure, comparison, threshold, enabled, state, previous_state, "
    "last_evaluated_at, last_value, last_unit, last_met, last_error, next_evaluation_at, "
    "created_at, updated_at"
)


class WatchRecord(BaseModel):
    """One watch, as it is read back."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    location: Location
    label: str | None = None
    measure: Measure
    comparison: str
    threshold: float
    enabled: bool
    state: WatchState = Field(
        default=WatchState.PENDING,
        description="What the last evaluation concluded. `pending` until one has happened.",
    )
    previous_state: WatchState | None = Field(
        default=None, description="What it concluded the time before, so a transition is readable."
    )
    last_evaluated_at: datetime | None = None
    last_value: float | None = None
    last_unit: str | None = None
    last_met: bool | None = None
    last_error: str | None = Field(
        default=None, description="Why the last pass degraded. Null where it did not."
    )
    next_evaluation_at: datetime | None = Field(
        default=None, description="When the schedule is next expected to reach this watch."
    )
    created_at: datetime
    updated_at: datetime


def evaluate_watch(
    *, measure: Measure, comparison: str, threshold: float, value: float | None
) -> bool | None:
    """Whether the condition held. Pure, and null where there was nothing to compare.

    Delegates to `analytics/watch.py`, which is where every figure this product computes lives. The
    comparison is the same for every measure, so `measure` is named for the caller's clarity and
    discarded — a watch on wind and a watch on humidity are the same arithmetic.
    """
    del measure
    return holds(comparison=comparison, threshold=threshold, value=value)


class WatchStore:
    """One person's watches. Every statement is scoped to the session's own subject."""

    __slots__ = ("_principal", "_session")

    def __init__(self, session: AsyncSession, principal: Principal) -> None:
        self._session = session
        self._principal = principal

    @staticmethod
    def _check(measure: Measure, comparison: str) -> None:
        if measure not in WATCHABLE:
            raise ValidationFailed(
                f"Weathra cannot watch {measure.value!r}.",
                details={"field": "measure", "watchable": sorted(m.value for m in WATCHABLE)},
            )
        if comparison not in COMPARISONS:
            raise ValidationFailed(
                f"{comparison!r} is not a direction Weathra compares.",
                details={"field": "comparison", "known": sorted(COMPARISONS)},
            )

    async def list(self) -> tuple[WatchRecord, ...]:
        rows = await self._session.execute(
            text(f"SELECT {COLUMNS} FROM weather_watches ORDER BY created_at")
        )
        return tuple(record_from(row) for row in rows)

    async def get(self, watch_id: str) -> WatchRecord:
        """One watch of one's own. Not found and not yours are the same answer, deliberately."""
        row = (
            await self._session.execute(
                text(f"SELECT {COLUMNS} FROM weather_watches WHERE id = CAST(:id AS uuid)"),
                {"id": watch_id},
            )
        ).first()
        if row is None:
            raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})
        return record_from(row)

    async def create(
        self,
        *,
        location: Location,
        measure: Measure,
        comparison: str,
        threshold: float,
        label: str | None = None,
    ) -> WatchRecord:
        """Add a watch, or update the one already asking this question about this place.

        Upsert rather than refuse, for the same reason saving a location twice updates its label:
        asking the same question again is a person changing their threshold, not an error.

        **The stored location is refreshed too, and that is what repairs a badly-named row.** The
        conflict key is the *rounded point*, so the incoming row is the same place by definition —
        but its canonical name may be better than the one on file. A watch saved by coordinates
        alone is named after its own latitude and longitude, because Open-Meteo has no reverse
        geocoding and a point cannot be asked what it is called; re-stating that watch with the name
        beside the coordinates replaces the coordinate label with the real one. Without this line
        the only repair would be deleting the watch and its whole history.
        """
        self._check(measure, comparison)

        row = (
            await self._session.execute(
                text(
                    "INSERT INTO weather_watches "
                    "  (id, user_id, location_id, location, label, measure, comparison, threshold) "
                    "VALUES (CAST(:id AS uuid), CAST(:user AS uuid), :location_id, "
                    "        CAST(:location AS jsonb), :label, :measure, :comparison, :threshold) "
                    "ON CONFLICT (user_id, location_id, measure) DO UPDATE "
                    "   SET comparison = excluded.comparison, threshold = excluded.threshold, "
                    "       label = excluded.label, location = excluded.location, "
                    "       enabled = true, updated_at = now() "
                    f"RETURNING {COLUMNS}"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "user": self._principal.user_id,
                    "location_id": location_identifier(location.latitude, location.longitude),
                    "location": location.model_dump_json(),
                    "label": label,
                    "measure": measure.value,
                    "comparison": comparison,
                    "threshold": threshold,
                },
            )
        ).first()
        assert row is not None  # the insert either wrote a row or updated one
        return record_from(row)

    async def update(
        self,
        watch_id: str,
        *,
        comparison: str | None = None,
        threshold: float | None = None,
        label: str | None = None,
        enabled: bool | None = None,
    ) -> WatchRecord:
        """Change a watch of one's own. The policy is what makes "of one's own" true."""
        if comparison is not None and comparison not in COMPARISONS:
            raise ValidationFailed(
                f"{comparison!r} is not a direction Weathra compares.",
                details={"field": "comparison", "known": sorted(COMPARISONS)},
            )

        row = (
            await self._session.execute(
                text(
                    "UPDATE weather_watches SET "
                    "  comparison = COALESCE(:comparison, comparison), "
                    "  threshold = COALESCE(:threshold, threshold), "
                    "  label = COALESCE(:label, label), "
                    "  enabled = COALESCE(:enabled, enabled), "
                    "  updated_at = now() "
                    " WHERE id = CAST(:id AS uuid) "
                    f"RETURNING {COLUMNS}"
                ),
                {
                    "id": watch_id,
                    "comparison": comparison,
                    "threshold": threshold,
                    "label": label,
                    "enabled": enabled,
                },
            )
        ).first()
        if row is None:
            # Not found and not yours are the same answer, deliberately: distinguishing them would
            # let somebody discover which identifiers exist.
            raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})
        return record_from(row)

    async def delete(self, watch_id: str) -> None:
        deleted = await self._session.execute(
            text("DELETE FROM weather_watches WHERE id = CAST(:id AS uuid) RETURNING id"),
            {"id": watch_id},
        )
        if deleted.first() is None:
            raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})

    async def set_state(
        self,
        watch_id: str,
        *,
        state: WatchState,
        previous_state: WatchState | None,
        evaluated_at: datetime,
        value: float | None,
        unit: str | None,
        met: bool | None,
        error: str | None,
        next_evaluation_at: datetime | None,
    ) -> WatchRecord:
        """Write what a pass concluded onto the watch itself."""
        return await set_watch_state(
            self._session,
            watch_id,
            state=state,
            previous_state=previous_state,
            evaluated_at=evaluated_at,
            value=value,
            unit=unit,
            met=met,
            error=error,
            next_evaluation_at=next_evaluation_at,
        )


async def set_watch_state(
    session: AsyncSession,
    watch_id: str,
    *,
    state: WatchState,
    previous_state: WatchState | None,
    evaluated_at: datetime,
    value: float | None,
    unit: str | None,
    met: bool | None,
    error: str | None,
    next_evaluation_at: datetime | None,
) -> WatchRecord:
    """Write what a pass concluded onto the watch itself.

    A function rather than a method because the scheduled evaluator has a session and a watch id
    and no principal at all — it is not serving anybody's request — and inventing a subject for it
    to hold would put a fabricated identity into the one place identity has to be real. The
    session's own scoping is what makes this safe on the request path: under the restricted role the
    policy narrows the statement to the caller's own rows, and under the privileged connection the
    evaluator is deliberately reaching everybody's.

    The evaluation row is the history and this is the *current* reading of it — denormalised so a
    listing of forty watches is one statement rather than forty correlated subqueries. Both are
    written in the same transaction by `memory/watch_monitoring.py`, so they cannot disagree.
    """
    row = (
        await session.execute(
            text(
                "UPDATE weather_watches SET state = :state, previous_state = :previous, "
                "       last_evaluated_at = :at, last_value = :value, last_unit = :unit, "
                "       last_met = :met, last_error = :error, "
                "       next_evaluation_at = :next, updated_at = now() "
                " WHERE id = CAST(:id AS uuid) "
                f"RETURNING {COLUMNS}"
            ),
            {
                "id": watch_id,
                "state": state.value,
                "previous": None if previous_state is None else previous_state.value,
                "at": evaluated_at,
                "value": value,
                "unit": unit,
                "met": met,
                "error": error,
                "next": next_evaluation_at,
            },
        )
    ).first()
    if row is None:
        raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})
    return record_from(row)


def record_from(row: Sequence[Any]) -> WatchRecord:
    """One row, in `COLUMNS` order. Positional because `text()` returns tuples, not models.

    Takes a sequence rather than a `Row` so a caller that selected extra leading columns — the
    scheduled evaluator selects the owner beside the watch — can pass the tail without copying the
    column list into a second place.
    """
    values = tuple(row)
    enabled = bool(values[6])
    stored = values[7]
    # A disabled watch is not being checked, so whatever its last pass concluded is no longer a
    # statement about now. The stored state is kept in the row for when it is re-enabled; what is
    # *read back* is `paused`, which is the honest answer to "what is this watch doing".
    state = (
        WatchState.PAUSED if not enabled else WatchState(stored) if stored else WatchState.PENDING
    )
    return WatchRecord(
        id=str(values[0]),
        location=Location.model_validate(values[1]),
        label=values[2],
        measure=Measure(values[3]),
        comparison=values[4],
        threshold=float(values[5]),
        enabled=enabled,
        state=state,
        previous_state=None if values[8] is None else WatchState(values[8]),
        last_evaluated_at=values[9],
        last_value=None if values[10] is None else float(values[10]),
        last_unit=values[11],
        last_met=values[12],
        last_error=values[13],
        next_evaluation_at=values[14],
        created_at=values[15],
        updated_at=values[16],
    )


def now() -> datetime:
    """The moment an evaluation happened. One place, so tests can reason about it."""
    return datetime.now(UTC)
