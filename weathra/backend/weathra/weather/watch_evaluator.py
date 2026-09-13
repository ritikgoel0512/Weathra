"""Checking watches against a retrieved forecast — the one routine both callers use.

Two things evaluate watches: the request path, when one is created or somebody presses refresh, and
the scheduled pass, which reaches everybody's. They must agree about what a check *is*, or the
state a person sees after pressing refresh would differ from the state the schedule recorded an hour
earlier, for reasons nobody could explain. So the work lives here once and neither caller
reimplements it.

**One retrieval per place, not one per watch.** Watches are grouped by their resolved place before
anything is fetched. Three watches on London — temperature, wind, humidity — are three comparisons
against one series, and a pass that fetched three times would cost three times as much to learn
exactly the same thing. This is the single most important property of the scheduled pass, because it
is what decides whether monitoring scales with places or with watches.

**A failed retrieval is recorded, not skipped.** If the provider cannot be reached, every watch at
that place is written as `degraded` with the reason attached. A pass that silently skipped them
would leave yesterday's state on screen looking current, which is the specific way a monitoring
product lies.

**Nothing here claims to be live.** What is produced is a statement about the instant the series was
retrieved, and that instant travels with it into the evaluation row.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from weathra.analytics.watch import HEADLINE, WatchOutcome, conditions_at, outcome_for
from weathra.domain.errors import WeathraError
from weathra.domain.location import Location, location_identifier
from weathra.domain.weather import Forecast, UnitSystem
from weathra.memory.watch_monitoring import (
    WatchEvaluationRecord,
    WatchEventRecord,
    WatchEvidence,
    record_evaluation,
)
from weathra.memory.watches import WatchRecord
from weathra.weather.forecast_service import ForecastService

__all__ = ["WATCH_WINDOW_DAYS", "evaluate_watches", "group_by_place"]

logger = logging.getLogger("weathra.weather.watch")

# How much of the forecast a watch is evaluated against.
#
# The reading itself is the first reported hour, which one day would serve. Two days is what the
# *threshold crossing* needs: "the first hour past your threshold" is only a useful answer if the
# window is long enough to contain one, and a watch whose condition is met tomorrow morning should
# say so rather than reporting no crossing because the window ended at midnight.
WATCH_WINDOW_DAYS = 2


def group_by_place(
    watches: Sequence[tuple[str, WatchRecord]],
) -> dict[str, list[tuple[str, WatchRecord]]]:
    """Watches keyed by the place they are about, so one retrieval can serve all of them.

    Keyed on the rounded identifier the rest of the system uses for a place rather than on raw
    coordinates: two watches created from "London" and from "london, england" resolve to the same
    place and must share a retrieval, and float equality would not see that.
    """
    grouped: dict[str, list[tuple[str, WatchRecord]]] = defaultdict(list)
    for owner, watch in watches:
        grouped[location_identifier(watch.location.latitude, watch.location.longitude)].append(
            (owner, watch)
        )
    return dict(grouped)


async def evaluate_watches(
    session: AsyncSession,
    *,
    watches: Sequence[tuple[str, WatchRecord]],
    forecasts: ForecastService,
    cadence: timedelta | None = None,
    now: datetime | None = None,
) -> tuple[tuple[WatchRecord, WatchEvaluationRecord, tuple[WatchEventRecord, ...]], ...]:
    """Evaluate every watch given, one provider call per place, and persist what was found.

    Returns what each watch became, in the order the watches were given. A caller that wants one
    watch passes one watch; the scheduled pass passes everybody's.
    """
    moment = now or datetime.now(UTC)
    results: dict[str, tuple[WatchRecord, WatchEvaluationRecord, tuple[WatchEventRecord, ...]]] = {}

    for group in group_by_place(watches).values():
        retrieved, failure = await _retrieve(forecasts, group[0][1].location)

        for owner, watch in group:
            evidence, error = _evidence(watch, retrieved, failure)
            results[watch.id] = await record_evaluation(
                session,
                user_id=owner,
                watch=watch,
                evidence=evidence,
                place=_place_of(watch),
                evaluated_at=moment,
                provider=None if retrieved is None else retrieved.provider,
                retrieved_at=None if retrieved is None else retrieved.retrieved_at,
                error=error,
                next_evaluation_at=None if cadence is None else moment + cadence,
            )

    return tuple(results[watch.id] for _, watch in watches if watch.id in results)


async def _retrieve(
    forecasts: ForecastService, location: Location
) -> tuple[Forecast | None, str | None]:
    """One place's forecast, or the reason there is none.

    The failure is caught rather than raised because this routine's contract is that every watch
    gets a row. A provider outage is a fact to record about Weathra; letting it propagate would
    abandon the remaining places in the same pass for a reason that has nothing to do with them.
    """
    try:
        return (
            await forecasts.forecast(
                location, days=WATCH_WINDOW_DAYS, unit_system=UnitSystem.METRIC
            ),
            None,
        )
    except WeathraError as exc:
        logger.warning("watch retrieval failed for %s: %s", location.display_name, exc)
        return None, str(exc)
    except Exception as exc:  # an unexpected failure is still a degraded watch, not a crash
        logger.exception("watch retrieval raised for %s", location.display_name)
        return None, f"{type(exc).__name__} while retrieving the forecast"


def _evidence(
    watch: WatchRecord, retrieved: Forecast | None, failure: str | None
) -> tuple[WatchEvidence, str | None]:
    """What one watch concluded, or an empty conclusion carrying why there is none.

    A degraded pass still produces a row, and the row still carries the threshold and direction it
    was checking — so a screen can say "we could not check this" about a specific question rather
    than going blank.
    """
    empty = WatchOutcome(
        measure=watch.measure,
        comparison=watch.comparison,
        threshold=watch.threshold,
        unit=watch.last_unit,
    )
    if retrieved is None:
        return WatchEvidence(outcome=empty), failure or "The forecast could not be retrieved."

    outcome = outcome_for(
        retrieved.hourly,
        measure=watch.measure,
        comparison=watch.comparison,
        threshold=watch.threshold,
    )
    return (
        WatchEvidence(
            outcome=outcome,
            conditions=conditions_at(retrieved.hourly, outcome.matched_at_utc),
            units={
                measure: unit
                for measure in HEADLINE
                if (unit := retrieved.hourly.units.get(measure)) is not None
            },
        ),
        None,
    )


def _place_of(watch: WatchRecord) -> str:
    """What a sentence about this watch calls the place: its label, or the place's own name."""
    return (watch.label or "").strip() or watch.location.display_name
