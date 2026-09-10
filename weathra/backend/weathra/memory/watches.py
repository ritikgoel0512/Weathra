"""Weather watches: the conditions one person asked Weathra to check, and what it found.

Owner-scoped like every other store in this package — the session carries the acting subject and the
policy on ``weather_watches`` returns nothing to a query about anybody else, so a caller cannot read
or write another person's watch whatever identifier they supply.

**Evaluated when asked, and the record says so.** There is no scheduler in this system. A watch is
checked when the screen is opened or when somebody presses refresh, and what is stored is the
*result of that check at that moment* — `last_evaluated_at` beside `last_value` and `last_met`. The
distinction between "the wind is above your threshold" and "the wind was, when you last looked" is
the whole honesty of the feature, and it lives in those three columns together.

**A null result is not a negative one.** Before the first evaluation there is no answer; where the
provider reported nothing for the measure there is still no answer. Neither is "the condition was
not met", and a boolean that collapsed all three would make a silent provider look like calm
weather.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.errors import NotFound, ValidationFailed
from weathra.domain.identity import Principal
from weathra.domain.location import Location, location_identifier
from weathra.domain.weather import Measure

__all__ = [
    "WATCHABLE",
    "WatchEvaluation",
    "WatchRecord",
    "WatchStore",
    "evaluate_watch",
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


class WatchEvaluation(BaseModel):
    """What one check found, at the moment it looked."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    evaluated_at: datetime
    value: float | None = Field(
        default=None, description="The reading. Null where the provider reported none."
    )
    met: bool | None = Field(
        default=None,
        description="Whether the condition held. Null where there was no reading to compare — "
        "which is not the same as the condition being unmet.",
    )
    unit: str | None = None


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
    last_evaluated_at: datetime | None = None
    last_value: float | None = None
    last_met: bool | None = None
    created_at: datetime
    updated_at: datetime


def evaluate_watch(
    *, measure: Measure, comparison: str, threshold: float, value: float | None
) -> bool | None:
    """Whether the condition held. Pure, and null where there was nothing to compare.

    No language model is involved and none could be: this is one comparison, and a model asked to
    perform it would be slower, more expensive and occasionally wrong.
    """
    del measure  # named for the caller's clarity; the comparison is the same for every measure
    if value is None:
        return None
    return value > threshold if comparison == "above" else value < threshold


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
            text(
                "SELECT id, location, label, measure, comparison, threshold, enabled, "
                "       last_evaluated_at, last_value, last_met, created_at, updated_at "
                "  FROM weather_watches ORDER BY created_at"
            )
        )
        return tuple(_record(row) for row in rows)

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
                    "       label = excluded.label, enabled = true, updated_at = now() "
                    "RETURNING id, location, label, measure, comparison, threshold, enabled, "
                    "          last_evaluated_at, last_value, last_met, created_at, updated_at"
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
        return _record(row)

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
                    "RETURNING id, location, label, measure, comparison, threshold, enabled, "
                    "          last_evaluated_at, last_value, last_met, created_at, updated_at"
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
        return _record(row)

    async def delete(self, watch_id: str) -> None:
        deleted = await self._session.execute(
            text("DELETE FROM weather_watches WHERE id = CAST(:id AS uuid) RETURNING id"),
            {"id": watch_id},
        )
        if deleted.first() is None:
            raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})

    async def record_evaluation(self, watch_id: str, evaluation: WatchEvaluation) -> WatchRecord:
        """Store what a check found. The moment is the store's, not the caller's clock."""
        row = (
            await self._session.execute(
                text(
                    "UPDATE weather_watches SET last_evaluated_at = :at, last_value = :value, "
                    "       last_met = :met, updated_at = now() "
                    " WHERE id = CAST(:id AS uuid) "
                    "RETURNING id, location, label, measure, comparison, threshold, enabled, "
                    "          last_evaluated_at, last_value, last_met, created_at, updated_at"
                ),
                {
                    "id": watch_id,
                    "at": evaluation.evaluated_at,
                    "value": evaluation.value,
                    "met": evaluation.met,
                },
            )
        ).first()
        if row is None:
            raise NotFound("No watch with that identifier.", details={"watch_id": watch_id})
        return _record(row)


def _record(row: Row[Any]) -> WatchRecord:
    values = tuple(row)
    location = values[1]
    return WatchRecord(
        id=str(values[0]),
        location=Location.model_validate(location),
        label=values[2],
        measure=Measure(values[3]),
        comparison=values[4],
        threshold=float(values[5]),
        enabled=bool(values[6]),
        last_evaluated_at=values[7],
        last_value=None if values[8] is None else float(values[8]),
        last_met=values[9],
        created_at=values[10],
        updated_at=values[11],
    )


def now() -> datetime:
    """The moment an evaluation happened. One place, so tests can reason about it."""
    return datetime.now(UTC)
