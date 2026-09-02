"""Task 4.1 — the signing-key cache: a cached hit, a TTL refresh, an unknown-key-id refetch, and a
fetch failure that is distinguishable without a per-request fetch.

Every test runs against an in-memory transport, so no network call is possible. The clock is
injected, so a TTL test takes microseconds rather than ten minutes.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from tests.auth_support import PRIMARY_KEY_ID, UNPUBLISHED_KEY_ID, TokenFactory, seeded_cache
from weathra.auth.jwks import JwksCache
from weathra.domain.errors import SigningKeysUnavailable, TokenUnknownKey


class FakeClock:
    """A monotonic clock a test can move."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


async def test_the_first_lookup_fetches_the_key_set(token_factory: TokenFactory) -> None:
    cache = seeded_cache(token_factory)
    assert cache.is_loaded is False

    key = await cache.key_for(PRIMARY_KEY_ID)

    assert key is not None
    assert cache.is_loaded is True
    assert cache.fetch_count == 1
    assert cache.key_ids == (PRIMARY_KEY_ID,)


async def test_a_second_lookup_is_served_from_cache(token_factory: TokenFactory) -> None:
    """The property the design is built on: no network call per request."""
    fetches: list[str] = []
    cache = seeded_cache(token_factory, fetch_recorder=fetches)

    for _ in range(25):
        await cache.key_for(PRIMARY_KEY_ID)

    assert cache.fetch_count == 1
    assert len(fetches) == 1


async def test_the_key_set_is_refetched_once_the_ttl_elapses(token_factory: TokenFactory) -> None:
    clock = FakeClock()
    cache = seeded_cache(token_factory, ttl_seconds=600, clock=clock)

    await cache.key_for(PRIMARY_KEY_ID)
    assert cache.fetch_count == 1

    clock.advance(599)
    await cache.key_for(PRIMARY_KEY_ID)
    assert cache.fetch_count == 1, "refetched before the TTL elapsed"

    clock.advance(2)
    await cache.key_for(PRIMARY_KEY_ID)
    assert cache.fetch_count == 2, "did not refetch after the TTL elapsed"


async def test_an_unknown_key_id_triggers_an_immediate_refetch(
    token_factory: TokenFactory,
) -> None:
    """A rotation mid-TTL must not reject valid users until the TTL expires."""
    clock = FakeClock()
    cache = seeded_cache(token_factory, ttl_seconds=3_600, clock=clock)

    await cache.key_for(PRIMARY_KEY_ID)
    assert cache.fetch_count == 1

    with pytest.raises(TokenUnknownKey):
        await cache.key_for(UNPUBLISHED_KEY_ID)

    assert cache.fetch_count == 2, "an unknown key id did not trigger a refetch"


async def test_a_rotated_in_key_is_picked_up_by_the_refetch() -> None:
    """The case the refetch exists for: the key set gains a key between two requests."""
    from tests.auth_support import KeyPair, _generate, settings_for

    first = KeyPair("key-one", _generate())
    second = KeyPair("key-two", _generate())
    factory = TokenFactory(signing=first, impostor=KeyPair("impostor", _generate()))
    settings = settings_for(factory)

    published = [first]

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"keys": [pair.as_jwk() for pair in published]})

    cache = JwksCache(
        jwks_url=settings.jwks_url,
        ttl_seconds=3_600,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    await cache.key_for("key-one")
    published.append(second)

    assert await cache.key_for("key-two") is not None
    assert cache.fetch_count == 2


async def test_repeated_unknown_key_ids_do_not_fetch_per_request(
    token_factory: TokenFactory,
) -> None:
    """The floor that keeps the refetch from becoming the per-request call it replaced."""
    clock = FakeClock()
    cache = seeded_cache(token_factory, ttl_seconds=3_600, clock=clock)
    await cache.key_for(PRIMARY_KEY_ID)
    baseline = cache.fetch_count

    for _ in range(20):
        with pytest.raises(TokenUnknownKey):
            await cache.key_for(UNPUBLISHED_KEY_ID)

    assert cache.fetch_count == baseline + 1, (
        "an unknown-key-id flood turned into per-request fetches"
    )


async def test_the_refetch_floor_lifts_after_its_interval(token_factory: TokenFactory) -> None:
    clock = FakeClock()
    cache = seeded_cache(token_factory, ttl_seconds=3_600, clock=clock)
    await cache.key_for(PRIMARY_KEY_ID)

    with pytest.raises(TokenUnknownKey):
        await cache.key_for(UNPUBLISHED_KEY_ID)
    fetches_after_first = cache.fetch_count

    clock.advance(11)
    with pytest.raises(TokenUnknownKey):
        await cache.key_for(UNPUBLISHED_KEY_ID)

    assert cache.fetch_count == fetches_after_first + 1


async def test_an_unknown_key_id_is_distinguishable_from_a_fetch_failure(
    token_factory: TokenFactory,
) -> None:
    cache = seeded_cache(token_factory)
    with pytest.raises(TokenUnknownKey) as caught:
        await cache.key_for(UNPUBLISHED_KEY_ID)
    assert caught.value.code == "token_unknown_key"
    assert caught.value.details["key_id"] == UNPUBLISHED_KEY_ID


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500),
        httpx.Response(404),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"keys": []}),
        httpx.Response(200, json={"keys": "not a list"}),
        httpx.Response(200, json={}),
    ],
    ids=["server-error", "not-found", "not-json", "empty-set", "malformed-set", "no-keys-field"],
)
async def test_a_fetch_failure_surfaces_as_a_dependency_problem(response: httpx.Response) -> None:
    """Not a rejected token: the credential may be fine and the fault ours."""

    def handler(_: httpx.Request) -> httpx.Response:
        return response

    cache = JwksCache(
        jwks_url="https://project.supabase.co/auth/v1/.well-known/jwks.json",
        ttl_seconds=600,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(SigningKeysUnavailable) as caught:
        await cache.key_for(PRIMARY_KEY_ID)
    assert caught.value.code == "signing_keys_unavailable"


async def test_a_transport_failure_surfaces_the_same_way() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    cache = JwksCache(
        jwks_url="https://project.supabase.co/auth/v1/.well-known/jwks.json",
        ttl_seconds=600,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(SigningKeysUnavailable):
        await cache.key_for(PRIMARY_KEY_ID)


async def test_a_fetch_failure_carries_no_response_body() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="Internal error: secret=hunter2")

    cache = JwksCache(
        jwks_url="https://project.supabase.co/auth/v1/.well-known/jwks.json",
        ttl_seconds=600,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(SigningKeysUnavailable) as caught:
        await cache.key_for(PRIMARY_KEY_ID)
    rendered = caught.value.message + str(caught.value.details)
    assert "hunter2" not in rendered


async def test_a_previously_loaded_cache_still_serves_when_a_refetch_fails(
    token_factory: TokenFactory,
) -> None:
    """A stale-but-known key beats rejecting everyone while the provider is down.

    The TTL check runs before the lookup, so a failed refresh does raise — but the key set is
    retained, so the very next successful fetch restores service without a redeploy.
    """
    clock = FakeClock()
    healthy = True

    def handler(_: httpx.Request) -> httpx.Response:
        if healthy:
            return httpx.Response(200, json=token_factory.jwks_document())
        return httpx.Response(503)

    cache = JwksCache(
        jwks_url="https://project.supabase.co/auth/v1/.well-known/jwks.json",
        ttl_seconds=60,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        clock=clock,
    )
    await cache.key_for(PRIMARY_KEY_ID)

    healthy = False
    clock.advance(61)
    with pytest.raises(SigningKeysUnavailable):
        await cache.key_for(PRIMARY_KEY_ID)
    assert cache.key_ids == (PRIMARY_KEY_ID,), "the key set was discarded on a failed refetch"

    healthy = True
    assert await cache.key_for(PRIMARY_KEY_ID) is not None


async def test_concurrent_first_lookups_fetch_once(token_factory: TokenFactory) -> None:
    """A cold start under load must not turn into one fetch per in-flight request."""
    fetches: list[str] = []
    cache = seeded_cache(token_factory, fetch_recorder=fetches)

    await asyncio.gather(*(cache.key_for(PRIMARY_KEY_ID) for _ in range(10)))

    assert len(fetches) == 1
    assert cache.fetch_count == 1


async def test_an_empty_key_id_is_refused_without_a_fetch(token_factory: TokenFactory) -> None:
    fetches: list[str] = []
    cache = seeded_cache(token_factory, fetch_recorder=fetches)
    with pytest.raises(TokenUnknownKey):
        await cache.key_for("")
    assert fetches == []


async def test_refresh_loads_the_set_eagerly(token_factory: TokenFactory) -> None:
    """Startup and readiness both use this rather than waiting for a first request."""
    cache = seeded_cache(token_factory)
    await cache.refresh()
    assert cache.is_loaded is True
    assert cache.fetch_count == 1


async def test_an_unusable_key_does_not_sink_the_whole_set(token_factory: TokenFactory) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "keys": [
                    {"kid": "broken", "kty": "RSA"},  # no modulus: unusable
                    {"no": "kid"},
                    token_factory.signing.as_jwk(),
                ]
            },
        )

    cache = JwksCache(
        jwks_url="https://project.supabase.co/auth/v1/.well-known/jwks.json",
        ttl_seconds=600,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    assert await cache.key_for(PRIMARY_KEY_ID) is not None
