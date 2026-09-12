"""The satellite observation capability — task 34.34.

Every case here is about one of two properties. The first is that the capability *works*: a
question that asks for imagery reaches the tool, the tool reaches the adapter, and the observation
comes back normalized with its provenance intact. The second is the one that matters more — that
the capability cannot become a way to say things Weathra has not established. It retrieves a
picture nobody has looked at, and a picture nobody has looked at supports exactly one claim: that
it exists, from whom, of where, and when.

The network is never reached: `httpx.MockTransport` answers every request, and a test that got past
it would fail rather than hit NASA.
"""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from datetime import UTC, date, datetime

import httpx
import pytest

from tests.agent_support import BERLIN, StubGeocoder, agent_settings, connected_tools
from tests.unit.test_agent_graph import _client, _plan, _state
from weathra.agents.graph import RunDependencies, run_agent
from weathra.agents.nodes.synthesize import SYNTHESIS_SYSTEM_PROMPT
from weathra.agents.plan import Capability, PlanStep, fallback_plan
from weathra.domain.errors import ProviderUnavailable
from weathra.domain.evidence import AgentName, DataClass, StepStatus
from weathra.domain.satellite import INTERPRETATION_BOUNDARY, SatelliteObservation
from weathra.mcp.client import McpToolClient
from weathra.providers.gibs import (
    ATTRIBUTION,
    MINIMUM_IMAGE_BYTES,
    PRODUCT,
    PROVIDER_NAME,
    GibsSatelliteProvider,
)

NOW = datetime(2026, 9, 12, 7, 49, tzinfo=UTC)

#: Enough bytes to count as imagery, and the content is irrelevant — nothing reads it.
IMAGERY = b"\xff\xd8\xff" + b"\x00" * MINIMUM_IMAGE_BYTES
#: What the service answers with where the day's composite has not reached this longitude yet.
EMPTY_FRAME = b"\xff\xd8\xff" + b"\x00" * 64


def _transport(bodies: dict[str, bytes]) -> httpx.MockTransport:
    """Answer by the requested TIME, so a test can say what exists for which day."""
    calls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        when = request.url.params.get("TIME", "")
        calls.append(when)
        body = bodies.get(when)
        if body is None:
            return httpx.Response(200, content=EMPTY_FRAME, headers={"content-type": "image/jpeg"})
        return httpx.Response(200, content=body, headers={"content-type": "image/jpeg"})

    transport = httpx.MockTransport(handle)
    transport.calls = calls  # type: ignore[attr-defined]
    return transport


# =========================================================================== the adapter


async def test_the_adapter_returns_the_latest_day_the_service_has_imagery_for() -> None:
    transport = _transport({"2026-09-12": IMAGERY})
    async with httpx.AsyncClient(transport=transport) as client:
        observation = await GibsSatelliteProvider(client, now=NOW).observe(BERLIN)

    assert observation.provider == PROVIDER_NAME
    assert observation.product == PRODUCT
    assert observation.observed_date == date(2026, 9, 12)
    assert observation.attribution == ATTRIBUTION
    assert observation.image_url.startswith("https://gibs.earthdata.nasa.gov/")
    assert observation.data_class is DataClass.SATELLITE_OBSERVATION
    # The box, not the point. Berlin sits inside it and the note says the region is what is covered.
    assert observation.coverage.south < BERLIN.latitude < observation.coverage.north
    assert observation.coverage.west < BERLIN.longitude < observation.coverage.east
    assert "region, not the place" in observation.coverage_note


async def test_a_day_the_composite_has_not_reached_steps_back_exactly_one_day() -> None:
    """The provider's own behaviour, probed on 2026-09-12: an empty frame for the current day.

    Reading the response size is a fact about *whether imagery was returned*. Nothing here looks at
    what the imagery shows, which is the distinction the whole capability rests on.
    """
    transport = _transport({"2026-09-11": IMAGERY})
    async with httpx.AsyncClient(transport=transport) as client:
        observation = await GibsSatelliteProvider(client, now=NOW).observe(BERLIN)

    assert observation.observed_date == date(2026, 9, 11)
    assert transport.calls == ["2026-09-12", "2026-09-11"]  # type: ignore[attr-defined]
    assert "2026-09-11" in observation.freshness_note


async def test_no_imagery_for_either_day_is_unavailable_rather_than_an_empty_observation() -> None:
    transport = _transport({})
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(ProviderUnavailable):
            await GibsSatelliteProvider(client, now=NOW).observe(BERLIN)


async def test_the_observation_carries_no_meteorological_figure_at_all() -> None:
    """The contract has nowhere to put one, which is the point of writing it out.

    A field named for a measurement is all it would take for a later pass to fill one in from an
    image. There is no such field, so there is nothing to fill.
    """
    fields = set(SatelliteObservation.model_fields)
    forbidden = {
        "temperature",
        "cloud_cover",
        "cloud_fraction",
        "precipitation",
        "rainfall",
        "storm",
        "severity",
        "pressure",
        "front",
        "convection",
        "analysis",
        "classification",
        "detected",
    }
    assert fields & forbidden == set()
    assert "no image analysis was performed" in INTERPRETATION_BOUNDARY


# =========================================================================== routing


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("Show me the latest satellite observation for Berlin.", (Capability.SATELLITE,)),
        ("What does satellite data show around Berlin?", (Capability.SATELLITE,)),
        (
            "Use satellite evidence together with the forecast for Berlin",
            (Capability.SATELLITE, Capability.FORECAST),
        ),
        # And the questions imagery cannot answer, which must not spend a retrieval on it.
        ("What will Berlin's temperature be tomorrow?", (Capability.FORECAST,)),
        (
            "What was the average temperature in Berlin last week?",
            (Capability.HISTORICAL, Capability.ANALYTICS),
        ),
        ("What does dew point mean?", (Capability.RAG,)),
        ("What is the weather like in Berlin right now?", (Capability.CURRENT,)),
    ],
)
def test_the_router_reaches_for_imagery_only_where_imagery_was_asked_for(
    question: str, expected: tuple[Capability, ...]
) -> None:
    plan = fallback_plan(question, now=datetime(2026, 9, 12))
    assert plan.capabilities == expected
    assert plan.in_scope


def test_the_routing_prompt_offers_satellite_as_observation_and_warns_against_over_routing() -> (
    None
):
    from weathra.agents.supervisor import ROUTING_SYSTEM_PROMPT

    assert '"satellite"' in ROUTING_SYSTEM_PROMPT
    assert "observational evidence" in ROUTING_SYSTEM_PROMPT
    assert "carries no measurement" in ROUTING_SYSTEM_PROMPT


def test_the_synthesis_prompt_forbids_drawing_weather_from_an_image() -> None:
    """Layer one of the boundary. The tests below are the layers that hold when it is ignored."""
    lowered = SYNTHESIS_SYSTEM_PROMPT.lower()
    assert "observational evidence and nothing else" in lowered
    for forbidden in ("no front", "no convection", "no instability", "no severity"):
        assert forbidden in lowered
    assert "nothing has looked at the image" in lowered
    assert "analysed, examined, inspected or saw anything in it" in lowered


# =========================================================================== through the graph


def _satellite_tools(
    bodies: dict[str, bytes] | None = None,
) -> AbstractAsyncContextManager[McpToolClient]:
    """The real MCP server and the real tool, over a transport that answers for NASA."""
    return connected_tools(
        settings=agent_settings(),
        http_transport=_transport(bodies if bodies is not None else {"2026-09-12": IMAGERY}),
        now=NOW,
    )


async def test_a_satellite_question_runs_the_node_and_records_the_real_provider() -> None:
    settings = agent_settings()
    client = _client(
        _plan(
            PlanStep(
                capability=Capability.SATELLITE,
                reason="the question asks for imagery",
                location="Berlin",
            )
        )
    )

    async with _satellite_tools() as tools:
        result = await run_agent(
            _state("Show me the latest satellite observation for Berlin."),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    assert [call.tool for call in result.envelope.evidence.tool_calls] == ["weather_satellite"]
    assert AgentName.SATELLITE in result.envelope.evidence.agents_in_order
    assert DataClass.SATELLITE_OBSERVATION in result.envelope.evidence.data_classes

    # The evidence a reader needs to check it, and the provider is the real one rather than a label.
    assert len(result.envelope.satellite) == 1
    observation = result.envelope.satellite[0]
    assert observation.provider == PROVIDER_NAME
    assert observation.product == PRODUCT
    assert observation.attribution == ATTRIBUTION
    assert observation.location.is_same_place(BERLIN)
    assert result.envelope.attribution[0].provider == PROVIDER_NAME

    # Imagery produces no figure, so the answer carries none and states no forecast uncertainty.
    assert result.envelope.findings == ()
    assert result.envelope.uncertainty is None


async def test_an_ordinary_forecast_question_retrieves_no_imagery() -> None:
    settings = agent_settings()
    client = _client(
        _plan(PlanStep(capability=Capability.FORECAST, reason="the days ahead", location="Berlin"))
    )

    async with _satellite_tools() as tools:
        result = await run_agent(
            _state("What will Berlin's temperature be tomorrow?"),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    assert "weather_satellite" not in [call.tool for call in result.envelope.evidence.tool_calls]
    assert AgentName.SATELLITE not in result.envelope.evidence.agents_in_order
    assert result.envelope.satellite == ()


async def test_a_historical_question_retrieves_no_imagery() -> None:
    settings = agent_settings()
    client = _client(
        _plan(
            PlanStep(
                capability=Capability.HISTORICAL,
                reason="the archive",
                location="Berlin",
                start_date=date(2025, 9, 1),
                end_date=date(2025, 9, 7),
            )
        )
    )

    async with _satellite_tools() as tools:
        result = await run_agent(
            _state("What was Berlin's average temperature in the first week of September?"),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    assert "weather_satellite" not in [call.tool for call in result.envelope.evidence.tool_calls]
    assert result.envelope.satellite == ()


async def test_unavailable_imagery_does_not_cost_the_run_its_forecast() -> None:
    """Satellite is optional, and optional means the rest of the answer survives without it."""
    settings = agent_settings()
    client = _client(
        _plan(
            PlanStep(capability=Capability.SATELLITE, reason="imagery", location="Berlin"),
            PlanStep(capability=Capability.FORECAST, reason="the days ahead", location="Berlin"),
        )
    )

    async with _satellite_tools(bodies={}) as tools:
        result = await run_agent(
            _state("Show me satellite imagery for Berlin and what is coming"),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    # The forecast answered.
    assert result.envelope.findings
    assert DataClass.FORECAST in result.envelope.evidence.data_classes
    # The satellite step did not, and says so rather than being quietly absent.
    assert result.envelope.satellite == ()
    step = next(s for s in result.envelope.evidence.agents if s.agent is AgentName.SATELLITE)
    assert step.status is StepStatus.FAILED


async def test_an_explicit_satellite_request_that_fails_says_so_rather_than_answering_anyway() -> (
    None
):
    """The failure is recorded as a failure, and handed to synthesis as one it must report.

    Asserted against the run's own record and the prompt it produces rather than against a model's
    words: a scripted client says whatever it was scripted to say, so a test that checked its prose
    would be checking the script. What Weathra controls is that the failure exists, that nothing was
    substituted for it, and that the model is told it must be named rather than answered around.
    """
    from weathra.agents.nodes.synthesize import _prompt

    settings = agent_settings()
    client = _client(
        _plan(PlanStep(capability=Capability.SATELLITE, reason="imagery", location="Berlin"))
    )

    async with _satellite_tools(bodies={}) as tools:
        result = await run_agent(
            _state("Show me the latest satellite observation for Berlin."),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    assert result.envelope.satellite == ()
    failures = " ".join(result.state.failures)
    assert "could not be retrieved" in failures
    assert "Nothing was substituted for it" in failures

    rendered = " ".join(str(message.content) for message in _prompt(result.state))
    assert "must be reported as such, not answered" in rendered
    assert "could not be retrieved" in rendered

    # And nothing invented in its place: no observation, and no provider credited for one.
    assert PROVIDER_NAME not in [entry.provider for entry in result.envelope.attribution]


async def test_nothing_in_the_answer_claims_the_image_was_looked_at() -> None:
    """No vision model is in this pipeline, so no surface may imply one ran.

    The prose here is the code-written summary, which is what a run with no inference credential
    produces — the strongest version of the check, because it is the wording Weathra itself chose
    rather than a model's.
    """
    settings = agent_settings()

    async with _satellite_tools() as tools:
        result = await run_agent(
            _state("Show me the latest satellite observation for Berlin."),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=None),
        )

    prose = result.envelope.answer_prose.lower()
    for claim in (
        "i analysed",
        "i analyzed",
        "the image shows",
        "detected",
        "i can see",
        "visible in the image",
    ):
        assert claim not in prose, f"the answer claims image interpretation: {claim}"


async def test_the_image_itself_never_reaches_the_language_model() -> None:
    """The safety property that holds when the prompt's rule does not.

    A model handed an image, or a URL it could be asked to fetch, can describe one. This asserts the
    synthesis request carries the observation's *metadata* and neither the bytes nor the link.
    """
    from weathra.agents.nodes.synthesize import _prompt

    settings = agent_settings()
    client = _client(
        _plan(PlanStep(capability=Capability.SATELLITE, reason="imagery", location="Berlin"))
    )

    async with _satellite_tools() as tools:
        result = await run_agent(
            _state("Show me the latest satellite observation for Berlin."),
            RunDependencies(settings=settings, tools=tools, geocoder=StubGeocoder(), llm=client),
        )

    observation = result.envelope.satellite[0]
    state = _state("Show me the latest satellite observation for Berlin.").with_satellite(
        observation
    )
    rendered = " ".join(str(message.content) for message in _prompt(state))

    assert observation.provider in rendered
    assert observation.product in rendered
    assert observation.image_url not in rendered
    assert "gibs.earthdata.nasa.gov" not in rendered
