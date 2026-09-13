"""The acting user's own data: their profile, their preferences, their saved places.

Every route here is protected, and every one of them is scoped to the token's subject in the same
way: the store objects take a ``Principal`` and there is no method on any of them that accepts a
user id. Row Level Security is the second gate behind that, and the ``db`` tests prove it by
deliberately omitting the ownership predicate.

**The profile is created on first authenticated use, not at sign-up.** Weathra never sees a
sign-up: Supabase Auth owns that. So the first request bearing a valid token is where the profile
row appears, and it is idempotent because two concurrent first requests are the *normal* case — a
frontend loads a screen and the screen fires two queries (``specs/authentication``).

**What ``/me`` returns, and what it cannot.** The subject, the email the *token* reported, when the
profile was created, and the effective preferences. No credential material, because there is none
to return: Weathra stores no password, no token, and no contact detail of its own. The email is
echoed from the validated claim rather than read from a table, which is why "Weathra does not
duplicate contact data" is true rather than aspirational.

**Deletion is confirmed, per table.** ``specs/http-api`` requires the response to say what was
removed, and counts are the honest form of that: "your data was deleted" is not checkable and "3
saved locations, 1 preference row, 2 threads, 5 runs" is.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path, Request, status
from pydantic import BaseModel, ConfigDict, Field

from weathra.analytics.saved_places import PlaceReading, PlacesComparison, compare_places
from weathra.analytics.watch import WatchState
from weathra.api.dependencies import Configuration, CurrentSession, Memory, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import resolve_for_saving
from weathra.auth.deps import RequiredPrincipal
from weathra.auth.profiles import ensure_profile, touch_profile
from weathra.auth.roles import is_administrative
from weathra.domain.errors import WeathraError
from weathra.domain.location import Location, location_identifier
from weathra.domain.weather import Measure, UnitSystem
from weathra.memory.locations import SavedLocationRecord, SavedLocationStore
from weathra.memory.preferences import UNSET, PreferenceStore, PreferenceView, Unset
from weathra.memory.retention import AccountDeletionReport as DeletionReport
from weathra.memory.retention import delete_account_data
from weathra.memory.watches import WatchStore
from weathra.providers.base import WeatherProvider

__all__ = ["router"]

logger = logging.getLogger("weathra.api.account")

router = APIRouter(tags=["account"])


class MeResponse(BaseModel):
    """Who you are, as far as Weathra is concerned. No credential material.

    There is deliberately no field that could carry one: the model forbids extras, and every field
    here is either the token's own subject, the email it reported, a timestamp, or a preference.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str = Field(
        description="Your Supabase Auth subject. Weathra's only identifier for you."
    )
    email: str | None = Field(
        default=None,
        description=(
            "As reported by your access token. Weathra does not store it — Supabase Auth owns "
            "your contact details."
        ),
    )
    email_verified: bool
    profile_created_at: datetime
    last_seen_at: datetime
    created_now: bool = Field(
        description="True when this request is the one that created your Weathra profile."
    )
    administrative: bool = Field(
        default=False,
        description=(
            "Whether you hold Weathra's administrative role, read from backend state keyed by "
            "your token subject. Advisory, and only for deciding what to offer you: every "
            "administrative endpoint checks the same state itself and refuses regardless of what "
            "any client believes."
        ),
    )
    preferences: PreferenceView


class PreferenceUpdate(BaseModel):
    """A preference change. Every field is an explicit choice you are making.

    Omitting a field leaves it as it was; sending ``null`` clears it back to the documented
    default. Those are genuinely different requests, and a shape that could not express both would
    make "reset my units" impossible to say (``specs/memory``).
    """

    model_config = ConfigDict(extra="forbid")

    unit_system: UnitSystem | None = None
    forecast_horizon_days: int | None = Field(default=None, ge=1, le=16)
    default_location: str | None = Field(
        default=None, description="A place name. Resolved and stored canonically."
    )
    # A default can also be named by coordinates, exactly as a saved location can
    # (``SavedLocationRequest``), and for a reason that is not symmetry.
    #
    # A place resolved from coordinates that reverse-geocoding could not name is called
    # ``"48.1374, 11.5755"`` — the geocoder's own coordinate label. Sending *that* back as a place
    # name asks the geocoder to search for a city of that name, which fails with "No location
    # matches '48.1374, 11.5755'". So a location Weathra had already resolved, stored, and shown
    # became one whose preference could not be saved, and the only clue was an error naming a
    # place nobody had typed.
    #
    # The fix is not to make the name path cleverer. A caller who already holds a resolved location
    # should not be re-deriving it from prose at all: coordinates carry the identity the name was
    # standing in for, and ``Location.identifier`` is derived from them, so this addresses the same
    # place with nothing left to guess. The name is kept for callers that genuinely have only a
    # name — a person typing one, or the evaluation runner's fixtures.
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    clear_unit_system: bool = Field(
        default=False, description="Clear the unit preference back to the documented default."
    )
    clear_forecast_horizon: bool = False
    clear_default_location: bool = False


class SavedLocationRequest(BaseModel):
    """A place to save, by name or by coordinates, with an optional label of your own."""

    model_config = ConfigDict(extra="forbid")

    location: str | None = None
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    label: str | None = Field(default=None, max_length=200)


class SavedLocationsResponse(BaseModel):
    """Your saved locations, and the limit they count against."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    limit: int = Field(ge=1)
    locations: tuple[SavedLocationRecord, ...]


class DeletionResponse(BaseModel):
    """What the deletion removed, per table, and what it deliberately did not."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    removed: DeletionReport
    total: int = Field(ge=0)
    note: str


# =========================================================================== 15.11 /me


@router.get("/me", response_model=MeResponse, summary="The acting user")
async def me(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
) -> MeResponse:
    """Your profile and your effective preferences, creating the profile on first use."""
    annotate(request, acting_user_id=principal.user_id)

    profile = await ensure_profile(session, principal)
    if not profile.created_now:
        # The only behavioural thing Weathra records without being asked, and it is a timestamp
        # rather than a trail (``specs/memory`` forbids inferring preferences from usage).
        await touch_profile(session, principal)

    preferences = await PreferenceStore(session, principal, settings).read()

    # The one capability a signed-in person needs told to them, and it is told rather than trusted.
    # `specs/web-ui` already draws the line this sits on: hiding a control is a presentation
    # convenience and the backend refuses the underlying request regardless — so this decides what
    # the navigation offers and authorizes nothing. Read from `admin_roles` on the request session,
    # where the owner policy means the query can only ever see the acting subject's own row.
    administrative = await is_administrative(session, principal)

    return MeResponse(
        user_id=principal.user_id,
        email=principal.email,
        email_verified=principal.email_verified,
        profile_created_at=profile.created_at,
        last_seen_at=profile.last_seen_at,
        created_now=profile.created_now,
        administrative=administrative,
        preferences=preferences,
    )


# =========================================================================== 15.12 preferences


@router.get("/me/preferences", response_model=PreferenceView, summary="Read your preferences")
async def read_preferences(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
) -> PreferenceView:
    """Your preferences, each labelled ``chosen`` or ``default``.

    The labels are half the response: a value shown identically whether you picked it or Weathra
    assumed it would be telling you that you made a decision you never made.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)
    return await PreferenceStore(session, principal, settings).read()


@router.put("/me/preferences", response_model=PreferenceView, summary="Update your preferences")
async def update_preferences(
    request: Request,
    body: PreferenceUpdate,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
) -> PreferenceView:
    """Record an explicit choice. Nothing here is ever inferred from how you use Weathra."""
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    store = PreferenceStore(session, principal, settings)

    unit_system: UnitSystem | Unset | None = UNSET
    if body.clear_unit_system:
        unit_system = None
    elif body.unit_system is not None:
        unit_system = body.unit_system

    horizon: int | Unset | None = UNSET
    if body.clear_forecast_horizon:
        horizon = None
    elif body.forecast_horizon_days is not None:
        horizon = body.forecast_horizon_days

    default_location: Location | Unset | None = UNSET
    named_location = body.default_location is not None
    given_coordinates = body.latitude is not None or body.longitude is not None
    if body.clear_default_location:
        default_location = None
    elif named_location or given_coordinates:
        # Resolved before storing, so what is kept is the canonical location rather than the text
        # — a saved default must not change meaning when a geocoder's ranking does. A caller that
        # already resolved the place sends its name and its coordinates together: the name is what
        # a stored default is read back as, and the pair says which candidate was meant, so neither
        # the ambiguity refusal nor a coordinate-shaped name can be the answer. Half a pair, or a
        # pair alone, still resolves exactly as it did.
        default_location = await resolve_for_saving(
            geocoder,
            location=body.default_location,
            latitude=body.latitude,
            longitude=body.longitude,
        )

    return await store.update(
        unit_system=unit_system,
        forecast_horizon_days=horizon,
        default_location=default_location,
    )


@router.delete("/me/preferences", response_model=PreferenceView, summary="Clear your preferences")
async def delete_preferences(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
) -> PreferenceView:
    """Remove your preferences, and return the defaults that now apply.

    Returning the defaults rather than nothing: "your preferences were cleared" and "metric now
    applies, as the default" are the same fact, and a response carrying only the first invites you
    to wonder about the second.
    """
    annotate(request, acting_user_id=principal.user_id)
    return await PreferenceStore(session, principal, settings).delete()


# =========================================================================== saved locations


@router.get(
    "/me/locations", response_model=SavedLocationsResponse, summary="List your saved locations"
)
async def list_locations(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
) -> SavedLocationsResponse:
    """Your saved locations, oldest first."""
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    store = SavedLocationStore(session, principal, settings)
    saved = await store.list()
    return SavedLocationsResponse(count=len(saved), limit=store.limit, locations=saved)


@router.post(
    "/me/locations",
    response_model=SavedLocationRecord,
    status_code=status.HTTP_201_CREATED,
    summary="Save a location",
)
async def save_location(
    request: Request,
    body: SavedLocationRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    geocoder: Places,
) -> SavedLocationRecord:
    """Save a place. Saving the same place twice updates its label rather than duplicating it."""
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    # `resolve_for_saving`, not `resolve_one`: a saved row is read back by name later, and
    # `specs/memory` requires that name to be the canonical one. A client that already resolved the
    # place sends both its name and its coordinates — the name for identity, the pair to say which
    # candidate it meant — and neither alone would do it. See that function for why accepting both
    # here is safe when the weather path refuses it.
    place = await resolve_for_saving(
        geocoder,
        location=body.location,
        latitude=body.latitude,
        longitude=body.longitude,
    )
    return await SavedLocationStore(session, principal, settings).save(place, label=body.label)


@router.delete(
    "/me/locations/{saved_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a saved location",
)
async def remove_location(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    saved_id: Annotated[str, Path(description="The saved location's identifier.")],
) -> None:
    """Remove one of your saved locations.

    An identifier that is not yours produces the same not-found response as one that does not
    exist, because "that exists but is not yours" is itself a disclosure.
    """
    annotate(request, acting_user_id=principal.user_id)
    await SavedLocationStore(session, principal, settings).remove(saved_id)


# =========================================================================== 15.14 deletion


@router.delete("/me/data", response_model=DeletionResponse, summary="Delete your Weathra data")
async def delete_my_data(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    memory: Memory,
) -> DeletionResponse:
    """Remove every Weathra record you own, and confirm what went.

    **What this does not touch, and why.** The knowledge corpus and the location-keyed forecast
    snapshots are nobody's personal data — the snapshots are keyed by *place*, deliberately, so
    that Weathra holds no browsing trail (design.md decision 10). Sweeping them would degrade What
    Changed? and knowledge retrieval for everyone else while removing nothing whatsoever about you.

    **Your login is not Weathra's to delete.** Supabase Auth owns the account itself. This removes
    the application data; removing the account is a separate action in Auth.
    """
    annotate(request, acting_user_id=principal.user_id)

    report = await delete_account_data(session, principal, checkpointer=memory)
    logger.info("account data deleted for %s", principal)

    return DeletionResponse(
        removed=report,
        total=report.total,
        note=(
            "Your saved locations, preferences, conversation threads and their memory, and stored "
            "agent runs have been removed. Weathra's shared knowledge base and its "
            "location-keyed forecast snapshots are not personal data and are unaffected. Your "
            "sign-in itself is managed by Supabase Auth and is not deleted by this endpoint."
        ),
    )


# =========================================================== the saved locations workspace


class SavedPlaceConditions(BaseModel):
    """What a provider reported at one saved place, with when and from whom."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    values: dict[Measure, float | None] = Field(default_factory=dict)
    units: dict[Measure, str] = Field(default_factory=dict)
    observed_at: datetime
    provider: str
    retrieved_at: datetime


class SavedPlaceCard(BaseModel):
    """One saved place, with whatever is currently known about it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    saved_id: str
    location: Location = Field(description="The canonical resolved place. Coordinates are inside.")
    label: str | None = None
    is_default: bool = Field(
        default=False, description="Whether this is the place every screen opens on."
    )
    watch_count: int = Field(default=0, ge=0, description="Enabled Weather Watches here.")
    met_watch_count: int = Field(
        default=0, ge=0, description="Of those, how many are currently met."
    )
    conditions: SavedPlaceConditions | None = None
    unavailable: str | None = Field(
        default=None,
        description="Why there are no conditions. A saved place is never dropped for this.",
    )


class SavedPlacesSummary(BaseModel):
    """The allowance, and what the saved set covers. Counted, never estimated."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    saved_count: int = Field(ge=0)
    limit: int = Field(ge=1)
    remaining: int = Field(ge=0)
    country_count: int = Field(ge=0)
    timezone_count: int = Field(ge=0)


class SavedPlaceAttention(BaseModel):
    """One real reason a saved place wants looking at. Never decoration."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: str = Field(description="'watch_met' or 'unavailable'. A stable identifier to branch on.")
    saved_id: str
    name: str
    detail: str


class SavedLocationsOverview(BaseModel):
    """Everything the Saved Locations screen draws, from one read."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    summary: SavedPlacesSummary
    places: tuple[SavedPlaceCard, ...] = ()
    comparison: PlacesComparison | None = Field(
        default=None, description="Absent below two places with readings. Not an empty table."
    )
    attention: tuple[SavedPlaceAttention, ...] = ()
    unit_system: UnitSystem


@router.get(
    "/me/locations/overview",
    response_model=SavedLocationsOverview,
    summary="Your saved locations, with what the weather is doing at each",
)
async def locations_overview(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    settings: Configuration,
    weather: WeatherFor,
) -> SavedLocationsOverview:
    """The saved places and their current conditions, in one request rather than one per card.

    **One provider call per place, not per component.** The cards, the comparison and the attention
    strip are three readings of the same retrieval; a screen where each fetched its own would cost
    three times as much to say the same thing, and would let two panels disagree about the
    temperature in one city.

    **A provider failure loses a card's weather, never the card.** Each retrieval is awaited
    independently and a failure is recorded on that place as `unavailable`. Dropping the place
    instead would make a provider outage look like somebody's saved location disappearing.

    **It retrieves current conditions only.** Today's high and low would need a second call per
    place — the forecast endpoint — and doubling the upstream cost of opening a screen is how this
    product exhausted a provider allowance once already. What a card shows is what one `current`
    call carries, and it is badged as observed because that is what it is.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    store = SavedLocationStore(session, principal, settings)
    saved = await store.list()
    preferences = await PreferenceStore(session, principal, settings).read()
    default_id = (
        None if preferences.default_location is None else preferences.default_location.identifier
    )
    unit_system = preferences.unit_system or UnitSystem.METRIC

    watches = await WatchStore(session, principal).list()
    readings = await asyncio.gather(
        *(_conditions_at(weather, record.location, unit_system) for record in saved)
    )

    places: list[SavedPlaceCard] = []
    for record, (conditions, failure) in zip(saved, readings, strict=True):
        here = [
            watch
            for watch in watches
            if location_identifier(watch.location.latitude, watch.location.longitude)
            == record.location_id
        ]
        places.append(
            SavedPlaceCard(
                saved_id=record.id,
                location=record.location,
                label=record.label,
                is_default=default_id is not None and record.location_id == default_id,
                watch_count=sum(1 for watch in here if watch.enabled),
                met_watch_count=sum(1 for watch in here if watch.state is WatchState.MET),
                conditions=conditions,
                unavailable=failure,
            )
        )

    return SavedLocationsOverview(
        summary=SavedPlacesSummary(
            saved_count=len(saved),
            limit=store.limit,
            remaining=max(store.limit - len(saved), 0),
            country_count=len(
                {record.location.country for record in saved if record.location.country}
            ),
            timezone_count=len({record.location.timezone for record in saved}),
        ),
        places=tuple(places),
        comparison=compare_places(
            [
                PlaceReading(
                    saved_id=card.saved_id,
                    name=card.label or card.location.display_name,
                    values=card.conditions.values,
                    units=card.conditions.units,
                )
                for card in places
                if card.conditions is not None
            ]
        ),
        attention=_attention(places),
        unit_system=unit_system,
    )


async def _conditions_at(
    provider: WeatherProvider, location: Location, unit_system: UnitSystem
) -> tuple[SavedPlaceConditions | None, str | None]:
    """One place's current conditions, or the reason there are none.

    The failure is caught rather than raised because this endpoint's contract is that every saved
    place comes back. One unreachable city must not empty the whole screen.
    """
    try:
        current = await provider.current(location, unit_system=unit_system)
    except WeathraError as exc:
        logger.info("current conditions unavailable for a saved place: %s", exc)
        return None, str(exc)
    except Exception as exc:  # an unexpected failure is still one card's weather, not the page
        logger.exception("current conditions raised for a saved place")
        return None, f"{type(exc).__name__} while retrieving the current conditions."

    return (
        SavedPlaceConditions(
            values=dict(current.values),
            units=dict(current.units),
            observed_at=current.observed_at_local,
            provider=current.provider,
            retrieved_at=current.retrieved_at,
        ),
        None,
    )


def _attention(places: Sequence[SavedPlaceCard]) -> tuple[SavedPlaceAttention, ...]:
    """The saved places that genuinely want looking at, and nothing else.

    Two reasons, both of which Weathra actually knows: a Weather Watch whose condition is met at
    this place, and a place whose conditions could not be retrieved. The approved screen carries a
    standing "atmospheric attention required" banner; a banner that is always there is decoration,
    and on a weather product decoration that says *attention* is worse than none.
    """
    found: list[SavedPlaceAttention] = []
    for card in places:
        name = card.label or card.location.display_name
        if card.met_watch_count > 0:
            found.append(
                SavedPlaceAttention(
                    kind="watch_met",
                    saved_id=card.saved_id,
                    name=name,
                    detail=(
                        f"{card.met_watch_count} of your "
                        f"{card.watch_count} watch{'' if card.watch_count == 1 else 'es'} here "
                        "is currently met."
                        if card.met_watch_count == 1
                        else f"{card.met_watch_count} of your {card.watch_count} watches here are "
                        "currently met."
                    ),
                )
            )
        elif card.unavailable is not None:
            found.append(
                SavedPlaceAttention(
                    kind="unavailable",
                    saved_id=card.saved_id,
                    name=name,
                    detail="Weathra could not retrieve the current conditions for this place.",
                )
            )
    return tuple(found)
