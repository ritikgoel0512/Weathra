"""Location search and resolution. Public: geocoding a query reads no user-owned row.

**Search and resolve are different operations, not one with a flag.** Search feeds a picker: it
returns ranked candidates and an empty list is a normal answer, because a search box showing "no
results" is not an error. Resolve answers "which place is this": it returns one location, or the
candidates it could not choose between, or a not-found error — and *never* a nearest match.

**Ambiguity is a successful response, and distinguishable from a single one.** Both come back at
200 with a ``kind`` discriminator, so a client branches on a field rather than on the shape of what
it got. ``specs/location-resolution`` asks for exactly this: an ambiguous name is not a failure,
and presenting one candidate as the answer would be choosing for the person.
"""

from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Places
from weathra.api.middleware import annotate
from weathra.auth.deps import OptionalPrincipal
from weathra.domain.errors import ValidationFailed
from weathra.domain.location import Ambiguous, Location, Resolved, validate_coordinates
from weathra.geocoding.base import DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT

__all__ = ["router"]

logger = logging.getLogger("weathra.api.locations")

router = APIRouter(prefix="/locations", tags=["locations"])


class SearchResponse(BaseModel):
    """Ranked candidates for a partial query. An empty list is a real answer."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    query: str
    count: int = Field(ge=0)
    results: tuple[Location, ...]
    note: str | None = None


class ResolvedResponse(BaseModel):
    """Exactly one place matched."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["resolved"] = "resolved"
    query: str
    location: Location


class AmbiguousResponse(BaseModel):
    """Several places matched and no qualifier chose between them.

    A 200, not an error: the request was fine and the answer is "these two". Each candidate carries
    its region and country so they can actually be told apart.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["ambiguous"] = "ambiguous"
    query: str
    candidates: tuple[Location, ...]
    message: str


@router.get("/search", response_model=SearchResponse, summary="Search locations")
async def search(
    request: Request,
    geocoder: Places,
    principal: OptionalPrincipal,
    query: Annotated[str, Query(min_length=1, max_length=200, description="What to search for.")],
    limit: Annotated[int, Query(ge=1, le=MAX_SEARCH_LIMIT)] = DEFAULT_SEARCH_LIMIT,
) -> SearchResponse:
    """Ranked candidates for a free-text query."""
    annotate(request, acting_user_id=principal.user_id if principal else None)

    results = await geocoder.search(query, limit=limit)
    return SearchResponse(
        query=query,
        count=len(results),
        results=results,
        note=(
            None
            if results
            else "No location matched that query. Weathra does not substitute a similar name."
        ),
    )


@router.get(
    "/resolve",
    response_model=ResolvedResponse | AmbiguousResponse,
    summary="Resolve one location",
)
async def resolve(
    request: Request,
    geocoder: Places,
    principal: OptionalPrincipal,
    query: Annotated[str | None, Query(max_length=200, description="A place name.")] = None,
    latitude: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    longitude: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
) -> ResolvedResponse | AmbiguousResponse:
    """Resolve a place name, or a coordinate pair, to one canonical location.

    Exactly one form is required. Accepting both would leave the question of which wins, and any
    answer to that is a surprise to somebody.
    """
    annotate(request, acting_user_id=principal.user_id if principal else None)

    named = bool(query and query.strip())
    coordinates = latitude is not None and longitude is not None

    if named and coordinates:
        raise ValidationFailed(
            "Supply either a place name or a latitude and longitude pair, not both.",
            details={"query": query, "latitude": latitude, "longitude": longitude},
        )
    if not named and not coordinates:
        if latitude is not None or longitude is not None:
            raise ValidationFailed(
                "Coordinates need both latitude and longitude.",
                details={"latitude": latitude, "longitude": longitude},
            )
        raise ValidationFailed(
            "A location is required: supply a place name, or a latitude and longitude pair."
        )

    if latitude is not None and longitude is not None:
        # ``validate_coordinates`` normalizes as well as checks, so the identifier a caller gets
        # back is the same one every cache and saved location keys on.
        checked_latitude, checked_longitude = validate_coordinates(latitude, longitude)
        located = await geocoder.resolve_coordinates(checked_latitude, checked_longitude)
        return ResolvedResponse(query=f"{checked_latitude},{checked_longitude}", location=located)

    outcome = await geocoder.resolve(str(query))

    if isinstance(outcome, Ambiguous):
        options = " or ".join(candidate.qualified_name for candidate in outcome.candidates)
        return AmbiguousResponse(
            query=outcome.query,
            candidates=outcome.candidates,
            message=(
                f"{outcome.query!r} matches more than one place: {options}. Weathra does not pick "
                "one for you — resolve again with a region or country to choose."
            ),
        )

    # ``Resolution`` has exactly two members and the other is handled above; an unresolvable name
    # raised ``LocationNotFound`` inside the geocoder and never reached here.
    resolved: Resolved = outcome
    return ResolvedResponse(query=resolved.query, location=resolved.location)
