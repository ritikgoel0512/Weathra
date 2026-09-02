"""The durable preference store: explicitly chosen, never inferred, with defaults that admit it.

``specs/memory`` puts three constraints on this module, and each one shapes the code:

**Only explicit choices are persisted.** There is no ``observe`` method, no usage counter, and no
"most frequent location" write. Asking about Lisbon nine times leaves the preference table exactly
as it was; the only behavioural thing Weathra records about a person is the profile's last-seen
timestamp. That is why this module's write path takes a caller's stated choice and nothing else.

**Defaults are reported as defaults.** ``PreferenceView`` carries a ``sources`` map saying, per
field, whether the value came from the person or from Weathra's documented default. A response that
presented ``metric`` identically whether it was chosen or assumed would be telling the person they
had made a decision they never made — and would make "clear my preferences" look like it did
nothing.

**Deleting restores the defaults.** Deletion removes the row rather than blanking its columns, so
"unset" has one representation instead of two.

A note on the *shape* of a partial update. ``update`` distinguishes "not mentioned" from "set back
to the default", which a plain ``value | None`` cannot express. ``UNSET`` is the sentinel for the
first and ``None`` for the second, so ``update(unit_system=None)`` clears the unit preference while
``update(forecast_horizon_days=7)`` leaves it alone.
"""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.models import MAX_HORIZON_PREFERENCE_DAYS, Preference
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.availability import reporting_unavailable

__all__ = [
    "PREFERENCE_FIELDS",
    "UNSET",
    "PreferenceSource",
    "PreferenceStore",
    "PreferenceView",
    "Unset",
]

logger = logging.getLogger("weathra.memory.preferences")


class Unset(StrEnum):
    """The sentinel distinguishing "not mentioned" from "set back to the default"."""

    TOKEN = "__unset__"


UNSET: Final = Unset.TOKEN

# Every preference field, in one place, so the view, the update, and the deletion cannot disagree
# about what a preference *is*.
PREFERENCE_FIELDS: Final = ("unit_system", "forecast_horizon_days", "default_location")


class PreferenceSource(StrEnum):
    """Where a reported preference value came from. Half the point of the response."""

    CHOSEN = "chosen"
    DEFAULT = "default"


class PreferenceView(BaseModel):
    """The acting user's effective preferences, each labelled chosen or default."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    unit_system: UnitSystem
    forecast_horizon_days: int = Field(ge=1, le=MAX_HORIZON_PREFERENCE_DAYS)
    default_location: Location | None = None
    sources: dict[str, PreferenceSource] = Field(
        description="Per field: whether the person chose this value or Weathra assumed it."
    )

    @property
    def any_chosen(self) -> bool:
        """Whether the person has chosen anything at all, or is running entirely on defaults."""
        return any(source is PreferenceSource.CHOSEN for source in self.sources.values())

    def source_of(self, field: str) -> PreferenceSource:
        return self.sources[field]

    def is_default(self, field: str) -> bool:
        return self.sources[field] is PreferenceSource.DEFAULT


class PreferenceStore:
    """Preference reads and writes, scoped to one authenticated user.

    The user id is never a parameter: the row's primary key *is* the acting subject, so there is
    no call here that could name someone else's preferences (``specs/memory``).
    """

    __slots__ = ("_principal", "_session", "_settings")

    def __init__(self, session: AsyncSession, principal: Principal, settings: Settings) -> None:
        self._session = session
        self._principal = principal
        self._settings = settings

    # ---------------------------------------------------------------- documented defaults

    @property
    def defaults(self) -> PreferenceView:
        """What applies when nothing has been chosen. Configuration, not a constant.

        The documented defaults are the same deployment settings every other layer reads, so
        "metric unless a caller says otherwise" is one value rather than one per module.
        """
        return PreferenceView(
            unit_system=UnitSystem(self._settings.default_unit_system),
            forecast_horizon_days=self._settings.default_forecast_days,
            default_location=None,
            sources=dict.fromkeys(PREFERENCE_FIELDS, PreferenceSource.DEFAULT),
        )

    # ---------------------------------------------------------------- reads

    async def read(self) -> PreferenceView:
        """The acting user's effective preferences, with each value's origin stated."""
        async with reporting_unavailable("preferences"):
            row = (
                await self._session.execute(
                    select(Preference).where(Preference.user_id == self._principal.user_id)
                )
            ).scalar_one_or_none()

        if row is None:
            return self.defaults
        return self._view(row)

    async def has_chosen_anything(self) -> bool:
        """Whether a preference row exists at all. Used by the no-inference assertion."""
        async with reporting_unavailable("preferences"):
            found = await self._session.scalar(
                select(func.count())
                .select_from(Preference)
                .where(Preference.user_id == self._principal.user_id)
            )
        return bool(found)

    # ---------------------------------------------------------------- writes

    async def update(
        self,
        *,
        unit_system: UnitSystem | Literal[Unset.TOKEN] | None = UNSET,
        forecast_horizon_days: int | Literal[Unset.TOKEN] | None = UNSET,
        default_location: Location | Literal[Unset.TOKEN] | None = UNSET,
    ) -> PreferenceView:
        """Record explicit choices, leaving unmentioned fields as they were.

        Every argument here is a *stated* choice. Nothing on the request path calls this on a
        person's behalf: ``specs/memory`` forbids inferring a preference from behaviour, and the way
        to keep that true is for the only writer to be the endpoint a person's own click reaches.
        """
        values: dict[str, Any] = {}
        if unit_system is not UNSET:
            values["unit_system"] = UnitSystem(unit_system).value if unit_system else None
        if forecast_horizon_days is not UNSET:
            values["forecast_horizon_days"] = (
                self._validated_horizon(forecast_horizon_days)
                if forecast_horizon_days is not None
                else None
            )
        if default_location is not UNSET:
            location = default_location if isinstance(default_location, Location) else None
            values["default_location_id"] = location.identifier if location else None
            values["default_location"] = location.model_dump(mode="json") if location else None

        if not values:
            return await self.read()

        # Upsert rather than check-then-insert: the first preference a person ever sets is the
        # common case, and a check-then-insert would race the row into existence twice.
        async with reporting_unavailable("preferences"):
            row = (
                await self._session.execute(
                    pg_insert(Preference)
                    .values(user_id=self._principal.user_id, **values)
                    .on_conflict_do_update(
                        index_elements=[Preference.user_id],
                        set_={**values, "updated_at": func.now()},
                    )
                    .returning(Preference)
                )
            ).scalar_one()
            await self._session.flush()

        logger.info("preferences updated for %s: %s", self._principal, sorted(values))
        return self._view(row)

    async def delete(self) -> PreferenceView:
        """Remove the acting user's preferences and return the defaults that now apply.

        Returns the view rather than nothing so the caller can *show* what took over — "your
        preferences were cleared" and "metric now applies, as the default" are the same fact, and a
        response carrying only the first invites the person to wonder about the second.
        """
        async with reporting_unavailable("preferences"):
            await self._session.execute(
                delete(Preference).where(Preference.user_id == self._principal.user_id)
            )
            await self._session.flush()
        logger.info("preferences deleted for %s", self._principal)
        return self.defaults

    # ---------------------------------------------------------------- applying

    async def unit_system_for(self, requested: UnitSystem | None) -> UnitSystem:
        """The unit system a request should use: what it asked for, else the person's, else default.

        The precedence is the point. An explicit request wins over a stored preference, because a
        preference is a default and not an override — someone who asks for Celsius once should get
        Celsius once without having to change their profile.
        """
        if requested is not None:
            return requested
        return (await self.read()).unit_system

    async def horizon_for(self, requested: int | None) -> int:
        """The forecast horizon a request should use, by the same precedence."""
        if requested is not None:
            return self._validated_horizon(requested)
        return (await self.read()).forecast_horizon_days

    # ---------------------------------------------------------------- internals

    @staticmethod
    def _validated_horizon(days: int) -> int:
        maximum = MAX_HORIZON_PREFERENCE_DAYS
        if not 1 <= days <= maximum:
            raise ValueError(
                f"A forecast horizon preference must be between 1 and {maximum} days; "
                f"{days} was given."
            )
        return days

    def _view(self, row: Preference) -> PreferenceView:
        """A stored row rendered as effective values plus where each one came from."""
        defaults = self.defaults
        chosen: dict[str, Any] = {
            "unit_system": UnitSystem(row.unit_system) if row.unit_system else None,
            "forecast_horizon_days": row.forecast_horizon_days,
            "default_location": (
                Location.model_validate(row.default_location) if row.default_location else None
            ),
        }
        return PreferenceView(
            unit_system=chosen["unit_system"] or defaults.unit_system,
            forecast_horizon_days=chosen["forecast_horizon_days"] or defaults.forecast_horizon_days,
            default_location=chosen["default_location"],
            sources={
                field: (
                    PreferenceSource.CHOSEN
                    if chosen[field] is not None
                    else PreferenceSource.DEFAULT
                )
                for field in PREFERENCE_FIELDS
            },
        )
