"""The five criteria a promotion decision may rest on (``specs/evaluation``).

The metrics module already computes what Weathra measures. This computes what a *promotion*
compares — a narrower and more opinionated set, because the question "is this model better" is
not the same question as "did this run pass".

    | Criterion         | Measured by                                                    |
    |-------------------|----------------------------------------------------------------|
    | JSON reliability  | first-attempt-valid proportion, and mean attempts to a decision |
    | Groundedness      | the groundedness metric, with hallucination and claim rates     |
    | Latency           | median and 95th percentile, per call role and overall           |
    | Planning quality  | tool-selection accuracy, plus multi-step plan and order         |
    | Cost              | recorded tokens against catalog pricing, labelled an estimate   |

**All five are always reported, and an unmeasured one reports null rather than a default.** A
candidate evaluated over a subset with no multi-step case has not achieved perfect plan correctness
— it has not been asked. Filling that in with 1.0 would put a number on a promotion decision that
nothing measured, which is the failure this whole layer exists to prevent.

**Structured reliability and groundedness are gates; latency and cost are not.**
``promotion_blockers`` names which of the two gates a candidate failed, and
`specs/evaluation` requires that a candidate failing either is not promoted on the strength of
being cheaper or faster. The refusal lives with the promotion action; the *finding* lives here,
because the criteria are what the decision has to be recorded against.

**Numerical calculation accuracy is not a criterion and is deliberately checked as an invariant.**
Figures come from deterministic analytics rather than from the model, so every candidate scores
100% over the same fixtures. A candidate that does not has exposed a grounding defect, and
``numerical_accuracy_intact`` reports it as exactly that rather than as a reason to prefer a
different model.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.evidence import InferenceStage, InferenceStatus
from weathra.evaluation.cases import EvaluationCase
from weathra.evaluation.metrics import (
    CaseOutcome,
    MetricName,
    MetricsReport,
    # The same percentile the latency report uses, deliberately: two implementations would
    # eventually disagree about the 95th of an even-length sample.
    _percentile,
)
from weathra.telemetry.cost import CostEstimate, estimate

__all__ = [
    "GATING_CRITERIA",
    "CostCriterion",
    "GroundednessCriterion",
    "LatencyCriterion",
    "PlanningCriterion",
    "SelectionCriteria",
    "StructuredReliability",
    "compute_criteria",
]

# The two a candidate may not be promoted past. Named rather than checked inline, so the promotion
# action and the report agree about which criteria are gates.
GATING_CRITERIA: tuple[str, ...] = ("structured_json_reliability", "groundedness")


class StructuredReliability(BaseModel):
    """How dependably a candidate returns schema-valid structured output.

    The routing decision is the only structured call Weathra makes, and a model that needs three
    attempts at it is a model whose every question costs three routing calls. Both halves of the
    spec's definition are here because they say different things: the proportion says how often it
    is right first time, the mean says how expensive being wrong is.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    first_attempt_valid_rate: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Null where no structured call was made."
    )
    mean_attempts_to_valid: float | None = Field(default=None, ge=0.0)
    decisions: int = Field(default=0, ge=0, description="Structured decisions observed.")
    attempts: int = Field(default=0, ge=0, description="Calls made across those decisions.")


class GroundednessCriterion(BaseModel):
    """Whether the prose stayed inside what was retrieved. Three measures, one question."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    groundedness: float | None = Field(default=None, ge=0.0, le=1.0)
    hallucination_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    unsupported_weather_claim_rate: float | None = Field(default=None, ge=0.0, le=1.0)


class LatencyCriterion(BaseModel):
    """Median and 95th percentile, overall and per call role.

    Per *role* rather than per case, because routing and synthesis are different calls with
    different shapes, and a candidate that is fast at one and slow at the other is a candidate a
    single number would misdescribe.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    overall_median_ms: float | None = None
    overall_p95_ms: float | None = None
    by_call_role: dict[str, dict[str, float]] = Field(default_factory=dict)
    samples: int = Field(default=0, ge=0)


class PlanningCriterion(BaseModel):
    """Tool selection, and whether a multi-step plan named the right steps in the right order."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    tool_selection_accuracy: float | None = Field(default=None, ge=0.0, le=1.0)
    plan_correctness: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Null where no multi-step case was evaluated."
    )
    multi_step_cases: int = Field(default=0, ge=0)
    plan_order_correct: tuple[str, ...] = ()
    plan_order_incorrect: tuple[str, ...] = ()


class CostCriterion(BaseModel):
    """What the run cost, from recorded tokens and catalog pricing. An estimate, always.

    Null rather than zero where the gateway reported no tokens: a run whose token counts are
    missing has not been shown to be free, and a promotion decision made on a fabricated zero is
    exactly the decision `specs/evaluation` forbids.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    estimated_total: Decimal | None = None
    estimated_per_case: Decimal | None = None
    currency: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    is_estimate: bool = Field(
        default=True, description="Always true. Never a billed amount, and labelled so."
    )


class SelectionCriteria(BaseModel):
    """One candidate's five criteria, as a promotion decision compares them."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str
    gateway_model: str | None = None
    structured_json_reliability: StructuredReliability
    groundedness: GroundednessCriterion
    latency: LatencyCriterion
    planning: PlanningCriterion
    cost: CostCriterion
    numerical_accuracy_intact: bool | None = Field(
        default=None,
        description="Null where no numeric case ran. False means a grounding defect, never a "
        "reason to prefer another candidate.",
    )

    def promotion_blockers(
        self, *, minimum_reliability: float = 0.95, maximum_hallucination: float = 0.0
    ) -> tuple[str, ...]:
        """Which gating criteria this candidate failed, by name.

        Only the two gates. Latency and cost are reported and never block, which is the asymmetry
        `specs/evaluation` asks for: a candidate may be promoted for being cheaper, and may not be
        promoted *despite* being unreliable.

        An unmeasured gate blocks. A candidate nobody asked a structured question of has not
        demonstrated reliability, and treating silence as a pass would let a subset run promote a
        model on evidence it never produced.
        """
        failed: list[str] = []

        rate = self.structured_json_reliability.first_attempt_valid_rate
        if rate is None or rate < minimum_reliability:
            failed.append("structured_json_reliability")

        hallucination = self.groundedness.hallucination_rate
        grounded = self.groundedness.groundedness
        if grounded is None or hallucination is None or hallucination > maximum_hallucination:
            failed.append("groundedness")

        return tuple(failed)


def compute_criteria(
    *,
    catalog_key: str,
    gateway_model: str | None,
    outcomes: Sequence[CaseOutcome],
    cases: Sequence[EvaluationCase],
    metrics: MetricsReport,
    input_price_per_million: Decimal | str | None = None,
    output_price_per_million: Decimal | str | None = None,
    currency: str = "USD",
) -> SelectionCriteria:
    """The five criteria for one candidate, from what its run actually recorded.

    Everything here is derived from ``outcomes`` and ``metrics`` — the same records a persisted run
    is re-scored from. Nothing reads a live object, so a stored comparison can be recomputed and
    two runs can be compared without either being re-executed.
    """
    by_id = {case.case_id: case for case in cases}
    return SelectionCriteria(
        catalog_key=catalog_key,
        gateway_model=gateway_model,
        structured_json_reliability=_structured(outcomes),
        groundedness=_groundedness(metrics),
        latency=_latency(outcomes),
        planning=_planning(outcomes, by_id, metrics),
        cost=_cost(
            outcomes,
            input_price_per_million=input_price_per_million,
            output_price_per_million=output_price_per_million,
            currency=currency,
        ),
        numerical_accuracy_intact=_numerical_intact(metrics),
    )


# =========================================================================== the five


def _structured(outcomes: Sequence[CaseOutcome]) -> StructuredReliability:
    """Group the routing attempts into decisions, and measure how many took one try.

    A *decision* is a run of attempts ending in a served one, which is exactly how
    `agents/llm/instrumented.py` links them: attempt one, then attempt two retrying it. So a
    decision starts wherever ``attempt_number`` returns to 1.
    """
    decisions: list[list[int]] = []
    for outcome in outcomes:
        for attempt in outcome.inference_attempts:
            if attempt.stage is not InferenceStage.ROUTING:
                continue
            if attempt.attempt_number == 1 or not decisions:
                decisions.append([])
            decisions[-1].append(attempt.attempt_number)

    if not decisions:
        return StructuredReliability()

    attempts = sum(len(run) for run in decisions)
    first_time = sum(1 for run in decisions if len(run) == 1)
    return StructuredReliability(
        first_attempt_valid_rate=first_time / len(decisions),
        mean_attempts_to_valid=attempts / len(decisions),
        decisions=len(decisions),
        attempts=attempts,
    )


def _groundedness(metrics: MetricsReport) -> GroundednessCriterion:
    return GroundednessCriterion(
        groundedness=metrics.result(MetricName.GROUNDEDNESS).value,
        hallucination_rate=metrics.result(MetricName.HALLUCINATION_RATE).value,
        unsupported_weather_claim_rate=metrics.result(
            MetricName.UNSUPPORTED_WEATHER_CLAIM_RATE
        ).value,
    )


def _latency(outcomes: Sequence[CaseOutcome]) -> LatencyCriterion:
    """Per call role from the recorded attempts, and overall from the cases.

    The overall figure is the case's end-to-end latency, which is what a person waits; the
    per-role figures are the model's own, which is what distinguishes two candidates. Reporting
    only one of them would answer a different question from the one being asked.
    """
    per_role: dict[str, list[float]] = {}
    for outcome in outcomes:
        for attempt in outcome.inference_attempts:
            if attempt.latency_ms is None or attempt.status is not InferenceStatus.SERVED:
                continue
            per_role.setdefault(attempt.stage.value, []).append(attempt.latency_ms)

    overall = sorted(item.latency_ms for item in outcomes if item.latency_ms is not None)
    return LatencyCriterion(
        overall_median_ms=_percentile(overall, 0.50) if overall else None,
        overall_p95_ms=_percentile(overall, 0.95) if overall else None,
        by_call_role={
            role: {
                "median_ms": _percentile(sorted(samples), 0.50),
                "p95_ms": _percentile(sorted(samples), 0.95),
                "samples": float(len(samples)),
            }
            for role, samples in sorted(per_role.items())
        },
        samples=len(overall),
    )


def _planning(
    outcomes: Sequence[CaseOutcome],
    cases: Mapping[str, EvaluationCase],
    metrics: MetricsReport,
) -> PlanningCriterion:
    """Tool accuracy from the metrics, plus multi-step order correctness measured here.

    Order is the half the tool-selection metric does not carry: it asks whether the right tools
    were called, and a plan that calls them backwards satisfies that while being wrong. A
    multi-step case is one expecting more than one tool.
    """
    correct: list[str] = []
    incorrect: list[str] = []

    for outcome in outcomes:
        case = cases.get(outcome.case_id)
        if case is None or len(case.expected_tools) < 2:
            continue
        called = [tool for tool in outcome.tools_called if tool in set(case.expected_tools)]
        # De-duplicated in first-call order: a tool invoked twice is one step of the plan, and
        # counting it twice would make a correct plan look out of order.
        ordered = list(dict.fromkeys(called))
        (correct if tuple(ordered) == tuple(case.expected_tools) else incorrect).append(
            outcome.case_id
        )

    multi_step = len(correct) + len(incorrect)
    return PlanningCriterion(
        tool_selection_accuracy=metrics.result(MetricName.TOOL_SELECTION_ACCURACY).value,
        plan_correctness=(len(correct) / multi_step) if multi_step else None,
        multi_step_cases=multi_step,
        plan_order_correct=tuple(correct),
        plan_order_incorrect=tuple(incorrect),
    )


def _cost(
    outcomes: Sequence[CaseOutcome],
    *,
    input_price_per_million: Decimal | str | None,
    output_price_per_million: Decimal | str | None,
    currency: str,
) -> CostCriterion:
    """Tokens against catalog pricing, through the same estimator telemetry uses.

    Not a second cost calculation: `telemetry/cost.py` is the one place money arithmetic happens,
    and a comparison computing its own would eventually disagree with the usage events it is
    supposed to be reconcilable with.

    `CaseOutcome` carries no token counts today — the evaluation runner reads its attempts out of
    the evidence record, which records latency and status rather than tokens. So this reports
    nulls for an offline run and real figures once a caller supplies them, which is the honest
    shape: unmeasured is null, never zero.
    """
    if input_price_per_million is None or output_price_per_million is None:
        return CostCriterion(currency=None)

    prompt = sum(getattr(outcome, "prompt_tokens", 0) or 0 for outcome in outcomes)
    completion = sum(getattr(outcome, "completion_tokens", 0) or 0 for outcome in outcomes)
    if prompt == 0 and completion == 0:
        return CostCriterion(currency=currency)

    computed: CostEstimate | None = estimate(
        prompt_tokens=prompt,
        completion_tokens=completion,
        input_price_per_million=Decimal(str(input_price_per_million)),
        output_price_per_million=Decimal(str(output_price_per_million)),
        currency=currency,
    )
    if computed is None:  # pragma: no cover - both prices are present by the guard above
        return CostCriterion(currency=currency)

    cases = len(outcomes) or 1
    return CostCriterion(
        estimated_total=computed.amount,
        estimated_per_case=computed.amount / cases,
        currency=computed.currency,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
    )


def _numerical_intact(metrics: MetricsReport) -> bool | None:
    """Whether every figure the model asserted matched the deterministic computation.

    ``None`` where no numeric case ran — an unasked question has no answer, and reporting `True`
    would claim an accuracy nothing measured.
    """
    value = metrics.result(MetricName.NUMERICAL_CALCULATION_ACCURACY).value
    return None if value is None else value >= 1.0
