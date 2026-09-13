"""What every capability node needs: a tool call that records itself, and result parsing.

**A tool call is not just a call.** ``specs/agent-orchestration`` requires the evidence record to
carry every tool call with its arguments, every result, and per-step timings — sufficient for a
reader to check a figure without re-running the question. Recording that at each call site would be
four chances to forget a field, so ``call_tool`` does the call *and* the recording, and returns the
state with both in it.

**A failed tool is a recorded outcome, not an exception.** ``McpToolClient.call`` already returns a
failure rather than raising, and ``ToolResult`` refuses to carry weather values alongside an error.
Between them a failed call cannot be presented as data — which is the property ``specs/
weather-providers`` and ``specs/safety-grounding`` both ask for, from opposite directions.

**Parsing is defensive about nulls, not about shape.** A tool's contract is fixed and validated at
its own boundary, so a missing ``attribution`` here is a bug worth raising over. A *null value*
inside a series is different: it is normal, it means "not reported", and it must never become a
zero.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from weathra.agents.state import GraphState, Retrieval
from weathra.domain.errors import WeathraError
from weathra.domain.evidence import (
    AgentName,
    AgentStep,
    Attribution,
    Finding,
    StepStatus,
    ToolCall,
    ToolResult,
)
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, Series, UnitSystem
from weathra.mcp.client import McpToolClient, ToolCallOutcome
from weathra.mcp.schemas import location_from_payload, period_from_payload

__all__ = [
    "ANALYTICS_PROVIDER",
    "analytics_attribution",
    "attribution_from",
    "baseline_for",
    "call_tool",
    "current_label",
    "finding_from_statistic",
    "finding_label",
    "findings_from_current",
    "headline_measure",
    "location_from",
    "measures_in",
    "period_from",
    "points_for",
    "record_step",
    "series_from",
    "window_label",
]

logger = logging.getLogger("weathra.agents.nodes")


async def call_tool(
    state: GraphState,
    client: McpToolClient,
    *,
    agent: AgentName,
    tool: str,
    arguments: dict[str, Any],
) -> tuple[GraphState, ToolCallOutcome]:
    """Call a tool and record the exchange in one step.

    Returns the updated state and the outcome. The caller decides what to do with a failure —
    which for a capability node is usually to record it and let the run continue with a partial
    answer rather than to abandon the question.
    """
    sequence = state.next_sequence
    started = datetime.now(UTC)
    outcome = await client.call(tool, arguments)
    duration = (datetime.now(UTC) - started).total_seconds() * 1000.0

    call = ToolCall(
        sequence=sequence,
        tool=tool,
        agent=agent,
        # Recorded verbatim. Tool arguments are coordinates, dates, and units — a tool that took a
        # credential would put one here, which is one reason no tool takes one.
        arguments=arguments,
        started_at=started,
        duration_ms=max(0.0, duration),
    )

    if outcome.ok:
        attribution = attribution_from(outcome.data) if "attribution" in outcome.data else None
        result = ToolResult(
            sequence=sequence,
            tool=tool,
            ok=True,
            data_class=(
                attribution.data_class
                if attribution
                else DataClass(outcome.data.get("data_class", DataClass.COMPUTED_STATISTIC.value))
            ),
            attribution=attribution,
            payload=outcome.data,
        )
    else:
        logger.info("tool %s failed: %s", tool, outcome.error_code)
        result = ToolResult(
            sequence=sequence,
            tool=tool,
            ok=False,
            error_code=outcome.error_code or "internal_error",
            error_message=outcome.error_message or "The tool reported a failure with no message.",
        )

    return state.with_tool_exchange(call, result), outcome


def record_step(
    state: GraphState,
    *,
    agent: AgentName,
    started_at: datetime,
    status: StepStatus = StepStatus.SUCCEEDED,
    reason: str | None = None,
) -> GraphState:
    """Record one agent's turn, with what it cost."""
    return state.with_step(
        AgentStep(
            sequence=state.next_step_sequence,
            agent=agent,
            status=status,
            started_at=started_at,
            duration_ms=max(0.0, (datetime.now(UTC) - started_at).total_seconds() * 1000.0),
            reason=reason,
        )
    )


def failure_reason(error: WeathraError) -> str:
    """A step's failure reason, carrying the coded condition rather than a stack trace."""
    return f"{error.code}: {error}"


# =========================================================================== labels

# How a measure reads in a sentence. Only the ones whose column name is not already English are
# here; anything absent falls through to its name with the underscores removed.
_MEASURE_WORDS: dict[str, str] = {
    "temperature_max": "daily high temperature",
    "temperature_min": "daily low temperature",
    "temperature_mean": "mean daily temperature",
    "apparent_temperature_max": "daily high apparent temperature",
    "apparent_temperature_min": "daily low apparent temperature",
    "precipitation_sum": "precipitation",
    "wind_speed_max": "peak wind speed",
    "wind_gusts_max": "peak wind gust",
    "relative_humidity": "relative humidity",
    "uv_index_max": "peak UV index",
}

# How a statistic reads. The measure goes in the placeholder, so "minimum" over the daily low
# becomes "Lowest daily low temperature" rather than "Minimum temperature min".
_STATISTIC_PHRASES: dict[str, str] = {
    "minimum": "Lowest {measure}",
    "maximum": "Highest {measure}",
    "mean": "Average {measure}",
    "median": "Median {measure}",
    "range": "{measure} range",
    "total": "Total {measure}",
    "standard_deviation": "{measure} variability (standard deviation)",
    "percentile": "{measure} percentile",
    "rolling_mean": "Rolling average {measure}",
    "trend": "{measure} trend",
}


def finding_label(statistic: str | None, measure: str | None) -> str:
    """A finding's label, in words a person reads rather than column names.

    Written out rather than assembled from the raw names because these labels are what the UI
    shows *and* what the synthesis prompt hands the model: "Minimum temperature min" is the kind
    of phrase a model rewrites into something wrong.
    """
    words = _MEASURE_WORDS.get(measure or "", (measure or "value").replace("_", " "))
    phrase = _STATISTIC_PHRASES.get(statistic or "")

    if phrase is None:
        readable = (statistic or "value").replace("_", " ")
        return f"{readable.capitalize()} {words}".strip()

    label = phrase.format(measure=words)
    return label[0].upper() + label[1:]


# How many points of a series-valued statistic are rendered into its text value. Enough for a week
# of daily figures; a longer series is truncated rather than turning one finding into a wall.
_SERIES_PREVIEW = 10


def finding_from_statistic(
    reported: dict[str, Any], attribution: Attribution, *, data_class: DataClass | None = None
) -> Finding:
    """One of a tool's reported statistics as an evidence-record finding.

    Three shapes, because a statistic has three honest outcomes:

    * a **scalar** — a mean, a maximum — which is the ordinary case;
    * a **series** — daily totals, a rolling mean — which is computed and has no single value, so
      it becomes a ``text_value`` listing the points. A ``Finding`` is "one value the answer rests
      on", and pretending a week of totals is one number would be the wrong kind of tidy;
    * **unavailable** — which keeps the reason the tool gave. The fallback wording exists so
      ``Finding``'s own invariant can never be the thing that fails a run.
    """
    computed = reported.get("status") == "computed"
    value = reported.get("value") if computed else None
    series = reported.get("values") if computed else None

    return Finding(
        label=finding_label(reported.get("statistic"), reported.get("measure")),
        value=value,
        text_value=_render_series(series) if value is None and series else None,
        unit=reported.get("unit"),
        data_class=data_class or attribution.data_class,
        method=reported.get("method"),
        points_used=reported.get("points_used"),
        attribution=attribution,
        unavailable_reason=(
            None
            if computed
            else reported.get("reason")
            or reported.get("note")
            or "The tool reported this statistic as unavailable without stating a reason."
        ),
    )


# =========================================================================== current conditions

# How each instantaneous measure reads as a reading rather than as a column name. Only the ones
# whose own name is not already what a person would write are here; anything else falls through to
# its name with the underscores taken out.
#
# Deliberately *not* "Temperature now" or "Observed temperature". `weather_current` returns the
# provider's own current-weather values, which for Open-Meteo are analysis output rather than a
# reading off an instrument at the location — see the note on ``findings_from_current``. The label
# names the measure; the panel it renders in and the attribution beneath it say what kind of value
# it is and who supplied it.
_CURRENT_LABELS: dict[str, str] = {
    "temperature": "Temperature",
    "apparent_temperature": "Feels like",
    "relative_humidity": "Humidity",
    "wind_speed": "Wind speed",
    "wind_gust": "Wind gust",
    "wind_direction": "Wind direction",
    "precipitation": "Precipitation",
    "precipitation_probability": "Chance of precipitation",
    "surface_pressure": "Pressure",
    "cloud_cover": "Cloud cover",
    "dew_point": "Dew point",
    "uv_index": "UV index",
    "weather_code": "Condition",
}


def current_label(measure: str) -> str:
    """What one current-conditions measure is called on screen."""
    known = _CURRENT_LABELS.get(measure)
    if known is not None:
        return known
    words = measure.replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else "Value"


def findings_from_current(payload: dict[str, Any], attribution: Attribution) -> tuple[Finding, ...]:
    """The current-conditions tool's reported values, as evidence-record findings.

    **This transcribes; it does not compute, and it does not fill in.** ``weather_current`` returns
    two maps — a value per measure and a unit per measure — because a current reading *is* the
    figure, so unlike the forecast tool it has no statistic to hand back and unlike the archive it
    has no series for the analytics layer to summarize. Pairing each value with its declared unit
    and its name is the whole of the work, and it is the same recording the other nodes do; no
    figure here was derived from another.

    **A measure the provider did not supply becomes no finding at all.** The forecast panel states
    an unavailable statistic *as* unavailable, because a statistic that was asked for and could not
    be computed is a fact about the window. Current conditions are different: the provider returns
    the measures it has for that location, and a row reading "Cloud cover — not reported" beside
    four real readings describes the provider's field list rather than the weather. Null is absence,
    never zero, and absence here is silence.

    **The condition is carried as the provider's code, not as a description.** Open-Meteo publishes
    WMO 4677; turning 3 into "Overcast" is a translation, and `lib/weather/condition.ts` is where
    that translation lives for the whole product. Inventing a second vocabulary here would let the
    same code be described two ways on two screens, which is the thing that file exists to prevent.
    """
    values = payload.get("values")
    units = payload.get("units")
    if not isinstance(values, dict):
        return ()
    declared = units if isinstance(units, dict) else {}

    findings: list[Finding] = []
    for measure, value in values.items():
        if not isinstance(measure, str) or not isinstance(value, int | float):
            continue
        unit = declared.get(measure)
        findings.append(
            Finding(
                label=current_label(measure),
                value=float(value),
                unit=unit if isinstance(unit, str) and unit else None,
                data_class=DataClass.CURRENT,
                attribution=attribution,
            )
        )
    return tuple(findings)


def _render_series(points: Any) -> str | None:
    """A series-valued statistic's points as readable text, truncated with a count.

    Nulls are rendered as "not reported" rather than skipped or zeroed: a gap in a week of daily
    totals is a fact about the week.
    """
    if not isinstance(points, list) or not points:
        return None

    rendered: list[str] = []
    for point in points[:_SERIES_PREVIEW]:
        value = point.get("value") if isinstance(point, dict) else point
        rendered.append("not reported" if value is None else f"{float(value):g}")

    if len(points) > _SERIES_PREVIEW:
        rendered.append(f"and {len(points) - _SERIES_PREVIEW} more")
    return ", ".join(rendered)


# =========================================================================== result parsing


def location_from(payload: dict[str, Any]) -> Location:
    """The location out of a tool's attribution block."""
    return location_from_payload(payload.get("attribution") or payload)


def period_from(payload: dict[str, Any]) -> Period | None:
    """The period out of a tool's attribution or top-level block, if it reported one."""
    return period_from_payload(payload.get("attribution") or payload)


def attribution_from(payload: dict[str, Any]) -> Attribution:
    """A tool's attribution block as the evidence record's own type.

    Goes through the tool schemas' own conversions rather than validating the block directly: the
    tool reports a location's derived ``identifier`` for a caller's convenience, and ``Location``
    rightly refuses to accept one as an input.

    Raises rather than defaulting if the block is missing a field: a result that cannot say where
    it came from must not enter the record wearing a plausible-looking blank.
    """
    block = payload["attribution"]
    return Attribution(
        provider=block["provider"],
        location=location_from_payload(block),
        data_class=DataClass(block["data_class"]),
        period=period_from_payload(block),
        timestamp_utc=block.get("timestamp_utc"),
        retrieved_at=block["retrieved_at"],
    )


ANALYTICS_PROVIDER = "weathra-analytics"
"""Who computed a derived figure. Weathra's own kernel, named as itself.

Not a weather provider and never presented as one: Open-Meteo supplied the series, and the mean
over it came from here. Crediting a computed statistic to the provider of its inputs would put a
figure no provider published under that provider's name.
"""


def analytics_attribution(
    source: Retrieval, *, computed_at: datetime, inputs: Sequence[Attribution] = ()
) -> Attribution | None:
    """The source row for the arithmetic, or None when the input carries no window to stand on.

    **Why a row of its own.** A run that retrieved three windows and computed a mean, a range and a
    difference over them showed three grounded sources, all of them external, and nothing at all
    saying where the computed figures came from — so the one class of figure a reader is most
    likely to challenge was the one class with no row to challenge. The statistics carry their
    method and point count in the tool payload already; what was missing was the *source*, beside
    the retrievals it was computed from.

    ``derived_from`` is the lineage: the retrieved sources this was computed over, so the row can
    be followed back to the rows above it rather than standing on its own authority.
    """
    if source.period is None:
        return None

    lineage: list[str] = []
    for attribution in inputs:
        name = f"{attribution.provider} {attribution.data_class.value}"
        if name not in lineage:
            lineage.append(name)

    return Attribution(
        provider=ANALYTICS_PROVIDER,
        location=source.location,
        data_class=DataClass.COMPUTED_STATISTIC,
        period=source.period,
        retrieved_at=computed_at,
        derived_from=tuple(lineage),
    )


# The measure an unqualified statistic question is about, in the order a person would ask. The
# daily high first: "how warm was it?" means the high, not the mean of highs and lows.
_HEADLINE_ORDER = (
    Measure.TEMPERATURE_MAX,
    Measure.TEMPERATURE,
    Measure.TEMPERATURE_MIN,
    Measure.PRECIPITATION,
    Measure.WIND_SPEED,
)


def baseline_for(state: GraphState, source: Retrieval, measure: Measure) -> Retrieval | None:
    """An earlier retrieval of the same measure over a *different* window, or None.

    The most recent qualifying one, because a run that retrieved three windows is comparing the
    latest against the one before it. A retrieval over the same period is the same window read
    twice and is not a comparison; a retrieval carrying no period cannot be shown to be a different
    window and is not treated as one.
    """
    if source.period is None:
        return None

    for retrieval in reversed(state.retrievals):
        if retrieval is source or retrieval.period is None:
            continue
        if retrieval.period.start_utc == source.period.start_utc:
            continue
        series = retrieval.series
        if series is None or measure not in measures_in(series):
            continue
        return retrieval
    return None


def window_label(retrieval: Retrieval) -> str:
    """What a comparison's other window is, in the words a difference's parameters carry."""
    period = retrieval.period
    if period is None:  # pragma: no cover - callers check first
        return retrieval.location.qualified_name
    return (
        f"{retrieval.location.qualified_name}, "
        f"{period.start_local.date().isoformat()} to {period.end_local.date().isoformat()}"
    )


def measures_in(series: Series) -> set[Measure]:
    """Every measure at least one entry of the series actually reports a value for."""
    found: set[Measure] = set()
    for entry in series.entries:
        for measure, value in entry.values.items():
            if value is not None:
                found.add(measure)
    return found


def headline_measure(retrieval: Any) -> Measure | None:
    """The measure a statistic over this retrieval should be about, absent a request."""
    series = retrieval.series
    if series is None:
        return None
    available = measures_in(series)
    for candidate in _HEADLINE_ORDER:
        if candidate in available:
            return candidate
    return next(iter(available), None)


def points_for(retrieval: Any, measure: Measure) -> tuple[list[dict[str, Any]], str]:
    """One measure of a retrieval's series, as the analytics tools take it, and its unit.

    Nulls travel through as nulls. The tools exclude and count them; dropping them here would make
    the point count wrong and hide that a day was missing.
    """
    series = retrieval.series
    if series is None:
        return [], ""

    points = [
        {"time_utc": entry.time_utc.isoformat(), "value": entry.values.get(measure)}
        for entry in series.entries
    ]
    if not any(point["value"] is not None for point in points):
        return [], ""

    return points, series.units.get(measure, "")


def series_from(payload: dict[str, Any], key: str) -> Series | None:
    """One of a tool result's series, or ``None`` when the tool did not report it."""
    block = payload.get(key)
    return Series.model_validate(block) if block else None


def unit_system_from(
    payload: dict[str, Any], default: UnitSystem = UnitSystem.METRIC
) -> UnitSystem:
    attribution = payload.get("attribution") or {}
    reported = attribution.get("units") or payload.get("units")
    return UnitSystem(reported) if isinstance(reported, str) else default
