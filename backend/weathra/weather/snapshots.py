"""Forecast snapshots, and What Changed?.

Snapshots are **shared and location-keyed, with no user reference at all** (design.md decision 5).
A forecast for Berlin is not private, and keying by location rather than by requester does two
things at once: it avoids storing a browsing trail, and it gives What Changed? far better coverage —
every person's request improves everyone's history. That is why ``forecast_snapshots`` is the one
table in the schema that deliberately has no ``user_id``.

**Capture never fails the retrieval it accompanies.** ``specs/forecast-analysis`` is explicit: a
storage failure is logged and the forecast is still returned. Catching the exception is not enough
to achieve that — a failed statement aborts the surrounding PostgreSQL transaction, so the
request's own commit would then fail even though the handler swallowed the error. So the insert
runs inside a **savepoint**: a failure rolls back only the savepoint and the request's transaction
survives intact. One connection, one transaction, and a bookkeeping write that genuinely cannot
take the request down with it.

**No prior snapshot is a first-class answer.** With opportunistic capture, a location nobody asked
about yesterday has nothing to compare against, and the honest response is to say so — not to
present today's forecast as though it were a change.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.analytics.support import insignificance_margin_for
from weathra.db.models import ForecastSnapshot
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Forecast, Measure, Period, Series, UnitSystem

__all__ = [
    "CHANGED_MEASURES",
    "DayChange",
    "SnapshotCaptureResult",
    "WhatChanged",
    "capture",
    "compare_with_previous",
]

logger = logging.getLogger("weathra.weather.snapshots")

# The measures What Changed? reports movement for. Temperature and precipitation are what
# ``specs/forecast-analysis`` names, and they are what a person actually replans around.
CHANGED_MEASURES: tuple[Measure, ...] = (
    Measure.TEMPERATURE_MAX,
    Measure.TEMPERATURE_MIN,
    Measure.PRECIPITATION_SUM,
)


class SnapshotCaptureResult(BaseModel):
    """Whether a snapshot was written, and why not when it was not.

    A result rather than an exception: the caller's job is to return the forecast either way.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    stored: bool
    snapshot_id: str | None = None
    reason: str | None = Field(
        default=None, description="Why the write did not happen. Logged as well as returned."
    )


class DayChange(BaseModel):
    """How one day's figures moved between two retrievals of the same window."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    local_date: str = Field(min_length=1, description="The local calendar date, ISO-8601.")
    measure: Measure
    unit: str
    previous: float | None
    current: float | None
    change: float | None = Field(
        default=None, description="Current minus previous. Null when either side is absent."
    )
    material: bool = Field(
        description="False when the movement is inside the measure's materiality margin."
    )
    statement: str = Field(min_length=1)


class WhatChanged(BaseModel):
    """How the forecast for a location and window has moved since the last earlier snapshot."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    period: Period
    provider: str = Field(min_length=1)
    unit_system: UnitSystem
    data_class: DataClass = DataClass.FORECAST
    comparison_available: bool
    previous_retrieved_at: datetime | None = None
    current_retrieved_at: datetime
    changes: tuple[DayChange, ...] = ()
    statement: str = Field(min_length=1)

    @property
    def material_changes(self) -> tuple[DayChange, ...]:
        return tuple(change for change in self.changes if change.material)


async def capture(session: AsyncSession, forecast: Forecast) -> SnapshotCaptureResult:
    """Record a snapshot of a retrieved forecast. Never raises.

    Called on each forecast retrieval, so What Changed? has something to compare against later.
    """
    snapshot = ForecastSnapshot(
        location_id=forecast.location.identifier,
        location=forecast.location.model_dump(mode="json"),
        window_start=forecast.period.start_utc,
        window_end=forecast.period.end_utc,
        provider=forecast.provider,
        unit_system=forecast.unit_system.value,
        retrieved_at=forecast.retrieved_at,
        daily_series=forecast.daily.model_dump(mode="json"),
    )
    try:
        # A savepoint, so a failed insert rolls back only this write. Without it the surrounding
        # transaction would be aborted and the request's commit would fail anyway.
        async with session.begin_nested():
            session.add(snapshot)
            await session.flush()
        return SnapshotCaptureResult(stored=True, snapshot_id=snapshot.id)
    except Exception as failure:
        # Deliberately broad. The contract is that the forecast is returned whatever happens here,
        # so every failure mode — a closed connection, a constraint, a serialization problem —
        # ends up logged and reported rather than raised.
        logger.warning(
            "snapshot capture failed for %s (%s): %s",
            forecast.location.identifier,
            forecast.provider,
            type(failure).__name__,
        )
        return SnapshotCaptureResult(
            stored=False, reason=f"snapshot storage failed ({type(failure).__name__})"
        )


async def previous_snapshot(session: AsyncSession, forecast: Forecast) -> ForecastSnapshot | None:
    """The most recent *earlier* snapshot of the same location, window, provider, and units.

    Strictly earlier: comparing a snapshot against itself would report no change and imply that
    the forecast had been checked twice.
    """
    statement = (
        select(ForecastSnapshot)
        .where(
            ForecastSnapshot.location_id == forecast.location.identifier,
            ForecastSnapshot.window_start == forecast.period.start_utc,
            ForecastSnapshot.window_end == forecast.period.end_utc,
            ForecastSnapshot.provider == forecast.provider,
            ForecastSnapshot.unit_system == forecast.unit_system.value,
            ForecastSnapshot.retrieved_at < forecast.retrieved_at,
        )
        .order_by(ForecastSnapshot.retrieved_at.desc())
        .limit(1)
    )
    return (await session.execute(statement)).scalar_one_or_none()


async def compare_with_previous(
    session: AsyncSession,
    forecast: Forecast,
    *,
    measures: tuple[Measure, ...] = CHANGED_MEASURES,
) -> WhatChanged:
    """How this forecast differs from the last earlier snapshot of the same window."""
    earlier = await previous_snapshot(session, forecast)

    if earlier is None:
        return WhatChanged(
            location=forecast.location,
            period=forecast.period,
            provider=forecast.provider,
            unit_system=forecast.unit_system,
            comparison_available=False,
            current_retrieved_at=forecast.retrieved_at,
            statement=(
                f"No earlier forecast is on record for {forecast.location.qualified_name} over "
                "this window, so there is nothing to compare against yet. This is the current "
                "forecast, not a change."
            ),
        )

    previous_series = Series.model_validate(earlier.daily_series)
    changes = _day_changes(previous_series, forecast.daily, measures)
    material = [change for change in changes if change.material]

    if material:
        summary = "; ".join(change.statement for change in material)
        statement = (
            f"Since {_readable(earlier.retrieved_at)}, the forecast for "
            f"{forecast.location.qualified_name} has moved: {summary}."
        )
    else:
        statement = (
            f"The forecast for {forecast.location.qualified_name} is unchanged since "
            f"{_readable(earlier.retrieved_at)}: every day's figures moved less than the "
            "materiality margin for their measure."
        )

    return WhatChanged(
        location=forecast.location,
        period=forecast.period,
        provider=forecast.provider,
        unit_system=forecast.unit_system,
        comparison_available=True,
        previous_retrieved_at=earlier.retrieved_at.replace(
            tzinfo=earlier.retrieved_at.tzinfo or UTC
        ),
        current_retrieved_at=forecast.retrieved_at,
        changes=changes,
        statement=statement,
    )


def _day_changes(
    previous: Series, current: Series, measures: tuple[Measure, ...]
) -> tuple[DayChange, ...]:
    """Per-day signed deltas, matched by local calendar date rather than by position.

    Matching by date rather than index matters: two retrievals of "the next 7 days" taken either
    side of local midnight cover overlapping but shifted windows, and comparing position 0 to
    position 0 would compare two different days.
    """
    previous_by_date = {entry.time_local.date(): entry for entry in previous.entries}

    changes: list[DayChange] = []
    for entry in current.entries:
        counterpart = previous_by_date.get(entry.time_local.date())
        if counterpart is None:
            continue

        for measure in measures:
            if measure not in current.units:
                continue
            before = counterpart.value(measure)
            after = entry.value(measure)
            unit = current.unit(measure) or ""
            margin = insignificance_margin_for(measure)
            day = entry.time_local.date().isoformat()

            if before is None or after is None:
                changes.append(
                    DayChange(
                        local_date=day,
                        measure=measure,
                        unit=unit,
                        previous=before,
                        current=after,
                        change=None,
                        material=False,
                        statement=(
                            f"{day}: {measure.value} cannot be compared — it is absent from "
                            f"{'the earlier' if before is None else 'the current'} forecast."
                        ),
                    )
                )
                continue

            change = after - before
            material = abs(change) >= margin
            if material:
                statement = f"{day} {measure.value} {change:+g} {unit} ({before:g} to {after:g})"
            else:
                statement = (
                    f"{day} {measure.value} unchanged "
                    f"(moved {change:+g} {unit}, inside the {margin:g} {unit} margin)"
                )

            changes.append(
                DayChange(
                    local_date=day,
                    measure=measure,
                    unit=unit,
                    previous=before,
                    current=after,
                    change=change,
                    material=material,
                    statement=statement,
                )
            )

    return tuple(changes)


def _readable(moment: datetime) -> str:
    aware = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return aware.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
