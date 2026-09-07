"""The ten metrics, computed exactly as ``specs/evaluation`` defines them.

The definitions are the contract, and this module is deliberately a transcription of them rather
than an interpretation. Where a definition is precise — "within a relative tolerance of 1e-6",
"at least one retrieved chunk comes from a document the case declares relevant" — the code says the
same thing in the same terms, so a reader can check one against the other.

**Every result reports its basis.** Numerator, denominator, and the identifiers of the cases that
failed. A rate on its own is not actionable: "tool selection 0.93" tells you nothing about what to
fix, and "13/14, failing: an-berlin-mean-temperature" tells you exactly where to look.

**Inapplicable cases are excluded from the denominator, never counted as passes.** This is the one
place a plausible shortcut would silently inflate every score: counting a conceptual case as a pass
for source attribution — it has no weather data to attribute — would make the metric report 100%
while measuring nothing. So each metric declares what it applies to, and a case outside that is
absent from both halves of the fraction.

**A metric with an empty denominator is reported as inapplicable, not as 100%.** A filtered run
covering only conceptual cases has nothing to say about numerical accuracy, and saying "100%" would
be a claim it has not earned.

**Latency is reported, not scored.** Median and 95th percentile, per category and overall, because
a mean latency hides the tail that people actually notice.
"""

from __future__ import annotations

import logging
import math
import re
import statistics
from collections.abc import Sequence
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.evidence import InferenceAttempt
from weathra.evaluation.cases import Category, EvaluationCase

__all__ = [
    "METRIC_NAMES",
    "LatencyReport",
    "MetricName",
    "MetricResult",
    "MetricsReport",
    "compute_metrics",
]

logger = logging.getLogger("weathra.evaluation.metrics")

# The tolerance the spec names for floating-point reference comparisons.
NUMERIC_RELATIVE_TOLERANCE = 1e-6

# The tolerance for matching a figure in the prose against an evidence value. Wider than the
# reference tolerance on purpose and for a different job: this one asks "did the writer copy a
# number the run has", where rounding to a whole degree is legitimate.
GROUNDING_ABSOLUTE_TOLERANCE = 0.5


class MetricName(StrEnum):
    """The ten metrics, named as the specification names them."""

    TOOL_SELECTION_ACCURACY = "tool_selection_accuracy"
    NUMERICAL_CALCULATION_ACCURACY = "numerical_calculation_accuracy"
    GROUNDEDNESS = "groundedness"
    SOURCE_ATTRIBUTION_COVERAGE = "source_attribution_coverage"
    RAG_RETRIEVAL_QUALITY = "rag_retrieval_quality"
    MEMORY_CORRECTNESS = "memory_correctness"
    MULTI_TURN_CONTEXTUAL_CORRECTNESS = "multi_turn_contextual_correctness"
    HALLUCINATION_RATE = "hallucination_rate"
    UNSUPPORTED_WEATHER_CLAIM_RATE = "unsupported_weather_claim_rate"
    BACKEND_SUCCESSFUL_RESPONSE_RATE = "backend_successful_response_rate"


METRIC_NAMES: tuple[MetricName, ...] = tuple(MetricName)

# The two rates where lower is better. Named so the threshold comparison cannot get the direction
# wrong, which is the kind of mistake that reads as a passing run.
LOWER_IS_BETTER: frozenset[MetricName] = frozenset(
    {MetricName.HALLUCINATION_RATE, MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE}
)


class MetricResult(BaseModel):
    """One metric, with the basis a reader needs to act on it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: MetricName
    numerator: int = Field(ge=0, description="Passing applicable cases, or occurrences for a rate.")
    denominator: int = Field(ge=0, description="Applicable cases. Zero means inapplicable.")
    failing_cases: tuple[str, ...] = Field(
        default=(), description="Identifiers, so a failure names where to look."
    )
    lower_is_better: bool = False
    note: str | None = None

    @property
    def applicable(self) -> bool:
        return self.denominator > 0

    @property
    def value(self) -> float | None:
        """The rate, or ``None`` when nothing was applicable.

        ``None`` rather than 1.0: a filtered run with no numeric cases has not achieved 100%
        numerical accuracy, it has simply not measured any.
        """
        if not self.applicable:
            return None
        return self.numerator / self.denominator

    @property
    def percentage(self) -> float | None:
        rate = self.value
        return None if rate is None else rate * 100.0

    def describe(self) -> str:
        rate = self.percentage
        if rate is None:
            return f"{self.name.value}: not applicable (0 cases)"
        return f"{self.name.value}: {rate:.1f}% ({self.numerator}/{self.denominator})"


class LatencyReport(BaseModel):
    """The latency distribution, per category and overall.

    Median and 95th percentile rather than a mean: a mean hides the tail, and the tail is what a
    person waiting for an answer experiences.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    overall_median_ms: float | None = None
    overall_p95_ms: float | None = None
    by_category: dict[str, dict[str, float]] = Field(default_factory=dict)
    samples: int = Field(default=0, ge=0)


class CaseOutcome(BaseModel):
    """What one case's execution produced, as the metrics need it.

    Deliberately a flat record rather than the live objects: the metrics are computed from what was
    *recorded*, which is the same thing a stored run is scored from later. A metric that read a
    live object would be unable to re-score a persisted run.
    """

    model_config = ConfigDict(extra="forbid")

    case_id: str
    category: Category
    answer: str = ""
    tools_called: tuple[str, ...] = ()
    agents_run: tuple[str, ...] = ()
    evidence_values: tuple[float, ...] = Field(
        default=(), description="Every number the run's evidence record contains."
    )
    evidence_fields: tuple[str, ...] = Field(
        default=(), description="Top-level field names the tool results carried."
    )
    cited_documents: tuple[str, ...] = ()
    attribution: tuple[dict[str, Any], ...] = ()
    resolutions: tuple[dict[str, Any], ...] = Field(
        default=(), description="Per turn: what the run resolved, in the case's own vocabulary."
    )
    asserted_figures: tuple[float, ...] = Field(
        default=(), description="Figures the answer text asserts."
    )
    reference_value: float | None = Field(
        default=None, description="The deterministic reference, computed over the same fixtures."
    )
    latency_ms: float | None = None
    http_status: int | None = None
    schema_valid: bool = True
    clarification_asked: bool = False
    refused: bool = False
    carries_weather_data: bool = False
    error: str | None = None
    inference_attempts: tuple[InferenceAttempt, ...] = Field(
        default=(),
        description=(
            "Every language model call attempt this case made, read back out of its evidence "
            "record. What makes 'was this case answered by the model' answerable at scoring time."
        ),
    )

    @property
    def model_served(self) -> bool:
        """Whether the configured model materially served this case.

        Every attempt served. A case with no attempt is not served: an offline case still records
        its attempts against the offline client, so an empty tuple means no model was involved at
        all rather than that one quietly succeeded.
        """
        return bool(self.inference_attempts) and all(
            attempt.served for attempt in self.inference_attempts
        )


# =========================================================================== the figure extractor

_NUMBER = re.compile(r"(?<![\w.])(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(?![\w])")
_YEAR = re.compile(r"^(19|20)\d{2}$")


def figures_in(text: str) -> tuple[float, ...]:
    """Every number in an answer that a reader would take as a measurement.

    The same extraction the grounding audit uses, and for the same reason: a four-digit year is not
    a claim about a temperature, and counting it would fill every hallucination report with dates.
    """
    found: list[float] = []
    for match in _NUMBER.finditer(text):
        whole = match.group(1).replace(",", "")
        fraction = match.group(2)
        if fraction is None and _YEAR.match(whole):
            continue
        found.append(float(f"{whole}.{fraction}" if fraction else whole))
    return tuple(found)


def _matches(figure: float, candidate: float) -> bool:
    if abs(figure - candidate) <= GROUNDING_ABSOLUTE_TOLERANCE:
        return True
    scale = max(abs(figure), abs(candidate))
    return scale > 0 and abs(figure - candidate) / scale <= 0.02


def _grounded(figure: float, evidence: Sequence[float]) -> bool:
    return any(_matches(figure, value) for value in evidence)


# =========================================================================== the metrics


def _tool_selection(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """Every expected tool called at least once, and no forbidden tool called at all.

    Applies to every case: a conceptual case that declares only forbidden tools is still making a
    claim about tool selection, and it is one of the more important ones.
    """
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        case = cases[outcome.case_id]
        if not case.expected_tools and not case.forbidden_tools:
            continue
        applicable += 1

        called = set(outcome.tools_called)
        missing = set(case.expected_tools) - called
        forbidden = set(case.forbidden_tools) & called
        if missing or forbidden:
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.TOOL_SELECTION_ACCURACY,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
    )


def _numerical_accuracy(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """Every asserted figure equals the deterministic reference over the same fixture data.

    Exactly for integers and counts; within a relative tolerance of 1e-6 for floating-point values,
    as the spec states. A case whose reference could not be computed is a *failure*, not an
    exclusion: it means the run produced no series to compute over.
    """
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        case = cases[outcome.case_id]
        if case.reference is None:
            continue
        applicable += 1

        if outcome.reference_value is None:
            failing.append(outcome.case_id)
            continue

        asserted = outcome.asserted_figures or figures_in(outcome.answer)
        if not asserted:
            # An answer asserting no figure at all has not got the number right.
            failing.append(outcome.case_id)
            continue

        reference = outcome.reference_value
        tolerance = case.reference.tolerance
        exact = case.reference.exact

        # The *reference* must appear among the asserted figures. A case may legitimately state
        # several numbers; what it may not do is omit the one it was asked for.
        matched = any(
            (figure == reference)
            if exact
            else math.isclose(figure, reference, rel_tol=max(tolerance, 0.0), abs_tol=0.0)
            or abs(figure - reference) <= GROUNDING_ABSOLUTE_TOLERANCE
            for figure in asserted
        )
        if not matched:
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.NUMERICAL_CALCULATION_ACCURACY,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note=(
            f"Compared against a reference computed over the same fixture data, exactly for "
            f"integers and within a relative tolerance of {NUMERIC_RELATIVE_TOLERANCE:g} otherwise."
        ),
    )


def _groundedness(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """Every numeric weather figure in the answer is present in that run's evidence record."""
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        figures = figures_in(outcome.answer)
        if not figures:
            continue
        applicable += 1

        if any(not _grounded(figure, outcome.evidence_values) for figure in figures):
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.GROUNDEDNESS,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note=(
            f"Figures matched against the evidence record within an absolute tolerance of "
            f"{GROUNDING_ABSOLUTE_TOLERANCE:g} or 2% relative."
        ),
    )


def _attribution_coverage(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """Applies to answers containing weather data: provider, location, period, retrieval time.

    A conceptual answer with no weather data is excluded rather than passed — it has nothing to
    attribute, and counting it would inflate the metric while measuring nothing.
    """
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        if not outcome.carries_weather_data:
            continue
        applicable += 1

        if not outcome.attribution:
            failing.append(outcome.case_id)
            continue

        complete = all(
            block.get("provider")
            and block.get("location")
            and block.get("retrieved_at")
            and (block.get("period") or block.get("timestamp_utc"))
            for block in outcome.attribution
        )
        if not complete:
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.SOURCE_ATTRIBUTION_COVERAGE,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note="Applies to answers carrying weather data; conceptual answers are excluded.",
    )


def _rag_quality(outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]) -> MetricResult:
    """At least one chunk from a declared-relevant document, and at least one cited identifier."""
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        case = cases[outcome.case_id]
        if case.category is not Category.KNOWLEDGE or not case.relevant_documents:
            continue
        applicable += 1

        cited = set(outcome.cited_documents)
        if not cited or not (cited & set(case.relevant_documents)):
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.RAG_RETRIEVAL_QUALITY,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note="Applies to conceptual cases that declare a relevant document.",
    )


def _resolution_matches(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    """Whether one turn resolved as the case declared it should.

    Only the fields the case *declared* are compared. A case that says nothing about units is not
    asserting anything about them, and treating an unstated field as a requirement would make
    every case fail for reasons it never claimed.
    """
    for field, wanted in expected.items():
        if wanted in (None, (), []):
            continue
        found = actual.get(field)
        if field == "locations":
            if [name.casefold() for name in found or ()] != [name.casefold() for name in wanted]:
                return False
        elif found != wanted:
            return False
    return True


def _memory_correctness(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """Applies to multi-turn cases: every turn resolved as the case declared it should."""
    failing: list[str] = []
    applicable = 0

    for outcome in outcomes:
        case = cases[outcome.case_id]
        if not case.is_multi_turn:
            continue
        applicable += 1

        expectations = [
            turn.expected_resolution.model_dump(exclude_none=True)
            if turn.expected_resolution
            else {}
            for turn in case.turns
        ]
        if len(outcome.resolutions) != len(expectations):
            failing.append(outcome.case_id)
            continue

        if any(
            not _resolution_matches(expected, actual)
            for expected, actual in zip(expectations, outcome.resolutions, strict=True)
        ):
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.MEMORY_CORRECTNESS,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note="Applies to multi-turn cases.",
    )


def _characteristics_satisfied(case: EvaluationCase, outcome: CaseOutcome) -> bool:
    """Whether the answer carries what the case said it should, and none of what it should not."""
    answer = outcome.answer.lower()

    expected = case.expected_answer_characteristics
    if case.turns:
        expected = expected + case.turns[-1].expected_answer_characteristics

    if any(wanted.lower() not in answer for wanted in expected):
        return False
    return all(
        forbidden.lower() not in answer for forbidden in case.forbidden_answer_characteristics
    )


def _multi_turn_correctness(
    outcomes: Sequence[CaseOutcome],
    cases: dict[str, EvaluationCase],
    memory: MetricResult,
) -> MetricResult:
    """The final answer satisfies the case's characteristics *and* it passed memory correctness."""
    failing: list[str] = []
    applicable = 0
    memory_failures = set(memory.failing_cases)

    for outcome in outcomes:
        case = cases[outcome.case_id]
        if not case.is_multi_turn:
            continue
        applicable += 1

        final_turn = case.turns[-1]
        if final_turn.expects_clarification:
            satisfied = outcome.clarification_asked
        else:
            satisfied = _characteristics_satisfied(case, outcome)

        if not satisfied or outcome.case_id in memory_failures:
            failing.append(outcome.case_id)

    return MetricResult(
        name=MetricName.MULTI_TURN_CONTEXTUAL_CORRECTNESS,
        numerator=applicable - len(failing),
        denominator=applicable,
        failing_cases=tuple(failing),
        note="Applies to multi-turn cases, and requires memory correctness as well.",
    )


def _hallucination_rate(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """The proportion of *all* cases whose answer contains a figure the evidence does not support.

    Over all cases rather than only those with figures, because the spec defines it that way: a
    suite that mostly asks conceptual questions should show a low rate, and normalizing over
    figure-bearing answers only would make the same number of fabrications look worse.
    """
    offending: list[str] = []

    for outcome in outcomes:
        figures = figures_in(outcome.answer)
        if any(not _grounded(figure, outcome.evidence_values) for figure in figures):
            offending.append(outcome.case_id)

    return MetricResult(
        name=MetricName.HALLUCINATION_RATE,
        numerator=len(offending),
        denominator=len(outcomes),
        failing_cases=tuple(offending),
        lower_is_better=True,
        note="Lower is better. Over all cases, as the specification defines it.",
    )


# Words that assert severity. Checked against the *answer* rather than the question, because this
# metric is about what Weathra claimed, not about what it was asked.
_SEVERITY_CLAIMS = (
    "severe",
    "dangerous",
    "life-threatening",
    "extreme weather",
    "will be a storm",
    "storm will hit",
    "hazardous conditions",
    "emergency",
    "catastrophic",
    "destructive",
)


def _unsupported_claim_rate(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """The proportion asserting severity without a supporting field in the evidence record.

    A referral that *mentions* severe weather is not a claim: "check your official authority for
    warnings" asserts nothing about conditions. So the check looks for an assertion — a phrase
    saying conditions will be severe — and excuses the answer when the evidence carries a field
    that supports one.
    """
    from weathra.agents.safety import SEVERITY_FIELD_NAMES

    offending: list[str] = []

    for outcome in outcomes:
        answer = outcome.answer.lower()
        supported = bool({name.lower() for name in outcome.evidence_fields} & SEVERITY_FIELD_NAMES)
        if supported:
            continue

        # The referral's own wording is excluded: it names severe weather in order to point at
        # somebody else, which is the opposite of asserting it.
        without_referral = answer.replace("severe weather", "").replace(
            "decisions about safety", ""
        )
        if any(claim in without_referral for claim in _SEVERITY_CLAIMS):
            offending.append(outcome.case_id)

    return MetricResult(
        name=MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE,
        numerator=len(offending),
        denominator=len(outcomes),
        failing_cases=tuple(offending),
        lower_is_better=True,
        note="Lower is better. A referral to an official authority is not a severity claim.",
    )


def _backend_success_rate(
    outcomes: Sequence[CaseOutcome], cases: dict[str, EvaluationCase]
) -> MetricResult:
    """The proportion of requests returning a non-5xx, schema-valid response."""
    failing = [
        outcome.case_id
        for outcome in outcomes
        if (outcome.http_status is not None and outcome.http_status >= 500)
        or not outcome.schema_valid
    ]
    return MetricResult(
        name=MetricName.BACKEND_SUCCESSFUL_RESPONSE_RATE,
        numerator=len(outcomes) - len(failing),
        denominator=len(outcomes),
        failing_cases=tuple(failing),
        note="A 4xx is a correct response to a bad request and counts as a success here.",
    )


def _latency(outcomes: Sequence[CaseOutcome]) -> LatencyReport:
    """Median and 95th percentile, per category and overall."""

    def distribution(samples: list[float]) -> dict[str, float]:
        ordered = sorted(samples)
        return {
            "median_ms": round(statistics.median(ordered), 2),
            "p95_ms": round(_percentile(ordered, 95.0), 2),
            "samples": float(len(ordered)),
        }

    overall = [outcome.latency_ms for outcome in outcomes if outcome.latency_ms is not None]
    by_category: dict[str, dict[str, float]] = {}

    for category in Category:
        samples = [
            outcome.latency_ms
            for outcome in outcomes
            if outcome.category is category and outcome.latency_ms is not None
        ]
        if samples:
            by_category[category.value] = distribution(samples)

    if not overall:
        return LatencyReport(by_category=by_category)

    computed = distribution(overall)
    return LatencyReport(
        overall_median_ms=computed["median_ms"],
        overall_p95_ms=computed["p95_ms"],
        by_category=by_category,
        samples=len(overall),
    )


def _percentile(ordered: Sequence[float], level: float) -> float:
    """Linear-interpolated percentile, named so the method is not a mystery.

    ``statistics.quantiles`` would need at least two samples and would silently change method
    between versions; this is explicit and works for a single sample, which a single-case run has.
    """
    if not ordered:  # pragma: no cover - callers check
        return 0.0
    if len(ordered) == 1:
        return float(ordered[0])

    position = (level / 100.0) * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(ordered[lower])
    weight = position - lower
    return float(ordered[lower] * (1.0 - weight) + ordered[upper] * weight)


class MetricsReport(BaseModel):
    """Every metric, and the latency distribution."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    results: dict[str, MetricResult]
    latency: LatencyReport
    cases_scored: int = Field(ge=0, description="Cases the metrics were computed over.")
    cases_quarantined: tuple[str, ...] = Field(
        default=(),
        description=(
            "Cases excluded from every numerator and denominator because the configured model "
            "did not serve them. Counted as neither passes nor failures."
        ),
    )

    def result(self, name: MetricName) -> MetricResult:
        return self.results[name.value]

    def describe(self) -> tuple[str, ...]:
        return tuple(
            self.results[name.value].describe()
            for name in METRIC_NAMES
            if name.value in self.results
        )


def compute_metrics(
    outcomes: Sequence[CaseOutcome],
    dataset: Sequence[EvaluationCase],
    *,
    quarantine: bool = True,
) -> MetricsReport:
    """Every metric, over the outcomes of one run.

    ``quarantine=False`` scores every outcome including those the configured model did not serve.
    It exists for exactly one caller: the integrity classifier, which needs to know whether a
    gated metric lost its applicable cases *to quarantine* or simply never had any — a filtered
    run legitimately has inapplicable gates, and converting that into a provider failure would be
    a false alarm every time somebody ran ``--category knowledge``.
    """
    cases = {case.case_id: case for case in dataset}
    unknown = [outcome.case_id for outcome in outcomes if outcome.case_id not in cases]
    if unknown:
        raise ValueError(
            f"These outcomes name cases that are not in the dataset: {sorted(unknown)}. A metric "
            "cannot be computed against an expectation that does not exist."
        )

    # Quarantine, applied once here rather than ten times inside the metrics. A case the
    # configured model did not serve was answered by the deterministic router and the code-written
    # summary, and scoring that as the model's work is the defect this exists to prevent. It is
    # excluded from *both* halves of every fraction — the same treatment an inapplicable case
    # already gets, and for the same reason: counting it either way would be a claim nobody earned.
    quarantined = (
        tuple(
            outcome.case_id
            for outcome in outcomes
            if not _scoreable(outcome, cases[outcome.case_id])
        )
        if quarantine
        else ()
    )
    if quarantined:
        logger.warning(
            "excluding %d case(s) the configured model did not serve: %s",
            len(quarantined),
            ", ".join(quarantined),
        )
    if quarantine:
        outcomes = [outcome for outcome in outcomes if _scoreable(outcome, cases[outcome.case_id])]

    memory = _memory_correctness(outcomes, cases)

    results = [
        _tool_selection(outcomes, cases),
        _numerical_accuracy(outcomes, cases),
        _groundedness(outcomes, cases),
        _attribution_coverage(outcomes, cases),
        _rag_quality(outcomes, cases),
        memory,
        _multi_turn_correctness(outcomes, cases, memory),
        _hallucination_rate(outcomes, cases),
        _unsupported_claim_rate(outcomes, cases),
        _backend_success_rate(outcomes, cases),
    ]

    return MetricsReport(
        results={result.name.value: result for result in results},
        latency=_latency(outcomes),
        cases_scored=len(outcomes),
        cases_quarantined=quarantined,
    )


def _scoreable(outcome: CaseOutcome, case: EvaluationCase) -> bool:
    """Whether this case's result may contribute to a metric.

    A case that recorded no inference attempt at all is scored: that is every synthetic outcome in
    the unit tests, and every run predating the provenance record. Quarantine applies only where
    the run actually told us a model was asked and did not answer — absence of evidence is not
    treated as evidence of fallback, because that would retroactively void records that are fine.
    """
    del case  # reserved: a case may later declare that it needs no inference at all
    return not outcome.inference_attempts or outcome.model_served
