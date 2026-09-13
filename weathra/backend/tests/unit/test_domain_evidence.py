"""Task 2.5 — analytics results, comparison candidates, and the evidence record and envelope.

The verification the task asks for is that every model round-trips through JSON without losing a
provenance field, so the round-trip tests here compare the *rehydrated model* against the original
rather than eyeballing a payload.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import BaseModel, ValidationError

from tests import factories as f
from weathra.domain.analytics import (
    AnomalyPoint,
    AnomalyReport,
    Direction,
    PointValue,
    Provenance,
    Statistic,
    StatisticResult,
    TrendDirection,
    TrendReport,
)
from weathra.domain.comparison import (
    ComparisonCandidate,
    ComparisonMode,
    ComparisonResult,
    ComponentContribution,
    Criterion,
    ExcludedCandidate,
)
from weathra.domain.evidence import (
    AgentName,
    AgentStep,
    AnswerEnvelope,
    Attribution,
    EvidenceRecord,
    Finding,
    GroundingReport,
    KnowledgeCitation,
    ResolvedContext,
    StepStatus,
    ToolCall,
    ToolResult,
)
from weathra.domain.location import Location
from weathra.domain.weather import (
    ConfidenceBand,
    DataClass,
    HorizonPoint,
    Measure,
    UncertaintyStatement,
)

MOMENT = datetime(2026, 3, 4, 12, 0, tzinfo=UTC)


def round_trips(model: BaseModel) -> BaseModel:
    """Rehydrate a model from its own JSON and assert nothing was lost."""
    restored = type(model).model_validate_json(model.model_dump_json())
    assert restored == model
    return restored


# =========================================================================== analytics


def test_a_statistic_result_states_everything_needed_to_check_it() -> None:
    result = f.statistic_result(
        statistic=Statistic.MAXIMUM,
        measure=Measure.TEMPERATURE_MAX,
        value=18.4,
        occurred_at=MOMENT,
        points_used=6,
        points_excluded=1,
    )
    assert result.statistic is Statistic.MAXIMUM
    assert result.value == 18.4
    assert result.unit == "°C"
    assert result.method
    assert result.points_used == 6
    assert result.points_excluded == 1
    assert result.data_class is DataClass.COMPUTED_STATISTIC
    assert result.provenance.location.display_name == "Berlin"
    assert result.provenance.provider == "open-meteo"
    assert result.provenance.period.duration_hours == 168.0
    assert result.occurred_at_utc == MOMENT


def test_a_statistic_result_round_trips_without_losing_provenance() -> None:
    restored = round_trips(f.statistic_result(occurred_at=MOMENT))
    assert isinstance(restored, StatisticResult)
    payload = json.loads(restored.model_dump_json())
    for field in (
        "location",
        "period",
        "provider",
        "unit_system",
        "source_data_class",
        "retrieved_at",
    ):
        assert field in payload["provenance"]


def test_a_not_computable_statistic_states_the_reason_and_the_counts() -> None:
    result = f.statistic_result(
        statistic=Statistic.TOTAL,
        measure=Measure.PRECIPITATION_SUM,
        status="not_computable",
        value=None,
        reason="Precipitation needs at least 3 usable points; the series carries 2.",
        points_used=2,
        minimum_points=3,
        unit="mm",
    )
    assert result.computed is False
    assert result.value is None
    assert "at least 3" in (result.reason or "")
    round_trips(result)


def test_a_not_computable_statistic_may_not_carry_a_value() -> None:
    with pytest.raises(ValidationError, match="must not carry a value"):
        f.statistic_result(status="not_computable", value=1.0, reason="too few points")


def test_a_not_computable_statistic_must_state_why() -> None:
    with pytest.raises(ValidationError, match="must state why"):
        f.statistic_result(status="not_computable", value=None)


def test_a_computed_statistic_must_carry_a_value() -> None:
    with pytest.raises(ValidationError, match="carries no value"):
        f.statistic_result(value=None)


def test_a_computed_statistic_cannot_undercut_its_declared_minimum() -> None:
    with pytest.raises(ValidationError, match="declares a minimum"):
        f.statistic_result(points_used=2, minimum_points=3)


def test_a_series_shaped_statistic_carries_timestamped_values() -> None:
    values = tuple(
        PointValue(
            time_utc=MOMENT + timedelta(days=index),
            time_local=(MOMENT + timedelta(days=index)).astimezone(f.BERLIN.zoneinfo),
            value=float(index),
        )
        for index in range(3)
    )
    result = f.statistic_result(
        statistic=Statistic.DAILY_TOTALS,
        measure=Measure.PRECIPITATION_SUM,
        value=None,
        values=values,
        unit="mm",
        points_used=3,
    )
    assert result.values is not None
    assert len(result.values) == 3
    round_trips(result)


def test_a_tied_extreme_records_the_tied_timestamps() -> None:
    later = MOMENT + timedelta(days=1)
    result = f.statistic_result(
        statistic=Statistic.MAXIMUM, occurred_at=MOMENT, tied=True, tied_at=(MOMENT, later)
    )
    assert result.tied is True
    assert result.tied_at == (MOMENT, later)
    assert result.occurred_at_utc == MOMENT  # the earliest of the tied timestamps


def test_a_tied_extreme_must_say_where_it_tied() -> None:
    with pytest.raises(ValidationError, match="must record the tied timestamps"):
        f.statistic_result(tied=True)


def test_provenance_names_retrieved_data_not_another_computed_value() -> None:
    for source in (DataClass.COMPUTED_STATISTIC, DataClass.AI_INTERPRETATION):
        with pytest.raises(ValidationError, match="not another"):
            f.provenance(source_data_class=source)


def test_provenance_accepts_each_retrieved_class() -> None:
    for source in (DataClass.FORECAST, DataClass.CURRENT, DataClass.HISTORICAL_OBSERVATION):
        assert f.provenance(source_data_class=source).source_data_class is source


def _anomaly_report(*, anomalies: tuple[AnomalyPoint, ...] = (), mad: float = 1.2) -> AnomalyReport:
    return AnomalyReport(
        measure=Measure.TEMPERATURE_MAX,
        anomalies=anomalies,
        minimum=f.statistic_result(statistic=Statistic.MINIMUM, value=4.0),
        maximum=f.statistic_result(statistic=Statistic.MAXIMUM, value=22.0),
        method="median absolute deviation, threshold 2.0 MAD",
        threshold=2.0,
        median=11.0,
        median_absolute_deviation=mad,
        unit="°C",
        points_used=7,
        provenance=f.provenance(),
    )


def test_an_anomaly_report_always_carries_the_window_extremes() -> None:
    report = _anomaly_report()
    assert report.found_any is False
    assert report.minimum.value == 4.0
    assert report.maximum.value == 22.0
    assert "median absolute deviation" in report.method
    round_trips(report)


def test_an_anomaly_carries_its_value_deviation_method_and_threshold() -> None:
    point = AnomalyPoint(
        time_utc=MOMENT,
        time_local=MOMENT.astimezone(f.BERLIN.zoneinfo),
        value=27.5,
        deviation=16.5,
        deviation_score=4.1,
    )
    report = _anomaly_report(anomalies=(point,))
    assert report.found_any is True
    assert report.anomalies[0].deviation_score == 4.1
    assert report.threshold == 2.0
    round_trips(report)


def test_a_flat_window_cannot_report_anomalies() -> None:
    """Zero dispersion means there is nothing to judge against — extremes only."""
    point = AnomalyPoint(
        time_utc=MOMENT,
        time_local=MOMENT.astimezone(f.BERLIN.zoneinfo),
        value=11.0,
        deviation=0.0,
        deviation_score=0.0,
    )
    with pytest.raises(ValidationError, match="extremes only"):
        _anomaly_report(anomalies=(point,), mad=0.0)


def _trend(direction: TrendDirection, slope: float, margin: float = 0.5) -> TrendReport:
    return TrendReport(
        measure=Measure.TEMPERATURE_MAX,
        direction=direction,
        slope_per_day=slope,
        magnitude=abs(slope) * 6,
        unit="°C",
        insignificance_margin_per_day=margin,
        method="least-squares slope over the daily series",
        points_used=7,
        minimum_points=3,
        provenance=f.provenance(),
    )


@pytest.mark.parametrize(
    ("direction", "slope"),
    [(TrendDirection.RISING, 1.4), (TrendDirection.FALLING, -1.4), (TrendDirection.STEADY, 0.1)],
)
def test_a_trend_direction_follows_from_its_slope(direction: TrendDirection, slope: float) -> None:
    report = _trend(direction, slope)
    assert report.direction is direction
    round_trips(report)


def test_a_trend_direction_inconsistent_with_its_slope_is_rejected() -> None:
    with pytest.raises(ValidationError, match="is steady, not rising"):
        _trend(TrendDirection.RISING, 0.1)
    with pytest.raises(ValidationError, match="is rising, not falling"):
        _trend(TrendDirection.FALLING, 2.0)


# =========================================================================== comparison


def _contribution(measure: Measure, weight: float, value: float) -> ComponentContribution:
    return ComponentContribution(
        measure=measure,
        value=value,
        unit="°C" if "temperature" in measure.value else "mm",
        direction=Direction.ABOVE if "temperature" in measure.value else Direction.BELOW,
        weight=weight,
        contribution=weight * value,
        supporting=f.statistic_result(measure=measure, value=value),
    )


def _candidate(
    *,
    label: str,
    location: Location,
    rank: int,
    score: float,
    tied: bool = False,
    contributions: tuple[ComponentContribution, ...] = (),
) -> ComparisonCandidate:
    return ComparisonCandidate(
        label=label,
        location=location,
        period=f.daily_period(datetime(2026, 3, 2, tzinfo=UTC), 5, timezone=location.timezone),
        rank=rank,
        score=score,
        tied=tied,
        contributions=contributions,
        supporting=(f.statistic_result(value=score),),
    )


def _comparison(**overrides: object) -> ComparisonResult:
    defaults: dict[str, object] = {
        "mode": ComparisonMode.LOCATIONS,
        "criterion": Criterion.WARMEST,
        "data_class": DataClass.FORECAST,
        "period": f.daily_period(datetime(2026, 3, 2, tzinfo=UTC), 5),
        "unit_system": "metric",
        "provider": "open-meteo",
        "statistics_applied": ("mean of daily maximum temperature",),
        "candidates": (
            _candidate(label="Lisbon", location=f.LISBON, rank=1, score=19.2),
            _candidate(label="Berlin", location=f.BERLIN, rank=2, score=11.4),
            _candidate(label="Reykjavík", location=f.REYKJAVIK, rank=3, score=4.1),
        ),
        "tie_tolerance": 0.1,
    }
    return ComparisonResult(**{**defaults, **overrides})


def test_a_comparison_ranks_every_candidate_with_its_evidence() -> None:
    result = _comparison()
    assert [candidate.label for candidate in result.candidates] == [
        "Lisbon",
        "Berlin",
        "Reykjavík",
    ]
    assert result.winner.label == "Lisbon"
    assert all(candidate.supporting for candidate in result.candidates)
    round_trips(result)


def test_a_comparison_states_its_shared_basis() -> None:
    result = _comparison()
    assert result.provider == "open-meteo"
    assert result.unit_system == "metric"
    assert result.statistics_applied
    assert result.period.duration_hours == 120.0
    assert result.local_time_basis is True


def test_a_location_comparison_needs_at_least_two_candidates() -> None:
    with pytest.raises(ValidationError, match="at least two candidates"):
        _comparison(candidates=(_candidate(label="Berlin", location=f.BERLIN, rank=1, score=1.0),))


def test_a_location_comparison_may_not_rank_one_place_twice() -> None:
    with pytest.raises(ValidationError, match="same place twice"):
        _comparison(
            candidates=(
                _candidate(label="Berlin", location=f.BERLIN, rank=1, score=1.0),
                _candidate(label="Berlin again", location=f.BERLIN, rank=2, score=0.5),
            )
        )


def test_a_day_comparison_ranks_days_at_one_location() -> None:
    result = _comparison(
        mode=ComparisonMode.DAYS,
        criterion=Criterion.DRIEST,
        candidates=(
            _candidate(label="2026-03-02", location=f.BERLIN, rank=1, score=0.0),
            _candidate(label="2026-03-03", location=f.BERLIN, rank=2, score=2.4),
        ),
    )
    assert result.mode is ComparisonMode.DAYS
    assert result.winner.label == "2026-03-02"


def test_a_day_comparison_across_two_places_is_rejected() -> None:
    with pytest.raises(ValidationError, match="exactly one location"):
        _comparison(
            mode=ComparisonMode.DAYS,
            candidates=(
                _candidate(label="a", location=f.BERLIN, rank=1, score=1.0),
                _candidate(label="b", location=f.MUNICH, rank=2, score=2.0),
            ),
        )


def test_tied_candidates_share_a_rank() -> None:
    result = _comparison(
        candidates=(
            _candidate(label="Berlin", location=f.BERLIN, rank=1, score=11.4, tied=True),
            _candidate(label="Munich", location=f.MUNICH, rank=1, score=11.45, tied=True),
        )
    )
    assert {candidate.rank for candidate in result.candidates} == {1}
    assert all(candidate.tied for candidate in result.candidates)


def test_an_excluded_candidate_is_listed_with_its_reason() -> None:
    result = _comparison(
        candidates=(
            _candidate(label="Lisbon", location=f.LISBON, rank=1, score=19.2),
            _candidate(label="Berlin", location=f.BERLIN, rank=2, score=11.4),
        ),
        excluded=(
            ExcludedCandidate(
                label="Reykjavík",
                location=f.REYKJAVIK,
                reason="The provider timed out for this location.",
                code="provider_timeout",
            ),
        ),
    )
    assert result.excluded[0].code == "provider_timeout"
    round_trips(result)


def test_the_composite_criterion_reports_its_component_contributions() -> None:
    contributions = (
        _contribution(Measure.TEMPERATURE_MEAN, 0.5, 19.0),
        _contribution(Measure.PRECIPITATION_SUM, 0.3, 1.2),
        _contribution(Measure.WIND_SPEED_MAX, 0.2, 14.0),
    )
    result = _comparison(
        criterion=Criterion.OUTDOOR_SUITABILITY,
        weighting_disclosure=(
            "The weighting is Weathra's own heuristic, not an authoritative index."
        ),
        candidates=(
            _candidate(
                label="Lisbon",
                location=f.LISBON,
                rank=1,
                score=0.81,
                contributions=contributions,
            ),
            _candidate(
                label="Berlin",
                location=f.BERLIN,
                rank=2,
                score=0.52,
                contributions=contributions,
            ),
        ),
    )
    first = result.candidates[0]
    assert {contribution.measure for contribution in first.contributions} == {
        Measure.TEMPERATURE_MEAN,
        Measure.PRECIPITATION_SUM,
        Measure.WIND_SPEED_MAX,
    }
    assert sum(contribution.weight for contribution in first.contributions) == pytest.approx(1.0)
    assert first.contributions[1].direction is Direction.BELOW  # less rain scores better
    round_trips(result)


def test_the_composite_criterion_must_disclose_its_weighting_as_a_heuristic() -> None:
    contributions = (_contribution(Measure.TEMPERATURE_MEAN, 1.0, 19.0),)
    with pytest.raises(ValidationError, match=r"own\s+heuristic"):
        _comparison(
            criterion=Criterion.OUTDOOR_SUITABILITY,
            candidates=(
                _candidate(
                    label="a", location=f.LISBON, rank=1, score=1.0, contributions=contributions
                ),
                _candidate(
                    label="b", location=f.BERLIN, rank=2, score=0.5, contributions=contributions
                ),
            ),
        )


def test_the_composite_criterion_must_explain_every_candidate() -> None:
    with pytest.raises(ValidationError, match="no component contributions"):
        _comparison(
            criterion=Criterion.OUTDOOR_SUITABILITY,
            weighting_disclosure="Weathra's own heuristic.",
        )


def test_a_comparison_is_computed_from_retrieved_data() -> None:
    with pytest.raises(ValidationError, match="name that data class"):
        _comparison(data_class=DataClass.COMPUTED_STATISTIC)


def test_a_historical_comparison_labels_its_class() -> None:
    assert _comparison(data_class=DataClass.HISTORICAL_OBSERVATION).data_class is (
        DataClass.HISTORICAL_OBSERVATION
    )


def test_every_criterion_is_supported_and_the_composite_is_marked() -> None:
    assert {criterion.value for criterion in Criterion} == {
        "warmest",
        "coolest",
        "driest",
        "wettest",
        "least_windy",
        "outdoor_suitability",
    }
    assert Criterion.OUTDOOR_SUITABILITY.is_composite is True
    assert Criterion.WARMEST.is_composite is False


# =========================================================================== evidence


def test_attribution_states_provider_location_period_and_retrieval_time() -> None:
    attributed = f.attribution()
    assert attributed.provider == "open-meteo"
    assert attributed.location.display_name == "Berlin"
    assert attributed.period is not None
    assert attributed.retrieved_at == f.RETRIEVED_AT
    round_trips(attributed)


def test_attribution_may_cover_a_single_instant() -> None:
    attributed = f.attribution(data_class=DataClass.CURRENT, timestamp=MOMENT)
    assert attributed.timestamp_utc == MOMENT
    assert attributed.period is None


def test_attribution_must_cover_something() -> None:
    with pytest.raises(ValidationError, match="period or the timestamp"):
        Attribution(
            provider="open-meteo",
            location=f.BERLIN,
            data_class=DataClass.FORECAST,
            retrieved_at=f.RETRIEVED_AT,
        )


def test_a_finding_carries_its_class_unit_method_and_attribution() -> None:
    found = f.finding(supporting=f.statistic_result())
    assert found.data_class is DataClass.COMPUTED_STATISTIC
    assert found.unit == "°C"
    assert found.method
    assert found.attribution.provider == "open-meteo"
    assert found.supporting is not None
    round_trips(found)


def test_an_unavailable_finding_states_why_rather_than_reading_as_empty() -> None:
    found = f.finding(
        label="Precipitation probability",
        value=None,
        unit="%",
        method=None,
        points_used=None,
        unavailable_reason="Open-Meteo supplies no probability for the archive series.",
    )
    assert found.value is None
    assert "no probability" in (found.unavailable_reason or "")
    round_trips(found)


def test_a_finding_with_no_value_and_no_reason_is_rejected() -> None:
    with pytest.raises(ValidationError, match="state why it is unavailable"):
        f.finding(value=None)


def test_a_finding_cannot_be_labelled_ai_interpretation() -> None:
    """Model-written content belongs in answer_prose, which is labelled as such."""
    with pytest.raises(ValidationError, match="belongs in"):
        f.finding(data_class=DataClass.AI_INTERPRETATION)


def test_a_tool_result_cannot_be_a_failure_carrying_weather_values() -> None:
    with pytest.raises(ValidationError, match="never presented as data"):
        ToolResult(
            sequence=1,
            tool="weather_forecast",
            ok=False,
            error_code="provider_timeout",
            payload={"temperature": 0.0},
        )


def test_a_failed_tool_result_carries_its_stable_code() -> None:
    with pytest.raises(ValidationError, match="stable error code"):
        ToolResult(sequence=1, tool="weather_forecast", ok=False)


def test_a_successful_tool_result_states_its_data_class() -> None:
    with pytest.raises(ValidationError, match="must state its data class"):
        ToolResult(sequence=1, tool="weather_forecast", ok=True, payload={})


def test_an_evidence_record_carries_the_run_in_order() -> None:
    calls = (
        ToolCall(
            sequence=1,
            tool="weather_forecast",
            agent=AgentName.FORECAST,
            arguments={"location": "Berlin", "days": 7},
            started_at=MOMENT,
            duration_ms=210.0,
        ),
    )
    results = (
        ToolResult(
            sequence=1,
            tool="weather_forecast",
            ok=True,
            data_class=DataClass.FORECAST,
            attribution=f.attribution(),
            payload={"daily": {"temperature_max": [12.0]}},
        ),
    )
    record = f.evidence_record(
        tool_calls=calls,
        tool_results=results,
        analytics_results=(f.statistic_result(),),
        attributions=(f.attribution(),),
    )
    assert record.agents_in_order == (AgentName.SUPERVISOR,)
    assert record.retrieval_happened is True
    assert record.llm_provider == "openrouter"
    assert record.llm_model
    assert record.total_duration_ms == 1_200.0
    round_trips(record)


def test_a_figure_in_the_answer_is_locatable_in_the_record() -> None:
    """specs/agent-orchestration: a reported statistic appears unchanged in the record."""
    computed = f.statistic_result(value=12.5)
    record = f.evidence_record(analytics_results=(computed,))
    assert any(result.value == 12.5 for result in record.analytics_results)


def test_a_record_with_no_retrieval_reports_it() -> None:
    """The hard zero-retrieval guard reads exactly this property."""
    assert f.evidence_record().retrieval_happened is False


def test_a_failed_tool_call_does_not_count_as_retrieval() -> None:
    record = f.evidence_record(
        tool_calls=(
            ToolCall(
                sequence=1,
                tool="weather_forecast",
                agent=AgentName.FORECAST,
                started_at=MOMENT,
                duration_ms=1.0,
            ),
        ),
        tool_results=(
            ToolResult(
                sequence=1, tool="weather_forecast", ok=False, error_code="provider_unavailable"
            ),
        ),
    )
    assert record.retrieval_happened is False


def test_a_tool_result_with_no_matching_call_is_rejected() -> None:
    with pytest.raises(ValidationError, match="no matching call"):
        f.evidence_record(
            tool_results=(
                ToolResult(
                    sequence=9, tool="weather_forecast", ok=True, data_class=DataClass.FORECAST
                ),
            )
        )


def test_agent_steps_must_be_recorded_in_execution_order() -> None:
    steps = (
        AgentStep(
            sequence=2,
            agent=AgentName.FORECAST,
            status=StepStatus.SUCCEEDED,
            started_at=MOMENT,
            duration_ms=1.0,
        ),
        AgentStep(
            sequence=1,
            agent=AgentName.SUPERVISOR,
            status=StepStatus.SUCCEEDED,
            started_at=MOMENT,
            duration_ms=1.0,
        ),
    )
    with pytest.raises(ValidationError, match="execution order"):
        f.evidence_record(agents=steps)


# =========================================================================== logical stages


def _step(sequence: int, agent: AgentName, status: StepStatus = StepStatus.SUCCEEDED) -> AgentStep:
    return AgentStep(
        sequence=sequence,
        agent=agent,
        status=status,
        started_at=MOMENT + timedelta(seconds=sequence),
        duration_ms=float(sequence * 10),
    )


def test_the_retrieval_agents_are_actions_of_one_stage_rather_than_stages_of_their_own() -> None:
    """A reading of now, a projection and an imagery pass are one part of the pipeline.

    They stay three agents, three tool calls and three source rows, because they are three claims
    under three data classes. What they are not is three *stages*: a reader asking which parts of
    the pipeline ran is asking about retrieval, and the record now answers at that altitude.
    """
    record = f.evidence_record(
        agents=(
            _step(1, AgentName.SUPERVISOR),
            _step(2, AgentName.CURRENT),
            _step(3, AgentName.FORECAST),
            _step(4, AgentName.SATELLITE),
            _step(5, AgentName.SYNTHESIS),
        )
    )

    assert [stage.agent for stage in record.stages] == [
        AgentName.SUPERVISOR,
        AgentName.FORECAST,
        AgentName.SYNTHESIS,
    ]
    retrieval = record.stages[1]
    assert [action.agent for action in retrieval.actions] == [
        AgentName.CURRENT,
        AgentName.FORECAST,
        AgentName.SATELLITE,
    ]
    # Nothing is merged: the action log still holds every turn that was taken.
    assert len(record.agents) == 5


def test_an_agent_that_ran_twice_is_one_stage_that_did_two_things() -> None:
    """Two archive windows are two actions. Counting them as two stages gave the wrong number."""
    record = f.evidence_record(
        agents=(
            _step(1, AgentName.SUPERVISOR),
            _step(2, AgentName.HISTORICAL),
            _step(3, AgentName.ANALYTICS),
            _step(4, AgentName.HISTORICAL),
            _step(5, AgentName.ANALYTICS),
            _step(6, AgentName.SYNTHESIS),
        )
    )

    assert [stage.agent for stage in record.stages] == [
        AgentName.SUPERVISOR,
        AgentName.HISTORICAL,
        AgentName.ANALYTICS,
        AgentName.SYNTHESIS,
    ]
    # Ordered by when the stage *first* ran, not by when it last did.
    assert len(record.stages[1].actions) == 2
    # What the stage cost the run is the sum of what its actions cost.
    assert record.stages[1].duration_ms == 20.0 + 40.0


def test_a_stage_reports_the_worst_of_its_actions_rather_than_the_last() -> None:
    """A stage with one failed retrieval did not succeed, however the other one went."""
    record = f.evidence_record(
        agents=(
            _step(1, AgentName.SUPERVISOR),
            _step(2, AgentName.HISTORICAL, StepStatus.FAILED),
            _step(3, AgentName.HISTORICAL, StepStatus.SUCCEEDED),
        )
    )

    assert record.stages[1].status is StepStatus.FAILED


def test_the_stage_of_an_action_cannot_be_talked_into_disagreeing_with_its_agent() -> None:
    """Derived on the way in, so a stored record cannot contradict itself.

    The record is written to JSON and read back, so a supplied `stage` is not a hint — it is a
    value that would outlive the mapping that should have produced it.
    """
    step = AgentStep.model_validate(
        {
            "sequence": 1,
            "agent": AgentName.CURRENT.value,
            "status": StepStatus.SUCCEEDED.value,
            "started_at": MOMENT,
            "duration_ms": 1.0,
            "stage": AgentName.SYNTHESIS.value,
        }
    )
    assert step.stage is AgentName.FORECAST


def test_the_stages_survive_the_round_trip_a_stored_record_actually_makes() -> None:
    """Persisted as JSON, read back, and still the same record — including its derived parts."""
    record = f.evidence_record(
        agents=(
            _step(1, AgentName.SUPERVISOR),
            _step(2, AgentName.CURRENT),
            _step(3, AgentName.FORECAST),
            _step(4, AgentName.SYNTHESIS),
        )
    )
    restored = round_trips(record)
    assert isinstance(restored, EvidenceRecord)
    assert [stage.agent for stage in restored.stages] == [
        AgentName.SUPERVISOR,
        AgentName.FORECAST,
        AgentName.SYNTHESIS,
    ]


def test_a_computed_source_names_the_retrievals_it_was_computed_over() -> None:
    """The analytics row is a source, and a derived one says what it derives from."""
    retrieved = f.attribution(data_class=DataClass.HISTORICAL_OBSERVATION)
    computed = Attribution(
        **{
            **retrieved.model_dump(),
            "provider": "weathra-analytics",
            "data_class": DataClass.COMPUTED_STATISTIC,
            "derived_from": ("open-meteo historical_observation",),
        }
    )
    assert computed.derived_from == ("open-meteo historical_observation",)
    round_trips(computed)


def test_a_retrieved_source_derives_from_nothing_because_it_is_the_origin() -> None:
    assert f.attribution().derived_from == ()


def test_a_partial_run_retains_its_evidence_and_names_the_bound() -> None:
    record = f.evidence_record(
        analytics_results=(f.statistic_result(),),
        partial=True,
        partial_reason="The step budget of 24 was exhausted before synthesis.",
    )
    assert record.partial is True
    assert "step budget" in (record.partial_reason or "")
    assert record.analytics_results


def test_a_partial_run_must_state_which_bound_it_hit() -> None:
    with pytest.raises(ValidationError, match="which bound"):
        f.evidence_record(partial=True)


def test_a_record_cannot_complete_before_it_started() -> None:
    base = f.evidence_record()
    with pytest.raises(ValidationError, match="cannot complete before"):
        EvidenceRecord(
            **{**base.model_dump(), "completed_at": base.started_at - timedelta(seconds=1)}
        )


def test_a_verified_grounding_report_lists_nothing_ungrounded() -> None:
    report = f.grounding_report()
    assert report.verified is True
    assert report.ungrounded_figures == ()
    round_trips(report)


def test_an_ungrounded_figure_is_reported_rather_than_suppressing_the_answer() -> None:
    report = f.grounding_report(verified=False, ungrounded=("21.5 °C",))
    assert report.verified is False
    assert report.ungrounded_figures == ("21.5 °C",)
    assert report.prose_discarded is False


def test_a_verified_report_cannot_list_ungrounded_figures() -> None:
    with pytest.raises(ValidationError, match="cannot list ungrounded figures"):
        GroundingReport(
            verified=True,
            method="numeric extraction",
            figures_checked=1,
            ungrounded_figures=("21.5 °C",),
        )


def test_an_unverified_report_must_say_what_failed() -> None:
    with pytest.raises(ValidationError, match="must say what was unmatched"):
        GroundingReport(verified=False, method="numeric extraction", figures_checked=0)


def test_the_hard_guard_case_is_representable() -> None:
    report = f.grounding_report(
        verified=False,
        figures_checked=2,
        prose_discarded=True,
        note="No weather tool was called during this request, so the prose was withheld.",
    )
    assert report.prose_discarded is True


# --------------------------------------------------------------------------- the envelope


def _uncertainty() -> UncertaintyStatement:
    return UncertaintyStatement(
        provider="open-meteo",
        reference_time_utc=f.RETRIEVED_AT,
        horizon=(
            HorizonPoint(
                time_utc=MOMENT,
                time_local=MOMENT.astimezone(f.BERLIN.zoneinfo),
                hours_ahead=72.0,
                confidence=ConfidenceBand.MODERATE,
            ),
        ),
        spread_available=False,
        basis=(
            "Confidence decreases with distance into the horizon. This signal is derived from "
            "horizon distance and Open-Meteo's own output only; it is not a multi-provider "
            "consensus."
        ),
    )


def _envelope(**overrides: object) -> AnswerEnvelope:
    findings = (f.finding(supporting=f.statistic_result()),)
    defaults: dict[str, object] = {
        "request_id": "req-1",
        "answer_prose": "Next week in Berlin averages 12.5 °C at its daily maximum.",
        "findings": findings,
        "uncertainty": _uncertainty(),
        "attribution": (f.attribution(),),
        "resolved": ResolvedContext(
            locations=(f.BERLIN,),
            period=f.daily_period(datetime(2026, 3, 2, tzinfo=UTC), 7),
            unit_system="metric",
            location_source="request",
            statement="Resolved to Berlin, 2 to 9 March, in metric units.",
        ),
        "grounding": f.grounding_report(),
        "evidence": f.evidence_record(analytics_results=(f.statistic_result(),)),
        "llm_provider": "openrouter",
        "llm_model": "nvidia/nemotron-nano-9b-v2:free",
    }
    return AnswerEnvelope(**{**defaults, **overrides})


def test_the_envelope_carries_every_field_decision_14_names() -> None:
    envelope = _envelope()
    assert envelope.answer_prose
    assert envelope.prose_data_class is DataClass.AI_INTERPRETATION
    assert envelope.findings
    assert envelope.uncertainty is not None
    assert envelope.attribution
    assert envelope.grounding.verified is True
    assert envelope.evidence.request_id == "req-1"
    assert envelope.llm_model
    round_trips(envelope)


def test_the_prose_is_structurally_distinguishable_from_the_data() -> None:
    """specs/safety-grounding: interpretation is a separate, labelled field, not mixed in."""
    payload = json.loads(_envelope().model_dump_json())
    assert payload["prose_data_class"] == "ai_interpretation"
    assert payload["findings"][0]["data_class"] == "computed_statistic"
    assert "answer_prose" in payload
    assert isinstance(payload["findings"], list)


def test_an_answer_that_retrieved_data_must_carry_its_findings() -> None:
    with pytest.raises(ValidationError, match="must carry the findings"):
        _envelope(findings=(), attribution=())


def test_a_weather_bearing_answer_must_carry_structured_attribution() -> None:
    with pytest.raises(ValidationError, match="structured fields"):
        _envelope(attribution=())


def test_a_clarifying_question_is_a_legitimate_answer_with_no_findings() -> None:
    envelope = _envelope(
        answer_prose="",
        findings=(),
        attribution=(),
        uncertainty=None,
        clarification_question="Which location did you mean?",
        evidence=f.evidence_record(),
        grounding=f.grounding_report(
            verified=False, figures_checked=0, note="No figures were stated."
        ),
    )
    assert envelope.clarification_question
    assert envelope.findings == ()


def test_unanswered_parts_are_named_rather_than_dropped() -> None:
    envelope = _envelope(
        unanswered_parts=("How accurate were last week's forecasts?",),
    )
    assert envelope.unanswered_parts == ("How accurate were last week's forecasts?",)


def test_the_uncertainty_statement_discloses_its_basis_and_single_provider() -> None:
    statement = _uncertainty()
    assert statement.multi_provider_consensus is False
    assert "not a multi-provider consensus" in statement.basis
    assert statement.confidence_at(MOMENT) is ConfidenceBand.MODERATE
    assert statement.spread_available is False
    round_trips(statement)


def test_a_spread_flag_and_its_payload_must_agree() -> None:
    with pytest.raises(ValidationError, match="no provider spread is carried"):
        UncertaintyStatement(
            provider="open-meteo",
            reference_time_utc=f.RETRIEVED_AT,
            spread_available=True,
            basis="Horizon distance only.",
        )


def test_a_citation_carries_its_document_identity_and_score() -> None:
    citation = KnowledgeCitation(
        document_id="dew-point",
        title="Dew point",
        topic="humidity",
        chunk_position=0,
        score=0.82,
        text="The dew point is the temperature at which air becomes saturated.",
    )
    assert citation.document_id == "dew-point"
    round_trips(citation)


def test_every_agent_in_the_execution_record_is_separately_identifiable() -> None:
    assert {agent.value for agent in AgentName} == {
        "supervisor",
        # Its own name rather than a branch of "forecast": what a provider reports for now and what
        # it projects for the days ahead are two claims under two data classes, and a record that
        # credited both to one agent could not say which of them was retrieved (task 34.33).
        "current",
        # Observational imagery is its own agent: a picture of a region at a time supports
        # different claims from a provider's figure for a place (task 34.34).
        "satellite",
        "forecast",
        "historical",
        "analytics",
        "rag",
        "synthesis",
    }


def test_no_evidence_model_declares_a_credential_field() -> None:
    """The no-secrets-in-evidence rule, as a property of the types."""
    forbidden = {"token", "access_token", "api_key", "secret", "password", "authorization"}
    for model in (
        Attribution,
        Finding,
        ToolCall,
        ToolResult,
        AgentStep,
        KnowledgeCitation,
        GroundingReport,
        EvidenceRecord,
        AnswerEnvelope,
        ResolvedContext,
        Provenance,
        StatisticResult,
    ):
        names = {name.lower() for name in model.model_fields}
        assert not (names & forbidden), f"{model.__name__} declares {names & forbidden}"
