"""Writing usage events, and never letting that failure become the caller's problem.

Two things live here: the sink that writes a row, and the fire-and-forget wrapper that keeps the
write off the answer path.

**Why the write is not in the request's critical path.** `specs/llm-telemetry` requires that
recording telemetry change nothing about the answer a caller receives, and the only way to
*guarantee* that is for the write not to be awaited by the request. So `BackgroundUsageRecorder`
schedules it on its own task with its own session and its own short timeout; a failure logs and
increments a counter and reaches nobody.

**Not silently, though.** A swallowed exception with no counter is how a telemetry gap goes
unnoticed for a month. Every failure is logged with the event's correlation identifiers and
counted, and `failures` is readable so an operator — and a test — can see the gap rather than infer
it from missing rows.

**The session is the request's own restricted one.** `llm_usage_events` grants the request role
`INSERT` under an owner policy, so a caller can only ever write their own row, and a principal-less
call can write exactly the anonymous row `specs/llm-telemetry` requires and nothing else. Nothing
here reaches for the privileged connection, and the group 26 scan proves it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.usage import UsageEvent

__all__ = ["BackgroundUsageRecorder", "UsageSink", "record_events", "usage_for_run"]

logger = logging.getLogger("weathra.telemetry.usage")

_INSERT = text(
    """
    INSERT INTO llm_usage_events (
        event_id, user_id, subject_kind, agent_run_id, request_id,
        catalog_key, gateway_provider, gateway_model, policy_id, plan, call_role,
        prompt_tokens, completion_tokens, total_tokens,
        estimated_cost, cost_currency, pricing_recorded_on,
        latency_ms, status, failure_class, attempt, retried_event_id, created_at
    ) VALUES (
        CAST(:event_id AS uuid), CAST(:user_id AS uuid), :subject_kind,
        CAST(:agent_run_id AS uuid), :request_id,
        :catalog_key, :gateway_provider, :gateway_model, :policy_id, :plan, :call_role,
        :prompt_tokens, :completion_tokens, :total_tokens,
        CAST(:estimated_cost AS numeric), :cost_currency, CAST(:pricing_recorded_on AS date),
        :latency_ms, :status, :failure_class, :attempt,
        CAST(:retried_event_id AS uuid), :created_at
    )
    ON CONFLICT (event_id) DO NOTHING
    """
)


def _parameters(event: UsageEvent) -> dict[str, object]:
    """One event as bind parameters.

    Written out rather than derived from the model so that adding a field to `UsageEvent` fails
    here loudly instead of being silently dropped on the way to the row — which would be a column
    of nulls nobody noticed.
    """
    return {
        "event_id": event.event_id,
        "user_id": event.user_id,
        "subject_kind": event.subject_kind.value,
        "agent_run_id": event.agent_run_id,
        "request_id": event.request_id,
        "catalog_key": event.catalog_key,
        "gateway_provider": event.gateway_provider,
        "gateway_model": event.gateway_model,
        "policy_id": str(event.policy_id),
        "plan": event.plan.value if event.plan else None,
        "call_role": event.call_role.value,
        "prompt_tokens": event.prompt_tokens,
        "completion_tokens": event.completion_tokens,
        "total_tokens": event.total_tokens,
        "estimated_cost": str(event.estimated_cost) if event.estimated_cost is not None else None,
        "cost_currency": event.cost_currency,
        # The domain calls it `pricing_date`; the column calls it `pricing_recorded_on`.
        # Mapped here rather than renaming either: the column name reads better in SQL and
        # the field name reads better in Python, and one translation is cheaper than a
        # migration.
        "pricing_recorded_on": event.pricing_date,
        "latency_ms": event.latency_ms,
        "status": event.status.value,
        "failure_class": event.failure_class.value if event.failure_class else None,
        "attempt": event.attempt,
        "retried_event_id": event.retried_event_id,
        "created_at": event.created_at,
    }


async def record_events(session: AsyncSession, events: Sequence[UsageEvent]) -> int:
    """Write events, returning how many rows were written.

    ``ON CONFLICT DO NOTHING`` on the event id, so a retried background task cannot double-count a
    call. The identifier is generated once when the event is projected, which is what makes the
    write idempotent rather than merely usually-correct.
    """
    written = 0
    for event in events:
        result = await session.execute(_INSERT, _parameters(event))
        # `CursorResult` carries the count; the base `Result` type does not declare it, and a
        # statement that returns no rows always produces the former.
        written += getattr(result, "rowcount", 0) or 0
    return written


async def usage_for_run(session: AsyncSession, agent_run_id: str) -> tuple[UsageEvent, ...]:
    """Every event belonging to one run, in the order the calls happened.

    `specs/llm-telemetry` requires a run's events to be listable from its identifier — which is
    what makes "diagnose through the run, not through stored content" a route a person can actually
    take rather than a policy.
    """
    rows = await session.execute(
        text(
            "SELECT event_id, user_id, subject_kind, agent_run_id, request_id, catalog_key, "
            "       gateway_provider, gateway_model, policy_id, plan, call_role, prompt_tokens, "
            "       completion_tokens, total_tokens, estimated_cost, cost_currency, "
            "       pricing_recorded_on, latency_ms, status, failure_class, attempt, "
            "       retried_event_id, created_at "
            "  FROM llm_usage_events WHERE agent_run_id = CAST(:run AS uuid) "
            " ORDER BY created_at, attempt"
        ),
        {"run": agent_run_id},
    )
    return tuple(
        UsageEvent(
            event_id=str(row[0]),
            user_id=str(row[1]) if row[1] else None,
            subject_kind=row[2],
            agent_run_id=str(row[3]) if row[3] else None,
            request_id=row[4],
            catalog_key=row[5],
            gateway_provider=row[6],
            gateway_model=row[7],
            policy_id=row[8],
            plan=row[9],
            call_role=row[10],
            prompt_tokens=row[11],
            completion_tokens=row[12],
            total_tokens=row[13],
            estimated_cost=row[14],
            cost_currency=row[15],
            pricing_date=row[16],
            latency_ms=row[17],
            status=row[18],
            failure_class=row[19],
            attempt=row[20],
            retried_event_id=str(row[21]) if row[21] else None,
            created_at=row[22],
        )
        for row in rows
    )


class UsageSink:
    """Writes events on a session the caller supplies. Awaited, and therefore not for the hot path.

    Used directly by the retention routine, the evaluation harness and the tests — anywhere the
    write genuinely should be part of the operation. A request uses `BackgroundUsageRecorder`.
    """

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(self, events: Sequence[UsageEvent]) -> int:
        return await record_events(self._session, events)


class BackgroundUsageRecorder:
    """Schedules usage writes off the request's critical path, with a bounded budget.

    The answer is already on its way back by the time this runs. A write that fails, times out, or
    finds the store unreachable increments `failures` and logs; nothing propagates, because
    `specs/llm-telemetry` requires a telemetry failure not to be reported to a caller as a weather
    or agent error.

    `open_session` is a factory rather than a session, because the request's own transaction has
    already committed by the time the task runs — reusing it would either write into a closed
    transaction or hold the request's connection open past its response.
    """

    __slots__ = ("_failures", "_open_session", "_tasks", "_timeout", "_written")

    def __init__(
        self,
        open_session: Callable[[], Awaitable[AsyncSession]] | None = None,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        self._open_session = open_session
        self._timeout = timeout_seconds
        self._tasks: set[asyncio.Task[None]] = set()
        self._failures = 0
        self._written = 0

    @property
    def failures(self) -> int:
        """How many writes this process has lost. The gap, made visible rather than inferred."""
        return self._failures

    @property
    def written(self) -> int:
        return self._written

    def schedule(
        self, events: Sequence[UsageEvent], writer: Callable[[Sequence[UsageEvent]], Awaitable[int]]
    ) -> None:
        """Record *events* in the background. Returns immediately.

        A strong reference to the task is kept until it finishes: asyncio only holds a weak one, so
        a task nobody referenced can be garbage-collected mid-write, which loses the event and
        raises nothing.
        """
        if not events:
            return
        task = asyncio.create_task(self._run(events, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(
        self, events: Sequence[UsageEvent], writer: Callable[[Sequence[UsageEvent]], Awaitable[int]]
    ) -> None:
        try:
            async with asyncio.timeout(self._timeout):
                self._written += await writer(events)
        except Exception as failure:
            self._failures += len(events)
            # The correlation identifiers and nothing else: an exception's text can carry a
            # provider payload, and this line goes to an operator's log.
            logger.warning(
                "telemetry write failed for %d event(s) (run=%s request=%s): %s",
                len(events),
                events[0].agent_run_id,
                events[0].request_id,
                type(failure).__name__,
            )

    async def drain(self, *, timeout_seconds: float = 5.0) -> None:
        """Wait for scheduled writes to finish. For shutdown, and for tests that assert on rows."""
        if not self._tasks:
            return
        pending = set(self._tasks)
        try:
            async with asyncio.timeout(timeout_seconds):
                await asyncio.gather(*pending, return_exceptions=True)
        except TimeoutError:  # pragma: no cover - a bounded wait that expired is not an error
            logger.warning(
                "%d telemetry write(s) did not finish before the drain deadline", len(pending)
            )
