"""Comparison: which place, or which day, best fits a criterion — and the evidence behind it.

This layer ranks and explains; it computes nothing. Every score is built from
``StatisticResult`` values so the ranking can be checked rather than trusted
(``specs/location-comparison``).

The composite outdoor-suitability criterion is the one place a judgment is being made rather than a
measurement reported, so its weights are disclosed in the result and labelled Weathra's own
heuristic — never an authoritative index.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from weathra.domain.analytics import Direction, StatisticResult
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Measure, Period, UnitSystem

__all__ = [
    "ComparisonCandidate",
    "ComparisonMode",
    "ComparisonResult",
    "ComponentContribution",
    "Criterion",
    "ExcludedCandidate",
]


class Criterion(StrEnum):
    """The supported ways to rank. Anything else is rejected with this list."""

    WARMEST = "warmest"
    COOLEST = "coolest"
    DRIEST = "driest"
    WETTEST = "wettest"
    LEAST_WINDY = "least_windy"
    OUTDOOR_SUITABILITY = "outdoor_suitability"

    @property
    def is_composite(self) -> bool:
        return self is Criterion.OUTDOOR_SUITABILITY


class ComparisonMode(StrEnum):
    """What is being compared."""

    LOCATIONS = "locations"
    DAYS = "days"


class ComponentContribution(BaseModel):
    """One measure's part in a composite score: which way it counts, how much, and to what effect.

    Required by ``specs/location-comparison`` for the composite criterion, so a reader can see
    that "best for being outdoors" is an arithmetic combination and not an opinion.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    measure: Measure
    value: float = Field(description="The measured input, in `unit`.")
    unit: str = Field(min_length=1)
    direction: Direction = Field(
        description="ABOVE when a higher value scores better, BELOW when a lower one does."
    )
    weight: float = Field(ge=0.0, le=1.0, description="This component's share of the score.")
    contribution: float = Field(description="Weighted points this component added to the score.")
    supporting: StatisticResult = Field(description="The analytics result the value came from.")


class ComparisonCandidate(BaseModel):
    """One ranked candidate — a location, or a day at one location — with its evidence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str = Field(min_length=1, description="What to call it: a place name, or a local date.")
    location: Location
    period: Period = Field(
        description="Evaluated in this candidate's own local time, which the result states."
    )
    rank: int = Field(ge=1, description="Shared by tied candidates rather than broken arbitrarily.")
    score: float
    tied: bool = False
    contributions: tuple[ComponentContribution, ...] = Field(
        default=(),
        description="Populated for the composite criterion; empty for a single-measure one.",
    )
    supporting: tuple[StatisticResult, ...] = Field(
        min_length=1, description="The analytics results that produced the score."
    )


class ExcludedCandidate(BaseModel):
    """A candidate whose data could not be retrieved, listed with why.

    Excluding rather than failing is what lets a three-city comparison still answer when one city
    is unavailable — provided at least two survive.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str = Field(min_length=1)
    location: Location | None = Field(
        default=None, description="Absent when the exclusion was a resolution failure."
    )
    reason: str = Field(min_length=1, description="Stated plainly, with no raw upstream payload.")
    code: str = Field(min_length=1, description="The stable error code behind the exclusion.")


class ComparisonResult(BaseModel):
    """A completed comparison: the ranking, the shared basis, and what was left out."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    mode: ComparisonMode
    criterion: Criterion
    data_class: DataClass = Field(
        description="Which class every candidate was evaluated from. Never mixed."
    )
    period: Period = Field(description="The shared window, applied in each candidate's local time.")
    unit_system: UnitSystem
    provider: str = Field(min_length=1)
    statistics_applied: tuple[str, ...] = Field(
        min_length=1, description="The same statistics were applied to every candidate."
    )
    candidates: tuple[ComparisonCandidate, ...] = Field(min_length=1)
    excluded: tuple[ExcludedCandidate, ...] = ()
    tie_tolerance: float = Field(
        ge=0.0, description="Scores within this are reported tied at the same rank."
    )
    local_time_basis: bool = Field(
        default=True,
        description="Whether the window was applied in each candidate's own local time.",
    )
    weighting_disclosure: str | None = Field(
        default=None,
        description="Required for the composite criterion: whose heuristic the weights are.",
    )
    correlation: StatisticResult | None = Field(
        default=None,
        description=(
            "How the two compared places' trajectories moved together, as Pearson's r over the "
            "instants both reported. Present only for a two-candidate comparison: a single "
            "coefficient describes one pair, and N places have N(N-1)/2 of them. Not computable, "
            "with its reason, where the pair shares too few instants or either side was flat."
        ),
    )
    data_density: StatisticResult | None = Field(
        default=None,
        description=(
            "How much of the window every candidate actually reported, as a percentage. Counts "
            "only instants every candidate carries a value for, because a slot one place reported "
            "and another did not is a slot the comparison could not use."
        ),
    )

    @model_validator(mode="after")
    def _basis_is_shared_and_stated(self) -> Self:
        if self.data_class not in (
            DataClass.FORECAST,
            DataClass.CURRENT,
            DataClass.HISTORICAL_OBSERVATION,
        ):
            raise ValueError(
                "A comparison is computed from retrieved data and must name that data class."
            )

        if self.mode is ComparisonMode.LOCATIONS:
            if len(self.candidates) < 2:
                raise ValueError(
                    "A location comparison ranks at least two candidates; fewer means the "
                    "request should have failed rather than returned a ranking."
                )
            identifiers = [candidate.location.identifier for candidate in self.candidates]
            if len(set(identifiers)) != len(identifiers):
                raise ValueError("A location comparison must not rank the same place twice.")
        else:
            places = {candidate.location.identifier for candidate in self.candidates}
            if len(places) != 1:
                raise ValueError("A day comparison ranks days at exactly one location.")

        if self.criterion.is_composite:
            if not self.weighting_disclosure:
                raise ValueError(
                    "A composite score must disclose that its weighting is Weathra's own "
                    "heuristic rather than an authoritative index."
                )
            for candidate in self.candidates:
                if not candidate.contributions:
                    raise ValueError(
                        f"Candidate {candidate.label!r} carries no component contributions, so "
                        "its composite score cannot be explained."
                    )

        ranks = sorted(candidate.rank for candidate in self.candidates)
        if ranks and ranks[0] != 1:
            raise ValueError("Ranking starts at 1.")

        return self

    @property
    def winner(self) -> ComparisonCandidate:
        """The top-ranked candidate. Ties share rank 1, and the first of them is returned."""
        return min(self.candidates, key=lambda candidate: (candidate.rank, candidate.label))
