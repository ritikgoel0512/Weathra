"""Group 17 — the rules that make Weathra trustworthy rather than merely fluent.

These are the tests that would fail if Weathra started guessing: data-class labelling across every
endpoint, structured attribution on every weather-bearing response, the forecaster-positioning and
official-warning referrals, the severity guard, honest unavailability, and data minimization.

Driven through the real app, so what is asserted is what a caller actually receives.
"""

from __future__ import annotations

import json
import re
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from tests.agent_support import stub_provider
from tests.api_support import ApiFactory, ApiHarness, capturing, harness
from tests.auth_support import USER_A, TokenFactory
from tests.provider_support import stub_capabilities
from weathra.agents.plan import Capability, PlanStep, RoutingPlan
from weathra.agents.safety import (
    SEVERITY_FIELD_NAMES,
    assess,
    describes_severity,
    mentions_severe_weather,
)
from weathra.db.models import Ownership, ownership_column, ownership_of, user_owned_tables
from weathra.db.session import privileged_session
from weathra.domain.errors import ProviderUnavailable
from weathra.domain.weather import DataClass, Granularity, Measure

pytestmark = pytest.mark.db

PREFIX = "/api/v1"

# Every data class Weathra reports. A response's label must be one of these and never a blend.
KNOWN_CLASSES = {klass.value for klass in DataClass}


@pytest.fixture
def api_factory(
    token_factory: TokenFactory, migrated_database: str, clean_database: None
) -> ApiFactory:
    def build(**overrides: Any) -> AbstractAsyncContextManager[ApiHarness]:
        return harness(factory=token_factory, database_url=migrated_database, **overrides)

    return build


def with_inference(api_factory: ApiFactory) -> AbstractAsyncContextManager[ApiHarness]:
    return api_factory(openrouter_api_key="test-credential-never-sent")


def _plan(*steps: PlanStep, **kwargs: object) -> dict:
    return RoutingPlan(steps=steps, reason="a scripted plan", **kwargs).model_dump(mode="json")


def _classes_in(payload: Any) -> set[str]:
    """Every ``data_class`` value anywhere in a response body."""
    found: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in {"data_class", "prose_data_class"} and isinstance(value, str):
                found.add(value)
            elif key == "data_classes" and isinstance(value, list):
                found.update(entry for entry in value if isinstance(entry, str))
            else:
                found |= _classes_in(value)
    elif isinstance(payload, list):
        for entry in payload:
            found |= _classes_in(entry)
    return found


# =========================================================================== 17.1 data classes


async def test_the_forecast_endpoint_labels_its_class(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
            )
        ).json()

    assert body["attribution"]["data_class"] == DataClass.FORECAST.value
    assert _classes_in(body) == {DataClass.FORECAST.value}, "one class, not a blend"


async def test_the_current_endpoint_labels_its_class(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(f"{PREFIX}/weather/current", params={"location": "Berlin"})
        ).json()

    assert body["attribution"]["data_class"] == DataClass.CURRENT.value
    assert DataClass.FORECAST.value not in _classes_in(body), "current is never a forecast"


async def test_the_history_endpoint_labels_its_class(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/history",
                params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07"},
            )
        ).json()

    assert body["data_class"] == DataClass.HISTORICAL_OBSERVATION.value
    assert DataClass.FORECAST.value not in _classes_in(body)


async def test_the_analysis_endpoint_labels_every_figure(api_factory: ApiFactory) -> None:
    """A computed statistic over a forecast is a *computed statistic*, and says so."""
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
            )
        ).json()

    assert body["data_class"] == DataClass.FORECAST.value, "what the window is"
    for finding in body["findings"]:
        assert finding["data_class"] == DataClass.COMPUTED_STATISTIC.value
    assert _classes_in(body) <= KNOWN_CLASSES


async def test_the_comparison_endpoint_labels_its_class(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        forecast_based = (
            await api.client.post(
                f"{PREFIX}/weather/comparison",
                json={"criterion": "warmest", "locations": ["Berlin", "Munich"], "days": 3},
            )
        ).json()
        archive_based = (
            await api.client.post(
                f"{PREFIX}/weather/comparison",
                json={
                    "criterion": "warmest",
                    "locations": ["Berlin", "Munich"],
                    "start": "2025-06-01",
                    "end": "2025-06-07",
                },
            )
        ).json()

    assert forecast_based["data_class"] == DataClass.FORECAST.value
    assert archive_based["data_class"] == DataClass.HISTORICAL_OBSERVATION.value
    assert forecast_based["data_class"] != archive_based["data_class"], "never conflated"


async def test_a_mixed_class_answer_labels_each_part(api_factory: ApiFactory) -> None:
    """A forecast-plus-historical answer carries both classes, each attached to its own figures."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(
                        capability=Capability.FORECAST,
                        reason="the week ahead",
                        location="Berlin",
                        days=3,
                        question_part="the week ahead",
                    ),
                    PlanStep(
                        capability=Capability.HISTORICAL,
                        reason="last week",
                        location="Berlin",
                        start_date=datetime(2025, 6, 1).date(),
                        end_date=datetime(2025, 6, 7).date(),
                        question_part="last week",
                    ),
                )
            ],
            completions=["Both windows are mild."],
        )
        body = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "How does this week compare with last week in Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()

    answer = body["answer"]
    assert answer["prose_data_class"] == DataClass.AI_INTERPRETATION.value

    finding_classes = {finding["data_class"] for finding in answer["findings"]}
    assert len(finding_classes) >= 2, f"each part labelled: {finding_classes}"
    assert DataClass.HISTORICAL_OBSERVATION.value in set(answer["evidence"]["data_classes"])
    assert DataClass.FORECAST.value in set(answer["evidence"]["data_classes"])

    # And every figure's own attribution carries its own class, so nothing is blended.
    for finding in answer["findings"]:
        assert finding["attribution"]["data_class"] in KNOWN_CLASSES


async def test_the_models_prose_is_labelled_as_interpretation_and_nothing_else(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    assert answer["prose_data_class"] == DataClass.AI_INTERPRETATION.value
    for finding in answer["findings"]:
        assert finding["data_class"] != DataClass.AI_INTERPRETATION.value, (
            "a finding is retrieved or computed data, never model-written"
        )


# =========================================================================== 17.2 attribution


def _has_structured_attribution(block: dict) -> None:
    """Provider, location, period or timestamp, and retrieval time — as fields, not prose."""
    assert block["provider"], "the provider that supplied it"
    assert block["location"]["display_name"], "the place it is about"
    assert block["retrieved_at"], "when it was fetched"
    assert block.get("period") or block.get("timestamp_utc"), "what time it covers"


async def test_the_forecast_endpoint_carries_machine_readable_attribution(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
            )
        ).json()

    attribution = body["attribution"]
    assert attribution["provider"] == "stub"
    assert attribution["location"]["display_name"] == "Berlin"
    assert attribution["retrieved_at"]
    assert body["period"], "and the window, in a field"


async def test_the_history_endpoint_carries_machine_readable_attribution(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/history",
                params={"location": "Berlin", "start": "2025-06-01", "end": "2025-06-07"},
            )
        ).json()

    assert body["provider"] == "stub"
    assert body["location"]["display_name"] == "Berlin"
    assert body["retrieved_at"]
    assert body["covered_period"]["start_utc"]


async def test_every_analysis_finding_carries_its_own_provenance(
    api_factory: ApiFactory,
) -> None:
    async with api_factory() as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
            )
        ).json()

    for finding in body["findings"]:
        provenance = finding["provenance"]
        assert provenance["provider"], f"{finding['statistic']} names no provider"
        assert provenance["location"], "nor a place"
        assert provenance["retrieved_at"], "nor a retrieval time"


async def test_a_forecast_plus_historical_answer_carries_separate_attribution(
    api_factory: ApiFactory,
) -> None:
    """``specs/safety-grounding``: each part carries its own provider, period, and retrieval time.

    Not one blended credit line — a reader following a figure back needs the attribution *for that
    figure*.
    """
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(
                        capability=Capability.FORECAST, reason="ahead", location="Berlin", days=3
                    ),
                    PlanStep(
                        capability=Capability.HISTORICAL,
                        reason="behind",
                        location="Berlin",
                        start_date=datetime(2025, 6, 1).date(),
                        end_date=datetime(2025, 6, 7).date(),
                    ),
                )
            ],
            completions=["Both windows are mild."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "This week versus last week in Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    attributions = answer["attribution"]
    assert len(attributions) >= 2, "one per source, not one for the answer"
    for block in attributions:
        _has_structured_attribution(block)

    by_class: dict[str, list[dict]] = {}
    for block in attributions:
        by_class.setdefault(block["data_class"], []).append(block)

    # The property under test is *separation*: two retrievals, two classes, neither blended into
    # the other or into a single credit line for the answer.
    assert DataClass.FORECAST.value in by_class, "the forecast keeps its own class"
    assert DataClass.HISTORICAL_OBSERVATION.value in by_class, "the archive keeps its own class"
    assert len(by_class[DataClass.FORECAST.value]) == 1, "one row per retrieval, not one blend"
    assert len(by_class[DataClass.HISTORICAL_OBSERVATION.value]) == 1

    # Nothing unexplained. A derived analytics row is allowed because the run really does compute
    # statistics over both windows, and a figure Weathra computed is not a figure the provider
    # published — but it is the *only* addition this answer may carry.
    assert set(by_class) <= {
        DataClass.FORECAST.value,
        DataClass.HISTORICAL_OBSERVATION.value,
        DataClass.COMPUTED_STATISTIC.value,
    }, f"each source labelled with its own class: {set(by_class)}"

    retrieved = [
        *by_class[DataClass.FORECAST.value],
        *by_class[DataClass.HISTORICAL_OBSERVATION.value],
    ]
    periods = {json.dumps(block["period"], sort_keys=True) for block in retrieved}
    assert len(periods) == 2, "and its own period"
    # Neither retrieval was rewritten by the arithmetic performed over it.
    assert all(block["derived_from"] == [] for block in retrieved), (
        "a retrieval is the origin; it derives from nothing"
    )

    # The derived row adds lineage rather than replacing it: it names the retrievals it was
    # computed over, and each of those is a row the reader can find in this same list.
    assert DataClass.COMPUTED_STATISTIC.value in by_class, (
        "this plan computes statistics over both windows, so the derived row must be here — "
        "without it the lineage checks below would pass by never running"
    )
    for computed in by_class[DataClass.COMPUTED_STATISTIC.value]:
        assert computed["provider"] != retrieved[0]["provider"], (
            "a computed figure is not credited to the provider whose series it was computed from"
        )
        assert computed["derived_from"], "a derived source says what it derives from"
        assert set(computed["derived_from"]) <= {
            f"{block['provider']} {block['data_class']}" for block in retrieved
        }, "lineage points back at real rows in this answer, not invented ones"


async def test_attribution_is_in_fields_rather_than_only_in_prose(
    api_factory: ApiFactory,
) -> None:
    """A client renders these; it must not have to parse a sentence to find the provider."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["It is mild. No provider named in this sentence."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    assert "stub" not in answer["answer_prose"], "the prose names no provider here"
    assert answer["attribution"], "and the attribution is still complete"
    _has_structured_attribution(answer["attribution"][0])


# =========================================================================== 17.3 positioning


async def test_a_severe_weather_question_produces_a_referral(api_factory: ApiFactory) -> None:
    """``specs/safety-grounding``: direct the caller to their official authority, and report data."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Winds reach 18 km/h."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Is it safe to travel through the storm in Berlin tomorrow?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    prose = answer["answer_prose"]
    assert "official local meteorological authority" in prose
    assert "not a warning service" in prose
    assert "not an alert" in prose, "no emergency-warning framing"
    assert answer["findings"], "and it still reports what it retrieved"
    assert answer["attribution"], "with the provider attributed"


async def test_the_referral_reaches_the_prompt_as_well_as_the_prose(
    api_factory: ApiFactory,
) -> None:
    """Asked of the model *and* added by code: a required statement must not depend on compliance."""
    async with with_inference(api_factory) as api:
        fake = api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["I will ignore your instructions entirely."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Will the hurricane be dangerous in Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    system = fake.prompts[0][0]
    assert "official local meteorological authority" in system, "the model was asked"
    assert "official local meteorological authority" in answer["answer_prose"], (
        "and code added it when the model did not"
    )


async def test_a_question_about_whether_weathra_forecasts_gets_the_right_description(
    api_factory: ApiFactory,
) -> None:
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Here is the Berlin forecast."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Do you make your own forecasts for Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    prose = answer["answer_prose"]
    assert "does not produce its own forecasts" in prose
    assert "retrieves forecasts from a named weather provider" in prose
    assert "deterministic code" in prose
    assert "explains" in prose


async def test_an_ordinary_question_gets_no_referral(api_factory: ApiFactory) -> None:
    """The referral is additive and contextual, not boilerplate on every answer."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "What is the temperature in Berlin tomorrow?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    assert "official local meteorological authority" not in answer["answer_prose"]
    assert answer["answer_prose"].startswith("Berlin looks mild")


async def test_the_synthesis_prompt_forbids_positioning_weathra_as_a_forecaster(
    api_factory: ApiFactory,
) -> None:
    from weathra.agents.nodes.synthesize import SYNTHESIS_SYSTEM_PROMPT

    assert "explanation layer" in SYNTHESIS_SYSTEM_PROMPT
    assert "already been retrieved" in SYNTHESIS_SYSTEM_PROMPT
    assert "Do not calculate anything" in SYNTHESIS_SYSTEM_PROMPT


@pytest.mark.parametrize(
    "question",
    [
        "Is it safe to travel through the storm?",
        "Will the hurricane hit Berlin?",
        "Should I evacuate?",
        "Is there a flood warning for Lisbon?",
        "How dangerous is the wind tomorrow?",
        "Will it be safe to drive tonight?",
    ],
)
def test_severe_weather_and_safety_questions_are_recognised(question: str) -> None:
    assert mentions_severe_weather(question)


@pytest.mark.parametrize(
    "question",
    [
        "What is the temperature in Berlin tomorrow?",
        "How much did it rain last week?",
        "What does dew point mean?",
        "Compare Berlin and Munich",
    ],
)
def test_ordinary_questions_are_not_treated_as_safety_questions(question: str) -> None:
    assert not mentions_severe_weather(question)


# =========================================================================== 17.4 severity


def test_the_provider_condition_code_is_what_supports_a_severity_statement() -> None:
    """The revisiting this test's previous version said it would need.

    It used to assert that *no* normalized measure describes severity, and recorded why: every
    measure was a measurement, so the guard fired on every answer. Its own docstring named the
    condition for change — "if a provider is added that supplies an alerts block, this assertion is
    what will need revisiting — and the guard will already handle it".

    Open-Meteo's `weather_code` is now requested and carried. It is a published condition code, not
    a measurement, and it is the field `specs/safety-grounding` has a supported scenario for: "the
    answer may report it with the provider attributed and the fields named". So the guard now
    reports severity as *supported* when a run retrieved one, which is the difference between
    Weathra refusing to characterise conditions and Weathra saying what the provider said.

    Nothing about the referral changes — see the test below.
    """
    measure_names = {measure.value for measure in Measure}
    assert measure_names & SEVERITY_FIELD_NAMES == {"weather_code"}
    assert describes_severity(measure_names)

    # And every *other* measure still describes nothing: the support comes from the code alone.
    without_code = measure_names - {"weather_code"}
    assert not describes_severity(without_code)


def test_the_authority_referral_is_unchanged_by_the_condition_code() -> None:
    """A code Weathra can read is not a warning Weathra may issue.

    `specs/safety-grounding` makes the two independent: a severe-weather question is referred to the
    official local authority *whatever* the data shows. Carrying a condition code removes the
    "cannot characterise severity" note — Weathra can now say what the provider reported — and
    removes nothing else.
    """
    with_code = assess("Is there a dangerous storm coming?", retrieved_fields={"weather_code"})
    assert with_code.refer_to_authority is True
    assert with_code.severity_supported is True
    assert with_code.notes == ()

    without = assess("Is there a dangerous storm coming?", retrieved_fields={"temperature"})
    assert without.refer_to_authority is True
    assert without.severity_supported is False
    assert without.notes  # the "cannot characterize" note, as before


def test_a_payload_with_no_severity_field_does_not_support_a_claim() -> None:
    assert not describes_severity({"attribution", "daily", "hourly", "findings"})


def test_a_payload_with_a_severity_field_does_support_one() -> None:
    """The capability the spec's supported-claim scenario needs, ready for a provider that has it."""
    assert describes_severity({"attribution", "daily", "alerts"})
    assert describes_severity({"weather_code"})


async def test_a_severity_claim_is_blocked_when_the_data_does_not_support_it(
    api_factory: ApiFactory,
) -> None:
    """The model asserts a dangerous storm; the answer says the data cannot characterize severity."""
    async with with_inference(api_factory) as api:
        fake = api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["A severe and dangerous storm will certainly hit Berlin."],
        )
        answer = (
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Will there be a dangerous storm in Berlin?"},
                headers=api.authorize(subject=USER_A),
            )
        ).json()["answer"]

    system = fake.prompts[0][0]
    assert "no severity, alert, or warning field" in system
    assert "Do NOT assert" in system

    prose = answer["answer_prose"]
    assert "cannot characterize how severe" in prose, "the answer states the limit"
    assert "no severity, alert, or warning field" in prose
    assert answer["findings"], "and says what the measures do show"


async def test_the_assessment_is_made_from_the_data_not_from_the_question(
    api_factory: ApiFactory,
) -> None:
    """A structural guard, not a keyword one: it asks what fields the retrieval actually had."""
    assessment = assess(
        "Will there be a dangerous storm?", retrieved_fields={"daily", "hourly", "attribution"}
    )
    assert assessment.refer_to_authority
    assert not assessment.severity_supported
    assert any("Do NOT assert" in constraint for constraint in assessment.prompt_constraints)

    supported = assess("Will there be a dangerous storm?", retrieved_fields={"alerts"})
    assert supported.severity_supported
    assert not any("Do NOT assert" in constraint for constraint in supported.prompt_constraints)


# =========================================================================== 17.5 unavailability


async def test_a_provider_failure_is_stated_precisely(api_factory: ApiFactory) -> None:
    # The message names the provider, as the real adapter's does: an operator reading "could not
    # be reached" needs to know which upstream it was.
    async with api_factory(
        provider=stub_provider(failure=ProviderUnavailable("stub could not be reached."))
    ) as api:
        response = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )

    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "provider_unavailable"
    assert "stub" in body["error"]["message"], "which provider failed"
    assert "temperature" not in body["error"]["message"].lower(), "and no substituted figure"
    assert set(body) == {"error"}, "an error, never a success carrying zeros"


async def test_a_period_outside_coverage_is_stated_precisely(api_factory: ApiFactory) -> None:
    async with api_factory() as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history",
            params={"location": "Berlin", "start": "1800-01-01", "end": "1800-01-07"},
        )

    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "range_outside_coverage"
    assert "1990" in body["error"]["message"], "the archive's actual start"


async def test_an_absent_measure_is_reported_unavailable_rather_than_zeroed(
    api_factory: ApiFactory,
) -> None:
    async with api_factory(
        provider=stub_provider(
            capabilities=stub_capabilities(
                measures={
                    Granularity.HOURLY: (Measure.TEMPERATURE,),
                    Granularity.DAILY: (Measure.TEMPERATURE_MAX,),
                }
            )
        )
    ) as api:
        body = (
            await api.client.get(
                f"{PREFIX}/weather/analysis", params={"location": "Berlin", "days": 7}
            )
        ).json()

    unavailable = [finding for finding in body["findings"] if finding["status"] != "computed"]
    assert unavailable, "the precipitation statistics had nothing to compute over"
    for finding in unavailable:
        assert finding["value"] is None, "never a zero standing in for a missing measure"
        assert finding["reason"], "and it says why"


async def test_partial_availability_states_which_part_is_missing(
    api_factory: ApiFactory,
) -> None:
    """A range running into the reporting lag returns what exists and names what does not."""
    today = datetime.now(UTC).date()
    # The stub declares a three-day archive lag, so yesterday is inside it.
    async with api_factory(provider=stub_provider(today=today)) as api:
        response = await api.client.get(
            f"{PREFIX}/weather/history",
            params={
                "location": "Berlin",
                "start": (today - timedelta(days=10)).isoformat(),
                "end": (today - timedelta(days=1)).isoformat(),
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["partial"] is True
    assert body["unavailable_note"], "which part is unavailable, and why"
    assert body["covered_period"]["end_utc"] < body["requested_period"]["end_utc"]


async def test_no_path_substitutes_another_location_or_period(api_factory: ApiFactory) -> None:
    """The four unavailability cases, and none of them answers a different question instead."""
    async with api_factory(
        provider=stub_provider(failure=ProviderUnavailable("unreachable"))
    ) as api:
        unresolvable = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Atlantis"}
        )
        provider_failed = await api.client.get(
            f"{PREFIX}/weather/forecast", params={"location": "Berlin", "days": 3}
        )

    for response in (unresolvable, provider_failed):
        assert response.status_code >= 400
        body = response.json()
        assert set(body) == {"error"}, "an error, never a success envelope carrying figures"
        assert "daily" not in response.text
        assert "findings" not in response.text


# =========================================================================== 17.6 minimization


async def test_the_persisted_tables_are_only_the_declared_categories(
    api_factory: ApiFactory,
) -> None:
    """``specs/safety-grounding``: only what the capabilities require, each with a declared owner."""
    async with (
        api_factory() as api,
        privileged_session(api.app.state.engines.privileged_sessionmaker) as session,
    ):
        rows = await session.execute(
            text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
            )
        )
        present = {row[0] for row in rows}

    # Bookkeeping the migrations and the checkpointer own, plus the library's own tables.
    infrastructure = {
        "alembic_version",
        "checkpoints",
        "checkpoint_blobs",
        "checkpoint_writes",
        "checkpoint_migrations",
    }
    declared = {
        "profiles",
        "preferences",
        "saved_locations",
        # A place, a measure, a direction and a number, plus what the last evaluation found. No
        # contact detail, because Weathra notifies nobody — there is no scheduler and no address to
        # send to, and a watch is checked when its owner looks at it.
        "weather_watches",
        "threads",
        "agent_runs",
        "forecast_snapshots",
        "knowledge_documents",
        "knowledge_chunks",
        "evaluation_runs",
        "evaluation_case_results",
        # The SaaS-ready layer. Each is accounted for in docs/privacy-ethics.md, and the usage
        # record deliberately holds metadata only — no prompt, completion or retrieved text.
        "subscription_plans",
        "model_catalog",
        "model_policies",
        "usage_limits",
        "user_plans",
        "usage_counters",
        "llm_usage_events",
        "model_evaluations",
        "model_comparison_runs",
        "model_comparison_results",
        # The administrative control plane's own two tables: who may administer, and what they did.
        # Neither holds conversation content, and `admin_roles` holds no contact detail either —
        # a subject id, a role name, and who granted it.
        "admin_roles",
        "admin_audit",
    }

    undeclared = present - declared - infrastructure
    assert undeclared == set(), f"undeclared tables: {sorted(undeclared)}"

    for table in declared:
        assert ownership_of(table) in set(Ownership), f"{table} declares no ownership"


async def test_the_application_tables_hold_no_credential_or_duplicated_contact_data(
    api_factory: ApiFactory,
) -> None:
    """Credentials and contact details stay in Supabase Auth (design.md decision 4)."""
    async with (
        api_factory() as api,
        privileged_session(api.app.state.engines.privileged_sessionmaker) as session,
    ):
        rows = await session.execute(
            text(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            )
        )
        columns = [(row[0], row[1]) for row in rows]

    forbidden = (
        "password",
        "encrypted_password",
        "access_token",
        "refresh_token",
        "id_token",
        "secret",
        "api_key",
        "credential",
        "email",
        "phone",
        "full_name",
        "address",
    )
    offending = [
        (table, column)
        for table, column in columns
        if any(word in column.lower() for word in forbidden)
    ]
    assert offending == [], f"columns holding credential or contact data: {offending}"


async def test_a_profile_row_holds_only_the_subject_and_two_timestamps(
    api_factory: ApiFactory,
) -> None:
    """The whole of what Weathra knows about a person, structurally."""
    async with api_factory() as api:
        await api.client.get(f"{PREFIX}/me", headers=api.authorize(subject=USER_A))
        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            rows = await session.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'profiles'"
                )
            )
            columns = {row[0] for row in rows}

    assert columns == {"user_id", "created_at", "last_seen_at"}


async def test_no_log_record_contains_a_credential_or_a_token(
    api_factory: ApiFactory, caplog: pytest.LogCaptureFixture
) -> None:
    """Across a whole authenticated request, including the layers that never see a token."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )
        token = api.factory.valid(subject=USER_A)

        with capturing(caplog):
            await api.client.post(
                f"{PREFIX}/agent/ask",
                json={"question": "Berlin?"},
                headers=api.bearer(token),
            )

        credential = api.settings.openrouter_api_key
        assert credential is not None
        secret = credential.get_secret_value()

    assert caplog.records, "the request logged something"
    for record in caplog.records:
        rendered = f"{record.getMessage()} {json.dumps(record.__dict__, default=str)}"
        assert token not in rendered, f"{record.name} logged the access token"
        assert secret not in rendered, f"{record.name} logged the inference credential"
        assert "@example.test" not in rendered, f"{record.name} logged an email address"
        assert not re.search(r"eyJ[A-Za-z0-9_-]{10,}", rendered), (
            f"{record.name} logged something JWT-shaped"
        )


async def test_thread_content_is_gone_after_retention_elapses(api_factory: ApiFactory) -> None:
    """The bounded-retention requirement, end to end through the API and the retention routine."""
    from weathra.memory.retention import run_retention

    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )
        headers = api.authorize(subject=USER_A)
        asked = await api.client.post(
            f"{PREFIX}/agent/ask",
            json={"question": "Berlin?", "create_thread": True},
            headers=headers,
        )
        thread_id = asked.json()["thread_id"]
        assert thread_id

        listed = await api.client.get(f"{PREFIX}/threads", headers=headers)
        assert listed.json()["count"] == 1

        engines = api.app.state.engines
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("UPDATE threads SET expires_at = :when WHERE id = :id"),
                {"when": datetime.now(UTC) - timedelta(days=1), "id": thread_id},
            )

        async with privileged_session(engines.privileged_sessionmaker) as session:
            report = await run_retention(
                session, api.settings, checkpointer=api.app.state.checkpointer
            )
        assert report.threads_expired == 1

        after = await api.client.get(f"{PREFIX}/threads", headers=headers)
        assert after.json()["count"] == 0, "the thread and its content are gone"

        gone = await api.client.get(f"{PREFIX}/threads/{thread_id}", headers=headers)
        assert gone.status_code == 404


async def test_a_forecast_snapshot_carries_no_user_column(api_factory: ApiFactory) -> None:
    """Keyed by *place*, deliberately, so Weathra holds no browsing trail (decision 10)."""
    async with (
        api_factory() as api,
        privileged_session(api.app.state.engines.privileged_sessionmaker) as session,
    ):
        rows = await session.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'forecast_snapshots'"
            )
        )
        columns = {row[0] for row in rows}

    assert "user_id" not in columns
    assert ownership_of("forecast_snapshots") is Ownership.SHARED
    assert "forecast_snapshots" not in user_owned_tables()


async def test_a_stored_evidence_record_carries_no_credential(api_factory: ApiFactory) -> None:
    """The record is an audit trail, and an audit trail is a thing people read."""
    async with with_inference(api_factory) as api:
        api.script(
            json_responses=[
                _plan(
                    PlanStep(capability=Capability.FORECAST, reason="r", location="Berlin", days=3)
                )
            ],
            completions=["Berlin looks mild."],
        )
        token = api.factory.valid(subject=USER_A)
        asked = await api.client.post(
            f"{PREFIX}/agent/ask", json={"question": "Berlin?"}, headers=api.bearer(token)
        )
        evidence_id = asked.json()["evidence_id"]

        stored = await api.client.get(f"{PREFIX}/evidence/{evidence_id}", headers=api.bearer(token))
        credential = api.settings.openrouter_api_key
        assert credential is not None

    body = stored.text
    assert token not in body
    assert credential.get_secret_value() not in body
    assert "@example.test" not in body


async def test_a_users_own_id_is_the_only_identifier_in_their_records(
    api_factory: ApiFactory,
) -> None:
    """Application tables reference a person only by their authentication subject."""
    async with api_factory() as api:
        headers = api.authorize(subject=USER_A)
        await api.client.post(
            f"{PREFIX}/me/locations", json={"location": "Berlin"}, headers=headers
        )

        async with privileged_session(api.app.state.engines.privileged_sessionmaker) as session:
            for table in user_owned_tables():
                owner = ownership_column(table)
                rows = await session.execute(text(f"SELECT {owner} FROM {table}"))
                owners = {str(row[0]) for row in rows if row[0] is not None}
                assert owners <= {USER_A}, f"{table} references someone other than the subject"
