"""The application an evaluation run drives, in either mode.

**The app is the real one.** ``build_app``, its lifespan, its middleware, its error handlers, its
routers. The metrics include a backend successful-response rate and an attribution coverage over
*response fields*, and both are claims about the API — a harness that called the graph directly
would be measuring something a caller never sees.

**Offline mode substitutes three things, each at a boundary the app already has:**

* the **HTTP transport**, which becomes a replay of recorded Open-Meteo payloads
  (``evaluation/fixtures.py``). The real provider and geocoder sit on top of it, so the whole
  normalization stack runs;
* the **inference client**, which becomes the scripted fake, installed through the same
  ``LLMProvider.override`` hook the test suite uses;
* the **token validator**, which trusts the locally-minted key pair
  (``evaluation/provisioning.py``).

Nothing else changes. Live mode substitutes none of them.

**The plan is derived from the case, and derived per *turn*.** A scripted plan has to route to the
capabilities the case declares it expects — otherwise the run would be measuring the script rather
than the pipeline. And it has to be built from each turn's *own* question: a plan that named Berlin
and Munich on the follow-up would make "which one is warmer?" look like a request that supplied its
own places, and the run would resolve from the request rather than from the conversation — scoring
zero on exactly the metric the case exists to measure.

**The prose is not scripted at all.** ``evaluation/offline_llm.py`` reads the findings out of the
prompt and states them, which is what a well-behaved model does. That is what makes numerical
accuracy and groundedness measure the pipeline: the figures come from what code computed and handed
over, not from a string somebody typed.

That leaves a real limitation of offline mode, worth naming: it measures execution, arithmetic,
grounding, attribution, memory and the API, and it does *not* measure whether a model would have
routed correctly or worded an answer well. Live mode measures those, and tool-selection accuracy is
the metric that shows the difference.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, timedelta

import httpx
from fastapi import FastAPI

from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.api.app import build_app
from weathra.config import Settings
from weathra.evaluation.cases import Category, EvaluationCase
from weathra.evaluation.fixtures import build_offline_transport
from weathra.evaluation.offline_llm import OfflineLLMClient
from weathra.evaluation.provisioning import EvaluationMode, TestIdentity, provision_test_user
from weathra.geocoding.open_meteo import OpenMeteoGeocoder
from weathra.providers.cache import CachedProvider
from weathra.providers.registry import build_provider

__all__ = ["PreparedApp", "build_evaluation_app"]

logger = logging.getLogger("weathra.evaluation.harness")

# The archive window the recorded fixtures cover. A case asking outside it fails loudly rather
# than quietly, which is what ``fixtures.MissingFixture`` is for.
RECORDED_ARCHIVE_START = date(2025, 5, 1)
RECORDED_ARCHIVE_END = date(2025, 6, 7)


@dataclass(slots=True)
class PreparedApp:
    """The app, a client for it, and the hooks a run needs."""

    app: FastAPI
    client: httpx.AsyncClient
    outbound: httpx.AsyncClient
    settings: Settings
    mode: EvaluationMode
    identity: TestIdentity
    llm_provider: str | None = None
    llm_model: str | None = None
    weather_provider: str = "open-meteo"

    pinned_provider_id: str | None = None
    pinned_model_id: str | None = None
    """The identity an offline run records for its client.

    Set by a model comparison so each candidate's results are attributed to that candidate rather
    than to the offline client they all share. ``None`` leaves the offline constants in place,
    which is every other caller.
    """

    def script_for(self, case: EvaluationCase) -> None:
        """Install a scripted routing plan and prose for one case, in offline mode.

        Derived from the case's declared expectations rather than hand-written per case: a script
        that routed somewhere the case did not expect would make the run measure the script.
        """
        if self.mode is not EvaluationMode.OFFLINE:
            return

        identity: dict[str, str] = {}
        if self.pinned_provider_id is not None:
            identity["provider_id"] = self.pinned_provider_id
        if self.pinned_model_id is not None:
            identity["model_id"] = self.pinned_model_id

        client = OfflineLLMClient(
            plans=[plan.model_dump(mode="json") for plan in _plans_for(case)], **identity
        )
        self.app.state.inference.override(client)
        self.llm_provider = client.provider_id
        self.llm_model = client.model_id


def _plans_for(case: EvaluationCase) -> tuple[RoutingPlan, ...]:
    """One plan per turn, each built from that turn's own question.

    Per turn rather than one for the case, because a follow-up names no place and its plan must not
    either — see the module docstring.
    """
    return tuple(_plan_for(case, question) for question in case.questions)


def _plan_for(case: EvaluationCase, question: str) -> RoutingPlan:
    """A routing plan matching what the case says it expects, for one turn's question.

    The one place the harness has to make a decision, and it makes it from the case's own
    declarations: the capabilities from ``expected_agents``, the places from this turn's own
    words, and the archive window from the recorded fixtures' coverage.
    """
    from weathra.agents.plan import extract_location

    named = extract_location(question) or _place_in(question)
    places = _places_in(question)

    steps: list[PlanStep] = []
    agents = _agents_for_turn(case, question)

    if "rag" in agents:
        steps.append(
            PlanStep(
                capability=Capability.RAG,
                reason="the case expects the knowledge capability",
                concept=question,
            )
        )

    if "historical" in agents:
        steps.append(
            PlanStep(
                capability=Capability.HISTORICAL,
                reason="the case expects the archive",
                locations=places if len(places) > 1 else (),
                location=named if len(places) <= 1 else None,
                start_date=RECORDED_ARCHIVE_END - timedelta(days=6),
                end_date=RECORDED_ARCHIVE_END,
            )
        )
    elif "forecast" in agents:
        steps.append(
            PlanStep(
                capability=Capability.FORECAST,
                reason="the case expects a forecast",
                locations=places if len(places) > 1 else (),
                location=named if len(places) <= 1 else None,
                days=_days_in(question),
            )
        )

    if "analytics" in agents:
        steps.append(
            PlanStep(
                capability=Capability.ANALYTICS,
                reason="the case expects a computed statistic",
                statistics=_statistics_for(case),
                measure=case.reference.measure if case.reference else None,
                uses_previous_result=True,
            )
        )

    if not steps:
        # A case that expects nothing — an unresolvable place, a question with no location — still
        # needs a plan, because the refusal happens in resolution rather than in routing.
        steps.append(
            PlanStep(
                capability=Capability.FORECAST,
                reason="the case expects the request to be refused during resolution",
                location=named,
                days=1,
            )
        )

    return RoutingPlan(
        steps=tuple(steps),
        reason=f"Offline evaluation plan derived from case {case.case_id}.",
    )


def _agents_for_turn(case: EvaluationCase, question: str) -> tuple[str, ...]:
    """The capabilities this turn should route to.

    A turn that declares its own expected tools is routed by them; otherwise the case's expected
    agents apply, and failing that the category's default. A statistical follow-up in an otherwise
    forecast case therefore reaches the analytics node, which is what the case is testing.
    """
    turn = next((entry for entry in case.turns if entry.question == question), None)

    if turn is not None and turn.expected_tools:
        derived: list[str] = []
        if "weather_history" in turn.expected_tools:
            derived.append("historical")
        elif "weather_forecast" in turn.expected_tools:
            derived.append("forecast")
        if any(tool.startswith("weather_statistics") for tool in turn.expected_tools):
            # A statistic needs a series, so the retrieval it computes over comes first.
            if not derived:
                derived.append("forecast")
            derived.append("analytics")
        if derived:
            return tuple(derived)

    if case.expected_agents:
        return tuple(case.expected_agents)
    return _agents_from_category(case.category)


def _agents_from_category(category: Category) -> tuple[str, ...]:
    """A default routing for a case that declares no expected agents."""
    return {
        Category.CURRENT_AND_FORECAST: ("forecast",),
        Category.HISTORICAL: ("historical",),
        Category.COMPARISON: ("forecast",),
        Category.ANALYTICS: ("forecast", "analytics"),
        Category.KNOWLEDGE: ("rag",),
        Category.MEMORY: ("forecast",),
    }[category]


# The places the fixtures cover, matched case-insensitively in a question's own words.
_KNOWN_PLACES = ("Berlin", "Munich", "Lisbon")


def _place_in(question: str) -> str | None:
    for place in _KNOWN_PLACES:
        if place.lower() in question.lower():
            return place
    return None


def _places_in(question: str) -> tuple[str, ...]:
    """Every recorded place a question names, in the order it names them."""
    found = [
        (question.lower().index(place.lower()), place)
        for place in _KNOWN_PLACES
        if place.lower() in question.lower()
    ]
    return tuple(place for _, place in sorted(found))


def _days_in(question: str) -> int | None:
    """A horizon a question states in words, so a 7-day question gets a 7-day window."""
    import re

    match = re.search(r"next (\d{1,2}) days", question, re.IGNORECASE)
    if match:
        return int(match.group(1))
    if "week" in question.lower():
        return 7
    if "tomorrow" in question.lower():
        return 2
    return 3


def _statistics_for(case: EvaluationCase) -> tuple[str, ...]:
    """The statistics an analytics step should request, from the case or its question."""
    if case.reference is not None:
        return (case.reference.statistic,)
    if "unusual" in (case.question or "").lower():
        return ("anomaly",)
    return ("minimum", "maximum", "mean", "range")


@asynccontextmanager
async def build_evaluation_app(
    settings: Settings, *, mode: EvaluationMode, pinned_catalog_key: str | None = None
) -> AsyncIterator[PreparedApp]:
    """The app an evaluation run drives, with this mode's substitutions in place.

    *pinned_catalog_key* names the candidate a model comparison is measuring. It reaches the
    request path through the same pin as the policy itself — see `pin_evaluation_policy` — so a
    candidate run's resolution is a real catalog-validated resolution rather than an environment
    variable the policy layer happens to fall back to.
    """
    app = build_app(settings)

    async with app.router.lifespan_context(app):
        # `specs/evaluation`: a live run resolves its pinned model through the fixed-model
        # evaluation policy rather than through the evaluation test user's subscription plan. The
        # pin goes on before the corpus, the identity or the first case, because everything after
        # this line can issue an inference call. Offline mode resolves nothing — the scripted
        # client is installed at the same seam and there is no model to pin.
        if mode is EvaluationMode.LIVE:
            app.state.inference.pin_evaluation_policy(catalog_key=pinned_catalog_key)

        outbound = app.state.http_client

        if mode is EvaluationMode.OFFLINE:
            # The recorded transport, under the *real* provider and geocoder.
            offline = httpx.AsyncClient(transport=build_offline_transport())
            await app.state.http_client.aclose()
            app.state.http_client = offline
            outbound = offline

            app.state.weather_provider = CachedProvider(
                build_provider(settings, offline, None), settings=settings
            )
            app.state.geocoder = OpenMeteoGeocoder(settings=settings, client=offline)

            # And the MCP server, rebuilt over them.
            await _reconnect_tools(app, settings)

        # The knowledge corpus, ensured before any case runs. A run that scored retrieval quality
        # against an empty index would be measuring whether somebody remembered to ingest, and
        # would report 0% for a retrieval layer that works.
        await _ensure_corpus(app, settings)

        # Provisioned *here*, once. Offline mode mints a key pair per call, so provisioning in two
        # places would leave the app trusting one key while holding a token signed by another — and
        # the run would fail with an authentication error that looked like a Weathra bug.
        identity, validator = await provision_test_user(
            settings, app.state.engines, mode=mode, client=outbound
        )
        if validator is not None:
            app.state.token_validator = validator
            logger.info("offline evaluation trusts its locally-minted key for %s", identity.user_id)

        prepared = PreparedApp(
            app=app,
            client=httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://weathra.evaluation"
            ),
            outbound=outbound,
            settings=settings,
            mode=mode,
            identity=identity,
            # Left unset for a live run: `LLM_MODEL` is no longer what serves one, and recording
            # it here would have the run record name a model the policy layer never selected. The
            # runner fills both in from the resolution its pre-flight actually obtained.
            llm_provider=None,
            llm_model=None,
            weather_provider=settings.default_weather_provider,
        )

        try:
            yield prepared
        finally:
            await prepared.client.aclose()


async def _ensure_corpus(app: FastAPI, settings: Settings) -> None:
    """Ingest the knowledge corpus if the index is empty or was built by another model.

    Idempotent: ``ingest_corpus`` leaves unchanged documents alone, so a re-run costs one query.
    Under the privileged connection, because the corpus tables are shared and the request-serving
    role has no write grant on them.
    """
    from weathra.auth.rls import administrative_session
    from weathra.rag.ingest import load_corpus
    from weathra.rag.store import index_identity, ingest_corpus

    embedder = app.state.embedder

    async with administrative_session(app.state.engines) as session:
        identity = await index_identity(session)
        if not identity.is_empty and identity.model == embedder.model_id:
            logger.info("knowledge index already built by %s", identity.model)
            return

        report = await ingest_corpus(
            session, embedder=embedder, settings=settings, documents=load_corpus()
        )
        logger.info(
            "ingested the knowledge corpus for evaluation: %d documents, %d chunks",
            report.documents_written,
            report.chunks_written,
        )


async def _reconnect_tools(app: FastAPI, settings: Settings) -> None:
    """Rebuild the in-process MCP server over the offline provider and reconnect."""
    from weathra.mcp.client import McpToolClient
    from weathra.mcp.server import ToolContext, build_server

    if app.state.tools is not None:
        await app.state.tools.close()

    server = build_server(
        ToolContext(
            settings=settings,
            client=app.state.http_client,
            provider=app.state.weather_provider,
            geocoder=app.state.geocoder,
        )
    )
    client = McpToolClient(settings=settings, server=server)
    await client.connect()
    app.state.tools = client
