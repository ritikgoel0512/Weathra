"""Tasks 29.1, 29.5, 29.6, 29.7 and 29.8 — the rows, the aggregate, the retention, the silence.

Against a real database, because every property here is about what the row *is*: the owner policy
that decides who can write it, the generated column that splits internal from product usage, the
percentile PostgreSQL computes, and the cascade that removes a person's events with their account.

The metadata-only suite is the one worth reading twice. "Telemetry holds no conversation content"
is the claim that makes an administrative aggregate across accounts defensible, and it is asserted
against the table's actual columns rather than against the writer's good intentions.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.entitlements import CallRole, PlanCode, PolicyId
from weathra.domain.identity import Principal
from weathra.domain.usage import FailureClass, SubjectKind, UsageEvent, UsageStatus
from weathra.memory.retention import delete_account_data, run_retention
from weathra.telemetry.aggregate import UsageWindow, aggregate_usage
from weathra.telemetry.usage import (
    BackgroundUsageRecorder,
    record_events,
    usage_for_run,
)

pytestmark = pytest.mark.db

CATALOG_KEY = "economy-free-primary"
GATEWAY = "openrouter"
MODEL = "testvendor/economy"


def _event(**overrides: Any) -> UsageEvent:
    fields: dict[str, Any] = {
        "event_id": str(uuid.uuid4()),
        "user_id": None,
        "subject_kind": SubjectKind.INTERNAL,
        "agent_run_id": None,
        "request_id": "req-1",
        "catalog_key": CATALOG_KEY,
        "gateway_provider": GATEWAY,
        "gateway_model": MODEL,
        "policy_id": PolicyId("free_default"),
        "plan": None,
        "call_role": CallRole.SYNTHESIS,
        "latency_ms": 120.0,
        "status": UsageStatus.SUCCESS,
        "created_at": datetime.now(UTC),
    }
    fields.update(overrides)
    return UsageEvent(**fields)


def _owned(user_id: str, **overrides: Any) -> UsageEvent:
    """An event belonging to a person, which needs a plan and a user subject."""
    return _event(
        user_id=user_id,
        subject_kind=SubjectKind.USER,
        plan=overrides.pop("plan", PlanCode.FREE),
        **overrides,
    )


@pytest.fixture
async def privileged_writer(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> AsyncIterator[AsyncSession]:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        yield session


async def _profile(engines: Engines, user_id: str) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)


async def _agent_run(engines: Engines, user_id: str) -> str:
    """A real `agent_runs` row, because the event's run reference is a foreign key.

    Correlating an event to its run is the requirement (`specs/llm-telemetry`), and the schema
    enforces it — so a test that invented a run identifier would be testing a shape the database
    would refuse in production.
    """
    run_id = str(uuid.uuid4())
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        await session.execute(
            text(
                "INSERT INTO agent_runs (id, user_id, request_id, question, envelope, evidence, "
                "duration_ms) VALUES (CAST(:id AS uuid), CAST(:u AS uuid), 'req-1', 'q', "
                "'{}'::jsonb, '{}'::jsonb, 1.0)"
            ),
            {"id": run_id, "u": user_id},
        )
    return run_id


# =========================================================================== 29.1 the row


async def test_a_complete_event_round_trips(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    run_id = await _agent_run(engines, new_user_id())
    written = _event(
        agent_run_id=run_id,
        prompt_tokens=1_200,
        completion_tokens=400,
        total_tokens=1_600,
        estimated_cost=Decimal("0.0001284"),
        cost_currency="USD",
        pricing_date=date(2026, 9, 9),
    )
    assert await record_events(privileged_writer, [written]) == 1

    read_back = await usage_for_run(privileged_writer, run_id)
    assert len(read_back) == 1
    event = read_back[0]
    assert event.catalog_key == CATALOG_KEY
    assert event.gateway_model == MODEL
    assert event.policy_id == "free_default"
    assert event.call_role is CallRole.SYNTHESIS
    assert (event.prompt_tokens, event.completion_tokens, event.total_tokens) == (1200, 400, 1600)
    assert event.estimated_cost == Decimal("0.0001284")
    assert event.cost_currency == "USD"
    assert event.pricing_date == date(2026, 9, 9)
    assert event.latency_ms == 120.0


async def test_a_principal_less_call_records_a_null_subject(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    """`specs/llm-telemetry`: never a placeholder, never a shared identifier."""
    run_id = await _agent_run(engines, new_user_id())
    await record_events(privileged_writer, [_event(agent_run_id=run_id)])

    stored = (await usage_for_run(privileged_writer, run_id))[0]
    assert stored.user_id is None
    assert stored.is_internal


async def test_a_runs_events_are_listable_from_its_run_identifier(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    """Which is what makes "diagnose through the run" a route rather than a policy."""
    run_id = await _agent_run(engines, new_user_id())
    other = await _agent_run(engines, new_user_id())
    base = datetime.now(UTC)
    await record_events(
        privileged_writer,
        [
            _event(agent_run_id=run_id, call_role=CallRole.ROUTING, created_at=base),
            _event(agent_run_id=run_id, created_at=base + timedelta(milliseconds=10)),
            _event(agent_run_id=other),
        ],
    )

    events = await usage_for_run(privileged_writer, run_id)
    assert [event.call_role for event in events] == [CallRole.ROUTING, CallRole.SYNTHESIS]


async def test_writing_the_same_event_twice_records_it_once(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    """A retried background task must not double-count a call."""
    event = _event(agent_run_id=await _agent_run(engines, new_user_id()))
    assert await record_events(privileged_writer, [event]) == 1
    assert await record_events(privileged_writer, [event]) == 0
    assert len(await usage_for_run(privileged_writer, event.agent_run_id or "")) == 1


async def test_a_failed_attempt_is_recorded_with_null_tokens(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    run_id = await _agent_run(engines, new_user_id())
    await record_events(
        privileged_writer,
        [
            _event(
                agent_run_id=run_id,
                status=UsageStatus.FAILURE,
                failure_class=FailureClass.TIMEOUT,
            )
        ],
    )
    stored = (await usage_for_run(privileged_writer, run_id))[0]
    assert stored.status is UsageStatus.FAILURE
    assert stored.failure_class is FailureClass.TIMEOUT
    assert stored.prompt_tokens is None
    assert stored.estimated_cost is None


async def test_a_retry_is_stored_linked_to_the_event_it_retried(
    engines: Engines, privileged_writer: AsyncSession
) -> None:
    run_id = await _agent_run(engines, new_user_id())
    first = _event(
        agent_run_id=run_id,
        status=UsageStatus.FAILURE,
        failure_class=FailureClass.SCHEMA_VALIDATION,
        created_at=datetime.now(UTC),
    )
    second = _event(
        agent_run_id=run_id,
        attempt=2,
        retried_event_id=first.event_id,
        created_at=datetime.now(UTC) + timedelta(milliseconds=5),
    )
    await record_events(privileged_writer, [first, second])

    events = await usage_for_run(privileged_writer, run_id)
    assert events[1].attempt == 2
    assert events[1].retried_event_id == first.event_id


# =========================================================================== 29.1 RLS


async def test_the_request_role_writes_its_own_event_and_reads_only_its_own(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The write happens under the restricted session, which is what group 26 granted it for."""
    mine, theirs = new_user_id(), new_user_id()
    await _profile(engines, mine)
    await _profile(engines, theirs)

    async with session_as(engines, mine) as session:
        assert await record_events(session, [_owned(mine)]) == 1
    async with session_as(engines, theirs) as session:
        await record_events(session, [_owned(theirs)])

    async with session_as(engines, mine) as session:
        rows = await session.execute(text("SELECT user_id FROM llm_usage_events"))
        owners = {str(row[0]) for row in rows}
    assert owners == {mine}


async def test_the_request_role_cannot_write_an_event_for_somebody_else(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    from sqlalchemy.exc import DBAPIError

    mine, theirs = new_user_id(), new_user_id()
    await _profile(engines, mine)
    await _profile(engines, theirs)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, mine) as session:
            await record_events(session, [_owned(theirs)])
    assert "row-level security" in str(caught.value)


def test_telemetry_never_touches_the_privileged_connection() -> None:
    """The group 26 scan, pointed at the telemetry package specifically.

    `telemetry/` takes sessions and never opens one, so there is no privileged path through it.
    """
    import ast
    from pathlib import Path

    package = Path(__file__).resolve().parents[2] / "weathra" / "telemetry"
    for module in sorted(package.rglob("*.py")):
        tree = ast.parse(module.read_text(encoding="utf-8"))
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)} | {
            node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
        }
        assert "privileged_session" not in names, f"{module.name} opens a privileged session"
        assert "privileged_sessionmaker" not in names, (
            f"{module.name} reaches for the privileged engine"
        )


# =========================================================================== 29.5 the write path


async def test_a_telemetry_write_failure_does_not_reach_the_caller(
    engines: Engines, clean_database: None
) -> None:
    """`specs/llm-telemetry`: a failure is logged and counted, and never propagates."""
    recorder = BackgroundUsageRecorder()

    async def broken(_events: Sequence[UsageEvent]) -> int:
        raise RuntimeError("the telemetry store is unreachable")

    recorder.schedule([_event()], broken)
    await recorder.drain()

    assert recorder.failures == 1, "the gap is counted rather than inferred from missing rows"
    assert recorder.written == 0


async def test_a_scheduled_write_succeeds_and_is_counted(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    recorder = BackgroundUsageRecorder()
    run_id = await _agent_run(engines, new_user_id())

    async def write(batch: Sequence[UsageEvent]) -> int:
        async with privileged_session(engines.privileged_sessionmaker) as own:
            return await record_events(own, batch)

    recorder.schedule([_event(agent_run_id=run_id)], write)
    await recorder.drain()

    assert recorder.failures == 0
    assert recorder.written == 1
    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert len(await usage_for_run(session, run_id)) == 1


async def test_a_slow_write_is_bounded_rather_than_hanging_the_process() -> None:
    recorder = BackgroundUsageRecorder(timeout_seconds=0.05)

    async def slow(_events: Sequence[UsageEvent]) -> int:
        await asyncio.sleep(5)
        return 1

    recorder.schedule([_event()], slow)
    await recorder.drain(timeout_seconds=2)
    assert recorder.failures == 1


async def test_scheduling_nothing_does_nothing() -> None:
    recorder = BackgroundUsageRecorder()

    async def never(_events: Sequence[UsageEvent]) -> int:  # pragma: no cover - must not run
        raise AssertionError("an empty batch must not be scheduled")

    recorder.schedule([], never)
    await recorder.drain()
    assert recorder.failures == 0


# =========================================================================== 29.6 metadata only


async def test_the_table_has_no_column_that_could_hold_conversation_content(
    privileged_writer: AsyncSession,
) -> None:
    """The claim an administrative aggregate rests on, checked against the schema.

    A table with no content column cannot leak content, whatever a writer intends.
    """
    rows = await privileged_writer.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'llm_usage_events'"
        )
    )
    columns = {row[0] for row in rows}
    forbidden = {
        "prompt",
        "prompt_text",
        "completion",
        "completion_text",
        "content",
        "messages",
        "passage",
        "retrieved_text",
        "answer",
        "question",
        "authorization",
        "api_key",
        "token",
        "credential",
    }
    assert not columns & forbidden, f"llm_usage_events could hold content: {columns & forbidden}"


async def test_a_stored_event_contains_no_credential_material(
    privileged_writer: AsyncSession, db_settings: Settings
) -> None:
    """Every value in the row, scanned. Nothing carries a key, a token or an email."""
    await record_events(privileged_writer, [_event()])

    rows = await privileged_writer.execute(
        text("SELECT to_jsonb(event) FROM llm_usage_events AS event")
    )
    for (payload,) in rows:
        rendered = str(payload).lower()
        for forbidden in ("bearer ", "authorization", "sk-", "supabase", "@", "secret", "password"):
            assert forbidden not in rendered, f"a stored event carries {forbidden!r}"


def test_the_event_type_cannot_be_given_content() -> None:
    """The other half: even before the row, the type refuses it."""
    from pydantic import ValidationError

    for field in ("prompt", "completion", "messages", "api_key"):
        with pytest.raises(ValidationError):
            _event(**{field: "something"})


# =========================================================================== 29.7 aggregation


async def _seed_for_aggregate(session: AsyncSession, user_id: str) -> None:
    base = datetime.now(UTC)
    await record_events(
        session,
        [
            _owned(
                user_id,
                gateway_model="testvendor/a",
                prompt_tokens=100,
                completion_tokens=50,
                total_tokens=150,
                estimated_cost=Decimal("0.10"),
                cost_currency="USD",
                latency_ms=100.0,
                created_at=base,
            ),
            _owned(
                user_id,
                gateway_model="testvendor/a",
                prompt_tokens=200,
                completion_tokens=100,
                total_tokens=300,
                estimated_cost=Decimal("0.20"),
                cost_currency="USD",
                latency_ms=300.0,
                created_at=base,
            ),
            _owned(
                user_id,
                gateway_model="testvendor/a",
                status=UsageStatus.FAILURE,
                failure_class=FailureClass.TIMEOUT,
                latency_ms=500.0,
                created_at=base,
            ),
            # Internal: must never join the product totals.
            _event(gateway_model="testvendor/a", latency_ms=1_000.0, created_at=base),
        ],
    )


async def test_the_aggregate_reports_every_required_measure(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    await _profile(engines, user_id)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await _seed_for_aggregate(session, user_id)
        totals = await aggregate_usage(session, by="model")

    product = next(row for row in totals if not row.is_internal)
    assert product.calls == 3
    assert product.failures == 1
    assert product.failure_rate == pytest.approx(1 / 3)
    assert product.prompt_tokens == 300
    assert product.total_tokens == 450
    assert product.estimated_cost_total == Decimal("0.30")
    assert product.latency_p50_ms == 300.0
    assert product.latency_p95_ms is not None and product.latency_p95_ms >= 300.0


async def test_internal_usage_is_reported_separately_and_never_joins_a_plan(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Split by the generated column, so an aggregate cannot forget to exclude it."""
    user_id = new_user_id()
    await _profile(engines, user_id)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await _seed_for_aggregate(session, user_id)
        by_model = await aggregate_usage(session, by="model")
        by_plan = await aggregate_usage(session, by="plan")

    internal = next(row for row in by_model if row.is_internal)
    assert internal.calls == 1

    free = next(row for row in by_plan if row.group == "free")
    assert free.calls == 3, "the internal call is not counted against the plan"
    assert not free.is_internal
    assert all(row.group is None for row in by_plan if row.is_internal), (
        "an internal event carries no plan at all"
    )


@pytest.mark.parametrize("by", ["model", "catalog_key", "policy", "plan", "call_role", "status"])
async def test_every_required_dimension_can_be_grouped_by(
    engines: Engines, clean_database: None, seeded_reference_data: None, by: str
) -> None:
    user_id = new_user_id()
    await _profile(engines, user_id)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await _seed_for_aggregate(session, user_id)
        assert await aggregate_usage(session, by=by)


async def test_an_unknown_dimension_is_refused_rather_than_interpolated(
    privileged_writer: AsyncSession,
) -> None:
    """The grouping column is interpolated into SQL, so the allowlist is the safety property."""
    with pytest.raises(ValueError, match="not an aggregation dimension"):
        await aggregate_usage(privileged_writer, by="gateway_model; DROP TABLE llm_usage_events")


async def test_a_window_narrows_the_aggregate(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    user_id = new_user_id()
    await _profile(engines, user_id)
    now = datetime.now(UTC)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_events(
            session,
            [
                _owned(user_id, created_at=now - timedelta(days=10)),
                _owned(user_id, created_at=now),
            ],
        )
        recent = await aggregate_usage(
            session,
            by="model",
            window=UsageWindow(start=now - timedelta(days=1), end=now + timedelta(days=1)),
        )
    assert sum(row.calls for row in recent) == 1


async def test_the_aggregate_returns_measures_and_never_rows() -> None:
    """The property the safety argument depends on: no per-call detail leaves this API."""
    from weathra.telemetry.aggregate import UsageAggregate

    fields = set(UsageAggregate.model_fields)
    assert not fields & {"user_id", "request_id", "agent_run_id", "event_id"}


# =========================================================================== 29.8 retention


async def test_retention_removes_events_past_the_window(
    engines: Engines, clean_database: None, seeded_reference_data: None, db_settings: Settings
) -> None:
    user_id = new_user_id()
    await _profile(engines, user_id)
    now = datetime.now(UTC)
    keep = await _agent_run(engines, user_id)
    drop = await _agent_run(engines, user_id)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_events(
            session,
            [
                _owned(user_id, agent_run_id=keep, created_at=now - timedelta(days=1)),
                _owned(
                    user_id,
                    agent_run_id=drop,
                    created_at=now - timedelta(days=db_settings.llm_usage_retention_days + 1),
                ),
            ],
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)

    assert report.usage_events_expired == 1
    assert report.llm_usage_retention_days == db_settings.llm_usage_retention_days
    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert len(await usage_for_run(session, keep)) == 1
        assert len(await usage_for_run(session, drop)) == 0


async def test_retention_is_one_routine_rather_than_a_second_scheduler() -> None:
    """`specs/memory` already schedules one pass from CI; a second would be a second thing to
    notice had stopped running."""
    import inspect

    from weathra.memory import retention

    source = inspect.getsource(retention.run_retention)
    assert "llm_usage_events" in source or "LlmUsageEvent" in source
    entry_points = [
        name
        for name, value in vars(retention).items()
        if inspect.iscoroutinefunction(value) and name.startswith("retain")
    ]
    assert entry_points == ["retain"], f"more than one retention entry point: {entry_points}"


async def test_deleting_an_account_removes_its_events_and_counters(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/llm-telemetry`: a user's raw events go with their data."""
    mine, theirs = new_user_id(), new_user_id()
    await _profile(engines, mine)
    await _profile(engines, theirs)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_events(session, [_owned(mine), _owned(theirs)])
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:mine, 'requests_per_day', '2026-09-09', 4), "
                "       (:theirs, 'requests_per_day', '2026-09-09', 7), "
                "       ('internal', 'requests_per_day', '2026-09-09', 99)"
            ),
            {"mine": mine, "theirs": theirs},
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await delete_account_data(session, Principal.from_claims(claims_for(mine)))

    assert report.usage_events == 1
    assert report.usage_counters == 1

    async with privileged_session(engines.privileged_sessionmaker) as session:
        remaining = await session.execute(text("SELECT user_id FROM llm_usage_events"))
        assert {str(row[0]) for row in remaining} == {theirs}
        subjects = await session.execute(text("SELECT subject FROM usage_counters"))
        assert {row[0] for row in subjects} == {theirs, "internal"}, (
            "the internal subject's counters are nobody's personal data and stay"
        )
