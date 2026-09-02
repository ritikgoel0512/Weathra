"""The Forecast Agent's capability, as a service the graph, the MCP tools, and the API all share.

This layer **composes and labels; it does not calculate.** Every figure in a
``ForecastAnalysis`` came out of ``analytics/``, carrying its own method and point count, so the
analysis is reproducible from the same series and every number in it is checkable
(``specs/forecast-analysis``).

Two properties worth calling out:

* **Determinism.** ``analyse`` takes a retrieved ``Forecast`` and returns the same analysis every
  time. Nothing in it reads a clock: the uncertainty statement anchors on the forecast's own
  ``retrieved_at``, so the analysis of a cached forecast equals the analysis of the live one.
* **No language model, ever.** ``summarize`` writes prose by formatting computed values, which is
  what keeps a plain-language summary available with no inference credential configured. The
  agent's prose is a *separate*, clearly-labelled thing.
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field

from weathra.analytics import descriptive, precipitation, wind
from weathra.analytics.anomaly import detect_anomalies
from weathra.analytics.support import require_usable
from weathra.analytics.trend import analyse_trend
from weathra.config import Settings
from weathra.domain.analytics import (
    AnomalyReport,
    Provenance,
    Statistic,
    StatisticResult,
    TrendReport,
)
from weathra.domain.errors import AnalyticsNotPossible
from weathra.domain.location import Location
from weathra.domain.weather import (
    CurrentConditions,
    DataClass,
    Forecast,
    Granularity,
    Measure,
    Period,
    UncertaintyStatement,
    UnitSystem,
)
from weathra.geocoding.base import Geocoder
from weathra.providers.base import WeatherProvider
from weathra.providers.validation import resolve_horizon
from weathra.weather.thresholds import ThresholdCondition, ThresholdReport, find_crossings
from weathra.weather.uncertainty import describe_uncertainty, qualify
from weathra.weather.windows import forecast_window

__all__ = ["ForecastAnalysis", "ForecastService", "analyse", "summarize"]


def _day_and_month(moment: datetime) -> str:
    """`2 March`. Built by hand because `%-d` is a glibc extension rather than portable."""
    return f"{moment.day} {moment.strftime('%B')}"


def _weekday_day_month(moment: datetime) -> str:
    """`Mon 2 March`."""
    return f"{moment.strftime('%a')} {moment.day} {moment.strftime('%B')}"


class ForecastAnalysis(BaseModel):
    """A composed, self-describing analysis of one forecast window."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    period: Period
    provider: str = Field(min_length=1)
    unit_system: UnitSystem
    data_class: DataClass = DataClass.FORECAST
    horizon_days: int = Field(ge=1)
    from_cache: bool = False

    findings: tuple[StatisticResult, ...] = Field(
        description="Every computed figure, each with its method, unit, and point count."
    )
    anomalies: AnomalyReport | None = None
    trend: TrendReport | None = None
    thresholds: tuple[ThresholdReport, ...] = ()
    uncertainty: UncertaintyStatement
    summary: str = Field(min_length=1, description="Written by code, from the findings only.")

    def finding(self, statistic: Statistic, measure: Measure) -> StatisticResult | None:
        for result in self.findings:
            if result.statistic is statistic and result.measure is measure:
                return result
        return None

    @property
    def computed_findings(self) -> tuple[StatisticResult, ...]:
        return tuple(result for result in self.findings if result.computed)

    @property
    def unavailable_findings(self) -> tuple[StatisticResult, ...]:
        return tuple(result for result in self.findings if not result.computed)


def provenance_for(forecast: Forecast) -> Provenance:
    """The provenance every statistic computed from this forecast carries."""
    return Provenance(
        location=forecast.location,
        period=forecast.period,
        provider=forecast.provider,
        unit_system=forecast.unit_system,
        source_data_class=DataClass.FORECAST,
        retrieved_at=forecast.retrieved_at,
    )


def analyse(
    forecast: Forecast,
    *,
    conditions: tuple[ThresholdCondition, ...] = (),
    trend_measure: Measure = Measure.TEMPERATURE_MAX,
    anomaly_measure: Measure = Measure.TEMPERATURE_MAX,
) -> ForecastAnalysis:
    """Compose an analysis from a retrieved forecast. Pure: same forecast, same analysis."""
    require_usable(forecast.daily, what="the retrieved daily forecast")
    provenance = provenance_for(forecast)
    daily = forecast.daily

    findings: list[StatisticResult] = []

    # Temperature: the extremes and the mean of the daily maxima and minima.
    findings.extend(descriptive.describe(daily, Measure.TEMPERATURE_MAX, provenance))
    findings.append(descriptive.minimum(daily, Measure.TEMPERATURE_MIN, provenance))
    findings.append(descriptive.mean(daily, Measure.TEMPERATURE_MEAN, provenance))

    # Precipitation: the window total, the per-day totals, the wet-day count, and probability —
    # which comes back unavailable rather than inferred when the provider supplies none.
    findings.append(precipitation.total(daily, provenance))
    findings.append(
        precipitation.daily_totals(daily, provenance, measure=Measure.PRECIPITATION_SUM)
    )
    findings.append(precipitation.wet_entry_count(daily, provenance))
    findings.extend(
        precipitation.probability_analysis(
            daily, provenance, measure=Measure.PRECIPITATION_PROBABILITY_MAX
        )
    )

    # Wind: speed, gust with its timestamp, and the prevailing sector.
    findings.extend(
        wind.wind_statistics(
            daily,
            provenance,
            speed=Measure.WIND_SPEED_MAX,
            gust=Measure.WIND_GUST_MAX,
            direction=Measure.WIND_DIRECTION_DOMINANT,
        )
    )

    # Humidity and pressure come from the hourly series: Open-Meteo's daily block carries neither,
    # and computing a daily mean here would be this layer calculating, which it must not do.
    if len(forecast.hourly):
        hourly_provenance = provenance
        findings.extend(wind.humidity_statistics(forecast.hourly, hourly_provenance))
        findings.extend(wind.pressure_statistics(forecast.hourly, hourly_provenance))

    anomalies = detect_anomalies(daily, anomaly_measure, provenance)

    trend: TrendReport | None
    try:
        trend = analyse_trend(daily, trend_measure, provenance)
    except AnalyticsNotPossible:
        # Too short a window for a trend is a missing finding, not a failed analysis.
        trend = None

    thresholds = tuple(
        find_crossings(daily, condition, provenance, data_class=DataClass.FORECAST)
        for condition in conditions
    )

    uncertainty = describe_uncertainty(forecast)

    return ForecastAnalysis(
        location=forecast.location,
        period=forecast.period,
        provider=forecast.provider,
        unit_system=forecast.unit_system,
        horizon_days=forecast.horizon_days,
        from_cache=forecast.from_cache,
        findings=tuple(findings),
        anomalies=anomalies,
        trend=trend,
        thresholds=thresholds,
        uncertainty=uncertainty,
        summary=summarize(
            location=forecast.location,
            period=forecast.period,
            provider=forecast.provider,
            findings=tuple(findings),
            anomalies=anomalies,
            trend=trend,
            thresholds=thresholds,
            uncertainty=uncertainty,
        ),
    )


def summarize(
    *,
    location: Location,
    period: Period,
    provider: str,
    findings: tuple[StatisticResult, ...],
    anomalies: AnomalyReport | None,
    trend: TrendReport | None,
    thresholds: tuple[ThresholdReport, ...],
    uncertainty: UncertaintyStatement,
) -> str:
    """A plain-language summary, written by code from the findings alone.

    Every figure in the returned text came from a ``StatisticResult`` in ``findings``, so the
    numeric audit can match all of it. Nothing here needs a language model, which is what makes a
    summary available when no inference credential is configured at all.
    """
    lookup = {(result.statistic, result.measure): result for result in findings if result.computed}

    def value_of(statistic: Statistic, measure: Measure) -> StatisticResult | None:
        return lookup.get((statistic, measure))

    start = _day_and_month(period.start_local)
    end = _day_and_month(period.end_local)
    sentences = [f"{location.qualified_name}, {start} to {end}, from {provider}."]

    high = value_of(Statistic.MAXIMUM, Measure.TEMPERATURE_MAX)
    low = value_of(Statistic.MINIMUM, Measure.TEMPERATURE_MIN) or value_of(
        Statistic.MINIMUM, Measure.TEMPERATURE_MAX
    )
    if high and low and high.value is not None and low.value is not None:
        sentences.append(
            f"Daily highs reach {high.value:g} {high.unit} and lows fall to "
            f"{low.value:g} {low.unit}."
        )
    elif high and high.value is not None:
        sentences.append(f"Daily highs reach {high.value:g} {high.unit}.")

    rain = value_of(Statistic.TOTAL, Measure.PRECIPITATION_SUM)
    wet = value_of(Statistic.WET_ENTRY_COUNT, Measure.PRECIPITATION_SUM)
    if rain and rain.value is not None:
        clause = f"{rain.value:g} {rain.unit} of precipitation is forecast in total"
        if wet and wet.value is not None:
            clause += f", across {wet.value:g} day(s) with measurable rain"
        sentences.append(clause + ".")

    gust = value_of(Statistic.MAXIMUM_GUST, Measure.WIND_GUST_MAX)
    if gust and gust.value is not None:
        when = (
            f" on {_weekday_day_month(gust.occurred_at_local)}"
            if gust.occurred_at_local is not None
            else ""
        )
        sentences.append(f"The strongest gust is {gust.value:g} {gust.unit}{when}.")

    if trend is not None:
        sentences.append(
            f"{trend.measure.value.replace('_', ' ').capitalize()} is "
            f"{trend.direction.value} across the window "
            f"({trend.slope_per_day:+.2f} {trend.unit}/day, {trend.method})."
        )

    if anomalies is not None and anomalies.found_any:
        standouts = ", ".join(
            f"{_weekday_day_month(point.time_local)} at {point.value:g} {anomalies.unit}"
            for point in anomalies.anomalies
        )
        sentences.append(f"Standing out against the rest of the window: {standouts}.")
    elif anomalies is not None:
        sentences.append("No day stands out materially against the rest of the window.")

    for report in thresholds:
        sentences.append(report.statement)

    unavailable = [
        result.measure.value for result in findings if not result.computed and result.reason
    ]
    if unavailable:
        sentences.append(
            "Not available for this window: " + ", ".join(sorted(set(unavailable))) + "."
        )

    if uncertainty.horizon:
        furthest = max(point.hours_ahead for point in uncertainty.horizon)
        sentences.append(f"The furthest figure is {qualify(furthest)}.")
    sentences.append(uncertainty.basis)

    return " ".join(sentences)


class ForecastService:
    """Retrieval plus analysis, for the callers that need both.

    The one clock read on this path lives here, in ``now``, so ``analyse`` stays pure and every
    window is resolved from the location's own calendar rather than the server's.
    """

    def __init__(
        self,
        *,
        provider: WeatherProvider,
        geocoder: Geocoder,
        settings: Settings,
        now: datetime | None = None,
    ) -> None:
        self._provider = provider
        self._geocoder = geocoder
        self._settings = settings
        self._now = now

    def _instant(self) -> datetime:
        return self._now or datetime.now(UTC)

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        """Current conditions, labelled ``current`` and never as a forecast."""
        return await self._provider.current(location, unit_system=unit_system)

    async def forecast(
        self,
        location: Location,
        *,
        days: int | None = None,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> Forecast:
        """A validated-horizon forecast. An over-long horizon is refused, never truncated."""
        horizon = resolve_horizon(self._provider.capabilities(), self._settings, days)
        return await self._provider.forecast(location, days=horizon, unit_system=unit_system)

    async def analyse(
        self,
        location: Location,
        *,
        days: int | None = None,
        unit_system: UnitSystem = UnitSystem.METRIC,
        conditions: tuple[ThresholdCondition, ...] = (),
    ) -> ForecastAnalysis:
        retrieved = await self.forecast(location, days=days, unit_system=unit_system)
        return analyse(retrieved, conditions=conditions)

    def window(self, location: Location, days: int) -> Period:
        """The window a request for ``days`` resolves to at this location."""
        return forecast_window(location, self._instant(), days)

    @staticmethod
    def granularities() -> tuple[Granularity, ...]:
        return (Granularity.HOURLY, Granularity.DAILY)
