"""The geocoder contract.

Separate from ``WeatherProvider`` for the reason ``specs/location-resolution`` separates them: a
deployment might geocode from a local place database while fetching weather remotely, and one
contract covering both would make that impossible without touching every consumer.

``resolve`` returns a ``Resolution`` — ``Resolved | Ambiguous`` — rather than raising on ambiguity.
Ambiguity is a *successful* answer that happens to carry several candidates, which is what
``specs/http-api`` requires it to be. Only a name matching nothing raises, as ``LocationNotFound``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from weathra.domain.location import Location, Resolution

__all__ = ["DEFAULT_SEARCH_LIMIT", "MAX_SEARCH_LIMIT", "Geocoder"]

# What a search returns when the caller names no limit.
DEFAULT_SEARCH_LIMIT = 10

# What a search box can usefully show. A higher limit would return candidates nobody scrolls to
# while costing the geocoder the same work, so it is refused rather than silently truncated.
MAX_SEARCH_LIMIT = 25


@runtime_checkable
class Geocoder(Protocol):
    """Turns what a person typed into one canonical location."""

    async def resolve(self, query: str) -> Resolution:
        """Resolve a free-text place name.

        Returns ``Resolved`` for one match, ``Ambiguous`` for several with no qualifier to choose
        between them. Raises ``LocationNotFound`` when nothing matches — no nearest or partial
        match is ever substituted.
        """
        ...

    async def resolve_coordinates(self, latitude: float, longitude: float) -> Location:
        """Resolve a coordinate pair, including its timezone, with no name lookup."""
        ...

    async def search(
        self, query: str, *, limit: int = DEFAULT_SEARCH_LIMIT
    ) -> tuple[Location, ...]:
        """Ranked candidates for a partial or complete query.

        Returns an empty tuple rather than raising when nothing matches: a search box that shows
        "no results" is not an error condition.
        """
        ...
