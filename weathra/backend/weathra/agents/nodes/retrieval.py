"""The forecast and historical capability nodes.

Both do the same three things and differ only in which tool they call and which data class comes
back, so they share this module rather than duplicating the recording: resolve the place, call the
tool through the MCP client, and record the result, its attribution, and its findings.

**The node calls a tool; it does not call a provider.** ``specs/agent-orchestration`` forbids an
agent from reaching a weather provider directly, and this is where that is either true or not.
Nothing here imports a provider client — only ``McpToolClient`` — which is what the
no-direct-provider-import test asserts about this package.

**Findings come from a tool, never from the node.** The forecast tool returns its own computed
statistics, each with its method, unit, and point count. The history tool deliberately does not —
it retrieves, and computing is the analytics layer's job — so the historical node asks
``weather_statistics`` for the headline set over the series it just retrieved. Two tool calls
instead of one, both recorded, and no arithmetic anywhere in this module: "how warm was it last
week?" then carries real figures with a stated method rather than a series nobody summarized.

**A failure is recorded and the run continues.** A three-part question whose historical part fails
should answer the other two parts and say what happened to the third, not lose all three
(``specs/agent-orchestration``'s partial-result requirement). So a failed tool call becomes a
recorded failure and a named unanswered part.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from weathra.agents.nodes.support import (
    attribution_from,
    baseline_for,
    call_tool,
    finding_from_statistic,
    findings_from_current,
    headline_measure,
    points_for,
    record_step,
    series_from,
    unit_system_from,
    window_label,
)
from weathra.agents.plan import Capability, PlanStep
from weathra.agents.state import GraphState, Retrieval
from weathra.domain.evidence import AgentName, Attribution, Finding, StepStatus
from weathra.domain.location import Location
from weathra.domain.weather import DataClass
from weathra.mcp.client import McpToolClient

__all__ = ["run_current", "run_forecast", "run_historical"]

logger = logging.getLogger("weathra.agents.nodes.retrieval")

# Which tool and which agent each capability is. Named here so a capability cannot silently reach
# for a tool outside the two it is meant to use.
_CURRENT_TOOL = "weather_current"
_FORECAST_TOOL = "weather_forecast"
_HISTORY_TOOL = "weather_history"
_STATISTICS_TOOL = "weather_statistics"

# What "how warm was it?" means. The same default set the analytics node uses, so a historical
# answer with no explicit statistic reads the same as a forecast one.
HEADLINE_STATISTICS: tuple[str, ...] = ("minimum", "maximum", "mean", "range")


async def run_current(state: GraphState, step: PlanStep, *, client: McpToolClient) -> GraphState:
    """Retrieve current conditions for each location the step names.

    The third capability that retrieves, and the reason it is its own node rather than a branch of
    ``run_forecast``: what a provider reports for *now* and what it projects for the days ahead are
    two data classes, they are recorded under two agents, and an answer carrying both has to be able
    to say which figure is which. Folding them together would produce exactly the blended credit
    line `specs/safety-grounding` forbids.

    No statistics step follows this one. A current reading is a single value per measure — there is
    no series to summarize, and asking the analytics tool for the mean of one number would be
    arithmetic performed for the sake of having performed some.
    """
    started = datetime.now(UTC)
    locations = _locations_for(state, step)

    if not locations:
        return record_step(
            state,
            agent=AgentName.CURRENT,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="No location was resolved, so there was nowhere to read conditions for.",
        )

    working = state
    succeeded = 0

    for location in locations:
        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.CURRENT,
            tool=_CURRENT_TOOL,
            arguments={
                "latitude": location.latitude,
                "longitude": location.longitude,
                "units": working.unit_system.value,
            },
        )

        if outcome.failed:
            working = working.with_failure(
                f"The current conditions for {location.qualified_name} could not be retrieved "
                f"({outcome.error_code})."
            )
            continue

        working = _record_retrieval(
            working, outcome.data, capability=Capability.CURRENT, step=step, location=location
        )
        succeeded += 1

    status = StepStatus.SUCCEEDED if succeeded else StepStatus.FAILED
    reason = (
        step.reason
        if succeeded
        else "Current conditions could not be retrieved for any location in this step."
    )
    return record_step(
        working, agent=AgentName.CURRENT, started_at=started, status=status, reason=reason
    )


async def run_forecast(state: GraphState, step: PlanStep, *, client: McpToolClient) -> GraphState:
    """Retrieve a forecast for each location the step names, and record what came back.

    Uses ``weather_compare`` for nothing: a comparison is a ranking over the same retrievals, and
    doing it here as several forecasts keeps every location's own series available to a later
    analytics step.
    """
    started = datetime.now(UTC)
    locations = _locations_for(state, step)

    if not locations:
        return record_step(
            state,
            agent=AgentName.FORECAST,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="No location was resolved, so there was nothing to retrieve a forecast for.",
        )

    working = state
    succeeded = 0

    for location in locations:
        arguments: dict[str, Any] = {
            "latitude": location.latitude,
            "longitude": location.longitude,
            "units": working.unit_system.value,
        }
        if step.days is not None:
            arguments["days"] = step.days

        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.FORECAST,
            tool=_FORECAST_TOOL,
            arguments=arguments,
        )

        if outcome.failed:
            working = working.with_failure(
                f"The forecast for {location.qualified_name} could not be retrieved "
                f"({outcome.error_code})."
            )
            continue

        working = _record_retrieval(
            working, outcome.data, capability=Capability.FORECAST, step=step, location=location
        )
        succeeded += 1

    status = StepStatus.SUCCEEDED if succeeded else StepStatus.FAILED
    reason = (
        step.reason
        if succeeded
        else "No forecast could be retrieved for any location in this step."
    )
    return record_step(
        working, agent=AgentName.FORECAST, started_at=started, status=status, reason=reason
    )


async def run_historical(state: GraphState, step: PlanStep, *, client: McpToolClient) -> GraphState:
    """Retrieve observed weather over the step's date range.

    A step with no range is skipped rather than given one: guessing at "last week" when the plan
    did not say would answer a question nobody asked. The deterministic router always supplies a
    range, so this is reached only when a model produced a historical step without dates.
    """
    started = datetime.now(UTC)
    locations = _locations_for(state, step)

    if not locations:
        return record_step(
            state,
            agent=AgentName.HISTORICAL,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="No location was resolved, so there was nothing to look up in the archive.",
        )

    if step.start_date is None or step.end_date is None:
        return record_step(
            state.with_failure(
                "A historical step arrived with no date range, so no period could be looked up."
            ),
            agent=AgentName.HISTORICAL,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason=(
                "The plan asked for historical data without a date range. Weathra does not guess "
                "at which past period was meant."
            ),
        )

    working = state
    retrieved: list[tuple[Location, Retrieval]] = []

    for location in locations:
        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.HISTORICAL,
            tool=_HISTORY_TOOL,
            arguments={
                "latitude": location.latitude,
                "longitude": location.longitude,
                # The tool's own argument names, which are not the plan's: a plan says
                # ``start_date`` because that is what a model produces reliably, and the tool says
                # ``start``. Translating here keeps both vocabularies stable.
                "start": step.start_date.isoformat(),
                "end": step.end_date.isoformat(),
                "units": working.unit_system.value,
            },
        )

        if outcome.failed:
            working = working.with_failure(
                f"The archive for {location.qualified_name} could not be read "
                f"({outcome.error_code})."
            )
            continue

        working = _record_retrieval(
            working, outcome.data, capability=Capability.HISTORICAL, step=step, location=location
        )
        # Held rather than re-read later: ``retrieval_for`` answers with the *most recent* result,
        # so a two-location step computing after the loop would compute both sets of statistics
        # over the second location's series.
        just_retrieved = working.retrieval_for(Capability.HISTORICAL)
        if just_retrieved is not None:
            retrieved.append((location, just_retrieved))

    status = StepStatus.SUCCEEDED if retrieved else StepStatus.FAILED
    reason = (
        step.reason if retrieved else "The archive could not be read for any location in this step."
    )
    working = record_step(
        working, agent=AgentName.HISTORICAL, started_at=started, status=status, reason=reason
    )

    return await _analytics_turn(working, retrieved, client=client)


async def _analytics_turn(
    state: GraphState,
    retrieved: Sequence[tuple[Location, Retrieval]],
    *,
    client: McpToolClient,
) -> GraphState:
    """The analytics layer's turn over the series the archive just returned.

    **Why this is a step of its own.** The archive retrieves and does not compute; the figures a
    reader sees under "how warm was it" come out of the analytics kernel, through
    ``weather_statistics``, under the ``computed_statistic`` data class. Recording that work under
    ``historical`` — which is what this node did — left a run whose evidence carried a mean, a
    minimum, a maximum and a range with no analytics stage anywhere in its execution record, and an
    evidence screen that could only recover the figures by rummaging in a retrieval's tool result.
    The capability is in the catalog and the enum, the tool call is real, and the class of the
    result is not the class of the series it was computed over, so the step is real too.

    It runs *after* the historical step is recorded rather than inside it, so neither duration
    contains the other: the archive's step is what retrieval cost, and this one is what the
    arithmetic cost.
    """
    if not retrieved:
        return state

    started = datetime.now(UTC)
    working = state
    computed = 0

    for location, retrieval in retrieved:
        working, succeeded = await _headline_statistics(
            working, location, retrieval=retrieval, client=client
        )
        computed += 1 if succeeded else 0

    return record_step(
        working,
        agent=AgentName.ANALYTICS,
        started_at=started,
        status=StepStatus.SUCCEEDED if computed else StepStatus.FAILED,
        reason=(
            "Computed the headline statistics over the archived series. Every figure carries the "
            "method that produced it and the number of points it used."
            if computed
            else "No statistic could be computed over the series the archive returned."
        ),
    )


async def _headline_statistics(
    state: GraphState,
    location: Location,
    *,
    retrieval: Retrieval,
    client: McpToolClient,
) -> tuple[GraphState, bool]:
    """Compute the headline statistics over the observations just retrieved.

    Through the analytics tool, not here: the arithmetic stays in one place, the call is recorded
    in the evidence, and every figure carries the method that produced it. A plan that goes on to
    ask for something specific adds its own analytics step; this is what "how warm was it?" needs.

    The call is attributed to the analytics agent, because that is which agent made it. It read a
    series the archive retrieved, which is the ordinary shape of an analytics step, and crediting
    the arithmetic to the retrieval that supplied its input is what left a run's computed figures
    with no analytics anywhere in its execution record.
    """
    measure = headline_measure(retrieval)
    if measure is None:
        return (
            state.with_failure(
                f"The archive returned no measured values for {location.qualified_name}, so no "
                "statistic could be computed over them."
            ),
            False,
        )

    points, unit = points_for(retrieval, measure)
    if not points:
        return (
            state.with_failure(
                f"The archive returned no {measure.value.replace('_', ' ')} values for "
                f"{location.qualified_name}, so no statistic could be computed over them."
            ),
            False,
        )

    arguments: dict[str, Any] = {
        "measure": measure.value,
        "unit": unit,
        "points": points,
        "statistics": list(HEADLINE_STATISTICS),
        "location": location.qualified_name,
        "timezone": location.timezone,
        "provider": retrieval.provider,
    }

    # The window this one is being compared against, when the run retrieved one.
    #
    # A question that asks the archive twice — this week and the same week a year ago — is a
    # comparison, and the figure it turns on is the difference. Without this the run summarised
    # each window and left the subtraction to whoever read the two sets of figures, so the answer's
    # headline number was the one number with no method and no place in the evidence record.
    baseline = baseline_for(state, retrieval, measure)
    if baseline is not None:
        baseline_points, _ = points_for(baseline, measure)
        if baseline_points:
            arguments["baseline_points"] = baseline_points
            arguments["baseline_label"] = window_label(baseline)

    working, outcome = await call_tool(
        state,
        client,
        agent=AgentName.ANALYTICS,
        tool=_STATISTICS_TOOL,
        arguments=arguments,
    )

    if outcome.failed:
        return (
            working.with_failure(
                f"The observations for {location.qualified_name} were retrieved, but no statistic "
                f"could be computed over them ({outcome.error_code})."
            ),
            False,
        )

    computed = outcome.data.get("baseline")
    reported_figures = [
        *(outcome.data.get("results") or ()),
        *((computed.get("results") or ()) if isinstance(computed, dict) else ()),
        *(outcome.data.get("differences") or ()),
    ]
    return (
        working.with_findings(
            tuple(
                finding_from_statistic(
                    reported, retrieval.attribution, data_class=DataClass.COMPUTED_STATISTIC
                )
                for reported in reported_figures
                if isinstance(reported, dict)
            )
        ),
        True,
    )


# =========================================================================== shared


def _locations_for(state: GraphState, step: PlanStep) -> tuple[Location, ...]:
    """The resolved locations this step runs over.

    Resolution happened in ``agents/context.py`` before any node ran, so this reads what was
    resolved rather than resolving again — which is what makes "where did this location come from"
    answerable in one place.
    """
    if not step.named_locations:
        return state.locations

    wanted = {name.strip().casefold() for name in step.named_locations}
    matched = tuple(
        location
        for location in state.locations
        if location.display_name.casefold() in wanted
        or location.qualified_name.casefold() in wanted
    )
    # A step naming places that were resolved under different display names still runs: the
    # resolved set is what the geocoder actually found for this question.
    return matched or state.locations


def _record_retrieval(
    state: GraphState,
    payload: dict[str, Any],
    *,
    capability: Capability,
    step: PlanStep,
    location: Location,
) -> GraphState:
    """Record one tool result as a retrieval, with its attribution and its findings.

    The attribution's location is replaced with the one *this node resolved*, and that is not
    cosmetic. The node resolves "Berlin" to coordinates and calls the tool with them; the tool
    resolves those coordinates back, and a coordinate lookup has no name to return — so the tool's
    own attribution says "52.52, 13.41". Both describe the same place, and one of them is the name
    the person used. Every finding's label and every attribution line reads from this, so keeping
    the tool's would mean answering "the daily high in 52.5244, 13.4105 is 21.3 °C".
    """
    attribution = attribution_from(payload).model_copy(update={"location": location})
    retrieval = Retrieval(
        capability=capability,
        location=location,
        period=attribution.period,
        data_class=attribution.data_class,
        unit_system=unit_system_from(payload, state.unit_system),
        provider=attribution.provider,
        retrieved_at=attribution.retrieved_at,
        daily=series_from(payload, "daily"),
        hourly=series_from(payload, "hourly"),
        payload=payload,
        attribution=attribution,
        question_part=step.question_part,
    )

    findings = _findings_from(payload, attribution)
    return state.with_retrieval(retrieval).with_findings(findings)


def _findings_from(payload: dict[str, Any], attribution: Attribution) -> tuple[Finding, ...]:
    """The tool's own reported figures, as evidence-record findings.

    Two shapes, because the two retrieval tools report differently and neither one is summarized
    here. ``weather_forecast`` returns its own computed statistics, each with the method that
    produced it. ``weather_current`` returns a value and a unit per measure, because a current
    reading is already the figure — see ``findings_from_current`` for why that is transcription
    rather than the node computing. The archive returns neither, and the historical node asks
    ``weather_statistics`` over the series it retrieved.
    """
    if attribution.data_class is DataClass.CURRENT:
        return findings_from_current(payload, attribution)

    return tuple(
        finding_from_statistic(reported, attribution)
        for reported in payload.get("findings") or ()
        if isinstance(reported, dict)
    )
