"""Travel Intelligence: one trip, one retrieval, every section computed from it.

**Why this exists at all.** Travel Intelligence used to be assembled in the browser out of four
unrelated endpoints — a day ranking, a forecast, a snapshot check and a baseline comparison — each
resolving the same place and each reaching for the same week of weather. That is four round trips
for one question, and it is the shape that made a screen fail with "the weather provider limited
this request" while the data it needed was already in hand.

So the composition moved here. One forecast is retrieved for the destination over the trip's own
window, and *every* section below reads that same series: the hero, the viability index, the metric
row, the daily outlook, the temporal comparison and the synthesis. The archive is the only other
upstream call, and it is made for the historical band alone.

**Nothing here invents a figure.** The viability index is the composite criterion
``specs/deterministic-analytics`` already defines — the same weights, the same normalisation, the
same disclosure — expressed on 0-100 because a traveller reads a score, not a fraction. Every metric
is either a provider value or a statistic computed by the same analytics functions the rest of
Weathra uses. Where a figure cannot be computed it is omitted with its reason, never defaulted.

**A section that fails does not take the trip with it.** The archive, the snapshot history and the
packing rules are each allowed to be unavailable; they report themselves in ``partial_failures`` and
the rest of the response still stands. Only the destination forecast is load-bearing, because
without it there is no trip weather to describe.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

from weathra.analytics import descriptive, precipitation
from weathra.config import Settings
from weathra.domain.analytics import Provenance, StatisticResult
from weathra.domain.comparison import ComponentContribution, Criterion
from weathra.domain.errors import ValidationFailed, WeathraError
from weathra.domain.location import Location
from weathra.domain.weather import (
    DataClass,
    Forecast,
    Measure,
    Period,
    Series,
    SeriesEntry,
    UnitSystem,
)
from weathra.providers.base import WeatherProvider
from weathra.weather.comparison_service import (
    WEIGHTING_DISCLOSURE,
    score_candidate,
)
from weathra.weather.history_service import BaselineComparison
from weathra.weather.snapshots import WhatChanged
from weathra.weather.windows import period_from_local_dates, today_at

__all__ = [
    "MAXIMUM_TRIP_NIGHTS",
    "DailyOutlookEntry",
    "PackingItem",
    "SectionFailure",
    "TravelEvidence",
    "TravelIntelligence",
    "TravelIntelligenceService",
    "TravelMetric",
    "TravelViability",
    "TripWindow",
]

logger = logging.getLogger("weathra.weather.travel")

# A trip longer than the provider's own horizon cannot be answered from a forecast, and a "trip"
# of forty days is a request to describe a season. Bounded here so the refusal names the limit.
MAXIMUM_TRIP_NIGHTS = 16

# Where the qualitative bands sit on the viability scale. Stated as a table rather than as a chain
# of comparisons so the thresholds are a single readable fact, and so the words a traveller sees
# cannot drift apart from the numbers behind them.
_VIABILITY_BANDS: tuple[tuple[float, str], ...] = (
    (75.0, "Excellent"),
    (60.0, "Good"),
    (45.0, "Mixed"),
    (0.0, "Poor"),
)

# The thresholds the deterministic packing rules fire on. Every one of them names the measure and
# the figure it reads, so a recommendation on screen can be traced to a number beside it.
_WET_DAY_MM = 1.0
_HEAVY_RAIN_MM = 10.0
_STRONG_WIND_KMH = 45.0
_COOL_EVENING_C = 12.0
_COLD_C = 4.0
_WARM_C = 25.0
_HIGH_UV = 6.0
# One day, as the step between two adjacent travel windows.
_ONE_DAY = timedelta(days=1)

# WMO codes that describe weather a traveller should be told about rather than merely shown.
_DISRUPTIVE_CODES = frozenset({65, 67, 75, 82, 95, 96, 99})


class TripWindow(BaseModel):
    """The trip as the traveller stated it, resolved to real places and real dates."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    origin: Location | None = Field(
        default=None,
        description=(
            "Where the traveller sets out from, carried as trip context. Weathra holds no "
            "transport data and this does not affect the destination's weather."
        ),
    )
    destination: Location
    start: date
    end: date
    nights: int = Field(ge=0)


class TravelViability(BaseModel):
    """Weathra's own travel-viability index, and the components that produced it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    score: float = Field(ge=0.0, le=100.0, description="0-100. Weathra's own heuristic.")
    state: str = Field(min_length=1, description="Excellent, Good, Mixed or Poor.")
    contributions: tuple[ComponentContribution, ...]
    basis: str = Field(min_length=1)
    disclosure: str = Field(min_length=1, description="Whose heuristic the weights are.")


class TravelMetric(BaseModel):
    """One analytical card: a figure, its unit, and the method that produced it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    value: float | None = Field(default=None, description="Null when it could not be computed.")
    unit: str | None = None
    display: str | None = Field(
        default=None, description="Pre-formatted where a unit is not enough."
    )
    detail: str | None = None
    method: str = Field(min_length=1, description="How the figure was arrived at.")
    data_class: DataClass = DataClass.COMPUTED_STATISTIC
    unavailable_reason: str | None = None


class DailyOutlookEntry(BaseModel):
    """One day of the trip, as the provider reported it and the ranking scored it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    local_date: date
    weekday: str = Field(min_length=1)
    condition_code: int | None = None
    temperature_max: float | None = None
    temperature_min: float | None = None
    apparent_temperature_max: float | None = None
    precipitation_sum: float | None = None
    precipitation_probability_max: float | None = None
    wind_speed_max: float | None = None
    wind_gust_max: float | None = None
    uv_index_max: float | None = None
    viability: float | None = Field(default=None, description="This day's own 0-100 score.")
    rank: int | None = None
    units: dict[str, str] = Field(default_factory=dict)


class PackingItem(BaseModel):
    """One packing recommendation, and the figure that raised it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    item: str = Field(min_length=1)
    tier: str = Field(min_length=1, description="Essential, Recommended or Optional.")
    because: str = Field(min_length=1, description="The figure this was derived from.")


class ComparedWindow(BaseModel):
    """One travel window measured the same way as the trip, for comparison against it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    start: date
    end: date
    label: str = Field(min_length=1)
    selected: bool
    viability: float | None = None
    state: str | None = None
    temperature_mean: float | None = None
    precipitation_sum: float | None = None
    unavailable_reason: str | None = None


class SectionFailure(BaseModel):
    """A section that could not be produced, named with the reason it could not."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    section: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    code: str | None = None


class TravelEvidence(BaseModel):
    """What a reader needs to check the figures: who answered, for where, over what, and when."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    forecast_provider: str = Field(min_length=1)
    forecast_retrieved_at: datetime
    forecast_from_cache: bool
    horizon_days: int
    unit_system: UnitSystem
    destination_resolved_as: str = Field(min_length=1)
    origin_resolved_as: str | None = None
    archive_provider: str | None = None
    archive_years_used: tuple[int, ...] = ()
    data_classes: tuple[DataClass, ...] = ()


class TravelIntelligence(BaseModel):
    """One coherent answer to "is this a good weather window for this trip"."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    trip: TripWindow
    generated_at: datetime
    hero_summary: str = Field(min_length=1)
    hero_state: str = Field(min_length=1)
    viability: TravelViability | None = None
    metrics: tuple[TravelMetric, ...] = ()
    daily_outlook: tuple[DailyOutlookEntry, ...] = ()
    packing_strategy: tuple[PackingItem, ...] = ()
    packing_insight: str | None = None
    temporal_comparison: tuple[ComparedWindow, ...] = ()
    forecast_changes: WhatChanged | None = Field(
        default=None,
        description=(
            "How this forecast has moved since the last earlier snapshot of the same window. "
            "Null where the snapshot history could not be read; a comparison that is simply not "
            "available yet says so in its own `comparison_available`, and is never invented."
        ),
    )
    historical_baseline: BaselineComparison | None = Field(
        default=None,
        description="The trip window against the archive, where the archive could answer.",
    )
    synthesis: str = Field(min_length=1)
    synthesis_data_class: DataClass = DataClass.COMPUTED_STATISTIC
    evidence: TravelEvidence
    partial_failures: tuple[SectionFailure, ...] = ()


def _weekday(day: date) -> str:
    return day.strftime("%a")


def _value(entry: SeriesEntry, measure: Measure) -> float | None:
    found = entry.values.get(measure)
    return float(found) if isinstance(found, (int, float)) else None


def _band(score: float) -> str:
    for threshold, name in _VIABILITY_BANDS:
        if score >= threshold:
            return name
    return _VIABILITY_BANDS[-1][1]


class TravelIntelligenceService:
    """Composes one trip's weather intelligence from a single forecast retrieval."""

    def __init__(
        self,
        *,
        provider: WeatherProvider,
        settings: Settings,
        now: datetime | None = None,
    ) -> None:
        self._provider = provider
        self._settings = settings
        self._now = now

    def _instant(self) -> datetime:
        return self._now or datetime.now(UTC)

    # ------------------------------------------------------------------ retrieval

    async def retrieve(
        self,
        destination: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> Forecast:
        """The one upstream forecast every section below is computed from.

        The horizon is counted from today rather than from the trip's first day, because a
        provider's forecast always begins this morning: asking for ``end - start`` days would stop
        short of the trip whenever it does not begin today.
        """
        today = today_at(destination, self._instant())
        if end < start:
            raise ValidationFailed(
                "A trip ends on or after the day it begins.",
                details={"start": start.isoformat(), "end": end.isoformat()},
            )
        if (end - start).days > MAXIMUM_TRIP_NIGHTS:
            raise ValidationFailed(
                f"Weathra analyses trips of up to {MAXIMUM_TRIP_NIGHTS} nights; this one is "
                f"{(end - start).days}.",
                details={"nights": (end - start).days, "maximum": MAXIMUM_TRIP_NIGHTS},
            )
        if end < today:
            raise ValidationFailed(
                "This trip is in the past, so there is no forecast for it. Historical Analytics "
                "answers what the weather actually did.",
                details={"end": end.isoformat(), "today": today.isoformat()},
            )

        # Reach past the trip, so the temporal comparison has real alternatives to measure.
        #
        # A horizon stopping at the trip's last day leaves nothing to compare it against: the trip
        # is then the only window the forecast covers, and a comparison matrix with one row in it
        # answers nothing. Two further trip-lengths are requested instead, which costs *no extra
        # upstream call* because a provider returns its whole horizon in one response. Capped at
        # what the provider says it can serve, so the request is never longer than the answer.
        trip_length = (end - start).days + 1
        wanted = (end - today).days + 1 + 2 * trip_length
        ceiling = self._provider.capabilities().maximum_forecast_days
        horizon = max(1, min(wanted, ceiling))
        return await self._provider.forecast(destination, days=horizon, unit_system=unit_system)

    # ------------------------------------------------------------------ slicing

    @staticmethod
    def trip_days(forecast: Forecast, *, start: date, end: date) -> tuple[SeriesEntry, ...]:
        """The daily entries falling inside the trip, in order."""
        return tuple(
            entry for entry in forecast.daily.entries if start <= entry.time_local.date() <= end
        )

    def _series_of(self, forecast: Forecast, entries: tuple[SeriesEntry, ...]) -> Series:
        return Series(
            granularity=forecast.daily.granularity,
            units=forecast.daily.units,
            entries=entries,
        )

    def _provenance(
        self, location: Location, period: Period, forecast: Forecast, unit_system: UnitSystem
    ) -> Provenance:
        return Provenance(
            location=location,
            period=period,
            provider=forecast.provider,
            unit_system=unit_system,
            source_data_class=DataClass.FORECAST,
            retrieved_at=forecast.retrieved_at,
        )

    # ------------------------------------------------------------------ viability

    def viability_of(
        self,
        forecast: Forecast,
        entries: tuple[SeriesEntry, ...],
        *,
        destination: Location,
        start: date,
        end: date,
        unit_system: UnitSystem,
    ) -> TravelViability | None:
        """The trip's viability index, from the composite criterion Weathra already defines.

        Deliberately not a new formula. ``score_candidate`` with the composite criterion is the
        scoring ``specs/deterministic-analytics`` places in the backend, with its weights disclosed
        and its normalisation documented; this expresses the same 0-1 result on 0-100 and names the
        band it falls in. Inventing a second travel-specific formula would mean two numbers in one
        product that disagree about the same week.
        """
        if not entries:
            return None
        period = period_from_local_dates(destination, start, end)
        provenance = self._provenance(destination, period, forecast, unit_system)
        try:
            score, contributions, _ = score_candidate(
                label=f"{start.isoformat()}..{end.isoformat()}",
                location=destination,
                period=period,
                series=self._series_of(forecast, entries),
                criterion=Criterion.OUTDOOR_SUITABILITY,
                provenance=provenance,
            )
        except WeathraError as failure:
            logger.info("travel viability not computable: %s", failure.message)
            return None

        percent = max(0.0, min(100.0, score * 100.0))
        return TravelViability(
            score=round(percent, 1),
            state=_band(percent),
            contributions=contributions,
            basis=(
                "Computed over the trip's own days, from the same weighted components Weathra "
                "scores outdoor suitability with elsewhere."
            ),
            disclosure=WEIGHTING_DISCLOSURE,
        )

    def _day_score(
        self,
        forecast: Forecast,
        entry: SeriesEntry,
        *,
        destination: Location,
        unit_system: UnitSystem,
    ) -> float | None:
        day = entry.time_local.date()
        period = period_from_local_dates(destination, day, day)
        try:
            score, _, _ = score_candidate(
                label=day.isoformat(),
                location=destination,
                period=period,
                series=self._series_of(forecast, (entry,)),
                criterion=Criterion.OUTDOOR_SUITABILITY,
                provenance=self._provenance(destination, period, forecast, unit_system),
            )
        except WeathraError:
            return None
        return round(max(0.0, min(100.0, score * 100.0)), 1)

    def window_mean(
        self,
        forecast: Forecast,
        entries: tuple[SeriesEntry, ...],
        *,
        destination: Location,
        start: date,
        end: date,
        unit_system: UnitSystem,
        measure: Measure = Measure.TEMPERATURE_MEAN,
    ) -> StatisticResult:
        """The trip's mean for one measure, from the forecast already retrieved.

        Exists so the historical band does not fetch a second forecast. ``HistoryService`` has a
        forecast-side comparison that retrieves its own, which is right for a caller that holds
        nothing — and wrong here, where the same week is already in hand. Its horizon differs from
        this service's too, so the two requests miss each other in the provider cache and cost two
        upstream calls for one screen. Handing the value over instead costs none.
        """
        period = period_from_local_dates(destination, start, end)
        return descriptive.mean(
            self._series_of(forecast, entries),
            measure,
            self._provenance(destination, period, forecast, unit_system),
        )

    # ------------------------------------------------------------------ metrics

    def metrics_of(
        self,
        forecast: Forecast,
        entries: tuple[SeriesEntry, ...],
        *,
        destination: Location,
        start: date,
        end: date,
        unit_system: UnitSystem,
    ) -> tuple[TravelMetric, ...]:
        """The four analytical cards, each from a figure the provider actually reported.

        The artifact's own four are Temp Variance, Flight Stability, Precip Cluster and Sun
        Exposure. Two of those names imply data Weathra does not hold: it knows nothing about
        aircraft, and the provider sends no sunshine duration. So the aviation one is named for
        what it actually measures — how settled the *weather* is — and sun exposure is the peak UV
        index, which is a real reported figure rather than an estimate of hours in the sun.
        """
        units = dict(forecast.daily.units)
        period = period_from_local_dates(destination, start, end)
        provenance = self._provenance(destination, period, forecast, unit_system)
        series = self._series_of(forecast, entries)

        metrics: list[TravelMetric] = []

        highs = [v for v in (_value(e, Measure.TEMPERATURE_MAX) for e in entries) if v is not None]
        lows = [v for v in (_value(e, Measure.TEMPERATURE_MIN) for e in entries) if v is not None]
        if highs and lows:
            spread = max(highs) - min(lows)
            metrics.append(
                TravelMetric(
                    key="temperature_variance",
                    label="Temperature variance",
                    value=round(spread, 1),
                    unit=units.get(Measure.TEMPERATURE_MAX, "°C"),
                    detail=(
                        f"{round(min(lows), 1)}{_RANGE_DASH}{round(max(highs), 1)}"
                        f"{units.get(Measure.TEMPERATURE_MAX, '°C')} across the trip"
                    ),
                    method="the trip's highest reported maximum minus its lowest reported minimum",
                )
            )
        else:
            metrics.append(
                TravelMetric(
                    key="temperature_variance",
                    label="Temperature variance",
                    method="the trip's highest reported maximum minus its lowest reported minimum",
                    unavailable_reason="The provider reported no daily temperature range.",
                )
            )

        metrics.append(self._stability(entries, units))
        metrics.append(self._precipitation_cluster(series, entries, units, provenance))
        metrics.append(self._sun(entries, units))
        return tuple(metrics)

    def _stability(
        self, entries: tuple[SeriesEntry, ...], units: dict[Measure, str]
    ) -> TravelMetric:
        """How settled the trip's weather is. Not an aviation figure, and not named as one.

        Counts the days carrying something a traveller would plan around: heavy rain, strong gusts,
        or a disruptive weather code. Expressed as the share of trip days that carry none.
        """
        if not entries:
            return TravelMetric(
                key="transit_stability",
                label="Transit weather stability",
                method="the share of trip days with no heavy rain, strong gust or disruptive code",
                unavailable_reason="No trip days were reported.",
            )

        unsettled = 0
        for entry in entries:
            rain = _value(entry, Measure.PRECIPITATION_SUM)
            gust = _value(entry, Measure.WIND_GUST_MAX)
            code = _value(entry, Measure.WEATHER_CODE_DOMINANT)
            if (
                (rain is not None and rain >= _HEAVY_RAIN_MM)
                or (gust is not None and gust >= _STRONG_WIND_KMH)
                or (code is not None and int(code) in _DISRUPTIVE_CODES)
            ):
                unsettled += 1

        settled = len(entries) - unsettled
        share = round(100.0 * settled / len(entries), 1)
        return TravelMetric(
            key="transit_stability",
            label="Transit weather stability",
            value=share,
            unit="%",
            detail=(
                f"{settled} of {len(entries)} days settled"
                if unsettled
                else "No disruptive weather reported"
            ),
            method=(
                f"the share of trip days reporting under {_HEAVY_RAIN_MM} mm of rain, gusts under "
                f"{_STRONG_WIND_KMH} km/h and no disruptive weather code. Weather only — Weathra "
                "holds no airline, airport or transport data."
            ),
        )

    def _precipitation_cluster(
        self,
        series: Series,
        entries: tuple[SeriesEntry, ...],
        units: dict[Measure, str],
        provenance: Provenance,
    ) -> TravelMetric:
        total: StatisticResult = precipitation.total(series, provenance)
        if total.value is None:
            return TravelMetric(
                key="precipitation_cluster",
                label="Precipitation cluster",
                method="the trip's total reported precipitation, and how many days carry it",
                unavailable_reason=total.reason or "No precipitation was reported.",
            )
        wet = sum(
            1
            for entry in entries
            if (_value(entry, Measure.PRECIPITATION_SUM) or 0.0) >= _WET_DAY_MM
        )
        return TravelMetric(
            key="precipitation_cluster",
            label="Precipitation cluster",
            value=round(float(total.value), 1),
            unit=units.get(Measure.PRECIPITATION_SUM, "mm"),
            detail=(
                "No day reaches 1 mm"
                if wet == 0
                else f"{wet} of {len(entries)} days at or above {_WET_DAY_MM:g} mm"
            ),
            method=total.method,
        )

    def _sun(self, entries: tuple[SeriesEntry, ...], units: dict[Measure, str]) -> TravelMetric:
        peaks = [v for v in (_value(e, Measure.UV_INDEX_MAX) for e in entries) if v is not None]
        if not peaks:
            return TravelMetric(
                key="sun_exposure",
                label="Strongest sun",
                method="the highest daily peak UV index across the trip",
                unavailable_reason="The provider reported no UV index for these days.",
                data_class=DataClass.FORECAST,
            )
        top = max(peaks)
        return TravelMetric(
            key="sun_exposure",
            label="Strongest sun",
            value=round(top, 1),
            unit=units.get(Measure.UV_INDEX_MAX, "index"),
            detail="High enough to need cover" if top >= _HIGH_UV else "Moderate at its strongest",
            method=(
                "the highest daily peak UV index the provider reported across the trip. Weathra "
                "has no sunshine-duration measure and does not estimate hours in the sun."
            ),
            data_class=DataClass.FORECAST,
        )

    # ------------------------------------------------------------------ outlook

    def outlook_of(
        self,
        forecast: Forecast,
        entries: tuple[SeriesEntry, ...],
        *,
        destination: Location,
        unit_system: UnitSystem,
    ) -> tuple[DailyOutlookEntry, ...]:
        units = {measure.value: unit for measure, unit in forecast.daily.units.items()}
        scored: list[tuple[SeriesEntry, float | None]] = [
            (
                entry,
                self._day_score(forecast, entry, destination=destination, unit_system=unit_system),
            )
            for entry in entries
        ]
        order = sorted((score for _, score in scored if score is not None), reverse=True)

        days: list[DailyOutlookEntry] = []
        for entry, score in scored:
            day = entry.time_local.date()
            code = _value(entry, Measure.WEATHER_CODE_DOMINANT)
            days.append(
                DailyOutlookEntry(
                    local_date=day,
                    weekday=_weekday(day),
                    condition_code=int(code) if code is not None else None,
                    temperature_max=_value(entry, Measure.TEMPERATURE_MAX),
                    temperature_min=_value(entry, Measure.TEMPERATURE_MIN),
                    apparent_temperature_max=_value(entry, Measure.APPARENT_TEMPERATURE_MAX),
                    precipitation_sum=_value(entry, Measure.PRECIPITATION_SUM),
                    precipitation_probability_max=_value(
                        entry, Measure.PRECIPITATION_PROBABILITY_MAX
                    ),
                    wind_speed_max=_value(entry, Measure.WIND_SPEED_MAX),
                    wind_gust_max=_value(entry, Measure.WIND_GUST_MAX),
                    uv_index_max=_value(entry, Measure.UV_INDEX_MAX),
                    viability=score,
                    rank=(order.index(score) + 1) if score is not None else None,
                    units=units,
                )
            )
        return tuple(days)

    # ------------------------------------------------------------------ packing

    def packing_for(
        self,
        entries: tuple[SeriesEntry, ...],
        units: dict[Measure, str],
    ) -> tuple[tuple[PackingItem, ...], str | None]:
        """Packing, from rules over the trip's own figures — no model, and no catalogue.

        The artifact recommends "Light Breathable Linen" and "UVA/UVB Performance Protection" as
        ESSENTIAL, which is a product list presented as a model's output. What is defensible is the
        small set of considerations the weather itself raises, each naming the figure that raised
        it — so a reader can check a recommendation against the day cards above rather than trust
        it. These rules run whether or not any language model is reachable.
        """
        if not entries:
            return (), None

        highs = [v for v in (_value(e, Measure.TEMPERATURE_MAX) for e in entries) if v is not None]
        lows = [v for v in (_value(e, Measure.TEMPERATURE_MIN) for e in entries) if v is not None]
        rain = [_value(e, Measure.PRECIPITATION_SUM) or 0.0 for e in entries]
        gusts = [v for v in (_value(e, Measure.WIND_GUST_MAX) for e in entries) if v is not None]
        uv = [v for v in (_value(e, Measure.UV_INDEX_MAX) for e in entries) if v is not None]

        temperature_unit = units.get(Measure.TEMPERATURE_MAX, "°C")
        rain_unit = units.get(Measure.PRECIPITATION_SUM, "mm")
        wind_unit = units.get(Measure.WIND_GUST_MAX, "km/h")

        items: list[PackingItem] = []
        wet_days = sum(1 for value in rain if value >= _WET_DAY_MM)
        total_rain = sum(rain)

        if wet_days:
            items.append(
                PackingItem(
                    item="Waterproof outer layer",
                    tier="Essential" if wet_days >= 2 else "Recommended",
                    because=(
                        f"{wet_days} of {len(entries)} days carry rain, "
                        f"{round(total_rain, 1)} {rain_unit} over the trip"
                    ),
                )
            )
            if max(rain) >= _HEAVY_RAIN_MM:
                items.append(
                    PackingItem(
                        item="Waterproof footwear",
                        tier="Recommended",
                        because=f"one day reaches {round(max(rain), 1)} {rain_unit}",
                    )
                )
        if lows and min(lows) <= _COLD_C:
            items.append(
                PackingItem(
                    item="Warm layer and accessories",
                    tier="Essential",
                    because=f"the coldest night falls to {round(min(lows), 1)} {temperature_unit}",
                )
            )
        elif lows and min(lows) <= _COOL_EVENING_C:
            items.append(
                PackingItem(
                    item="Light evening layer",
                    tier="Recommended",
                    because=f"evenings fall to {round(min(lows), 1)} {temperature_unit}",
                )
            )
        if highs and max(highs) >= _WARM_C:
            items.append(
                PackingItem(
                    item="Breathable warm-weather clothing",
                    tier="Recommended",
                    because=f"the warmest day reaches {round(max(highs), 1)} {temperature_unit}",
                )
            )
        if uv and max(uv) >= _HIGH_UV:
            items.append(
                PackingItem(
                    item="Sun protection",
                    tier="Essential" if max(uv) >= 8 else "Recommended",
                    because=f"the peak UV index reaches {round(max(uv), 1)}",
                )
            )
        if gusts and max(gusts) >= _STRONG_WIND_KMH:
            items.append(
                PackingItem(
                    item="Wind-resistant shell",
                    tier="Recommended",
                    because=f"gusts reach {round(max(gusts), 1)} {wind_unit}",
                )
            )
        if highs and lows and (max(highs) - min(lows)) >= 12.0:
            items.append(
                PackingItem(
                    item="Layers you can add and remove",
                    tier="Optional",
                    because=(
                        f"the trip spans {round(max(highs) - min(lows), 1)} {temperature_unit} "
                        "between its coldest night and warmest day"
                    ),
                )
            )

        insight = self._insight(highs, lows, rain, temperature_unit, rain_unit)
        return tuple(items), insight

    @staticmethod
    def _insight(
        highs: list[float],
        lows: list[float],
        rain: list[float],
        temperature_unit: str,
        rain_unit: str,
    ) -> str | None:
        """One sentence about the trip's shape, written from its figures rather than by a model."""
        if not highs or not lows:
            return None
        swing = max(highs) - min(lows)
        if swing >= 12.0:
            return (
                f"Daytime highs reach {round(max(highs), 1)} {temperature_unit} but nights fall to "
                f"{round(min(lows), 1)} {temperature_unit}, so one layer carried through the day "
                "covers the difference."
            )
        if sum(rain) >= _HEAVY_RAIN_MM:
            return (
                f"Rain is spread across the trip rather than concentrated in one day, totalling "
                f"{round(sum(rain), 1)} {rain_unit} — cover matters more than timing."
            )
        if max(highs) >= _WARM_C:
            return (
                f"Conditions stay warm throughout, peaking at {round(max(highs), 1)} "
                f"{temperature_unit}, with little day-to-day variation to plan around."
            )
        return (
            f"Temperatures hold between {round(min(lows), 1)} and {round(max(highs), 1)} "
            f"{temperature_unit} across the trip, with no sharp changes to plan around."
        )

    # ------------------------------------------------------------------ temporal

    def compare_windows(
        self,
        forecast: Forecast,
        *,
        destination: Location,
        start: date,
        end: date,
        unit_system: UnitSystem,
    ) -> tuple[ComparedWindow, ...]:
        """The trip window against the other windows of the same length the horizon still covers.

        The artifact compares four departure windows across two months. A forecast horizon is days,
        not months, so the alternatives are the windows of the *same length* that fit inside what
        the provider actually sent — and where only one fits, one row is returned rather than three
        invented ones. Every figure is computed the same way as the trip's own, which is what makes
        the comparison mean anything.
        """
        entries = forecast.daily.entries
        if not entries:
            return ()

        available = sorted({entry.time_local.date() for entry in entries})
        windows: list[ComparedWindow] = []
        seen: set[tuple[date, date]] = set()

        candidates = [(start, end)]
        cursor = start
        while True:
            cursor = cursor + (end - start) + _ONE_DAY
            close = cursor + (end - start)
            if close > available[-1]:
                break
            candidates.append((cursor, close))
        # And the window immediately before the trip, where the horizon still holds it.
        earlier_start = start - (end - start) - _ONE_DAY
        if earlier_start >= available[0]:
            candidates.insert(0, (earlier_start, start - _ONE_DAY))

        for window_start, window_end in candidates:
            if (window_start, window_end) in seen:
                continue
            seen.add((window_start, window_end))
            slice_ = self.trip_days(forecast, start=window_start, end=window_end)
            selected = window_start == start and window_end == end
            label = _window_label(window_start, window_end)
            if not slice_:
                windows.append(
                    ComparedWindow(
                        start=window_start,
                        end=window_end,
                        label=label,
                        selected=selected,
                        unavailable_reason="The forecast does not reach these days.",
                    )
                )
                continue

            viability = self.viability_of(
                forecast,
                slice_,
                destination=destination,
                start=window_start,
                end=window_end,
                unit_system=unit_system,
            )
            temperatures = [
                v for v in (_value(e, Measure.TEMPERATURE_MEAN) for e in slice_) if v is not None
            ]
            rain = [_value(e, Measure.PRECIPITATION_SUM) or 0.0 for e in slice_]
            windows.append(
                ComparedWindow(
                    start=window_start,
                    end=window_end,
                    label=label,
                    selected=selected,
                    viability=viability.score if viability else None,
                    state=viability.state if viability else None,
                    temperature_mean=(
                        round(sum(temperatures) / len(temperatures), 1) if temperatures else None
                    ),
                    precipitation_sum=round(sum(rain), 1) if rain else None,
                )
            )

        return tuple(sorted(windows, key=lambda window: window.start))


# The range dash a reader expects between two dates, named so the literal appears once.
_RANGE_DASH = "\u2013"


def _window_label(start: date, end: date) -> str:
    if start == end:
        return start.strftime("%-d %b")
    if start.month == end.month:
        return f"{start.strftime('%-d')}{_RANGE_DASH}{end.strftime('%-d %b')}"
    return f"{start.strftime('%-d %b')} {_RANGE_DASH} {end.strftime('%-d %b')}"
