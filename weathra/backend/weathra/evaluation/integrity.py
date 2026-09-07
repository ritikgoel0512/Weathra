"""Whether a run measured the model, or measured what happened when the model did not answer.

Task 22.8's live runs are why this module exists. The configured model had been withdrawn
upstream and returned HTTP 404 for every call, so the supervisor routed deterministically and the
synthesis node wrote its own summary — both correct product behaviour, and both invisible to the
evaluation. Forty code-written answers were scored against expectations meant for a language
model, the thresholds were missed, and the run was recorded as a *quality* failure of a model that
had never answered.

**The distinction this module holds.** A run's metrics are model-quality metrics only when the
configured model materially served the run. Otherwise they measure the deterministic fallback,
which is a different subject, and reporting them as the model's performance is a false statement
about a model.

**Why contamination is not partially salvageable.** The obvious intuition — a fallback run just
scores worse, so a partial one is a slightly pessimistic reading — is wrong, and it is wrong in
the direction that matters. ``agents/plan.py``'s deterministic router keys off real vocabulary and
routes many questions *correctly*, so tool-selection accuracy can be **inflated** by fallback; and
``code_written_summary`` copies findings verbatim, so groundedness and numerical accuracy score
*well*. A mixed run is not uniformly worse than a served one, it is differently shaped, and no
interpolation recovers the model's number from it.

So: **quarantine, then gate.** An unserved case is excluded from every numerator and every
denominator — the treatment ``evaluation/metrics.py`` already gives an inapplicable case, for the
same reason and with the same honesty: it is not counted as a pass, and not counted as a failure.
Then the run as a whole is scored only if enough of it was served to be worth scoring.

**Invalid output is not an outage.** A model that answers with unparseable JSON has materially
served the evaluation and performed badly. Folding that into infrastructure would let a weak model
launder its failures as a provider outage — the exact mirror of the defect above — so
``InferenceStatus.INVALID_OUTPUT`` counts as served and is scored.
"""

from __future__ import annotations

import logging
from collections import Counter
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.evidence import InferenceAttempt, InferenceStatus
from weathra.evaluation.metrics import CaseOutcome, MetricsReport
from weathra.evaluation.provisioning import EvaluationMode

__all__ = ["InferenceIntegrity", "RunOutcome", "assess_integrity", "case_is_model_served"]

logger = logging.getLogger("weathra.evaluation.integrity")


class RunOutcome(StrEnum):
    """What a run is entitled to claim about the model it ran against."""

    SCORED = "scored"
    """The model served enough of the run that the metrics are model-quality metrics."""

    PROVIDER_FAILURE = "provider_failure"
    """The model did not materially serve the run. No quality verdict is available."""

    NOT_APPLICABLE = "not_applicable"
    """An offline run: no live model was under evaluation, so the question does not arise."""


def case_is_model_served(attempts: tuple[InferenceAttempt, ...]) -> bool:
    """Whether the configured model materially served one case.

    Every attempt served — not "at least one". A case whose routing came from the model and whose
    prose came from ``code_written_summary`` is contaminated in exactly the dimension the wording
    metrics measure, and a case with no attempt at all had no model in it to evaluate.
    """
    return bool(attempts) and all(attempt.served for attempt in attempts)


class InferenceIntegrity(BaseModel):
    """What served this run, what did not, and whether it may be scored as model quality."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    mode: EvaluationMode
    outcome: RunOutcome
    cases_total: int = Field(ge=0)
    cases_model_served: int = Field(ge=0)
    quarantined_cases: tuple[str, ...] = Field(
        default=(),
        description="Excluded from every numerator and denominator; neither passes nor failures.",
    )
    attempts_by_status: dict[str, int] = Field(
        default_factory=dict, description="Every call attempt the run made, counted by outcome."
    )
    served_models: tuple[str, ...] = Field(
        default=(),
        description=(
            "Every distinct model the gateway reported as having answered. More than one means a "
            "route substituted a model, which a pinned evaluation needs to see."
        ),
    )
    minimum_served_rate: float = Field(ge=0.0, le=1.0)
    emptied_thresholds: tuple[str, ...] = Field(
        default=(),
        description="Gated metrics left with no applicable cases once quarantine was applied.",
    )
    reason: str | None = None

    @property
    def served_rate(self) -> float | None:
        if self.cases_total == 0:
            return None
        return self.cases_model_served / self.cases_total

    @property
    def representative(self) -> bool:
        """Whether this run's metrics may be presented as the model's performance."""
        return self.outcome is not RunOutcome.PROVIDER_FAILURE

    def describe(self) -> tuple[str, ...]:
        rate = self.served_rate
        lines = [
            f"outcome        {self.outcome.value}",
            f"model served   {self.cases_model_served}/{self.cases_total}"
            + (f" ({rate * 100:.1f}%)" if rate is not None else ""),
            f"floor          {self.minimum_served_rate * 100:.1f}%",
        ]
        if self.attempts_by_status:
            lines.append(
                "attempts       "
                + ", ".join(
                    f"{name} {count}" for name, count in sorted(self.attempts_by_status.items())
                )
            )
        if self.served_models:
            lines.append(f"served by      {', '.join(self.served_models)}")
        if self.quarantined_cases:
            lines.append(f"quarantined    {', '.join(self.quarantined_cases)}")
        if self.emptied_thresholds:
            lines.append(f"emptied gates  {', '.join(self.emptied_thresholds)}")
        if self.reason:
            lines.append(f"reason         {self.reason}")
        return tuple(lines)


def assess_integrity(
    outcomes: list[CaseOutcome] | tuple[CaseOutcome, ...],
    metrics: MetricsReport,
    *,
    mode: EvaluationMode,
    minimum_served_rate: float,
    gated_metrics: tuple[str, ...],
    metrics_before_quarantine: MetricsReport | None = None,
) -> InferenceIntegrity:
    """Judge whether this run's metrics are model-quality metrics.

    ``gated_metrics`` is passed in rather than imported so this module does not depend on
    ``thresholds``, which depends on ``metrics`` — and so a change to which metrics gate cannot
    silently change what "representative" means without the caller saying so.

    ``metrics_before_quarantine`` is the same computation with every case included. It is what
    separates a gate that *lost* its cases to quarantine from one that never had any: a run
    filtered to a single category has inapplicable gates for entirely legitimate reasons, and
    calling that a provider failure would cry wolf on every subset re-run.
    """
    total = len(outcomes)
    served = [outcome for outcome in outcomes if outcome.model_served]
    quarantined = tuple(outcome.case_id for outcome in outcomes if not outcome.model_served)

    counts: Counter[str] = Counter()
    models: list[str] = []
    for outcome in outcomes:
        for attempt in outcome.inference_attempts:
            counts[attempt.status.value] += 1
            if attempt.served_model and attempt.served_model not in models:
                models.append(attempt.served_model)

    # A gate whose cases were all quarantined does not pass vacuously: 39 cases quarantined and one
    # served would leave "numerical accuracy 1/1 = 100%" over a basis of one, which is a weaker
    # claim wearing the same number as a full pass. Only a gate that *had* cases and lost them
    # counts — an inapplicable gate on a filtered run is already reported honestly as unmeasured.
    before = metrics_before_quarantine
    emptied = tuple(
        name
        for name in gated_metrics
        if before is not None
        and (was := before.results.get(name)) is not None
        and was.applicable
        and (now := metrics.results.get(name)) is not None
        and not now.applicable
    )

    if mode is not EvaluationMode.LIVE:
        return InferenceIntegrity(
            mode=mode,
            outcome=RunOutcome.NOT_APPLICABLE,
            cases_total=total,
            cases_model_served=len(served),
            quarantined_cases=quarantined,
            attempts_by_status=dict(counts),
            served_models=tuple(models),
            minimum_served_rate=minimum_served_rate,
            reason="Offline mode evaluates no live model, so no model-quality claim is at stake.",
        )

    rate = (len(served) / total) if total else 0.0
    failure: str | None = None

    if total == 0:
        failure = "The run executed no case, so nothing was served."
    elif rate < minimum_served_rate:
        dominant = _dominant_failure(counts)
        failure = (
            f"The configured model served {len(served)} of {total} cases "
            f"({rate * 100:.1f}%), below the {minimum_served_rate * 100:.1f}% floor"
            + (f"; the commonest failure was {dominant}." if dominant else ".")
        )
    elif emptied:
        failure = (
            "Quarantining unserved cases left "
            f"{', '.join(emptied)} with no applicable case, so the gates it carries would pass "
            "over nothing."
        )

    if failure is not None:
        logger.warning("evaluation classified as a provider failure: %s", failure)

    return InferenceIntegrity(
        mode=mode,
        outcome=RunOutcome.PROVIDER_FAILURE if failure else RunOutcome.SCORED,
        cases_total=total,
        cases_model_served=len(served),
        quarantined_cases=quarantined,
        attempts_by_status=dict(counts),
        served_models=tuple(models),
        minimum_served_rate=minimum_served_rate,
        emptied_thresholds=emptied,
        reason=failure,
    )


def _dominant_failure(counts: Counter[str]) -> str | None:
    """The commonest non-served attempt outcome, for the sentence a reader actually acts on."""
    unserved = {
        name: count
        for name, count in counts.items()
        if not InferenceStatus(name).served and count > 0
    }
    if not unserved:
        return None
    name, count = max(unserved.items(), key=lambda item: item[1])
    return f"{name} ({count})"
