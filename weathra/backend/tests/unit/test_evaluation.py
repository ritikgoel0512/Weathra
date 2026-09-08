"""Tasks 22.1, 22.3, 22.4 — the dataset's composition, the ten metrics, and the thresholds.

The metric tests run over *synthetic* outcomes rather than real runs, deliberately: a metric is a
definition, and the way to check a definition is to feed it a case you constructed to have a known
answer. A test that ran the pipeline and asserted "the metric came out at 100%" would be testing
the pipeline and would pass for a metric that always returned 1.0.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.evaluation.cases import (
    DATASET_DIRECTORY,
    DATASET_VERSION,
    MINIMUM_PER_CATEGORY,
    REQUIRED_CATEGORIES,
    Category,
    EvaluationCase,
    composition,
    load_dataset,
)
from weathra.evaluation.integrity import InferenceIntegrity, RunOutcome, assess_integrity
from weathra.evaluation.metrics import (
    METRIC_NAMES,
    CaseOutcome,
    MetricName,
    MetricsReport,
    compute_metrics,
    figures_in,
)
from weathra.evaluation.provisioning import EvaluationMode
from weathra.evaluation.thresholds import GATED_METRICS, THRESHOLDS, evaluate_thresholds

# =========================================================================== 22.1 the dataset


def test_the_dataset_has_about_forty_cases() -> None:
    cases = load_dataset()
    assert 35 <= len(cases) <= 50, f"the dataset has {len(cases)} cases; the spec asks for ~40"


def test_every_required_category_has_at_least_four_cases() -> None:
    counts = composition()
    for category in REQUIRED_CATEGORIES:
        assert counts[category] >= MINIMUM_PER_CATEGORY, (
            f"{category.value} has {counts[category]} cases; at least "
            f"{MINIMUM_PER_CATEGORY} are required"
        )


def test_the_dataset_is_data_files_rather_than_test_literals() -> None:
    """``specs/evaluation``: structured data in the repository, not literals inside test code.

    Asserted by locating the files, because the requirement is about *where the dataset lives* —
    a dataset only a test file contains cannot be diffed or reviewed as the artifact it is.
    """
    files = sorted(DATASET_DIRECTORY.glob("*.json"))
    assert files, f"no dataset files under {DATASET_DIRECTORY}"
    assert len(files) >= len(REQUIRED_CATEGORIES) - 1, "the cases are spread across data files"

    for path in files:
        payload = json.loads(path.read_text())
        assert isinstance(payload, dict | list), f"{path.name} is not structured data"

    # And the dataset itself is not in this file: every case identifier the run scores comes from
    # a data file, which the loader is the only reader of.
    loaded = {case.case_id for case in load_dataset()}
    own_source = Path(__file__).read_text()
    for identifier in loaded:
        assert identifier not in own_source, (
            f"{identifier} appears in this test file; the dataset must live in its data files"
        )


@pytest.mark.parametrize("case", load_dataset(), ids=lambda case: case.case_id)
def test_every_case_declares_its_expectations(case: EvaluationCase) -> None:
    """Identifier, category, question, tools, and answer characteristics — for every case."""
    assert case.case_id
    assert case.category in REQUIRED_CATEGORIES
    assert case.description, "a failure names this, so it has to say what the case is for"
    assert case.questions, "a case with no question cannot be run"

    # A case must declare *something* about what it expects, or it scores nothing.
    declares_something = bool(
        case.expected_tools
        or case.expected_agents
        or case.forbidden_tools
        or case.expected_answer_characteristics
        or case.forbidden_answer_characteristics
        or case.reference
        or case.relevant_documents
        or case.expected_resolution
        or case.expects_clarification
        or case.expects_refusal
        or case.turns
    )
    assert declares_something, f"{case.case_id} declares no expectation and cannot fail"


@pytest.mark.parametrize(
    "case", [case for case in load_dataset() if case.is_multi_turn], ids=lambda case: case.case_id
)
def test_every_multi_turn_case_declares_per_turn_resolution(case: EvaluationCase) -> None:
    """``specs/evaluation``: a multi-turn case says what each turn's references resolve to."""
    for index, turn in enumerate(case.turns, start=1):
        assert turn.expected_resolution is not None or turn.expects_clarification, (
            f"{case.case_id} turn {index} declares neither a resolution nor a clarification"
        )


@pytest.mark.parametrize(
    "case",
    [case for case in load_dataset() if case.reference is not None],
    ids=lambda case: case.case_id,
)
def test_a_numeric_case_declares_a_computation_rather_than_a_number(
    case: EvaluationCase,
) -> None:
    """The reference is *computed* over the run's own data, not typed into the dataset.

    A hard-coded expectation would have to be edited every time a fixture was re-recorded, and the
    edit would look like a passing test.
    """
    assert case.reference is not None
    assert case.reference.statistic
    assert case.reference.measure


def test_a_knowledge_case_names_the_documents_it_expects() -> None:
    for case in load_dataset():
        if case.category is not Category.KNOWLEDGE:
            continue
        assert case.relevant_documents or case.expects_refusal, (
            f"{case.case_id} could not be scored for retrieval quality"
        )


def test_case_identifiers_are_unique_and_stable() -> None:
    identifiers = [case.case_id for case in load_dataset()]
    assert len(set(identifiers)) == len(identifiers)
    assert all(identifier == identifier.lower() for identifier in identifiers)


def test_a_case_with_both_a_question_and_turns_is_refused() -> None:
    with pytest.raises(ValueError, match="one or the other"):
        EvaluationCase.model_validate(
            {
                "case_id": "bad-case",
                "category": "historical",
                "description": "declares both shapes",
                "question": "one question",
                "turns": [{"question": "another"}],
            }
        )


def test_a_multi_turn_case_with_no_declared_resolution_is_refused() -> None:
    """Enforced at load time: a memory case with nothing to compare would pass vacuously."""
    with pytest.raises(ValueError, match="declare no expected resolution"):
        EvaluationCase.model_validate(
            {
                "case_id": "bad-memory",
                "category": "memory",
                "description": "says nothing about what its turns resolve to",
                "turns": [{"question": "first"}, {"question": "second"}],
            }
        )


def test_the_dataset_declares_a_version() -> None:
    """Recorded on every run, so a cross-run comparison can flag a dataset difference."""
    assert DATASET_VERSION
    assert DATASET_VERSION.count(".") == 2, "a semantic version, so a change is legible"


# =========================================================================== 22.3 the metrics


def _outcome(case_id: str, category: Category, **overrides: object) -> CaseOutcome:
    values: dict[str, object] = {
        "case_id": case_id,
        "category": category,
        "answer": "",
        "http_status": 200,
        "schema_valid": True,
    }
    values.update(overrides)
    return CaseOutcome.model_validate(values)


def _case(case_id: str, category: Category, **overrides: object) -> EvaluationCase:
    """A synthetic case with a known answer, for checking a metric's definition.

    A case is a question *or* a turn sequence, never both, so supplying ``turns`` drops the default
    question rather than colliding with it.
    """
    values: dict[str, object] = {
        "case_id": case_id,
        "category": category,
        "description": "a synthetic case with a known answer",
    }
    if "turns" not in overrides:
        values["question"] = "a question"
    values.update(overrides)
    return EvaluationCase.model_validate(values)


def test_every_metric_the_specification_names_is_computed() -> None:
    case = _case("a-case", Category.HISTORICAL, expected_tools=["weather_history"])
    report = compute_metrics([_outcome("a-case", Category.HISTORICAL)], [case])
    assert set(report.results) == {name.value for name in METRIC_NAMES}


def test_every_metric_reports_its_numerator_denominator_and_failing_cases() -> None:
    case = _case("a-case", Category.HISTORICAL, expected_tools=["weather_history"])
    report = compute_metrics([_outcome("a-case", Category.HISTORICAL)], [case])

    result = report.result(MetricName.TOOL_SELECTION_ACCURACY)
    assert result.denominator == 1
    assert result.numerator == 0, "the expected tool was not called"
    assert result.failing_cases == ("a-case",)


def test_tool_selection_passes_when_expected_called_and_forbidden_not() -> None:
    case = _case(
        "a-case",
        Category.HISTORICAL,
        expected_tools=["weather_history"],
        forbidden_tools=["weather_forecast"],
    )
    report = compute_metrics(
        [_outcome("a-case", Category.HISTORICAL, tools_called=("weather_history",))], [case]
    )
    assert report.result(MetricName.TOOL_SELECTION_ACCURACY).value == 1.0


def test_tool_selection_fails_on_a_forbidden_tool_even_if_the_expected_one_ran() -> None:
    case = _case(
        "a-case",
        Category.HISTORICAL,
        expected_tools=["weather_history"],
        forbidden_tools=["weather_forecast"],
    )
    report = compute_metrics(
        [
            _outcome(
                "a-case",
                Category.HISTORICAL,
                tools_called=("weather_history", "weather_forecast"),
            )
        ],
        [case],
    )
    assert report.result(MetricName.TOOL_SELECTION_ACCURACY).value == 0.0


def test_numerical_accuracy_passes_within_the_stated_tolerance() -> None:
    case = _case(
        "num-case",
        Category.ANALYTICS,
        reference={"statistic": "mean", "measure": "temperature_max", "tolerance": 1e-6},
    )
    report = compute_metrics(
        [
            _outcome(
                "num-case",
                Category.ANALYTICS,
                answer="The mean is 11.857142857 °C.",
                asserted_figures=(11.857142857,),
                reference_value=11.857142857,
            )
        ],
        [case],
    )
    assert report.result(MetricName.NUMERICAL_CALCULATION_ACCURACY).value == 1.0


def test_numerical_accuracy_fails_on_a_wrong_figure() -> None:
    case = _case(
        "num-case",
        Category.ANALYTICS,
        reference={"statistic": "mean", "measure": "temperature_max"},
    )
    report = compute_metrics(
        [
            _outcome(
                "num-case",
                Category.ANALYTICS,
                answer="The mean is 20.0 °C.",
                asserted_figures=(20.0,),
                reference_value=11.9,
            )
        ],
        [case],
    )
    result = report.result(MetricName.NUMERICAL_CALCULATION_ACCURACY)
    assert result.value == 0.0
    assert result.failing_cases == ("num-case",)


def test_numerical_accuracy_fails_when_no_reference_could_be_computed() -> None:
    """A missing reference means the run retrieved no series — a failure, not an exclusion."""
    case = _case(
        "num-case",
        Category.ANALYTICS,
        reference={"statistic": "mean", "measure": "temperature_max"},
    )
    report = compute_metrics(
        [_outcome("num-case", Category.ANALYTICS, answer="11.9", reference_value=None)], [case]
    )
    assert report.result(MetricName.NUMERICAL_CALCULATION_ACCURACY).value == 0.0


def test_groundedness_passes_when_every_figure_is_in_the_evidence() -> None:
    case = _case("g-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "g-case",
                Category.CURRENT_AND_FORECAST,
                answer="It reaches 11.8 °C on Tuesday.",
                evidence_values=(11.8, 12.5),
            )
        ],
        [case],
    )
    assert report.result(MetricName.GROUNDEDNESS).value == 1.0


def test_groundedness_fails_on_a_figure_the_evidence_does_not_support() -> None:
    case = _case("g-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "g-case",
                Category.CURRENT_AND_FORECAST,
                answer="It reaches 47.3 °C on Tuesday.",
                evidence_values=(11.8, 12.5),
            )
        ],
        [case],
    )
    assert report.result(MetricName.GROUNDEDNESS).value == 0.0


def test_attribution_coverage_excludes_a_case_with_no_weather_data() -> None:
    """The inapplicable-case exclusion: a conceptual answer has nothing to attribute.

    This is the shortcut that would silently inflate every score — counting it as a pass would make
    the metric read 100% while measuring nothing.
    """
    weather = _case("w-case", Category.CURRENT_AND_FORECAST)
    conceptual = _case("k-case", Category.KNOWLEDGE, relevant_documents=["dew-point"])

    report = compute_metrics(
        [
            _outcome(
                "w-case",
                Category.CURRENT_AND_FORECAST,
                carries_weather_data=True,
                attribution=(
                    {
                        "provider": "open-meteo",
                        "location": {"display_name": "Berlin"},
                        "retrieved_at": "2025-06-01T00:00:00Z",
                        "period": {"start_utc": "x"},
                    },
                ),
            ),
            _outcome("k-case", Category.KNOWLEDGE, carries_weather_data=False),
        ],
        [weather, conceptual],
    )

    result = report.result(MetricName.SOURCE_ATTRIBUTION_COVERAGE)
    assert result.denominator == 1, "the conceptual case is excluded, not counted as a pass"
    assert result.value == 1.0


def test_attribution_coverage_fails_on_an_incomplete_block() -> None:
    case = _case("w-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "w-case",
                Category.CURRENT_AND_FORECAST,
                carries_weather_data=True,
                # No retrieval time: a reader cannot tell how fresh this is.
                attribution=({"provider": "open-meteo", "location": {"display_name": "Berlin"}},),
            )
        ],
        [case],
    )
    assert report.result(MetricName.SOURCE_ATTRIBUTION_COVERAGE).value == 0.0


def test_rag_quality_requires_a_declared_relevant_document() -> None:
    case = _case("k-case", Category.KNOWLEDGE, relevant_documents=["dew-point"])

    passing = compute_metrics(
        [_outcome("k-case", Category.KNOWLEDGE, cited_documents=("dew-point",))], [case]
    )
    failing = compute_metrics(
        [_outcome("k-case", Category.KNOWLEDGE, cited_documents=("uv-index",))], [case]
    )

    assert passing.result(MetricName.RAG_RETRIEVAL_QUALITY).value == 1.0
    assert failing.result(MetricName.RAG_RETRIEVAL_QUALITY).value == 0.0


def test_rag_quality_excludes_a_non_conceptual_case() -> None:
    case = _case("w-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics([_outcome("w-case", Category.CURRENT_AND_FORECAST)], [case])
    assert report.result(MetricName.RAG_RETRIEVAL_QUALITY).denominator == 0
    assert report.result(MetricName.RAG_RETRIEVAL_QUALITY).value is None, "inapplicable, not 100%"


def test_memory_correctness_compares_every_turn() -> None:
    case = _case(
        "m-case",
        Category.MEMORY,
        turns=[
            {
                "question": "Compare Berlin and Munich",
                "expected_resolution": {
                    "locations": ["Berlin", "Munich"],
                    "location_source": "request",
                },
            },
            {
                "question": "Which one is warmer?",
                "expected_resolution": {
                    "locations": ["Berlin", "Munich"],
                    "location_source": "thread",
                },
            },
        ],
    )

    matching = compute_metrics(
        [
            _outcome(
                "m-case",
                Category.MEMORY,
                resolutions=(
                    {"locations": ("Berlin", "Munich"), "location_source": "request"},
                    {"locations": ("Berlin", "Munich"), "location_source": "thread"},
                ),
            )
        ],
        [case],
    )
    assert matching.result(MetricName.MEMORY_CORRECTNESS).value == 1.0

    wrong_source = compute_metrics(
        [
            _outcome(
                "m-case",
                Category.MEMORY,
                resolutions=(
                    {"locations": ("Berlin", "Munich"), "location_source": "request"},
                    # Resolved from the request, so the follow-up did not use the conversation.
                    {"locations": ("Berlin", "Munich"), "location_source": "request"},
                ),
            )
        ],
        [case],
    )
    assert wrong_source.result(MetricName.MEMORY_CORRECTNESS).value == 0.0


def test_memory_correctness_ignores_a_field_the_case_did_not_declare() -> None:
    """A case that says nothing about units is not asserting anything about them."""
    case = _case(
        "m-case",
        Category.MEMORY,
        turns=[
            {"question": "one", "expected_resolution": {"locations": ["Berlin"]}},
            {"question": "two", "expected_resolution": {"locations": ["Berlin"]}},
        ],
    )
    report = compute_metrics(
        [
            _outcome(
                "m-case",
                Category.MEMORY,
                resolutions=(
                    {"locations": ("Berlin",), "unit_system": "imperial"},
                    {"locations": ("Berlin",), "unit_system": "metric"},
                ),
            )
        ],
        [case],
    )
    assert report.result(MetricName.MEMORY_CORRECTNESS).value == 1.0


def test_multi_turn_correctness_requires_memory_correctness_too() -> None:
    case = _case(
        "m-case",
        Category.MEMORY,
        turns=[
            {"question": "one", "expected_resolution": {"locations": ["Berlin"]}},
            {
                "question": "two",
                "expected_resolution": {"locations": ["Munich"]},
                "expected_answer_characteristics": ["munich"],
            },
        ],
    )
    # The final answer says the right thing, but the second turn resolved to the wrong place.
    report = compute_metrics(
        [
            _outcome(
                "m-case",
                Category.MEMORY,
                answer="Munich is warmer.",
                resolutions=(
                    {"locations": ("Berlin",)},
                    {"locations": ("Berlin",)},
                ),
            )
        ],
        [case],
    )
    assert report.result(MetricName.MULTI_TURN_CONTEXTUAL_CORRECTNESS).value == 0.0


def test_hallucination_rate_is_over_all_cases() -> None:
    """As the specification defines it: the denominator is every case, not the figure-bearing ones."""
    cases = [
        _case("one", Category.CURRENT_AND_FORECAST),
        _case("two", Category.KNOWLEDGE, relevant_documents=["dew-point"]),
        _case("three", Category.CURRENT_AND_FORECAST),
        _case("four", Category.CURRENT_AND_FORECAST),
    ]
    outcomes = [
        _outcome("one", Category.CURRENT_AND_FORECAST, answer="47.3 °C", evidence_values=(11.0,)),
        _outcome("two", Category.KNOWLEDGE, answer="The dew point is a temperature."),
        _outcome("three", Category.CURRENT_AND_FORECAST, answer="11.0 °C", evidence_values=(11.0,)),
        _outcome("four", Category.CURRENT_AND_FORECAST, answer="no figures here"),
    ]
    result = compute_metrics(outcomes, cases).result(MetricName.HALLUCINATION_RATE)

    assert result.denominator == 4
    assert result.numerator == 1
    assert result.value == 0.25
    assert result.lower_is_better


def test_an_unsupported_severity_claim_is_counted() -> None:
    case = _case("s-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "s-case",
                Category.CURRENT_AND_FORECAST,
                answer="A dangerous storm will certainly hit Berlin.",
                evidence_fields=("daily", "hourly"),
            )
        ],
        [case],
    )
    result = report.result(MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE)
    assert result.value == 1.0
    assert result.lower_is_better


def test_a_severity_claim_supported_by_a_field_is_not_counted() -> None:
    case = _case("s-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "s-case",
                Category.CURRENT_AND_FORECAST,
                answer="The provider reports a severe weather alert.",
                evidence_fields=("daily", "alerts"),
            )
        ],
        [case],
    )
    assert report.result(MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE).value == 0.0


def test_a_referral_to_an_official_authority_is_not_a_severity_claim() -> None:
    """Otherwise every safety answer would score as an unsupported claim."""
    from weathra.agents.safety import OFFICIAL_AUTHORITY_REFERRAL

    case = _case("s-case", Category.CURRENT_AND_FORECAST)
    report = compute_metrics(
        [
            _outcome(
                "s-case",
                Category.CURRENT_AND_FORECAST,
                answer=OFFICIAL_AUTHORITY_REFERRAL,
                evidence_fields=("daily",),
            )
        ],
        [case],
    )
    assert report.result(MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE).value == 0.0


def test_the_backend_success_rate_counts_a_4xx_as_a_success() -> None:
    """A 400 is the correct response to a bad request; a 500 is not a response at all."""
    cases = [
        _case("bad-request", Category.CURRENT_AND_FORECAST),
        _case("server-error", Category.CURRENT_AND_FORECAST),
    ]
    report = compute_metrics(
        [
            _outcome("bad-request", Category.CURRENT_AND_FORECAST, http_status=400),
            _outcome("server-error", Category.CURRENT_AND_FORECAST, http_status=500),
        ],
        cases,
    )
    result = report.result(MetricName.BACKEND_SUCCESSFUL_RESPONSE_RATE)
    assert result.value == 0.5
    assert result.failing_cases == ("server-error",)


def test_latency_is_reported_as_a_median_and_a_95th_percentile_per_category() -> None:
    cases = [_case(f"case-{index}", Category.CURRENT_AND_FORECAST) for index in range(1, 5)] + [
        _case("k-case", Category.KNOWLEDGE, relevant_documents=["dew-point"])
    ]
    outcomes = [
        _outcome(f"case-{index}", Category.CURRENT_AND_FORECAST, latency_ms=float(index) * 100.0)
        for index in range(1, 5)
    ] + [_outcome("k-case", Category.KNOWLEDGE, latency_ms=50.0)]

    latency = compute_metrics(outcomes, cases).latency

    assert latency.overall_median_ms is not None
    assert latency.overall_p95_ms is not None
    assert latency.overall_p95_ms >= latency.overall_median_ms
    assert set(latency.by_category) == {"current_and_forecast", "knowledge"}
    assert latency.by_category["knowledge"]["median_ms"] == 50.0
    assert latency.samples == 5


def test_a_latency_percentile_works_for_a_single_sample() -> None:
    """A single-case run has one sample, and reporting nothing for it would be unhelpful."""
    case = _case("one", Category.CURRENT_AND_FORECAST)
    latency = compute_metrics(
        [_outcome("one", Category.CURRENT_AND_FORECAST, latency_ms=42.0)], [case]
    ).latency
    assert latency.overall_median_ms == 42.0
    assert latency.overall_p95_ms == 42.0


def test_an_outcome_naming_an_unknown_case_is_refused() -> None:
    with pytest.raises(ValueError, match="not in the dataset"):
        compute_metrics([_outcome("nobody", Category.HISTORICAL)], [])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("It reaches 11.8 °C", (11.8,)),
        ("Between -3 and 12 degrees", (-3.0, 12.0)),
        ("1,200 mm of rain", (1200.0,)),
        ("Since 1991 the mean has risen", ()),
        ("no figures at all", ()),
    ],
)
def test_the_figure_extractor_reads_measurements_and_skips_years(
    text: str, expected: tuple[float, ...]
) -> None:
    assert figures_in(text) == expected


# =========================================================================== 22.4 thresholds


def _all_passing_report() -> object:
    """Synthetic outcomes constructed to pass every threshold."""
    cases = [
        _case(
            "w-case",
            Category.CURRENT_AND_FORECAST,
            expected_tools=["weather_forecast"],
        ),
        _case("k-case", Category.KNOWLEDGE, relevant_documents=["dew-point"]),
        _case(
            "m-case",
            Category.MEMORY,
            turns=[
                {"question": "one", "expected_resolution": {"locations": ["Berlin"]}},
                {"question": "two", "expected_resolution": {"locations": ["Berlin"]}},
            ],
        ),
        _case(
            "n-case",
            Category.ANALYTICS,
            reference={"statistic": "mean", "measure": "temperature_max"},
        ),
    ]
    attribution = (
        {
            "provider": "open-meteo",
            "location": {"display_name": "Berlin"},
            "retrieved_at": "2025-06-01T00:00:00Z",
            "period": {"start_utc": "x"},
        },
    )
    outcomes = [
        _outcome(
            "w-case",
            Category.CURRENT_AND_FORECAST,
            answer="Berlin reaches 11.8 °C.",
            tools_called=("weather_forecast",),
            evidence_values=(11.8,),
            carries_weather_data=True,
            attribution=attribution,
            latency_ms=100.0,
        ),
        _outcome(
            "k-case",
            Category.KNOWLEDGE,
            answer="The dew point is a saturation temperature.",
            cited_documents=("dew-point",),
            latency_ms=50.0,
        ),
        _outcome(
            "m-case",
            Category.MEMORY,
            answer="Berlin is mild.",
            resolutions=({"locations": ("Berlin",)}, {"locations": ("Berlin",)}),
            latency_ms=150.0,
        ),
        _outcome(
            "n-case",
            Category.ANALYTICS,
            answer="The mean is 11.9 °C.",
            asserted_figures=(11.9,),
            reference_value=11.9,
            evidence_values=(11.9,),
            carries_weather_data=True,
            attribution=attribution,
            latency_ms=120.0,
        ),
    ]
    return compute_metrics(outcomes, cases)


def test_an_all_passing_run_passes_every_threshold() -> None:
    report = evaluate_thresholds(_all_passing_report())  # type: ignore[arg-type]

    assert report.passed, report.summary()
    assert report.missed == ()
    assert report.measured_thresholds == len(THRESHOLDS)
    assert "PASS" in report.summary()


def test_a_run_failing_numerical_accuracy_fails_overall_and_names_it() -> None:
    case = _case(
        "n-case",
        Category.ANALYTICS,
        reference={"statistic": "mean", "measure": "temperature_max"},
    )
    metrics = compute_metrics(
        [
            _outcome(
                "n-case",
                Category.ANALYTICS,
                answer="The mean is 20.0 °C.",
                asserted_figures=(20.0,),
                reference_value=11.9,
                evidence_values=(20.0,),
            )
        ],
        [case],
    )
    report = evaluate_thresholds(metrics)

    assert not report.passed
    missed = {outcome.metric for outcome in report.missed}
    assert MetricName.NUMERICAL_CALCULATION_ACCURACY in missed

    numerical = next(
        outcome
        for outcome in report.outcomes
        if outcome.metric is MetricName.NUMERICAL_CALCULATION_ACCURACY
    )
    assert numerical.failing_cases == ("n-case",)
    assert numerical.margin_points == pytest.approx(100.0), "short by the full hundred points"
    assert "FAIL" in numerical.describe()
    assert "n-case" in numerical.describe()


def test_the_non_gating_metrics_are_reported_in_both_a_passing_and_a_failing_run() -> None:
    """``specs/evaluation``: reported for every run whether or not they gate acceptance."""
    passing = evaluate_thresholds(_all_passing_report())  # type: ignore[arg-type]

    failing_case = _case(
        "f-case", Category.CURRENT_AND_FORECAST, expected_tools=["weather_forecast"]
    )
    failing = evaluate_thresholds(
        compute_metrics([_outcome("f-case", Category.CURRENT_AND_FORECAST)], [failing_case])
    )

    expected = {"groundedness", "memory_correctness", "hallucination_rate"}
    assert set(passing.non_gating) == expected
    assert set(failing.non_gating) == expected
    assert not failing.passed


def test_a_lower_is_better_threshold_compares_the_other_way() -> None:
    """The single most dangerous mistake this module could make, asserted directly."""
    cases = [_case(f"case-{index}", Category.CURRENT_AND_FORECAST) for index in range(1, 3)]
    metrics = compute_metrics(
        [
            _outcome(
                "case-1",
                Category.CURRENT_AND_FORECAST,
                answer="A dangerous storm is certain.",
                evidence_fields=("daily",),
            ),
            _outcome("case-2", Category.CURRENT_AND_FORECAST, answer="Mild."),
        ],
        cases,
    )
    report = evaluate_thresholds(metrics)

    claim = next(
        outcome
        for outcome in report.outcomes
        if outcome.metric is MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE
    )
    assert claim.value == 0.5
    assert claim.passed is False, "50% is not below 2%"


def test_an_inapplicable_threshold_is_reported_as_such_rather_than_passed() -> None:
    """A filtered run has not achieved 100% on a metric it never measured."""
    case = _case("k-case", Category.KNOWLEDGE, relevant_documents=["dew-point"])
    metrics = compute_metrics(
        [_outcome("k-case", Category.KNOWLEDGE, cited_documents=("dew-point",))], [case]
    )
    report = evaluate_thresholds(metrics)

    numerical = next(
        outcome
        for outcome in report.outcomes
        if outcome.metric is MetricName.NUMERICAL_CALCULATION_ACCURACY
    )
    assert numerical.passed is None
    assert "not applicable" in numerical.describe()
    assert "numerical_calculation_accuracy" in report.inapplicable_thresholds
    assert report.passed, "an unmeasured threshold neither passes nor fails the run"
    assert "not applicable" in report.summary()


def test_every_threshold_in_the_specification_is_evaluated() -> None:
    report = evaluate_thresholds(_all_passing_report())  # type: ignore[arg-type]
    assert {outcome.metric for outcome in report.outcomes} == {
        threshold.metric for threshold in THRESHOLDS
    }
    assert len(THRESHOLDS) == 7, "the specification's table has seven gating thresholds"


# =========================================================================== task 22.9
#
# Evaluation inference integrity. Task 22.8's live runs scored forty deterministic-fallback answers
# as though a language model had written them, missed the thresholds, and were recorded as a
# quality failure of a model that never answered. These assert that cannot happen again.


def _attempt(
    status: InferenceStatus,
    *,
    stage: InferenceStage = InferenceStage.ROUTING,
    **kw: object,
) -> InferenceAttempt:
    return InferenceAttempt(stage=stage, status=status, **kw)


def _served(case_id: str, category: Category, **overrides: object) -> CaseOutcome:
    return _outcome(
        case_id,
        category,
        inference_attempts=(
            _attempt(InferenceStatus.SERVED, served_model="vendor/pinned"),
            _attempt(
                InferenceStatus.SERVED, stage=InferenceStage.SYNTHESIS, served_model="vendor/pinned"
            ),
        ),
        **overrides,
    )


def _fell_back(case_id: str, category: Category, **overrides: object) -> CaseOutcome:
    return _outcome(
        case_id,
        category,
        inference_attempts=(
            _attempt(InferenceStatus.MODEL_UNAVAILABLE, http_status=404),
            _attempt(
                InferenceStatus.MODEL_UNAVAILABLE, stage=InferenceStage.SYNTHESIS, http_status=404
            ),
        ),
        **overrides,
    )


def _assess(
    outcomes: list[CaseOutcome] | tuple[CaseOutcome, ...],
    metrics: MetricsReport,
    *,
    mode: EvaluationMode = EvaluationMode.LIVE,
    floor: float = 1.0,
    cases: Sequence[EvaluationCase] | None = None,
) -> InferenceIntegrity:
    return assess_integrity(
        outcomes,
        metrics,
        mode=mode,
        minimum_served_rate=floor,
        gated_metrics=GATED_METRICS,
        metrics_before_quarantine=(
            compute_metrics(outcomes, cases, quarantine=False) if cases else metrics
        ),
    )


def test_a_case_the_model_did_not_serve_is_excluded_from_every_metric() -> None:
    """Both halves of every fraction. Not a pass, not a failure — the treatment an inapplicable
    case already gets, for the same reason: counting it either way is a claim nobody earned."""
    cases = [
        _case("served", Category.HISTORICAL, expected_tools=["weather_history"]),
        _case("fallback", Category.HISTORICAL, expected_tools=["weather_history"]),
    ]
    report = compute_metrics(
        [
            _served("served", Category.HISTORICAL, tools_called=("weather_history",)),
            _fell_back("fallback", Category.HISTORICAL, tools_called=("weather_history",)),
        ],
        cases,
    )

    result = report.result(MetricName.TOOL_SELECTION_ACCURACY)
    assert result.denominator == 1, "the quarantined case must leave the denominator"
    assert result.numerator == 1
    assert "fallback" not in result.failing_cases, "and must not be counted as a failure either"
    assert report.cases_quarantined == ("fallback",)
    assert report.cases_scored == 1


def test_a_fully_fallen_back_run_is_a_provider_failure_not_a_threshold_failure() -> None:
    """The Task 22.8 regression, asserted directly."""
    cases = [
        _case(f"c{i}", Category.HISTORICAL, expected_tools=["weather_history"]) for i in range(4)
    ]
    outcomes = [_fell_back(f"c{i}", Category.HISTORICAL) for i in range(4)]

    metrics = compute_metrics(outcomes, cases)
    integrity = _assess(outcomes, metrics)
    report = evaluate_thresholds(metrics, integrity=integrity)

    assert integrity.outcome is RunOutcome.PROVIDER_FAILURE
    assert integrity.cases_model_served == 0
    assert integrity.served_rate == 0.0
    assert report.passed is None, "no verdict — not a failing verdict"
    assert report.provider_failed is True
    assert "PROVIDER FAILURE" in report.summary()
    assert not report.missed, "a provider outage names no missed threshold"


def test_a_rate_limited_run_is_a_provider_failure_too() -> None:
    cases = [_case("c0", Category.HISTORICAL, expected_tools=["weather_history"])]
    outcomes = [
        _outcome(
            "c0",
            Category.HISTORICAL,
            inference_attempts=(_attempt(InferenceStatus.RATE_LIMITED, http_status=429),),
        )
    ]
    integrity = _assess(outcomes, compute_metrics(outcomes, cases))

    assert integrity.outcome is RunOutcome.PROVIDER_FAILURE
    assert integrity.attempts_by_status == {"rate_limited": 1}
    assert "rate_limited" in (integrity.reason or "")


def test_invalid_output_is_scored_rather_than_quarantined() -> None:
    """A model that answered badly served the evaluation. Quarantining it would let a weak model
    escape measurement by producing garbage."""
    cases = [_case("c0", Category.HISTORICAL, expected_tools=["weather_history"])]
    outcomes = [
        _outcome(
            "c0",
            Category.HISTORICAL,
            tools_called=("weather_history",),
            inference_attempts=(_attempt(InferenceStatus.INVALID_OUTPUT),),
        )
    ]
    metrics = compute_metrics(outcomes, cases)
    integrity = _assess(outcomes, metrics)

    assert metrics.cases_quarantined == ()
    assert integrity.outcome is RunOutcome.SCORED
    assert evaluate_thresholds(metrics, integrity=integrity).passed is not None


def test_a_run_below_the_served_floor_is_a_provider_failure() -> None:
    cases = [
        _case(f"c{i}", Category.HISTORICAL, expected_tools=["weather_history"]) for i in range(4)
    ]
    outcomes = [
        _served("c0", Category.HISTORICAL, tools_called=("weather_history",)),
        _served("c1", Category.HISTORICAL, tools_called=("weather_history",)),
        _served("c2", Category.HISTORICAL, tools_called=("weather_history",)),
        _fell_back("c3", Category.HISTORICAL),
    ]
    metrics = compute_metrics(outcomes, cases)

    assert _assess(outcomes, metrics, floor=1.0).outcome is RunOutcome.PROVIDER_FAILURE
    # Lowered deliberately: an exploratory run may accept a reduced basis, and says so.
    relaxed = _assess(outcomes, metrics, floor=0.75)
    assert relaxed.outcome is RunOutcome.SCORED
    assert relaxed.served_rate == 0.75


def test_a_gate_emptied_by_quarantine_invalidates_the_run() -> None:
    """The degenerate case: quarantine everything a gate applied to, and the gate would otherwise
    "pass" over nothing at all."""
    cases = [
        _case("numeric", Category.ANALYTICS, reference={"statistic": "mean", "measure": "t"}),
        _case("other", Category.HISTORICAL),
    ]
    outcomes = [
        _fell_back("numeric", Category.ANALYTICS),
        _served("other", Category.HISTORICAL),
    ]
    metrics = compute_metrics(outcomes, cases)
    integrity = _assess(outcomes, metrics, floor=0.5, cases=cases)

    assert not metrics.result(MetricName.NUMERICAL_CALCULATION_ACCURACY).applicable
    assert integrity.outcome is RunOutcome.PROVIDER_FAILURE
    assert "numerical_calculation_accuracy" in integrity.emptied_thresholds


def test_an_offline_run_is_not_applicable_rather_than_a_provider_failure() -> None:
    """CI's offline run must keep passing. It evaluates no live model, so the question of whether
    one served it does not arise."""
    cases = [_case("c0", Category.HISTORICAL, expected_tools=["weather_history"])]
    outcomes = [_served("c0", Category.HISTORICAL, tools_called=("weather_history",))]
    metrics = compute_metrics(outcomes, cases)
    integrity = _assess(outcomes, metrics, mode=EvaluationMode.OFFLINE)

    assert integrity.outcome is RunOutcome.NOT_APPLICABLE
    assert integrity.representative is True
    assert evaluate_thresholds(metrics, integrity=integrity).passed is True


def test_outcomes_with_no_recorded_attempts_are_still_scored() -> None:
    """Absence of evidence is not evidence of fallback. A record predating the provenance field,
    or a synthetic outcome, must not be retroactively voided."""
    cases = [_case("c0", Category.HISTORICAL, expected_tools=["weather_history"])]
    outcomes = [_outcome("c0", Category.HISTORICAL, tools_called=("weather_history",))]
    metrics = compute_metrics(outcomes, cases)

    assert metrics.cases_quarantined == ()
    assert metrics.result(MetricName.TOOL_SELECTION_ACCURACY).denominator == 1


def test_the_integrity_report_names_the_models_that_actually_answered() -> None:
    """A pinned run that observed two distinct served models had a route substitute one, and that
    is a fact a reproducible evaluation has to surface rather than average over."""
    cases = [_case("c0", Category.HISTORICAL), _case("c1", Category.HISTORICAL)]
    outcomes = [
        _outcome(
            "c0",
            Category.HISTORICAL,
            inference_attempts=(_attempt(InferenceStatus.SERVED, served_model="vendor/a"),),
        ),
        _outcome(
            "c1",
            Category.HISTORICAL,
            inference_attempts=(_attempt(InferenceStatus.SERVED, served_model="vendor/b"),),
        ),
    ]
    integrity = _assess(outcomes, compute_metrics(outcomes, cases))

    assert integrity.served_models == ("vendor/a", "vendor/b")
    assert integrity.attempts_by_status == {"served": 2}
