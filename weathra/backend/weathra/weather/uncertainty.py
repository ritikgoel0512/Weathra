"""The uncertainty statement that accompanies every forecast.

Two requirements shape this, and they pull in the same direction:
``specs/forecast-analysis`` wants each figure's distance into the horizon and any provider-supplied
spread; ``specs/safety-grounding`` wants the *basis* of any confidence characterization stated,
including that it comes from one provider.

So the statement is honest about how little it knows. With a single provider there is no consensus
signal — no second model to disagree — and the only things Weathra can truthfully say are "this
figure is N hours out" and "the provider supplied this range, or supplied none". The bands are
therefore bands, not probabilities: presenting "72% confidence" from horizon distance alone would
be inventing precision, which is the specific failure the grounding rules exist to prevent.

The band thresholds are a judgment call and a deliberately coarse one. Provider skill decays
gradually, so any cut point is arbitrary; three wide bands say roughly what is true without
implying the boundary means something.
"""

from __future__ import annotations

from datetime import UTC, datetime

from weathra.domain.weather import (
    ConfidenceBand,
    Forecast,
    Granularity,
    HorizonPoint,
    Measure,
    Series,
    SpreadPoint,
    UncertaintyStatement,
)

__all__ = [
    "BASIS_STATEMENT",
    "HIGH_CONFIDENCE_HOURS",
    "MODERATE_CONFIDENCE_HOURS",
    "describe_uncertainty",
    "describe_uncertainty_for",
]

# Up to two days out, provider skill is good enough to call high; past five days it is not.
HIGH_CONFIDENCE_HOURS = 48.0
MODERATE_CONFIDENCE_HOURS = 120.0

BASIS_STATEMENT = (
    "Confidence decreases with distance into the horizon. This assessment is derived from horizon "
    "distance and {provider}'s own model output and supplied spread only — it is not a "
    "multi-provider consensus, and Weathra does not produce forecasts of its own."
)


def band_for(hours_ahead: float) -> ConfidenceBand:
    """The band a figure that far into the horizon falls in."""
    if hours_ahead <= HIGH_CONFIDENCE_HOURS:
        return ConfidenceBand.HIGH
    if hours_ahead <= MODERATE_CONFIDENCE_HOURS:
        return ConfidenceBand.MODERATE
    return ConfidenceBand.LOW


def describe_uncertainty(
    forecast: Forecast,
    *,
    reference: datetime | None = None,
    granularity: Granularity = Granularity.DAILY,
) -> UncertaintyStatement:
    """The uncertainty statement for a forecast.

    ``reference`` defaults to the forecast's own ``retrieved_at`` rather than to the current
    instant, so the statement describes the data as retrieved and stays stable when the same
    forecast is read again later — including when it is served from cache.
    """
    anchor = (reference or forecast.retrieved_at).astimezone(UTC)
    series = forecast.daily if granularity is Granularity.DAILY else forecast.hourly
    return describe_uncertainty_for(series, provider=forecast.provider, retrieved_at=anchor)


def describe_uncertainty_for(
    series: Series, *, provider: str, retrieved_at: datetime
) -> UncertaintyStatement:
    """The same statement, from a series a caller already holds.

    The agent graph reaches for this one: it has the retrieved series on the run's state and no
    ``Forecast`` object, and re-fetching one to describe uncertainty about data already in hand
    would be a second retrieval that could disagree with the first.
    """
    anchor = retrieved_at.astimezone(UTC)

    horizon = tuple(
        HorizonPoint(
            time_utc=entry.time_utc,
            time_local=entry.time_local,
            hours_ahead=_hours(anchor, entry.time_utc),
            confidence=band_for(_hours(anchor, entry.time_utc)),
        )
        for entry in series.entries
    )

    spread = _provider_spread(series)

    return UncertaintyStatement(
        provider=provider,
        reference_time_utc=anchor,
        horizon=horizon,
        provider_spread=spread,
        spread_available=bool(spread),
        basis=BASIS_STATEMENT.format(provider=provider),
    )


def _hours(anchor: datetime, moment: datetime) -> float:
    return max((moment.astimezone(UTC) - anchor).total_seconds() / 3600.0, 0.0)


def _provider_spread(series: Series) -> tuple[SpreadPoint, ...]:
    """Any range the provider itself supplied, as a spread.

    Open-Meteo's standard endpoint carries no ensemble range, so this is usually empty — and
    ``spread_available`` then says so rather than the statement implying a spread it does not have.
    The one range the provider *does* give per day is the min-to-max temperature envelope, which
    is a real statement about the day's variation and is reported as such.
    """
    if not {Measure.TEMPERATURE_MIN, Measure.TEMPERATURE_MAX} <= set(series.units):
        return ()

    points: list[SpreadPoint] = []
    for entry in series.entries:
        low = entry.value(Measure.TEMPERATURE_MIN)
        high = entry.value(Measure.TEMPERATURE_MAX)
        if low is None or high is None:
            continue
        points.append(
            SpreadPoint(
                time_utc=entry.time_utc,
                measure=Measure.TEMPERATURE_MEAN,
                lower=min(low, high),
                upper=max(low, high),
            )
        )
    return tuple(points)


def qualify(hours_ahead: float) -> str:
    """A short phrase a summary can use for a figure that far out.

    Deliberately not a percentage. "Lower confidence" is what the system can support; "68% likely"
    is not.
    """
    band = band_for(hours_ahead)
    if band is ConfidenceBand.HIGH:
        return f"{hours_ahead:.0f} hours out, near-term and higher-confidence"
    if band is ConfidenceBand.MODERATE:
        return f"{hours_ahead:.0f} hours out, moderate-confidence"
    return f"{hours_ahead:.0f} hours out, far-horizon and lower-confidence"
