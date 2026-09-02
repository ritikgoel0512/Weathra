"""The signing-key cache.

Validation is local. Calling Supabase's user endpoint on every request was rejected in design.md
decision 4: it adds an external round trip to the latency of every protected call and makes Weathra
unavailable whenever Supabase's API is slow. Instead the project's published key set is fetched
once and cached, with two refresh triggers:

* a **bounded TTL**, so a rotated key is picked up without a redeploy, and
* an **immediate refetch on an unknown key id**, so a rotation mid-TTL does not reject valid users
  for up to the TTL.

The second trigger is rate-limited by ``min_refetch_interval_seconds``. Without that floor, a stream
of tokens naming a key id that genuinely does not exist — a different project's tokens, or a
probe — would turn every request into an outbound fetch, which is the per-request network call the
design set out to avoid.

A fetch failure surfaces as ``SigningKeysUnavailable``, deliberately distinct from a rejected
token: the credential may be perfectly good and the fault ours, and a systemic rejection should be
diagnosable rather than look like user error.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping
from typing import Any

import httpx
import jwt

from weathra.domain.errors import SigningKeysUnavailable, TokenUnknownKey

__all__ = ["JwksCache"]

Clock = Callable[[], float]


class JwksCache:
    """A TTL-bounded cache of the project's JSON Web Key Set, keyed by key id."""

    def __init__(
        self,
        *,
        jwks_url: str,
        ttl_seconds: int,
        client: httpx.AsyncClient,
        timeout_seconds: float = 5.0,
        min_refetch_interval_seconds: float = 10.0,
        clock: Clock = time.monotonic,
    ) -> None:
        self._jwks_url = jwks_url
        self._ttl = float(ttl_seconds)
        self._client = client
        self._timeout = timeout_seconds
        self._min_refetch_interval = min_refetch_interval_seconds
        self._clock = clock

        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None
        self._last_refetch_attempt: float | None = None
        self._lock = asyncio.Lock()
        self.fetch_count = 0

    # ---------------------------------------------------------------- state

    @property
    def is_loaded(self) -> bool:
        return self._fetched_at is not None

    @property
    def key_ids(self) -> tuple[str, ...]:
        return tuple(self._keys)

    def _is_stale(self) -> bool:
        if self._fetched_at is None:
            return True
        return (self._clock() - self._fetched_at) >= self._ttl

    # ---------------------------------------------------------------- fetching

    async def _fetch(self) -> None:
        try:
            response = await self._client.get(self._jwks_url, timeout=self._timeout)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Deliberately does not include the response body: a key-set endpoint should not carry
            # secrets, but an error path is not the place to find out.
            raise SigningKeysUnavailable(
                "The authentication provider's signing keys could not be fetched, so no token "
                "can be validated right now.",
                details={"reason": type(exc).__name__},
            ) from exc

        keys = self._parse(payload)
        if not keys:
            raise SigningKeysUnavailable(
                "The authentication provider returned a key set containing no usable keys.",
                details={"reason": "empty_key_set"},
            )

        self._keys = keys
        self._fetched_at = self._clock()
        self.fetch_count += 1

    @staticmethod
    def _parse(payload: Any) -> dict[str, jwt.PyJWK]:
        raw_keys = payload.get("keys") if isinstance(payload, Mapping) else None
        if not isinstance(raw_keys, list):
            raise SigningKeysUnavailable(
                "The authentication provider's key set was not in the expected format.",
                details={"reason": "malformed_key_set"},
            )

        parsed: dict[str, jwt.PyJWK] = {}
        for entry in raw_keys:
            if not isinstance(entry, Mapping):
                continue
            key_id = entry.get("kid")
            if not isinstance(key_id, str) or not key_id:
                continue
            try:
                parsed[key_id] = jwt.PyJWK.from_dict(dict(entry))
            except Exception:
                continue
        return parsed

    async def refresh(self) -> None:
        """Fetch the key set now, whatever the TTL says. Used at startup and by readiness."""
        async with self._lock:
            await self._fetch()

    # ---------------------------------------------------------------- lookup

    async def key_for(self, key_id: str) -> jwt.PyJWK:
        """The signing key for a key id, fetching or refetching only when necessary."""
        if not key_id:
            raise TokenUnknownKey("The token names no signing key id.")

        async with self._lock:
            if self._is_stale():
                await self._fetch()

            key = self._keys.get(key_id)
            if key is not None:
                return key

            # An unknown key id means a rotation we have not seen — refetch immediately rather
            # than rejecting valid tokens until the TTL elapses. Rate-limited so an endless stream
            # of unknown ids cannot turn this into a per-request fetch.
            if self._may_refetch():
                self._last_refetch_attempt = self._clock()
                await self._fetch()
                key = self._keys.get(key_id)
                if key is not None:
                    return key

            raise TokenUnknownKey(
                "The token was signed with a key the authentication provider does not publish.",
                details={"key_id": key_id},
            )

    def _may_refetch(self) -> bool:
        if self._last_refetch_attempt is None:
            return True
        return (self._clock() - self._last_refetch_attempt) >= self._min_refetch_interval
