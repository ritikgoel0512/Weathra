"""A watch's history: every check that happened, and every transition worth telling somebody about.

`memory/watches.py` holds the watch — the place, the measure, the number somebody typed, and what
the last pass concluded. This holds what happened *over time*, which is the half that turns a
threshold form into a monitored thing.

**Two tables, because they answer two different questions.** ``weather_watch_evaluations`` is every
check of any outcome, including the ones that failed, and it is what evidence is read from: "why is
this watch met" is answered by a specific retrieval at a specific moment, not by asking the provider
again now. ``weather_watch_events`` is only the *transitions*, which is the far smaller set a person
reads down an activity feed.

**The events are written, not derived.** Recomputing them at read time from the evaluation rows
would be possible and wrong twice over: the evaluator knows what the previous state was at the
moment it concluded the new one, and evaluations are subject to retention — a history that quietly
rewrote itself as old rows expired would be worse than no history.

**Owner-scoped, and the policy is what makes that true.** Both tables carry ``user_id`` denormalised
from the watch so their policies need no join; a policy that reaches another table to decide can be
defeated by that table's own. The scheduled evaluator reaches every user's watches, which is exactly
why it runs from a CI job under the privileged connection and not from the request path — the same
boundary retention sits behind, for the same reason.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.analytics.watch import (
    WatchChange,
    WatchOutcome,
    WatchState,
    changes_between,
    state_for,
)
from weathra.domain.identity import Principal
from weathra.domain.weather import Measure
from weathra.memory.watches import COLUMNS, WatchRecord, record_from, set_watch_state

__all__ = [
    "EVALUATION_COLUMNS",
    "EVENT_COLUMNS",
    "WatchEvaluationRecord",
    "WatchEventRecord",
    "WatchEvidence",
    "WatchHistory",
    "record_creation",
    "record_evaluation",
]

EVALUATION_COLUMNS = (
    "id, watch_id, evaluated_at, state, value, unit, threshold, comparison, condition_met, "
    "provider, retrieved_at, matched_at, evidence, error"
)

EVENT_COLUMNS = (
    "id, watch_id, occurred_at, event_type, previous_state, new_state, summary, delta, unit"
)


class WatchEvidence(BaseModel):
    """Everything the evaluation knew at the moment it concluded, as it was stored.

    The outcome is why the watch is in its state. The conditions beside it are what the same hour of
    the same retrieval said about the place generally, kept because a watched-location card wants
    "26.3 °C, 0 mm, 14 km/h" and re-fetching a series that has already been read to answer that
    would be a provider call to learn something Weathra had in hand and threw away.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    outcome: WatchOutcome
    conditions: dict[Measure, float] = Field(default_factory=dict)
    units: dict[Measure, str] = Field(default_factory=dict)


class WatchEvaluationRecord(BaseModel):
    """One check, exactly as it was written."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    watch_id: str
    evaluated_at: datetime
    state: WatchState
    value: float | None = None
    unit: str | None = None
    threshold: float
    comparison: str
    condition_met: bool | None = None
    provider: str | None = None
    retrieved_at: datetime | None = Field(
        default=None, description="When the provider data behind this check was retrieved."
    )
    matched_at: datetime | None = Field(
        default=None, description="The instant in the series the reading was taken from."
    )
    evidence: WatchEvidence | None = Field(
        default=None, description="The arithmetic that produced the state, as it was computed."
    )
    error: str | None = None

    @property
    def outcome(self) -> WatchOutcome | None:
        """The arithmetic alone, for the callers that want it without the conditions beside it."""
        return None if self.evidence is None else self.evidence.outcome


class WatchEventRecord(BaseModel):
    """One transition, as a person reads it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    watch_id: str
    occurred_at: datetime
    event_type: str
    previous_state: WatchState | None = None
    new_state: WatchState | None = None
    summary: str
    delta: float | None = None
    unit: str | None = None


class WatchHistory:
    """One person's evaluations and events, scoped by the session's own subject."""

    __slots__ = ("_principal", "_session")

    def __init__(self, session: AsyncSession, principal: Principal) -> None:
        self._session = session
        self._principal = principal

    async def latest_evaluations(self) -> dict[str, WatchEvaluationRecord]:
        """The most recent check of each watch, in one statement.

        ``DISTINCT ON`` rather than a correlated subquery per watch: the dashboard reads every
        watch's latest evaluation at once, and forty round trips to render one screen is how a
        monitoring page becomes the slowest thing in a product.
        """
        rows = await self._session.execute(
            text(
                f"SELECT DISTINCT ON (watch_id) {EVALUATION_COLUMNS} "
                "  FROM weather_watch_evaluations "
                " ORDER BY watch_id, evaluated_at DESC"
            )
        )
        return {str(row[1]): _evaluation(row) for row in rows}

    async def evaluations(
        self, watch_id: str, *, limit: int = 24
    ) -> tuple[WatchEvaluationRecord, ...]:
        """One watch's recent checks, newest first."""
        rows = await self._session.execute(
            text(
                f"SELECT {EVALUATION_COLUMNS} FROM weather_watch_evaluations "
                " WHERE watch_id = CAST(:watch AS uuid) "
                " ORDER BY evaluated_at DESC LIMIT :limit"
            ),
            {"watch": watch_id, "limit": limit},
        )
        return tuple(_evaluation(row) for row in rows)

    async def events(
        self, *, limit: int = 20, since: datetime | None = None
    ) -> tuple[WatchEventRecord, ...]:
        """Recent transitions across every watch this person owns, newest first."""
        rows = await self._session.execute(
            text(
                f"SELECT {EVENT_COLUMNS} FROM weather_watch_events "
                " WHERE (CAST(:since AS timestamptz) IS NULL OR occurred_at >= :since) "
                " ORDER BY occurred_at DESC, created_at DESC LIMIT :limit"
            ),
            {"limit": limit, "since": since},
        )
        return tuple(_event(row) for row in rows)

    async def count_events_since(self, since: datetime) -> int:
        """How many transitions happened in a window. The `changes detected` figure, and only that.

        Transitions rather than evaluations: a pass that found nothing new is not a change, and a
        counter that incremented on every scheduled check would report a number about the schedule
        rather than about the weather.
        """
        found = await self._session.scalar(
            text("SELECT count(*) FROM weather_watch_events WHERE occurred_at >= :since"),
            {"since": since},
        )
        return int(found or 0)


# ------------------------------------------------------------------ writing what a pass found


async def record_creation(
    session: AsyncSession, *, user_id: str, watch: WatchRecord, place: str, at: datetime
) -> WatchEventRecord:
    """The watch's first event. A feed whose earliest entry is an evaluation has no beginning."""
    return await _write_event(
        session,
        user_id=user_id,
        watch_id=watch.id,
        occurred_at=at,
        change=WatchChange(
            kind="watch_created",
            summary=(
                f"Watch created: {place} {watch.measure.value.replace('_', ' ')} "
                f"{watch.comparison} {watch.threshold:g}"
                f"{f' {watch.last_unit}' if watch.last_unit else ''}."
            ),
            new_state=WatchState.PENDING,
        ),
    )


async def record_evaluation(
    session: AsyncSession,
    *,
    user_id: str,
    watch: WatchRecord,
    evidence: WatchEvidence,
    place: str,
    evaluated_at: datetime,
    provider: str | None,
    retrieved_at: datetime | None,
    error: str | None = None,
    next_evaluation_at: datetime | None = None,
) -> tuple[WatchRecord, WatchEvaluationRecord, tuple[WatchEventRecord, ...]]:
    """Write one check: the evaluation row, the transitions it caused, and the watch's own state.

    All three in one transaction, because a screen that read the watch's state from one statement
    and its evidence from another could show a state no evaluation supports. The previous
    evaluation is read *before* the new one is written, so "what changed" compares two checks
    rather than a check against itself.
    """
    outcome = evidence.outcome
    previous = await _latest_evaluation(session, watch.id)
    new_state = state_for(
        enabled=watch.enabled,
        evaluated=True,
        met=outcome.met,
        degraded=error is not None,
    )

    changes = changes_between(
        previous=None if previous is None else previous.outcome,
        previous_state=None if previous is None else previous.state,
        current=outcome,
        current_state=new_state,
        place=place,
    )

    evaluation = await _write_evaluation(
        session,
        user_id=user_id,
        watch=watch,
        evidence=evidence,
        state=new_state,
        evaluated_at=evaluated_at,
        provider=provider,
        retrieved_at=retrieved_at,
        error=error,
    )

    events = tuple(
        [
            await _write_event(
                session,
                user_id=user_id,
                watch_id=watch.id,
                occurred_at=evaluated_at,
                change=change,
            )
            for change in changes
        ]
    )

    updated = await set_watch_state(
        session,
        watch.id,
        state=new_state,
        previous_state=None if previous is None else previous.state,
        evaluated_at=evaluated_at,
        value=outcome.value,
        unit=outcome.unit,
        met=outcome.met,
        error=error,
        next_evaluation_at=next_evaluation_at,
    )
    return updated, evaluation, events


async def due_watches(
    session: AsyncSession, *, not_evaluated_since: datetime | None = None
) -> tuple[tuple[str, WatchRecord], ...]:
    """Every enabled watch, across every user, that the schedule should reach on this pass.

    **Privileged callers only.** It reads rows belonging to everybody, which is the work the
    request-serving role must not be able to do — the same boundary retention sits behind.

    Ordered by place so the evaluator can group retrievals: two watches on the same city share one
    provider call, which is the difference between a pass that costs one request per watch and one
    that costs one per place.
    """
    rows = await session.execute(
        text(
            f"SELECT user_id, location_id, {COLUMNS} FROM weather_watches "
            " WHERE enabled "
            "   AND (CAST(:since AS timestamptz) IS NULL "
            "        OR last_evaluated_at IS NULL OR last_evaluated_at < :since) "
            " ORDER BY location_id, created_at"
        ),
        {"since": not_evaluated_since},
    )
    return tuple((str(row[0]), record_from(tuple(row)[2:])) for row in rows)


# ------------------------------------------------------------------ the statements themselves


async def _latest_evaluation(session: AsyncSession, watch_id: str) -> WatchEvaluationRecord | None:
    row = (
        await session.execute(
            text(
                f"SELECT {EVALUATION_COLUMNS} FROM weather_watch_evaluations "
                " WHERE watch_id = CAST(:watch AS uuid) "
                " ORDER BY evaluated_at DESC LIMIT 1"
            ),
            {"watch": watch_id},
        )
    ).first()
    return None if row is None else _evaluation(row)


async def _write_evaluation(
    session: AsyncSession,
    *,
    user_id: str,
    watch: WatchRecord,
    evidence: WatchEvidence,
    state: WatchState,
    evaluated_at: datetime,
    provider: str | None,
    retrieved_at: datetime | None,
    error: str | None,
) -> WatchEvaluationRecord:
    row = (
        await session.execute(
            text(
                "INSERT INTO weather_watch_evaluations "
                "  (id, watch_id, user_id, evaluated_at, state, value, unit, threshold, "
                "   comparison, condition_met, provider, retrieved_at, matched_at, evidence, "
                "   error) "
                "VALUES (CAST(:id AS uuid), CAST(:watch AS uuid), CAST(:user AS uuid), :at, "
                "        :state, :value, :unit, :threshold, :comparison, :met, :provider, "
                "        :retrieved, :matched, CAST(:evidence AS jsonb), :error) "
                f"RETURNING {EVALUATION_COLUMNS}"
            ),
            {
                "id": str(uuid.uuid4()),
                "watch": watch.id,
                "user": user_id,
                "at": evaluated_at,
                "state": state.value,
                "value": evidence.outcome.value,
                "unit": evidence.outcome.unit,
                "threshold": watch.threshold,
                "comparison": watch.comparison,
                "met": evidence.outcome.met,
                "provider": provider,
                "retrieved": retrieved_at,
                "matched": evidence.outcome.matched_at_utc,
                "evidence": evidence.model_dump_json(),
                "error": None if error is None else error[:200],
            },
        )
    ).first()
    assert row is not None  # an INSERT ... RETURNING either wrote a row or raised
    return _evaluation(row)


async def _write_event(
    session: AsyncSession,
    *,
    user_id: str,
    watch_id: str,
    occurred_at: datetime,
    change: WatchChange,
) -> WatchEventRecord:
    row = (
        await session.execute(
            text(
                "INSERT INTO weather_watch_events "
                "  (id, watch_id, user_id, occurred_at, event_type, previous_state, new_state, "
                "   summary, delta, unit) "
                "VALUES (CAST(:id AS uuid), CAST(:watch AS uuid), CAST(:user AS uuid), :at, "
                "        :kind, :previous, :new, :summary, :delta, :unit) "
                f"RETURNING {EVENT_COLUMNS}"
            ),
            {
                "id": str(uuid.uuid4()),
                "watch": watch_id,
                "user": user_id,
                "at": occurred_at,
                "kind": change.kind,
                "previous": None if change.previous_state is None else change.previous_state.value,
                "new": None if change.new_state is None else change.new_state.value,
                "summary": change.summary[:400],
                "delta": change.delta,
                "unit": change.unit,
            },
        )
    ).first()
    assert row is not None
    return _event(row)


def _evaluation(row: Row[Any]) -> WatchEvaluationRecord:
    values = tuple(row)
    stored = values[12]
    return WatchEvaluationRecord(
        id=str(values[0]),
        watch_id=str(values[1]),
        evaluated_at=values[2],
        state=WatchState(values[3]),
        value=None if values[4] is None else float(values[4]),
        unit=values[5],
        threshold=float(values[6]),
        comparison=values[7],
        condition_met=values[8],
        provider=values[9],
        retrieved_at=values[10],
        matched_at=values[11],
        # Written by this module and read straight back, but validated rather than trusted: a row
        # older than a change to `WatchOutcome` is a row this build cannot read, and a screen with
        # no evidence is a better outcome than one with a half-parsed dictionary in it.
        evidence=None
        if stored is None
        else WatchEvidence.model_validate(
            stored if isinstance(stored, dict) else json.loads(stored)
        ),
        error=values[13],
    )


def _event(row: Row[Any]) -> WatchEventRecord:
    values = tuple(row)
    return WatchEventRecord(
        id=str(values[0]),
        watch_id=str(values[1]),
        occurred_at=values[2],
        event_type=values[3],
        previous_state=None if values[4] is None else WatchState(values[4]),
        new_state=None if values[5] is None else WatchState(values[5]),
        summary=values[6],
        delta=None if values[7] is None else float(values[7]),
        unit=values[8],
    )
