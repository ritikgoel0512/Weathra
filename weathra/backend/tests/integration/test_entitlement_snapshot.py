"""Task 27.3 — the TTL snapshot over the catalog, policies and plans (design.md decision 23).

Three properties the task names, and each is asserted the way it actually matters:

* **A change is visible after the TTL.** Not "the cache eventually notices" — an administrator's
  disable must take effect, and the documented staleness window is the bound on how long it may
  take. Tested at both ends: invisible inside the window, visible past it.
* **A hot-path resolution issues no query while the snapshot is fresh.** Counted by refreshes
  rather than by instrumenting the database, because the refresh *is* the query and counting it
  directly says what the requirement means.
* **An override validates against the database rather than the snapshot.** The one place staleness
  is not tolerable: an administrator naming a model is acting now, and a stale allowlist would let
  them select something they had just disabled.

The clock is injected rather than waited on. A test that slept for a real TTL would be slow and,
worse, flaky on a loaded machine — and the property under test is about the comparison, not about
`time.monotonic` itself.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.errors import ModelNotAllowlisted
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.snapshot import (
    EntitlementSnapshot,
    SnapshotCache,
    load_snapshot,
    validate_override_against_database,
)

pytestmark = pytest.mark.db

ADMIN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


@pytest.fixture
async def session(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> AsyncIterator[AsyncSession]:
    """A privileged session over pristine seeded reference data, restored afterwards."""
    async with privileged_session(engines.privileged_sessionmaker) as opened:
        yield opened


def _cache(ttl_seconds: int) -> SnapshotCache:
    return SnapshotCache(
        Settings(
            supabase_url="https://test.supabase.co",
            model_catalog_cache_ttl_seconds=ttl_seconds,
        )
    )


# =========================================================================== what it holds


async def test_a_snapshot_carries_the_catalog_the_policies_and_the_plans(
    session: AsyncSession,
) -> None:
    snapshot = await load_snapshot(session)
    assert snapshot.catalog and snapshot.policies and snapshot.plans
    assert snapshot.entry("economy-free-primary") is not None
    assert snapshot.policy("free_default") is not None
    assert snapshot.plan(PlanCode.FREE) is not None


async def test_a_snapshot_is_frozen(session: AsyncSession) -> None:
    """Everything holding a reference keeps a consistent view as a newer one replaces it."""
    from pydantic import ValidationError

    snapshot = await load_snapshot(session)
    with pytest.raises(ValidationError):
        snapshot.catalog = {}  # type: ignore[misc]


async def test_enabled_candidates_follow_the_policy_order_and_not_the_catalog(
    session: AsyncSession,
) -> None:
    """Resolution takes the first of these, so an implementation that sorted would change which
    model serves."""
    snapshot = await load_snapshot(session)
    policy = snapshot.policy("balanced")
    assert policy is not None

    candidates = snapshot.enabled_candidates("balanced", CallRole.SYNTHESIS)
    assert [entry.catalog_key for entry in candidates] == list(policy.candidate_catalog_keys)


async def test_a_disabled_entry_leaves_the_candidate_list(session: AsyncSession) -> None:
    await CatalogStore(session).disable("standard-general", acting_principal=ADMIN)
    snapshot = await load_snapshot(session)

    assert snapshot.entry("standard-general") is not None, "still in the catalog"
    assert snapshot.enabled_entry("standard-general") is None, "and not resolvable"
    keys = [
        entry.catalog_key for entry in snapshot.enabled_candidates("balanced", CallRole.SYNTHESIS)
    ]
    assert "standard-general" not in keys
    assert keys, "the policy's remaining candidate must still be offered"


async def test_a_policy_that_does_not_apply_to_a_role_offers_nothing(
    session: AsyncSession,
) -> None:
    """`free_default` applies to routing and synthesis. Asking it for the lab role is not an error
    — it is a policy with nothing to offer, which is what a resolver needs to hear."""
    snapshot = await load_snapshot(session)
    assert snapshot.enabled_candidates("free_default", CallRole.LAB) == ()
    assert snapshot.enabled_candidates("no_such_policy", CallRole.ROUTING) == ()


async def test_a_capability_cannot_borrow_another_capabilitys_policy(
    session: AsyncSession,
) -> None:
    """A policy's applicable call roles gate it, so a role a policy does not declare gets nothing
    from it however the candidates happen to be shaped."""
    snapshot = await load_snapshot(session)
    for policy_id, record in snapshot.policies.items():
        for role in CallRole:
            if record.applies_to(role):
                continue
            assert snapshot.enabled_candidates(policy_id, role) == (), (
                f"{policy_id} offered candidates for {role.value}, which it does not declare"
            )


# =========================================================================== the TTL


async def test_a_fresh_snapshot_issues_no_query(session: AsyncSession) -> None:
    """The hot-path requirement. Counted by refreshes: the refresh is the query."""
    cache = _cache(ttl_seconds=60)

    first = await cache.current(session)
    assert cache.refreshes == 1

    for _ in range(20):
        again = await cache.current(session)
        assert again is first, "a fresh read must hand back the same object, not a new load"
    assert cache.refreshes == 1, "the hot path issued a query while the snapshot was fresh"


async def test_a_change_is_invisible_inside_the_window_and_visible_after_it(
    session: AsyncSession,
) -> None:
    """Both halves of the documented staleness window, which is the honest form of the claim:
    a disable is not instant, and it is bounded."""
    cache = _cache(ttl_seconds=60)
    before = await cache.current(session)
    assert before.enabled_entry("standard-general") is not None

    await CatalogStore(session).disable("standard-general", acting_principal=ADMIN)

    inside = await cache.current(session)
    assert inside.enabled_entry("standard-general") is not None, (
        "a change inside the window must not be visible; that is what the TTL buys"
    )
    assert cache.refreshes == 1

    # Age the snapshot past its window rather than sleeping through it.
    #
    # The boundary is checked on a snapshot whose `captured_at` is exactly zero, and that is not
    # fussiness. `captured_at` is a monotonic clock reading, which on a host that has been up for
    # weeks is a large float; `captured_at + 60` then rounds, and subtracting `captured_at` back out
    # gives 59.999999… rather than 60. The assertion is about the comparison being `>=`, so it is
    # made where the arithmetic is exact. CI failed here once for precisely this reason.
    boundary = before.model_copy(update={"captured_at": 0.0})
    assert not boundary.is_stale(60, now=59.0)
    assert boundary.is_stale(60, now=60.0)
    assert not before.is_stale(60, now=before.captured_at + 59)
    assert before.is_stale(60, now=before.captured_at + 61)

    stale = _cache(ttl_seconds=0)
    after = await stale.current(session)
    assert after.enabled_entry("standard-general") is None, (
        "past the window the change must be visible, or a disable would need a redeploy"
    )


async def test_a_zero_ttl_reads_every_time(session: AsyncSession) -> None:
    """How a deployment or a test turns the cache off, with no second flag to keep consistent."""
    cache = _cache(ttl_seconds=0)
    first = await cache.current(session)
    second = await cache.current(session)
    assert cache.refreshes == 2
    assert first is not second


async def test_a_concurrent_burst_on_a_cold_cache_refreshes_once(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The lock earning its place: without it a cold process serving a burst issues one set of
    queries per waiter, which is exactly the storm the cache exists to prevent.

    Each task gets its own session, because a burst is concurrent requests and an ``AsyncSession``
    is not safe to share across them — sharing one would deadlock rather than test anything.
    """
    import asyncio

    cache = _cache(ttl_seconds=60)

    async def read() -> EntitlementSnapshot:
        async with privileged_session(engines.privileged_sessionmaker) as own:
            return await cache.current(own)

    results = await asyncio.gather(*(read() for _ in range(8)))
    assert cache.refreshes == 1
    assert all(result is results[0] for result in results)


async def test_invalidating_makes_the_next_read_refresh(session: AsyncSession) -> None:
    """For the process that made an administrative change: the one case where serving the
    administrator their own stale view is indefensible."""
    cache = _cache(ttl_seconds=3_600)
    await cache.current(session)
    assert cache.refreshes == 1

    await CatalogStore(session).disable("standard-general", acting_principal=ADMIN)
    cache.invalidate()

    refreshed = await cache.current(session)
    assert cache.refreshes == 2
    assert refreshed.enabled_entry("standard-general") is None


async def test_the_ttl_comes_from_configuration(session: AsyncSession) -> None:
    assert _cache(ttl_seconds=42).ttl_seconds == 42
    assert SnapshotCache(Settings(supabase_url="https://test.supabase.co")).ttl_seconds == 60, (
        "the documented default"
    )


# =========================================================================== overrides


async def test_an_override_validates_against_the_database_and_not_the_snapshot(
    session: AsyncSession,
) -> None:
    """Decision 23: an administrator never acts on a stale allowlist.

    The snapshot is deliberately left holding the model as enabled while the database has it
    disabled — exactly the window the TTL creates — and the override still refuses.
    """
    cache = _cache(ttl_seconds=3_600)
    snapshot = await cache.current(session)
    assert snapshot.enabled_entry("standard-general") is not None

    await CatalogStore(session).disable("standard-general", acting_principal=ADMIN)

    assert (await cache.current(session)).enabled_entry("standard-general") is not None, (
        "the snapshot is still stale, which is the situation this test is about"
    )

    with pytest.raises(ModelNotAllowlisted, match="disabled") as caught:
        await validate_override_against_database(session, "standard-general")
    assert caught.value.details["reason"] == "disabled"


async def test_an_override_naming_a_model_outside_the_catalog_is_refused(
    session: AsyncSession,
) -> None:
    with pytest.raises(ModelNotAllowlisted, match="not in the model catalog") as caught:
        await validate_override_against_database(session, "no-such-model")
    assert caught.value.details["reason"] == "absent"


async def test_an_override_naming_an_enabled_model_is_accepted(session: AsyncSession) -> None:
    """The refusals only mean something if the permitted case works."""
    entry = await validate_override_against_database(session, "frontier-reasoning")
    assert entry.catalog_key == "frontier-reasoning"
    assert entry.is_enabled


async def test_an_override_sees_an_enable_immediately(session: AsyncSession) -> None:
    """The other direction of the same requirement, and the more annoying one to hit in practice:
    an administrator enables a model and must not be told it does not exist."""
    catalog = CatalogStore(session)
    await catalog.disable("standard-general", acting_principal=ADMIN)

    cache = _cache(ttl_seconds=3_600)
    await cache.current(session)  # snapshot now holds it disabled

    await catalog.enable("standard-general", acting_principal=ADMIN)
    accepted = await validate_override_against_database(session, "standard-general")
    assert accepted.is_enabled


# =========================================================================== determinism


async def test_two_snapshots_of_unchanged_state_resolve_identically(
    session: AsyncSession,
) -> None:
    """Determinism, at the level this group actually provides it: given the same stored state, the
    candidate walk produces the same ordered answer every time."""
    first = await load_snapshot(session)
    second = await load_snapshot(session)

    for policy_id in first.policies:
        for role in CallRole:
            assert [entry.catalog_key for entry in first.enabled_candidates(policy_id, role)] == [
                entry.catalog_key for entry in second.enabled_candidates(policy_id, role)
            ]


async def test_every_plan_resolves_a_policy_that_the_snapshot_carries(
    session: AsyncSession,
) -> None:
    """The three tiers, end to end through the snapshot: each maps both call roles to a policy that
    exists and offers at least one enabled candidate."""
    snapshot = await load_snapshot(session)
    for plan_code in (PlanCode.FREE, PlanCode.PRO, PlanCode.PREMIUM):
        plan = snapshot.plan(plan_code)
        assert plan is not None, f"{plan_code.value} is missing from the snapshot"
        for role in (CallRole.ROUTING, CallRole.SYNTHESIS):
            policy_id = plan.policy_for(role)
            assert policy_id is not None, f"{plan_code.value} maps no policy for {role.value}"
            assert snapshot.policy(policy_id) is not None
            assert snapshot.enabled_candidates(policy_id, role), (
                f"{plan_code.value}/{role.value} resolves {policy_id} with no enabled candidate"
            )


async def test_the_snapshot_holds_no_plan_named_plus(session: AsyncSession) -> None:
    snapshot = await load_snapshot(session)
    assert set(snapshot.plans) == {"free", "pro", "premium"}
    assert snapshot.plan("plus") is None
