"""Conversation threads: the ownership gate, and the projection a follow-up resolves against.

Two jobs, both from design.md decision 11.

**The gate.** ``ThreadStore.open`` is what makes a thread the acting user's or nothing at all. It
runs *before the graph is invoked*, so a caller presenting someone else's thread id is refused
without the checkpointer ever being consulted — and refused as ``ThreadNotFound``, identical to a
thread that never existed, because "exists but is not yours" is itself a disclosure
(``specs/memory``, ``specs/authentication``). Row Level Security on ``threads`` is the second gate
behind this one, not a substitute for it.

**The projection.** ``ResolvedEntities`` is the explicit, queryable answer to "what could a
follow-up be referring to": the locations in play, the units, the window, the criterion, and the
last data class. It is deliberately *not* reconstructed by replaying a checkpoint — that would
couple follow-up resolution to LangGraph's internals, and the scenarios in ``specs/memory`` ("which
one is warmer tomorrow?", "what about precipitation?") need a small, stable shape instead.

**An unresolved reference is an answer.** ``resolve_reference`` returns a
``Reference`` that says *unresolved* rather than guessing at the most recent location. A guess that
happens to be right teaches a caller to trust one that is wrong.

**Only what a follow-up needs is stored.** ``specs/memory`` limits the stored representation to
the turn text, the resolved entities, and the evidence references. ``TurnRecord`` is that list and
nothing else, and ``ResolvedEntities`` forbids extra fields so a new one has to be added
deliberately rather than by a caller passing a dict through.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.models import Thread
from weathra.domain.comparison import Criterion
from weathra.domain.errors import ThreadNotFound
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, UnitSystem
from weathra.memory.availability import reporting_unavailable

__all__ = [
    "MAX_REMEMBERED_LOCATIONS",
    "MAX_REMEMBERED_TURNS",
    "Reference",
    "ResolvedEntities",
    "ThreadRecord",
    "ThreadStore",
    "TurnRecord",
    "WindowMemory",
]

logger = logging.getLogger("weathra.memory.threads")

# Bounds on the projection, not on the conversation. A thread that has discussed forty cities does
# not need all forty to resolve "which one is warmer" — and an unbounded JSONB column is a row that
# grows without limit for as long as the retention window allows.
MAX_REMEMBERED_LOCATIONS = 8
MAX_REMEMBERED_TURNS = 12


class WindowMemory(BaseModel):
    """The window a turn used, in the terms a follow-up would repeat it in.

    Stored as the *request* — "the next 3 days" — rather than as resolved UTC bounds, because that
    is what "what about precipitation?" means: the same question over the same window, resolved
    afresh against the location's own clock rather than against yesterday's instants.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: str = Field(min_length=1, description="'forecast_days', 'date_range', or 'current'.")
    days: int | None = Field(default=None, ge=1, description="For a forecast horizon.")
    start_date: str | None = Field(default=None, description="ISO date, for a historical range.")
    end_date: str | None = None
    label: str | None = Field(default=None, description="How it was said, for the UI to echo.")


class TurnRecord(BaseModel):
    """One turn, reduced to what follow-up resolution and evidence display need.

    Nothing else: no tool payloads, no model output beyond the answer text, no headers. The
    stored-content scenario in ``specs/memory`` is asserted against exactly this field list.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    role: str = Field(pattern="^(user|assistant)$")
    text: str = Field(description="What was asked or answered.")
    at: datetime = Field(description="When, in UTC.")
    evidence_id: str | None = Field(
        default=None, description="A reference to the evidence record, never a copy of it."
    )
    data_class: DataClass | None = None


class ResolvedEntities(BaseModel):
    """What a follow-up may refer to. The projection, not a replay of graph state."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    locations: tuple[Location, ...] = Field(
        default=(), description="Canonical, so a follow-up needs no re-resolution."
    )
    unit_system: UnitSystem | None = None
    window: WindowMemory | None = None
    criterion: Criterion | None = None
    last_data_class: DataClass | None = None
    turns: tuple[TurnRecord, ...] = Field(
        default=(), description="The bounded turn history, oldest first."
    )

    @field_validator("locations")
    @classmethod
    def _bound_locations(cls, value: tuple[Location, ...]) -> tuple[Location, ...]:
        return value[-MAX_REMEMBERED_LOCATIONS:]

    @field_validator("turns")
    @classmethod
    def _bound_turns(cls, value: tuple[TurnRecord, ...]) -> tuple[TurnRecord, ...]:
        return value[-MAX_REMEMBERED_TURNS:]

    # ---------------------------------------------------------------- reading

    @property
    def location_identifiers(self) -> tuple[str, ...]:
        return tuple(location.identifier for location in self.locations)

    def location_named(self, name: str) -> Location | None:
        """A remembered location matched by name, case- and qualifier-insensitively.

        Matches the display name or the qualified name, and nothing looser: a follow-up naming
        "Berlin" should find Berlin, and one naming "Berkeley" should find nothing rather than the
        nearest string.
        """
        wanted = name.strip().casefold()
        if not wanted:
            return None
        for location in reversed(self.locations):
            if wanted in (location.display_name.casefold(), location.qualified_name.casefold()):
                return location
        return None

    # ---------------------------------------------------------------- writing

    def with_locations(self, locations: Sequence[Location]) -> Self:
        """The projection with these locations recorded, most recent last, no duplicates.

        Replacing rather than appending when the same places come back keeps "which two cities did
        we just compare" answerable: a repeated pair should not push the pair before it out.
        """
        merged: list[Location] = [
            existing
            for existing in self.locations
            if all(not existing.is_same_place(new) for new in locations)
        ]
        merged.extend(locations)
        return self.model_copy(update={"locations": tuple(merged[-MAX_REMEMBERED_LOCATIONS:])})

    def with_turn(self, turn: TurnRecord) -> Self:
        return self.model_copy(update={"turns": (*self.turns, turn)[-MAX_REMEMBERED_TURNS:]})

    def with_updates(self, **values: Any) -> Self:
        """A copy with the named fields replaced. Fields not named keep their value.

        The distinction matters for a follow-up: "what about precipitation?" changes the measure
        and must *not* clear the window or the locations.
        """
        supplied = {key: value for key, value in values.items() if value is not None}
        return self.model_copy(update=supplied) if supplied else self


class Reference(BaseModel):
    """The outcome of resolving a follow-up's reference. Possibly, honestly, nothing."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    resolved: bool
    what: str = Field(min_length=1, description="What was being looked for: 'location', 'window'.")
    locations: tuple[Location, ...] = ()
    unit_system: UnitSystem | None = None
    window: WindowMemory | None = None
    criterion: Criterion | None = None
    reason: str | None = Field(
        default=None, description="Set when unresolved, explaining what was missing."
    )

    @classmethod
    def missing(cls, what: str, reason: str) -> Self:
        return cls(resolved=False, what=what, reason=reason)


class ThreadRecord(BaseModel):
    """A thread as a caller sees it, with its owner already checked."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    user_id: str
    title: str | None
    entities: ResolvedEntities
    created_at: datetime
    last_activity_at: datetime
    expires_at: datetime

    def checkpoint_key(self, principal: Principal) -> str:
        """The composed checkpointer key, built from the *acting* principal.

        From the principal rather than from ``self.user_id`` on purpose: the two are equal only
        because the ownership check passed, and deriving the key from the row would mean a bug in
        that check silently produced a key into someone else's state.
        """
        return principal.thread_key(self.id)


class ThreadStore:
    """Thread reads and writes, scoped to one authenticated user.

    Constructed per request with the session and the principal, like every other user-owned
    accessor: there is no method here that takes a thread id without also having a principal.
    """

    __slots__ = ("_principal", "_session", "_settings")

    def __init__(self, session: AsyncSession, principal: Principal, settings: Settings) -> None:
        self._session = session
        self._principal = principal
        self._settings = settings

    # ---------------------------------------------------------------- creation

    async def create(
        self, *, title: str | None = None, entities: ResolvedEntities | None = None
    ) -> ThreadRecord:
        """Start a thread owned by the acting user.

        The owner is not a parameter. ``specs/memory`` requires the acting authenticated user to be
        recorded at creation, and a caller-supplied owner is exactly the thing that must not be
        able to override the token's subject.
        """
        now = datetime.now(UTC)
        thread = Thread(
            user_id=self._principal.user_id,
            title=title.strip()[:200] if title and title.strip() else None,
            resolved_entities=(entities or ResolvedEntities()).model_dump(mode="json"),
            expires_at=now + timedelta(days=self._settings.thread_retention_days),
        )
        self._session.add(thread)
        async with reporting_unavailable("threads"):
            await self._session.flush()
            await self._session.refresh(thread)
        logger.info("thread %s created for %s", thread.id, self._principal)
        return _as_record(thread)

    # ---------------------------------------------------------------- the gate

    async def open(self, thread_id: str) -> ThreadRecord:
        """One of the acting user's threads, or ``ThreadNotFound``.

        **This is the authorization gate for the whole agent surface.** Called before the graph is
        invoked, so a foreign thread id never reaches the checkpointer. The error is deliberately
        indistinguishable from a thread that does not exist.
        """
        found = await self.find(thread_id)
        if found is None:
            # Not logged with the id at info level, and never with the owner: a log that
            # distinguishes "someone else's" from "nonexistent" leaks what the response does not.
            raise ThreadNotFound("No conversation thread with that identifier.")
        return found

    async def find(self, thread_id: str) -> ThreadRecord | None:
        """The same read, returning ``None`` instead of raising."""
        async with reporting_unavailable("threads"):
            row = (
                await self._session.execute(
                    select(Thread).where(
                        Thread.id == thread_id, Thread.user_id == self._principal.user_id
                    )
                )
            ).scalar_one_or_none()
        return _as_record(row) if row is not None else None

    async def list(self, *, limit: int = 50) -> tuple[ThreadRecord, ...]:
        """The acting user's threads, most recently active first."""
        async with reporting_unavailable("threads"):
            rows = (
                await self._session.execute(
                    select(Thread)
                    .where(Thread.user_id == self._principal.user_id)
                    .order_by(Thread.last_activity_at.desc())
                    .limit(limit)
                )
            ).scalars()
        return tuple(_as_record(row) for row in rows)

    # ---------------------------------------------------------------- the projection

    async def record(
        self,
        thread_id: str,
        *,
        locations: Sequence[Location] | None = None,
        unit_system: UnitSystem | None = None,
        window: WindowMemory | None = None,
        criterion: Criterion | None = None,
        data_class: DataClass | None = None,
        turn: TurnRecord | None = None,
    ) -> ThreadRecord:
        """Record what a turn resolved, leaving everything it did not touch alone.

        Goes through ``open`` first: a write to a thread is as much an ownership decision as a read
        of one, and the update's own ``WHERE user_id`` is the second gate rather than the first.
        """
        current = await self.open(thread_id)

        entities = current.entities
        if locations:
            entities = entities.with_locations(locations)
        entities = entities.with_updates(
            unit_system=unit_system,
            window=window,
            criterion=criterion,
            last_data_class=data_class,
        )
        if turn is not None:
            entities = entities.with_turn(turn)

        async with reporting_unavailable("threads"):
            await self._session.execute(
                update(Thread)
                .where(Thread.id == thread_id, Thread.user_id == self._principal.user_id)
                .values(
                    resolved_entities=entities.model_dump(mode="json"),
                    last_activity_at=func.now(),
                )
            )
            await self._session.flush()

        return current.model_copy(update={"entities": entities})

    async def entities(self, thread_id: str) -> ResolvedEntities:
        """The projection of one of the acting user's threads."""
        return (await self.open(thread_id)).entities

    # ---------------------------------------------------------------- follow-up resolution

    async def resolve_reference(
        self, thread_id: str, *, what: str = "location", name: str | None = None
    ) -> Reference:
        """Resolve a follow-up's reference against the thread, or report it unresolved.

        Never a guess. ``specs/memory``: "memory reports the reference unresolved rather than
        returning a guess", which is what makes the resolved case worth trusting.
        """
        entities = await self.entities(thread_id)

        if what == "location":
            if name:
                matched = entities.location_named(name)
                if matched is None:
                    return Reference.missing(
                        "location",
                        f"No earlier turn in this conversation established a location named "
                        f"{name!r}.",
                    )
                return Reference(resolved=True, what="location", locations=(matched,))
            if not entities.locations:
                return Reference.missing(
                    "location", "No earlier turn in this conversation established a location."
                )
            return Reference(resolved=True, what="location", locations=entities.locations)

        if what == "window":
            if entities.window is None:
                return Reference.missing(
                    "window", "No earlier turn in this conversation established a time window."
                )
            return Reference(resolved=True, what="window", window=entities.window)

        if what == "unit_system":
            if entities.unit_system is None:
                return Reference.missing(
                    "unit_system", "No earlier turn in this conversation chose a unit system."
                )
            return Reference(resolved=True, what="unit_system", unit_system=entities.unit_system)

        if what == "criterion":
            if entities.criterion is None:
                return Reference.missing(
                    "criterion", "No earlier turn in this conversation established a criterion."
                )
            return Reference(resolved=True, what="criterion", criterion=entities.criterion)

        return Reference.missing(
            what, f"{what!r} is not something conversation memory keeps, so it cannot be recalled."
        )

    # ---------------------------------------------------------------- deletion

    async def delete(self, thread_id: str) -> str:
        """Delete one of the acting user's threads, confirming what was removed.

        Returns the thread id rather than nothing, because ``specs/memory`` requires the deletion
        to be *confirmed*. The checkpoints are removed by ``memory/retention.py``, which owns the
        checkpointer handle; this removes the row that is the gate, so the thread is unreachable
        the moment this commits either way.
        """
        record = await self.open(thread_id)
        async with reporting_unavailable("threads"):
            await self._session.delete(await self._session.get_one(Thread, record.id))
            await self._session.flush()
        logger.info("thread %s deleted on request by %s", thread_id, self._principal)
        return record.id


def _as_record(thread: Thread) -> ThreadRecord:
    return ThreadRecord(
        id=thread.id,
        user_id=thread.user_id,
        title=thread.title,
        entities=ResolvedEntities.model_validate(thread.resolved_entities or {}),
        created_at=thread.created_at,
        last_activity_at=thread.last_activity_at,
        expires_at=thread.expires_at,
    )
