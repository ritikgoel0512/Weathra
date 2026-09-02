"""Horizon and range validation, against declared capabilities rather than one provider's limits.

Every check here reads ``ProviderCapabilities``. That is what makes the spec scenarios
provider-independent: swapping in a provider with a 10-day horizon changes the error message and
nothing else, because no bound is written down twice (design.md decision 7).

The rule these functions exist to keep is "never silently truncated". A 30-day request against a
16-day provider is an error stating 16 — not a 16-day forecast returned as though it answered the
question.
"""

from __future__ import annotations

from datetime import date

from weathra.config import Settings
from weathra.domain.errors import RangeOutsideCoverage, UnsupportedHorizon
from weathra.providers.base import ProviderCapabilities

__all__ = ["resolve_horizon", "validate_historical_range"]


def resolve_horizon(
    capabilities: ProviderCapabilities, settings: Settings, days: int | None = None
) -> int:
    """The horizon to request: the caller's, or the configured default when they gave none.

    Raises ``UnsupportedHorizon`` when the request exceeds what the provider declares, with the
    maximum stated. Also refuses the configured default silently exceeding a provider's limit —
    a misconfiguration that would otherwise fail on every request with a confusing message.
    """
    requested = days if days is not None else settings.default_forecast_days

    if requested < 1:
        raise UnsupportedHorizon(
            f"A forecast horizon must be at least 1 day; {requested} was requested.",
            details={
                "field": "days",
                "requested": requested,
                "minimum": 1,
                "maximum": capabilities.maximum_forecast_days,
            },
        )

    if requested > capabilities.maximum_forecast_days:
        raise UnsupportedHorizon(
            f"{capabilities.name} forecasts at most {capabilities.maximum_forecast_days} days; "
            f"{requested} were requested.",
            details={
                "field": "days",
                "requested": requested,
                "maximum": capabilities.maximum_forecast_days,
                "provider": capabilities.name,
            },
        )

    return requested


def validate_historical_range(
    capabilities: ProviderCapabilities,
    *,
    start: date,
    end: date,
    today: date,
) -> None:
    """Check a past date range, naming the offending bound.

    ``today`` is passed in rather than read from a clock: the analytics layer's purity rule is
    about deterministic *computation*, but a validation function that reads the clock is equally
    untestable, and the caller already knows what day it is at the location in question.
    """
    if not capabilities.serves_history:
        raise RangeOutsideCoverage(
            f"{capabilities.name} serves no historical observations.",
            details={"provider": capabilities.name},
        )

    if end < start:
        raise RangeOutsideCoverage(
            f"A historical range's end ({end.isoformat()}) must not precede its start "
            f"({start.isoformat()}).",
            details={"field": "end", "start": start.isoformat(), "end": end.isoformat()},
        )

    earliest = capabilities.earliest_historical_date
    if earliest is not None and start < earliest:
        raise RangeOutsideCoverage(
            f"{capabilities.name}'s archive begins on {earliest.isoformat()}; the requested "
            f"range starts on {start.isoformat()}.",
            details={
                "field": "start",
                "requested": start.isoformat(),
                "earliest_available": earliest.isoformat(),
                "provider": capabilities.name,
            },
        )

    if start > today:
        raise RangeOutsideCoverage(
            f"A historical range cannot start in the future; {start.isoformat()} is after "
            f"{today.isoformat()}.",
            details={"field": "start", "requested": start.isoformat(), "today": today.isoformat()},
        )

    if end > today:
        raise RangeOutsideCoverage(
            f"A historical range cannot extend into the future; {end.isoformat()} is after "
            f"{today.isoformat()}. Ask for a forecast instead.",
            details={"field": "end", "requested": end.isoformat(), "today": today.isoformat()},
        )
