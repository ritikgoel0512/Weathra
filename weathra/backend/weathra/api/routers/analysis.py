"""Deterministic analysis over a forecast window. Public.

**Every figure states its method and its point count.** ``specs/deterministic-analytics`` requires
it, and the reason is that "11.9 °C" is not checkable while "11.9 °C, arithmetic mean, 7 points
used, 0 excluded" is. A response that carried only values would be asking a reader to trust it.

**A statistic that cannot be computed is reported unavailable, and the others still return.**
``specs/deterministic-analytics`` again: an absent measure or too few points is a real answer with a
reason, not a zero and not a failure of the whole request. So the response carries a finding with
no value and the reason it has none, alongside every finding that did compute.

**Thresholds are optional and answered honestly.** "How many days above 25 °C" over a window with
two missing days is answered as a count *and* an exclusion count, because a count that silently
treated a missing day as below the threshold would be wrong in a way nobody could see.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import horizon_for, provider_for, resolve_one, units_for
from weathra.api.routers.weather import Latitude, LocationName, Longitude, ProviderName, Units
from weathra.auth.deps import OptionalPrincipal
from weathra.domain.analytics import AnomalyReport, StatisticResult, TrendReport
from weathra.domain.errors import ValidationFailed
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, UncertaintyStatement, UnitSystem
from weathra.memory.preferences import PreferenceStore
from weathra.weather.forecast_service import ForecastService
from weathra.weather.thresholds import Direction, ThresholdCondition, ThresholdReport

__all__ = ["router"]

logger = logging.getLogger("weathra.api.analysis")

router = APIRouter(prefix="/weather", tags=["analysis"])


class AnalysisResponse(BaseModel):
    """A composed, self-describing analysis of one forecast window."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    location: Location
    provider: str = Field(min_length=1)
    units: UnitSystem
    data_class: DataClass
    period: Period
    horizon_days: int = Field(ge=1)
    from_cache: bool
    findings: tuple[StatisticResult, ...] = Field(
        description="Every computed figure, each with its method, unit, and point count."
    )
    anomalies: AnomalyReport | None = None
    trend: TrendReport | None = None
    thresholds: tuple[ThresholdReport, ...] = ()
    uncertainty: UncertaintyStatement
    summary: str = Field(
        min_length=1, description="Written by code, from the findings only. No model involved."
    )


def _thresholds(above: list[str] | None, below: list[str] | None) -> tuple[ThresholdCondition, ...]:
    """Parse ``measure:value`` pairs into conditions, or refuse with what went wrong.

    A compact query form because a threshold list belongs in a URL a person can share:
    ``?above=temperature_max:25&below=precipitation:1``.
    """
    conditions: list[ThresholdCondition] = []

    for direction, supplied in ((Direction.ABOVE, above or []), (Direction.BELOW, below or [])):
        for entry in supplied:
            measure_name, separator, raw_value = entry.partition(":")
            if not separator:
                raise ValidationFailed(
                    f"A threshold must be written 'measure:value'; got {entry!r}.",
                    details={"threshold": entry},
                )
            try:
                measure = Measure(measure_name.strip())
            except ValueError:
                raise ValidationFailed(
                    f"{measure_name!r} is not a measure Weathra knows. Available: "
                    f"{', '.join(measure.value for measure in Measure)}.",
                    details={"threshold": entry, "measure": measure_name},
                ) from None
            try:
                value = float(raw_value)
            except ValueError:
                raise ValidationFailed(
                    f"A threshold value must be a number; got {raw_value!r}.",
                    details={"threshold": entry},
                ) from None

            conditions.append(ThresholdCondition(measure=measure, direction=direction, value=value))

    return tuple(conditions)


@router.get("/analysis", response_model=AnalysisResponse, summary="Analyse a forecast window")
async def analysis(
    request: Request,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: OptionalPrincipal,
    location: LocationName = None,
    latitude: Latitude = None,
    longitude: Longitude = None,
    units: Units = None,
    provider: ProviderName = None,
    days: Annotated[int | None, Query(ge=1, le=365)] = None,
    above: Annotated[
        list[str] | None,
        Query(description="Thresholds as 'measure:value', e.g. temperature_max:25. Repeatable."),
    ] = None,
    below: Annotated[
        list[str] | None,
        Query(description="Thresholds as 'measure:value', e.g. precipitation:1. Repeatable."),
    ] = None,
) -> AnalysisResponse:
    """Statistics, extremes, anomalies, trend, and thresholds over one forecast window.

    Every figure is computed in Python from the retrieved series. No language model is involved,
    which is why this endpoint works with no inference credential configured.
    """
    place = await resolve_one(geocoder, location=location, latitude=latitude, longitude=longitude)
    preferences = PreferenceStore(session, principal, settings) if principal is not None else None
    unit_system, _ = await units_for(
        request, requested=units, principal=principal, preferences=preferences
    )
    horizon = await horizon_for(days, principal=principal, preferences=preferences)

    service = ForecastService(
        provider=provider_for(request, weather, provider, settings),
        geocoder=geocoder,
        settings=settings,
    )
    result = await service.analyse(
        place,
        days=horizon,
        unit_system=unit_system,
        conditions=_thresholds(above, below),
    )
    annotate(
        request,
        acting_user_id=principal.user_id if principal else None,
        weather_provider=result.provider,
        cache_status="hit" if result.from_cache else "miss",
    )

    return AnalysisResponse(
        location=result.location,
        provider=result.provider,
        units=result.unit_system,
        data_class=result.data_class,
        period=result.period,
        horizon_days=result.horizon_days,
        from_cache=result.from_cache,
        findings=result.findings,
        anomalies=result.anomalies,
        trend=result.trend,
        thresholds=result.thresholds,
        uncertainty=result.uncertainty,
        summary=result.summary,
    )
