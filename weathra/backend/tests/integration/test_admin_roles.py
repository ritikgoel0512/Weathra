"""Task 31.1 and 31.2 — the administrative role as state, and the audit of changing it.

The role moved from a token claim to a row in `admin_roles` in `0011`, and most of this file exists
because of *how* it moved. A claim-reading build passed every test that came before, so the tests
that matter here are the ones that would fail if the claim were ever read again: a token carrying
the old shape, asserted at every layer that used to honour it.

The rest is the table's own security: a caller may read their own row and no other, may write
nothing at all, and the predicate that runs on every request cannot be turned into a way of
enumerating who else is an administrator.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from tests.db_support import (
    claims_for,
    grant_administrator,
    insert_profile,
    new_user_id,
    session_as,
)
from weathra.auth.roles import (
    ADMINISTRATOR_ROLE,
    GRANTABLE_ROLES,
    ROLE_SUBJECT_KIND,
    RoleStore,
    is_administrative,
)
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.errors import NotFound, ValidationFailed
from weathra.domain.identity import Principal
from weathra.entitlements.audit import recorded_changes
from weathra.entitlements.records import AdminAction

pytestmark = pytest.mark.db


async def a_user(engines: Engines) -> str:
    user_id = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, user_id)
    return user_id


# =========================================================================== 31.1 the role


async def test_the_role_is_read_from_backend_state(engines: Engines, clean_database: None) -> None:
    """`specs/authentication`: the backend consults role state keyed by the token subject."""
    user_id = await a_user(engines)
    principal = Principal.from_claims(claims_for(user_id))

    async with session_as(engines, user_id) as session:
        assert not await is_administrative(session, principal)

    await grant_administrator(engines, user_id)

    async with session_as(engines, user_id) as session:
        assert await is_administrative(session, principal)


async def test_a_token_asserting_the_role_is_not_administrative(
    engines: Engines, clean_database: None
) -> None:
    """The claim shape groups 28 to 30 honoured. It grants nothing now, and this is the guard.

    Written in exactly the old shape rather than an invented one: a build that started reading
    `app_metadata` again would pass every other test in this file.
    """
    pretender = await a_user(engines)
    principal = Principal.from_claims(claims_for(pretender, administrative=True))
    assert principal.claims.get("app_metadata") == {"weathra_role": ADMINISTRATOR_ROLE}

    async with session_as(engines, pretender, administrative=True) as session:
        assert not await is_administrative(session, principal)


async def test_the_sql_accessor_agrees_with_the_python_predicate(
    engines: Engines, clean_database: None
) -> None:
    """Two implementations of "is this an administrator" is one more than is safe.

    There are two only because a Row Level Security policy cannot call Python, so they are asserted
    to agree over the same session rather than trusted to.
    """
    user_id = await a_user(engines)
    principal = Principal.from_claims(claims_for(user_id, administrative=True))

    async with session_as(engines, user_id, administrative=True) as session:
        assert await session.scalar(text("SELECT weathra_is_administrative()")) is False
        assert await is_administrative(session, principal) is False

    await grant_administrator(engines, user_id)

    async with session_as(engines, user_id) as session:
        assert await session.scalar(text("SELECT weathra_is_administrative()")) is True
        assert await is_administrative(session, principal) is True


async def test_an_unbound_session_is_not_administrative(
    engines: Engines, clean_database: None
) -> None:
    """The one case a permissive default would be catastrophic and would look like an oversight."""
    async with session_as(engines, None) as session:
        assert await session.scalar(text("SELECT weathra_is_administrative()")) is False
        assert not await is_administrative(session, None)


async def test_none_is_not_an_administrator(engines: Engines, clean_database: None) -> None:
    async with session_as(engines, None) as session:
        assert not await is_administrative(session, None)


# =========================================================================== 31.1 the table


async def test_a_caller_reads_their_own_role_row_and_no_other(
    engines: Engines, clean_database: None
) -> None:
    """The owner policy is what lets the predicate run on the request path safely.

    Without it, asking "am I an administrator" would be a query that could be rewritten into
    "who else is".
    """
    mine, theirs = await a_user(engines), await a_user(engines)
    await grant_administrator(engines, mine)
    await grant_administrator(engines, theirs)

    async with session_as(engines, mine) as session:
        rows = await session.execute(text("SELECT subject_id FROM admin_roles"))
        assert {str(row[0]) for row in rows} == {mine}, "the predicate saw another subject's grant"


@pytest.mark.parametrize(
    "statement",
    [
        "INSERT INTO admin_roles (subject_id, role) VALUES (CAST(:u AS uuid), 'administrator')",
        "UPDATE admin_roles SET role = 'administrator' WHERE subject_id = CAST(:u AS uuid)",
        "DELETE FROM admin_roles WHERE subject_id = CAST(:u AS uuid)",
    ],
)
async def test_the_request_path_cannot_write_a_role_row(
    engines: Engines, clean_database: None, statement: str
) -> None:
    """Self-promotion is impossible by grant, not by check.

    A check can be forgotten on the sixteenth route somebody adds. A missing `INSERT` grant cannot.
    """
    user_id = await a_user(engines)
    async with session_as(engines, user_id) as session:
        with pytest.raises(DBAPIError):
            await session.execute(text(statement), {"u": user_id})


async def test_a_caller_cannot_promote_themselves_by_naming_their_own_subject(
    engines: Engines, clean_database: None
) -> None:
    """The row *would* be theirs, which is why the grant and not the policy is the defence.

    An owner-write policy would admit this insert — it is their own subject — and that is exactly
    the mistake `user_plans` documents and this table repeats the lesson from.
    """
    user_id = await a_user(engines)
    async with session_as(engines, user_id) as session:
        with pytest.raises(DBAPIError):
            await session.execute(
                text(
                    "INSERT INTO admin_roles (subject_id, role) "
                    "VALUES (CAST(:u AS uuid), 'administrator')"
                ),
                {"u": user_id},
            )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT count(*) FROM admin_roles")) == 0


# =========================================================================== 31.2 the audit


async def test_a_grant_is_recorded_with_the_administrator_who_made_it(
    engines: Engines, clean_database: None
) -> None:
    granter, granted = await a_user(engines), await a_user(engines)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await RoleStore(session).grant(granted, acting_principal=granter)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        entries = await recorded_changes(session, subject_kind=ROLE_SUBJECT_KIND)

    assert len(entries) == 1
    entry = entries[0]
    assert entry.action is AdminAction.ROLE_GRANT
    assert entry.acting_principal == granter
    assert entry.subject_id == f"{granted}:{ADMINISTRATOR_ROLE}"
    assert entry.before is None
    assert entry.after is not None and entry.after["subject_id"] == granted


async def test_a_revocation_records_what_was_taken_away(
    engines: Engines, clean_database: None
) -> None:
    granter, granted = await a_user(engines), await a_user(engines)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        store = RoleStore(session)
        await store.grant(granted, acting_principal=granter)
        await store.revoke(granted, acting_principal=granter)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        entries = await recorded_changes(session, subject_kind=ROLE_SUBJECT_KIND)

    assert [entry.action for entry in entries] == [AdminAction.ROLE_REVOKE, AdminAction.ROLE_GRANT]
    revocation = entries[0]
    assert revocation.after is None
    assert revocation.before is not None and revocation.before["role"] == ADMINISTRATOR_ROLE


async def test_a_bootstrap_grant_records_the_absence_of_a_granter_rather_than_a_fiction(
    engines: Engines, clean_database: None
) -> None:
    """There is no administrator to attribute the first grant to, and saying so is the honest
    record. Naming one would put a false claim in the log that exists to be believed."""
    first = await a_user(engines)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await RoleStore(session).grant(first, acting_principal=None)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        entries = await recorded_changes(session, subject_kind=ROLE_SUBJECT_KIND)
        holders = await RoleStore(session).holders()

    assert entries[0].after is not None
    assert entries[0].after["granted_by"] is None
    assert holders[0].granted_by is None


async def test_the_audit_row_carries_no_credential_material(
    engines: Engines, clean_database: None
) -> None:
    """There is nothing in the row to leak, and this asserts the row rather than the intention."""
    granter, granted = await a_user(engines), await a_user(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await RoleStore(session).grant(granted, acting_principal=granter)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        payloads = await session.execute(text("SELECT to_jsonb(entry) FROM admin_audit AS entry"))
        rendered = " ".join(str(row[0]) for row in payloads).lower()

    for forbidden in ("token", "bearer", "password", "secret", "api_key", "eyj", "postgresql://"):
        assert forbidden not in rendered, f"the audit trail carries {forbidden!r}"


async def test_the_audit_and_the_grant_are_one_transaction(
    engines: Engines, clean_database: None
) -> None:
    """A grant that committed with no audit row, or a row for a grant that rolled back, would each
    be worse than no audit at all — both look like a complete record."""
    granter, granted = await a_user(engines), await a_user(engines)

    with pytest.raises(RuntimeError):
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await RoleStore(session).grant(granted, acting_principal=granter)
            raise RuntimeError("something after the grant went wrong")

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT count(*) FROM admin_roles")) == 0
        assert await session.scalar(text("SELECT count(*) FROM admin_audit")) == 0


# =========================================================================== validation


async def test_an_unknown_role_is_refused_rather_than_written(
    engines: Engines, clean_database: None
) -> None:
    """A typo in a role name is a grant that silently does nothing and reads, in the audit trail,
    exactly like one that worked."""
    granter, granted = await a_user(engines), await a_user(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        with pytest.raises(ValidationFailed, match="not a role"):
            await RoleStore(session).grant(granted, "superuser", acting_principal=granter)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT count(*) FROM admin_roles")) == 0


async def test_revoking_a_role_nobody_holds_is_refused(
    engines: Engines, clean_database: None
) -> None:
    """ "Fine" for a subject who never held it is how a typo reads as a completed action."""
    granter, stranger = await a_user(engines), await a_user(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        with pytest.raises(NotFound):
            await RoleStore(session).revoke(stranger, acting_principal=granter)


async def test_regranting_is_idempotent_in_the_table_and_recorded_in_the_trail(
    engines: Engines, clean_database: None
) -> None:
    granter, granted = await a_user(engines), await a_user(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        store = RoleStore(session)
        await store.grant(granted, acting_principal=granter)
        await store.grant(granted, acting_principal=granter)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        assert await session.scalar(text("SELECT count(*) FROM admin_roles")) == 1
        entries = await recorded_changes(session, subject_kind=ROLE_SUBJECT_KIND)
    assert len(entries) == 2, "a re-assertion is a fact an auditor may want"
    assert entries[0].before is not None, "the second grant recorded what it replaced"


def test_only_the_administrative_role_is_grantable() -> None:
    """An allowlist, so a role added later is a deliberate decision rather than free text."""
    assert set(GRANTABLE_ROLES) == {ADMINISTRATOR_ROLE}
