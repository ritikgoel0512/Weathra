"""Task 12.5 — bounded retention, thread deletion on request, and whole-account deletion.

The account-deletion tests are the load-bearing ones: they assert both halves of the requirement —
that the requesting user's records go, and that nobody else's and no shared data does.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from tests.graph_support import one_turn_graph
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.errors import ThreadNotFound
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.checkpointer import Checkpointer
from weathra.memory.locations import SavedLocationStore
from weathra.memory.preferences import PreferenceStore
from weathra.memory.retention import (
    delete_account_data,
    delete_thread,
    run_retention,
)
from weathra.memory.threads import ThreadStore

pytestmark = pytest.mark.db

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    country_code="DE",
)


def _principal(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


async def _expire(engines: Engines, thread_id: str, *, days_ago: int = 1) -> None:
    """Backdate a thread's expiry, privileged — the retention routine's own precondition.

    Done with SQL rather than by waiting: the retention window is thirty days.
    """
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text("UPDATE threads SET expires_at = :when WHERE id = :id"),
            {"when": datetime.now(UTC) - timedelta(days=days_ago), "id": thread_id},
        )


async def _insert_snapshot(engines: Engines, *, retrieved_days_ago: int) -> str:
    snapshot_id = str(uuid.uuid4())
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO forecast_snapshots "
                "(id, location_id, location, window_start, window_end, provider, unit_system, "
                " retrieved_at, daily_series) "
                "VALUES (:id, :location_id, :location, :start, :end, 'open-meteo', 'metric', "
                "        :retrieved, :series)"
            ),
            {
                "id": snapshot_id,
                "location_id": BERLIN.identifier,
                "location": BERLIN.model_dump_json(),
                "start": datetime.now(UTC),
                "end": datetime.now(UTC) + timedelta(days=7),
                "retrieved": datetime.now(UTC) - timedelta(days=retrieved_days_ago),
                "series": "{}",
            },
        )
    return snapshot_id


# =========================================================================== the retention routine


async def test_an_expired_thread_is_removed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        expired = await store.create(title="old")
        current = await store.create(title="new")

    await _expire(engines, expired.id)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)

    assert report.threads_expired == 1
    assert report.anything_removed

    async with session_as(engines, user) as session:
        store = ThreadStore(session, _principal(user), db_settings)
        assert await store.find(expired.id) is None
        assert await store.find(current.id) is not None


async def test_retention_removes_expired_threads_of_every_user(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The reason it runs privileged: under the restricted role it would see one user's rows."""
    users = [new_user_id() for _ in range(3)]
    for user in users:
        async with session_as(engines, user) as session:
            await insert_profile(session, user)
            thread = await ThreadStore(session, _principal(user), db_settings).create()
        await _expire(engines, thread.id)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)

    assert report.threads_expired == 3


async def test_a_thread_inside_its_window_is_left_alone(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, _principal(user), db_settings).create()

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)

    assert report.threads_expired == 0
    async with session_as(engines, user) as session:
        assert await ThreadStore(session, _principal(user), db_settings).find(thread.id) is not None


async def test_expired_snapshots_are_removed_on_their_own_longer_window(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Snapshots outlive threads: they are the baseline What Changed? compares against."""
    stale = await _insert_snapshot(
        engines, retrieved_days_ago=db_settings.snapshot_retention_days + 1
    )
    fresh = await _insert_snapshot(engines, retrieved_days_ago=1)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)

    assert report.snapshots_expired == 1

    async with privileged_session(engines.privileged_sessionmaker) as session:
        # ``str`` because raw SQL hands back UUID objects, not the strings the models expose.
        remaining = {
            str(row[0])
            for row in (await session.execute(text("SELECT id FROM forecast_snapshots"))).all()
        }
    assert remaining == {fresh}
    assert stale not in remaining


async def test_retention_clears_the_checkpoints_of_an_expired_thread(
    engines: Engines, db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    """The half no cascade reaches: the checkpoint tables have no foreign key to ``threads``."""
    graph = one_turn_graph()

    user = new_user_id()
    principal = _principal(user)
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, principal, db_settings).create()

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.acting_as(principal.user_id):
            await graph.compile(checkpointer=checkpointer.saver).ainvoke(
                {"turns": ["hello"]}, config=checkpointer.config_for(principal, thread.id)
            )
        assert await checkpointer.load(principal, thread.id) is not None

        await _expire(engines, thread.id)
        async with privileged_session(engines.privileged_sessionmaker) as session:
            report = await run_retention(session, db_settings, checkpointer=checkpointer)

        assert report.threads_expired == 1
        assert report.thread_checkpoints_cleared == 1
        assert await checkpointer.load(principal, thread.id) is None
    finally:
        await checkpointer.close()


async def test_retention_runs_without_a_checkpointer_and_says_so(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The thread row — the gate — goes either way. The report does not claim more than happened."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, _principal(user), db_settings).create()
    await _expire(engines, thread.id)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings, checkpointer=None)

    assert report.threads_expired == 1
    assert report.thread_checkpoints_cleared == 0


async def test_the_report_states_the_windows_it_applied(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        report = await run_retention(session, db_settings)
    assert report.thread_retention_days == db_settings.thread_retention_days
    assert report.snapshot_retention_days == db_settings.snapshot_retention_days


# =========================================================================== deletion on request


async def test_a_thread_is_deleted_on_request_with_its_checkpoints(
    engines: Engines, db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    user = new_user_id()
    principal = _principal(user)
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, principal, db_settings).create()

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with session_as(engines, user) as session:
            confirmed = await delete_thread(
                session, principal, db_settings, thread.id, checkpointer=checkpointer
            )
        assert confirmed == thread.id
        assert await checkpointer.load(principal, thread.id) is None
    finally:
        await checkpointer.close()

    async with session_as(engines, user) as session:
        with pytest.raises(ThreadNotFound):
            await ThreadStore(session, principal, db_settings).open(thread.id)


async def test_a_foreign_thread_cannot_be_deleted(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The ownership check comes before any deletion, and fails as not-found."""
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        thread = await ThreadStore(session, _principal(owner), db_settings).create()

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)
        with pytest.raises(ThreadNotFound):
            await delete_thread(session, _principal(intruder), db_settings, thread.id)

    async with session_as(engines, owner) as session:
        assert await ThreadStore(session, _principal(owner), db_settings).find(thread.id)


# =========================================================================== account deletion


async def _populate(engines: Engines, user: str, db_settings: Settings) -> str:
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        principal = _principal(user)
        thread = await ThreadStore(session, principal, db_settings).create(title="theirs")
        await SavedLocationStore(session, principal, db_settings).save(BERLIN, label="Home")
        await PreferenceStore(session, principal, db_settings).update(
            unit_system=UnitSystem.IMPERIAL
        )
        await session.execute(
            text(
                "INSERT INTO agent_runs "
                "(id, user_id, thread_id, request_id, question, envelope, evidence, duration_ms) "
                "VALUES (:id, :user_id, :thread_id, 'req_1', 'q', '{}', '{}', 1.0)"
            ),
            {"id": str(uuid.uuid4()), "user_id": user, "thread_id": thread.id},
        )
    return thread.id


async def test_account_deletion_removes_every_record_of_the_requesting_user(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    await _populate(engines, user, db_settings)

    async with session_as(engines, user) as session:
        report = await delete_account_data(session, _principal(user))

    assert report.user_id == user
    assert (report.threads, report.saved_locations, report.preferences, report.agent_runs) == (
        1,
        1,
        1,
        1,
    )
    assert report.profile == 1
    assert report.total == 5

    async with session_as(engines, user) as session:
        principal = _principal(user)
        assert await ThreadStore(session, principal, db_settings).list() == ()
        assert await SavedLocationStore(session, principal, db_settings).list() == ()
        assert not await PreferenceStore(session, principal, db_settings).has_chosen_anything()


async def test_account_deletion_removes_only_the_requesting_users_records(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    leaving = new_user_id()
    staying = new_user_id()
    await _populate(engines, leaving, db_settings)
    staying_thread = await _populate(engines, staying, db_settings)

    async with session_as(engines, leaving) as session:
        report = await delete_account_data(session, _principal(leaving))
    assert report.total == 5

    async with session_as(engines, staying) as session:
        principal = _principal(staying)
        assert len(await ThreadStore(session, principal, db_settings).list()) == 1
        assert await ThreadStore(session, principal, db_settings).find(staying_thread) is not None
        assert len(await SavedLocationStore(session, principal, db_settings).list()) == 1
        assert await PreferenceStore(session, principal, db_settings).has_chosen_anything()

    async with privileged_session(engines.privileged_sessionmaker) as session:
        for table in ("threads", "saved_locations", "preferences", "agent_runs", "profiles"):
            owners = {
                str(row[0])
                for row in (await session.execute(text(f"SELECT user_id FROM {table}"))).all()
            }
            assert owners == {staying}, f"{table} still holds rows for the wrong user"


async def test_shared_data_survives_an_account_deletion(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The corpus and the location-keyed snapshots are nobody's personal data.

    Sweeping them would degrade What Changed? and knowledge retrieval for everyone else while
    removing nothing whatsoever about the person who asked (design.md decision 10).
    """
    user = new_user_id()
    await _populate(engines, user, db_settings)
    snapshot = await _insert_snapshot(engines, retrieved_days_ago=1)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                "VALUES ('doc-1', 'Heat index', 'concepts', 'authored for Weathra', 'hash')"
            )
        )

    async with session_as(engines, user) as session:
        await delete_account_data(session, _principal(user))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        snapshots = await session.scalar(text("SELECT count(*) FROM forecast_snapshots"))
        documents = await session.scalar(text("SELECT count(*) FROM knowledge_documents"))
        remaining = await session.scalar(
            text("SELECT count(*) FROM forecast_snapshots WHERE id = :id"), {"id": snapshot}
        )

    assert snapshots == 1
    assert remaining == 1
    assert documents == 1


async def test_account_deletion_clears_the_checkpoints_too(
    engines: Engines, db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    graph = one_turn_graph()

    user = new_user_id()
    principal = _principal(user)
    thread_id = await _populate(engines, user, db_settings)

    checkpointer = Checkpointer(db_settings)
    await checkpointer.open()
    try:
        async with checkpointer.acting_as(principal.user_id):
            await graph.compile(checkpointer=checkpointer.saver).ainvoke(
                {"turns": ["hello"]}, config=checkpointer.config_for(principal, thread_id)
            )

        async with session_as(engines, user) as session:
            report = await delete_account_data(session, principal, checkpointer=checkpointer)

        assert report.thread_checkpoints_cleared == 1
        assert await checkpointer.load(principal, thread_id) is None
    finally:
        await checkpointer.close()


async def test_deleting_an_account_with_nothing_in_it_is_not_an_error(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        report = await delete_account_data(session, _principal(user))
    assert report.total == 0


# =========================================================================== the invocable routine


async def test_the_routine_runs_privileged_only_and_still_clears_checkpoints(
    engines: Engines, db_settings: Settings, checkpointer_schema: str, clean_database: None
) -> None:
    """``weathra-retention`` end to end, with no request credential configured at all.

    The scheduled job is a privileged-only process. If clearing expired graph state needed
    ``DATABASE_URL``, deploying the job would mean handing it a request-serving credential it has
    no other use for — so the checkpointer opens on the privileged connection here.
    """
    from weathra.memory.retention import retain

    configured = db_settings.database_url_privileged
    assert configured is not None
    privileged_only = Settings(
        supabase_url="https://test.supabase.co",
        runtime_mode="privileged",
        database_url_privileged=configured.get_secret_value(),
    )
    assert privileged_only.database_url is None, "the fixture must not supply a request URL"

    user = new_user_id()
    principal = _principal(user)
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, principal, db_settings).create()

    writer = Checkpointer(db_settings)
    await writer.open()
    try:
        async with writer.acting_as(principal.user_id):
            await (
                one_turn_graph()
                .compile(checkpointer=writer.saver)
                .ainvoke({"turns": ["hello"]}, config=writer.config_for(principal, thread.id))
            )
    finally:
        await writer.close()

    await _expire(engines, thread.id)
    report = await retain(privileged_only)

    assert report.threads_expired == 1
    assert report.thread_checkpoints_cleared == 1

    reader = Checkpointer(db_settings)
    await reader.open()
    try:
        assert await reader.load(principal, thread.id) is None
    finally:
        await reader.close()
