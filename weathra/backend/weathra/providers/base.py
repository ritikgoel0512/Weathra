"""The weather-provider contract.

A ``Protocol`` rather than an abstract base class: a provider is a thing that answers four
questions, and nothing above this layer should care whether an implementation inherits from
anything. ``runtime_checkable`` so a test can assert a stub satisfies the contract without
importing the real one.

``capabilities()`` is mandatory, and that is the load-bearing part. Horizon and archive-range
validation read the descriptor rather than hardcoding Open-Meteo's limits, which is what makes
those spec scenarios provider-independent — and what makes "a measure this provider does not
supply" a declared fact rather than something a caller discovers from a null.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol, Self, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, model_validator

from weathra.domain.location import Location
from weathra.domain.weather import (
    CurrentConditions,
    Forecast,
    Granularity,
    HistoricalObservations,
    Measure,
    UnitSystem,
)

__all__ = ["ProviderCapabilities", "WeatherProvider"]


class ProviderCapabilities(BaseModel):
    """What a provider can actually do, declared rather than discovered."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(min_length=1, description="The registry key this provider answers to.")
    maximum_forecast_days: int = Field(
        ge=1, description="Horizon bound. A longer request is refused with this number stated."
    )
    minimum_hourly_hours: int = Field(
        ge=1, description="How far into the horizon hourly detail is guaranteed."
    )
    earliest_historical_date: date | None = Field(
        default=None,
        description="Archive start. None means the provider serves no history at all.",
    )
    archive_lag_days: int = Field(
        default=0,
        ge=0,
        description=(
            "How far behind 'today' the archive runs. A range ending inside the lag returns "
            "partial coverage with a statement of what is not yet available."
        ),
    )
    measures: dict[Granularity, tuple[Measure, ...]] = Field(
        description="Which measures this provider supplies at which granularity."
    )
    historical_measures: tuple[Measure, ...] = Field(
        default=(),
        description="Daily measures the archive supplies. Often a subset of the forecast set.",
    )
    unit_systems: tuple[UnitSystem, ...] = Field(default=(UnitSystem.METRIC, UnitSystem.IMPERIAL))
    requires_credential: bool = Field(
        default=False, description="Open-Meteo needs none, which is why it is the default."
    )

    @model_validator(mode="after")
    def _declares_something(self) -> Self:
        if not self.measures:
            raise ValueError(f"Provider {self.name!r} declares no measures at any granularity.")
        if self.earliest_historical_date is None and self.historical_measures:
            raise ValueError(
                f"Provider {self.name!r} declares historical measures but no archive start date."
            )
        return self

    def supplies(self, measure: Measure, granularity: Granularity) -> bool:
        return measure in self.measures.get(granularity, ())

    def supplies_historically(self, measure: Measure) -> bool:
        return measure in self.historical_measures

    @property
    def serves_history(self) -> bool:
        return self.earliest_historical_date is not None


@runtime_checkable
class WeatherProvider(Protocol):
    """Any upstream weather source, behind one shape.

    Adding a provider means implementing this and registering it. No agent, analytics function,
    MCP tool, or API route changes (``specs/weather-providers``).
    """

    def capabilities(self) -> ProviderCapabilities:
        """What this provider supports. Read by validation, readiness, and the MCP catalog."""
        ...

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        """Conditions now. Labelled ``current``, never ``forecast``."""
        ...

    async def forecast(
        self,
        location: Location,
        *,
        days: int,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> Forecast:
        """Hourly and daily forecast over ``days``, which the caller has already validated."""
        ...

    async def history(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> HistoricalObservations:
        """Observed weather over a past range, inclusive of both bounds."""
        ...
