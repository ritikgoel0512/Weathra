"""Tasks 4.4, 4.5, and 4.6 against a real PostgreSQL.

The profile's idempotency, the claims binding, and the ownership-enforcing repository all need a
real database: the first because it rests on ``ON CONFLICT DO NOTHING``, the second because the
policies read a Postgres setting, the third because "returns not-found rather than another user's
row" is only meaningful with two users' rows actually present.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text

from tests.db_support import claims_for, new_user_id
from weathra.auth.profiles import ensure_profile, load_profile, touch_profile
from weathra.auth.repository import OwnedRepository
from weathra.auth.rls import administrative_session, claims_of, session_for
from weathra.db.engine import Engines
from weathra.db.models import ForecastSnapshot, Preference, Profile, SavedLocation, Thread
from weathra.domain.errors import RecordNotFound
from weathra.domain.identity import Principal

pytestmark = [pytest.mark.db, pytest.mark.usefixtures("clean_database")]


def principal_for(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


# =========================================================================== 4.5 claims binding


async def test_a_session_for_a_principal_binds_that_principals_subject(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        assert await session.scalar(text("SELECT weathra_current_user_id()")) == actor.user_id


async def test_the_bound_subject_is_the_principals_own_not_a_claim_a_caller_shaped(
    engines: Engines,
) -> None:
    """A claim mapping cannot disagree with ``Principal.user_id``; the principal wins."""
    actor = principal_for(new_user_id())
    claims = claims_of(actor)
    assert claims is not None
    assert claims["sub"] == actor.user_id


async def test_a_session_with_no_principal_reads_no_user_owned_row(engines: Engines) -> None:
    owner = new_user_id()
    async with administrative_session(engines) as admin:
        await admin.execute(text("INSERT INTO profiles (user_id) VALUES (:u)"), {"u": owner})

    async with session_for(engines, None) as session:
        assert await session.scalar(text("SELECT count(*) FROM profiles")) == 0


# =========================================================================== 4.4 profiles


async def test_a_profile_is_created_on_first_authenticated_use(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        assert await load_profile(session, actor) is None
        created = await ensure_profile(session, actor)

    assert created.created_now is True
    assert created.user_id == actor.user_id

    async with session_for(engines, actor) as session:
        assert await load_profile(session, actor) is not None


async def test_a_second_call_does_not_create_a_second_profile(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)
    async with session_for(engines, actor) as session:
        again = await ensure_profile(session, actor)

    assert again.created_now is False

    async with administrative_session(engines) as admin:
        count = await admin.scalar(
            text("SELECT count(*) FROM profiles WHERE user_id = :u"), {"u": actor.user_id}
        )
    assert count == 1


async def test_concurrent_first_requests_leave_exactly_one_profile(engines: Engines) -> None:
    """The scenario from specs/authentication. A check-then-insert would lose this race."""
    actor = principal_for(new_user_id())

    async def first_use() -> None:
        async with session_for(engines, actor) as session:
            await ensure_profile(session, actor)

    await asyncio.gather(*(first_use() for _ in range(6)), return_exceptions=False)

    async with administrative_session(engines) as admin:
        count = await admin.scalar(
            text("SELECT count(*) FROM profiles WHERE user_id = :u"), {"u": actor.user_id}
        )
    assert count == 1


async def test_the_profile_table_holds_no_credential_or_contact_data(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)

    async with administrative_session(engines) as admin:
        columns = {
            row[0]
            for row in await admin.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'profiles'"
                )
            )
        }
    assert columns == {"user_id", "created_at", "last_seen_at"}
    assert not any(forbidden in columns for forbidden in ("email", "password", "token", "phone"))

    # The email arrives in the token on every request; it is never written down.
    async with administrative_session(engines) as admin:
        rendered = str((await admin.execute(text("SELECT * FROM profiles"))).mappings().all())
    assert actor.email is not None
    assert actor.email not in rendered


async def test_one_user_cannot_create_a_profile_for_another(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    other = principal_for(new_user_id())

    with pytest.raises(Exception):  # noqa: B017 - the policy's own violation type
        async with session_for(engines, actor) as session:
            await session.execute(
                text("INSERT INTO profiles (user_id) VALUES (:u)"), {"u": other.user_id}
            )

    async with administrative_session(engines) as admin:
        assert (
            await admin.scalar(
                text("SELECT count(*) FROM profiles WHERE user_id = :u"), {"u": other.user_id}
            )
            == 0
        )


async def test_touching_a_profile_updates_only_the_last_seen_timestamp(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        created = await ensure_profile(session, actor)

    async with session_for(engines, actor) as session:
        await session.execute(text("SELECT pg_sleep(0.01)"))
        await touch_profile(session, actor)

    async with session_for(engines, actor) as session:
        after = await load_profile(session, actor)

    assert after is not None
    assert after.created_at == created.created_at
    assert after.last_seen_at >= created.last_seen_at


# =========================================================================== 4.6 repository


async def _seed(engines: Engines, actor: Principal) -> str:
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)
        repository = OwnedRepository(session, actor)
        saved = repository.add(
            SavedLocation(
                location_id="loc:52.52,13.41",
                label="Berlin",
                location={"display_name": "Berlin"},
            )
        )
        await session.flush()
        return saved.id


async def test_a_scoped_read_returns_the_acting_users_row(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, actor)

    async with session_for(engines, actor) as session:
        found = await OwnedRepository(session, actor).get(SavedLocation, row_id)
        assert found.label == "Berlin"
        assert found.user_id == actor.user_id


async def test_a_scoped_write_records_the_acting_user_as_owner(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, actor)

    async with administrative_session(engines) as admin:
        owner = await admin.scalar(
            text("SELECT user_id::text FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
    assert owner == actor.user_id


async def test_a_write_cannot_choose_another_owner(engines: Engines) -> None:
    """`add` sets the owner rather than trusting one, so a passed-in owner is simply overwritten."""
    actor = principal_for(new_user_id())
    victim = principal_for(new_user_id())
    async with session_for(engines, victim) as session:
        await ensure_profile(session, victim)

    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)
        repository = OwnedRepository(session, actor)
        staged = repository.add(
            SavedLocation(
                user_id=victim.user_id,
                location_id="loc:48.14,11.58",
                label="Munich",
                location={},
            )
        )
        await session.flush()
        assert staged.user_id == actor.user_id


async def test_a_cross_user_read_returns_not_found(engines: Engines) -> None:
    victim = principal_for(new_user_id())
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, victim)
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)

    async with session_for(engines, actor) as session:
        with pytest.raises(RecordNotFound) as caught:
            await OwnedRepository(session, actor).get(SavedLocation, row_id)

    assert caught.value.code == "record_not_found"


async def test_a_cross_user_read_is_indistinguishable_from_a_missing_row(
    engines: Engines,
) -> None:
    """A probe must not be able to tell "not yours" from "does not exist"."""
    victim = principal_for(new_user_id())
    actor = principal_for(new_user_id())
    existing = await _seed(engines, victim)
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)

    messages = []
    for record_id in (existing, new_user_id()):
        async with session_for(engines, actor) as session:
            with pytest.raises(RecordNotFound) as caught:
                await OwnedRepository(session, actor).get(SavedLocation, record_id)
            messages.append(caught.value.message)

    assert messages[0] == messages[1]


async def test_a_cross_user_mutation_leaves_the_target_unchanged(engines: Engines) -> None:
    victim = principal_for(new_user_id())
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, victim)
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)

    async with session_for(engines, actor) as session:
        with pytest.raises(RecordNotFound):
            await OwnedRepository(session, actor).update(SavedLocation, row_id, label="hijacked")

    async with administrative_session(engines) as admin:
        label = await admin.scalar(
            text("SELECT label FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
    assert label == "Berlin"


async def test_a_cross_user_delete_leaves_the_target_in_place(engines: Engines) -> None:
    victim = principal_for(new_user_id())
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, victim)
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)

    async with session_for(engines, actor) as session:
        with pytest.raises(RecordNotFound):
            await OwnedRepository(session, actor).delete(SavedLocation, row_id)

    async with administrative_session(engines) as admin:
        assert await admin.scalar(
            text("SELECT count(*) FROM saved_locations WHERE id = :id"), {"id": row_id}
        )


async def test_an_owner_can_update_and_delete_their_own_row(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    row_id = await _seed(engines, actor)

    async with session_for(engines, actor) as session:
        updated = await OwnedRepository(session, actor).update(SavedLocation, row_id, label="Home")
        assert updated.label == "Home"

    async with session_for(engines, actor) as session:
        await OwnedRepository(session, actor).delete(SavedLocation, row_id)

    async with administrative_session(engines) as admin:
        assert (
            await admin.scalar(
                text("SELECT count(*) FROM saved_locations WHERE id = :id"), {"id": row_id}
            )
            == 0
        )


async def test_an_update_cannot_move_a_row_to_another_owner(engines: Engines) -> None:
    actor = principal_for(new_user_id())
    victim = principal_for(new_user_id())
    row_id = await _seed(engines, actor)
    async with session_for(engines, victim) as session:
        await ensure_profile(session, victim)

    async with session_for(engines, actor) as session:
        await OwnedRepository(session, actor).update(
            SavedLocation, row_id, user_id=victim.user_id, label="still mine"
        )

    async with administrative_session(engines) as admin:
        owner = await admin.scalar(
            text("SELECT user_id::text FROM saved_locations WHERE id = :id"), {"id": row_id}
        )
    assert owner == actor.user_id


async def test_a_listing_returns_only_the_acting_users_rows(engines: Engines) -> None:
    first = principal_for(new_user_id())
    second = principal_for(new_user_id())
    await _seed(engines, first)
    await _seed(engines, second)

    for actor in (first, second):
        async with session_for(engines, actor) as session:
            rows = await OwnedRepository(session, actor).list(SavedLocation)
            assert [row.user_id for row in rows] == [actor.user_id]


async def test_a_count_is_scoped_too(engines: Engines) -> None:
    """The saved-location limit must count the acting user's rows, not everyone's."""
    first = principal_for(new_user_id())
    second = principal_for(new_user_id())
    await _seed(engines, first)
    await _seed(engines, second)

    async with session_for(engines, first) as session:
        assert await OwnedRepository(session, first).count(SavedLocation) == 1


async def test_delete_all_removes_only_the_acting_users_rows(engines: Engines) -> None:
    """The mechanism behind account data deletion."""
    actor = principal_for(new_user_id())
    other = principal_for(new_user_id())
    await _seed(engines, actor)
    await _seed(engines, other)

    async with session_for(engines, actor) as session:
        removed = await OwnedRepository(session, actor).delete_all(SavedLocation)
    assert removed == 1

    async with session_for(engines, other) as session:
        assert await OwnedRepository(session, other).count(SavedLocation) == 1


async def test_a_primary_key_read_finds_the_acting_users_singleton_row(
    engines: Engines,
) -> None:
    """Preferences are keyed by the user id itself rather than a row id."""
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)
        OwnedRepository(session, actor).add(Preference(unit_system="imperial"))

    async with session_for(engines, actor) as session:
        found = await OwnedRepository(session, actor).get_by_primary_key(Preference)
        assert found is not None
        assert found.unit_system == "imperial"

    other = principal_for(new_user_id())
    async with session_for(engines, other) as session:
        await ensure_profile(session, other)
        assert await OwnedRepository(session, other).get_by_primary_key(Preference) is None


async def test_a_shared_table_cannot_be_reached_through_the_ownership_repository(
    engines: Engines,
) -> None:
    """A shared table has no owner to scope by, so asking is a programming error."""
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        with pytest.raises(TypeError, match="not a user-owned table"):
            await OwnedRepository(session, actor).list(ForecastSnapshot)


async def test_every_user_owned_model_is_reachable_through_the_repository(
    engines: Engines,
) -> None:
    actor = principal_for(new_user_id())
    async with session_for(engines, actor) as session:
        await ensure_profile(session, actor)
        repository = OwnedRepository(session, actor)
        for model in (Profile, Preference, SavedLocation, Thread):
            await repository.list(model)
