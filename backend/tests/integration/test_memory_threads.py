"""Task 12.2 — thread ownership, the resolved-entity projection, and honest unresolved references.

`db` tests: the ownership gate is only worth asserting against the real table it guards, with Row
Level Security in force behind it. Every session here is opened the way a request opens one — as a
principal, under the restricted role — so nothing passes because it ran privileged.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.comparison import Criterion
from weathra.domain.errors import ThreadNotFound
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, UnitSystem
from weathra.memory.threads import (
    MAX_REMEMBERED_LOCATIONS,
    ResolvedEntities,
    ThreadStore,
    TurnRecord,
    WindowMemory,
)

pytestmark = pytest.mark.db

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    country_code="DE",
)
MUNICH = Location(
    display_name="Munich",
    latitude=48.14,
    longitude=11.58,
    timezone="Europe/Berlin",
    country_code="DE",
)
LISBON = Location(
    display_name="Lisbon",
    latitude=38.72,
    longitude=-9.14,
    timezone="Europe/Lisbon",
    country_code="PT",
)

THREE_DAYS = WindowMemory(kind="forecast_days", days=3, label="the next 3 days")


def _principal(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


# =========================================================================== creation and ownership


async def test_the_acting_user_is_recorded_as_the_owner_at_creation(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        created = await ThreadStore(session, _principal(user), db_settings).create(title="Berlin")

    assert created.user_id == user
    assert created.title == "Berlin"
    assert created.expires_at > created.created_at


async def test_the_owner_is_not_a_parameter_a_caller_can_supply(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """``specs/memory``: a supplied identifier must not override the token's subject.

    Asserted structurally — ``create`` has no owner parameter at all, so there is nothing to pass.
    """
    import inspect

    parameters = inspect.signature(ThreadStore.create).parameters
    assert "user_id" not in parameters
    assert "owner" not in parameters
    assert set(parameters) == {"self", "title", "entities"}


async def test_a_foreign_thread_id_fails_without_disclosing_that_it_exists(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        thread = await ThreadStore(session, _principal(owner), db_settings).create()

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)
        store = ThreadStore(session, _principal(intruder), db_settings)

        with pytest.raises(ThreadNotFound) as raised:
            await store.open(thread.id)

        # The message for a thread that is someone else's must be the message for one that is not
        # there at all — otherwise the error itself is the disclosure.
        with pytest.raises(ThreadNotFound) as absent:
            await store.open(str(uuid.uuid4()))
        assert str(raised.value) == str(absent.value)
        assert thread.id not in str(raised.value)
        assert owner not in str(raised.value)

        assert await store.find(thread.id) is None
        assert await store.list() == ()


async def test_a_foreign_threads_entities_are_never_returned(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    owner = new_user_id()
    intruder = new_user_id()

    async with session_as(engines, owner) as session:
        await insert_profile(session, owner)
        store = ThreadStore(session, _principal(owner), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN], window=THREE_DAYS)

    async with session_as(engines, intruder) as session:
        await insert_profile(session, intruder)
        intruding = ThreadStore(session, _principal(intruder), db_settings)
        with pytest.raises(ThreadNotFound):
            await intruding.entities(thread.id)
        with pytest.raises(ThreadNotFound):
            await intruding.resolve_reference(thread.id)
        with pytest.raises(ThreadNotFound):
            await intruding.record(thread.id, locations=[LISBON])
        with pytest.raises(ThreadNotFound):
            await intruding.delete(thread.id)

    # And the owner's thread is untouched by all of that.
    async with session_as(engines, owner) as session:
        entities = await ThreadStore(session, _principal(owner), db_settings).entities(thread.id)
    assert entities.location_identifiers == (BERLIN.identifier,)


async def test_two_threads_of_one_user_stay_separate(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)

        berlin_thread = await store.create(title="Berlin")
        lisbon_thread = await store.create(title="Lisbon")
        await store.record(berlin_thread.id, locations=[BERLIN], window=THREE_DAYS)
        await store.record(lisbon_thread.id, locations=[LISBON])

        berlin = await store.resolve_reference(berlin_thread.id)
        lisbon = await store.resolve_reference(lisbon_thread.id)

    assert [location.display_name for location in berlin.locations] == ["Berlin"]
    assert [location.display_name for location in lisbon.locations] == ["Lisbon"]

    # The window established in one thread is not available in the other.
    async with session_as(engines, user) as session:
        store = ThreadStore(session, _principal(user), db_settings)
        assert (await store.resolve_reference(berlin_thread.id, what="window")).resolved
        assert not (await store.resolve_reference(lisbon_thread.id, what="window")).resolved


# =========================================================================== the projection


async def test_resolved_entities_are_recorded(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()

        updated = await store.record(
            thread.id,
            locations=[BERLIN, MUNICH],
            unit_system=UnitSystem.IMPERIAL,
            window=THREE_DAYS,
            criterion=Criterion.WARMEST,
            data_class=DataClass.FORECAST,
            turn=TurnRecord(role="user", text="Compare Berlin and Munich", at=datetime.now(UTC)),
        )

    entities = updated.entities
    assert [location.display_name for location in entities.locations] == ["Berlin", "Munich"]
    assert entities.unit_system is UnitSystem.IMPERIAL
    assert entities.window == THREE_DAYS
    assert entities.criterion is Criterion.WARMEST
    assert entities.last_data_class is DataClass.FORECAST
    assert [turn.text for turn in entities.turns] == ["Compare Berlin and Munich"]


async def test_recording_one_field_leaves_the_others_alone(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "What about precipitation?" must not clear the window it is asking about."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN], window=THREE_DAYS)

        after = await store.record(thread.id, data_class=DataClass.FORECAST)

    assert after.entities.window == THREE_DAYS
    assert after.entities.location_identifiers == (BERLIN.identifier,)
    assert after.entities.last_data_class is DataClass.FORECAST


async def test_resolution_survives_a_restart(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """A new session, a new store, a new engine — the context is still there.

    The projection is a table, not process state, which is the whole reason it is a table.
    """
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN, MUNICH], window=THREE_DAYS)

    restarted = Engines.create(db_settings)
    try:
        async with session_as(restarted, user) as session:
            reference = await ThreadStore(session, _principal(user), db_settings).resolve_reference(
                thread.id
            )
    finally:
        await restarted.dispose()

    assert reference.resolved
    assert [location.display_name for location in reference.locations] == ["Berlin", "Munich"]


async def test_repeating_the_same_locations_does_not_push_out_the_pair(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN, MUNICH])
        after = await store.record(thread.id, locations=[BERLIN, MUNICH])

    assert [location.display_name for location in after.entities.locations] == ["Berlin", "Munich"]


async def test_the_projection_is_bounded(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """An unbounded JSONB column is a row that grows for the whole retention window."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()

        for index in range(MAX_REMEMBERED_LOCATIONS + 4):
            await store.record(
                thread.id,
                locations=[
                    Location(
                        display_name=f"Place {index}",
                        latitude=float(index),
                        longitude=float(index),
                        timezone="UTC",
                    )
                ],
            )
        entities = await store.entities(thread.id)

    assert len(entities.locations) == MAX_REMEMBERED_LOCATIONS
    assert entities.locations[-1].display_name == f"Place {MAX_REMEMBERED_LOCATIONS + 3}"


async def test_only_the_necessary_content_is_stored(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """``specs/memory``: the turn text, the resolved entities, and the evidence references.

    Read back from the raw column rather than through the model, so a field the model happens to
    drop on the way out would still be caught here.
    """
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(
            thread.id,
            locations=[BERLIN],
            turn=TurnRecord(
                role="assistant",
                text="Berlin is 11 °C.",
                at=datetime.now(UTC),
                evidence_id="ev_123",
                data_class=DataClass.CURRENT,
            ),
        )

        stored = await session.scalar(
            text("SELECT resolved_entities FROM threads WHERE id = :id"), {"id": thread.id}
        )

    assert set(stored) <= {
        "locations",
        "unit_system",
        "window",
        "criterion",
        "last_data_class",
        "turns",
    }
    assert set(stored["turns"][0]) == {"role", "text", "at", "evidence_id", "data_class"}
    assert stored["turns"][0]["evidence_id"] == "ev_123"


# =========================================================================== follow-up resolution


async def test_locations_carry_into_a_follow_up(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "Compare Berlin and Munich" then "Which one is warmer tomorrow?" — the spec's own scenario."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN, MUNICH], criterion=Criterion.WARMEST)

        reference = await store.resolve_reference(thread.id)
        named = await store.resolve_reference(thread.id, name="berlin")

    assert [location.display_name for location in reference.locations] == ["Berlin", "Munich"]
    assert named.resolved
    assert named.locations == (BERLIN,)


async def test_the_window_carries_into_a_follow_up(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "Next 3 days" then "What about precipitation?" — the same 3-day window."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN], window=THREE_DAYS)

        reference = await store.resolve_reference(thread.id, what="window")

    assert reference.resolved
    assert reference.window is not None
    assert reference.window.days == 3


async def test_units_carry_into_a_follow_up(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, unit_system=UnitSystem.IMPERIAL)
        reference = await store.resolve_reference(thread.id, what="unit_system")

    assert reference.resolved
    assert reference.unit_system is UnitSystem.IMPERIAL


@pytest.mark.parametrize("what", ["location", "window", "unit_system", "criterion"])
async def test_a_reference_no_turn_established_is_reported_unresolved(
    engines: Engines, db_settings: Settings, clean_database: None, what: str
) -> None:
    """The load-bearing case: memory says it does not know rather than guessing."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()

        reference = await store.resolve_reference(thread.id, what=what)

    assert not reference.resolved
    assert reference.locations == ()
    assert reference.window is None
    assert reference.unit_system is None
    assert reference.criterion is None
    assert reference.reason is not None
    assert "No earlier turn" in reference.reason


async def test_a_location_name_no_turn_established_is_not_the_nearest_match(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Berkeley must not resolve to Berlin. A near-miss guess is the dangerous kind."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN])

        reference = await store.resolve_reference(thread.id, name="Berkeley")

    assert not reference.resolved
    assert reference.locations == ()
    assert reference.reason is not None
    assert "Berkeley" in reference.reason


async def test_an_unknown_kind_of_reference_is_reported_rather_than_guessed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        reference = await store.resolve_reference(thread.id, what="favourite_colour")

    assert not reference.resolved
    assert reference.reason is not None
    assert "conversation memory keeps" in reference.reason


# =========================================================================== deletion


async def test_a_thread_is_deleted_on_request_and_the_deletion_is_confirmed(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = ThreadStore(session, _principal(user), db_settings)
        thread = await store.create()
        await store.record(thread.id, locations=[BERLIN])

        confirmed = await store.delete(thread.id)
        assert confirmed == thread.id

    async with session_as(engines, user) as session:
        store = ThreadStore(session, _principal(user), db_settings)
        assert await store.find(thread.id) is None
        with pytest.raises(ThreadNotFound):
            await store.open(thread.id)


# =========================================================================== the composed key


async def test_the_checkpoint_key_comes_from_the_acting_principal(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """Derived from the principal, not from the stored row — see the method's own docstring."""
    user = new_user_id()
    principal = _principal(user)
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        thread = await ThreadStore(session, principal, db_settings).create()

    assert thread.checkpoint_key(principal) == f"{user}:{thread.id}"


# =========================================================================== the projection model


def test_the_projection_refuses_a_field_it_does_not_know() -> None:
    """So "only what a follow-up needs is stored" cannot be widened by a caller's dict."""
    with pytest.raises(ValueError, match="browsing_history"):
        ResolvedEntities.model_validate({"browsing_history": ["berlin", "munich"]})
