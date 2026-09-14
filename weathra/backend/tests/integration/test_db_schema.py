"""Tasks 3.2, 3.3, and 3.4 against a real PostgreSQL.

Every test here is `db`-marked and deselected by default. They exercise the things that only exist
in a real database: the migrations, the ``vector`` extension, the HNSW index, the Row Level Security
policies, and the claims binding the request-scoped session performs.

The RLS tests deliberately omit the ownership predicate. That is the point: the data path's
``AND user_id = :actor`` is the primary gate, and this asserts the *second* gate holds on its own,
so a handler that forgets the predicate returns nothing rather than another user's row.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.db_support import (
    insert_profile,
    insert_saved_location,
    new_user_id,
    session_as,
)
from weathra.db.engine import Engines
from weathra.db.models import Base, Ownership, ownership_of, user_owned_tables
from weathra.db.session import privileged_session

pytestmark = pytest.mark.db

USER_OWNED = ("profiles", "preferences", "saved_locations", "threads", "agent_runs")
SHARED = ("forecast_snapshots", "knowledge_documents", "knowledge_chunks")
OPERATIONAL = ("evaluation_runs", "evaluation_case_results")

# The three roles: the owner runs migrations, LOGIN_ROLE is what DATABASE_URL authenticates as,
# and RESTRICTED_ROLE is what every request transaction assumes. See docs/authentication.md.
LOGIN_ROLE = "weathra_api"
RESTRICTED_ROLE = "weathra_request"


# =========================================================================== 3.2 migrations


async def test_every_table_exists_after_migration(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    )
    present = {row[0] for row in rows}
    assert set(USER_OWNED + SHARED + OPERATIONAL) <= present


async def test_the_vector_extension_is_enabled(privileged: AsyncSession) -> None:
    version = await privileged.scalar(
        text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
    )
    assert version, "the vector extension was not enabled by the migration"


async def test_the_chunk_vector_carries_an_hnsw_cosine_index(privileged: AsyncSession) -> None:
    definition = await privileged.scalar(
        text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE tablename = 'knowledge_chunks' AND indexname = 'ix_knowledge_chunks_embedding_hnsw'"
        )
    )
    assert definition is not None
    assert "USING hnsw" in definition
    assert "vector_cosine_ops" in definition


async def test_the_chunk_vector_has_the_configured_dimension(
    privileged: AsyncSession, db_settings: object
) -> None:
    declared = await privileged.scalar(
        text(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
            "WHERE attrelid = to_regclass('knowledge_chunks') AND attname = 'embedding'"
        )
    )
    assert declared == f"vector({db_settings.embedding_dimension})"  # type: ignore[attr-defined]


async def test_timestamps_are_stored_with_a_timezone(privileged: AsyncSession) -> None:
    rows = await privileged.execute(
        text(
            "SELECT table_name, column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND (column_name LIKE '%\\_at' "
            "OR column_name LIKE '%\\_start' OR column_name LIKE '%\\_end')"
        )
    )
    naive = [(table, column) for table, column, kind in rows if kind != "timestamp with time zone"]
    assert not naive, f"naive timestamp columns: {naive}"


# =========================================================================== 3.3 policies


@pytest.mark.parametrize("table", USER_OWNED)
async def test_row_level_security_is_enabled_on_each_user_owned_table(
    privileged: AsyncSession, table: str
) -> None:
    row = (
        await privileged.execute(
            text(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                "WHERE oid = to_regclass(:table)"
            ),
            {"table": table},
        )
    ).one()
    enabled, forced = row
    assert enabled, f"row level security is not enabled on {table}"
    assert forced, (
        f"{table} does not FORCE row level security, so the table owner would bypass the policy"
    )


@pytest.mark.parametrize("table", USER_OWNED)
async def test_each_user_owned_table_has_an_owner_restricting_policy(
    privileged: AsyncSession, table: str
) -> None:
    rows = await privileged.execute(
        text(
            "SELECT policyname, qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = :table"
        ),
        {"table": table},
    )
    policies = rows.all()
    assert policies, f"{table} has no policy"
    for _, using, with_check in policies:
        assert "weathra_current_user_id()" in (using or "")
        assert "weathra_current_user_id()" in (with_check or ""), (
            "a policy with no WITH CHECK would let a write place a row under another owner"
        )


@pytest.mark.parametrize("table", SHARED)
async def test_shared_tables_are_not_restricted_by_owner(
    privileged: AsyncSession, table: str
) -> None:
    """specs/authentication requires exactly this asymmetry, so it is asserted, not assumed.

    The asymmetry is about *ownership*, not about whether row level security is switched on. These
    tables carry policies since 0004 — they have to, because Supabase enables RLS on everything in
    ``public`` and a table with RLS on and no policy is unreachable — but none of those policies
    tests who the row belongs to. That is what "not restricted by owner" means, and it is what the
    corpus and the location-keyed snapshots require: shared data has no owner to test.
    """
    for name, using, with_check in (
        await privileged.execute(
            text(
                "SELECT policyname, qual, with_check FROM pg_policies "
                "WHERE schemaname = 'public' AND tablename = :table"
            ),
            {"table": table},
        )
    ).all():
        for clause in (using, with_check):
            assert "weathra_current_user_id()" not in (clause or ""), (
                f"{table}.{name} restricts shared data by owner; {table} has no owner to test"
            )
            assert "user_id" not in (clause or ""), (
                f"{table}.{name} predicates on a user column that {table} does not carry"
            )


# The writes the request path may perform on an operational table, named individually with the one
# command each may use. There are two, both created by `0017`, and both exist because the audited
# candidate-order confirmation task 34.8 specifies happens on the request path — the container that
# serves browsers, which is deliberately never given the privileged credential.
#
# Named rather than allowed by shape, because "an administrative write policy" is precisely the
# thing that must not become a category somebody can add to without deciding to. A third entry here
# is a deliberate act with a reviewer attached; a policy that appears in the database without one
# fails `write_policy_offences` below.
ADMINISTRATIVE_WRITE_POLICIES: dict[tuple[str, str], str] = {
    ("model_policies", "model_policies_admin_write"): "UPDATE",
    ("admin_audit", "admin_audit_admin_append"): "INSERT",
}

# The predicate each of them must be gated on, and nothing else. `0011`'s SECURITY DEFINER read of
# `admin_roles`: backend state, which no claim, header or body field can satisfy.
ADMINISTRATIVE_PREDICATE = "weathra_is_administrative()"

OPERATIONAL_POLICY_QUERY = """
    SELECT tablename, policyname, cmd, roles, coalesce(qual, ''), coalesce(with_check, '')
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = ANY(:tables)
"""


def write_policy_offences(policies: Sequence[Any]) -> list[str]:
    """Every operational policy that is neither a read nor one of the two sanctioned writes.

    Separated from the test so the same rule can be pointed at a policy that does not exist and
    shown to reject it — a checker nobody has watched fail is a green light rather than a check.

    Four things are required of a write, and each rules out a different mistake:

    * it is one of the two named above — so a *new* write policy fails here rather than passing on
      the strength of resembling them;
    * it carries only the command that entry names — so `admin_audit`'s append cannot become an
      `UPDATE` or a `DELETE` under the same name, which is the difference between a trail this role
      may add to and one it may rewrite;
    * both its `USING` and its `WITH CHECK`, wherever present, are exactly the administrative
      predicate — so a widened clause, or one testing a token claim, fails;
    * it applies to the restricted role alone — so it cannot be a policy for `PUBLIC` that happens
      to look administrative.
    """
    offences: list[str] = []
    for table, name, cmd, roles, using, with_check in policies:
        if cmd == "SELECT":
            continue
        where = f"{table}.{name}"
        expected = ADMINISTRATIVE_WRITE_POLICIES.get((table, name))
        if expected is None:
            offences.append(f"{where} is an unsanctioned {cmd} policy on an operational table")
            continue
        if cmd != expected:
            offences.append(f"{where} is {cmd}; the sanctioned write is {expected} only")
        for clause, value in (("USING", using), ("WITH CHECK", with_check)):
            if value and value.strip() != ADMINISTRATIVE_PREDICATE:
                offences.append(f"{where} has a {clause} that is not {ADMINISTRATIVE_PREDICATE}")
        if list(roles) != [RESTRICTED_ROLE]:
            offences.append(f"{where} applies to {list(roles)} rather than {[RESTRICTED_ROLE]}")
    return offences


async def test_the_policy_set_matches_the_models_classification(
    privileged: AsyncSession,
) -> None:
    """The migrations and ``user_owned_tables()`` must not drift apart.

    Keyed on owner-restricting policies rather than on policies as such, because 0004 gave the
    shared tables role-scoped read policies too. The classification that must hold is which tables
    bind a row to a person — not which tables happen to appear in ``pg_policies``.

    Scoped to the tables the models declare. LangGraph's checkpoint tables also carry
    owner-restricting policies, written by ``ensure_checkpoint_schema`` rather than by a migration,
    and they are not in ``Base.metadata`` because Weathra does not define them.

    **The operational tables were read-only to the request path, and two of them no longer are.**
    ``0017`` grants ``UPDATE`` on ``model_policies`` and ``INSERT`` on ``admin_audit``, because the
    audited candidate-order confirmation is a write that has to happen in the container serving the
    browser — the one deliberately never given the privileged credential. This test used to assert
    that every operational policy was a ``SELECT``, which was true when it was written and stopped
    being true when that shipped.

    It is not relaxed into "writes are allowed here". The two are named, each with the one command
    it may carry, the predicate it must be gated on and the role it must apply to
    (``write_policy_offences``); a third policy, a widened clause, or one of these two gaining
    ``DELETE`` all fail. The grants are asserted alongside, because a policy cannot grant a
    privilege the role does not hold and a privilege is what a policy is checked after.
    """
    rows = await privileged.execute(
        text(
            "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' "
            "AND (coalesce(qual, '') LIKE '%weathra_current_user_id%' "
            "     OR coalesce(with_check, '') LIKE '%weathra_current_user_id%')"
        )
    )
    declared = set(Base.metadata.tables)
    owner_restricted = {row[0] for row in rows} & declared

    # `admin_roles` is the one operational table with an owner-restricting policy, and the
    # exception is narrow in the direction that matters. It restricts *reads* to the acting
    # subject — so the administrative predicate can run on the request session without becoming a
    # way to enumerate who else is an administrator — while granting no write of any kind. The
    # classification stays OPERATIONAL because the row is an authorization fact about a subject
    # rather than the subject's own data: they cannot write it, and deleting their account does
    # not remove it.
    #
    # The exception is paid for below rather than merely declared: a build that gave this table a
    # write grant would fail here, which is exactly the mistake worth catching.
    assert owner_restricted - {"admin_roles"} == set(user_owned_tables())
    for table in owner_restricted - {"admin_roles"}:
        assert ownership_of(table) is Ownership.USER

    role_grants = await privileged.execute(
        text(
            "SELECT privilege_type FROM information_schema.role_table_grants "
            " WHERE table_name = 'admin_roles' AND grantee = 'weathra_request'"
        )
    )
    assert {row[0] for row in role_grants} == {"SELECT"}, (
        "admin_roles must stay read-only to the request path; a write grant here is a "
        "self-service administrative promotion"
    )

    # The grant is the other half of the policy, and the half a policy cannot restore: PostgreSQL
    # checks the privilege first, so a table with no `DELETE` grant cannot be deleted from however
    # the policies read. The two sanctioned writes are asserted as whole grant sets rather than as
    # presences, because "it still has INSERT" is exactly what a widening looks like.
    for table, expected in (
        ("admin_audit", {"SELECT", "INSERT"}),
        ("model_policies", {"SELECT", "UPDATE"}),
    ):
        grants = await privileged.execute(
            text(
                "SELECT privilege_type FROM information_schema.role_table_grants "
                " WHERE table_name = :table AND grantee = :role"
            ),
            {"table": table, "role": RESTRICTED_ROLE},
        )
        assert {row[0] for row in grants} == expected, (
            f"{table} grants the request path more than {sorted(expected)}; an audit trail this "
            "role can rewrite or prune is not an audit trail"
        )

    everything = await privileged.execute(
        text("SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'")
    )
    # A policy that does not consult the acting principal must be on a table where there is no
    # principal to consult: the shared data everyone may read, or the operational policy tables a
    # resolution reads on the way to a model. Both are allowed and neither may be user-owned —
    # an owner-less policy on a user-owned table would hand every row to every caller.
    operational: list[str] = []
    for table in ({row[0] for row in everything} & declared) - owner_restricted:
        ownership = ownership_of(table)
        assert ownership in (Ownership.SHARED, Ownership.OPERATIONAL), (
            f"{table} carries a policy that is neither owner-restricting nor shared-read"
        )
        if ownership is Ownership.OPERATIONAL:
            operational.append(table)

    policies = await privileged.execute(
        text(OPERATIONAL_POLICY_QUERY), {"tables": sorted(operational)}
    )
    assert write_policy_offences(policies.all()) == []


def test_the_write_policy_check_rejects_a_policy_nobody_sanctioned() -> None:
    """The checker is worth exactly its ability to fail, so it is shown failing — on the four
    shapes that would matter, each of which would otherwise look like the two real ones."""
    sanctioned = (
        "admin_audit",
        "admin_audit_admin_append",
        "INSERT",
        [RESTRICTED_ROLE],
        "",
        ADMINISTRATIVE_PREDICATE,
    )
    assert write_policy_offences([sanctioned]) == []

    # A new write policy on an operational table, gated exactly as the real ones are.
    unsanctioned = (
        "model_catalog",
        "model_catalog_admin_write",
        "UPDATE",
        [RESTRICTED_ROLE],
        ADMINISTRATIVE_PREDICATE,
        ADMINISTRATIVE_PREDICATE,
    )
    assert write_policy_offences([unsanctioned]), "an unsanctioned write policy went undetected"

    # The sanctioned name, carrying a command it may not.
    widened = (
        "admin_audit",
        "admin_audit_admin_append",
        "DELETE",
        [RESTRICTED_ROLE],
        ADMINISTRATIVE_PREDICATE,
        "",
    )
    assert write_policy_offences([widened]), "a trail this role could prune went undetected"

    # The sanctioned name and command, gated on something weaker.
    ungated = ("admin_audit", "admin_audit_admin_append", "INSERT", [RESTRICTED_ROLE], "", "true")
    assert write_policy_offences([ungated]), "an ungated append went undetected"

    # The sanctioned name, command and predicate — offered to everybody.
    public = (
        "admin_audit",
        "admin_audit_admin_append",
        "INSERT",
        ["public"],
        "",
        ADMINISTRATIVE_PREDICATE,
    )
    assert write_policy_offences([public]), "a policy for PUBLIC went undetected"


async def test_an_administrator_may_append_to_the_audit_trail_and_nobody_else_may(
    engines: Engines, clean_database: None
) -> None:
    """`0017`'s append, asserted as behaviour rather than as catalogue rows.

    Four callers and one statement. The administrator is the only one who may write it, and the
    role comes from ``admin_roles`` rather than from the token — the claimant below asserts it and
    is refused all the same.
    """
    admin, ordinary = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, admin)
        await insert_profile(session, ordinary)
        await session.execute(
            text(
                "INSERT INTO admin_roles (subject_id, role) "
                "VALUES (CAST(:u AS uuid), 'administrator')"
            ),
            {"u": admin},
        )

    append = text(
        "INSERT INTO admin_audit (id, acting_principal, action, subject_kind, subject_id, "
        "before, after) VALUES (gen_random_uuid(), CAST(:actor AS uuid), 'policy_edit', "
        "'model_policy', 'balanced', NULL, '{\"candidate_catalog_keys\": []}')"
    )

    async with session_as(engines, admin) as session:
        await session.execute(append, {"actor": admin})
        assert await session.scalar(text("SELECT count(*) FROM admin_audit")) == 1

    # An ordinary authenticated caller. The grant is there — the refusal is the policy's.
    with pytest.raises(DBAPIError) as refused:
        async with session_as(engines, ordinary) as session:
            await session.execute(append, {"actor": ordinary})
    assert "row-level security" in str(refused.value)

    # A caller whose token asserts the role. `0011` made the predicate read backend state.
    with pytest.raises(DBAPIError):
        async with session_as(engines, ordinary, administrative=True) as session:
            await session.execute(append, {"actor": ordinary})

    # And nobody at all.
    with pytest.raises(DBAPIError):
        async with session_as(engines, None) as session:
            await session.execute(append, {"actor": admin})

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT count(*) FROM admin_audit")) == 1


@pytest.mark.parametrize(
    "statement", ["DELETE FROM admin_audit", "UPDATE admin_audit SET action = 'x'"]
)
async def test_an_administrator_may_not_edit_or_prune_the_audit_trail(
    engines: Engines, clean_database: None, statement: str
) -> None:
    """Append is the whole of it. An audit trail the audited role can rewrite is not one, and the
    refusal here is the *grant* rather than a policy — there is no `UPDATE` or `DELETE` to check a
    policy against."""
    admin = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, admin)
        await session.execute(
            text(
                "INSERT INTO admin_roles (subject_id, role) "
                "VALUES (CAST(:u AS uuid), 'administrator')"
            ),
            {"u": admin},
        )

    with pytest.raises(DBAPIError) as refused:
        async with session_as(engines, admin) as session:
            await session.execute(text(statement))
    assert "permission denied" in str(refused.value)


async def test_the_restricted_role_exists_and_cannot_bypass_policies(
    privileged: AsyncSession, db_settings: object
) -> None:
    role = db_settings.database_restricted_role  # type: ignore[attr-defined]
    row = (
        await privileged.execute(
            text("SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = :role"),
            {"role": role},
        )
    ).one_or_none()
    assert row is not None, f"the migration did not create the {role} role"
    bypass, can_login, is_super = row
    assert bypass is False, "the request role must not be able to bypass row level security"
    assert can_login is False, "the request role is assumed, never connected as"
    assert is_super is False


async def test_the_login_role_exists_and_may_only_log_in(privileged: AsyncSession) -> None:
    """``weathra_api`` — the identity ``DATABASE_URL`` authenticates as (migration 0003).

    ``rolinherit`` is the one that matters. If the membership below were inheritable, the restricted
    role's privileges would apply to every query automatically and the ``SET LOCAL ROLE`` in
    ``db/session.py`` would be decorative — a request that skipped the switch would still read
    everything. With ``NOINHERIT`` the membership confers exactly one capability: the right to
    *become* ``weathra_request``.
    """
    row = (
        await privileged.execute(
            text(
                "SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreatedb, "
                "rolcreaterole, rolreplication FROM pg_roles WHERE rolname = :role"
            ),
            {"role": LOGIN_ROLE},
        )
    ).one_or_none()
    assert row is not None, f"migration 0003 did not create the {LOGIN_ROLE} role"
    can_login, inherits, bypass, is_super, createdb, createrole, replication = row
    assert can_login is True, (
        "DATABASE_URL authenticates as this role, so it must be able to log in"
    )
    assert inherits is False, "NOINHERIT is what keeps SET LOCAL ROLE load-bearing"
    assert bypass is False, "a request-serving identity must never bypass row level security"
    assert (is_super, createdb, createrole, replication) == (False, False, False, False)


async def test_the_login_role_is_a_member_of_the_restricted_role(privileged: AsyncSession) -> None:
    """Without this grant the role switch every request performs would fail outright."""
    granted = (
        (
            await privileged.execute(
                text(
                    "SELECT r.rolname FROM pg_auth_members am "
                    "JOIN pg_roles m ON m.oid = am.member "
                    "JOIN pg_roles r ON r.oid = am.roleid WHERE m.rolname = :role"
                ),
                {"role": LOGIN_ROLE},
            )
        )
        .scalars()
        .all()
    )
    assert RESTRICTED_ROLE in granted


async def test_the_login_role_holds_no_table_privileges_of_its_own(
    privileged: AsyncSession,
) -> None:
    """Checked without inherited rights, which is exactly the question ``NOINHERIT`` settles: before
    the role switch, a request-serving connection must be able to reach nothing."""
    for table in USER_OWNED + SHARED:
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            granted = await privileged.scalar(
                text("SELECT has_table_privilege(:role, :table, :privilege)"),
                {"role": LOGIN_ROLE, "table": table, "privilege": f"{privilege} WITH GRANT OPTION"},
            )
            assert granted is False, f"{LOGIN_ROLE} should hold no direct {privilege} on {table}"


# =========================================================================== 3.4 sessions


async def test_a_request_session_binds_the_acting_users_claims(engines: Engines) -> None:
    user_id = new_user_id()
    async with session_as(engines, user_id) as session:
        bound = await session.scalar(text("SELECT weathra_current_user_id()"))
        assert bound == user_id


async def test_a_request_session_runs_under_the_restricted_role(engines: Engines) -> None:
    async with session_as(engines, new_user_id()) as session:
        current = await session.scalar(text("SELECT current_user"))
        assert current == engines.settings.database_restricted_role


async def test_a_session_with_no_principal_binds_no_owner(engines: Engines) -> None:
    async with session_as(engines, None) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) is None


@pytest.mark.usefixtures("clean_database")
async def test_a_session_with_no_principal_reads_no_user_owned_row(engines: Engines) -> None:
    """A handler that opens a session without a principal must see nothing, not everything."""
    owner = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, owner)
        await insert_saved_location(admin, owner)

    async with session_as(engines, None) as session:
        rows = await session.scalar(text("SELECT count(*) FROM saved_locations"))
        assert rows == 0


@pytest.mark.usefixtures("clean_database")
async def test_the_policy_hides_another_users_row_with_the_predicate_omitted(
    engines: Engines,
) -> None:
    """The second gate, on its own.

    The query below deliberately has no ``WHERE user_id = ...``. If the policy were dropped, it
    would return the other user's row — which is exactly what task 18.9 asks to be proved.
    """
    first, second = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, first)
        await insert_profile(admin, second)
        await insert_saved_location(admin, second, location_id="loc:48.14,11.58")

    async with session_as(engines, first) as session:
        visible = (
            await session.execute(text("SELECT id::text, user_id::text FROM saved_locations"))
        ).all()
        assert visible == [], "the policy did not hide another user's row"


@pytest.mark.usefixtures("clean_database")
async def test_each_user_sees_only_their_own_rows(engines: Engines) -> None:
    first, second = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        for user_id in (first, second):
            await insert_profile(admin, user_id)
            await insert_saved_location(admin, user_id)

    for user_id in (first, second):
        async with session_as(engines, user_id) as session:
            rows = (await session.execute(text("SELECT user_id::text FROM saved_locations"))).all()
            assert [row[0] for row in rows] == [user_id]


@pytest.mark.usefixtures("clean_database")
async def test_a_write_cannot_place_a_row_under_another_owner(engines: Engines) -> None:
    """The WITH CHECK half of the policy."""
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)

    with pytest.raises(DBAPIError):
        async with session_as(engines, actor) as session:
            await insert_saved_location(session, victim)


@pytest.mark.usefixtures("clean_database")
async def test_a_cross_user_update_changes_nothing(engines: Engines) -> None:
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)
        row_id = await insert_saved_location(admin, victim)

    async with session_as(engines, actor) as session:
        result = await session.execute(
            text("UPDATE saved_locations SET label = 'hijacked' WHERE id = :id RETURNING id"),
            {"id": row_id},
        )
        assert result.all() == []

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        label = await admin.scalar(
            text("SELECT label FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
        assert label == "Berlin"


@pytest.mark.usefixtures("clean_database")
async def test_a_cross_user_delete_removes_nothing(engines: Engines) -> None:
    actor, victim = new_user_id(), new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await insert_profile(admin, actor)
        await insert_profile(admin, victim)
        row_id = await insert_saved_location(admin, victim)

    async with session_as(engines, actor) as session:
        result = await session.execute(
            text("DELETE FROM saved_locations WHERE id = :id RETURNING id"), {"id": row_id}
        )
        assert result.all() == []

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        assert await admin.scalar(
            text("SELECT count(*) FROM saved_locations WHERE id = :id"), {"id": row_id}
        )


@pytest.mark.usefixtures("clean_database")
async def test_a_users_own_write_and_read_succeed(engines: Engines) -> None:
    user_id = new_user_id()
    async with session_as(engines, user_id) as session:
        await session.execute(
            text("INSERT INTO profiles (user_id) VALUES (:user_id)"), {"user_id": user_id}
        )
        row_id = await insert_saved_location(session, user_id)

    async with session_as(engines, user_id) as session:
        found = await session.scalar(
            text("SELECT label FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
        assert found == "Berlin"


@pytest.mark.usefixtures("clean_database")
async def test_the_shared_corpus_is_readable_under_any_principal(engines: Engines) -> None:
    """The corpus is readable by any authenticated user without being user-owned."""
    async with privileged_session(engines.privileged_sessionmaker) as admin:
        await admin.execute(
            text(
                "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                "VALUES ('dew-point', 'Dew point', 'humidity', 'Authored for Weathra', 'abc')"
            )
        )

    for user_id in (new_user_id(), new_user_id()):
        async with session_as(engines, user_id) as session:
            assert await session.scalar(text("SELECT count(*) FROM knowledge_documents")) == 1


@pytest.mark.usefixtures("clean_database")
async def test_the_restricted_role_cannot_write_the_corpus(engines: Engines) -> None:
    """Read-only to users: ingestion runs under the privileged connection."""
    with pytest.raises(ProgrammingError):
        async with session_as(engines, new_user_id()) as session:
            await session.execute(
                text(
                    "INSERT INTO knowledge_documents (id, title, topic, provenance, content_hash) "
                    "VALUES ('injected', 'x', 'y', 'z', 'h')"
                )
            )


@pytest.mark.usefixtures("clean_database")
async def test_snapshots_are_visible_to_every_principal(engines: Engines) -> None:
    """One user's request improves everyone's What Changed? history."""
    async with session_as(engines, new_user_id()) as session:
        await session.execute(
            text(
                "INSERT INTO forecast_snapshots "
                "(id, location_id, location, window_start, window_end, provider, unit_system, "
                " retrieved_at, daily_series) VALUES "
                "(gen_random_uuid(), 'loc:52.52,13.41', '{}', now(), now() + interval '7 days', "
                " 'open-meteo', 'metric', now(), '{}')"
            )
        )

    async with session_as(engines, new_user_id()) as other:
        assert await other.scalar(text("SELECT count(*) FROM forecast_snapshots")) == 1


async def test_the_privileged_connection_is_distinct_from_the_request_one(
    engines: Engines,
) -> None:
    assert engines.privileged() is not engines.request_engine
    assert engines.privileged().pool.__class__.__name__ == "NullPool"

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        as_admin = await admin.scalar(text("SELECT current_user"))
    async with session_as(engines, new_user_id()) as session:
        as_request = await session.scalar(text("SELECT current_user"))

    assert as_admin != as_request
    assert as_request == engines.settings.database_restricted_role


async def test_the_role_does_not_leak_to_the_next_use_of_a_pooled_connection(
    engines: Engines,
) -> None:
    """SET LOCAL ends with the transaction; this asserts it, because a leak would be cross-user."""
    async with session_as(engines, new_user_id()):
        pass
    async with engines.request_sessionmaker() as plain:
        current = await plain.scalar(text("SELECT current_user"))
        assert current != engines.settings.database_restricted_role
        assert await plain.scalar(text("SELECT weathra_current_user_id()")) is None


async def test_claims_are_reset_between_requests(engines: Engines) -> None:
    first, second = new_user_id(), new_user_id()
    async with session_as(engines, first) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) == first
    async with session_as(engines, second) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) == second


async def test_a_failing_request_rolls_back_and_still_resets(engines: Engines) -> None:
    user_id = new_user_id()
    with pytest.raises(RuntimeError, match="handler blew up"):
        async with session_as(engines, user_id) as session:
            await session.execute(
                text("INSERT INTO profiles (user_id) VALUES (:user_id)"), {"user_id": user_id}
            )
            raise RuntimeError("handler blew up")

    async with privileged_session(engines.privileged_sessionmaker) as admin:
        assert (
            await admin.scalar(
                text("SELECT count(*) FROM profiles WHERE user_id = :user_id"),
                {"user_id": user_id},
            )
            == 0
        )
