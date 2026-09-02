"""Task 12.6 — a memory outage degrades the follow-up, not the forecast.

Offline by design. The outage is a database URL nothing listens on, and the weather comes from the
stub provider, so the two halves of ``specs/memory``'s degradation requirement are asserted without
arranging a real failure in a real store.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.provider_support import StubProvider, provider_settings
from weathra.config import Settings
from weathra.domain.errors import MemoryUnavailable, ThreadNotFound
from weathra.domain.identity import Principal
from weathra.domain.location import Location, Resolution
from weathra.domain.weather import DataClass, UnitSystem
from weathra.geocoding.base import Geocoder
from weathra.memory.checkpointer import Checkpointer
from weathra.memory.degradation import (
    CONTEXT_UNAVAILABLE,
    PREFERENCES_UNAVAILABLE,
    MemoryStatus,
    follow_up_unavailable,
    with_memory,
)
from weathra.memory.preferences import PreferenceStore
from weathra.memory.threads import ThreadStore
from weathra.weather.forecast_service import ForecastService

# 127.0.0.1 on a port nothing listens on: the connection is refused at once, so an "outage" costs
# no waiting and reaches no network.
DOWN = "postgresql://weathra:weathra@127.0.0.1:1/weathra"

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    country_code="DE",
)
THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PRINCIPAL = Principal.from_claims({"sub": "11111111-1111-4111-8111-111111111111"})


class _NoGeocoder:
    """A geocoder that satisfies the Protocol and refuses to be used.

    Every method raises. These tests hand the forecast service an already-resolved location, so a
    call here would mean the stateless path had reached for something it does not need.
    """

    name = "none"

    _REFUSAL = "the forecast path must not need to geocode an already-resolved place"

    async def resolve(self, query: str) -> Resolution:  # pragma: no cover
        raise AssertionError(self._REFUSAL)

    async def resolve_coordinates(  # pragma: no cover
        self, latitude: float, longitude: float
    ) -> Location:
        raise AssertionError(self._REFUSAL)

    async def search(  # pragma: no cover
        self, query: str, *, limit: int = 5
    ) -> tuple[Location, ...]:
        raise AssertionError(self._REFUSAL)


def _geocoder() -> Geocoder:
    """Named so the Protocol conformance is checked here rather than at each construction."""
    return _NoGeocoder()


def _down_session() -> async_sessionmaker:
    """A sessionmaker whose engine cannot connect. The outage, in one line."""
    return async_sessionmaker(
        create_async_engine(DOWN.replace("postgresql://", "postgresql+asyncpg://")),
        expire_on_commit=False,
    )


# =========================================================================== stateless capabilities


async def test_a_public_forecast_succeeds_during_a_memory_outage() -> None:
    """``specs/memory``: forecast, historical, analytics and comparison still succeed.

    They take a location and a window and call a provider. A memory outage has nothing to do with
    them, and failing them would turn a degraded service into a down one.
    """
    provider = StubProvider(daily_values=[11.0, 12.5, 13.0])
    service = ForecastService(
        provider=provider,
        geocoder=_geocoder(),
        settings=provider_settings(database_url=DOWN),
    )

    forecast = await service.forecast(BERLIN, days=3)

    assert forecast.data_class is DataClass.FORECAST
    assert forecast.daily.entries
    assert provider.forecast_calls == 1


async def test_current_conditions_and_analysis_also_survive_the_outage() -> None:
    provider = StubProvider(daily_values=[11.0, 12.5, 13.0])
    service = ForecastService(
        provider=provider,
        geocoder=_geocoder(),
        settings=provider_settings(database_url=DOWN),
    )

    current = await service.current(BERLIN)
    analysis = await service.analyse(BERLIN, days=3)

    assert current.data_class is DataClass.CURRENT
    assert analysis.findings
    assert analysis.horizon_days == 3


async def test_the_stateless_path_never_touches_a_session() -> None:
    """Structural: the forecast service is constructed without one, so it cannot need one."""
    import inspect

    parameters = set(inspect.signature(ForecastService.__init__).parameters)
    assert "session" not in parameters
    assert "engines" not in parameters
    assert parameters == {"self", "provider", "geocoder", "settings", "now"}


# =========================================================================== follow-ups


async def test_a_follow_up_reports_unavailable_context_rather_than_answering() -> None:
    refused = follow_up_unavailable("Which one is warmer tomorrow?")

    assert not refused.answered
    assert refused.message == CONTEXT_UNAVAILABLE
    assert not refused.status.available
    assert "cannot tell what this question refers to" in refused.message
    assert refused.question == "Which one is warmer tomorrow?"


async def test_the_refusal_carries_no_answer_to_be_mistaken_for_one() -> None:
    """A caveat under a confident number is read as a footnote. A refusal is read as the answer."""
    refused = follow_up_unavailable("What about precipitation?")
    assert set(refused.model_dump()) == {"answered", "message", "status", "question"}
    assert refused.model_dump()["answered"] is False


async def test_reading_a_thread_during_an_outage_reports_unavailability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """And reports it as an outage, not as a missing thread.

    The distinction is the whole requirement: ``ThreadNotFound`` would tell the caller their
    conversation is gone, when in fact it is unreachable and will be back.
    """
    settings = Settings(supabase_url="https://test.supabase.co", database_url=DOWN)
    async with _down_session()() as session:
        store = ThreadStore(session, PRINCIPAL, settings)
        with pytest.raises(MemoryUnavailable) as raised:
            await store.find(THREAD)

    assert raised.value.code == "memory_unavailable"
    assert not isinstance(raised.value, ThreadNotFound)


async def test_resolving_a_reference_during_an_outage_is_an_outage_not_a_guess() -> None:
    settings = Settings(supabase_url="https://test.supabase.co", database_url=DOWN)
    async with _down_session()() as session:
        store = ThreadStore(session, PRINCIPAL, settings)
        with pytest.raises(MemoryUnavailable):
            await store.resolve_reference(THREAD)


async def test_an_unreachable_checkpointer_reports_unavailability() -> None:
    checkpointer = Checkpointer(
        Settings(supabase_url="https://test.supabase.co", database_url=DOWN)
    )
    with pytest.raises(MemoryUnavailable):
        await checkpointer.open(connect_timeout=1.0)


# =========================================================================== preferences


async def test_preferences_fall_back_to_documented_defaults_and_say_so() -> None:
    """The defaults are the right answer. Presenting them as the person's choice is not."""
    settings = Settings(supabase_url="https://test.supabase.co", database_url=DOWN)
    async with _down_session()() as session:
        store = PreferenceStore(session, PRINCIPAL, settings)
        view, status = await with_memory(
            store.read, fallback=store.defaults, what="the preference store"
        )

    assert view.unit_system is UnitSystem.METRIC
    assert not view.any_chosen
    assert not status.available
    assert status.defaults_applied
    assert status.note == PREFERENCES_UNAVAILABLE
    assert "documented defaults" in (status.note or "")


async def test_a_reachable_store_reports_available_and_applies_no_fallback() -> None:
    async def reachable() -> str:
        return "the stored value"

    value, status = await with_memory(reachable, fallback="the default", what="the store")

    assert value == "the stored value"
    assert status.available
    assert status.note is None
    assert not status.defaults_applied


async def test_only_an_outage_is_absorbed_by_the_fallback() -> None:
    """A not-found or a validation error is not an outage and must reach the caller as itself."""

    async def missing() -> str:
        raise ThreadNotFound("No conversation thread with that identifier.")

    with pytest.raises(ThreadNotFound):
        await with_memory(missing, fallback="the default", what="the store")

    async def broken() -> str:
        raise ValueError("a programming mistake, not an outage")

    with pytest.raises(ValueError, match="programming mistake"):
        await with_memory(broken, fallback="the default", what="the store")


# =========================================================================== the status itself


def test_the_default_status_is_available_and_silent() -> None:
    status = MemoryStatus()
    assert status.available
    assert status.note is None
    assert not status.defaults_applied


def test_an_unavailable_status_always_carries_a_note() -> None:
    """So a response cannot report unavailability without saying what it cost."""
    for defaults_applied in (True, False):
        status = MemoryStatus.unavailable(defaults_applied=defaults_applied)
        assert not status.available
        assert status.note
