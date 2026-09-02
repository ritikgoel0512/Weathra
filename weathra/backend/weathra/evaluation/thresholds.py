"""The acceptance thresholds, and what a run reports when it misses one.

``specs/evaluation`` sets seven gating thresholds and requires four more metrics to be *reported
whether or not they gate acceptance*. Both halves matter, and for opposite reasons: the gates make
"good enough" a fact rather than an opinion, and the non-gating metrics keep a run honest about
things a gate would be the wrong instrument for.

**A missed threshold is reported with its margin.** "Tool selection missed by 2 points" is
actionable and "failed" is not, and the margin is what tells a reader whether a run is nearly there
or badly wrong.

**Lower-is-better thresholds compare the other way, and the direction is data.** Getting that wrong
would report a run with a 40% hallucination rate as passing a "below 2%" threshold, which is the
single most dangerous mistake this module could make — so the direction comes from the metric's own
``lower_is_better`` flag rather than from a comparison written per threshold.

**An inapplicable metric does not pass a gate; it is reported as unmeasured.** A filtered run
covering only conceptual cases has not achieved 100% numerical accuracy. Whether that makes the
*run* fail is a judgement, and the honest one is that a filtered run is not an acceptance run — so
it is reported as inapplicable and excluded from the overall verdict, with the run's own filter
recorded so nobody mistakes it for a full pass.

**A failing threshold is reported, never adjusted.** Stated here because the temptation is real and
the whole apparatus is worthless if it is yielded to.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, ConfigDict, Field

from weathra.evaluation.metrics import MetricName, MetricResult, MetricsReport

__all__ = [
    "THRESHOLDS",
    "ThresholdOutcome",
    "ThresholdReport",
    "evaluate_thresholds",
]

logger = logging.getLogger("weathra.evaluation.thresholds")


class Threshold(BaseModel):
    """One acceptance threshold, as the specification's table states it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: MetricName
    minimum: float | None = Field(
        default=None, description="The rate the metric must reach, as a proportion."
    )
    maximum: float | None = Field(
        default=None, description="The rate a lower-is-better metric must stay below."
    )
    statement: str = Field(min_length=1, description="The threshold in the spec's own words.")

    def satisfied_by(self, result: MetricResult) -> bool | None:
        """Whether this threshold is met, or ``None`` when the metric was not applicable."""
        value = result.value
        if value is None:
            return None
        if self.maximum is not None:
            return value < self.maximum
        return value >= (self.minimum or 0.0)

    def margin(self, result: MetricResult) -> float | None:
        """How far short, in percentage points. Negative means it passed by that much."""
        value = result.value
        if value is None:
            return None
        if self.maximum is not None:
            return (value - self.maximum) * 100.0
        return ((self.minimum or 0.0) - value) * 100.0


# The seven gating thresholds, transcribed from ``specs/evaluation``'s table.
THRESHOLDS: tuple[Threshold, ...] = (
    Threshold(
        metric=MetricName.TOOL_SELECTION_ACCURACY,
        minimum=0.95,
        statement="Tool-selection accuracy: at least 95%",
    ),
    Threshold(
        metric=MetricName.NUMERICAL_CALCULATION_ACCURACY,
        minimum=1.0,
        statement="Numerical calculation accuracy: 100%",
    ),
    Threshold(
        metric=MetricName.SOURCE_ATTRIBUTION_COVERAGE,
        minimum=1.0,
        statement="Source attribution coverage: 100% of weather-data answers",
    ),
    Threshold(
        metric=MetricName.RAG_RETRIEVAL_QUALITY,
        minimum=0.90,
        statement="RAG grounded answer rate: at least 90%",
    ),
    Threshold(
        metric=MetricName.MULTI_TURN_CONTEXTUAL_CORRECTNESS,
        minimum=0.90,
        statement="Multi-turn contextual correctness: at least 90%",
    ),
    Threshold(
        metric=MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE,
        maximum=0.02,
        statement="Unsupported weather claim rate: below 2%",
    ),
    Threshold(
        metric=MetricName.BACKEND_SUCCESSFUL_RESPONSE_RATE,
        minimum=0.95,
        statement="Backend successful-response rate: at least 95%",
    ),
)

# Reported for every run whether or not they gate acceptance, because a gate would be the wrong
# instrument: groundedness and hallucination rate depend on a heuristic figure match, memory
# correctness on a small denominator, and latency on the machine the run happened to be on.
NON_GATING_METRICS: tuple[MetricName, ...] = (
    MetricName.GROUNDEDNESS,
    MetricName.MEMORY_CORRECTNESS,
    MetricName.HALLUCINATION_RATE,
)


class ThresholdOutcome(BaseModel):
    """One threshold's verdict, with the margin that makes it actionable."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: MetricName
    statement: str
    passed: bool | None = Field(
        description="None when the metric was not applicable to this run's cases."
    )
    value: float | None = None
    margin_points: float | None = Field(
        default=None, description="How far short, in percentage points. Negative means a pass."
    )
    failing_cases: tuple[str, ...] = ()

    @property
    def missed(self) -> bool:
        return self.passed is False

    def describe(self) -> str:
        if self.passed is None:
            return f"{self.statement} — not applicable (no cases measured it)"
        if self.passed:
            return f"{self.statement} — PASS ({(self.value or 0.0) * 100:.1f}%)"
        return (
            f"{self.statement} — FAIL ({(self.value or 0.0) * 100:.1f}%, short by "
            f"{abs(self.margin_points or 0.0):.1f} points); failing: "
            f"{', '.join(self.failing_cases) or 'none named'}"
        )


class ThresholdReport(BaseModel):
    """Every threshold's verdict, the overall one, and the metrics that do not gate."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    outcomes: tuple[ThresholdOutcome, ...]
    non_gating: dict[str, MetricResult] = Field(
        default_factory=dict, description="Reported for every run, gating or not."
    )
    passed: bool = Field(
        description=(
            "True when every *applicable* threshold is met. A threshold whose metric had no "
            "applicable cases is not counted either way."
        )
    )
    measured_thresholds: int = Field(ge=0)
    inapplicable_thresholds: tuple[str, ...] = ()

    @property
    def missed(self) -> tuple[ThresholdOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if outcome.missed)

    def summary(self) -> str:
        if self.passed and not self.inapplicable_thresholds:
            return f"PASS — every one of {self.measured_thresholds} thresholds met."
        if self.passed:
            return (
                f"PASS — {self.measured_thresholds} thresholds met; "
                f"{len(self.inapplicable_thresholds)} not applicable to this run's cases "
                f"({', '.join(self.inapplicable_thresholds)})."
            )
        names = ", ".join(outcome.metric.value for outcome in self.missed)
        return f"FAIL — {len(self.missed)} of {self.measured_thresholds} thresholds missed: {names}"

    def describe(self) -> tuple[str, ...]:
        lines = [outcome.describe() for outcome in self.outcomes]
        lines.append("")
        lines.append("Reported but not gating:")
        lines.extend(f"  {result.describe()}" for result in self.non_gating.values())
        return tuple(lines)


def evaluate_thresholds(report: MetricsReport) -> ThresholdReport:
    """Every threshold, judged against the metrics, with margins and failing cases named."""
    outcomes: list[ThresholdOutcome] = []
    inapplicable: list[str] = []

    for threshold in THRESHOLDS:
        result = report.results.get(threshold.metric.value)
        if result is None:  # pragma: no cover - compute_metrics returns all ten
            continue

        passed = threshold.satisfied_by(result)
        if passed is None:
            inapplicable.append(threshold.metric.value)

        outcomes.append(
            ThresholdOutcome(
                metric=threshold.metric,
                statement=threshold.statement,
                passed=passed,
                value=result.value,
                margin_points=threshold.margin(result),
                failing_cases=result.failing_cases if passed is False else (),
            )
        )

    measured = [outcome for outcome in outcomes if outcome.passed is not None]
    overall = all(outcome.passed for outcome in measured)

    if not overall:
        logger.warning(
            "evaluation failed %d threshold(s): %s",
            len([outcome for outcome in measured if not outcome.passed]),
            ", ".join(outcome.metric.value for outcome in measured if outcome.passed is False),
        )

    return ThresholdReport(
        outcomes=tuple(outcomes),
        non_gating={
            name.value: report.results[name.value]
            for name in NON_GATING_METRICS
            if name.value in report.results
        },
        passed=overall,
        measured_thresholds=len(measured),
        inapplicable_thresholds=tuple(inapplicable),
    )
