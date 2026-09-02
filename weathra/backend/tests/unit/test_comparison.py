"""Group 9 — the comparison service: criteria, fairness, ties, partial failures, and modes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime

import pytest

from tests import factories as f
from tests.provider_support import provider_settings, stub_capabilities
from weathra.domain.analytics import Direction, Provenance, Statistic
from weathra.domain.comparison import ComparisonMode, Criterion
from weathra.domain.errors import (
    ProviderTimeout,
    ProviderUnavailable,
    UnsupportedCriterion,
    ValidationFailed,
)
from weathra.domain.location import Location
from weathra.domain.weather import (
    CurrentConditions,
    DataClass,
    Forecast,
    Granularity,
    HistoricalObservations,
    Measure,
    Series,
    UnitSystem,
    units_map,
)
from weathra.domain.windows import period_from_local_dates
from weathra.providers.base import ProviderCapabilities
from weathra.weather.comparison_service import (
    COMPOSITE_WEIGHTS,
    TIE_TOLERANCE,
    WEIGHTING_DISCLOSURE,
    ComparisonService,
    parse_criterion,
    supported_criteria,
)

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
START = date(2026, 3, 1)


class ScriptedProvider:
    """A provider that answers each location from a script, or fails it.

    Built here rather than reused from ``provider_support`` because a comparison test needs
    per-location control: three cities with different weather, one of which times out.
    """

    name = "scripted"

    def __init__(
        self,
        *,
        daily: Mapping[str, Mapping[Measure, Sequence[float | None]]],
        failures: dict[str, Exception] | None = None,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> None:
        self._daily = daily
        self._failures = failures or {}
        self._unit_system = unit_system
        self.forecast_calls: list[str] = []
        self.history_calls: list[str] = []

    def capabilities(self) -> ProviderCapabilities:
        return stub_capabilities(name=self.name, maximum_forecast_days=16)

    async def current(
        self, location: Location, *, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> CurrentConditions:
        raise NotImplementedError

    def _series(self, location: Location, days: int) -> Series:
        values = self._daily.get(location.display_name)
        if values is None:
            return Series(
                granularity=Granularity.DAILY,
                units=units_map((Measure.TEMPERATURE_MEAN,), self._unit_system),
            )
        return f.series(
            {measure: column[:days] for measure, column in values.items()},
            timezone=location.timezone,
            unit_system=self._unit_system,
        )

    async def forecast(
        self, location: Location, *, days: int, unit_system: UnitSystem = UnitSystem.METRIC
    ) -> Forecast:
        self.forecast_calls.append(location.display_name)
        failure = self._failures.get(location.display_name)
        if failure:
            raise failure
        return f.forecast(
            daily=self._series(location, days),
            location=location,
            provider=self.name,
            unit_system=unit_system,
            horizon_days=days,
        )

    async def history(
        self,
        location: Location,
        *,
        start: date,
        end: date,
        unit_system: UnitSystem = UnitSystem.METRIC,
    ) -> HistoricalObservations:
        self.history_calls.append(location.display_name)
        failure = self._failures.get(location.display_name)
        if failure:
            raise failure
        window = period_from_local_dates(location, start, end)
        return f.historical(
            daily=self._series(location, (end - start).days + 1),
            location=location,
            provider=self.name,
            unit_system=unit_system,
            requested=window,
            covered=window,
        )


THREE_CITIES: Mapping[str, Mapping[Measure, Sequence[float | None]]] = {
    "Lisbon": {
        Measure.TEMPERATURE_MEAN: [19.0, 20.0, 21.0, 20.0, 19.0],
        Measure.PRECIPITATION_SUM: [0.0, 0.0, 1.0, 0.0, 0.0],
        Measure.WIND_SPEED_MAX: [14.0, 12.0, 15.0, 13.0, 11.0],
    },
    "Berlin": {
        Measure.TEMPERATURE_MEAN: [11.0, 12.0, 11.5, 12.5, 11.0],
        Measure.PRECIPITATION_SUM: [2.0, 4.0, 0.0, 1.0, 3.0],
        Measure.WIND_SPEED_MAX: [22.0, 25.0, 18.0, 20.0, 24.0],
    },
    "Reykjavík": {
        Measure.TEMPERATURE_MEAN: [3.0, 4.0, 2.5, 3.5, 4.0],
        Measure.PRECIPITATION_SUM: [6.0, 8.0, 4.0, 5.0, 7.0],
        Measure.WIND_SPEED_MAX: [38.0, 42.0, 35.0, 40.0, 44.0],
    },
}

LOCATIONS = (f.LISBON, f.BERLIN, f.REYKJAVIK)


def service(
    *,
    daily: Mapping[str, Mapping[Measure, Sequence[float | None]]] | None = None,
    failures: dict[str, Exception] | None = None,
    max_locations: int = 8,
) -> ComparisonService:
    provider = ScriptedProvider(daily=daily or THREE_CITIES, failures=failures)
    return ComparisonService(
        provider=provider,
        settings=provider_settings(comparison_max_locations=max_locations),
        now=NOW,
    )


# =========================================================================== 9.1 criteria


def test_every_criterion_the_spec_names_is_supported() -> None:
    assert set(supported_criteria()) == {
        "warmest",
        "coolest",
        "driest",
        "wettest",
        "least_windy",
        "outdoor_suitability",
    }


def test_an_unsupported_criterion_lists_the_supported_ones() -> None:
    with pytest.raises(UnsupportedCriterion) as caught:
        parse_criterion("sunniest")
    assert "sunniest" in caught.value.message
    assert "warmest" in caught.value.message
    assert caught.value.details["supported"] == list(supported_criteria())


@pytest.mark.parametrize(
    ("criterion", "expected_first"),
    [
        (Criterion.WARMEST, "Lisbon"),
        (Criterion.COOLEST, "Reykjavík"),
        (Criterion.DRIEST, "Lisbon"),
        (Criterion.WETTEST, "Reykjavík"),
        (Criterion.LEAST_WINDY, "Lisbon"),
        (Criterion.OUTDOOR_SUITABILITY, "Lisbon"),
    ],
)
async def test_each_criterion_orders_correctly(criterion: Criterion, expected_first: str) -> None:
    result = await service().compare_locations(LOCATIONS, criterion=criterion, days=5)
    assert result.winner.label == expected_first
    assert [candidate.rank for candidate in result.candidates] == [1, 2, 3]


async def test_the_composite_criterion_reports_every_component_contribution() -> None:
    result = await service().compare_locations(
        LOCATIONS, criterion=Criterion.OUTDOOR_SUITABILITY, days=5
    )
    winner = result.winner

    assert {contribution.measure for contribution in winner.contributions} == set(COMPOSITE_WEIGHTS)
    assert sum(c.weight for c in winner.contributions) == pytest.approx(1.0)
    assert winner.score == pytest.approx(sum(c.contribution for c in winner.contributions)), (
        "the score must be the sum of its disclosed contributions"
    )


async def test_the_composite_criterion_states_each_component_direction() -> None:
    result = await service().compare_locations(
        LOCATIONS, criterion=Criterion.OUTDOOR_SUITABILITY, days=5
    )
    by_measure = {c.measure: c for c in result.winner.contributions}
    assert by_measure[Measure.TEMPERATURE_MEAN].direction is Direction.ABOVE
    assert by_measure[Measure.PRECIPITATION_SUM].direction is Direction.BELOW
    assert by_measure[Measure.WIND_SPEED_MAX].direction is Direction.BELOW


async def test_the_composite_weighting_is_disclosed_as_a_heuristic() -> None:
    result = await service().compare_locations(
        LOCATIONS, criterion=Criterion.OUTDOOR_SUITABILITY, days=5
    )
    assert result.weighting_disclosure == WEIGHTING_DISCLOSURE
    assert "Weathra's own heuristic" in result.weighting_disclosure
    assert "not an authoritative index" in result.weighting_disclosure


async def test_a_single_measure_criterion_carries_no_contributions() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    assert all(candidate.contributions == () for candidate in result.candidates)
    assert result.weighting_disclosure is None


async def test_every_candidate_carries_the_analytics_behind_its_score() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    for candidate in result.candidates:
        assert candidate.supporting
        for statistic in candidate.supporting:
            assert statistic.method
            assert statistic.data_class is DataClass.COMPUTED_STATISTIC


async def test_a_criterion_score_is_readable_in_the_measures_own_unit() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    lisbon = result.winner
    mean = next(
        statistic for statistic in lisbon.supporting if statistic.statistic is Statistic.MEAN
    )
    assert lisbon.score == pytest.approx(mean.value)


# =========================================================================== 9.2 multi-location


async def test_three_locations_are_all_returned_ranked() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    assert result.mode is ComparisonMode.LOCATIONS
    assert len(result.candidates) == 3
    assert [candidate.label for candidate in result.candidates] == [
        "Lisbon",
        "Berlin",
        "Reykjavík",
    ]


async def test_a_single_location_comparison_is_refused() -> None:
    with pytest.raises(ValidationFailed) as caught:
        await service().compare_locations((f.BERLIN,), criterion=Criterion.WARMEST)
    assert "at least two locations" in caught.value.message
    assert caught.value.details["minimum"] == 2


async def test_an_over_limit_comparison_states_the_limit() -> None:
    many = tuple(
        Location(
            display_name=f"City {index}",
            latitude=float(index),
            longitude=float(index),
            timezone="UTC",
        )
        for index in range(6)
    )
    with pytest.raises(ValidationFailed) as caught:
        await service(max_locations=4).compare_locations(many, criterion=Criterion.WARMEST)
    assert "at most 4 locations" in caught.value.message
    assert caught.value.details["maximum"] == 4


async def test_the_shared_basis_is_stated() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    assert result.provider == "scripted"
    assert result.unit_system is UnitSystem.METRIC
    assert result.statistics_applied
    assert "temperature_mean" in result.statistics_applied[0]
    assert result.local_time_basis is True


async def test_candidates_in_differing_timezones_are_evaluated_in_their_own_local_time() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    zones = {candidate.period.timezone for candidate in result.candidates}
    assert zones == {"Europe/Lisbon", "Europe/Berlin", "Atlantic/Reykjavik"}
    assert result.local_time_basis is True


async def test_every_candidate_gets_the_same_window_length() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    durations = {candidate.period.duration_hours for candidate in result.candidates}
    assert durations == {120.0}


async def test_every_candidate_is_retrieved_from_the_same_provider_and_units() -> None:
    provider = ScriptedProvider(daily=THREE_CITIES)
    built = ComparisonService(provider=provider, settings=provider_settings(), now=NOW)
    result = await built.compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    assert sorted(provider.forecast_calls) == ["Berlin", "Lisbon", "Reykjavík"]
    for candidate in result.candidates:
        for statistic in candidate.supporting:
            assert statistic.provenance.provider == "scripted"
            assert statistic.provenance.unit_system is UnitSystem.METRIC


# =========================================================================== 9.3 day-level


async def test_the_driest_day_ranks_first_with_its_analytics() -> None:
    result = await service().compare_days(f.BERLIN, criterion=Criterion.DRIEST, days=5)

    assert result.mode is ComparisonMode.DAYS
    assert len(result.candidates) == 5
    # Berlin's third day has 0.0 mm; every other day has more.
    assert result.winner.label == "2026-03-04"
    assert result.winner.supporting
    assert result.winner.supporting[0].statistic is Statistic.TOTAL


async def test_a_day_comparison_ranks_days_at_one_location() -> None:
    result = await service().compare_days(f.BERLIN, criterion=Criterion.WARMEST, days=5)
    assert {candidate.location.identifier for candidate in result.candidates} == {
        f.BERLIN.identifier
    }
    assert all(candidate.period.duration_hours == 24.0 for candidate in result.candidates)


# =========================================================================== 9.4 historical


async def test_a_historical_comparison_is_labelled_historical() -> None:
    result = await service().compare_locations_historically(
        (f.LISBON, f.BERLIN),
        criterion=Criterion.WETTEST,
        start=date(2025, 2, 1),
        end=date(2025, 2, 5),
    )
    assert result.data_class is DataClass.HISTORICAL_OBSERVATION
    assert result.winner.label == "Berlin"
    for candidate in result.candidates:
        for statistic in candidate.supporting:
            assert statistic.provenance.source_data_class is DataClass.HISTORICAL_OBSERVATION


async def test_a_historical_comparison_uses_the_archive_rather_than_the_forecast() -> None:
    provider = ScriptedProvider(daily=THREE_CITIES)
    built = ComparisonService(provider=provider, settings=provider_settings(), now=NOW)
    await built.compare_locations_historically(
        (f.LISBON, f.BERLIN),
        criterion=Criterion.WETTEST,
        start=date(2025, 2, 1),
        end=date(2025, 2, 5),
    )
    assert sorted(provider.history_calls) == ["Berlin", "Lisbon"]
    assert provider.forecast_calls == []


async def test_a_comparison_is_one_data_class_or_the_other_never_mixed() -> None:
    """The model itself refuses a mixed comparison, so it cannot be constructed."""
    forecast_side = await service().compare_locations(
        (f.LISBON, f.BERLIN), criterion=Criterion.WARMEST, days=5
    )
    historical_side = await service().compare_locations_historically(
        (f.LISBON, f.BERLIN),
        criterion=Criterion.WARMEST,
        start=date(2025, 2, 1),
        end=date(2025, 2, 5),
    )
    assert forecast_side.data_class is DataClass.FORECAST
    assert historical_side.data_class is DataClass.HISTORICAL_OBSERVATION

    with pytest.raises(ValueError, match="name that data class"):
        forecast_side.model_copy(
            update={"data_class": DataClass.COMPUTED_STATISTIC}
        ).model_validate(forecast_side.model_dump() | {"data_class": DataClass.COMPUTED_STATISTIC})


async def test_a_future_historical_range_is_refused() -> None:
    from weathra.domain.errors import RangeOutsideCoverage

    with pytest.raises(RangeOutsideCoverage):
        await service().compare_locations_historically(
            (f.LISBON, f.BERLIN),
            criterion=Criterion.WETTEST,
            start=date(2026, 6, 1),
            end=date(2026, 6, 5),
        )


# =========================================================================== 9.5 ties, failures


async def test_two_candidates_within_the_tolerance_share_a_rank() -> None:
    twins: Mapping[str, Mapping[Measure, Sequence[float | None]]] = {
        "Berlin": {Measure.TEMPERATURE_MEAN: [12.0, 12.0, 12.0]},
        "Munich": {Measure.TEMPERATURE_MEAN: [12.02, 12.0, 12.0]},
    }
    result = await service(daily=twins).compare_locations(
        (f.BERLIN, f.MUNICH), criterion=Criterion.WARMEST, days=3
    )

    assert {candidate.rank for candidate in result.candidates} == {1}
    assert all(candidate.tied for candidate in result.candidates)
    assert result.tie_tolerance == TIE_TOLERANCE


async def test_candidates_outside_the_tolerance_do_not_tie() -> None:
    distinct: Mapping[str, Mapping[Measure, Sequence[float | None]]] = {
        "Berlin": {Measure.TEMPERATURE_MEAN: [12.0, 12.0, 12.0]},
        "Munich": {Measure.TEMPERATURE_MEAN: [14.0, 14.0, 14.0]},
    }
    result = await service(daily=distinct).compare_locations(
        (f.BERLIN, f.MUNICH), criterion=Criterion.WARMEST, days=3
    )
    assert [candidate.rank for candidate in result.candidates] == [1, 2]
    assert not any(candidate.tied for candidate in result.candidates)


async def test_one_unavailable_candidate_among_three_is_excluded_with_its_reason() -> None:
    result = await service(
        failures={"Reykjavík": ProviderTimeout("The provider did not respond in time.")}
    ).compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    assert len(result.candidates) == 2
    assert len(result.excluded) == 1
    excluded = result.excluded[0]
    assert excluded.label == "Reykjavík"
    assert excluded.code == "provider_timeout"
    assert "did not respond" in excluded.reason


async def test_an_excluded_candidate_carries_no_raw_upstream_material() -> None:
    result = await service(
        failures={"Reykjavík": RuntimeError("connection reset by peer: token=abc123")}
    ).compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    excluded = result.excluded[0]
    assert "abc123" not in excluded.reason
    assert excluded.code == "internal_error"


async def test_fewer_than_two_survivors_fails_the_whole_request() -> None:
    with pytest.raises(ValidationFailed) as caught:
        await service(
            failures={
                "Berlin": ProviderUnavailable("unreachable"),
                "Reykjavík": ProviderUnavailable("unreachable"),
            }
        ).compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    assert "Too few locations" in caught.value.message
    assert caught.value.details["evaluated"] == 1
    assert len(caught.value.details["excluded"]) == 2


async def test_the_failure_names_every_excluded_candidate() -> None:
    with pytest.raises(ValidationFailed) as caught:
        await service(
            failures={
                "Berlin": ProviderUnavailable("Berlin is unreachable."),
                "Reykjavík": ProviderTimeout("Reykjavík timed out."),
            }
        ).compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    labels = {item["label"] for item in caught.value.details["excluded"]}
    assert labels == {"Berlin", "Reykjavík"}


async def test_candidates_are_retrieved_concurrently() -> None:
    """Three sequential round trips would triple the latency of every comparison."""
    import asyncio

    in_flight = 0
    peak = 0

    class SlowProvider(ScriptedProvider):
        async def forecast(
            self, location: Location, *, days: int, unit_system: UnitSystem = UnitSystem.METRIC
        ) -> Forecast:
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return await super().forecast(location, days=days, unit_system=unit_system)

    built = ComparisonService(
        provider=SlowProvider(daily=THREE_CITIES), settings=provider_settings(), now=NOW
    )
    await built.compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    assert peak == 3


async def test_a_candidate_whose_series_is_empty_is_excluded_rather_than_scored() -> None:
    result = await service(
        daily={name: values for name, values in THREE_CITIES.items() if name != "Reykjavík"}
    ).compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)

    assert len(result.candidates) == 2
    assert result.excluded[0].label == "Reykjavík"


async def test_a_composite_score_with_a_missing_component_still_ranks() -> None:
    """A missing component contributes nothing rather than a guessed value."""
    partial: Mapping[str, Mapping[Measure, Sequence[float | None]]] = {
        "Lisbon": {
            Measure.TEMPERATURE_MEAN: [19.0, 20.0, 21.0],
            Measure.PRECIPITATION_SUM: [None, None, None],
            Measure.WIND_SPEED_MAX: [14.0, 12.0, 15.0],
        },
        "Berlin": {
            Measure.TEMPERATURE_MEAN: [11.0, 12.0, 11.5],
            Measure.PRECIPITATION_SUM: [2.0, 4.0, 0.0],
            Measure.WIND_SPEED_MAX: [22.0, 25.0, 18.0],
        },
    }
    result = await service(daily=partial).compare_locations(
        (f.LISBON, f.BERLIN), criterion=Criterion.OUTDOOR_SUITABILITY, days=3
    )

    lisbon = next(c for c in result.candidates if c.label == "Lisbon")
    measures = {contribution.measure for contribution in lisbon.contributions}
    assert Measure.PRECIPITATION_SUM not in measures
    unavailable = [s for s in lisbon.supporting if not s.computed]
    assert unavailable, "the gap must stay visible in the supporting results"
    assert unavailable[0].measure is Measure.PRECIPITATION_SUM


async def test_the_ranking_starts_at_one() -> None:
    result = await service().compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=5)
    assert min(candidate.rank for candidate in result.candidates) == 1


async def test_a_comparison_round_trips_through_json() -> None:
    from weathra.domain.comparison import ComparisonResult

    result = await service().compare_locations(
        LOCATIONS, criterion=Criterion.OUTDOOR_SUITABILITY, days=5
    )
    restored = ComparisonResult.model_validate_json(result.model_dump_json())
    assert restored == result


async def test_the_provider_is_never_asked_for_an_over_long_horizon() -> None:
    from weathra.domain.errors import UnsupportedHorizon

    provider = ScriptedProvider(daily=THREE_CITIES)
    built = ComparisonService(provider=provider, settings=provider_settings(), now=NOW)
    with pytest.raises(UnsupportedHorizon):
        await built.compare_locations(LOCATIONS, criterion=Criterion.WARMEST, days=40)
    assert provider.forecast_calls == []


def test_ranking_itself_needs_no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ranking is pure; only retrieval touches the network."""
    import socket

    from weathra.weather.comparison_service import rank, score_candidate

    monkeypatch.setattr(
        socket, "socket", lambda *args, **kwargs: pytest.fail("ranking opened a socket")
    )

    window = period_from_local_dates(f.BERLIN, START, START)
    provenance = Provenance(
        location=f.BERLIN,
        period=window,
        provider="scripted",
        unit_system=UnitSystem.METRIC,
        source_data_class=DataClass.FORECAST,
        retrieved_at=NOW,
    )
    series = f.series({Measure.TEMPERATURE_MEAN: [12.0, 14.0]})
    score, contributions, supporting = score_candidate(
        label="Berlin",
        location=f.BERLIN,
        period=window,
        series=series,
        criterion=Criterion.WARMEST,
        provenance=provenance,
    )
    assert score == pytest.approx(13.0)
    assert contributions == ()
    assert supporting
    assert rank([("Berlin", f.BERLIN, window, score, contributions, supporting)])[0].rank == 1
