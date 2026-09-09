"""The process-local snapshot of the catalog, the policies and the plans (design.md decision 23).

Three tables are read on nearly every agent request and change perhaps weekly. Reading them per
call is three queries on the hot path; caching them without expiry means an administrator's disable
takes effect on redeploy, which ``specs/model-catalog`` forbids outright. So: one snapshot per
process, refreshed on read when older than ``MODEL_CATALOG_CACHE_TTL_SECONDS``.

**The TTL is the documented staleness window, and it is honest about what it costs.** An
administrator disabling a model may see it serve requests for up to one TTL on an instance that has
not refreshed. Multiple instances converge within that window with no pub/sub, no invalidation
message and no second datastore — the same trade decision 8 makes for the provider cache. That is
acceptable for a cost or a quality decision and would not be for a safety one, which is why the
safety controls are code rather than catalog rows.

**An override is not allowed to read this.** ``validate_override_against_database`` exists as its
own function, takes a session, and never consults the snapshot. An administrator naming a model, or
a lab selecting one, is acting on a decision they are making *now*, and letting them act on a
snapshot up to a TTL old would mean an administrator could enable a model and immediately be told
it does not exist — or, worse, disable one and still be allowed to select it. Reads on the hot path
tolerate staleness; a deliberate act must not.

**Refreshing is serialised.** A cold process serving a burst would otherwise issue one set of
queries per concurrent request. One lock, one refresh, and the rest of the burst waits for it and
then reads the same object — which is also why the snapshot is immutable: everything holding a
reference to it keeps a consistent view even as a newer one replaces it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.errors import ModelNotAllowlisted
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.policies import PolicyStore
from weathra.entitlements.records import CatalogEntry, PlanRecord, PolicyRecord

__all__ = [
    "EntitlementSnapshot",
    "SnapshotCache",
    "SnapshotSource",
    "load_snapshot",
    "validate_override_against_database",
]

logger = logging.getLogger("weathra.entitlements.snapshot")


class EntitlementSnapshot(BaseModel):
    """The catalog, the policies and the plans as they stood at one moment.

    Immutable, and read by everything on the hot path. The accessors below are the whole API: a
    caller that reached into the dictionaries directly would eventually forget that a catalog entry
    can be disabled, which is the single most consequential thing to forget here.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog: Mapping[str, CatalogEntry] = Field(default_factory=dict)
    policies: Mapping[str, PolicyRecord] = Field(default_factory=dict)
    plans: Mapping[str, PlanRecord] = Field(default_factory=dict)
    captured_at: float = Field(description="Monotonic clock reading, for age. Not a wall clock.")

    def entry(self, catalog_key: str) -> CatalogEntry | None:
        """One catalog entry whatever its status — the caller decides what disabled means."""
        return self.catalog.get(catalog_key)

    def enabled_entry(self, catalog_key: str) -> CatalogEntry | None:
        """One catalog entry, only if it may currently be resolved."""
        entry = self.catalog.get(catalog_key)
        return entry if entry is not None and entry.is_enabled else None

    def policy(self, policy_id: str) -> PolicyRecord | None:
        return self.policies.get(str(policy_id))

    def plan(self, plan_code: PlanCode | str) -> PlanRecord | None:
        return self.plans.get(str(plan_code))

    def enabled_candidates(self, policy_id: str, role: CallRole) -> tuple[CatalogEntry, ...]:
        """A policy's candidates that are present, enabled, and fit for *role*, in declared order.

        The order is the policy's, not the catalog's — resolution takes the first of these, so an
        implementation that sorted or set-ified here would quietly change which model serves.
        Returns empty for an unknown policy, or one that does not apply to the role at all; both
        mean "this policy offers nothing for this call", which is the honest answer to give a
        resolver rather than an exception it would have to catch.
        """
        record = self.policy(policy_id)
        if record is None or not record.applies_to(role):
            return ()
        return tuple(
            entry
            for key in record.candidate_catalog_keys
            if (entry := self.enabled_entry(key)) is not None and entry.serves(role)
        )

    def age_seconds(self, *, now: float | None = None) -> float:
        return (time.monotonic() if now is None else now) - self.captured_at

    def is_stale(self, ttl_seconds: float, *, now: float | None = None) -> bool:
        """Whether this snapshot has outlived its documented staleness window.

        A TTL of zero is always stale, which is how a deployment or a test turns the cache off
        without a second flag to keep consistent with this one.
        """
        return self.age_seconds(now=now) >= ttl_seconds


class SnapshotSource(Protocol):
    """Whatever the resolver reads its snapshot from.

    A Protocol rather than the concrete cache, so the resolver can be exercised over fixture
    catalog and policy data with no database at all — which is what task 28.1 asks for, and what
    makes the candidate-walk tests fast enough to be worth writing exhaustively.
    """

    async def current(self, session: AsyncSession) -> EntitlementSnapshot:
        """The snapshot to resolve against, refreshed if the implementation thinks it stale."""
        ...


async def load_snapshot(session: AsyncSession) -> EntitlementSnapshot:
    """Read all three tables once, through the same session and therefore the same transaction.

    One transaction matters: a snapshot assembled from three separately-timed reads could carry a
    policy naming a catalog entry that a concurrent administrative write had already removed, and
    the resolver would see a dangling candidate that never actually existed at any single moment.
    """
    catalog = await CatalogStore(session).list()
    policies = await PolicyStore(session).list()
    plans = await PlanStore(session).list()
    return EntitlementSnapshot(
        catalog={entry.catalog_key: entry for entry in catalog},
        policies={str(record.policy_id): record for record in policies},
        plans={str(plan.plan_code): plan for plan in plans},
        captured_at=time.monotonic(),
    )


async def validate_override_against_database(
    session: AsyncSession, catalog_key: str
) -> CatalogEntry:
    """Confirm an administratively named model is real and enabled, reading the database directly.

    Deliberately not a snapshot read. ``specs/model-catalog`` requires an override naming a model
    absent from the catalog or disabled to be refused with a structured error naming the reason,
    and design.md decision 23 says an override "validates against the database directly, so an
    administrator never acts on a stale allowlist".

    The two refusals are distinct on purpose. "Not in the catalog" and "in the catalog and
    disabled" are different situations for the person reading the error: the first is a typo or a
    model that was never added, the second is a decision somebody made.
    """
    entry = await CatalogStore(session).get(catalog_key)
    if entry is None:
        raise ModelNotAllowlisted(
            f"{catalog_key!r} is not in the model catalog, so it cannot be selected.",
            details={"catalog_key": catalog_key, "reason": "absent"},
        )
    if not entry.is_enabled:
        raise ModelNotAllowlisted(
            f"{catalog_key!r} is in the catalog but disabled, so it cannot be selected.",
            details={"catalog_key": catalog_key, "reason": "disabled"},
        )
    return entry


class SnapshotCache:
    """One snapshot per process, refreshed on a stale read.

    Held by the application lifespan and shared by every request. It takes a *session factory*
    rather than a session, because it outlives any one request's transaction — and the session it
    refreshes from is whichever the caller supplies, so the cache never decides for itself whether
    it is reading privileged or restricted. On the request path it is the restricted one, and Row
    Level Security therefore applies to the refresh exactly as it does to everything else.
    """

    __slots__ = ("_lock", "_refreshes", "_settings", "_snapshot")

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._snapshot: EntitlementSnapshot | None = None
        self._lock = asyncio.Lock()
        self._refreshes = 0

    @property
    def ttl_seconds(self) -> int:
        """The documented staleness window this cache honours."""
        return self._settings.model_catalog_cache_ttl_seconds

    @property
    def refreshes(self) -> int:
        """How many times this process has actually read the three tables.

        Exposed because "the hot path issued no query while the snapshot was fresh" is a property
        worth asserting, and counting refreshes is a far more direct way to assert it than
        instrumenting the database.
        """
        return self._refreshes

    def peek(self) -> EntitlementSnapshot | None:
        """The current snapshot without refreshing it. For diagnostics, never for resolution."""
        return self._snapshot

    def invalidate(self) -> None:
        """Drop the snapshot so the next read refreshes.

        Not an invalidation protocol — there is no message to any other instance, and other
        instances converge on their own TTL. It exists so the process that *made* an
        administrative change does not serve its own stale view back to the administrator who made
        it, which is the one case where the staleness window is indefensible.
        """
        self._snapshot = None

    async def current(self, session: AsyncSession) -> EntitlementSnapshot:
        """The snapshot, refreshed first if it has outlived its TTL."""
        cached = self._snapshot
        if cached is not None and not cached.is_stale(self.ttl_seconds):
            return cached

        async with self._lock:
            # Re-checked inside the lock: a burst on a cold process would otherwise refresh once
            # per waiter, which is exactly the query storm the cache exists to prevent.
            cached = self._snapshot
            if cached is not None and not cached.is_stale(self.ttl_seconds):
                return cached

            refreshed = await load_snapshot(session)
            self._snapshot = refreshed
            self._refreshes += 1
            logger.debug(
                "entitlement snapshot refreshed: %d catalog entries, %d policies, %d plans",
                len(refreshed.catalog),
                len(refreshed.policies),
                len(refreshed.plans),
            )
            return refreshed
