"""Travel Intelligence: one trip, one request, one coherent answer. Public.

**Why this endpoint exists.** The screen used to assemble itself from four unrelated endpoints —
a day ranking, a forecast, a snapshot check and a baseline comparison — each resolving the same
place and each reaching for the same week of weather. Four round trips for one question, and the
shape that produced "the weather provider limited this request" on a screen whose data was already
in hand. Everything below is computed from a single destination forecast; the archive is the only
other upstream call, and it is made for one band.

**A section may fail without taking the trip with it.** The archive, the snapshot history and the
synthesis are each allowed to be unavailable, and say so in ``partial_failures``. Only the
destination forecast is load-bearing: without it there is no trip weather to describe, and the
request fails rather than returning a hollow shape for the screen to dress up.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.api.dependencies import Configuration, CurrentSession, Places, WeatherFor
from weathra.api.middleware import annotate
from weathra.api.routers.support import provider_for, units_for
from weathra.api.routers.weather import ProviderName, Units
from weathra.auth.deps import RequiredPrincipal
from weathra.domain.analytics import StatisticResult
from weathra.domain.errors import ValidationFailed, WeathraError
from weathra.domain.location import Location, Resolved
from weathra.domain.weather import DataClass, Forecast, Measure, SeriesEntry, UnitSystem
from weathra.memory.preferences import PreferenceStore
from weathra.weather.history_service import BaselineComparison, HistoryService
from weathra.weather.snapshots import WhatChanged, capture, compare_with_previous
from weathra.weather.travel_service import (
    _RANGE_DASH,
    ComparedWindow,
    DailyOutlookEntry,
    SectionFailure,
    TravelEvidence,
    TravelIntelligence,
    TravelIntelligenceService,
    TravelMetric,
    TravelViability,
    TripWindow,
)

__all__ = ["router"]

logger = logging.getLogger("weathra.api.travel")

router = APIRouter(prefix="/travel", tags=["travel"])

# How many archive years the historical band asks for. Each is one upstream call, so this is the
# single largest lever on what a Travel page load costs the provider's quota.
_BASELINE_YEARS = 5


class TravelIntelligenceRequest(BaseModel):
    """A trip: where from, where to, and when.

    A POST body rather than a query string because a trip is a small object, not a filter, and
    because the origin and destination are names that need resolving rather than coordinates a
    screen already holds.
    """

    model_config = ConfigDict(extra="forbid")

    destination: str = Field(min_length=1, description="Where the trip goes. Resolved by name.")
    start: date = Field(description="First day of the trip, in the destination's local calendar.")
    end: date = Field(description="Last day of the trip, inclusive.")
    origin: str | None = Field(
        default=None,
        description=(
            "Where the traveller sets out from, carried as trip context. Weathra holds no "
            "transport data, so this does not affect the destination's weather."
        ),
    )
    units: Units = None
    provider: ProviderName = None


@router.post(
    "/intelligence",
    response_model=TravelIntelligence,
    summary="Analyse a trip's weather",
)
async def intelligence(
    request: Request,
    body: TravelIntelligenceRequest,
    geocoder: Places,
    weather: WeatherFor,
    session: CurrentSession,
    settings: Configuration,
    principal: RequiredPrincipal,
) -> TravelIntelligence:
    """Everything the Travel Intelligence screen shows, from one forecast retrieval."""
    preferences = PreferenceStore(session, principal, settings)
    unit_system, _ = await units_for(
        request, requested=body.units, principal=principal, preferences=preferences
    )

    destination = await _resolve(geocoder, body.destination, field="destination")
    origin = (
        await _resolve(geocoder, body.origin, field="origin")
        if body.origin and body.origin.strip()
        else None
    )

    service = TravelIntelligenceService(
        provider=provider_for(request, weather, body.provider, settings), settings=settings
    )

    # The one load-bearing call. A failure here is the request's failure: there is no trip
    # weather without it, and a success-shaped response with nothing in it is worse than an error.
    forecast = await service.retrieve(
        destination, start=body.start, end=body.end, unit_system=unit_system
    )

    entries = service.trip_days(forecast, start=body.start, end=body.end)
    if not entries:
        raise ValidationFailed(
            "The forecast does not reach these dates, so this trip cannot be analysed yet.",
            details={
                "start": body.start.isoformat(),
                "end": body.end.isoformat(),
                "horizon_days": forecast.horizon_days,
            },
        )

    failures: list[SectionFailure] = []

    viability = service.viability_of(
        forecast,
        entries,
        destination=destination,
        start=body.start,
        end=body.end,
        unit_system=unit_system,
    )
    metrics = service.metrics_of(
        forecast,
        entries,
        destination=destination,
        start=body.start,
        end=body.end,
        unit_system=unit_system,
    )
    outlook = service.outlook_of(
        forecast, entries, destination=destination, unit_system=unit_system
    )
    packing, insight = service.packing_for(entries, dict(forecast.daily.units))
    windows = service.compare_windows(
        forecast,
        destination=destination,
        start=body.start,
        end=body.end,
        unit_system=unit_system,
    )

    # The archive side only. The *forecast* side is the mean of the days already retrieved above,
    # so the historical band costs the archive years and not a second forecast.
    baseline = await _baseline(
        request,
        weather,
        body,
        settings,
        destination,
        failures,
        unit_system=unit_system,
        forecast_value=service.window_mean(
            forecast,
            entries,
            destination=destination,
            start=body.start,
            end=body.end,
            unit_system=unit_system,
        ),
    )
    changed = await _changes(session, forecast, failures)

    hero_state, hero = _hero(viability, metrics, entries, destination, body.start, body.end)
    synthesis = _synthesis(
        destination, body.start, body.end, viability, outlook, windows, baseline, changed
    )

    annotate(
        request,
        acting_user_id=principal.user_id,
        weather_provider=forecast.provider,
    )

    return TravelIntelligence(
        trip=TripWindow(
            origin=origin,
            destination=destination,
            start=body.start,
            end=body.end,
            nights=(body.end - body.start).days,
        ),
        generated_at=datetime.now(UTC),
        hero_summary=hero,
        hero_state=hero_state,
        viability=viability,
        metrics=metrics,
        daily_outlook=outlook,
        packing_strategy=packing,
        packing_insight=insight,
        temporal_comparison=windows,
        forecast_changes=changed,
        historical_baseline=baseline,
        synthesis=synthesis,
        synthesis_data_class=DataClass.COMPUTED_STATISTIC,
        evidence=TravelEvidence(
            forecast_provider=forecast.provider,
            forecast_retrieved_at=forecast.retrieved_at,
            forecast_from_cache=forecast.from_cache,
            horizon_days=forecast.horizon_days,
            unit_system=unit_system,
            destination_resolved_as=destination.display_name,
            origin_resolved_as=origin.display_name if origin else None,
            archive_provider=baseline.baseline.provider if baseline else None,
            archive_years_used=tuple(baseline.baseline.years_used) if baseline else (),
            data_classes=(
                (DataClass.FORECAST, DataClass.COMPUTED_STATISTIC)
                + ((DataClass.HISTORICAL_OBSERVATION,) if baseline else ())
            ),
        ),
        partial_failures=tuple(failures),
    )


async def _resolve(geocoder: Places, name: str, *, field: str) -> Location:
    """One place, by name, with an ambiguity surfaced rather than guessed at."""
    resolution = await geocoder.resolve(name)
    if not isinstance(resolution, Resolved):
        raise ValidationFailed(
            f"That {field} matched more than one place. Choose which one you mean.",
            details={"field": field, "query": name},
        )
    return resolution.location


async def _baseline(
    request: Request,
    weather: WeatherFor,
    body: TravelIntelligenceRequest,
    settings: Configuration,
    destination: Location,
    failures: list[SectionFailure],
    *,
    unit_system: UnitSystem,
    forecast_value: StatisticResult,
) -> BaselineComparison | None:
    """The trip window against the archive. Secondary: a failure here is reported, not raised."""
    value = getattr(forecast_value, "value", None)
    if value is None:
        failures.append(
            SectionFailure(
                section="historical_baseline",
                reason=(
                    "The forecast holds no usable mean for this window, so there is nothing to "
                    "place against the archive."
                ),
            )
        )
        return None
    try:
        service = HistoryService(
            provider=provider_for(request, weather, body.provider, settings), settings=settings
        )
        reference = await service.baseline(
            destination,
            start=body.start,
            end=body.end,
            years=_BASELINE_YEARS,
            measure=Measure.TEMPERATURE_MEAN,
            unit_system=unit_system,
        )
        return service.compare_against_baseline(
            baseline=reference, value=float(value), value_data_class=DataClass.FORECAST
        )
    except WeathraError as failure:
        # The provider's own message names measures and ranges — "no usable temperature_mean
        # observations for this period" — which is the right thing in a log and the wrong thing on
        # a customer's screen. The code travels for anyone tracing it; the sentence is theirs.
        logger.info(
            "travel historical baseline unavailable (%s): %s", failure.code, failure.message
        )
        failures.append(
            SectionFailure(
                section="historical_baseline",
                reason=(
                    "Weathra holds no archive observations for this calendar period at this place."
                ),
                code=failure.code,
            )
        )
        return None


async def _changes(
    session: AsyncSession, forecast: Forecast, failures: list[SectionFailure]
) -> WhatChanged | None:
    """What moved since the last snapshot of this window, where one exists.

    Never fabricated. With no earlier snapshot the comparison reports itself unavailable and the
    screen says so; a section that invented model convergence would be the worst thing this
    product could put on a page.
    """
    try:
        report = await compare_with_previous(session, forecast)
        if not forecast.from_cache:
            await capture(session, forecast)
        return report
    except Exception as failure:
        logger.info("travel forecast-change comparison unavailable: %s", failure)
        failures.append(
            SectionFailure(
                section="forecast_changes",
                reason="Weathra could not read the forecast snapshot history for this trip.",
            )
        )
        return None


def _hero(
    viability: TravelViability | None,
    metrics: tuple[TravelMetric, ...],
    entries: tuple[SeriesEntry, ...],
    destination: Location,
    start: date,
    end: date,
) -> tuple[str, str]:
    """The headline: what the window is, in a sentence built from the figures beside it."""
    where = destination.display_name
    when = f"{start.strftime('%-d %b')}{_RANGE_DASH}{end.strftime('%-d %b')}"

    if viability is None:
        return "Unrated", (
            f"Weathra could not score the weather window for {where} over {when} from the figures "
            "the provider reported."
        )

    rain = next((m for m in metrics if m.key == "precipitation_cluster"), None)
    stability = next((m for m in metrics if m.key == "transit_stability"), None)
    variance = next((m for m in metrics if m.key == "temperature_variance"), None)

    parts = [
        f"{when} at {where} rates {viability.score:.1f} out of 100 for outdoor conditions, "
        f"which Weathra calls {viability.state.lower()}."
    ]
    if rain is not None and rain.value is not None:
        parts.append(
            "No rain is expected across the trip."
            if rain.value == 0
            else f"{rain.value:.1f} {rain.unit} of rain is expected across the trip"
            + (f", {rain.detail[0].lower()}{rain.detail[1:]}." if rain.detail else ".")
        )
    if stability is not None and stability.value is not None:
        # Said as a traveller would ask it, rather than as the percentage it is computed from.
        parts.append(
            "No day is expected to bring heavy rain, strong gusts or a storm."
            if stability.value >= 100
            else f"Settled weather is expected on {stability.value:.0f}% of the days."
        )
    if variance is not None and variance.detail:
        parts.append(
            f"Temperatures range {variance.detail[8:]}."
            if variance.detail.startswith("Between ")
            else f"Temperatures run {variance.detail}."
        )

    return viability.state, " ".join(parts)


def _synthesis(
    destination: Location,
    start: date,
    end: date,
    viability: TravelViability | None,
    outlook: tuple[DailyOutlookEntry, ...],
    windows: tuple[ComparedWindow, ...],
    baseline: BaselineComparison | None,
    changed: WhatChanged | None,
) -> str:
    """The closing read, written by code from the figures already in this response.

    Badged as analytics, never as a model's work: labelling deterministic prose as AI is the one
    mislabelling this product must not make. Every sentence names a figure that appears elsewhere
    in the same payload, so a reader can check it rather than trust it.
    """
    sentences: list[str] = []
    where = destination.display_name

    if viability is not None:
        sentences.append(
            f"The weather over {start.strftime('%-d %b')}{_RANGE_DASH}"
            f"{end.strftime('%-d %b')} at {where} "
            f"rates {viability.score:.1f} out of 100, which Weathra calls "
            f"{viability.state.lower()}."
        )

    rated = [day for day in outlook if day.viability is not None]
    if rated:
        best = max(rated, key=lambda day: day.viability or 0)
        worst = min(rated, key=lambda day: day.viability or 0)
        if best.local_date != worst.local_date:
            sentences.append(
                f"{best.weekday} {best.local_date.strftime('%-d %b')} is the strongest day and "
                f"{worst.weekday} {worst.local_date.strftime('%-d %b')} the weakest."
            )

    alternatives = [w for w in windows if not w.selected and w.viability is not None]
    selected = next((w for w in windows if w.selected), None)
    if alternatives and selected is not None and selected.viability is not None:
        better = max(alternatives, key=lambda w: w.viability or 0)
        if (better.viability or 0) > selected.viability + 1.0:
            sentences.append(
                f"{better.label} scores higher at {better.viability:.1f}. Weathra does not change "
                "your dates; this compares weather, not bookings."
            )
        else:
            sentences.append(
                "No nearby window within the forecast horizon scores materially higher."
            )

    if baseline is not None and baseline.difference.value is not None:
        sentences.append(
            f"Against the {baseline.baseline.years_count} years of archive Weathra holds for this "
            f"calendar period, the window runs {baseline.difference.value:+.1f} "
            f"{baseline.difference.unit or ''}.".replace("  ", " ")
        )

    if changed is not None and changed.comparison_available:
        sentences.append(changed.statement)

    if not sentences:
        sentences.append(
            f"Weathra retrieved the forecast for {where} but could not compute a trip summary "
            "from the figures the provider reported."
        )
    return " ".join(sentences)
