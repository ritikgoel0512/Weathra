"""Building a completed `ModelComparison` without running a model.

The persistence this supports takes a *finished* comparison as its input, which is exactly what
makes it testable without a gateway: every candidate outcome here is assembled from recorded
`CaseOutcome`s and scored by the real ``compute_metrics`` and ``compute_criteria``. So the criteria
under test are the canonical ones — nothing is hand-written into the shape the code expects — and
no OpenRouter call is made by any test that uses this.
"""

from __future__ import annotations

from datetime import UTC, datetime

from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.evaluation.cases import Category, EvaluationCase
from weathra.evaluation.criteria import compute_criteria
from weathra.evaluation.metrics import CaseOutcome, compute_metrics
from weathra.evaluation.model_compare import (
    CandidateCase,
    CandidateOutcome,
    ModelComparison,
    PinnedConfiguration,
)
from weathra.evaluation.provisioning import EvaluationMode

# Two seeded catalog keys, so the foreign key to `model_catalog` resolves against the real seed.
PRIMARY = "economy-free-primary"
SECONDARY = "economy-free-secondary"

DATASET = "1.0.0"
COMMIT = "abc1234"


def _routing(attempt: int, status: InferenceStatus) -> InferenceAttempt:
    return InferenceAttempt(
        stage=InferenceStage.ROUTING,
        attempt_number=attempt,
        status=status,
        provider="openrouter",
        selected_model="a/model",
        latency_ms=120.0,
    )


def _synthesis() -> InferenceAttempt:
    return InferenceAttempt(
        stage=InferenceStage.SYNTHESIS,
        attempt_number=1,
        status=InferenceStatus.SERVED,
        provider="openrouter",
        selected_model="a/model",
        latency_ms=380.0,
    )


def a_case(case_id: str) -> EvaluationCase:
    return EvaluationCase(
        case_id=case_id,
        category=Category.CURRENT_AND_FORECAST,
        description="A fixture case.",
        question="What is the forecast for Berlin?",
        expected_tools=("get_forecast",),
    )


def a_scored_outcome(case_id: str, *, grounded: bool, first_try: bool = True) -> CaseOutcome:
    """One case's record. *grounded* decides whether the asserted figure is in the evidence.

    The figure is in the answer text because that is what the groundedness metric reads: a case
    whose answer states no number is not applicable to it, and a comparison of two models over
    figure-free answers would leave the gate unmeasured rather than passed.
    """
    attempts = (
        (_routing(1, InferenceStatus.SERVED),)
        if first_try
        else (
            _routing(1, InferenceStatus.INVALID_OUTPUT),
            _routing(2, InferenceStatus.SERVED),
        )
    )
    return CaseOutcome(
        case_id=case_id,
        category=Category.CURRENT_AND_FORECAST,
        answer="Berlin is 12.5 degrees.",
        tools_called=("get_forecast",),
        evidence_values=(12.5,) if grounded else (30.0,),
        carries_weather_data=True,
        latency_ms=900.0,
        inference_attempts=(*attempts, _synthesis()),
    )


def an_evidenced_candidate(
    catalog_key: str,
    *,
    gateway_model: str = "a/model",
    case_ids: tuple[str, ...] = ("case-one",),
    grounded: bool = True,
    first_try: bool = True,
) -> CandidateOutcome:
    """A candidate that completed and was scored, through the canonical scoring path."""
    cases = [a_case(case_id) for case_id in case_ids]
    outcomes = [
        a_scored_outcome(case_id, grounded=grounded, first_try=first_try) for case_id in case_ids
    ]
    metrics = compute_metrics(outcomes, cases)
    return CandidateOutcome(
        catalog_key=catalog_key,
        gateway_model=gateway_model,
        completed=True,
        cases=tuple(
            CandidateCase(case_id=item.case_id, succeeded=True, latency_ms=item.latency_ms)
            for item in outcomes
        ),
        criteria=compute_criteria(
            catalog_key=catalog_key,
            gateway_model=gateway_model,
            outcomes=outcomes,
            cases=cases,
            metrics=metrics,
            input_price_per_million="0",
            output_price_per_million="0",
        ),
        metrics={name: metrics.results[name].value for name in metrics.results},
        cases_scored=metrics.cases_scored,
        passed=True,
    )


def a_failed_candidate(catalog_key: str, *, failure: str = "TimeoutError") -> CandidateOutcome:
    """A candidate whose run raised. No criteria, no cases, and that is the point."""
    return CandidateOutcome(
        catalog_key=catalog_key,
        gateway_model="a/model",
        completed=False,
        failure=failure,
    )


def an_unscored_candidate(catalog_key: str) -> CandidateOutcome:
    """A candidate whose run completed and measured nothing — the pre-flight aborted it.

    Deliberately the *realistic* shape rather than the convenient one: ``_aborted_run`` returns a
    result, so the comparison computes criteria over an empty set of outcomes and every one of them
    reports null. The candidate therefore arrives with criteria present and nothing scored, which
    is exactly the case a ``criteria is not None`` check alone would wave through.
    """
    metrics = compute_metrics([], [])
    return CandidateOutcome(
        catalog_key=catalog_key,
        gateway_model="a/model",
        completed=True,
        criteria=compute_criteria(
            catalog_key=catalog_key,
            gateway_model="a/model",
            outcomes=[],
            cases=[],
            metrics=metrics,
            input_price_per_million="0",
            output_price_per_million="0",
        ),
        metrics={name: metrics.results[name].value for name in metrics.results},
        cases_scored=0,
    )


def a_comparison(
    *candidates: CandidateOutcome,
    case_ids: tuple[str, ...] = ("case-one",),
    mode: EvaluationMode = EvaluationMode.LIVE,
    budget_exhausted: bool = False,
    identity_subject: str | None = None,
) -> ModelComparison:
    started = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)
    return ModelComparison(
        configuration=PinnedConfiguration(
            dataset_version=DATASET,
            mode=mode,
            weather_provider="open-meteo",
            embedding_model="BAAI/bge-small-en-v1.5",
            commit_sha=COMMIT,
            case_ids=case_ids,
        ),
        candidates=candidates,
        started_at=started,
        completed_at=datetime(2026, 9, 10, 12, 5, tzinfo=UTC),
        budget_exhausted=budget_exhausted,
        identity_subject=identity_subject,
    )
