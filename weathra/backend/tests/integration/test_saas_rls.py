"""Tasks 26.3, 26.5 and 26.7 — the second gate, on the three user-owned SaaS tables.

Like ``test_db_schema.py``, every isolation test here deliberately omits the ownership predicate.
That is the point: the data path's ``AND user_id = :actor`` is the primary gate, and this asserts
the database's own gate holds without it, so a handler that forgets the predicate returns nothing
rather than another user's usage.

Three things are being established, and they are separable:

* **26.3** — the new tables have Row Level Security enabled and forced, with owner-restricting
  policies, and a query under one principal's claims cannot reach another's rows in either
  direction.
* **26.5** — the five tables ``0002`` already protects, and the three checkpoint tables the
  checkpointer protects, are *exactly* as they were. Not "still protected" — unchanged, expression
  by expression, with the same commands, the same roles and the same forcing. A weakening is
  detected as a difference rather than reasoned about.
* **26.7** — every request-path read and write of these tables goes through the restricted session
  rather than the privileged connection, asserted over the source rather than by convention.
"""

from __future__ import annotations

import ast
import uuid
from collections.abc import Iterable
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import insert_profile, new_user_id, session_as
from weathra.db.engine import Engines
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = BACKEND_ROOT / "weathra"

NEW_USER_OWNED_TABLES = ("user_plans", "usage_counters", "llm_usage_events")

# The tables whose protection predates this change and must survive it untouched. The three
# checkpoint tables are included even though no migration creates them: `memory/checkpointer.py`
# writes their policies at deploy time, they test the same accessor, and "no new migration weakened
# anything" is a claim about them too.
PRE_EXISTING_PROTECTED_TABLES = (
    "profiles",
    "preferences",
    "saved_locations",
    "threads",
    "agent_runs",
)
CHECKPOINT_TABLES = ("checkpoints", "checkpoint_blobs", "checkpoint_writes")

OWNER_PREDICATE = "((user_id)::text = weathra_current_user_id())"
CHECKPOINT_PREDICATE = "(split_part(thread_id, ':'::text, 1) = weathra_current_user_id())"

# The policies exactly as they stood before group 26, keyed by (table, policy name) and holding
# (command, USING expression, WITH CHECK expression, rls enabled, rls forced).
#
# `polcmd` is '*' for FOR ALL, 'r' for SELECT, 'a' for INSERT. Transcribed from the database rather
# than from the migration source, because what protects a row is what PostgreSQL stored, not what
# somebody meant to write.
FROZEN_POLICIES: dict[tuple[str, str], tuple[str, str, str, bool, bool]] = {
    (table, f"{table}_owner_only"): ("*", OWNER_PREDICATE, OWNER_PREDICATE, True, True)
    for table in PRE_EXISTING_PROTECTED_TABLES
}
FROZEN_POLICIES.update(
    {
        (table, f"{table}_owner_only"): (
            "*",
            CHECKPOINT_PREDICATE,
            CHECKPOINT_PREDICATE,
            True,
            False,
        )
        for table in CHECKPOINT_TABLES
    }
)
FROZEN_POLICIES.update(
    {
        ("forecast_snapshots", "forecast_snapshots_request_read"): ("r", "true", "-", True, False),
        ("forecast_snapshots", "forecast_snapshots_request_append"): (
            "a",
            "-",
            "true",
            True,
            False,
        ),
        ("knowledge_documents", "knowledge_documents_request_read"): (
            "r",
            "true",
            "-",
            True,
            False,
        ),
        ("knowledge_chunks", "knowledge_chunks_request_read"): ("r", "true", "-", True, False),
    }
)

POLICY_QUERY = """
SELECT relation.relname,
       policy.polname,
       policy.polcmd::text,
       coalesce(pg_get_expr(policy.polqual, policy.polrelid), '-'),
       coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '-'),
       relation.relrowsecurity,
       relation.relforcerowsecurity
  FROM pg_policy AS policy
  JOIN pg_class AS relation ON relation.oid = policy.polrelid
 WHERE relation.relname = ANY(:tables)
"""


def _subjects(rows: Iterable[object]) -> list[str]:
    """Row values as strings.

    ``user_id`` is a real ``uuid`` column and comes back as ``UUID``; ``usage_counters.subject`` is
    text, because it also holds the reserved internal subject. Comparing them as strings is what
    lets one assertion cover both without pretending the columns are the same type.
    """
    return [str(value) for value in rows]


async def _seed_two_users(engines: Engines) -> tuple[str, str]:
    """Two profiles, each with a plan, a counter and a usage event of their own."""
    first, second = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        for user_id, plan in ((first, "premium"), (second, "free")):
            await insert_profile(session, user_id)
            await session.execute(
                text("INSERT INTO user_plans (user_id, plan_code) VALUES (:u, :p)"),
                {"u": user_id, "p": plan},
            )
            await session.execute(
                text(
                    "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                    "VALUES (:u, 'requests_per_day', '2026-09-09', 3)"
                ),
                {"u": user_id},
            )
            await session.execute(
                text(
                    "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                    "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, "
                    "status) VALUES (:e, :u, 'user', 'economy-free-primary', 'openrouter', "
                    "'vendor/model:free', 'free_default', :p, 'synthesis', 100, 'success')"
                ),
                {"e": str(uuid.uuid4()), "u": user_id, "p": plan},
            )
    return first, second


# =========================================================================== 26.3 enabled + forced


@pytest.mark.parametrize("table", NEW_USER_OWNED_TABLES)
async def test_a_new_user_owned_table_has_row_level_security_enabled_and_forced(
    privileged: AsyncSession, table: str
) -> None:
    """FORCE for ``0002``'s reason: on a managed Postgres the migration and request credentials
    can be the same database user, and a table's owner is otherwise exempt from its own policies."""
    row = (
        await privileged.execute(
            text("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = :table"),
            {"table": table},
        )
    ).one()
    assert row[0], f"{table} does not have row level security enabled"
    assert row[1], f"{table} does not force row level security"


@pytest.mark.parametrize("table", NEW_USER_OWNED_TABLES)
async def test_a_new_user_owned_table_carries_an_owner_policy(
    privileged: AsyncSession, table: str
) -> None:
    rows = await privileged.execute(
        text(
            "SELECT polname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) "
            "FROM pg_policy WHERE polrelid = to_regclass(:table)"
        ),
        {"table": table},
    )
    policies = {row[0]: (row[1], row[2]) for row in rows}
    assert policies, f"{table} has row level security on and no policy, which denies everyone"

    # Every readable policy restricts to something the *validated token* says. Two accessors are
    # allowed to be that something, and the second is narrower than the first rather than an
    # escape from it:
    #
    # * `weathra_current_user_id()` — the acting subject. `usage_counters` compares it against
    #   `subject` rather than `user_id`, which is the same rule spelled for a column that also
    #   holds the reserved internal subject.
    # * `weathra_is_administrative()` — only in the one policy that lets an administrator's
    #   product-path call be accounted against the shared internal subject (`0010`). It must pin
    #   the subject to that literal as well, so a policy claiming the role and *not* naming the
    #   row it unlocks fails here.
    readable = [using for using, _ in policies.values() if using is not None]
    assert readable, f"{table} has no readable policy"
    for using in readable:
        if "weathra_is_administrative()" in using:
            assert "'internal'" in using, (
                f"{table} has an administrative policy that does not pin the internal subject, so "
                f"it unlocks more than the internal allowance: {using}"
            )
            continue
        assert "weathra_current_user_id()" in using, (
            f"{table} has a policy that does not consult the acting principal: {using}"
        )


# =========================================================================== 26.3 isolation


async def test_a_caller_reads_only_their_own_plan_counters_and_usage(
    engines: Engines, clean_database: None
) -> None:
    """The ownership predicate is deliberately omitted from every query below."""
    first, second = await _seed_two_users(engines)

    async with session_as(engines, first) as session:
        plans = (await session.execute(text("SELECT user_id FROM user_plans"))).scalars().all()
        counters = (
            (await session.execute(text("SELECT subject FROM usage_counters"))).scalars().all()
        )
        events = (
            (await session.execute(text("SELECT user_id FROM llm_usage_events"))).scalars().all()
        )

    assert _subjects(plans) == [first]
    assert _subjects(counters) == [first]
    assert _subjects(events) == [first]
    assert second not in set(_subjects(plans) + _subjects(counters) + _subjects(events))


async def test_the_isolation_holds_in_the_other_direction_too(
    engines: Engines, clean_database: None
) -> None:
    """Asserted for both users rather than one, so a policy that happened to match the first
    principal by accident would not pass."""
    _first, second = await _seed_two_users(engines)

    async with session_as(engines, second) as session:
        events = (
            (await session.execute(text("SELECT user_id FROM llm_usage_events"))).scalars().all()
        )
        plan = await session.scalar(text("SELECT plan_code FROM user_plans"))

    assert _subjects(events) == [second]
    assert plan == "free", "the second user must see their own plan, not the first user's"


async def test_a_cross_user_read_returns_nothing_rather_than_refusing(
    engines: Engines, clean_database: None
) -> None:
    """Naming another user's row explicitly reads as absent, which is the same answer a row that
    does not exist gives — so a probe cannot tell "not yours" from "not here"."""
    first, second = await _seed_two_users(engines)

    async with session_as(engines, first) as session:
        found = await session.scalar(
            text("SELECT count(*) FROM llm_usage_events WHERE user_id = :other"), {"other": second}
        )
        their_plan = await session.scalar(
            text("SELECT count(*) FROM user_plans WHERE user_id = :other"), {"other": second}
        )
    assert found == 0
    assert their_plan == 0


async def test_a_cross_user_write_is_refused(engines: Engines, clean_database: None) -> None:
    first, second = await _seed_two_users(engines)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, first) as session:
            await session.execute(
                text(
                    "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                    "VALUES (:other, 'requests_per_month', '2026-09', 1)"
                ),
                {"other": second},
            )
    assert "row-level security" in str(caught.value)


async def test_a_caller_cannot_move_a_usage_event_onto_another_user(
    engines: Engines, clean_database: None
) -> None:
    """``WITH CHECK`` and not only ``USING``: without it, a write could create a row into somebody
    else's ownership even though it could never read one back."""
    first, second = await _seed_two_users(engines)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, first) as session:
            await session.execute(
                text(
                    "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                    "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, "
                    "status) VALUES (:e, :other, 'user', 'economy-free-primary', 'openrouter', "
                    "'vendor/model:free', 'free_default', 'free', 'routing', 5, 'success')"
                ),
                {"e": str(uuid.uuid4()), "other": second},
            )
    assert "row-level security" in str(caught.value)


async def test_a_session_with_no_principal_reads_no_user_owned_row(
    engines: Engines, clean_database: None
) -> None:
    """An unbound session owns nothing rather than everything — the direction a bug should fail in."""
    await _seed_two_users(engines)

    async with session_as(engines, None) as session:
        assert await session.scalar(text("SELECT count(*) FROM user_plans")) == 0
        assert await session.scalar(text("SELECT count(*) FROM usage_counters")) == 0
        assert await session.scalar(text("SELECT count(*) FROM llm_usage_events")) == 0


# =========================================================================== 26.3 the two shapes


async def test_a_caller_cannot_assign_themselves_a_plan(
    engines: Engines, clean_database: None
) -> None:
    """The escalation this table's grant exists to prevent.

    An owner policy written ``FOR ALL`` the way every other user-owned table has one would let this
    succeed, because the row genuinely belongs to the caller. Entitlement is a fact the backend
    establishes, so the request role holds ``SELECT`` and nothing else.
    """
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, user_id) as session:
            await session.execute(
                text("INSERT INTO user_plans (user_id, plan_code) VALUES (:u, 'premium')"),
                {"u": user_id},
            )
    assert "permission denied" in str(caught.value)


async def test_a_caller_cannot_upgrade_their_existing_plan(
    engines: Engines, clean_database: None
) -> None:
    first, _ = await _seed_two_users(engines)

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, first) as session:
            await session.execute(text("UPDATE user_plans SET plan_code = 'premium'"))
    assert "permission denied" in str(caught.value)


async def test_an_internal_usage_row_is_invisible_to_every_caller(
    engines: Engines, clean_database: None
) -> None:
    """Decision 27's resolution, tested from the caller's side.

    An internal event's ``user_id`` is null, and ``NULL = anything`` is not true, so the owner
    policy excludes it without needing a clause about internal rows at all.
    """
    first, _ = await _seed_two_users(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, status) "
                "VALUES (:e, NULL, 'internal', 'economy-free-primary', 'openrouter', "
                "'vendor/model:free', 'evaluation_fixed', NULL, 'lab', 42, 'success')"
            ),
            {"e": str(uuid.uuid4())},
        )

    async with session_as(engines, first) as session:
        visible = (
            (await session.execute(text("SELECT user_id FROM llm_usage_events"))).scalars().all()
        )
    assert _subjects(visible) == [first], "an internal event reached a caller"

    # And the privileged aggregate still sees both, which is what makes an administrative total
    # possible at all.
    async with privileged_session(engines.privileged_sessionmaker) as session:
        internal = await session.scalar(
            text("SELECT count(*) FROM llm_usage_events WHERE is_internal")
        )
        product = await session.scalar(
            text("SELECT count(*) FROM llm_usage_events WHERE NOT is_internal")
        )
    assert internal == 1
    assert product == 2


async def test_an_internal_counter_is_invisible_to_every_caller(
    engines: Engines, clean_database: None
) -> None:
    """`specs/usage-limits`: internal consumption is reported separately and never attributed to a
    person. The reserved subject is not UUID-shaped, so no caller's id can ever equal it."""
    first, _ = await _seed_two_users(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES ('internal', 'requests_per_day', '2026-09-09', 500)"
            )
        )

    async with session_as(engines, first) as session:
        subjects = (
            (await session.execute(text("SELECT subject FROM usage_counters"))).scalars().all()
        )
    assert _subjects(subjects) == [first]


async def test_an_anonymous_call_can_record_its_own_event_and_no_other(
    engines: Engines, clean_database: None
) -> None:
    """`specs/llm-telemetry` requires a call with no principal to be recorded with a null subject
    and never a placeholder. The append policy admits exactly that row — and, because
    ``weathra_current_user_id()`` is null for such a session, no row naming anybody."""
    owner, _ = await _seed_two_users(engines)

    async with session_as(engines, None) as session:
        await session.execute(
            text(
                "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, status) "
                "VALUES (:e, NULL, 'internal', 'economy-free-primary', 'openrouter', "
                "'vendor/model:free', 'free_default', NULL, 'synthesis', 12, 'success')"
            ),
            {"e": str(uuid.uuid4())},
        )

    with pytest.raises(DBAPIError) as caught:
        async with session_as(engines, None) as session:
            await session.execute(
                text(
                    "INSERT INTO llm_usage_events (event_id, user_id, subject_kind, catalog_key, "
                    "gateway_provider, gateway_model, policy_id, plan, call_role, latency_ms, "
                    "status) VALUES (:e, :owner, 'user', 'economy-free-primary', 'openrouter', "
                    "'vendor/model:free', 'free_default', 'free', 'synthesis', 12, 'success')"
                ),
                {"e": str(uuid.uuid4()), "owner": owner},
            )
    assert "row-level security" in str(caught.value)


async def test_a_caller_may_count_their_own_consumption(
    engines: Engines, clean_database: None
) -> None:
    """The admission upsert of decision 25, run as a request would run it. Reading and writing
    one's own counter must genuinely work — a policy that denied it would fail every request."""
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)

    async with session_as(engines, user_id) as session:
        consumed = await session.scalar(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, 'requests_per_day', '2026-09-09', 1) "
                "ON CONFLICT (subject, dimension, window_key) "
                "DO UPDATE SET consumed = usage_counters.consumed + 1 "
                "WHERE usage_counters.consumed < 2 RETURNING consumed"
            ),
            {"u": user_id},
        )
    assert consumed == 1

    async with session_as(engines, user_id) as session:
        second = await session.scalar(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, 'requests_per_day', '2026-09-09', 1) "
                "ON CONFLICT (subject, dimension, window_key) "
                "DO UPDATE SET consumed = usage_counters.consumed + 1 "
                "WHERE usage_counters.consumed < 2 RETURNING consumed"
            ),
            {"u": user_id},
        )
    assert second == 2

    # The third is refused by the allowance clause rather than by an error: no row comes back,
    # which is what "the allowance is exhausted" looks like to the admission check.
    async with session_as(engines, user_id) as session:
        third = await session.scalar(
            text(
                "INSERT INTO usage_counters (subject, dimension, window_key, consumed) "
                "VALUES (:u, 'requests_per_day', '2026-09-09', 1) "
                "ON CONFLICT (subject, dimension, window_key) "
                "DO UPDATE SET consumed = usage_counters.consumed + 1 "
                "WHERE usage_counters.consumed < 2 RETURNING consumed"
            ),
            {"u": user_id},
        )
    assert third is None


# =========================================================================== 26.3 privileged path


async def test_the_privileged_path_still_administers_every_new_table(
    engines: Engines, clean_database: None
) -> None:
    """The migration and administrative connection must remain fully functional. A change that
    locked it out would satisfy every isolation test above and break every deployment."""
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
        await session.execute(
            text(
                "INSERT INTO user_plans (user_id, plan_code, assigned_by) "
                "VALUES (:u, 'pro', :admin)"
            ),
            {"u": user_id, "admin": new_user_id()},
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assigned = await session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = :u"), {"u": user_id}
        )
        await session.execute(
            text("UPDATE user_plans SET plan_code = 'premium' WHERE user_id = :u"), {"u": user_id}
        )
    assert assigned == "pro"

    async with privileged_session(engines.privileged_sessionmaker) as session:
        upgraded = await session.scalar(
            text("SELECT plan_code FROM user_plans WHERE user_id = :u"), {"u": user_id}
        )
    assert upgraded == "premium", (
        "administrative assignment must work; it is the only way to upgrade"
    )


async def test_deleting_an_account_removes_its_usage(
    engines: Engines, clean_database: None
) -> None:
    """`specs/llm-telemetry`: a user's raw events are removed when their data is deleted. The
    cascade means no second routine has to remember to."""
    first, second = await _seed_two_users(engines)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(text("DELETE FROM profiles WHERE user_id = :u"), {"u": first})

    async with privileged_session(engines.privileged_sessionmaker) as session:
        remaining = (
            (await session.execute(text("SELECT user_id FROM llm_usage_events"))).scalars().all()
        )
        plans = (await session.execute(text("SELECT user_id FROM user_plans"))).scalars().all()
    assert _subjects(remaining) == [second]
    assert _subjects(plans) == [second]


# =========================================================================== 26.5 nothing weakened


async def test_no_pre_existing_policy_was_changed_by_this_group(
    privileged: AsyncSession, checkpointer_schema: str
) -> None:
    """Task 26.5. Every policy that protected a row before group 26 is byte-for-byte what it was.

    Compared as whole tuples — command, both expressions, enabled, forced — rather than checked for
    presence, because "the policy still exists" is exactly what a weakening looks like. Widening a
    ``USING`` clause, dropping a ``WITH CHECK``, turning ``FORCE`` off or changing ``FOR ALL`` to
    ``FOR SELECT`` all leave a policy of the same name in place.
    """
    tables = sorted({table for table, _ in FROZEN_POLICIES})
    rows = await privileged.execute(text(POLICY_QUERY), {"tables": tables})
    found = {(row[0], row[1]): (row[2], row[3], row[4], row[5], row[6]) for row in rows}

    assert found == FROZEN_POLICIES, (
        "the Row Level Security on the pre-existing tables is not what it was.\n"
        f"missing or changed: {sorted(set(FROZEN_POLICIES) - set(found))}\n"
        f"unexpected: {sorted(set(found) - set(FROZEN_POLICIES))}\n"
        + "\n".join(
            f"  {key}: expected {FROZEN_POLICIES[key]} got {found[key]}"
            for key in sorted(set(found) & set(FROZEN_POLICIES))
            if found[key] != FROZEN_POLICIES[key]
        )
    )


async def test_the_snapshot_detects_a_weakened_policy(
    engines: Engines, privileged: AsyncSession, checkpointer_schema: str
) -> None:
    """The check above is worth exactly as much as its ability to fail, so this weakens a policy
    for real and asserts the comparison notices.

    ``saved_locations`` is rewritten to drop its ``WITH CHECK`` — the subtlest of the weakenings,
    since reads stay correctly scoped and only writes into another user's ownership become
    possible — and put back in a ``finally`` whether the assertion holds or not.
    """
    tables = sorted({table for table, _ in FROZEN_POLICIES})
    original = await privileged.scalar(
        text(
            "SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy "
            "WHERE polname = 'saved_locations_owner_only'"
        )
    )
    assert original == OWNER_PREDICATE

    async def read_policies() -> dict[tuple[str, str], tuple[str, str, str, bool, bool]]:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            rows = await session.execute(text(POLICY_QUERY), {"tables": tables})
            return {(row[0], row[1]): (row[2], row[3], row[4], row[5], row[6]) for row in rows}

    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(text("DROP POLICY saved_locations_owner_only ON saved_locations"))
            await session.execute(
                text(
                    "CREATE POLICY saved_locations_owner_only ON saved_locations FOR ALL "
                    f"USING ({OWNER_PREDICATE})"
                )
            )
        weakened = await read_policies()
        assert weakened != FROZEN_POLICIES, "a dropped WITH CHECK went undetected"
        assert weakened[("saved_locations", "saved_locations_owner_only")][2] == "-"
    finally:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(text("DROP POLICY saved_locations_owner_only ON saved_locations"))
            await session.execute(
                text(
                    "CREATE POLICY saved_locations_owner_only ON saved_locations FOR ALL "
                    f"USING ({OWNER_PREDICATE}) WITH CHECK ({OWNER_PREDICATE})"
                )
            )

    assert await read_policies() == FROZEN_POLICIES, "the weakening was not put back"


def test_no_new_migration_drops_alters_or_bypasses_a_pre_existing_policy() -> None:
    """The source half of 26.5, which the database half cannot see.

    A migration could drop a policy and recreate it identically; the catalog comparison would pass
    and the intent would still be wrong. So the migrations added by this group are read, and any
    statement touching a pre-existing table's protection is a failure. ``0002`` and ``0004`` are
    excluded because those statements are *theirs*.
    """
    versions = PACKAGE_ROOT / "db" / "migrations" / "versions"
    pre_existing = (
        set(PRE_EXISTING_PROTECTED_TABLES)
        | set(CHECKPOINT_TABLES)
        | {
            "forecast_snapshots",
            "knowledge_documents",
            "knowledge_chunks",
        }
    )
    forbidden = ("DROP POLICY", "DISABLE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY")

    for path in sorted(versions.glob("00*.py")):
        if path.name.startswith(("0001", "0002", "0003", "0004")):
            continue
        source = path.read_text(encoding="utf-8")
        upper = source.upper()
        for table in pre_existing:
            for statement in forbidden:
                offence = f"{statement} ON {table.upper()}"
                assert offence not in upper, f"{path.name} contains {offence!r}"
                assert f"{statement} IF EXISTS {table.upper()}" not in upper
            # A policy on a pre-existing table, created from a new migration, would be a second
            # policy — and policies are OR-ed, so an added one can only ever widen access.
            assert f"CREATE POLICY {table.upper()}" not in upper, (
                f"{path.name} adds a policy to {table}; policies combine by OR, so this widens it"
            )
        assert "BYPASSRLS" not in upper or "NOBYPASSRLS" in upper, (
            f"{path.name} grants a role the right to bypass row level security"
        )


def test_the_source_check_catches_a_deliberate_violation(tmp_path: Path) -> None:
    """And that checker, in turn, is only worth its ability to fail."""
    offending = "op.execute('DROP POLICY profiles_owner_only ON profiles')".upper()
    assert "DROP POLICY ON PROFILES" not in offending
    assert "DROP POLICY PROFILES_OWNER_ONLY ON PROFILES" in offending

    # The shape the real check looks for, on the real string.
    source = "op.execute('ALTER TABLE threads DISABLE ROW LEVEL SECURITY')".upper()
    assert "DISABLE ROW LEVEL SECURITY ON THREADS" not in source
    assert "DISABLE ROW LEVEL SECURITY" in source and "THREADS" in source


# =========================================================================== 26.7 the right session


def _module_source(relative: str) -> str:
    return (PACKAGE_ROOT / relative).read_text(encoding="utf-8")


# Modules allowed to reach these tables through the privileged connection, because being exempt
# from the policies is their job: the migrations own the schema and the seed, the session and
# engine modules *are* the connection machinery, and the models merely declare the tables.
# Administrative assignment and retention are privileged by design and will be added here with the
# routines that perform them.
PRIVILEGED_BY_DESIGN = (
    "db/migrations",
    "db/session.py",
    "db/engine.py",
    "db/models.py",
    # Retention is the scheduled pass that deletes *other people's* expired rows, so it cannot run
    # under a session bound to one principal's claims — it is one of the legitimate callers this
    # rule was written around. The module also holds account deletion, which is request path, and a
    # whole-module exemption would stop watching it; `test_only_the_scheduled_pass_in_retention_...`
    # below pins which functions here may name the privileged connection so that half stays checked.
    "memory/retention.py",
)

# The functions in `memory/retention.py` that are allowed to open the privileged connection: the
# scheduled pass's entry point and its dry run. `delete_account_data` is deliberately absent.
RETENTION_PRIVILEGED_FUNCTIONS = frozenset({"retain", "_dry_run"})


def privileged_saas_access(sources: dict[str, str]) -> list[str]:
    """Where *sources* reach a user-owned SaaS table through the privileged connection.

    Separated from the scan below so the same logic can be pointed at deliberately offending source
    and shown to catch it. A checker nobody has watched fail is a green light, not a check.
    """
    offenders: list[str] = []
    for relative, source in sources.items():
        if any(relative.startswith(allowed) for allowed in PRIVILEGED_BY_DESIGN):
            continue
        if not any(table in source for table in NEW_USER_OWNED_TABLES):
            continue
        for node in ast.walk(ast.parse(source)):
            # Narrowed one branch at a time so the line number is read off a node type that
            # actually carries one; `ast.AST` in general does not.
            if isinstance(node, ast.Name):
                names_it = node.id == "privileged_session"
            elif isinstance(node, ast.Attribute):
                names_it = node.attr == "privileged_sessionmaker"
            else:
                continue
            if names_it:
                offenders.append(f"{relative}:{node.lineno}")
    return offenders


def _package_sources() -> dict[str, str]:
    return {
        path.relative_to(PACKAGE_ROOT).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(PACKAGE_ROOT.rglob("*.py"))
        if "__pycache__" not in path.parts
    }


def test_no_module_below_the_api_reaches_the_saas_tables_privileged() -> None:
    """Task 26.7, asserted over the source.

    The request path must reach ``user_plans``, ``usage_counters`` and ``llm_usage_events`` through
    the request-scoped restricted session, so Row Level Security applies to it. A handler handed
    the privileged connection would work perfectly and silently be exempt from every policy above,
    which is the failure mode this test exists for: invisible in behaviour, obvious in source.

    ``privileged_session`` has legitimate callers — Alembic, retention, evaluation provisioning,
    administrative assignment — so the rule is not "nobody calls it". It is that no module which
    also names one of these three tables calls it, outside the set that is supposed to.
    """
    offenders = privileged_saas_access(_package_sources())
    assert not offenders, (
        "these modules touch a user-owned SaaS table through the privileged connection, which is "
        f"exempt from every Row Level Security policy: {offenders}"
    )


def test_only_the_scheduled_pass_in_retention_opens_the_privileged_connection() -> None:
    """The other half of exempting `memory/retention.py` above.

    Retention deletes every user's expired rows and must be privileged. Account deletion lives in
    the same module and is the opposite: a caller removing their own data, on the request session,
    with Row Level Security over it. Exempting the file buys the first and would have quietly given
    up the second, so the exemption is paid for here — the set of functions that may name the
    privileged connection is written down, and `delete_account_data` is not in it.
    """
    source = (PACKAGE_ROOT / "memory" / "retention.py").read_text(encoding="utf-8")
    tree = ast.parse(source)

    opening: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for inner in ast.walk(node):
            names_it = (isinstance(inner, ast.Name) and inner.id == "privileged_session") or (
                isinstance(inner, ast.Attribute) and inner.attr == "privileged_sessionmaker"
            )
            if names_it:
                opening.add(node.name)
                break

    assert opening == set(RETENTION_PRIVILEGED_FUNCTIONS), (
        "the set of retention functions that open the privileged connection changed; if this is "
        f"account deletion acquiring it, that is the regression: {sorted(opening)}"
    )


def test_the_privileged_access_checker_catches_a_handler_given_the_wrong_session() -> None:
    """The negative control 26.7 asks for: the check fails when a handler is handed the privileged
    connection, rather than merely passing today because nothing has wired these tables up yet."""
    offending = {
        "api/routers/usage.py": (
            "from weathra.db.session import privileged_session\n"
            "\n"
            "async def read_usage(engines):\n"
            "    async with privileged_session(engines.privileged_sessionmaker) as session:\n"
            "        return await session.execute('SELECT * FROM llm_usage_events')\n"
        )
    }
    caught = privileged_saas_access(offending)
    assert caught, "a handler reading llm_usage_events privileged went undetected"
    assert all(entry.startswith("api/routers/usage.py:") for entry in caught)


def test_the_checker_does_not_flag_the_modules_that_are_privileged_by_design() -> None:
    """The other direction: a checker that flagged the migrations would be turned off within a day."""
    by_design = {
        "db/migrations/versions/0008_seed.py": (
            "from weathra.db.session import privileged_session\n"
            "# seeds usage_limits and reads user_plans\n"
        )
    }
    assert privileged_saas_access(by_design) == []


def test_the_checker_ignores_a_privileged_call_that_touches_none_of_these_tables() -> None:
    """Retention and corpus ingestion are privileged and have nothing to do with entitlement; the
    rule is about these three tables, not about the connection existing."""
    unrelated = {
        "rag/store.py": (
            "from weathra.db.session import privileged_session\n"
            "async def ingest(engines):\n"
            "    async with privileged_session(engines.privileged_sessionmaker) as session:\n"
            "        await session.execute('DELETE FROM knowledge_chunks')\n"
        )
    }
    assert privileged_saas_access(unrelated) == []


def test_the_request_session_is_what_binds_claims_and_drops_privilege() -> None:
    """The other half of 26.7: the session the request path *does* use is the one that applies the
    policies. Without both steps, running under the restricted session would prove nothing."""
    source = _module_source("db/session.py")
    tree = ast.parse(source)
    functions = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef)
    }
    assert "request_session" in functions
    body = ast.get_source_segment(source, functions["request_session"]) or ""
    assert "bind_claims" in body, "the request session must bind the acting principal's claims"
    assert "assume_restricted_role" in body, "the request session must drop to the restricted role"

    privileged = ast.get_source_segment(source, functions["privileged_session"]) or ""
    assert "assume_restricted_role" not in privileged
    assert "bind_claims" not in privileged
