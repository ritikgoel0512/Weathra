"""Builders for domain objects used across the suite.

Every helper is deterministic and offline: no clock reads that matter, no network, no database.
Timestamps are explicit so a test asserting on a window never depends on when it ran.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from weathra.domain.analytics import PointValue, Provenance, Statistic, StatisticResult
from weathra.domain.evidence import (
    AgentName,
    AgentStep,
    Attribution,
    EvidenceRecord,
    Finding,
    GroundingReport,
    KnowledgeCitation,
    StepStatus,
    ToolCall,
    ToolResult,
)
from weathra.domain.location import Location
from weathra.domain.weather import (
    CurrentConditions,
    DataClass,
    Forecast,
    Granularity,
    HistoricalObservations,
    Measure,
    Period,
    Series,
    SeriesEntry,
    UnitSystem,
    units_map,
)

BERLIN = Location(
    display_name="Berlin",
    latitude=52.52,
    longitude=13.41,
    timezone="Europe/Berlin",
    region="Berlin",
    country="Germany",
    country_code="DE",
    elevation_metres=74.0,
)

MUNICH = Location(
    display_name="Munich",
    latitude=48.14,
    longitude=11.58,
    timezone="Europe/Berlin",
    region="Bavaria",
    country="Germany",
    country_code="DE",
)

REYKJAVIK = Location(
    display_name="Reykjavík",
    latitude=64.15,
    longitude=-21.94,
    timezone="Atlantic/Reykjavik",
    country="Iceland",
    country_code="IS",
)

LISBON = Location(
    display_name="Lisbon",
    latitude=38.72,
    longitude=-9.14,
    timezone="Europe/Lisbon",
    country="Portugal",
    country_code="PT",
)

RETRIEVED_AT = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def period(start: datetime, end: datetime, *, timezone: str = "Europe/Berlin") -> Period:
    """A period from two UTC instants, with its local bounds resolved in ``timezone``."""
    zone = ZoneInfo(timezone)
    return Period(
        start_utc=start.astimezone(UTC),
        end_utc=end.astimezone(UTC),
        start_local=start.astimezone(zone),
        end_local=end.astimezone(zone),
        timezone=timezone,
    )


def daily_period(start: datetime, days: int, *, timezone: str = "Europe/Berlin") -> Period:
    return period(start, start + timedelta(days=days), timezone=timezone)


def series(
    values_by_measure: Mapping[Measure, Sequence[float | None]],
    *,
    granularity: Granularity = Granularity.DAILY,
    start: datetime = datetime(2026, 3, 2, 0, 0, tzinfo=UTC),
    timezone: str = "Europe/Berlin",
    unit_system: UnitSystem = UnitSystem.METRIC,
    step: timedelta | None = None,
) -> Series:
    """A series from parallel value sequences, one entry per position.

    ``None`` in a sequence means the provider did not supply that measure at that point — the
    absent case every analytics function has to exclude rather than treat as zero.
    """
    lengths = {len(sequence) for sequence in values_by_measure.values()}
    if len(lengths) > 1:
        raise ValueError(f"value sequences must be the same length; got {sorted(lengths)}")
    count = lengths.pop() if lengths else 0
    increment = step or (
        timedelta(days=1) if granularity is Granularity.DAILY else timedelta(hours=1)
    )
    zone = ZoneInfo(timezone)

    entries = []
    for index in range(count):
        moment = start + increment * index
        entries.append(
            SeriesEntry(
                time_utc=moment.astimezone(UTC),
                time_local=moment.astimezone(zone),
                values={
                    measure: sequence[index] for measure, sequence in values_by_measure.items()
                },
            )
        )

    return Series(
        granularity=granularity,
        units=units_map(tuple(values_by_measure), unit_system),
        entries=tuple(entries),
    )


def current_conditions(
    values: Mapping[Measure, float | None],
    *,
    location: Location = BERLIN,
    provider: str = "open-meteo",
    unit_system: UnitSystem = UnitSystem.METRIC,
    observed_at: datetime = datetime(2026, 3, 1, 11, 0, tzinfo=UTC),
    retrieved_at: datetime = RETRIEVED_AT,
    from_cache: bool = False,
) -> CurrentConditions:
    return CurrentConditions(
        location=location,
        provider=provider,
        unit_system=unit_system,
        retrieved_at=retrieved_at,
        from_cache=from_cache,
        observed_at_utc=observed_at.astimezone(UTC),
        observed_at_local=observed_at.astimezone(location.zoneinfo),
        units=units_map(tuple(values), unit_system),
        values=dict(values),
    )


def forecast(
    *,
    hourly: Series | None = None,
    daily: Series | None = None,
    location: Location = BERLIN,
    provider: str = "open-meteo",
    unit_system: UnitSystem = UnitSystem.METRIC,
    start: datetime = datetime(2026, 3, 2, 0, 0, tzinfo=UTC),
    horizon_days: int = 7,
    retrieved_at: datetime = RETRIEVED_AT,
    from_cache: bool = False,
) -> Forecast:
    hourly_series = (
        hourly
        if hourly is not None
        else Series(
            granularity=Granularity.HOURLY, units=units_map((Measure.TEMPERATURE,), unit_system)
        )
    )
    daily_series = (
        daily
        if daily is not None
        else Series(
            granularity=Granularity.DAILY, units=units_map((Measure.TEMPERATURE_MAX,), unit_system)
        )
    )
    return Forecast(
        location=location,
        provider=provider,
        unit_system=unit_system,
        retrieved_at=retrieved_at,
        from_cache=from_cache,
        period=daily_period(start, horizon_days, timezone=location.timezone),
        horizon_days=horizon_days,
        hourly=hourly_series,
        daily=daily_series,
    )


def historical(
    *,
    daily: Series,
    hourly: Series | None = None,
    location: Location = BERLIN,
    provider: str = "open-meteo",
    unit_system: UnitSystem = UnitSystem.METRIC,
    requested: Period | None = None,
    covered: Period | None = None,
    unavailable_note: str | None = None,
    retrieved_at: datetime = RETRIEVED_AT,
    from_cache: bool = False,
) -> HistoricalObservations:
    requested_period = requested or daily_period(
        datetime(2026, 2, 1, 0, 0, tzinfo=UTC), 28, timezone=location.timezone
    )
    return HistoricalObservations(
        location=location,
        provider=provider,
        unit_system=unit_system,
        retrieved_at=retrieved_at,
        from_cache=from_cache,
        requested_period=requested_period,
        covered_period=covered or requested_period,
        hourly=hourly,
        daily=daily,
        unavailable_note=unavailable_note,
    )


# --------------------------------------------------------------------------- analytics


def provenance(
    *,
    location: Location = BERLIN,
    window: Period | None = None,
    provider: str = "open-meteo",
    unit_system: UnitSystem = UnitSystem.METRIC,
    source_data_class: DataClass = DataClass.FORECAST,
    retrieved_at: datetime = RETRIEVED_AT,
) -> Provenance:
    return Provenance(
        location=location,
        period=window
        or daily_period(datetime(2026, 3, 2, tzinfo=UTC), 7, timezone=location.timezone),
        provider=provider,
        unit_system=unit_system,
        source_data_class=source_data_class,
        retrieved_at=retrieved_at,
    )


def statistic_result(
    *,
    statistic: Statistic = Statistic.MEAN,
    measure: Measure = Measure.TEMPERATURE_MAX,
    value: float | None = 12.5,
    unit: str = "°C",
    method: str = "arithmetic mean of usable points",
    points_used: int = 7,
    points_excluded: int = 0,
    minimum_points: int = 1,
    occurred_at: datetime | None = None,
    tied: bool = False,
    tied_at: tuple[datetime, ...] = (),
    parameters: dict[str, object] | None = None,
    status: Literal["computed", "not_computable"] = "computed",
    reason: str | None = None,
    values: tuple[PointValue, ...] | None = None,
    prov: Provenance | None = None,
) -> StatisticResult:
    return StatisticResult(
        statistic=statistic,
        measure=measure,
        status=status,
        value=value,
        values=values,
        unit=unit,
        occurred_at_utc=occurred_at.astimezone(UTC) if occurred_at else None,
        occurred_at_local=occurred_at.astimezone(BERLIN.zoneinfo) if occurred_at else None,
        tied=tied,
        tied_at=tied_at,
        method=method,
        parameters=parameters or {},
        points_used=points_used,
        points_excluded=points_excluded,
        minimum_points=minimum_points,
        reason=reason,
        provenance=prov or provenance(),
    )


def attribution(
    *,
    provider: str = "open-meteo",
    location: Location = BERLIN,
    data_class: DataClass = DataClass.FORECAST,
    window: Period | None = None,
    timestamp: datetime | None = None,
    retrieved_at: datetime = RETRIEVED_AT,
) -> Attribution:
    if window is None and timestamp is None:
        window = daily_period(datetime(2026, 3, 2, tzinfo=UTC), 7, timezone=location.timezone)
    return Attribution(
        provider=provider,
        location=location,
        data_class=data_class,
        period=window,
        timestamp_utc=timestamp,
        retrieved_at=retrieved_at,
    )


def finding(
    *,
    label: str = "Mean daily maximum temperature",
    value: float | None = 12.5,
    unit: str | None = "°C",
    data_class: DataClass = DataClass.COMPUTED_STATISTIC,
    method: str | None = "arithmetic mean of usable points",
    points_used: int | None = 7,
    unavailable_reason: str | None = None,
    supporting: StatisticResult | None = None,
    attrib: Attribution | None = None,
) -> Finding:
    return Finding(
        label=label,
        value=value,
        unit=unit,
        data_class=data_class,
        method=method,
        points_used=points_used,
        attribution=attrib or attribution(),
        unavailable_reason=unavailable_reason,
        supporting=supporting,
    )


def evidence_record(
    *,
    request_id: str = "req-1",
    question: str = "How warm will next week be in Berlin?",
    agents: tuple[AgentStep, ...] | None = None,
    tool_calls: tuple[ToolCall, ...] = (),
    tool_results: tuple[ToolResult, ...] = (),
    analytics_results: tuple[StatisticResult, ...] = (),
    citations: tuple[KnowledgeCitation, ...] = (),
    attributions: tuple[Attribution, ...] = (),
    llm_provider: str | None = "openrouter",
    llm_model: str | None = "nvidia/nemotron-nano-9b-v2:free",
    partial: bool = False,
    partial_reason: str | None = None,
    thread_id: str | None = None,
) -> EvidenceRecord:
    started = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    return EvidenceRecord(
        request_id=request_id,
        thread_id=thread_id,
        question=question,
        routing_reason="The question asks about a future window at a named location.",
        agents=agents
        if agents is not None
        else (
            AgentStep(
                sequence=1,
                agent=AgentName.SUPERVISOR,
                status=StepStatus.SUCCEEDED,
                started_at=started,
                duration_ms=41.0,
                reason="Routed to the Forecast Agent.",
            ),
        ),
        tool_calls=tool_calls,
        tool_results=tool_results,
        analytics_results=analytics_results,
        citations=citations,
        attributions=attributions,
        data_classes=(DataClass.FORECAST,),
        llm_provider=llm_provider,
        llm_model=llm_model,
        started_at=started,
        completed_at=started + timedelta(milliseconds=1_200),
        total_duration_ms=1_200.0,
        steps_used=3,
        partial=partial,
        partial_reason=partial_reason,
    )


def grounding_report(
    *,
    verified: bool = True,
    figures_checked: int = 3,
    ungrounded: tuple[str, ...] = (),
    prose_discarded: bool = False,
    note: str | None = None,
) -> GroundingReport:
    return GroundingReport(
        verified=verified,
        method="numeric extraction matched against findings and evidence within 0.5% tolerance",
        figures_checked=figures_checked,
        ungrounded_figures=ungrounded,
        prose_discarded=prose_discarded,
        note=note,
    )
