"""Task 13.5 — everything except the agent surface works with no inference credential.

``specs/agent-orchestration``: with no credential configured, the agent surface reports itself
unavailable naming what is missing, and every non-agent capability stays *fully* functional. This
asserts the second half against the services themselves — forecast, current, history, analytics,
comparison, and RAG retrieval — with a ``Settings`` that has no credential in it at all.

`db` because RAG retrieval is a vector query against a real index; the weather half needs no
database and would pass offline, but keeping the whole claim in one place is worth the container.

The HTTP-endpoint form of this claim — the same assertion made through the public routes — lands
with the API in group 15, where those routes exist to be called.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import httpx
import pytest

from tests.db_support import claims_for
from tests.provider_support import StubProvider
from weathra.agents.llm.registry import LLMProvider, build_client
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.comparison import Criterion
from weathra.domain.errors import AgentNotConfigured
from weathra.domain.identity import Principal
from weathra.domain.location import Location, Resolution
from weathra.domain.weather import DataClass
from weathra.geocoding.base import Geocoder
from weathra.rag.embed import DeterministicEmbedder
from weathra.rag.ingest import load_corpus
from weathra.rag.retrieve import retrieve
from weathra.rag.store import ingest_corpus
from weathra.weather.comparison_service import ComparisonService
from weathra.weather.forecast_service import ForecastService
from weathra.weather.history_service import HistoryService

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
NOW = datetime(2025, 6, 15, 9, 0, tzinfo=UTC)


class _NoGeocoder:
    """Satisfies the Protocol and refuses to be called: these tests pass resolved locations."""

    name = "none"
    _REFUSAL = "these capabilities are given an already-resolved location"

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


@pytest.fixture
def uncredentialled(db_settings: Settings) -> Settings:
    """The database settings with every trace of an inference credential removed."""
    settings = db_settings.model_copy(
        update={"openrouter_api_key": None, "embedding_model_id": "weathra-hashing-v1"}
    )
    assert not settings.inference_configured
    assert settings.openrouter_api_key is None
    return settings


def _geocoder() -> Geocoder:
    return _NoGeocoder()


def _provider() -> StubProvider:
    return StubProvider(daily_values=[11.0, 12.5, 13.0, 10.5, 14.0, 12.0, 11.5])


# =========================================================================== the agent surface


def test_agent_construction_raises_and_names_the_missing_configuration(
    uncredentialled: Settings,
) -> None:
    with pytest.raises(AgentNotConfigured) as raised:
        build_client(httpx.AsyncClient(), uncredentialled)
    assert "OPENROUTER_API_KEY" in str(raised.value)


def test_the_provider_reports_itself_unconfigured_without_disclosing_anything(
    uncredentialled: Settings,
) -> None:
    provider = LLMProvider(httpx.AsyncClient(), uncredentialled)
    assert not provider.configured
    assert not provider.built
    with pytest.raises(AgentNotConfigured):
        provider.get()


# =========================================================================== weather capabilities


async def test_current_conditions_succeed_with_no_credential(uncredentialled: Settings) -> None:
    service = ForecastService(
        provider=_provider(), geocoder=_geocoder(), settings=uncredentialled, now=NOW
    )
    current = await service.current(BERLIN)
    assert current.data_class is DataClass.CURRENT


async def test_a_forecast_succeeds_with_no_credential(uncredentialled: Settings) -> None:
    service = ForecastService(
        provider=_provider(), geocoder=_geocoder(), settings=uncredentialled, now=NOW
    )
    forecast = await service.forecast(BERLIN, days=3)
    assert forecast.data_class is DataClass.FORECAST
    assert forecast.daily.entries


async def test_forecast_analysis_succeeds_with_no_credential(uncredentialled: Settings) -> None:
    """Analytics is deterministic code, so it never needed a model in the first place."""
    service = ForecastService(
        provider=_provider(), geocoder=_geocoder(), settings=uncredentialled, now=NOW
    )
    analysis = await service.analyse(BERLIN, days=7)
    assert analysis.findings
    assert analysis.summary, "the summary is written by code, from the findings"


async def test_history_succeeds_with_no_credential(uncredentialled: Settings) -> None:
    service = HistoryService(provider=_provider(), settings=uncredentialled, now=NOW)
    observations = await service.observations(BERLIN, start=date(2025, 6, 1), end=date(2025, 6, 7))
    assert observations.data_class is DataClass.HISTORICAL_OBSERVATION
    assert observations.daily.entries


async def test_comparison_succeeds_with_no_credential(uncredentialled: Settings) -> None:
    service = ComparisonService(provider=_provider(), settings=uncredentialled, now=NOW)
    result = await service.compare_locations((BERLIN, MUNICH), criterion=Criterion.WARMEST, days=3)
    assert result.candidates
    assert result.criterion is Criterion.WARMEST


# =========================================================================== RAG retrieval


async def test_rag_retrieval_succeeds_with_no_credential(
    engines: Engines, uncredentialled: Settings, clean_database: None
) -> None:
    """Embedding is local and search is a database query, so neither needs a credential.

    Only the prose *explanation* layered on retrieval needs a model — and a person asking what a
    dew point is still gets the passage that defines it.
    """
    from weathra.auth.rls import administrative_session, session_for

    embedder = DeterministicEmbedder(model_id="weathra-hashing-v1")

    async with administrative_session(engines) as admin:
        await ingest_corpus(
            admin, embedder=embedder, settings=uncredentialled, documents=load_corpus()
        )

    principal = Principal.from_claims(claims_for("11111111-1111-4111-8111-111111111111"))
    async with session_for(engines, principal) as session:
        result = await retrieve(
            session,
            embedder=embedder,
            settings=uncredentialled,
            query="dew point",
        )

    assert result.found_any, "retrieval must work with no inference credential"
    assert result.document_ids
    assert result.embedding_model == "weathra-hashing-v1"


# =========================================================================== nothing built


async def test_no_capability_above_constructed_an_inference_client(
    uncredentialled: Settings,
) -> None:
    """The lazy half of the claim: it is not that construction *fails* gracefully.

    It is that nothing on these paths asks for a client at all. A provider handed to every service
    above and never called stays unbuilt — which is what makes ``AgentNotConfigured`` a per-request
    condition rather than a startup failure.
    """
    provider = LLMProvider(httpx.AsyncClient(), uncredentialled)

    forecast = ForecastService(
        provider=_provider(), geocoder=_geocoder(), settings=uncredentialled, now=NOW
    )
    await forecast.analyse(BERLIN, days=3)
    await HistoryService(provider=_provider(), settings=uncredentialled, now=NOW).observations(
        BERLIN, start=date(2025, 6, 1), end=date(2025, 6, 3)
    )
    await ComparisonService(
        provider=_provider(), settings=uncredentialled, now=NOW
    ).compare_locations((BERLIN, MUNICH), criterion=Criterion.WARMEST, days=3)

    assert not provider.built
