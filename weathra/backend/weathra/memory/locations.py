"""Saved locations: canonical, de-duplicated, and bounded.

Three things ``specs/memory`` asks for, each of which is a decision about *what is stored* rather
than about the CRUD around it:

**Canonical, not the query text.** A saved location holds the resolved ``Location`` — name,
coordinates, timezone — so listing it never needs the geocoder. Storing "berlin" would mean a saved
location could silently change meaning when the geocoder's ranking changed, or stop working when it
was unavailable.

**One entry per place, not per spelling.** The uniqueness key is the coordinate-derived
``Location.identifier``, so "Berlin", "berlin", and "Berlin, DE" are the same saved location.
Saving the same place twice updates the label and leaves the list one entry long, which is what
"saving the same location twice SHALL NOT create a duplicate" means for a person who typed it
differently the second time.

**A limit that says what it is.** ``SavedLocationLimitReached`` carries the number in its message
and its details, because "you have too many" without the number leaves the person guessing how many
to remove.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.models import SavedLocation
from weathra.domain.errors import RecordNotFound, SavedLocationLimitReached
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.memory.availability import reporting_unavailable

__all__ = ["SavedLocationRecord", "SavedLocationStore"]

logger = logging.getLogger("weathra.memory.locations")


class SavedLocationRecord(BaseModel):
    """One saved location as a caller sees it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    location: Location = Field(description="The canonical resolved location.")
    label: str | None = Field(default=None, description="The person's own name for it, if any.")
    created_now: bool = Field(
        default=False,
        description="Whether this save created the entry or matched one already there.",
    )

    @property
    def location_id(self) -> str:
        return self.location.identifier


class SavedLocationStore:
    """Saved-location reads and writes, scoped to one authenticated user."""

    __slots__ = ("_principal", "_session", "_settings")

    def __init__(self, session: AsyncSession, principal: Principal, settings: Settings) -> None:
        self._session = session
        self._principal = principal
        self._settings = settings

    @property
    def limit(self) -> int:
        return self._settings.saved_locations_limit

    # ---------------------------------------------------------------- reads

    async def list(self) -> tuple[SavedLocationRecord, ...]:
        """The acting user's saved locations, oldest first, and nobody else's.

        The id is a tiebreaker rather than decoration: ``created_at`` defaults to ``now()``, the
        *transaction* timestamp, so two rows written in one transaction share it exactly. One save
        per request means that does not arise in practice, but an unordered tail would make the
        list flicker between requests if it ever did.
        """
        async with reporting_unavailable("saved_locations"):
            rows = (
                await self._session.execute(
                    select(SavedLocation)
                    .where(SavedLocation.user_id == self._principal.user_id)
                    .order_by(SavedLocation.created_at, SavedLocation.id)
                )
            ).scalars()
        return tuple(_as_record(row) for row in rows)

    async def count(self) -> int:
        async with reporting_unavailable("saved_locations"):
            found = await self._session.scalar(
                select(func.count())
                .select_from(SavedLocation)
                .where(SavedLocation.user_id == self._principal.user_id)
            )
        return int(found or 0)

    # ---------------------------------------------------------------- writes

    async def save(self, location: Location, *, label: str | None = None) -> SavedLocationRecord:
        """Save a resolved location, or update the label on the one already saved for that place.

        The limit is checked before the insert but only for a place that is *not* already saved: a
        person at the limit must still be able to relabel what they have, and refusing that would
        make the limit feel like a lock rather than a bound.
        """
        cleaned = label.strip()[:200] if label and label.strip() else None
        identifier = location.identifier

        async with reporting_unavailable("saved_locations"):
            existing = await self._session.scalar(
                select(SavedLocation.id).where(
                    SavedLocation.user_id == self._principal.user_id,
                    SavedLocation.location_id == identifier,
                )
            )

        if existing is None and await self.count() >= self.limit:
            raise SavedLocationLimitReached(
                f"You can save up to {self.limit} locations. Remove one before saving another.",
                details={"limit": self.limit, "saved": await self.count()},
            )

        # ON CONFLICT on (user_id, location_id) — the constraint, not a prior read, is what makes
        # the second save of a place an update instead of a duplicate. A check-then-insert would
        # let two concurrent saves of the same place both pass the check.
        async with reporting_unavailable("saved_locations"):
            row = (
                await self._session.execute(
                    pg_insert(SavedLocation)
                    .values(
                        user_id=self._principal.user_id,
                        location_id=identifier,
                        label=cleaned,
                        location=location.model_dump(mode="json"),
                    )
                    .on_conflict_do_update(
                        index_elements=[SavedLocation.user_id, SavedLocation.location_id],
                        set_={"label": cleaned, "location": location.model_dump(mode="json")},
                    )
                    .returning(SavedLocation)
                )
            ).scalar_one()
            await self._session.flush()

        record = _as_record(row).model_copy(update={"created_now": existing is None})
        logger.info(
            "saved location %s for %s (%s)",
            identifier,
            self._principal,
            "new" if record.created_now else "already saved",
        )
        return record

    async def remove(self, saved_id: str) -> str:
        """Remove one of the acting user's saved locations, confirming which.

        ``RecordNotFound`` whether the row is absent or someone else's — the same rule the rest of
        the user-owned surface follows, so a probe cannot tell the two apart.
        """
        async with reporting_unavailable("saved_locations"):
            removed = (
                await self._session.execute(
                    delete(SavedLocation)
                    .where(
                        SavedLocation.id == saved_id,
                        SavedLocation.user_id == self._principal.user_id,
                    )
                    .returning(SavedLocation.id)
                )
            ).all()
        if not removed:
            raise RecordNotFound("No saved location with that identifier.")
        await self._session.flush()
        logger.info("saved location %s removed by %s", saved_id, self._principal)
        return saved_id

    async def remove_place(self, location: Location) -> str:
        """Remove by place rather than by row id, for a caller holding the location itself."""
        async with reporting_unavailable("saved_locations"):
            found = await self._session.scalar(
                select(SavedLocation.id).where(
                    SavedLocation.user_id == self._principal.user_id,
                    SavedLocation.location_id == location.identifier,
                )
            )
        if found is None:
            raise RecordNotFound("No saved location with that identifier.")
        return await self.remove(found)


def _as_record(row: SavedLocation) -> SavedLocationRecord:
    return SavedLocationRecord(
        id=row.id, location=Location.model_validate(row.location), label=row.label
    )
