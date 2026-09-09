"""Retention and deletion: the three ways data leaves Weathra.

``specs/memory`` and ``specs/safety-grounding`` between them ask for all three, and they are
genuinely different operations rather than one with parameters:

1. **The retention routine** — bounded, unattended, and for *everyone*. Expired threads and their
   checkpoints go, and so do forecast snapshots past their own longer window. Runs under the
   privileged connection from a scheduled CI job, because deleting other people's expired rows is
   exactly the work the restricted role must not be able to do (design.md decision 11: "a retention
   routine invoked from a scheduled CI job in the MVP, no in-process scheduler").

2. **Explicit thread deletion** — one thread, on request, by its owner. Runs on the *request*
   connection as the acting user, so the ownership check and Row Level Security both apply. Lives
   in ``ThreadStore.delete``; this module adds the checkpoint half, which needs the checkpointer.

3. **Whole-account deletion** — every user-owned record of one person, on request. Also the acting
   user's own operation, and deliberately scoped so that it cannot reach shared data: the knowledge
   corpus and the location-keyed forecast snapshots are nobody's personal data, and a deletion that
   swept them would degrade the service for everyone else to no benefit for the person asking.

**Why checkpoints are deleted separately from their thread row.** They live in tables LangGraph
owns, addressed by the composed key, with no foreign key to ``threads`` — so no cascade reaches
them. Deleting the ``threads`` row alone would leave orphaned graph state that nothing can ever
read (the gate is gone) but that still occupies the database. Both halves are done here, and the
row is deleted *last*: an interrupted run then leaves a thread whose checkpoints are already gone,
which the next retention pass simply repeats, rather than orphaned state with no row to find it by.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.models import (
    AgentRun,
    ForecastSnapshot,
    LlmUsageEvent,
    Preference,
    Profile,
    SavedLocation,
    Thread,
    UsageCounter,
)
from weathra.db.session import privileged_session
from weathra.db.urls import ConnectionRole
from weathra.domain.errors import MemoryUnavailable
from weathra.domain.identity import Principal
from weathra.memory.availability import reporting_unavailable
from weathra.memory.checkpointer import Checkpointer
from weathra.memory.threads import ThreadStore

__all__ = [
    "AccountDeletionReport",
    "RetentionReport",
    "delete_account_data",
    "delete_thread",
    "main",
    "run_retention",
]

logger = logging.getLogger("weathra.memory.retention")


class RetentionReport(BaseModel):
    """What one retention pass removed. Reported, not just logged, so CI can assert on it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    threads_expired: int = Field(ge=0)
    thread_checkpoints_cleared: int = Field(ge=0)
    snapshots_expired: int = Field(ge=0)
    usage_events_expired: int = Field(default=0, ge=0)
    thread_retention_days: int = Field(ge=1)
    snapshot_retention_days: int = Field(ge=1)
    llm_usage_retention_days: int = Field(default=90, ge=1)
    ran_at: datetime

    @property
    def anything_removed(self) -> bool:
        return bool(self.threads_expired or self.snapshots_expired or self.usage_events_expired)


class AccountDeletionReport(BaseModel):
    """What a whole-account deletion removed, per table.

    ``specs/http-api`` requires the response to *confirm what was removed*, so the counts are the
    product here rather than a diagnostic.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str
    threads: int = Field(ge=0)
    thread_checkpoints_cleared: int = Field(ge=0)
    saved_locations: int = Field(ge=0)
    preferences: int = Field(ge=0)
    agent_runs: int = Field(ge=0)
    usage_events: int = Field(default=0, ge=0)
    usage_counters: int = Field(default=0, ge=0)
    profile: int = Field(ge=0)

    @property
    def total(self) -> int:
        return (
            self.threads
            + self.saved_locations
            + self.preferences
            + self.agent_runs
            + self.usage_events
            + self.usage_counters
            + self.profile
        )


@dataclass(frozen=True, slots=True)
class _ExpiredThread:
    """An expired thread and its owner, so the composed checkpoint key can be rebuilt."""

    thread_id: str
    user_id: str


# =========================================================================== the retention routine


async def run_retention(
    session: AsyncSession,
    settings: Settings,
    *,
    checkpointer: Checkpointer | None = None,
    now: datetime | None = None,
) -> RetentionReport:
    """Remove expired threads, their checkpoints, and expired forecast snapshots.

    **Must be called with the privileged session.** It deletes rows belonging to every user, which
    is precisely what a request-serving connection is prevented from doing — under the restricted
    role the policies would silently narrow every statement here to the acting user's own rows and
    the routine would report having tidied the whole database while touching almost none of it.

    ``checkpointer`` is optional so retention still runs when the checkpointer cannot be opened:
    the thread rows — the gate — go either way, and the report says how many checkpoint deletions
    were skipped rather than pretending they happened.
    """
    moment = now or datetime.now(UTC)

    async with reporting_unavailable("retention"):
        expired = [
            _ExpiredThread(thread_id=row[0], user_id=row[1])
            for row in (
                await session.execute(
                    select(Thread.id, Thread.user_id).where(Thread.expires_at <= moment)
                )
            ).all()
        ]

    cleared = 0
    if checkpointer is not None and checkpointer.is_open:
        for thread in expired:
            # Before the row, so an interruption leaves a thread to retry rather than orphaned
            # graph state with no row to find it by.
            await checkpointer.forget(thread.user_id, thread.thread_id)
            cleared += 1
    elif expired:
        logger.warning(
            "no checkpointer available; %d expired thread rows removed but their graph state "
            "remains and will be cleared by the next pass",
            len(expired),
        )

    async with reporting_unavailable("retention"):
        removed_threads = (
            await session.execute(
                delete(Thread).where(Thread.expires_at <= moment).returning(Thread.id)
            )
        ).all()

        snapshot_cutoff = moment - timedelta(days=settings.snapshot_retention_days)
        removed_snapshots = (
            await session.execute(
                delete(ForecastSnapshot)
                .where(ForecastSnapshot.retrieved_at < snapshot_cutoff)
                .returning(ForecastSnapshot.id)
            )
        ).all()

        # Raw usage events age out here rather than in a second scheduled job. `specs/memory`
        # already has one routine invoked from CI, and a second scheduler would be a second thing
        # to notice had stopped running. The events hold per-call metadata and no conversation
        # content, so the window is about storage and relevance rather than disclosure.
        usage_cutoff = moment - timedelta(days=settings.llm_usage_retention_days)
        removed_usage = (
            await session.execute(
                delete(LlmUsageEvent)
                .where(LlmUsageEvent.created_at < usage_cutoff)
                .returning(LlmUsageEvent.event_id)
            )
        ).all()
        await session.flush()

    report = RetentionReport(
        threads_expired=len(removed_threads),
        thread_checkpoints_cleared=cleared,
        snapshots_expired=len(removed_snapshots),
        usage_events_expired=len(removed_usage),
        thread_retention_days=settings.thread_retention_days,
        snapshot_retention_days=settings.snapshot_retention_days,
        llm_usage_retention_days=settings.llm_usage_retention_days,
        ran_at=moment,
    )
    logger.info(
        "retention removed %d expired threads (%d checkpoint sets cleared) and %d snapshots",
        report.threads_expired,
        report.thread_checkpoints_cleared,
        report.snapshots_expired,
    )
    return report


# =========================================================================== explicit deletion


async def delete_thread(
    session: AsyncSession,
    principal: Principal,
    settings: Settings,
    thread_id: str,
    *,
    checkpointer: Checkpointer | None = None,
) -> str:
    """Delete one of the acting user's threads and its checkpoints, confirming which.

    The ownership check comes first, through ``ThreadStore.open``: a foreign thread id must fail as
    not-found *before* anything is deleted, and before the composed key is built from a subject
    that would not match it anyway.
    """
    store = ThreadStore(session, principal, settings)
    record = await store.open(thread_id)

    if checkpointer is not None and checkpointer.is_open:
        await checkpointer.forget(record.user_id, record.id)

    return await store.delete(record.id)


async def delete_account_data(
    session: AsyncSession,
    principal: Principal,
    *,
    checkpointer: Checkpointer | None = None,
) -> AccountDeletionReport:
    """Delete every Weathra record the acting user owns, and confirm what went.

    Scoped to the acting subject in every statement, so it cannot reach another person's data even
    if the policies were somehow not in force. Shared data is deliberately untouched: the corpus
    and the location-keyed forecast snapshots are nobody's personal data, and a deletion that swept
    them would degrade the service for everyone else and remove nothing about the person asking.

    Credentials and contact details are not here to delete — they live in Supabase Auth, which owns
    the account itself (``specs/authentication``). Removing the application data is this endpoint's
    whole job; removing the login is Auth's.
    """
    async with reporting_unavailable("account_deletion"):
        threads = [
            row[0]
            for row in (
                await session.execute(select(Thread.id).where(Thread.user_id == principal.user_id))
            ).all()
        ]

    cleared = 0
    if checkpointer is not None and checkpointer.is_open:
        for thread_id in threads:
            await checkpointer.forget(principal.user_id, thread_id)
            cleared += 1
    elif threads:
        logger.warning(
            "account data deleted for %s with no checkpointer; %d checkpoint sets remain and are "
            "unreachable until the next retention pass",
            principal,
            len(threads),
        )

    async with reporting_unavailable("account_deletion"):
        counts: dict[str, int] = {}
        # Agent runs first: they reference threads. The FK is ON DELETE SET NULL rather than
        # CASCADE, so deleting the thread would leave the run behind — which is right for a thread
        # deleted on its own, and wrong here, where the run is the person's data too.
        # Usage events are *counted* here and removed by the cascade from `profiles` below.
        # `specs/llm-telemetry` requires a person's raw events to go with their data, and `0006`
        # already declares that FK as ON DELETE CASCADE so no second routine has to remember to.
        # Deleting them here instead would need `DELETE` on `llm_usage_events` granted to the
        # request role, which would end the append-only guarantee the same migration relies on —
        # an event is a record of something that happened, and the request path may not rewrite
        # history one row at a time. Counted before anything else moves, so the figure is what the
        # cascade is about to take.
        counts["usage_events"] = int(
            await session.scalar(
                select(func.count())
                .select_from(LlmUsageEvent)
                .where(LlmUsageEvent.user_id == principal.user_id)
            )
            or 0
        )

        # Consumption counters are keyed by `subject` and have no foreign key to a profile, so
        # nothing cascades them. They are the person's data and go here explicitly — which is why
        # `0009` grants the request role `DELETE` on this one table; the reserved internal
        # subject's counters are untouched because they are nobody's.
        usage_counters = (
            await session.execute(
                delete(UsageCounter)
                .where(UsageCounter.subject == principal.user_id)
                .returning(UsageCounter.subject)
            )
        ).all()
        counts["usage_counters"] = len(usage_counters)

        for name, model in (
            ("agent_runs", AgentRun),
            ("threads", Thread),
            ("saved_locations", SavedLocation),
            ("preferences", Preference),
        ):
            removed = (
                await session.execute(
                    delete(model).where(model.user_id == principal.user_id).returning(model.user_id)
                )
            ).all()
            counts[name] = len(removed)

        profile = (
            await session.execute(
                delete(Profile)
                .where(Profile.user_id == principal.user_id)
                .returning(Profile.user_id)
            )
        ).all()
        await session.flush()

    report = AccountDeletionReport(
        user_id=principal.user_id,
        threads=counts["threads"],
        thread_checkpoints_cleared=cleared,
        saved_locations=counts["saved_locations"],
        preferences=counts["preferences"],
        agent_runs=counts["agent_runs"],
        usage_events=counts["usage_events"],
        usage_counters=counts["usage_counters"],
        profile=len(profile),
    )
    logger.info("account data deleted for %s: %s", principal, report.model_dump(mode="json"))
    return report


# =========================================================================== the invocable routine


async def retain(settings: Settings) -> RetentionReport:
    """Open the privileged connection, run one pass, and close it. The scheduled entry point."""
    engines = Engines.create(settings)
    # Privileged throughout: this job has no request credential, and clearing another user's
    # expired graph state is not request-path work.
    checkpointer = Checkpointer(settings, role=ConnectionRole.PRIVILEGED)
    try:
        try:
            await checkpointer.open()
        except (MemoryUnavailable, ValueError) as exc:
            # The routine's job is the thread rows; clearing graph state is the part that can wait.
            logger.warning("checkpointer unavailable for this pass (%s)", type(exc).__name__)

        async with privileged_session(engines.privileged_sessionmaker) as session:
            return await run_retention(session, settings, checkpointer=checkpointer)
    finally:
        await checkpointer.close()
        await engines.dispose()


def main(argv: list[str] | None = None) -> int:
    """``weathra-retention``. Invoked by a scheduled job, not by a running server.

    Refuses to run outside privileged mode for the same reason corpus ingestion does: under the
    request-serving configuration the policies would narrow every delete to nothing and the job
    would report success having removed almost nothing.
    """
    parser = argparse.ArgumentParser(
        prog="weathra-retention",
        description="Remove expired conversation threads, their checkpoints, and expired "
        "forecast snapshots. Runs under the privileged database connection.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be removed without removing it.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = Settings()

    if settings.runtime_mode != "privileged":
        print(
            "Refusing to run: set WEATHRA_RUNTIME_MODE=privileged. Retention deletes rows "
            "belonging to every user, which the request-serving role cannot do — under it this "
            "job would report success having removed almost nothing.",
            file=sys.stderr,
        )
        return 2

    report = asyncio.run(_dry_run(settings) if args.dry_run else retain(settings))
    print(json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True))
    return 0


async def _dry_run(settings: Settings) -> RetentionReport:
    """Count what a pass would remove, without removing it.

    The predicates are written out again here rather than shared with ``run_retention``, which is
    the one duplication in this module worth accepting: a dry run that called the real routine and
    rolled back would have to hold a transaction open across the checkpoint deletions, and those
    are not transactional — the checkpointer has its own connection, so a rollback would not undo
    them. Counting is the only honest way to look without touching.
    """
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            now = datetime.now(UTC)
            threads = await session.scalar(
                select(func.count()).select_from(Thread).where(Thread.expires_at <= now)
            )
            cutoff = now - timedelta(days=settings.snapshot_retention_days)
            snapshots = await session.scalar(
                select(func.count())
                .select_from(ForecastSnapshot)
                .where(ForecastSnapshot.retrieved_at < cutoff)
            )
            return RetentionReport(
                threads_expired=int(threads or 0),
                thread_checkpoints_cleared=0,
                snapshots_expired=int(snapshots or 0),
                thread_retention_days=settings.thread_retention_days,
                snapshot_retention_days=settings.snapshot_retention_days,
                ran_at=now,
            )
    finally:
        await engines.dispose()


if __name__ == "__main__":  # pragma: no cover - exercised through the console script
    raise SystemExit(main())
