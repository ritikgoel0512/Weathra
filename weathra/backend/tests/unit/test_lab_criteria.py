"""Task 32.7 and 32.3 — the five criteria, and the bounds, without a database.

What can be proved here is everything that is arithmetic or refusal. The criteria are pure
functions over recorded outcomes, and the bounds are checks that must fire before anything runs —
neither needs a gateway, and proving them against one would prove less, not more.

The negative controls matter more than usual in this file. A criteria module that returned a
plausible default for an unmeasured criterion would pass every positive test and quietly promote
a model on evidence nobody produced.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from weathra.config import Settings
from weathra.domain.errors import ValidationFailed
from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.evaluation.cases import Category, EvaluationCase
from weathra.evaluation.criteria import GATING_CRITERIA, compute_criteria
from weathra.evaluation.metrics import CaseOutcome, compute_metrics
from weathra.lab.compare import AD_HOC_CASE_ID, LabRunner


def settings_for(**overrides: object) -> Settings:
    return Settings(
        supabase_url="https://test.supabase.co",
        database_url="postgresql+asyncpg://u:p@localhost/weathra",
        **overrides,  # type: ignore[arg-type]
    )


def routing(
    attempt_number: int, status: InferenceStatus, latency: float = 100.0
) -> InferenceAttempt:
    return InferenceAttempt(
        stage=InferenceStage.ROUTING,
        attempt_number=attempt_number,
        status=status,
        provider="openrouter",
        selected_model="a/model",
        latency_ms=latency,
    )


def synthesis(latency: float = 400.0) -> InferenceAttempt:
    return InferenceAttempt(
        stage=InferenceStage.SYNTHESIS,
        attempt_number=1,
        status=InferenceStatus.SERVED,
        provider="openrouter",
        selected_model="a/model",
        latency_ms=latency,
    )


def outcome(case_id: str, *attempts: InferenceAttempt, latency: float = 900.0) -> CaseOutcome:
    return CaseOutcome(
        case_id=case_id,
        category=Category.CURRENT_AND_FORECAST,
        answer="Berlin looks mild.",
        latency_ms=latency,
        inference_attempts=attempts,
    )


def case(case_id: str, *tools: str) -> EvaluationCase:
    return EvaluationCase(
        case_id=case_id,
        category=Category.CURRENT_AND_FORECAST,
        description="A fixture case.",
        question="What is the forecast for Berlin?",
        expected_tools=tools,
    )


def criteria_over(outcomes: list[CaseOutcome], cases: list[EvaluationCase], **prices: object):  # type: ignore[no-untyped-def]
    return compute_criteria(
        catalog_key="standard-general",
        gateway_model="a/model",
        outcomes=outcomes,
        cases=cases,
        metrics=compute_metrics(outcomes, cases),
        **prices,  # type: ignore[arg-type]
    )


# =========================================================================== 32.7 the five


def test_all_five_criteria_are_reported_for_every_candidate() -> None:
    """`specs/evaluation`: a result reports all five. Not "the ones that applied"."""
    computed = criteria_over(
        [outcome("a", routing(1, InferenceStatus.SERVED), synthesis())], [case("a")]
    )

    assert computed.structured_json_reliability is not None
    assert computed.groundedness is not None
    assert computed.latency is not None
    assert computed.planning is not None
    assert computed.cost is not None


def test_a_decision_valid_first_time_reads_as_one_attempt() -> None:
    computed = criteria_over(
        [
            outcome("a", routing(1, InferenceStatus.SERVED)),
            outcome("b", routing(1, InferenceStatus.SERVED)),
        ],
        [case("a"), case("b")],
    )
    reliability = computed.structured_json_reliability
    assert reliability.first_attempt_valid_rate == 1.0
    assert reliability.mean_attempts_to_valid == 1.0
    assert reliability.decisions == 2


def test_a_retried_decision_lowers_the_rate_and_raises_the_mean() -> None:
    """The two halves say different things: how often it is right first time, and what being
    wrong costs."""
    computed = criteria_over(
        [
            outcome("a", routing(1, InferenceStatus.SERVED)),
            outcome(
                "b",
                routing(1, InferenceStatus.INVALID_OUTPUT),
                routing(2, InferenceStatus.INVALID_OUTPUT),
                routing(3, InferenceStatus.SERVED),
            ),
        ],
        [case("a"), case("b")],
    )
    reliability = computed.structured_json_reliability
    assert reliability.first_attempt_valid_rate == 0.5
    assert reliability.mean_attempts_to_valid == 2.0
    assert reliability.decisions == 2
    assert reliability.attempts == 4


def test_a_candidate_asked_no_structured_question_reports_null_rather_than_perfect() -> None:
    """The control that matters. A default of 1.0 here would promote a model on silence."""
    computed = criteria_over([outcome("a", synthesis())], [case("a")])
    assert computed.structured_json_reliability.first_attempt_valid_rate is None
    assert computed.structured_json_reliability.decisions == 0


def test_latency_is_reported_per_call_role_and_overall() -> None:
    computed = criteria_over(
        [
            outcome(
                "a", routing(1, InferenceStatus.SERVED, 100.0), synthesis(500.0), latency=800.0
            ),
            outcome(
                "b", routing(1, InferenceStatus.SERVED, 300.0), synthesis(700.0), latency=1200.0
            ),
        ],
        [case("a"), case("b")],
    )
    latency = computed.latency
    assert latency.overall_median_ms is not None
    assert set(latency.by_call_role) == {"routing", "synthesis"}
    assert latency.by_call_role["routing"]["samples"] == 2.0
    assert (
        latency.by_call_role["routing"]["median_ms"]
        <= latency.by_call_role["synthesis"]["median_ms"]
    )


def test_a_failed_attempt_contributes_no_latency_sample() -> None:
    """A call that did not answer has no latency to report, and averaging its timeout in would
    describe the model as slower rather than as broken."""
    computed = criteria_over(
        [
            outcome(
                "a",
                routing(1, InferenceStatus.INVALID_OUTPUT, 30_000.0),
                routing(2, InferenceStatus.SERVED, 100.0),
            )
        ],
        [case("a")],
    )
    assert computed.latency.by_call_role["routing"]["samples"] == 1.0
    assert computed.latency.by_call_role["routing"]["median_ms"] == 100.0


def test_plan_order_is_measured_on_multi_step_cases_only() -> None:
    """`specs/evaluation`: whether the planned capabilities *and their order* matched."""
    ordered = outcome("multi", routing(1, InferenceStatus.SERVED))
    ordered = ordered.model_copy(update={"tools_called": ("weather_forecast", "weather_history")})
    reversed_ = outcome("multi2", routing(1, InferenceStatus.SERVED))
    reversed_ = reversed_.model_copy(
        update={"tools_called": ("weather_history", "weather_forecast")}
    )

    computed = criteria_over(
        [ordered, reversed_, outcome("single")],
        [
            case("multi", "weather_forecast", "weather_history"),
            case("multi2", "weather_forecast", "weather_history"),
            case("single", "weather_forecast"),
        ],
    )
    planning = computed.planning
    assert planning.multi_step_cases == 2, "a single-tool case is not a plan"
    assert planning.plan_correctness == 0.5
    assert planning.plan_order_correct == ("multi",)
    assert planning.plan_order_incorrect == ("multi2",)


def test_plan_correctness_is_null_where_no_multi_step_case_ran() -> None:
    computed = criteria_over([outcome("single")], [case("single", "weather_forecast")])
    assert computed.planning.plan_correctness is None
    assert computed.planning.multi_step_cases == 0


def test_cost_is_null_when_no_price_is_supplied_rather_than_zero() -> None:
    """A candidate whose pricing nobody recorded has not been shown to be free."""
    computed = criteria_over([outcome("a")], [case("a")])
    assert computed.cost.estimated_total is None
    assert computed.cost.is_estimate is True


def test_cost_is_null_when_the_gateway_reported_no_tokens() -> None:
    """The second half of the same rule: a price with nothing to price is still unmeasured."""
    computed = criteria_over(
        [outcome("a")],
        [case("a")],
        input_price_per_million=Decimal("0.5"),
        output_price_per_million=Decimal("1.5"),
    )
    assert computed.cost.estimated_total is None
    assert computed.cost.currency == "USD"


def test_cost_is_always_labelled_an_estimate() -> None:
    """`specs/usage-limits`: estimated cost is never presented as an amount owed."""
    assert criteria_over([outcome("a")], [case("a")]).cost.is_estimate is True


# =========================================================================== the gates


def test_only_reliability_and_groundedness_gate_a_promotion() -> None:
    """Latency and cost are reported and never block. That asymmetry is the requirement."""
    assert set(GATING_CRITERIA) == {"structured_json_reliability", "groundedness"}


def test_a_candidate_that_was_never_asked_a_structured_question_is_blocked() -> None:
    """An unmeasured gate blocks. Treating silence as a pass would let a subset run promote a
    model on evidence it never produced."""
    computed = criteria_over([outcome("a", synthesis())], [case("a")])
    assert "structured_json_reliability" in computed.promotion_blockers()


def test_an_unreliable_candidate_is_blocked_however_fast_it_is() -> None:
    computed = criteria_over(
        [
            outcome(
                "a",
                routing(1, InferenceStatus.INVALID_OUTPUT, 1.0),
                routing(2, InferenceStatus.SERVED, 1.0),
            ),
            outcome(
                "b",
                routing(1, InferenceStatus.INVALID_OUTPUT, 1.0),
                routing(2, InferenceStatus.SERVED, 1.0),
            ),
        ],
        [case("a"), case("b")],
    )
    assert computed.structured_json_reliability.first_attempt_valid_rate == 0.0
    assert "structured_json_reliability" in computed.promotion_blockers()


# =========================================================================== 32.3 the bounds


def test_too_many_models_is_refused_naming_the_bound() -> None:
    runner = LabRunner(settings_for(model_lab_max_models=2))
    with pytest.raises(ValidationFailed) as caught:
        runner.plan(candidates=[_entry(f"m{index}") for index in range(3)], question="Berlin?")

    assert caught.value.details["bound"] == "model_lab_max_models"
    assert caught.value.details["limit"] == 2
    assert caught.value.details["requested"] == 3


def test_too_many_cases_is_refused_naming_the_bound() -> None:
    runner = LabRunner(settings_for(model_lab_max_cases=1))
    with pytest.raises(ValidationFailed) as caught:
        runner.plan(candidates=[_entry("m0")], category="current_and_forecast")

    assert caught.value.details["bound"] == "model_lab_max_cases"


def test_a_comparison_with_no_candidate_is_refused() -> None:
    with pytest.raises(ValidationFailed):
        LabRunner(settings_for()).plan(candidates=[], question="Berlin?")


def test_a_comparison_runs_a_question_or_a_dataset_selection_and_not_both() -> None:
    """Two incomparable halves under one run identifier would leave a reader unable to tell which
    half a figure came from."""
    runner = LabRunner(settings_for())
    with pytest.raises(ValidationFailed):
        runner.plan(candidates=[_entry("m0")], question="Berlin?", category="current_and_forecast")
    with pytest.raises(ValidationFailed):
        runner.plan(candidates=[_entry("m0")])


def test_an_ad_hoc_plan_names_one_case_and_no_dataset_version() -> None:
    plan = LabRunner(settings_for()).plan(candidates=[_entry("m0")], question="Berlin?")
    assert plan.case_ids == (AD_HOC_CASE_ID,)
    assert plan.dataset_version is None
    assert plan.question == "Berlin?"


def test_a_dataset_plan_fixes_the_cases_once_for_every_candidate() -> None:
    """The selection is the comparison's, not each candidate's — which is what makes them
    comparable rather than merely simultaneous."""
    plan = LabRunner(settings_for()).plan(
        candidates=[_entry("m0"), _entry("m1")], category="knowledge"
    )
    assert plan.dataset_version is not None
    assert plan.question is None
    assert len(plan.case_ids) >= 1
    assert plan.cells == 2 * len(plan.case_ids)


def test_an_unknown_category_is_refused_with_the_known_ones_named() -> None:
    with pytest.raises(ValidationFailed) as caught:
        LabRunner(settings_for()).plan(candidates=[_entry("m0")], category="nonsense")
    assert "known" in caught.value.details


def _entry(catalog_key: str):  # type: ignore[no-untyped-def]
    from datetime import date

    from weathra.entitlements.records import CapabilityTier, CatalogEntry, CatalogStatus

    return CatalogEntry(
        catalog_key=catalog_key,
        gateway_provider="openrouter",
        gateway_model=f"vendor/{catalog_key}",
        display_name=catalog_key,
        capability_roles=("routing", "synthesis"),
        capability_tier=CapabilityTier.STANDARD,
        supports_structured_output=True,
        context_window=8_000,
        input_price_per_million=Decimal("0.1"),
        output_price_per_million=Decimal("0.2"),
        price_currency="USD",
        pricing_recorded_on=date(2026, 9, 9),
        status=CatalogStatus.ENABLED,
        is_free_tier=False,
    )
