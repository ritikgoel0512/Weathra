"""Tasks 30.2 through 30.5 and 30.9 — the allowance layer against a real PostgreSQL.

The unit suite proves the decisions. This proves the *statements*: that the reservation is atomic
under genuine concurrency, that Row Level Security scopes a counter the way the policies say, that
the seeded plans differ in the direction they are supposed to, and that consumption reconciles
with the usage events Group 29 records.

Concurrency is asserted with real connections rather than with a fake that yields at the right
moment. A test that simulated the race would prove the simulation; these open several sessions and
let PostgreSQL decide, which is the thing the design relies on.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode, PolicyId
from weathra.domain.errors import QuotaExceeded
from weathra.domain.identity import Principal
from weathra.domain.usage import (
    INTERNAL_SUBJECT,
    QuotaDimension,
    SubjectKind,
    UsageEvent,
    UsageStatus,
    WindowKey,
)
from weathra.entitlements.quotas import (
    QuotaGate,
    QuotaStore,
    QuotaSubject,
    Reservation,
    stores_over,
)
from weathra.memory.retention import delete_account_data
from weathra.telemetry.usage import record_events

pytestmark = pytest.mark.db

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=UTC)
DAY = WindowKey("2026-09-09")
MONTH = WindowKey("2026-09")


# =========================================================================== harness


def gate_for(
    engines: Engines, user_id: str | None, *, administrative: bool = False, **overrides: object
) -> QuotaGate:
    """A gate whose every operation opens the *restricted* session this caller would get.

    Exactly the plumbing `api/dependencies.py` composes, so what these tests exercise is what a
    request exercises — including the policies, which is the half a privileged session would hide.
    """
    settings = engines.settings.model_copy(update=overrides) if overrides else engines.settings

    def sessions() -> AbstractAsyncContextManager[AsyncSession]:
        return session_as(engines, user_id, administrative=administrative)

    return QuotaGate(stores_over(sessions, zone=settings.quota_zone), settings)


@asynccontextmanager
async def store_for(engines: Engines, user_id: str | None) -> AsyncIterator[QuotaStore]:
    async with session_as(engines, user_id) as session:
        yield QuotaStore(session, zone=engines.settings.quota_zone)


async def set_allowance(engines: Engines, plan: str, dimension: str, allowance: int) -> None:
    """Change one seeded allowance, the way an administrator eventually will.

    Privileged because `usage_limits` is read-only to the request path by grant and by policy —
    which is the property that makes "a caller cannot raise their own limit" true.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "UPDATE usage_limits SET allowance = :allowance "
                " WHERE plan_code = :plan AND dimension = :dimension"
            ),
            {"allowance": allowance, "plan": plan, "dimension": dimension},
        )


async def clear_allowances(engines: Engines, plan: str, *, keep: str) -> None:
    """Leave one dimension bounded and every other unlimited, so a test binds on what it means to."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text("DELETE FROM usage_limits WHERE plan_code = :plan AND dimension <> :keep"),
            {"plan": plan, "keep": keep},
        )


async def assign_plan(engines: Engines, user_id: str, plan: PlanCode) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO user_plans (user_id, plan_code) VALUES (CAST(:u AS uuid), :p) "
                "ON CONFLICT (user_id) DO UPDATE SET plan_code = excluded.plan_code"
            ),
            {"u": user_id, "p": plan.value},
        )


async def a_user(engines: Engines, plan: PlanCode = PlanCode.FREE) -> str:
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
    if plan is not PlanCode.FREE:
        await assign_plan(engines, user_id, plan)
    return user_id


def subject_for(user_id: str, plan: PlanCode = PlanCode.FREE) -> QuotaSubject:
    return QuotaSubject(key=user_id, kind=SubjectKind.USER, plan=plan)


async def consumed(engines: Engines, subject: str, dimension: QuotaDimension, window: str) -> int:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        value = await session.scalar(
            text(
                "SELECT consumed FROM usage_counters "
                " WHERE subject = :s AND dimension = :d AND window_key = :w"
            ),
            {"s": subject, "d": dimension.value, "w": window},
        )
    return int(value or 0)


# =========================================================================== 30.2 admission


async def test_a_caller_within_their_plans_allowance_is_admitted_and_counted(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await gate_for(engines, user_id).admit(subject_for(user_id), moment=NOW)

    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_MONTH, str(MONTH)) == 1


async def test_the_boundary_admits_the_last_request_and_refuses_the_next(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Free, at exactly its daily allowance and one past it."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 3)
    gate = gate_for(engines, user_id)

    for _ in range(3):
        await gate.admit(subject_for(user_id), moment=NOW)

    with pytest.raises(QuotaExceeded) as caught:
        await gate.admit(subject_for(user_id), moment=NOW)

    assert caught.value.details["dimension"] == "requests_per_day"
    assert caught.value.details["allowance"] == 3
    assert caught.value.details["consumed"] == 3
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 3, (
        "a refused request must not have consumed anything"
    )


@pytest.mark.parametrize(
    ("plan", "expected"), [(PlanCode.FREE, 25), (PlanCode.PRO, 250), (PlanCode.PREMIUM, 1_000)]
)
async def test_each_tier_carries_its_own_seeded_daily_allowance(
    engines: Engines,
    clean_database: None,
    seeded_reference_data: None,
    plan: PlanCode,
    expected: int,
) -> None:
    """FREE, PRO and PREMIUM differ, and differ in the right direction."""
    user_id = await a_user(engines, plan)
    report = await gate_for(engines, user_id).report(subject_for(user_id, plan), moment=NOW)
    daily = report.by_dimension(QuotaDimension.REQUESTS_PER_DAY)
    assert daily is not None
    assert daily.allowance == expected
    assert daily.remaining == expected


async def test_a_dimension_a_plan_leaves_unset_does_not_bind(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    gate = gate_for(engines, user_id)

    # Every monthly counter is far past where the seeded allowances sat; none of them binds now.
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, 'tokens_per_month', :w, 999999999), "
                "       (:u, 'requests_per_month', :w, 999999)"
            ),
            {"u": user_id, "w": str(MONTH)},
        )

    await gate.admit(subject_for(user_id), moment=NOW)


async def test_the_estimated_cost_dimension_is_unseeded_and_therefore_unlimited(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/usage-limits` asks for it to be *representable*, and this change ships no billing —
    an estimate is the wrong thing to refuse a request on."""
    user_id = await a_user(engines)
    report = await gate_for(engines, user_id).report(subject_for(user_id), moment=NOW)
    cost = report.by_dimension(QuotaDimension.ESTIMATED_COST_PER_MONTH)
    assert cost is not None
    assert cost.allowance is None


async def test_a_caller_cannot_raise_their_own_allowance(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`usage_limits` is read-only to the request path, by grant and by policy."""
    user_id = await a_user(engines)
    async with session_as(engines, user_id) as session:
        with pytest.raises(DBAPIError):
            await session.execute(
                text("UPDATE usage_limits SET allowance = 999999 WHERE plan_code = 'free'")
            )


# =========================================================================== 30.2 concurrency


async def test_a_caller_with_one_request_left_issuing_several_at_once_is_admitted_once(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The whole reason admission is one statement.

    Six real connections, six real transactions, no coordination between them. Read-then-write
    would let several of them see the same last unit; ``INSERT … ON CONFLICT … DO UPDATE … WHERE``
    makes PostgreSQL re-evaluate the condition against whatever the winner wrote.
    """
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 1)
    gate = gate_for(engines, user_id)

    async def attempt() -> str:
        try:
            await gate.admit(subject_for(user_id), moment=NOW)
        except QuotaExceeded:
            return "refused"
        return "admitted"

    outcomes = await asyncio.gather(*(attempt() for _ in range(6)))

    assert outcomes.count("admitted") == 1, f"more than one got through: {outcomes}"
    assert outcomes.count("refused") == 5
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1


async def test_concurrent_admissions_never_take_the_counter_past_the_allowance(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Counter integrity at the interesting size: more racers than units, twice over."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 4)
    gate = gate_for(engines, user_id)

    async def attempt() -> bool:
        try:
            await gate.admit(subject_for(user_id), moment=NOW)
        except QuotaExceeded:
            return False
        return True

    admitted = sum(await asyncio.gather(*(attempt() for _ in range(10))))
    assert admitted == 4
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 4


async def test_a_reservation_released_before_any_gateway_call_leaves_the_allowance_untouched(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    gate = gate_for(engines, user_id)

    admission = await gate.admit(subject_for(user_id), moment=NOW)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1

    await gate.finish(admission, reached_gateway=False)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 0
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_MONTH, str(MONTH)) == 0


async def test_a_release_cannot_drive_a_counter_negative(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """A double release is a bug that must not manufacture allowance out of a negative counter."""
    user_id = await a_user(engines)
    async with store_for(engines, user_id) as store:
        reservation = Reservation(user_id, QuotaDimension.REQUESTS_PER_DAY, DAY)
        await store.reserve(user_id, QuotaDimension.REQUESTS_PER_DAY, DAY, 5)
        for _ in range(4):
            await store.release(reservation)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 0


# =========================================================================== 30.4 concurrency dim


async def test_the_concurrency_dimension_refuses_at_the_limit_and_names_itself(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="concurrent_runs")
    await set_allowance(engines, "free", "concurrent_runs", 1)
    gate = gate_for(engines, user_id)

    first = await gate.admit(subject_for(user_id), moment=NOW)
    with pytest.raises(QuotaExceeded) as caught:
        await gate.admit(subject_for(user_id), moment=NOW)
    assert caught.value.details["dimension"] == "concurrent_runs"
    assert caught.value.details["resets_at"] is None, "a gauge has no boundary to wait for"

    await gate.finish(first)
    await gate.admit(subject_for(user_id), moment=NOW)


async def test_the_slot_comes_back_after_a_run_that_raised(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="concurrent_runs")
    await set_allowance(engines, "free", "concurrent_runs", 1)
    gate = gate_for(engines, user_id)

    admission = await gate.admit(subject_for(user_id), moment=NOW)
    try:
        raise RuntimeError("the run blew up")
    except RuntimeError:
        await gate.finish(admission, reached_gateway=False)

    assert await consumed(engines, user_id, QuotaDimension.CONCURRENT_RUNS, "current") == 0
    await gate.admit(subject_for(user_id), moment=NOW)


async def test_a_slot_a_killed_process_never_released_is_collected(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The failure a ``finally`` cannot cover. Without this an account that crashed as many times
    as its concurrency allowance would be refused forever."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="concurrent_runs")
    await set_allowance(engines, "free", "concurrent_runs", 1)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed, updated_at)"
                " VALUES (:u, 'concurrent_runs', 'current', 1, now() - interval '2 days')"
            ),
            {"u": user_id},
        )

    await gate_for(engines, user_id).admit(subject_for(user_id), moment=NOW)
    assert await consumed(engines, user_id, QuotaDimension.CONCURRENT_RUNS, "current") == 1


async def test_a_slot_a_live_run_is_holding_is_not_collected(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The other direction: a run that started a moment ago is still in flight."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="concurrent_runs")
    await set_allowance(engines, "free", "concurrent_runs", 1)
    gate = gate_for(engines, user_id)

    await gate.admit(subject_for(user_id), moment=NOW)
    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id), moment=NOW)


# =========================================================================== 30.3 tokens


async def test_the_token_dimension_refuses_once_the_settled_total_reaches_it(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="tokens_per_month")
    await set_allowance(engines, "free", "tokens_per_month", 1_000)
    gate = gate_for(engines, user_id)

    admission = await gate.admit(subject_for(user_id), moment=NOW)
    await gate.finish(admission, tokens=1_000)
    assert await consumed(engines, user_id, QuotaDimension.TOKENS_PER_MONTH, str(MONTH)) == 1_000

    with pytest.raises(QuotaExceeded) as caught:
        await gate.admit(subject_for(user_id), moment=NOW)
    assert caught.value.details["dimension"] == "tokens_per_month"


async def test_the_overshoot_is_one_request_and_no_more(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Decision 25's stated trade, asserted rather than assumed: a token count does not exist
    before the call, so the ceiling is crossed by at most the one request that crossed it."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="tokens_per_month")
    await set_allowance(engines, "free", "tokens_per_month", 100)
    gate = gate_for(engines, user_id)

    admission = await gate.admit(subject_for(user_id), moment=NOW)
    await gate.finish(admission, tokens=900)

    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id), moment=NOW)
    assert await consumed(engines, user_id, QuotaDimension.TOKENS_PER_MONTH, str(MONTH)) == 900


async def test_counters_and_recorded_events_agree_for_a_window(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`: consumption must reconcile with the events.

    Two runs, the second of which retried its structured call — three events, two requests, and
    the tokens of all three. The request counter must say two and the token counter must say the
    sum, or the counters and the record disagree about what happened.
    """
    user_id = await a_user(engines)
    gate = gate_for(engines, user_id)

    first, second = await _agent_run(engines, user_id), await _agent_run(engines, user_id)
    events = [
        _event(user_id, first, tokens=100, request_id="req-1"),
        _event(user_id, second, tokens=150, attempt=1, request_id="req-2"),
        _event(user_id, second, tokens=90, attempt=2, request_id="req-2"),
    ]
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_events(session, events)

    for run_tokens in (100, 240):
        admission = await gate.admit(subject_for(user_id), moment=NOW)
        await gate.finish(admission, tokens=run_tokens)

    async with store_for(engines, user_id) as store:
        recorded = await store.recorded_usage(subject_for(user_id), MONTH)

    assert recorded["requests"] == 2, "a retry is one request, not two"
    assert recorded["tokens"] == 340, "a retry's tokens count"
    assert (
        await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_MONTH, str(MONTH))
        == recorded["requests"]
    )
    assert (
        await consumed(engines, user_id, QuotaDimension.TOKENS_PER_MONTH, str(MONTH))
        == recorded["tokens"]
    )


# =========================================================================== 30.5 internal


async def test_an_administrators_product_call_is_charged_to_the_internal_allowance(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`: administrative traffic never consumes an end user's plan."""
    admin_id = await a_user(engines, PlanCode.PREMIUM)
    principal = Principal.from_claims(claims_for(admin_id, administrative=True))
    subject = QuotaSubject.for_principal(principal, PlanCode.PREMIUM)
    assert subject.key == INTERNAL_SUBJECT

    await gate_for(engines, admin_id, administrative=True).admit(subject, moment=NOW)

    assert await consumed(engines, INTERNAL_SUBJECT, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1
    assert await consumed(engines, admin_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 0


async def test_an_exhausted_internal_allowance_refuses_internal_calls_only(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    admin_id = await a_user(engines)
    ordinary_id = await a_user(engines)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text("DELETE FROM usage_limits WHERE internal_subject IS NOT NULL AND dimension <> :d"),
            {"d": "requests_per_day"},
        )
        await session.execute(
            text(
                "UPDATE usage_limits SET allowance = 1 "
                " WHERE internal_subject IS NOT NULL AND dimension = 'requests_per_day'"
            )
        )

    internal = QuotaSubject.internal()
    admin_gate = gate_for(engines, admin_id, administrative=True)
    await admin_gate.admit(internal, moment=NOW)
    with pytest.raises(QuotaExceeded):
        await admin_gate.admit(internal, moment=NOW)

    # Product traffic is untouched by the internal allowance being spent.
    await gate_for(engines, ordinary_id).admit(subject_for(ordinary_id), moment=NOW)


async def test_an_ordinary_caller_cannot_reach_the_internal_counter(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The policy `0010` adds is narrow: one subject, and only for an administrative token.

    Without this, the grant that lets an administrator book internal usage would let anybody drain
    the internal allowance — or, worse, book their own consumption to a counter no plan reads.
    """
    user_id = await a_user(engines)
    async with session_as(engines, user_id) as session:
        store = QuotaStore(session, zone=engines.settings.quota_zone)
        with pytest.raises(DBAPIError):
            await store.reserve(INTERNAL_SUBJECT, QuotaDimension.REQUESTS_PER_DAY, DAY, 100)


async def test_an_ordinary_caller_cannot_read_the_internal_counter_either(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES ('internal', 'requests_per_day', :w, 42)"
            ),
            {"w": str(DAY)},
        )

    user_id = await a_user(engines)
    async with store_for(engines, user_id) as store:
        assert await store.consumed(INTERNAL_SUBJECT, QuotaDimension.REQUESTS_PER_DAY, DAY) == 0


async def test_an_evaluation_runs_identity_is_internal_by_the_token_it_carries(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`: an evaluation run is accounted as internal, not against a plan.

    Asserted at the identity rather than by running the harness, because that is where the
    property lives: the offline runner's token declares the administrative role, so every request
    it makes is classified internal by the same predicate a product request goes through. There is
    no evaluation-shaped exception anywhere in the gate.

    **Live evaluation is not yet covered by this.** A live run signs in against Supabase Auth, and
    the role would have to be set on that account's server-controlled metadata — which is account
    provisioning rather than code, and belongs with the live-evaluation wiring in a later group.
    Until then a live run is accounted against its own user's plan, which is stated here rather
    than discovered by somebody reading a surprising bill.
    """
    from weathra.evaluation.provisioning import OFFLINE_TEST_SUBJECT, _build_offline_tokens

    tokens = _build_offline_tokens(engines.settings)
    principal = await tokens.validator.validate(tokens.token)

    subject = QuotaSubject.for_principal(principal, PlanCode.FREE)
    assert principal.user_id == OFFLINE_TEST_SUBJECT
    assert subject.is_internal
    assert subject.key == INTERNAL_SUBJECT


async def test_internal_usage_is_reported_apart_from_every_product_plan(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    admin_id = await a_user(engines)
    ordinary_id = await a_user(engines)

    await gate_for(engines, admin_id, administrative=True).admit(
        QuotaSubject.internal(), moment=NOW
    )
    await gate_for(engines, ordinary_id).admit(subject_for(ordinary_id), moment=NOW)

    internal = await gate_for(engines, admin_id, administrative=True).report(
        QuotaSubject.internal(), moment=NOW
    )
    product = await gate_for(engines, ordinary_id).report(subject_for(ordinary_id), moment=NOW)

    assert internal.subject.is_internal
    assert not product.subject.is_internal
    daily_internal = internal.by_dimension(QuotaDimension.REQUESTS_PER_DAY)
    daily_product = product.by_dimension(QuotaDimension.REQUESTS_PER_DAY)
    assert daily_internal is not None and daily_internal.consumed == 1
    assert daily_product is not None and daily_product.consumed == 1
    assert daily_internal.allowance != daily_product.allowance, (
        "the internal allowance is configured independently of any plan's"
    )


# =========================================================================== 30.9 windows, plans


async def test_a_new_window_reads_as_zero_with_no_operator_action(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The reset is a different key, not a scheduled job — so it cannot fail to run."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 1)
    gate = gate_for(engines, user_id)

    await gate.admit(subject_for(user_id), moment=NOW)
    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id), moment=NOW)

    tomorrow = NOW + timedelta(days=1)
    await gate.admit(subject_for(user_id), moment=tomorrow)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, "2026-09-10") == 1


async def test_the_closed_window_stays_readable_after_the_boundary(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """ "What did this account use yesterday" must survive the reset."""
    user_id = await a_user(engines)
    gate = gate_for(engines, user_id)
    # Each run is finished before the next begins, because Free permits one at a time — which is
    # itself the concurrency dimension doing its job.
    await gate.finish(await gate.admit(subject_for(user_id), moment=NOW))
    await gate.finish(await gate.admit(subject_for(user_id), moment=NOW + timedelta(days=1)))

    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, "2026-09-10") == 1


async def test_yesterdays_consumption_does_not_bind_today(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 2)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, 'requests_per_day', '2026-09-08', 99)"
            ),
            {"u": user_id},
        )

    await gate_for(engines, user_id).admit(subject_for(user_id), moment=NOW)


async def test_raising_an_allowance_mid_window_admits_the_caller_at_once(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/usage-limits`: the change applies to the remainder of the window, against the
    consumption already recorded. Not cached, or "at once" would mean "within the TTL"."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 1)
    gate = gate_for(engines, user_id)

    await gate.admit(subject_for(user_id), moment=NOW)
    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id), moment=NOW)

    await set_allowance(engines, "free", "requests_per_day", 3)
    await gate.admit(subject_for(user_id), moment=NOW)

    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 2, (
        "the raise applies against consumption already recorded, not from zero"
    )


async def test_a_request_already_served_is_not_re_evaluated_when_an_allowance_falls(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 5)
    gate = gate_for(engines, user_id)

    for _ in range(3):
        await gate.admit(subject_for(user_id), moment=NOW)

    await set_allowance(engines, "free", "requests_per_day", 1)

    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id), moment=NOW)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 3, (
        "the three served requests stand; nothing is refunded and nothing is retroactively refused"
    )


async def test_an_upgrade_takes_effect_against_the_consumption_already_recorded(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """FREE → PRO mid-window. The counter is keyed by subject, not by plan, so the consumption
    follows the person — which is right: an upgrade buys a bigger allowance, not a fresh one."""
    user_id = await a_user(engines)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await clear_allowances(engines, "pro", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 1)
    await set_allowance(engines, "pro", "requests_per_day", 3)
    gate = gate_for(engines, user_id)

    await gate.admit(subject_for(user_id, PlanCode.FREE), moment=NOW)
    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id, PlanCode.FREE), moment=NOW)

    await assign_plan(engines, user_id, PlanCode.PRO)
    await gate.admit(subject_for(user_id, PlanCode.PRO), moment=NOW)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 2


async def test_a_downgrade_binds_immediately_without_erasing_what_was_used(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """PREMIUM → FREE. The history stands; the new ceiling applies to the rest of the window."""
    user_id = await a_user(engines, PlanCode.PREMIUM)
    await clear_allowances(engines, "free", keep="requests_per_day")
    await clear_allowances(engines, "premium", keep="requests_per_day")
    await set_allowance(engines, "free", "requests_per_day", 2)
    await set_allowance(engines, "premium", "requests_per_day", 10)
    gate = gate_for(engines, user_id)

    for _ in range(4):
        await gate.admit(subject_for(user_id, PlanCode.PREMIUM), moment=NOW)

    await assign_plan(engines, user_id, PlanCode.FREE)
    with pytest.raises(QuotaExceeded):
        await gate.admit(subject_for(user_id, PlanCode.FREE), moment=NOW)

    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 4


async def test_the_report_is_the_callers_own_and_nobody_elses(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    mine, theirs = await a_user(engines), await a_user(engines)
    other = gate_for(engines, theirs)
    for _ in range(2):
        await other.finish(await other.admit(subject_for(theirs), moment=NOW))

    report = await gate_for(engines, mine).report(subject_for(mine), moment=NOW)
    daily = report.by_dimension(QuotaDimension.REQUESTS_PER_DAY)
    assert daily is not None and daily.consumed == 0


# =========================================================================== 30.8 fail closed


async def test_an_unreadable_counter_refuses_rather_than_admitting(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """A real privilege failure rather than a simulated one: a session with no claims bound has no
    subject, so the owner policy denies the write and the gate must fail closed."""
    from weathra.domain.errors import QuotaUnavailable

    user_id = await a_user(engines)
    gate = gate_for(engines, None)
    with pytest.raises((QuotaUnavailable, QuotaExceeded)) as caught:
        await gate.admit(subject_for(user_id), moment=NOW)
    assert caught.value.code in {"quota_unavailable", "quota_exceeded"}
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 0


async def test_enforcement_disabled_admits_without_touching_a_counter(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = await a_user(engines)
    await set_allowance(engines, "free", "requests_per_day", 0)

    gate = gate_for(engines, user_id, quota_enabled=False)
    admission = await gate.admit(subject_for(user_id), moment=NOW)
    await gate.finish(admission, tokens=500)

    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 0


# =========================================================================== Group 29 regression


async def test_deleting_an_account_still_clears_its_counters_and_events(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The Group 29 defect, re-asserted with quota rows in play.

    Account deletion runs on the *request* session, so it can only remove what the request role is
    granted: events by `0006`'s cascade from `profiles`, counters by `0009`'s grant. Group 30 fills
    these tables on every question, which makes this the regression most worth keeping green.
    """
    user_id = await a_user(engines)
    run = await _agent_run(engines, user_id)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_events(session, [_event(user_id, run, tokens=120)])

    gate = gate_for(engines, user_id)
    admission = await gate.admit(subject_for(user_id), moment=NOW)
    await gate.finish(admission, tokens=120)
    assert await consumed(engines, user_id, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1

    async with session_as(engines, user_id) as session:
        report = await delete_account_data(session, Principal.from_claims(claims_for(user_id)))
        await session.commit()

    assert report.usage_events == 1
    assert report.usage_counters >= 1
    async with privileged_session(engines.privileged_sessionmaker) as session:
        left = await session.scalar(
            text("SELECT count(*) FROM usage_counters WHERE subject = :u"), {"u": user_id}
        )
        events = await session.scalar(
            text("SELECT count(*) FROM llm_usage_events WHERE user_id = CAST(:u AS uuid)"),
            {"u": user_id},
        )
    assert left == 0
    assert events == 0


async def test_deleting_an_account_leaves_the_internal_counters_alone(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """They are nobody's personal data, and an administrator deleting their own account must not
    reset the allowance the whole lab runs against."""
    admin_id = await a_user(engines)
    await gate_for(engines, admin_id, administrative=True).admit(
        QuotaSubject.internal(), moment=NOW
    )

    async with session_as(engines, admin_id) as session:
        await delete_account_data(session, Principal.from_claims(claims_for(admin_id)))
        await session.commit()

    assert await consumed(engines, INTERNAL_SUBJECT, QuotaDimension.REQUESTS_PER_DAY, str(DAY)) == 1


# =========================================================================== helpers


async def _agent_run(engines: Engines, user_id: str) -> str:
    """A real `agent_runs` row, because `llm_usage_events.agent_run_id` is a foreign key.

    Inventing an identifier would test a shape the database refuses in production.
    """
    import uuid

    run_id = str(uuid.uuid4())
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO agent_runs (id, user_id, request_id, question, envelope, evidence, "
                "duration_ms) VALUES (CAST(:id AS uuid), CAST(:u AS uuid), 'req-1', 'q', "
                "'{}'::jsonb, '{}'::jsonb, 1.0)"
            ),
            {"id": run_id, "u": user_id},
        )
    return run_id


def _event(
    user_id: str, run_id: str, *, tokens: int, attempt: int = 1, request_id: str = "req-1"
) -> UsageEvent:
    import uuid

    return UsageEvent(
        event_id=str(uuid.uuid4()),
        user_id=user_id,
        subject_kind=SubjectKind.USER,
        agent_run_id=run_id,
        request_id=request_id,
        catalog_key="economy-free-primary",
        gateway_provider="openrouter",
        gateway_model="nvidia/nemotron-3-super-120b-a12b:free",
        policy_id=PolicyId("free_default"),
        plan=PlanCode.FREE,
        call_role=CallRole.SYNTHESIS,
        prompt_tokens=tokens // 2,
        completion_tokens=tokens - tokens // 2,
        total_tokens=tokens,
        attempt=attempt,
        status=UsageStatus.SUCCESS,
        failure_class=None,
        latency_ms=120.0,
        created_at=NOW,
    )
