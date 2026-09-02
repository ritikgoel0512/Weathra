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

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path, Request, status
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Memory, Places
from weathra.api.middleware import annotate
from weathra.api.routers.support import resolve_one
from weathra.auth.deps import RequiredPrincipal
from weathra.auth.profiles import ensure_profile, touch_profile
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.locations import SavedLocationRecord, SavedLocationStore
from weathra.memory.preferences import UNSET, PreferenceStore, PreferenceView, Unset
from weathra.memory.retention import AccountDeletionReport as DeletionReport
from weathra.memory.retention import delete_account_data

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

    return MeResponse(
        user_id=principal.user_id,
        email=principal.email,
        email_verified=principal.email_verified,
        profile_created_at=profile.created_at,
        last_seen_at=profile.last_seen_at,
        created_now=profile.created_now,
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
    if body.clear_default_location:
        default_location = None
    elif body.default_location is not None:
        # Resolved before storing, so what is kept is the canonical location rather than the text
        # — a saved default must not change meaning when a geocoder's ranking does.
        default_location = await resolve_one(
            geocoder, location=body.default_location, latitude=None, longitude=None
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

    place = await resolve_one(
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
