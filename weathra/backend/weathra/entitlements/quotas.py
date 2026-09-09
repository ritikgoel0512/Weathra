"""Allowances, consumption, and the reservation that makes a limit hold under concurrency.

The layer between "which plan is this person on" (``entitlements/plans.py``) and "which model
serves this call" (``entitlements/resolver.py``): whether the call may be made at all.

**One statement is the check and the increment** (design.md decision 25). Reading a counter and
then writing it is two statements with a gap in between, and two requests from one account will
find that gap — both read nine of ten used, both write ten, and the eleventh call happens. So
admission is a single ``INSERT … ON CONFLICT … DO UPDATE … WHERE consumed < allowance``: no row
comes back when the allowance is exhausted, and PostgreSQL serialises the conflicting writers for
us. There is no in-memory counter here at all, deliberately — one would be per-process, and a
second instance would double every allowance.

**A window is a key, not a schedule.** Consumption lives at ``(subject, dimension, window_key)``
where the key is ``2026-09-09`` for a day and ``2026-09`` for a month, derived in
``QUOTA_WINDOW_TIMEZONE``. The boundary passing produces a *different key*, which has no row, which
reads as zero — so a reset needs no cron entry, cannot fail to run, and leaves the closed window's
row in place for anyone asking what last month cost.

**Two kinds of dimension, and the honest difference between them.** A request or a concurrent run
is one unit, known before the call, so it can be reserved. Tokens cannot be: the count does not
exist until the gateway answers. Those are *pre-checked* against the window's consumed total and
settled from the recorded usage events afterwards, which admits an overshoot of at most one
request's tokens past a monthly ceiling. Decision 25 states that trade rather than presenting the
ceiling as exact, and so does this module.

**A dimension a plan declares no row for is unlimited.** Absence has to mean absence: a default of
zero here would silently refuse every request on a plan somebody forgot to configure, which is the
kind of failure that looks like a bug in the gateway.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.domain.entitlements import PlanCode
from weathra.domain.errors import QuotaExceeded, QuotaUnavailable
from weathra.domain.identity import Principal
from weathra.domain.usage import (
    INTERNAL_SUBJECT,
    QuotaDimension,
    QuotaWindow,
    SubjectKind,
    WindowKey,
)
from weathra.entitlements.administration import is_administrative

__all__ = [
    "ADMISSION_ORDER",
    "Admission",
    "AllowanceSet",
    "DimensionUsage",
    "QuotaGate",
    "QuotaStore",
    "QuotaSubject",
    "Reservation",
    "StoreFactory",
    "UsageReport",
    "reset_at",
    "stores_over",
]

logger = logging.getLogger("weathra.entitlements.quotas")

# Where the gate gets a store, which is to say a session with the statements wrapped round it.
# A factory rather than one store, because **a reservation may not
# live inside the request's transaction**, and that is the single most consequential fact about
# this module's plumbing.
#
# The request path runs one transaction per request and rolls it back on any failure. A counter
# incremented inside it would be invisible to every other request until the response was written —
# so two concurrent questions would each read zero in flight and both be admitted — and the row
# lock the increment takes would be held for the whole run, serialising one account's requests
# behind each other for seconds at a time. So each quota operation opens its own short session,
# commits, and closes. It is still the *restricted* session with the caller's claims bound, so the
# owner policy on `usage_counters` applies to it exactly as it does to everything else.
StoreFactory = Callable[[], AbstractAsyncContextManager["QuotaStore"]]

# The order dimensions are evaluated in. The two that cannot be reserved come first, so a refusal
# on one of them costs nothing to unwind; the reservable ones follow narrowest window first, and
# concurrency last because it is the only one released on the way out of every run.
ADMISSION_ORDER: Final[tuple[QuotaDimension, ...]] = (
    QuotaDimension.TOKENS_PER_MONTH,
    QuotaDimension.ESTIMATED_COST_PER_MONTH,
    QuotaDimension.REQUESTS_PER_DAY,
    QuotaDimension.REQUESTS_PER_MONTH,
    QuotaDimension.CONCURRENT_RUNS,
)

# How long a caller waits for each window to turn over, as a rank. When several dimensions bind at
# once the refusal names the highest — `specs/usage-limits` asks for the *most restrictive* one,
# and the most restrictive is the one the caller waits longest on. A concurrency limit clears when
# a run finishes; a daily one at midnight; a monthly one not until the month does.
_RESTRICTIVENESS: Final[dict[QuotaWindow, int]] = {
    QuotaWindow.CONCURRENT: 0,
    QuotaWindow.DAY: 1,
    QuotaWindow.MONTH: 2,
}


# =========================================================================== windows


def reset_at(window: QuotaWindow, moment: datetime, zone: tzinfo) -> datetime | None:
    """When *window*'s current period ends, as an instant in UTC.

    ``None`` for concurrency, which has no period: it is a gauge, and it falls the moment a run
    finishes rather than at a boundary. Returning zero or the epoch instead would put a reset time
    in a refusal that no clock will ever reach.

    The zone is a parameter for the same reason as in ``WindowKey.for_window``: a boundary computed
    from the server's local time depends on where the process happens to run, and two instances
    disagreeing about whether it is still Tuesday is a bug found by a customer.
    """
    if window is QuotaWindow.CONCURRENT:
        return None
    if moment.tzinfo is None:
        raise ValueError("A reset time needs an aware instant to compute the boundary from.")

    local = moment.astimezone(zone)
    if window is QuotaWindow.DAY:
        boundary = local.date() + timedelta(days=1)
    else:
        year, month = local.year, local.month
        boundary = date(year + month // 12, month % 12 + 1, 1)
    # `time.min` in the configured zone. In the handful of zones whose clocks jump *at* midnight
    # that instant does not exist on some days; `astimezone` normalises it forward, which is the
    # behaviour we want — the window ends when the day does, whatever the offset did.
    return datetime.combine(boundary, time.min, tzinfo=zone).astimezone(UTC)


# =========================================================================== who is being counted


@dataclass(frozen=True, slots=True)
class QuotaSubject:
    """Whose allowance a call is accounted against, and under which plan.

    Two things that are not the same question. An administrator asking a product question as
    themselves has a real ``user_id`` and a real plan, and is still counted as ``internal`` —
    ``specs/usage-limits`` accounts administrative traffic against the internal allowance so that a
    person doing their job cannot spend the entitlement of the account they are logged in as, and
    so that internal usage stays reportable apart from product usage.

    ``plan`` is ``None`` for the internal subject and not "the plan they would have had": the
    internal allowance is keyed by the reserved subject, and carrying a plan alongside it would
    invite a reader to think one of them is a fallback for the other.
    """

    key: str
    kind: SubjectKind
    plan: PlanCode | None = None

    @property
    def is_internal(self) -> bool:
        return self.kind is SubjectKind.INTERNAL

    @classmethod
    def internal(cls) -> QuotaSubject:
        """The reserved subject every internal path is counted against."""
        return cls(key=INTERNAL_SUBJECT, kind=SubjectKind.INTERNAL, plan=None)

    @classmethod
    def for_principal(cls, principal: Principal, plan: PlanCode) -> QuotaSubject:
        """The subject *principal* is counted as, on *plan*.

        The internal classification is derived from the validated token here rather than passed in
        by the caller, which is what makes "internal by construction rather than by a flag" true:
        there is no argument a route could get wrong, and no path that can opt a product request
        out of its own plan's accounting.
        """
        if is_administrative(principal):
            return cls.internal()
        return cls(key=principal.user_id, kind=SubjectKind.USER, plan=plan)


# =========================================================================== allowances


@dataclass(frozen=True, slots=True)
class AllowanceSet:
    """What one subject may consume, per dimension. Absence means unlimited.

    A frozen mapping rather than a row per dimension with a nullable number, because "no row" and
    "a row saying null" would be two spellings of the same thing and somebody would eventually
    write the second one meaning zero.
    """

    subject: str
    limits: Mapping[QuotaDimension, int] = field(default_factory=dict)

    def limit(self, dimension: QuotaDimension) -> int | None:
        """The allowance for *dimension*, or ``None`` where the subject is unlimited in it."""
        return self.limits.get(dimension)

    def bounded(self) -> tuple[QuotaDimension, ...]:
        """The dimensions that actually bind, in evaluation order."""
        return tuple(item for item in ADMISSION_ORDER if item in self.limits)


@dataclass(frozen=True, slots=True)
class DimensionUsage:
    """One dimension as a caller may see it: what they have, what they used, when it turns over."""

    dimension: QuotaDimension
    window: QuotaWindow
    window_key: WindowKey
    allowance: int | None
    consumed: int
    resets_at: datetime | None

    @property
    def remaining(self) -> int | None:
        """What is left, or ``None`` where the dimension is unlimited. Never negative."""
        if self.allowance is None:
            return None
        return max(self.allowance - self.consumed, 0)

    @property
    def is_exhausted(self) -> bool:
        return self.allowance is not None and self.consumed >= self.allowance


@dataclass(frozen=True, slots=True)
class UsageReport:
    """A subject's whole standing at one moment. What the own-usage endpoint reports."""

    subject: QuotaSubject
    dimensions: tuple[DimensionUsage, ...]

    def by_dimension(self, dimension: QuotaDimension) -> DimensionUsage | None:
        return next((item for item in self.dimensions if item.dimension is dimension), None)


# =========================================================================== reservations


@dataclass(frozen=True, slots=True)
class Reservation:
    """One unit taken from one dimension's counter, and the coordinates to give it back."""

    subject: str
    dimension: QuotaDimension
    window_key: WindowKey


@dataclass(slots=True)
class Admission:
    """A call that was let through, and the reservations that let it.

    Two groups, released on different occasions and never together:

    * ``requests`` are given back only when the run fails *before* any gateway call — the request
      was admitted and then cost nothing, so it should not have been counted. Once a model has
      answered, the request is spent whatever happens next.
    * ``concurrency`` is given back at the end of every run, successful or not. It is a gauge of
      what is in flight, and a run that raised is no longer in flight.
    """

    subject: QuotaSubject
    requests: tuple[Reservation, ...] = ()
    concurrency: Reservation | None = None
    windows: Mapping[QuotaDimension, WindowKey] = field(default_factory=dict)
    _requests_released: bool = False
    _concurrency_released: bool = False

    async def release_requests(self, store: QuotaStore) -> None:
        """Give the request reservations back. Idempotent, because a caller may unwind twice."""
        if self._requests_released:
            return
        self._requests_released = True
        for reservation in self.requests:
            await store.release(reservation)

    async def release_concurrency(self, store: QuotaStore) -> None:
        """Give the concurrency slot back. Called from a ``finally``, so it must never raise."""
        if self._concurrency_released or self.concurrency is None:
            return
        self._concurrency_released = True
        try:
            await store.release(self.concurrency)
        except SQLAlchemyError as failure:
            # A leaked slot recovers when the window's row is next corrected; an exception here
            # would replace a perfectly good answer with a 500 raised on the way out of it.
            logger.warning(
                "could not release the concurrency slot for %s: %s",
                self.subject.kind.value,
                type(failure).__name__,
            )


# =========================================================================== the store


class QuotaStore:
    """Reads allowances and reads, reserves, releases and settles consumption.

    Every statement is scoped to one subject and runs on whatever session it is given — which on
    the request path is the *restricted* one, so the owner policy on ``usage_counters`` applies to
    a quota write exactly as it does to any other. Nothing here opens a connection of its own.
    """

    __slots__ = ("_session", "_zone")

    def __init__(self, session: AsyncSession, *, zone: tzinfo) -> None:
        self._session = session
        self._zone = zone

    # ---------------------------------------------------------------- allowances

    async def allowances(self, subject: QuotaSubject) -> AllowanceSet:
        """The allowance rows in force for *subject*, read fresh.

        Not served from the entitlement snapshot, and that is deliberate. ``specs/usage-limits``
        requires an allowance raised mid-window to admit the caller for the remainder of it; a
        cached copy would make that true only after the cache expired, which is a different
        promise. This is one indexed read on a table with a handful of rows.
        """
        rows = await self._session.execute(
            text(
                "SELECT dimension, allowance "
                "  FROM usage_limits "
                " WHERE coalesce(plan_code, internal_subject) = CAST(:subject AS text)"
            ),
            {"subject": self._allowance_key(subject)},
        )
        limits: dict[QuotaDimension, int] = {}
        for name, allowance in rows:
            try:
                limits[QuotaDimension(name)] = int(allowance)
            except ValueError:
                # A dimension this build does not know about. Skipping it is the only safe reading:
                # enforcing an allowance whose meaning is unknown would be enforcing a guess.
                logger.warning("ignoring an allowance for an unknown dimension: %s", name)
        return AllowanceSet(subject=subject.key, limits=limits)

    @staticmethod
    def _allowance_key(subject: QuotaSubject) -> str:
        """Which row in ``usage_limits`` holds this subject's allowances.

        A product subject's allowances belong to their *plan*, not to them — an allowance per
        person would be an entitlement store, and there already is one.
        """
        if subject.is_internal:
            return INTERNAL_SUBJECT
        if subject.plan is None:
            raise ValueError("A product subject must carry the plan its allowances come from.")
        return subject.plan.value

    # ---------------------------------------------------------------- consumption

    async def consumed(self, subject: str, dimension: QuotaDimension, window: WindowKey) -> int:
        """What has been used in one window. Absent means zero, which is what a new window is."""
        value = await self._session.scalar(
            text(
                "SELECT consumed FROM usage_counters "
                " WHERE subject = :subject AND dimension = :dimension AND window_key = :window"
            ),
            {"subject": subject, "dimension": dimension.value, "window": str(window)},
        )
        return int(value or 0)

    async def consumption(
        self, subject: str, windows: Mapping[QuotaDimension, WindowKey]
    ) -> dict[QuotaDimension, int]:
        """Every dimension's consumption in one read, for the report."""
        if not windows:
            return {}
        rows = await self._session.execute(
            text(
                "SELECT dimension, window_key, consumed FROM usage_counters "
                " WHERE subject = :subject"
            ),
            {"subject": subject},
        )
        found = {(str(row[0]), str(row[1])): int(row[2]) for row in rows}
        return {
            dimension: found.get((dimension.value, str(window)), 0)
            for dimension, window in windows.items()
        }

    # ---------------------------------------------------------------- the atomic admission

    async def reserve(
        self,
        subject: str,
        dimension: QuotaDimension,
        window: WindowKey,
        allowance: int,
        *,
        amount: int = 1,
    ) -> int | None:
        """Take *amount* from a dimension if the allowance permits, atomically.

        The consumed total afterwards, or ``None`` when the allowance is already reached. The check
        and the increment are one statement, so two concurrent callers cannot both see the last
        unit: PostgreSQL takes the row lock for the second one and re-evaluates the ``WHERE``
        against what the first one wrote.

        An allowance smaller than the amount asked for is refused here rather than by the
        statement, and the difference is not cosmetic: the ``WHERE`` guards the *update* branch
        only, so the first call of a window would insert its row and be admitted past a limit of
        nothing.
        """
        if amount <= 0 or allowance < amount:
            return None
        result = await self._session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:subject, :dimension, :window, :amount) "
                "ON CONFLICT (subject, dimension, window_key) DO UPDATE "
                "   SET consumed = usage_counters.consumed + :amount, updated_at = now() "
                " WHERE usage_counters.consumed + :amount <= :allowance "
                "RETURNING consumed"
            ),
            {
                "subject": subject,
                "dimension": dimension.value,
                "window": str(window),
                "amount": amount,
                "allowance": allowance,
            },
        )
        row = result.first()
        return int(row[0]) if row is not None else None

    async def release(self, reservation: Reservation, *, amount: int = 1) -> None:
        """Give a reserved unit back, never below zero.

        ``greatest(…, 0)`` rather than a bare subtraction because a double release is a bug that
        should not be able to manufacture allowance out of a negative counter.
        """
        await self._session.execute(
            text(
                "UPDATE usage_counters "
                "   SET consumed = greatest(consumed - :amount, 0), updated_at = now() "
                " WHERE subject = :subject AND dimension = :dimension AND window_key = :window"
            ),
            {
                "subject": reservation.subject,
                "dimension": reservation.dimension.value,
                "window": str(reservation.window_key),
                "amount": amount,
            },
        )

    async def forget_stale(
        self,
        subject: str,
        dimension: QuotaDimension,
        window: WindowKey,
        *,
        older_than_seconds: float,
    ) -> int:
        """Zero a counter nothing has touched for *older_than_seconds*, and say how much it held.

        Only ever called for the concurrency gauge, which is the one dimension with no boundary to
        clear it: a process killed mid-run leaves its slot held, and nothing would ever give it
        back. The threshold is chosen by the caller from a run's own maximum duration, so a row
        this collects belonged to a run that provably cannot still be going.
        """
        result = await self._session.execute(
            text(
                "UPDATE usage_counters SET consumed = 0, updated_at = now() "
                " WHERE subject = :subject AND dimension = :dimension AND window_key = :window "
                "   AND consumed > 0 "
                "   AND updated_at < now() - make_interval(secs => :age) "
                "RETURNING consumed"
            ),
            {
                "subject": subject,
                "dimension": dimension.value,
                "window": str(window),
                "age": float(older_than_seconds),
            },
        )
        return len(result.all())

    async def settle(
        self, subject: str, dimension: QuotaDimension, window: WindowKey, amount: int
    ) -> int:
        """Add *amount* to a counter unconditionally, after the fact.

        For the dimensions that cannot be reserved: the tokens a call used are known only once it
        has answered, so they are added here rather than checked here. Adding zero is a no-op
        rather than a row of zero, so a call the gateway reported no tokens for leaves no trace
        claiming it used none.
        """
        if amount <= 0:
            return await self.consumed(subject, dimension, window)
        result = await self._session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:subject, :dimension, :window, :amount) "
                "ON CONFLICT (subject, dimension, window_key) DO UPDATE "
                "   SET consumed = usage_counters.consumed + :amount, updated_at = now() "
                "RETURNING consumed"
            ),
            {
                "subject": subject,
                "dimension": dimension.value,
                "window": str(window),
                "amount": amount,
            },
        )
        row = result.first()
        return int(row[0]) if row is not None else 0

    # ---------------------------------------------------------------- reconciliation

    async def recorded_usage(self, subject: QuotaSubject, window: WindowKey) -> dict[str, int]:
        """Requests and tokens for one month, counted from the usage events themselves.

        The reconciliation ``specs/usage-limits`` asks for: the counters and the event record must
        not disagree. A *request* is one HTTP request, not one call — a question whose structured
        call retried twice is one request and three events — so events are counted distinctly by
        ``request_id`` while tokens are summed across every attempt.

        Grouped by ``request_id`` rather than by ``agent_run_id``: the run identifier is written
        only where a run was persisted, and an event whose correlation identifier is missing
        cannot be grouped with anything, so it counts as its own request rather than silently
        joining every other ungrouped event into one.
        """
        owner = (
            "user_id IS NULL OR subject_kind = 'internal'"
            if subject.is_internal
            else "user_id = CAST(:subject AS uuid) AND subject_kind = 'user'"
        )
        row = (
            await self._session.execute(
                text(
                    "SELECT count(DISTINCT coalesce(request_id, event_id::text)) AS requests, "
                    "       coalesce(sum(total_tokens), 0) AS tokens "
                    "  FROM llm_usage_events "
                    f" WHERE ({owner}) "
                    "   AND to_char(created_at AT TIME ZONE :zone, :pattern) = :window"
                ),
                {
                    "subject": subject.key,
                    "zone": str(self._zone),
                    "pattern": "YYYY-MM",
                    "window": str(window),
                },
            )
        ).first()
        if row is None:
            return {"requests": 0, "tokens": 0}
        return {"requests": int(row[0] or 0), "tokens": int(row[1] or 0)}


def stores_over(
    sessions: Callable[[], AbstractAsyncContextManager[AsyncSession]], *, zone: tzinfo
) -> StoreFactory:
    """Turn a session factory into a store factory. What the API dependency composes with.

    The gate is given stores rather than sessions so that it has no opinion about connections at
    all — which is also what lets it be exercised over a store that never opens one.
    """

    @asynccontextmanager
    async def factory() -> AsyncIterator[QuotaStore]:
        async with sessions() as session:
            yield QuotaStore(session, zone=zone)

    return factory


# =========================================================================== the gate


class QuotaGate:
    """Decides whether one call may be made, and takes what it costs while deciding.

    The whole gate is two passes. The first *reads* every bounded dimension and refuses if any is
    already exhausted — which is where the refusal gets an honest allowance, consumption and reset
    time to name, and where the un-reservable token dimension is enforced at all. The second
    *reserves* the countable ones atomically, which is what holds under concurrency; a reservation
    that comes back empty means somebody else took the last unit between the two passes, and the
    refusal is the same refusal.

    Each pass runs in its own committed transaction — see ``SessionFactory`` for why that is not an
    implementation detail.

    Nothing here decides which model serves the call. The gate runs first and answers one question:
    whether there is to be a call.
    """

    __slots__ = ("_settings", "_stores")

    def __init__(self, stores: StoreFactory, settings: Settings) -> None:
        self._stores = stores
        self._settings = settings

    @property
    def enabled(self) -> bool:
        return self._settings.quota_enabled

    def windows(self, moment: datetime) -> dict[QuotaDimension, WindowKey]:
        """The window key each dimension is counted under at *moment*."""
        zone = self._settings.quota_zone
        return {
            dimension: WindowKey.for_dimension(dimension, moment, zone)
            for dimension in QuotaDimension
        }

    # ---------------------------------------------------------------- admission

    async def admit(self, subject: QuotaSubject, *, moment: datetime | None = None) -> Admission:
        """Let one call through, or refuse it.

        Raises ``QuotaExceeded`` naming the bound dimension, and ``QuotaUnavailable`` when the
        store could not answer — which is a refusal too, because admitting an unaccounted call
        during an outage is how a store problem becomes an unmetered gateway bill.
        """
        now = moment or datetime.now(UTC)
        windows = self.windows(now)
        if not self.enabled:
            # Still a real `Admission`, with no reservations to give back. The caller's release and
            # settle calls then do nothing, so the disabled path exercises the same code shape.
            return Admission(subject=subject, windows=windows)

        try:
            async with self._stores() as store:
                allowances = await store.allowances(subject)
                # Before the read pass, not inside the reservation: a slot a killed process never
                # released reads as consumption, so a gauge left full would refuse the caller here
                # and the collection below would never be reached. Found exactly that way.
                if QuotaDimension.CONCURRENT_RUNS in allowances.limits:
                    await self._forget_abandoned_runs(
                        store, subject, windows[QuotaDimension.CONCURRENT_RUNS]
                    )
                bound = await self._binding(store, subject, allowances, windows, now)
                if bound is None:
                    return await self._reserve_all(store, subject, allowances, windows, now)
        except QuotaExceeded:
            raise
        except (SQLAlchemyError, OSError) as failure:
            raise self._unavailable(subject, failure) from failure
        raise self._exceeded(bound)

    async def _binding(
        self,
        store: QuotaStore,
        subject: QuotaSubject,
        allowances: AllowanceSet,
        windows: Mapping[QuotaDimension, WindowKey],
        now: datetime,
    ) -> DimensionUsage | None:
        """The dimension that refuses this call, or ``None``.

        Every bounded dimension is read, not just up to the first that binds, so that when several
        are exhausted the one named is the most restrictive rather than the first in the list.
        """
        exhausted: list[DimensionUsage] = []
        for dimension in allowances.bounded():
            usage = await self._usage(store, subject, dimension, allowances, windows, now)
            if usage.is_exhausted:
                exhausted.append(usage)
        if not exhausted:
            return None
        return max(exhausted, key=lambda item: _RESTRICTIVENESS[item.window])

    async def _reserve_all(
        self,
        store: QuotaStore,
        subject: QuotaSubject,
        allowances: AllowanceSet,
        windows: Mapping[QuotaDimension, WindowKey],
        now: datetime,
    ) -> Admission:
        """Take one unit from each reservable dimension, unwinding everything if one refuses."""
        taken: list[Reservation] = []
        concurrency: Reservation | None = None

        for dimension in allowances.bounded():
            if not dimension.is_reservable:
                continue
            allowance = allowances.limit(dimension)
            assert allowance is not None  # `bounded()` returns only dimensions with a limit
            window = windows[dimension]
            consumed = await store.reserve(subject.key, dimension, window, allowance)
            if consumed is None:
                # Somebody took the last unit between the read and here. Give back everything this
                # attempt reserved before refusing, or a losing racer would leave the winner short
                # by the dimensions it got through first.
                for reservation in (*taken, *(item for item in (concurrency,) if item)):
                    await store.release(reservation)
                raise self._exceeded(
                    await self._usage(store, subject, dimension, allowances, windows, now)
                )
            reservation = Reservation(subject.key, dimension, window)
            if dimension is QuotaDimension.CONCURRENT_RUNS:
                concurrency = reservation
            else:
                taken.append(reservation)

        return Admission(
            subject=subject,
            requests=tuple(taken),
            concurrency=concurrency,
            windows=dict(windows),
        )

    async def _forget_abandoned_runs(
        self, store: QuotaStore, subject: QuotaSubject, window: WindowKey
    ) -> None:
        """Zero a concurrency gauge nothing has touched for longer than a run can last.

        The one failure mode a ``finally`` cannot cover: a process killed mid-run never releases
        its slot, and a gauge with no reset boundary would carry that leak forever — an account
        that crashed as many times as its concurrency allowance would be permanently refused.

        The threshold is the agent's own wall-clock budget with a margin, so it can only ever
        collect a slot whose run has provably ended. A live run refreshes ``updated_at`` when it
        reserves, so it is never the row being collected.
        """
        await store.forget_stale(
            subject.key,
            QuotaDimension.CONCURRENT_RUNS,
            window,
            older_than_seconds=self._settings.agent_wall_clock_budget_seconds * 2,
        )

    # ---------------------------------------------------------------- finishing a run

    async def finish(
        self, admission: Admission, *, tokens: int = 0, reached_gateway: bool = True
    ) -> None:
        """Close out a run: give back what it did not use, and record what it did.

        One session for both, because they happen at the same moment and neither is worth a second
        connection. Never raises: this runs after the answer exists, and a bookkeeping failure that
        turned a good answer into a 500 would be a worse bug than the one it reported.

        *reached_gateway* is the distinction ``specs/usage-limits`` draws. A run that failed before
        any model was called cost nothing and gives its request reservations back; a run that
        failed after one did is a request that happened, and stays counted.
        """
        if not self.enabled:
            return
        try:
            async with self._stores() as store:
                if not reached_gateway:
                    await admission.release_requests(store)
                await admission.release_concurrency(store)
                if tokens > 0:
                    window = admission.windows.get(QuotaDimension.TOKENS_PER_MONTH)
                    if window is not None:
                        await store.settle(
                            admission.subject.key,
                            QuotaDimension.TOKENS_PER_MONTH,
                            window,
                            tokens,
                        )
        except (SQLAlchemyError, OSError) as failure:
            # The pre-check on the next request reads whatever did get written, so the ceiling
            # still holds — one request later than it should have, which is the bounded overshoot
            # decision 25 already documents rather than a new hole.
            logger.warning(
                "could not settle the quota for a %s subject: %s",
                admission.subject.kind.value,
                type(failure).__name__,
            )

    # ---------------------------------------------------------------- reporting

    async def report(self, subject: QuotaSubject, *, moment: datetime | None = None) -> UsageReport:
        """Every dimension's standing for *subject*. What the caller's own usage endpoint returns.

        Unlimited dimensions are included with a null allowance rather than omitted, so a client
        can tell "this plan does not limit tokens" from "this build forgot to report tokens".
        """
        now = moment or datetime.now(UTC)
        windows = self.windows(now)
        async with self._stores() as store:
            allowances = await store.allowances(subject)
            consumption = await store.consumption(subject.key, windows)
        return UsageReport(
            subject=subject,
            dimensions=tuple(
                DimensionUsage(
                    dimension=dimension,
                    window=dimension.window,
                    window_key=windows[dimension],
                    allowance=allowances.limit(dimension),
                    consumed=consumption.get(dimension, 0),
                    resets_at=reset_at(dimension.window, now, self._settings.quota_zone),
                )
                for dimension in ADMISSION_ORDER
            ),
        )

    # ---------------------------------------------------------------- refusals

    async def _usage(
        self,
        store: QuotaStore,
        subject: QuotaSubject,
        dimension: QuotaDimension,
        allowances: AllowanceSet,
        windows: Mapping[QuotaDimension, WindowKey],
        now: datetime,
    ) -> DimensionUsage:
        window = windows[dimension]
        return DimensionUsage(
            dimension=dimension,
            window=dimension.window,
            window_key=window,
            allowance=allowances.limit(dimension),
            consumed=await store.consumed(subject.key, dimension, window),
            resets_at=reset_at(dimension.window, now, self._settings.quota_zone),
        )

    @staticmethod
    def _exceeded(usage: DimensionUsage) -> QuotaExceeded:
        """The refusal, naming what bound and when it lifts.

        Names the dimension, the allowance, the consumption and the reset — and nothing else. No
        plan internals, no other subject, no pricing, no counter or column name: a caller learns
        their own standing and the shape of the limit, which is what makes the refusal actionable
        without making it a disclosure.
        """
        resets = usage.resets_at
        details: dict[str, Any] = {
            "dimension": usage.dimension.value,
            "window": usage.window.value,
            "allowance": usage.allowance,
            "consumed": usage.consumed,
            "resets_at": resets.isoformat() if resets else None,
        }
        if resets is not None:
            details["retry_after_seconds"] = max(
                int((resets - datetime.now(UTC)).total_seconds()), 1
            )
        return QuotaExceeded(_REFUSAL_MESSAGE[usage.window], details=details)

    @staticmethod
    def _unavailable(subject: QuotaSubject, failure: Exception) -> QuotaUnavailable:
        """Fail closed, and tell an operator — the two halves `specs/usage-limits` asks for.

        The log line is the operator report: it names the subject *kind* and the exception type,
        which is enough to find the incident, and neither the subject's identity nor the driver's
        message, which may carry a statement and its parameters.
        """
        logger.error(
            "quota accounting is unavailable for a %s subject; failing closed: %s",
            subject.kind.value,
            type(failure).__name__,
        )
        return QuotaUnavailable(
            "Your usage allowance could not be checked just now, so the request was not made. "
            "This is a temporary problem on our side — please try again shortly."
        )


# What a person reads when they are refused. One sentence per window, because "quota exceeded" is
# not a sentence and the reset time in `details` is not where a person looks first.
_REFUSAL_MESSAGE: Final[dict[QuotaWindow, str]] = {
    QuotaWindow.DAY: (
        "You have used today's allowance of agent questions. It resets at the start of the next "
        "day. Forecasts, history, comparisons and analysis are unaffected."
    ),
    QuotaWindow.MONTH: (
        "You have used this month's allowance. It resets at the start of the next month. "
        "Forecasts, history, comparisons and analysis are unaffected."
    ),
    QuotaWindow.CONCURRENT: (
        "You already have as many questions in flight as your plan allows. Wait for one to finish "
        "and ask again."
    ),
}
