"""Task 12.4 — saved locations: canonical storage, no duplicates, a limit that states itself."""

from __future__ import annotations

import uuid

import pytest

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.errors import RecordNotFound, SavedLocationLimitReached
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.memory.locations import SavedLocationStore

pytestmark = pytest.mark.db

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    region="Berlin",
    country="Germany",
    country_code="DE",
)
LISBON = Location(
    display_name="Lisbon",
    latitude=38.72,
    longitude=-9.14,
    timezone="Europe/Lisbon",
    country_code="PT",
)


def _principal(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


def _place(index: int) -> Location:
    return Location(
        display_name=f"Place {index}",
        latitude=float(index) / 10,
        longitude=float(index) / 10,
        timezone="UTC",
    )


def _settings_with_limit(base: Settings, limit: int) -> Settings:
    return base.model_copy(update={"saved_locations_limit": limit})


# =========================================================================== saving and listing


async def test_a_saved_location_is_listed_with_its_canonical_name_coordinates_and_timezone(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        saved = await store.save(BERLIN, label="Home")
        listed = await store.list()

    assert saved.created_now
    assert len(listed) == 1
    entry = listed[0]
    assert entry.label == "Home"
    assert entry.location.display_name == "Berlin"
    assert (entry.location.latitude, entry.location.longitude) == (52.52, 13.41)
    assert entry.location.timezone == "Europe/Berlin"
    assert entry.location.country_code == "DE"


async def test_the_canonical_location_is_stored_not_the_query_text(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """So listing never needs the geocoder, and a saved place cannot change meaning."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await SavedLocationStore(session, _principal(user), db_settings).save(BERLIN)

    async with session_as(engines, user) as session:
        listed = await SavedLocationStore(session, _principal(user), db_settings).list()

    assert listed[0].location == BERLIN
    assert listed[0].location_id == BERLIN.identifier


async def test_saved_locations_survive_a_restart(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await SavedLocationStore(session, _principal(user), db_settings).save(BERLIN)

    restarted = Engines.create(db_settings)
    try:
        async with session_as(restarted, user) as session:
            listed = await SavedLocationStore(session, _principal(user), db_settings).list()
    finally:
        await restarted.dispose()

    assert [entry.location.display_name for entry in listed] == ["Berlin"]


async def test_the_list_is_ordered_oldest_first(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """One save per session, because that is one save per request.

    Deliberately not two saves in one transaction: ``created_at`` defaults to ``now()``, which is
    the *transaction* timestamp, so two rows written inside one transaction are genuinely
    simultaneous and their order is only the id tiebreaker. No request does that, and pretending
    otherwise would be testing a shape the API cannot produce.
    """
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await SavedLocationStore(session, _principal(user), db_settings).save(BERLIN)
    async with session_as(engines, user) as session:
        await SavedLocationStore(session, _principal(user), db_settings).save(LISBON)

    async with session_as(engines, user) as session:
        listed = await SavedLocationStore(session, _principal(user), db_settings).list()

    assert [entry.location.display_name for entry in listed] == ["Berlin", "Lisbon"]


# =========================================================================== duplicates


async def test_a_duplicate_save_does_not_duplicate(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        first = await store.save(BERLIN, label="Home")
        second = await store.save(BERLIN, label="Berlin flat")
        listed = await store.list()

    assert len(listed) == 1
    assert first.id == second.id
    assert first.created_now
    assert not second.created_now
    assert listed[0].label == "Berlin flat", "the second save should update the label"


async def test_the_same_place_under_a_different_spelling_is_the_same_entry(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The key is the coordinate-derived identifier, not the display name."""
    also_berlin = BERLIN.model_copy(update={"display_name": "berlin", "region": None})

    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        await store.save(BERLIN)
        await store.save(also_berlin)
        listed = await store.list()

    assert len(listed) == 1
    assert listed[0].location.display_name == "berlin", "the latest canonical form is kept"


# =========================================================================== removal


async def test_a_saved_location_is_removed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        saved = await store.save(BERLIN)
        await store.save(LISBON)

        confirmed = await store.remove(saved.id)
        listed = await store.list()

    assert confirmed == saved.id
    assert [entry.location.display_name for entry in listed] == ["Lisbon"]


async def test_a_saved_location_can_be_removed_by_place(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        await store.save(BERLIN)
        await store.remove_place(BERLIN)
        assert await store.list() == ()


async def test_removing_something_absent_is_not_found(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), db_settings)
        with pytest.raises(RecordNotFound):
            await store.remove(str(uuid.uuid4()))
        with pytest.raises(RecordNotFound):
            await store.remove_place(LISBON)


# =========================================================================== the limit


async def test_the_limit_is_enforced_and_the_error_states_it(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    limited = _settings_with_limit(db_settings, 3)

    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), limited)
        for index in range(3):
            await store.save(_place(index))

        with pytest.raises(SavedLocationLimitReached) as raised:
            await store.save(_place(99))

        assert await store.count() == 3

    assert "3" in str(raised.value), "the error must state the limit"
    assert raised.value.details["limit"] == 3
    assert raised.value.code == "saved_location_limit_reached"


async def test_at_the_limit_an_existing_entry_can_still_be_relabelled(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """A bound on how many places, not a lock on the ones already there."""
    limited = _settings_with_limit(db_settings, 2)

    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), limited)
        await store.save(BERLIN, label="Home")
        await store.save(LISBON)

        again = await store.save(BERLIN, label="Berlin flat")
        assert not again.created_now
        assert await store.count() == 2


async def test_removing_one_makes_room_again(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    limited = _settings_with_limit(db_settings, 1)

    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = SavedLocationStore(session, _principal(user), limited)
        first = await store.save(BERLIN)
        with pytest.raises(SavedLocationLimitReached):
            await store.save(LISBON)

        await store.remove(first.id)
        await store.save(LISBON)
        assert [entry.location.display_name for entry in await store.list()] == ["Lisbon"]


# =========================================================================== isolation


async def test_two_users_lists_stay_separate(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    first = new_user_id()
    second = new_user_id()

    async with session_as(engines, first) as session:
        await insert_profile(session, first)
        await SavedLocationStore(session, _principal(first), db_settings).save(BERLIN)

    async with session_as(engines, second) as session:
        await insert_profile(session, second)
        store = SavedLocationStore(session, _principal(second), db_settings)
        await store.save(LISBON)
        listed = await store.list()

    assert [entry.location.display_name for entry in listed] == ["Lisbon"]

    async with session_as(engines, first) as session:
        theirs = await SavedLocationStore(session, _principal(first), db_settings).list()
    assert [entry.location.display_name for entry in theirs] == ["Berlin"]


async def test_the_same_place_saved_by_two_users_is_two_entries(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Uniqueness is per user, not global — one person saving Berlin must not block another."""
    first = new_user_id()
    second = new_user_id()

    for user in (first, second):
        async with session_as(engines, user) as session:
            await insert_profile(session, user)
            saved = await SavedLocationStore(session, _principal(user), db_settings).save(BERLIN)
            assert saved.created_now


async def test_one_user_cannot_remove_anothers_saved_location(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        saved = await SavedLocationStore(session, _principal(owner), db_settings).save(BERLIN)

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)
        store = SavedLocationStore(session, _principal(intruder), db_settings)
        with pytest.raises(RecordNotFound) as raised:
            await store.remove(saved.id)

        # Indistinguishable from an identifier that never existed.
        with pytest.raises(RecordNotFound) as absent:
            await store.remove(str(uuid.uuid4()))
        assert str(raised.value) == str(absent.value)

    async with session_as(engines, owner) as session:
        still = await SavedLocationStore(session, _principal(owner), db_settings).list()
    assert len(still) == 1


async def test_anothers_saved_locations_do_not_count_against_the_limit(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    limited = _settings_with_limit(db_settings, 2)

    crowded = new_user_id()
    async with session_as(engines, crowded) as session:
        await insert_profile(session, crowded)
        store = SavedLocationStore(session, _principal(crowded), limited)
        await store.save(_place(1))
        await store.save(_place(2))

    fresh = new_user_id()
    async with session_as(engines, fresh) as session:
        await insert_profile(session, fresh)
        store = SavedLocationStore(session, _principal(fresh), limited)
        assert await store.count() == 0
        await store.save(BERLIN)
