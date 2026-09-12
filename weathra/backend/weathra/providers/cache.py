"""``CachedProvider``: a wrapper implementing the same contract (design.md decision 8).

A wrapper rather than caching inside each provider, and rather than HTTP-level caching. HTTP
caching was rejected because it cannot report ``from_cache`` in domain terms and cannot key on
unit system — two things ``specs/weather-providers`` requires.

Three properties are load-bearing:

* **Two tiers.** Forecast and current entries get a short TTL; historical entries a long one, since
  past weather does not change. The spec asserts the second outlives the first.
* **Unit systems key separately.** A metric request must not be served an imperial entry, so the
  unit system is part of the key rather than something converted after the fact.
* **Per-key lock collapsing.** Two concurrent identical misses produce one upstream call. Without
  it, a cold cache under load multiplies traffic against a keyless provider by however many
  requests arrive in the first round trip.

Coordinates are rounded to four decimals (~11 m) in the key. Open-Meteo's grid is kilometre-scale,
so merged entries would have returned identical data anyway.

The cache is process-local. Multiple backend instances each keep their own, which multiplies
upstream calls — an accepted trade for not operating Redis, and this wrapper is the seam where a
shared cache drops in.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from weathra.config import Settings
from weathra.domain.errors import ProviderRateLimited
from weathra.domain.location import Location
from weathra.domain.weather import CurrentConditions, Forecast, HistoricalObservations, UnitSystem
from weathra.providers.base import ProviderCapabilities, WeatherProvider

__all__ = ["COORDINATE_DECIMALS", "CacheKey", "CachedProvider"]

logger = logging.getLogger("weathra.providers.cache")

# ~11 m. Far below any provider's grid resolution, so merging is free.
COORDINATE_DECIMALS = 4

Clock = Callable[[], float]

CachedValue = CurrentConditions | Forecast | HistoricalObservations


@dataclass(frozen=True, slots=True)
class CacheKey:
    """Everything that makes two requests the same request.

    Deliberately carries no user identity: a forecast for Berlin is a forecast for Berlin whoever
    asked, and keying by requester would both waste the cache and store a browsing trail
    (``specs/authentication``'s shared-data classification).
    """

    provider: str
    kind: str
    latitude: float
    longitude: float
    unit_system: UnitSystem
    span: str

    @classmethod
    def build(
        cls,
        *,
        provider: str,
        kind: str,
        location: Location,
        unit_system: UnitSystem,
        span: str,
    ) -> CacheKey:
        return cls(
            provider=provider,
            kind=kind,
            latitude=round(location.latitude, COORDINATE_DECIMALS) + 0.0,
            longitude=round(location.longitude, COORDINATE_DECIMALS) + 0.0,
            unit_system=unit_system,
            span=span,
        )


@dataclass(slots=True)
class _Entry:
    value: CachedValue
    expires_at: float


class CachedProvider:
    """Wraps any ``WeatherProvider`` and satisfies the same contract."""

    def __init__(
        self,
        inner: WeatherProvider,
        *,
        settings: Settings,
        clock: Clock = time.monotonic,
    ) -> None:
        self._inner = inner
        self._settings = settings
        self._clock = clock
        self._entries: OrderedDict[CacheKey, _Entry] = OrderedDict()
        self._locks: dict[CacheKey, asyncio.Lock] = {}
        self.hits = 0
        self.misses = 0
        self.upstream_calls = 0
        self.stale_served = 0

    # ---------------------------------------------------------------- contract

    def capabilities(self) -> ProviderCapabilities:
        """Passed straight through: caching changes nothing about what a provider can do."""
        return self._inner.capabilities()

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        key = self._key("current", location, unit_system, span="now")
        return await self._resolve(  # type: ignore[return-value]
            key,
            self._settings.cache_current_ttl_seconds,
            lambda: self._inner.current(location, unit_system=unit_system),
        )

    async def forecast(
        self, location: Location, *, days: int, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> Forecast:
        key = self._key("forecast", location, unit_system, span=f"{days}d")
        return await self._resolve(  # type: ignore[return-value]
            key,
            self._settings.cache_forecast_ttl_seconds,
            lambda: self._inner.forecast(location, days=days, unit_system=unit_system),
        )

    async def history(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> HistoricalObservations:
        key = self._key(
            "history", location, unit_system, span=f"{start.isoformat()}..{end.isoformat()}"
        )
        return await self._resolve(  # type: ignore[return-value]
            key,
            self._settings.cache_history_ttl_seconds,
            lambda: self._inner.history(location, start=start, end=end, unit_system=unit_system),
        )

    # ---------------------------------------------------------------- internals

    def _key(
        self, kind: str, location: Location, unit_system: UnitSystem, *, span: str
    ) -> CacheKey:
        return CacheKey.build(
            provider=getattr(self._inner, "name", self._inner.capabilities().name),
            kind=kind,
            location=location,
            unit_system=unit_system,
            span=span,
        )

    def _fresh(self, key: CacheKey) -> CachedValue | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.expires_at <= self._clock():
            # Expired, but not forgotten: `_stale` can still serve it when upstream refuses to
            # answer at all. Kept rather than deleted, and evicted by size like any other entry.
            return None
        self._entries.move_to_end(key)
        return entry.value

    def _stale(self, key: CacheKey) -> CachedValue | None:
        """The last value obtained for a key, however old — for when upstream will not answer."""
        entry = self._entries.get(key)
        return None if entry is None else entry.value

    async def _resolve(
        self,
        key: CacheKey,
        ttl_seconds: int,
        fetch: Callable[[], Any],
    ) -> CachedValue:
        cached = self._fresh(key)
        if cached is not None:
            self.hits += 1
            return self._as_cached(cached)

        # One lock per key. Two concurrent identical misses queue here, and the second finds the
        # first one's result in the cache rather than making its own upstream call.
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._fresh(key)
            if cached is not None:
                self.hits += 1
                return self._as_cached(cached)

            self.misses += 1
            self.upstream_calls += 1
            try:
                value: CachedValue = await fetch()
            except ProviderRateLimited:
                """
                Rate-limited, with something already on the shelf.

                The entry has outlived its TTL, which is a statement about freshness, not about
                usefulness: an hour-old forecast is a far better answer than a screen that cannot
                rank anything, and `_as_cached` marks it `from_cache` without touching
                `retrieved_at`, so the reader is told exactly how old the figures are. Nothing is
                retried here — a provider that just refused a request is the last thing that should
                be asked again in a loop.
                """
                stale = self._stale(key)
                if stale is None:
                    raise
                self.stale_served += 1
                logger.warning(
                    "provider rate-limited %s; serving the last value obtained for it", key
                )
                return self._as_cached(stale)
            self._store(key, value, ttl_seconds)
            return value

    def _store(self, key: CacheKey, value: CachedValue, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        self._entries[key] = _Entry(value=value, expires_at=self._clock() + ttl_seconds)
        self._entries.move_to_end(key)
        while len(self._entries) > self._settings.cache_max_entries:
            evicted, _ = self._entries.popitem(last=False)
            self._locks.pop(evicted, None)

    @staticmethod
    def _as_cached(value: CachedValue) -> CachedValue:
        """The same result, marked as served from cache.

        ``retrieved_at`` is deliberately *not* refreshed: it states when the data was obtained
        from upstream, which is what a reader needs in order to judge how old the figures are.
        """
        return value.model_copy(update={"from_cache": True})
