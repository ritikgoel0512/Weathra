"""Task 12.3 — preferences: chosen not inferred, defaults that say they are defaults.

`db` tests, as with the rest of the memory layer: every session is opened as a principal under the
restricted role, so isolation between users is proven against the policies rather than around them.
"""

from __future__ import annotations

import inspect

import pytest

from tests.db_support import claims_for, insert_profile, new_user_id, session_as
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.weather import UnitSystem
from weathra.memory.preferences import (
    PREFERENCE_FIELDS,
    PreferenceSource,
    PreferenceStore,
)
from weathra.memory.threads import ThreadStore

pytestmark = pytest.mark.db

LISBON = Location(
    display_name="Lisbon",
    latitude=38.72,
    longitude=-9.14,
    timezone="Europe/Lisbon",
    country_code="PT",
)


def _principal(user_id: str) -> Principal:
    return Principal.from_claims(claims_for(user_id))


# =========================================================================== defaults


async def test_documented_defaults_apply_when_nothing_is_set(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        view = await PreferenceStore(session, _principal(user), db_settings).read()

    assert view.unit_system is UnitSystem.METRIC
    assert view.forecast_horizon_days == db_settings.default_forecast_days
    assert view.default_location is None


async def test_an_unset_preference_is_reported_as_a_default_not_as_a_choice(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The distinction ``specs/memory`` asks for by name.

    Without it, a person who has never touched their settings is told they chose metric.
    """
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        view = await PreferenceStore(session, _principal(user), db_settings).read()

    assert not view.any_chosen
    for field in PREFERENCE_FIELDS:
        assert view.is_default(field), f"{field} was reported as a choice"


async def test_a_set_preference_is_reported_as_chosen_and_the_others_as_defaults(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        view = await PreferenceStore(session, _principal(user), db_settings).update(
            unit_system=UnitSystem.IMPERIAL
        )

    assert view.source_of("unit_system") is PreferenceSource.CHOSEN
    assert view.source_of("forecast_horizon_days") is PreferenceSource.DEFAULT
    assert view.source_of("default_location") is PreferenceSource.DEFAULT
    assert view.any_chosen


# =========================================================================== setting and applying


async def test_a_preference_is_set_and_then_applied(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """ "Imperial" set once, then applied to a later request that asked for nothing."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), db_settings).update(
            unit_system=UnitSystem.IMPERIAL, forecast_horizon_days=10
        )

    async with session_as(engines, user) as session:
        store = PreferenceStore(session, _principal(user), db_settings)
        assert await store.unit_system_for(None) is UnitSystem.IMPERIAL
        assert await store.horizon_for(None) == 10


async def test_an_explicit_request_wins_over_a_stored_preference(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """A preference is a default, not an override: one Celsius answer needs no profile change."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = PreferenceStore(session, _principal(user), db_settings)
        await store.update(unit_system=UnitSystem.IMPERIAL, forecast_horizon_days=10)

        assert await store.unit_system_for(UnitSystem.METRIC) is UnitSystem.METRIC
        assert await store.horizon_for(3) == 3


async def test_an_update_leaves_unmentioned_fields_alone(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = PreferenceStore(session, _principal(user), db_settings)
        await store.update(unit_system=UnitSystem.IMPERIAL, default_location=LISBON)

        after = await store.update(forecast_horizon_days=5)

    assert after.unit_system is UnitSystem.IMPERIAL
    assert after.default_location is not None
    assert after.default_location.display_name == "Lisbon"
    assert after.forecast_horizon_days == 5


async def test_a_field_can_be_set_back_to_the_default_without_clearing_the_rest(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """``None`` means "back to the default"; not mentioning a field means "leave it"."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = PreferenceStore(session, _principal(user), db_settings)
        await store.update(unit_system=UnitSystem.IMPERIAL, forecast_horizon_days=10)

        after = await store.update(unit_system=None)

    assert after.unit_system is UnitSystem.METRIC
    assert after.is_default("unit_system")
    assert after.forecast_horizon_days == 10
    assert after.source_of("forecast_horizon_days") is PreferenceSource.CHOSEN


async def test_a_default_location_is_stored_canonically(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The resolved location, not the query text, so it needs no re-resolving."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        stored = (
            await PreferenceStore(session, _principal(user), db_settings).update(
                default_location=LISBON
            )
        ).default_location

    assert stored == LISBON
    assert stored is not None
    assert stored.timezone == "Europe/Lisbon"


@pytest.mark.parametrize("days", [0, 17, -1])
async def test_a_horizon_outside_the_stored_range_is_refused(
    engines: Engines, db_settings: Settings, clean_database: None, days: int
) -> None:
    """Refused by the code as well as by the check constraint, with the bound in the message."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        with pytest.raises(ValueError, match="between 1 and 16"):
            await PreferenceStore(session, _principal(user), db_settings).update(
                forecast_horizon_days=days
            )


# =========================================================================== persistence


async def test_preferences_outlive_the_session(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """A new engine stands in for the person coming back tomorrow, on a new instance."""
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        await PreferenceStore(session, _principal(user), db_settings).update(
            unit_system=UnitSystem.IMPERIAL
        )

    restarted = Engines.create(db_settings)
    try:
        async with session_as(restarted, user) as session:
            view = await PreferenceStore(session, _principal(user), db_settings).read()
    finally:
        await restarted.dispose()

    assert view.unit_system is UnitSystem.IMPERIAL
    assert view.source_of("unit_system") is PreferenceSource.CHOSEN


# =========================================================================== deletion


async def test_deletion_restores_the_documented_defaults(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        store = PreferenceStore(session, _principal(user), db_settings)
        await store.update(
            unit_system=UnitSystem.IMPERIAL, forecast_horizon_days=14, default_location=LISBON
        )

        after_delete = await store.delete()
        assert not await store.has_chosen_anything()

    assert after_delete.unit_system is UnitSystem.METRIC
    assert after_delete.forecast_horizon_days == db_settings.default_forecast_days
    assert after_delete.default_location is None
    assert not after_delete.any_chosen

    async with session_as(engines, user) as session:
        reread = await PreferenceStore(session, _principal(user), db_settings).read()
    assert not reread.any_chosen


async def test_deleting_nothing_is_not_an_error(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    user = new_user_id()
    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        view = await PreferenceStore(session, _principal(user), db_settings).delete()
    assert not view.any_chosen


# =========================================================================== no inference


async def test_repeated_use_of_a_location_does_not_persist_it(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """``specs/memory``: asking about one place repeatedly must not make it a preference.

    Conversation memory records Lisbon — that is what a follow-up resolves against, and it expires
    with the thread. The *preference* table stays empty, because nobody chose anything.
    """
    user = new_user_id()
    principal = _principal(user)

    async with session_as(engines, user) as session:
        await insert_profile(session, user)
        threads = ThreadStore(session, principal, db_settings)
        thread = await threads.create()
        for _ in range(9):
            await threads.record(thread.id, locations=[LISBON])

        preferences = PreferenceStore(session, principal, db_settings)
        assert not await preferences.has_chosen_anything()
        view = await preferences.read()

    assert view.default_location is None
    assert not view.any_chosen


def test_the_store_offers_no_way_to_infer_a_preference() -> None:
    """Structural, so the property cannot be broken by a later well-meaning addition.

    Every public method is a read, an explicit write, a deletion, or an application of what is
    already stored. There is nothing that takes a usage event.
    """
    public = {
        name
        for name, member in inspect.getmembers(PreferenceStore)
        if not name.startswith("_") and (inspect.isfunction(member) or isinstance(member, property))
    }
    assert public == {
        "defaults",
        "delete",
        "has_chosen_anything",
        "horizon_for",
        "read",
        "unit_system_for",
        "update",
    }


def test_every_update_argument_is_a_stated_choice() -> None:
    """No ``observed_``, ``inferred_``, or ``from_usage`` parameter can creep in unnoticed."""
    parameters = set(inspect.signature(PreferenceStore.update).parameters) - {"self"}
    assert parameters == set(PREFERENCE_FIELDS)


# =========================================================================== isolation


async def test_one_users_preference_does_not_affect_another(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    first = new_user_id()
    second = new_user_id()

    async with session_as(engines, first) as session:
        await insert_profile(session, first)
        await PreferenceStore(session, _principal(first), db_settings).update(
            unit_system=UnitSystem.IMPERIAL, forecast_horizon_days=14, default_location=LISBON
        )

    async with session_as(engines, second) as session:
        await insert_profile(session, second)
        store = PreferenceStore(session, _principal(second), db_settings)
        view = await store.read()
        assert not await store.has_chosen_anything()

    assert view.unit_system is UnitSystem.METRIC
    assert view.forecast_horizon_days == db_settings.default_forecast_days
    assert view.default_location is None
    assert not view.any_chosen


async def test_a_deletion_by_one_user_leaves_anothers_preferences_standing(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    first = new_user_id()
    second = new_user_id()

    for user in (first, second):
        async with session_as(engines, user) as session:
            await insert_profile(session, user)
            await PreferenceStore(session, _principal(user), db_settings).update(
                unit_system=UnitSystem.IMPERIAL
            )

    async with session_as(engines, first) as session:
        await PreferenceStore(session, _principal(first), db_settings).delete()

    async with session_as(engines, second) as session:
        view = await PreferenceStore(session, _principal(second), db_settings).read()
    assert view.unit_system is UnitSystem.IMPERIAL


async def test_the_store_has_no_way_to_name_another_user(
    engines: Engines, db_settings: Settings, clean_database: None
) -> None:
    """The row's primary key *is* the acting subject, so there is no id to pass."""
    for name in ("read", "update", "delete", "has_chosen_anything"):
        parameters = set(inspect.signature(getattr(PreferenceStore, name)).parameters)
        assert "user_id" not in parameters
