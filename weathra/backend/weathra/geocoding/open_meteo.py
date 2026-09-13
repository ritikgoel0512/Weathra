"""Open-Meteo geocoding, plus coordinate resolution and a cache.

Three behaviours are worth reading closely, because each one exists to satisfy a specific scenario
in ``specs/location-resolution``:

* **Region-qualified names win.** "Springfield, Illinois" must resolve to the Springfield in
  Illinois. Open-Meteo's search takes a name, not a qualifier, so the qualifier is split off and
  matched against each candidate's region, country, and country code — and a qualifier that matches
  exactly one candidate turns an ambiguous query into a resolved one.
* **Ambiguity is decided in three narrowing steps, not by result count.** Open-Meteo answers
  "Reykjavik" with the city *and* Reykjavik Airport, and "New York" with New York City plus a dozen
  unnamed hamlets called New York. Counting results would report both as ambiguous, which is wrong
  in both cases. So the candidates are narrowed by exact name match, then collapsed by the stable
  coordinate-derived identifier, and finally checked for one dominant place — a candidate whose
  population is at least ten times the runner-up's. New York City (8.8 million) dominates a hamlet
  with no recorded population; Springfield, Missouri (169k) does *not* dominate Springfield,
  Illinois (116k), so that query stays ambiguous, which is exactly what
  ``specs/location-resolution`` asks for. Ten is a judgment call, and a deliberately blunt one: a
  finer ratio would start silently choosing between genuinely comparable cities.
* **Coordinates resolve through the forecast endpoint's ``timezone=auto``.** Open-Meteo has no
  reverse-geocoding endpoint, and a coordinate pair does not need a name — it needs a timezone,
  which is exactly what that parameter returns. The alternative, shipping a timezone-boundary
  database, is a large dependency for one field.

The cache exists because place-name-to-coordinate mappings change far less often than weather does.
It is keyed on the normalized query, so "  new YORK  " and "New York" share an entry.
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from weathra.config import Settings
from weathra.domain.errors import LocationNotFound, ProviderUnavailable, ValidationFailed
from weathra.domain.location import (
    Ambiguous,
    Location,
    Resolution,
    Resolved,
    validate_coordinates,
)
from weathra.geocoding.base import DEFAULT_SEARCH_LIMIT
from weathra.providers.http import request_json
from weathra.providers.open_meteo import (
    CUSTOMER_FORECAST_URL,
    FORECAST_URL,
    OPEN_METEO_NAME,
)

__all__ = [
    "CUSTOMER_GEOCODING_URL",
    "GEOCODING_URL",
    "OpenMeteoGeocoder",
    "normalize_query",
    "split_qualifier",
]

logger = logging.getLogger("weathra.geocoding.open_meteo")

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"

# The commercial geocoding host. Used only when a key is configured — see
# `Settings.open_meteo_api_key`. Resolving a name and retrieving weather count against the same
# per-IP quota on the free hosts, so a keyed deployment has to move both or it has moved neither.
CUSTOMER_GEOCODING_URL = "https://customer-geocoding-api.open-meteo.com/v1/search"

# Open-Meteo's search takes one name; a qualifier is matched locally against the candidates.
_MAX_UPSTREAM_RESULTS = 20

# How much larger a population has to be for one candidate to count as *the* place a person meant.
POPULATION_DOMINANCE_FACTOR = 10

# Open-Meteo feature codes that are not settlements. Kept out of resolution when a settlement is
# available, so "Reykjavik" is not made ambiguous by Reykjavik Airport.
NON_SETTLEMENT_FEATURE_CODES = frozenset({"AIRP", "AIRF", "AIRB", "AIRQ", "PRT", "RSTN"})

Clock = Callable[[], float]


@dataclass(frozen=True, slots=True)
class _Candidate:
    """One search result, with the provider fields resolution needs but ``Location`` does not.

    Population and feature code are Open-Meteo's own vocabulary, so they stay inside this adapter
    rather than leaking into the domain model.
    """

    location: Location
    population: int
    feature_code: str | None

    @property
    def is_settlement(self) -> bool:
        return self.feature_code not in NON_SETTLEMENT_FEATURE_CODES


def normalize_query(query: str) -> str:
    """Collapse whitespace and case so equivalent queries share a cache entry.

    ``"  new YORK  "`` and ``"New York"`` normalize to the same string, which is what makes the
    casing-and-whitespace scenario a property of the cache key rather than of each call site.
    """
    return " ".join(query.split()).casefold()


def split_qualifier(query: str) -> tuple[str, str | None]:
    """``"Springfield, Illinois"`` -> ``("Springfield", "Illinois")``.

    Only the first comma splits: "Frankfurt, Hesse, Germany" keeps "Hesse, Germany" as one
    qualifier, and every part of it is matched against the candidate's region and country.
    """
    cleaned = " ".join(query.split())
    if "," not in cleaned:
        return cleaned, None
    name, _, qualifier = cleaned.partition(",")
    name = name.strip()
    qualifier = qualifier.strip()
    return (name or cleaned), (qualifier or None)


# Everyday names for countries that are not the name Open-Meteo returns, mapped to the ISO alpha-2
# code it *does* return.
#
# **Why this is here and not treated as a caller error.** The qualifier is usually not typed by a
# person: the supervisor's plan names the place, and a model writing "London, UK" or "Austin, USA"
# is writing the ordinary English form. Open-Meteo answers with `country="United Kingdom"` and
# `country_code="GB"`, so an exact match against the candidate's own fields rejected every one of
# the twenty Londons — and a run whose location does not resolve retrieves nothing, cites nothing
# and computes nothing, so it persists an evidence record holding the supervisor and no other
# stage. One unrecognised abbreviation was costing the whole run.
#
# Deliberately short, and only aliases whose mapping is unambiguous. A guessy table would resolve a
# place the caller did not mean, which is worse than asking: "Weathra does not substitute a nearby
# or similarly spelled place" is the rule this must not break. Anything not listed still falls
# through to the exact match and, failing that, to the clarifying question.
_COUNTRY_ALIASES: Mapping[str, str] = {
    "uk": "gb",
    "u.k.": "gb",
    "great britain": "gb",
    "britain": "gb",
    "usa": "us",
    "u.s.": "us",
    "u.s.a.": "us",
    "united states of america": "us",
    "uae": "ae",
    "u.a.e.": "ae",
    "holland": "nl",
    "czech republic": "cz",
    "south korea": "kr",
    "north korea": "kp",
}


def _matches_qualifier(location: Location, qualifier: str) -> bool:
    """Whether a candidate sits in the region or country the caller named.

    A part matches the candidate's region, country or country code exactly, or — for the everyday
    country names in `_COUNTRY_ALIASES` — the code that name stands for.
    """
    parts = [part.strip().casefold() for part in qualifier.split(",") if part.strip()]
    if not parts:
        return False
    haystack = {
        value.casefold()
        for value in (location.region, location.country, location.country_code)
        if value
    }

    def known(part: str) -> bool:
        alias = _COUNTRY_ALIASES.get(part)
        return part in haystack or (alias is not None and alias in haystack)

    return all(known(part) for part in parts)


# The precision a cached point is keyed at, matching `providers.cache.COORDINATE_DECIMALS`:
# roughly a hundred metres, which is far finer than any timezone or country boundary.
_POINT_DECIMALS = 4


class OpenMeteoGeocoder:
    """Open-Meteo's geocoding API behind the ``Geocoder`` contract."""

    name = OPEN_METEO_NAME

    def __init__(
        self,
        *,
        settings: Settings,
        client: httpx.AsyncClient,
        clock: Clock = time.monotonic,
    ) -> None:
        self._settings = settings
        self._client = client
        self._clock = clock
        self._cache: OrderedDict[str, tuple[float, tuple[_Candidate, ...]]] = OrderedDict()
        # Points already resolved to a place. Separate from `_cache` because the values are a
        # different shape, and because a coordinate pair is not a search query.
        self._resolved: OrderedDict[str, tuple[float, Location]] = OrderedDict()
        self.upstream_calls = 0

    # ---------------------------------------------------------------- resolution

    async def resolve(self, query: str) -> Resolution:
        if not query or not query.strip():
            raise ValidationFailed(
                "A location query cannot be empty.", details={"field": "location"}
            )

        name, qualifier = split_qualifier(query)
        candidates = await self._search(name, limit=_MAX_UPSTREAM_RESULTS)

        if not candidates:
            raise LocationNotFound(f"No location matches {query!r}.", details={"query": query})

        if qualifier:
            candidates = tuple(
                candidate
                for candidate in candidates
                if _matches_qualifier(candidate.location, qualifier)
            )
            if not candidates:
                raise LocationNotFound(
                    f"No location named {name!r} was found in {qualifier!r}.",
                    details={"query": query, "name": name, "qualifier": qualifier},
                )

        narrowed = self._narrow(candidates, name)
        distinct = self._distinct_places(narrowed)

        if len(distinct) == 1:
            return Resolved(query=query, location=distinct[0])

        dominant = self._dominant(narrowed)
        if dominant is not None:
            return Resolved(query=query, location=dominant)

        return Ambiguous(query=query, candidates=distinct)

    async def resolve_coordinates(self, latitude: float, longitude: float) -> Location:
        """The place at a point, from cache where this pair has been resolved before.

        **This was the screen-killer.** Turning a coordinate pair into a timezone costs a call to
        the provider's *forecast* endpoint, and this method reached for it every single time —
        while `_search` beside it had been cached from the start. Any screen that passes latitude
        and longitude rather than a name therefore paid one uncached provider call per request, on
        every load, forever: Travel Intelligence issues three such requests, so three calls of its
        nine were pure repetition that no amount of forecast caching could remove. It is what
        exhausted the free tier's quota and produced "open-meteo rate-limited the request" on a
        screen whose actual weather data was already being shared correctly.

        A point resolves to a timezone, a country and an elevation, none of which change. The
        geocoding TTL is the right one, and rounding the point to the same precision the weather
        cache uses is the right key: two requests for the same place from different screens round
        to the same entry.
        """
        latitude, longitude = validate_coordinates(latitude, longitude)

        point = (round(latitude, _POINT_DECIMALS), round(longitude, _POINT_DECIMALS))
        key = f"point:{point[0]},{point[1]}"
        settled = self._resolved.get(key)
        if settled is not None:
            expires_at, location = settled
            if expires_at > self._clock():
                self._resolved.move_to_end(key)
                return location
            del self._resolved[key]

        endpoint, credential = self._endpoint(FORECAST_URL, CUSTOMER_FORECAST_URL)
        payload = await request_json(
            self._client,
            endpoint,
            params={
                "latitude": latitude,
                "longitude": longitude,
                # `timezone=auto` is what turns a coordinate pair into a timezone. `current` keeps
                # the response small; the values are discarded.
                "timezone": "auto",
                "current": "temperature_2m",
                "forecast_days": 1,
                **credential,
            },
            provider=OPEN_METEO_NAME,
            settings=self._settings,
        )

        timezone = payload.get("timezone")
        if not isinstance(timezone, str) or not timezone:
            raise ProviderUnavailable(
                f"{OPEN_METEO_NAME} returned no timezone for {latitude}, {longitude}.",
                details={"provider": OPEN_METEO_NAME},
            )

        self.upstream_calls += 1
        elevation = payload.get("elevation")
        resolved = Location(
            display_name=self._coordinate_label(latitude, longitude),
            latitude=latitude,
            longitude=longitude,
            timezone=timezone,
            elevation_metres=float(elevation) if isinstance(elevation, (int, float)) else None,
        )

        ttl = self._settings.cache_geocoding_ttl_seconds
        if ttl > 0:
            self._resolved[key] = (self._clock() + ttl, resolved)
            self._resolved.move_to_end(key)
            while len(self._resolved) > self._settings.cache_max_entries:
                self._resolved.popitem(last=False)
        return resolved

    async def search(
        self, query: str, *, limit: int = DEFAULT_SEARCH_LIMIT
    ) -> tuple[Location, ...]:
        if limit < 1:
            raise ValidationFailed(
                f"A search limit must be at least 1; {limit} was requested.",
                details={"field": "limit", "requested": limit, "minimum": 1},
            )
        if not query or not query.strip():
            return ()

        name, qualifier = split_qualifier(query)
        candidates = await self._search(name, limit=max(limit, _MAX_UPSTREAM_RESULTS))
        if qualifier:
            candidates = tuple(
                candidate
                for candidate in candidates
                if _matches_qualifier(candidate.location, qualifier)
            )
        # Search deliberately does *not* narrow: a search box exists to show the alternatives.
        return self._distinct_places(candidates)[:limit]

    # ---------------------------------------------------------------- internals

    async def _search(self, name: str, *, limit: int) -> tuple[_Candidate, ...]:
        key = normalize_query(name)
        cached = self._cached(key)
        if cached is not None:
            return cached

        endpoint, credential = self._endpoint(GEOCODING_URL, CUSTOMER_GEOCODING_URL)
        payload = await request_json(
            self._client,
            endpoint,
            params={
                "name": name,
                "count": limit,
                "language": "en",
                "format": "json",
                **credential,
            },
            provider=f"{OPEN_METEO_NAME} geocoding",
            settings=self._settings,
        )
        self.upstream_calls += 1

        results = payload.get("results")
        # Open-Meteo omits `results` entirely for a query matching nothing, rather than sending [].
        raw = results if isinstance(results, Sequence) and not isinstance(results, str) else ()
        candidates = tuple(
            candidate
            for candidate in (self._as_candidate(entry) for entry in raw)
            if candidate is not None
        )
        self._store(key, candidates)
        return candidates

    @staticmethod
    def _as_candidate(entry: Any) -> _Candidate | None:
        """One search result, or ``None`` when it is unusable.

        A result with no timezone is dropped rather than defaulted: every downstream window is
        resolved from the location's zone, so a location without one is not a usable location.
        """
        if not isinstance(entry, Mapping):
            return None
        name = entry.get("name")
        latitude = entry.get("latitude")
        longitude = entry.get("longitude")
        timezone = entry.get("timezone")
        if not isinstance(name, str) or not isinstance(timezone, str):
            return None
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            return None

        country_code = entry.get("country_code")
        elevation = entry.get("elevation")
        population = entry.get("population")
        feature_code = entry.get("feature_code")
        try:
            location = Location(
                display_name=name,
                latitude=float(latitude),
                longitude=float(longitude),
                timezone=timezone,
                region=entry.get("admin1") if isinstance(entry.get("admin1"), str) else None,
                country=entry.get("country") if isinstance(entry.get("country"), str) else None,
                country_code=country_code if isinstance(country_code, str) else None,
                elevation_metres=float(elevation) if isinstance(elevation, (int, float)) else None,
            )
            return _Candidate(
                location=location,
                # A place Open-Meteo records no population for counts as zero: it is a hamlet, not
                # a city, and treating it as unknown would leave every dominance check inconclusive.
                population=int(population)
                if isinstance(population, (int, float)) and not isinstance(population, bool)
                else 0,
                feature_code=feature_code if isinstance(feature_code, str) else None,
            )
        except ValueError:
            # An out-of-range coordinate or an unknown timezone from upstream: drop the candidate
            # rather than fail the whole search.
            logger.info("dropping an unusable geocoding result for %r", name)
            return None

    @staticmethod
    def _narrow(candidates: Sequence[_Candidate], name: str) -> tuple[_Candidate, ...]:
        """Prefer exact name matches, and settlements over airports and stations.

        Each step is skipped when it would leave nothing: a query that matches only an airport
        should still resolve to that airport.
        """
        wanted = normalize_query(name)
        exact = tuple(
            candidate
            for candidate in candidates
            if normalize_query(candidate.location.display_name) == wanted
        )
        pool = exact or tuple(candidates)

        settlements = tuple(candidate for candidate in pool if candidate.is_settlement)
        return settlements or pool

    @staticmethod
    def _dominant(candidates: Sequence[_Candidate]) -> Location | None:
        """The one place a person almost certainly meant, or ``None`` when it is a real toss-up."""
        ranked = sorted(candidates, key=lambda candidate: candidate.population, reverse=True)
        if len(ranked) < 2:
            return ranked[0].location if ranked else None

        first, second = ranked[0], ranked[1]
        if first.population == 0:
            return None
        if first.population >= max(second.population, 1) * POPULATION_DOMINANCE_FACTOR:
            return first.location
        return None

    @staticmethod
    def _distinct_places(candidates: Sequence[_Candidate]) -> tuple[Location, ...]:
        """Collapse candidates that are the same place, keeping the first (best-ranked) of each.

        Open-Meteo ranks by relevance and population, so the first entry for an identifier is the
        one a person most likely meant.
        """
        seen: dict[str, Location] = {}
        for candidate in candidates:
            seen.setdefault(candidate.location.identifier, candidate.location)
        return tuple(seen.values())

    @staticmethod
    def _coordinate_label(latitude: float, longitude: float) -> str:
        return f"{latitude:.4f}, {longitude:.4f}".replace(".0000", ".0")

    def _endpoint(self, free: str, customer: str) -> tuple[str, dict[str, str]]:
        """The host to call and the credential to send, given whether a key is configured.

        Without a key this is exactly what it always was: the free host and no extra parameter.
        With one, the customer host and the key — geocoding shares the free tier's per-IP quota
        with the weather endpoints, so moving only the weather calls would leave every resolved
        name still counting against the shared address.
        """
        key = self._settings.open_meteo_api_key
        if key is None:
            return free, {}
        return customer, {"apikey": key.get_secret_value()}

    def _cached(self, key: str) -> tuple[_Candidate, ...] | None:
        entry = self._cache.get(key)
        if entry is None:
            return None
        expires_at, candidates = entry
        if expires_at <= self._clock():
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return candidates

    def _store(self, key: str, candidates: tuple[_Candidate, ...]) -> None:
        ttl = self._settings.cache_geocoding_ttl_seconds
        if ttl <= 0:
            return
        self._cache[key] = (self._clock() + ttl, candidates)
        self._cache.move_to_end(key)
        while len(self._cache) > self._settings.cache_max_entries:
            self._cache.popitem(last=False)
