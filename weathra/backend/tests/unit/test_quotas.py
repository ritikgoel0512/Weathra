"""Tasks 30.1, 30.2, 30.5, 30.8 — the allowance layer, without a database.

What can be proved here is everything that is arithmetic or policy rather than concurrency: window
derivation across a real boundary in a configured zone, what "unset means unlimited" does, which
dimension a refusal names when several bind, who is counted as internal, and what happens when the
store will not answer. The reservation itself needs PostgreSQL to mean anything and is proved in
``integration/test_quota_enforcement.py``; a fake store here could only prove that the fake works.

The store is faked *at the store*, not at the session, deliberately. A fake session would mean
asserting against SQL strings, which passes when the statement is wrong in an interesting way.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import cast
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.exc import OperationalError

from tests.db_support import claims_for
from weathra.config import Settings
from weathra.domain.entitlements import PRODUCT_PLAN_CODES, PlanCode
from weathra.domain.errors import QuotaExceeded, QuotaUnavailable
from weathra.domain.identity import Principal
from weathra.domain.usage import (
    INTERNAL_SUBJECT,
    QuotaDimension,
    QuotaWindow,
    SubjectKind,
    WindowKey,
)
from weathra.entitlements.quotas import (
    ADMISSION_ORDER,
    Admission,
    AllowanceSet,
    DimensionUsage,
    QuotaGate,
    QuotaStore,
    QuotaSubject,
    Reservation,
    reset_at,
)

BERLIN = ZoneInfo("Europe/Berlin")
UTC_ZONE = ZoneInfo("UTC")


def settings_for(**overrides: object) -> Settings:
    return Settings(
        supabase_url="https://test.supabase.co",
        database_url="postgresql+asyncpg://u:p@localhost/weathra",
        **overrides,  # type: ignore[arg-type]
    )


# =========================================================================== 30.1 windows


@pytest.mark.parametrize(
    ("moment", "zone", "expected"),
    [
        # 22:30 UTC on the 9th is already the 10th in Berlin, which is the whole point of the zone
        # being configured rather than assumed: two instances in different regions must agree, and
        # they only do if both ask the same named zone.
        (datetime(2026, 9, 9, 22, 30, tzinfo=UTC), BERLIN, "2026-09-10"),
        (datetime(2026, 9, 9, 22, 30, tzinfo=UTC), UTC_ZONE, "2026-09-09"),
        (datetime(2026, 9, 9, 21, 59, tzinfo=UTC), BERLIN, "2026-09-09"),
        # And the month key turns over with the day it belongs to.
        (datetime(2026, 9, 30, 22, 30, tzinfo=UTC), BERLIN, "2026-10-01"),
    ],
)
def test_the_day_key_is_derived_in_the_configured_zone(
    moment: datetime, zone: ZoneInfo, expected: str
) -> None:
    assert WindowKey.for_window(QuotaWindow.DAY, moment, zone) == expected


def test_the_month_key_follows_the_same_boundary() -> None:
    late = datetime(2026, 9, 30, 22, 30, tzinfo=UTC)
    assert WindowKey.for_window(QuotaWindow.MONTH, late, BERLIN) == "2026-10"
    assert WindowKey.for_window(QuotaWindow.MONTH, late, UTC_ZONE) == "2026-09"


def test_concurrency_has_one_key_because_it_has_no_window() -> None:
    """A gauge, not a period. Two moments a month apart share the row."""
    first = WindowKey.for_window(QuotaWindow.CONCURRENT, datetime(2026, 9, 9, tzinfo=UTC), BERLIN)
    later = WindowKey.for_window(QuotaWindow.CONCURRENT, datetime(2026, 10, 9, tzinfo=UTC), BERLIN)
    assert first == later == "current"


def test_a_naive_instant_is_refused_rather_than_guessed_at() -> None:
    with pytest.raises(ValueError, match="aware instant"):
        WindowKey.for_window(QuotaWindow.DAY, datetime(2026, 9, 9, 12, 0), BERLIN)


@pytest.mark.parametrize(
    ("window", "moment", "zone", "expected"),
    [
        (
            QuotaWindow.DAY,
            datetime(2026, 9, 9, 12, 0, tzinfo=UTC),
            UTC_ZONE,
            datetime(2026, 9, 10, 0, 0, tzinfo=UTC),
        ),
        # Berlin is two hours ahead in September, so its midnight is 22:00 UTC the day before.
        (
            QuotaWindow.DAY,
            datetime(2026, 9, 9, 12, 0, tzinfo=UTC),
            BERLIN,
            datetime(2026, 9, 9, 22, 0, tzinfo=UTC),
        ),
        (
            QuotaWindow.MONTH,
            datetime(2026, 12, 31, 12, 0, tzinfo=UTC),
            UTC_ZONE,
            datetime(2027, 1, 1, 0, 0, tzinfo=UTC),
        ),
    ],
)
def test_the_reset_time_is_the_next_boundary_in_the_configured_zone(
    window: QuotaWindow, moment: datetime, zone: ZoneInfo, expected: datetime
) -> None:
    assert reset_at(window, moment, zone) == expected


def test_the_year_rolls_over_rather_than_producing_a_thirteenth_month() -> None:
    assert reset_at(QuotaWindow.MONTH, datetime(2026, 12, 5, tzinfo=UTC), UTC_ZONE) == datetime(
        2027, 1, 1, tzinfo=UTC
    )


def test_concurrency_has_no_reset_time_rather_than_a_fake_one() -> None:
    """Null, not the epoch and not zero: no clock will ever reach a boundary that does not exist."""
    assert reset_at(QuotaWindow.CONCURRENT, datetime(2026, 9, 9, tzinfo=UTC), UTC_ZONE) is None


def test_the_configured_zone_must_be_one_the_platform_knows() -> None:
    """A boot failure naming the variable, rather than a 500 on somebody's first question."""
    with pytest.raises(ValueError, match="QUOTA_WINDOW_TIMEZONE"):
        settings_for(quota_window_timezone="Mars/Olympus_Mons")


def test_the_zone_is_resolved_once_and_reads_back_as_a_zone() -> None:
    assert settings_for(quota_window_timezone="Europe/Berlin").quota_zone == BERLIN


# =========================================================================== 30.1 allowances


def test_a_dimension_with_no_row_is_unlimited_rather_than_zero() -> None:
    """The distinction the whole model turns on: a plan nobody configured must not refuse
    everything."""
    allowances = AllowanceSet(subject="free", limits={QuotaDimension.REQUESTS_PER_DAY: 25})
    assert allowances.limit(QuotaDimension.REQUESTS_PER_DAY) == 25
    assert allowances.limit(QuotaDimension.TOKENS_PER_MONTH) is None
    assert allowances.bounded() == (QuotaDimension.REQUESTS_PER_DAY,)


def test_the_cost_budget_is_expressible_without_restructuring_anything() -> None:
    """`specs/usage-limits`: the model must *admit* a cost budget. Same set, same mechanism, no
    new type — which is what "without restructuring" has to mean to be checkable."""
    allowances = AllowanceSet(
        subject="premium", limits={QuotaDimension.ESTIMATED_COST_PER_MONTH: 50}
    )
    assert allowances.limit(QuotaDimension.ESTIMATED_COST_PER_MONTH) == 50
    assert QuotaDimension.ESTIMATED_COST_PER_MONTH in ADMISSION_ORDER
    assert QuotaDimension.ESTIMATED_COST_PER_MONTH.window is QuotaWindow.MONTH


def test_every_dimension_is_evaluated_and_none_is_evaluated_twice() -> None:
    assert set(ADMISSION_ORDER) == set(QuotaDimension)
    assert len(ADMISSION_ORDER) == len(set(ADMISSION_ORDER))


def test_the_unreservable_dimensions_are_evaluated_before_the_reservable_ones() -> None:
    """So a refusal on tokens costs no reservation to unwind."""
    reservable = [index for index, item in enumerate(ADMISSION_ORDER) if item.is_reservable]
    unreservable = [index for index, item in enumerate(ADMISSION_ORDER) if not item.is_reservable]
    assert max(unreservable) < min(reservable)


def test_remaining_never_goes_negative_and_is_null_when_unlimited() -> None:
    over = DimensionUsage(
        dimension=QuotaDimension.REQUESTS_PER_DAY,
        window=QuotaWindow.DAY,
        window_key=WindowKey("2026-09-09"),
        allowance=5,
        consumed=9,
        resets_at=None,
    )
    assert over.remaining == 0
    assert over.is_exhausted

    unlimited = DimensionUsage(
        dimension=QuotaDimension.TOKENS_PER_MONTH,
        window=QuotaWindow.MONTH,
        window_key=WindowKey("2026-09"),
        allowance=None,
        consumed=1_000_000,
        resets_at=None,
    )
    assert unlimited.remaining is None
    assert not unlimited.is_exhausted


# =========================================================================== 30.5 who is counted


def test_an_ordinary_caller_is_counted_as_themselves_on_their_plan() -> None:
    principal = Principal.from_claims(claims_for("11111111-2222-4333-8444-555555555555"))
    subject = QuotaSubject.for_principal(principal, PlanCode.PRO)
    assert subject.key == principal.user_id
    assert subject.kind is SubjectKind.USER
    assert subject.plan is PlanCode.PRO


def test_an_administrator_is_internal_and_carries_no_plan() -> None:
    """`specs/usage-limits`: administrative traffic is accounted internally even on a product path.

    The flag comes from `admin_roles` by way of the identity dependency, resolved once per request,
    so the gate and the model resolver a moment later cannot disagree about who is an
    administrator.
    """
    principal = Principal.from_claims(claims_for("11111111-2222-4333-8444-555555555555"))
    subject = QuotaSubject.for_principal(principal, PlanCode.FREE, administrative=True)
    assert subject.key == INTERNAL_SUBJECT
    assert subject.is_internal
    assert subject.plan is None, "an internal subject must not carry a plan to be mistaken for one"


def test_a_token_claiming_the_administrative_role_is_counted_as_an_ordinary_caller() -> None:
    """`specs/authentication`: an asserted role is ignored. Here that means it pays for itself.

    The claim shape is exactly the one groups 28 to 30 honoured, so this is the regression guard
    for the move to backend state: a build that read the claim again would let anyone whose
    identity provider emits one field spend the internal allowance instead of their own.
    """
    principal = Principal.from_claims(
        claims_for("11111111-2222-4333-8444-555555555555", administrative=True)
    )
    subject = QuotaSubject.for_principal(principal, PlanCode.FREE)
    assert subject.key == principal.user_id
    assert not subject.is_internal
    assert subject.plan is PlanCode.FREE


def test_the_internal_subject_cannot_collide_with_a_real_one() -> None:
    """Not UUID-shaped, so no auth subject can ever equal it — which is what makes the owner
    policy deny internal rows to every caller by arithmetic rather than by a clause."""
    assert INTERNAL_SUBJECT == "internal"
    with pytest.raises(ValueError):
        __import__("uuid").UUID(INTERNAL_SUBJECT)


# =========================================================================== the fake store


class _FakeStore:
    """A store with the consumption a test says, and nothing else."""

    def __init__(
        self,
        limits: dict[QuotaDimension, int] | None = None,
        consumed: dict[QuotaDimension, int] | None = None,
        *,
        failing: bool = False,
    ) -> None:
        self.limits = limits or {}
        self._consumed = dict(consumed or {})
        self.failing = failing
        self.reserved: list[QuotaDimension] = []
        self.released: list[QuotaDimension] = []
        self.settled: list[tuple[QuotaDimension, int]] = []
        self.stale_checked: list[QuotaDimension] = []
        # Consumption a competing request adds the instant before this one reserves. The only way
        # to reach the unwind path, because the read pass catches everything that is already over.
        self.taken_between_the_passes: dict[QuotaDimension, int] = {}

    def _boom(self) -> None:
        if self.failing:
            raise OperationalError("SELECT 1", {}, Exception("the accounting store is down"))

    async def allowances(self, subject: QuotaSubject) -> AllowanceSet:
        self._boom()
        return AllowanceSet(subject=subject.key, limits=dict(self.limits))

    async def consumed(self, subject: str, dimension: QuotaDimension, window: WindowKey) -> int:
        self._boom()
        return self._consumed.get(dimension, 0)

    async def consumption(
        self, subject: str, windows: dict[QuotaDimension, WindowKey]
    ) -> dict[QuotaDimension, int]:
        self._boom()
        return {dimension: self._consumed.get(dimension, 0) for dimension in windows}

    async def reserve(
        self,
        subject: str,
        dimension: QuotaDimension,
        window: WindowKey,
        allowance: int,
        *,
        amount: int = 1,
    ) -> int | None:
        self._boom()
        used = self._consumed.get(dimension, 0) + self.taken_between_the_passes.pop(dimension, 0)
        self._consumed[dimension] = used
        if used + amount > allowance:
            return None
        self._consumed[dimension] = used + amount
        self.reserved.append(dimension)
        return self._consumed[dimension]

    async def release(self, reservation: Reservation, *, amount: int = 1) -> None:
        self._boom()
        self._consumed[reservation.dimension] = max(
            self._consumed.get(reservation.dimension, 0) - amount, 0
        )
        self.released.append(reservation.dimension)

    async def settle(
        self, subject: str, dimension: QuotaDimension, window: WindowKey, amount: int
    ) -> int:
        self._boom()
        self._consumed[dimension] = self._consumed.get(dimension, 0) + amount
        self.settled.append((dimension, amount))
        return self._consumed[dimension]

    async def forget_stale(
        self,
        subject: str,
        dimension: QuotaDimension,
        window: WindowKey,
        *,
        older_than_seconds: float,
    ) -> int:
        self._boom()
        self.stale_checked.append(dimension)
        return 0


def gate_over(store: _FakeStore, **overrides: object) -> QuotaGate:
    """A gate whose every operation reaches *store* — no session, no database, no SQL.

    This is what the store factory buys: the gate is handed something that satisfies `QuotaStore`'s
    shape and has no opinion about where it came from, so the decision logic can be exercised
    exhaustively while the statements themselves are proved against a real PostgreSQL next door.
    """

    @asynccontextmanager
    async def stores() -> AsyncIterator[QuotaStore]:
        yield cast(QuotaStore, store)

    return QuotaGate(stores, settings_for(**overrides))


SUBJECT = QuotaSubject(
    key="11111111-2222-4333-8444-555555555555", kind=SubjectKind.USER, plan=PlanCode.FREE
)


# =========================================================================== 30.2 admission


async def test_a_caller_within_their_allowance_is_admitted_and_charged() -> None:
    store = _FakeStore(limits={QuotaDimension.REQUESTS_PER_DAY: 3})
    admission = await gate_over(store).admit(SUBJECT)
    assert store.reserved == [QuotaDimension.REQUESTS_PER_DAY]
    assert [item.dimension for item in admission.requests] == [QuotaDimension.REQUESTS_PER_DAY]


async def test_the_last_unit_is_admitted_and_the_one_after_it_is_not() -> None:
    """The boundary in both directions, which is where an off-by-one lives."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 3},
        consumed={QuotaDimension.REQUESTS_PER_DAY: 2},
    )
    gate = gate_over(store)
    await gate.admit(SUBJECT)
    with pytest.raises(QuotaExceeded):
        await gate.admit(SUBJECT)


async def test_an_allowance_of_zero_refuses_the_very_first_call() -> None:
    """The case the atomic statement alone gets wrong: its ``WHERE`` guards the update branch, so
    a first call of the window would insert its own row and slip past a limit of nothing."""
    store = _FakeStore(limits={QuotaDimension.REQUESTS_PER_DAY: 0})
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)
    assert caught.value.details["allowance"] == 0
    assert store.reserved == []


async def test_the_refusal_names_the_dimension_the_allowance_and_the_reset() -> None:
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 5},
        consumed={QuotaDimension.REQUESTS_PER_DAY: 5},
    )
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)

    details = caught.value.details
    assert details["dimension"] == "requests_per_day"
    assert details["window"] == "day"
    assert details["allowance"] == 5
    assert details["consumed"] == 5
    assert details["resets_at"] is not None
    assert details["retry_after_seconds"] >= 1


async def test_the_refusal_discloses_nothing_but_the_callers_own_standing() -> None:
    """No column names, no plan internals, no other subject, no pricing."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_MONTH: 1},
        consumed={QuotaDimension.REQUESTS_PER_MONTH: 1},
    )
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)

    rendered = f"{caught.value.message} {caught.value.details}".lower()
    for forbidden in ("usage_counters", "usage_limits", "select", "insert", "policy", "postgres"):
        assert forbidden not in rendered, f"the refusal leaks {forbidden!r}"


async def test_when_several_dimensions_bind_the_refusal_names_the_most_restrictive() -> None:
    """`specs/usage-limits` asks for the most restrictive one, and the most restrictive is the one
    the caller waits longest on — a month, not the day inside it."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 1, QuotaDimension.REQUESTS_PER_MONTH: 1},
        consumed={QuotaDimension.REQUESTS_PER_DAY: 1, QuotaDimension.REQUESTS_PER_MONTH: 1},
    )
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)
    assert caught.value.details["dimension"] == "requests_per_month"


async def test_only_the_daily_dimension_binding_leaves_the_monthly_one_alone() -> None:
    """The spec's own scenario: the refusal names the day, and the month is not consumed by it."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 2, QuotaDimension.REQUESTS_PER_MONTH: 100},
        consumed={QuotaDimension.REQUESTS_PER_DAY: 2, QuotaDimension.REQUESTS_PER_MONTH: 40},
    )
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)
    assert caught.value.details["dimension"] == "requests_per_day"
    assert store.reserved == [], "nothing was taken from the month by a refusal on the day"


async def test_an_unset_dimension_does_not_bind_however_much_has_been_used() -> None:
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 10},
        consumed={QuotaDimension.TOKENS_PER_MONTH: 10_000_000_000},
    )
    await gate_over(store).admit(SUBJECT)


async def test_a_dimension_already_exhausted_is_refused_before_anything_is_reserved() -> None:
    """The read pass earns its keep: nothing is taken, so nothing has to be given back."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 10, QuotaDimension.REQUESTS_PER_MONTH: 3},
        consumed={QuotaDimension.REQUESTS_PER_MONTH: 3},
    )
    with pytest.raises(QuotaExceeded):
        await gate_over(store).admit(SUBJECT)
    assert store.reserved == []
    assert store.released == []


async def test_losing_the_race_gives_back_the_reservations_already_taken() -> None:
    """The case the read pass cannot catch: room at the read, gone by the reserve.

    Without the unwind, a caller who lost the race would leave the winner's monthly allowance
    short by the day it had already taken — a refused request that still cost something.
    """
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 10, QuotaDimension.REQUESTS_PER_MONTH: 3}
    )
    store.taken_between_the_passes = {QuotaDimension.REQUESTS_PER_MONTH: 3}

    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)
    assert caught.value.details["dimension"] == "requests_per_month"
    assert store.reserved == [QuotaDimension.REQUESTS_PER_DAY]
    assert store.released == [QuotaDimension.REQUESTS_PER_DAY]


# =========================================================================== 30.3 / 30.4 settling


async def test_a_run_that_never_reached_a_gateway_gives_its_request_back() -> None:
    store = _FakeStore(limits={QuotaDimension.REQUESTS_PER_DAY: 5})
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    await gate.finish(admission, reached_gateway=False)
    assert store.released == [QuotaDimension.REQUESTS_PER_DAY]


async def test_a_run_that_reached_a_gateway_stays_counted_even_if_it_then_failed() -> None:
    store = _FakeStore(limits={QuotaDimension.REQUESTS_PER_DAY: 5})
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    await gate.finish(admission, reached_gateway=True)
    assert store.released == [], "a request that reached a model is a request that happened"


async def test_the_concurrency_slot_comes_back_on_every_path() -> None:
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 5, QuotaDimension.CONCURRENT_RUNS: 2}
    )
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    assert QuotaDimension.CONCURRENT_RUNS in store.reserved

    await gate.finish(admission, reached_gateway=True)
    assert store.released == [QuotaDimension.CONCURRENT_RUNS]


async def test_releasing_twice_does_not_manufacture_allowance() -> None:
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 5, QuotaDimension.CONCURRENT_RUNS: 2}
    )
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    await gate.finish(admission, reached_gateway=False)
    await gate.finish(admission, reached_gateway=False)
    assert store.released.count(QuotaDimension.REQUESTS_PER_DAY) == 1
    assert store.released.count(QuotaDimension.CONCURRENT_RUNS) == 1


async def test_a_stale_concurrency_gauge_is_collected_before_it_is_reserved_against() -> None:
    """The one leak a ``finally`` cannot cover: a process killed mid-run never releases its slot,
    and a gauge with no boundary would carry that forever."""
    store = _FakeStore(limits={QuotaDimension.CONCURRENT_RUNS: 1})
    await gate_over(store).admit(SUBJECT)
    assert store.stale_checked == [QuotaDimension.CONCURRENT_RUNS]


async def test_tokens_are_settled_from_what_the_run_reported() -> None:
    store = _FakeStore(limits={QuotaDimension.TOKENS_PER_MONTH: 1_000})
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    await gate.finish(admission, tokens=340)
    assert store.settled == [(QuotaDimension.TOKENS_PER_MONTH, 340)]


async def test_a_run_the_gateway_reported_no_tokens_for_settles_nothing() -> None:
    """Adding zero would assert that the call used none, which is a claim rather than a
    measurement."""
    store = _FakeStore(limits={QuotaDimension.TOKENS_PER_MONTH: 1_000})
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    await gate.finish(admission, tokens=0)
    assert store.settled == []


async def test_the_token_dimension_refuses_once_the_recorded_total_reaches_it() -> None:
    store = _FakeStore(
        limits={QuotaDimension.TOKENS_PER_MONTH: 1_000},
        consumed={QuotaDimension.TOKENS_PER_MONTH: 1_000},
    )
    with pytest.raises(QuotaExceeded) as caught:
        await gate_over(store).admit(SUBJECT)
    assert caught.value.details["dimension"] == "tokens_per_month"
    assert store.reserved == [], "the token dimension is pre-checked, never reserved"


# =========================================================================== 30.8 fail closed


async def test_an_unreadable_store_refuses_rather_than_admitting_an_unaccounted_call() -> None:
    """`specs/usage-limits`: fail closed. Admitting here is how a store outage becomes an
    unmetered gateway bill."""
    with pytest.raises(QuotaUnavailable):
        await gate_over(_FakeStore(failing=True)).admit(SUBJECT)


async def test_the_store_failure_is_reported_to_operators_without_the_subject_or_the_statement(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("ERROR", logger="weathra.entitlements.quotas")
    with pytest.raises(QuotaUnavailable):
        await gate_over(_FakeStore(failing=True)).admit(SUBJECT)

    reported = "\n".join(record.getMessage() for record in caplog.records)
    assert "failing closed" in reported
    assert "user" in reported, "the operator needs to know which kind of traffic was refused"
    assert SUBJECT.key not in reported, "the subject's identity is not the operator's business"
    assert "SELECT" not in reported, "a driver message may carry a statement and its parameters"


async def test_the_refusal_a_store_outage_produces_is_not_the_one_a_limit_produces() -> None:
    """`QuotaExceeded` names an allowance, a consumption and a reset. During an outage none of the
    three is known, so reporting one would be a lie the caller could not act on."""
    with pytest.raises(QuotaUnavailable) as caught:
        await gate_over(_FakeStore(failing=True)).admit(SUBJECT)
    assert caught.value.code == "quota_unavailable"
    assert not isinstance(caught.value, QuotaExceeded)


async def test_a_settlement_failure_after_the_answer_does_not_raise() -> None:
    """The answer already exists. Failing here would punish the caller for bookkeeping."""
    store = _FakeStore(limits={QuotaDimension.REQUESTS_PER_DAY: 5})
    gate = gate_over(store)
    admission = await gate.admit(SUBJECT)
    store.failing = True
    await gate.finish(admission, tokens=100)


async def test_enforcement_can_be_turned_off_and_the_call_shape_stays_the_same() -> None:
    """`QUOTA_ENABLED` for local and CI runs. The admission is still a real one, so the release and
    settle calls that follow it are exercised rather than skipped."""
    store = _FakeStore(
        limits={QuotaDimension.REQUESTS_PER_DAY: 0}, consumed={QuotaDimension.REQUESTS_PER_DAY: 99}
    )
    gate = gate_over(store, quota_enabled=False)
    admission = await gate.admit(SUBJECT)
    assert isinstance(admission, Admission)
    assert admission.requests == ()
    await gate.finish(admission, tokens=100)
    assert store.reserved == [] and store.settled == []


# =========================================================================== tiers


def test_the_three_product_tiers_are_the_only_ones_a_subject_can_carry() -> None:
    assert {plan.value for plan in PlanCode} == {"free", "pro", "premium"}


def test_plus_is_not_a_tier_and_no_alias_admits_it() -> None:
    """Not a compatibility mapping, not a silent translation: `plus` is not a value this enum
    has, so a plan row, an allowance row or a request naming it cannot resolve to a tier."""
    with pytest.raises(ValueError):
        PlanCode("plus")
    assert "plus" not in {plan.value for plan in PRODUCT_PLAN_CODES}
