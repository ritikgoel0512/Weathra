"""The analytics capability node: statistics over a series another node retrieved.

**It cannot retrieve.** The ``weather_statistics`` and ``weather_anomaly`` tools take a series as
an argument; they have no provider and no way to fetch one. So analytics runs over the points a
prior step already put in the state, and "the model interprets but never calculates" holds for a
reason stronger than a prompt: there is no path by which the analytics capability could obtain a
number nobody retrieved.

**The series is passed, not re-fetched.** ``Retrieval`` carries the series, so the figures in an
answer are computed over exactly the numbers the retrieval step recorded — one retrieval, one set
of data, no chance of the answer and the evidence record disagreeing about what the weather was.

**Absent values stay absent.** A null in the series is excluded and counted by the analytics
functions, and the tool reports the exclusions. Nothing here fills one in, and a statistic the
tools declare unavailable becomes a finding with no value and the reason — never a zero.

**What it computes comes from the plan, with a documented default.** A step that names statistics
gets those; a step that names none gets minimum, maximum, mean, and range, which is what "what were
the temperatures like?" means. A trend or an anomaly request goes to the tool that computes it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from weathra.agents.nodes.support import (
    baseline_for,
    call_tool,
    finding_from_statistic,
    headline_measure,
    measures_in,
    points_for,
    record_step,
    window_label,
)
from weathra.agents.plan import PlanStep
from weathra.agents.state import GraphState, Retrieval
from weathra.domain.evidence import AgentName, Finding, StepStatus
from weathra.domain.weather import DataClass, Measure
from weathra.mcp.client import McpToolClient

__all__ = ["DEFAULT_STATISTICS", "run_analytics"]

logger = logging.getLogger("weathra.agents.nodes.analytics")

_STATISTICS_TOOL = "weather_statistics"
_ANOMALY_TOOL = "weather_anomaly"

# What "what were the temperatures like?" means when a plan asks for no statistic in particular.
DEFAULT_STATISTICS: tuple[str, ...] = ("minimum", "maximum", "mean", "range")

# The statistic names the tool computes. A name outside this set is dropped with a recorded reason
# rather than passed through: the tool would reject the whole call, losing the valid ones with it.
_KNOWN_STATISTICS = frozenset(
    {
        "minimum",
        "maximum",
        "mean",
        "range",
        "total",
        "percentile",
        "rolling_mean",
        "trend",
        "standard_deviation",
    }
)

# Requests that go to the anomaly tool instead. "Unusual" is a different question from "average".
_ANOMALY_WORDS = frozenset({"anomaly", "anomalies", "anomalous", "unusual", "outlier", "outliers"})


async def run_analytics(state: GraphState, step: PlanStep, *, client: McpToolClient) -> GraphState:
    """Compute the step's statistics over the most recent retrieved series.

    Skipped, with the reason recorded, when no prior step retrieved anything — which is the honest
    outcome: there is no series to compute over, and inventing one is the failure mode this whole
    arrangement exists to prevent.
    """
    started = datetime.now(UTC)
    source = state.latest_series_retrieval

    if source is None:
        return record_step(
            state.with_failure(
                "No statistic could be computed: no earlier step retrieved a series to compute "
                "over."
            ),
            agent=AgentName.ANALYTICS,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason=(
                "Analytics computes over data another step retrieved, and nothing was retrieved. "
                "Weathra does not produce a statistic without the series behind it."
            ),
        )

    requested = tuple(step.statistics) or DEFAULT_STATISTICS
    wants_anomaly = bool({name.lower() for name in requested} & _ANOMALY_WORDS)
    statistics = tuple(name for name in requested if name in _KNOWN_STATISTICS)
    unknown = tuple(
        name
        for name in requested
        if name not in _KNOWN_STATISTICS and name.lower() not in _ANOMALY_WORDS
    )

    measure = _measure_for(step, source)
    if measure is None:
        return record_step(
            state.with_failure(
                "No statistic could be computed: the retrieved series carries no measure that "
                "matches what was asked for."
            ),
            agent=AgentName.ANALYTICS,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason="The requested measure is not present in the retrieved series.",
        )

    points, unit = points_for(source, measure)
    if not points:
        return record_step(
            state.with_failure(
                f"No statistic could be computed: the retrieved series carries no "
                f"{measure.value.replace('_', ' ')} values."
            ),
            agent=AgentName.ANALYTICS,
            started_at=started,
            status=StepStatus.SKIPPED,
            reason=f"The series carries no {measure.value} points to compute over.",
        )

    working = state
    if unknown:
        working = working.with_failure(
            f"These statistics are not ones Weathra computes and were not attempted: "
            f"{', '.join(unknown)}."
        )

    computed = 0

    if statistics or not wants_anomaly:
        arguments: dict[str, Any] = {
            "measure": measure.value,
            "unit": unit,
            "points": points,
            "statistics": list(statistics or DEFAULT_STATISTICS),
            "location": source.location.qualified_name,
            "timezone": source.location.timezone,
            "provider": source.provider,
        }
        if "percentile" in arguments["statistics"]:
            # The tool requires a level with the request; 90th is the documented default for
            # "what does a high day look like".
            arguments["percentile"] = 90.0
        if "rolling_mean" in arguments["statistics"]:
            arguments["rolling_window"] = min(3, len(points))

        # The window this one is being compared against, when the run retrieved one.
        #
        # A comparison question — "how does this week compare with the same week last year" — is
        # answered by a *difference*, and until this was here nothing computed one: the run
        # retrieved two windows, summarised each of them, and left the subtraction to whoever read
        # the two sets of figures. So the one figure the question turned on was the one figure with
        # no method, no point count and no place in the evidence record.
        baseline = baseline_for(working, source, measure)
        if baseline is not None:
            baseline_points, _ = points_for(baseline, measure)
            if baseline_points:
                arguments["baseline_points"] = baseline_points
                arguments["baseline_label"] = window_label(baseline)

        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.ANALYTICS,
            tool=_STATISTICS_TOOL,
            arguments=arguments,
        )
        if outcome.failed:
            working = working.with_failure(
                f"The statistics could not be computed ({outcome.error_code})."
            )
        else:
            working = _record_statistics(working, outcome.data, source)
            computed += 1

    if wants_anomaly:
        working, outcome = await call_tool(
            working,
            client,
            agent=AgentName.ANALYTICS,
            tool=_ANOMALY_TOOL,
            arguments={
                "measure": measure.value,
                "unit": unit,
                "points": points,
                "location": source.location.qualified_name,
                "timezone": source.location.timezone,
                "provider": source.provider,
            },
        )
        if outcome.failed:
            working = working.with_failure(
                f"Anomaly detection could not run ({outcome.error_code})."
            )
        else:
            working = _record_anomalies(working, outcome.data, source)
            computed += 1

    status = StepStatus.SUCCEEDED if computed else StepStatus.FAILED
    return record_step(
        working,
        agent=AgentName.ANALYTICS,
        started_at=started,
        status=status,
        reason=step.reason if computed else "No statistic could be computed over the series.",
    )


# =========================================================================== reading the series


def _measure_for(step: PlanStep, source: Retrieval) -> Measure | None:
    """Which measure to compute over: what the step named, else the series' own best candidate."""
    if step.measure:
        try:
            wanted = Measure(step.measure)
        except ValueError:
            wanted = None
        if (
            wanted is not None
            and source.series is not None
            and wanted in measures_in(source.series)
        ):
            return wanted
    return headline_measure(source)


# =========================================================================== recording


def _record_statistics(state: GraphState, payload: dict[str, Any], source: Retrieval) -> GraphState:
    """Record the tool's statistics as findings and as analytics payloads.

    Both, because they serve different readers: a finding is what the UI renders next to the prose,
    and the analytics payload is what the evidence record carries so the method and the point count
    survive into the audit trail.
    """
    baseline = payload.get("baseline")
    reported_figures = [
        *(payload.get("results") or ()),
        *((baseline.get("results") or ()) if isinstance(baseline, dict) else ()),
        # The differences last, so a reader of the findings meets both sides before the figure
        # that subtracts them — and so a comparison's answer carries the figure it turns on.
        *(payload.get("differences") or ()),
    ]
    findings = tuple(
        finding_from_statistic(
            reported, source.attribution, data_class=DataClass.COMPUTED_STATISTIC
        )
        for reported in reported_figures
        if isinstance(reported, dict)
    )
    return state.with_findings(findings).with_analytics("statistics", payload)


def _record_anomalies(state: GraphState, payload: dict[str, Any], source: Retrieval) -> GraphState:
    """Record an anomaly report, including the honest "nothing stood out" case.

    A window with no anomaly is a real answer and gets a finding saying so, because the alternative
    — reporting nothing — reads as though the question was not asked.
    """
    anomalies = payload.get("anomalies") or ()
    findings = (
        Finding(
            label="Anomalous days",
            value=float(len(anomalies)),
            unit="days",
            data_class=DataClass.COMPUTED_STATISTIC,
            method=payload.get("method"),
            points_used=payload.get("points_used"),
            attribution=source.attribution,
        ),
    )
    return state.with_findings(findings).with_analytics("anomaly", payload)
