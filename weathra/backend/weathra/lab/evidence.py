"""Task 32.2 and 32.8, completed — turning a finished comparison into citable evidence.

`evaluation/model_compare.py` computes the five criteria of `specs/evaluation` for every candidate,
and `lab/records.py` has always been able to store them. Nothing joined the two: the writer
``record_evaluation`` had no caller outside the tests, so ``model_evaluations`` stayed empty,
``model_comparison_results`` carried a permanently null ``evaluation_id``, and the promotion gate —
which reads exactly those rows — had nothing to read. `specs/model-lab` asks a comparison result to
name "the evaluation result where the case was scored" and `specs/evaluation` asks for "a model
evaluation record per model per run"; this is the writer both requirements assumed.

**It persists evidence; it decides nothing.** No policy row, no catalog status, no plan mapping and
no audit row is touched here. Promotion stays what `specs/model-lab` requires it to be — a separate,
separately authorized administrative write — and recording an evaluation is emphatically not one.

**Live only, and that is the substance of it.** An offline comparison runs every candidate against
``FakeLLMClient``, so its structured-output reliability and its groundedness are measurements of the
harness rather than of any model. Persisting those as ``model_evaluations`` rows would put scripted
numbers where the promotion gate reads for evidence, and a candidate could then be promoted on the
strength of a stand-in that always returns valid JSON. So an offline comparison is refused here
rather than recorded and captioned, because a caption is not a safeguard.

**Sufficiency is checked, never assumed.** A candidate that raised, that produced no criteria, or
that scored no case gets *no* evaluation row — not a row of nulls. `docs/evaluation.md` is explicit
that an unmeasured criterion is a finding rather than a default, and the same reasoning applies one
level up: a candidate the comparison never measured has not scored badly, it has not been measured,
and a row asserting otherwise is the fabrication this layer exists to prevent.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.usage import FailureClass
from weathra.evaluation.records import CandidateOutcome, EvaluationMode, ModelComparison
from weathra.lab.records import ComparisonResultRecord, LabRecords

__all__ = [
    "ComparisonEvidence",
    "persist_candidate_evaluations",
    "record_comparison",
]

logger = logging.getLogger("weathra.lab.evidence")

# Why a candidate contributed no evaluation row. Recorded rather than logged, because "which
# candidates did this comparison fail to measure" is the first question its reader asks.
DID_NOT_COMPLETE: Final[str] = "did_not_complete"
NO_CRITERIA: Final[str] = "no_criteria_computed"
NO_CASE_SCORED: Final[str] = "no_case_scored"


class ComparisonEvidence(BaseModel):
    """What a persisted comparison left behind, and what it could not evidence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: str
    evaluation_ids: dict[str, str] = Field(
        default_factory=dict,
        description="Catalog key to the `model_evaluations` row holding that candidate's five "
        "criteria. A candidate absent from this map produced no evidence.",
    )
    unevidenced: dict[str, str] = Field(
        default_factory=dict,
        description="Catalog key to why no evaluation was recorded for it.",
    )
    status: str = Field(description="The status the run should be closed with.")

    @property
    def evidenced_keys(self) -> tuple[str, ...]:
        return tuple(sorted(self.evaluation_ids))


def _insufficient(candidate: CandidateOutcome) -> str | None:
    """Why this candidate cannot be evidenced, or ``None`` where it can.

    Three separate reasons rather than one boolean, because they call for different responses: a
    candidate that raised may be a broken model, one that scored no case may have been stopped by
    the runner's own pre-flight, and neither is the same as a comparison bug.
    """
    if not candidate.completed:
        return candidate.failure or DID_NOT_COMPLETE
    if candidate.criteria is None:
        return NO_CRITERIA
    if candidate.cases_scored <= 0:
        # The pre-flight aborted the run, or every case was quarantined. `execute_run` returns a
        # result either way, so "it completed" is true and "it measured something" is not.
        return NO_CASE_SCORED
    return None


async def persist_candidate_evaluations(
    session: AsyncSession,
    *,
    run_id: str,
    comparison: ModelComparison,
) -> ComparisonEvidence:
    """Record each sufficiently-evidenced candidate's five criteria against an open run.

    The criteria themselves are not computed here and no formula is repeated: they arrive already
    computed by ``evaluation/criteria.py`` on the outcome, and are serialized by that module's own
    ``SelectionCriteria.recorded()`` so the document the promotion gate reads is produced in one
    place. This function's whole job is the association.

    The association is the one the schema was built for and needs no migration:
    ``model_comparison_runs`` → ``model_comparison_results`` (unique per run, candidate and case)
    → ``evaluation_id`` → ``model_evaluations``. Every cell of an evidenced candidate names that
    candidate's evaluation, because the evaluation scored the run those cells are the cases of.
    """
    mode = comparison.configuration.mode
    if mode is not EvaluationMode.LIVE:
        raise ValueError(
            f"A {mode.value} comparison measures the harness rather than the candidates, so it is "
            "not recorded as evaluation evidence. Run the comparison with mode=live, or keep the "
            "result in the run record without persisting it."
        )

    records = LabRecords(session)
    dataset_version = comparison.configuration.dataset_version
    commit_sha = comparison.configuration.commit_sha

    evaluation_ids: dict[str, str] = {}
    unevidenced: dict[str, str] = {}

    for candidate in comparison.candidates:
        reason = _insufficient(candidate)
        if reason is not None:
            unevidenced[candidate.catalog_key] = reason
            logger.info("no evaluation recorded for %s: %s", candidate.catalog_key, reason)
            continue

        assert candidate.criteria is not None  # _insufficient established it
        criteria = candidate.criteria.recorded()
        # Stated in the evidence itself rather than inferred from the run it hangs off, so a
        # promotion decision read a year later says which mode it rested on.
        criteria["mode"] = mode.value
        evaluation_ids[candidate.catalog_key] = await records.record_evaluation(
            catalog_key=candidate.catalog_key,
            gateway_model=candidate.gateway_model,
            dataset_version=dataset_version,
            metrics=candidate.metrics,
            criteria=criteria,
            passed=candidate.passed,
            commit_sha=commit_sha,
        )

    for candidate in comparison.candidates:
        await _record_cells(
            records,
            run_id=run_id,
            candidate=candidate,
            case_ids=comparison.configuration.case_ids,
            evaluation_id=evaluation_ids.get(candidate.catalog_key),
        )

    return ComparisonEvidence(
        run_id=run_id,
        evaluation_ids=evaluation_ids,
        unevidenced=unevidenced,
        status=_status(comparison, evidenced=bool(evaluation_ids), unevidenced=bool(unevidenced)),
    )


async def _record_cells(
    records: LabRecords,
    *,
    run_id: str,
    candidate: CandidateOutcome,
    case_ids: tuple[str, ...],
    evaluation_id: str | None,
) -> None:
    """One cell per case this candidate was asked, measured where the run measured it.

    Tokens, cost and policy stay null throughout, and deliberately. The evaluation runner does not
    attribute tokens per case, a comparison pins a model rather than resolving a policy, and the
    cost the run *does* know is a per-run figure carried by the cost criterion. Filling any of them
    in here would turn an absent measurement into a stated one.
    """
    measured = {case.case_id: case for case in candidate.cases}
    for case_id in case_ids:
        case = measured.get(case_id)
        succeeded = case.succeeded if case is not None else False
        await records.record_result(
            run_id,
            ComparisonResultRecord(
                catalog_key=candidate.catalog_key,
                gateway_model=candidate.gateway_model,
                case_id=case_id,
                latency_ms=case.latency_ms if case is not None else None,
                succeeded=succeeded,
                # The comparison records that a case did not succeed, not why at the coarseness
                # `FailureClass` describes. Saying ``unclassified`` is honest; picking one of the
                # other five from an exception type would be a guess wearing a classification.
                failure_class=None if succeeded else FailureClass.UNCLASSIFIED,
                evaluation_id=evaluation_id,
            ),
        )


def _status(comparison: ModelComparison, *, evidenced: bool, unevidenced: bool) -> str:
    """The run status, decided on evidence rather than on completion.

    A candidate can complete and measure nothing — the pre-flight aborts its run and `execute_run`
    still returns a result. Closing such a comparison ``completed`` would describe a run that
    produced no evidence as a finished one, so the question asked here is what was evidenced.
    """
    if not evidenced:
        return "failed"
    if unevidenced or comparison.budget_exhausted:
        return "partial"
    return "completed"


async def record_comparison(
    session: AsyncSession,
    comparison: ModelComparison,
    *,
    initiated_by: str | None = None,
    catalog_state: Mapping[str, Any] | None = None,
) -> ComparisonEvidence:
    """Open a run for a finished comparison, persist its evidence, and close it.

    The convenience over ``persist_candidate_evaluations`` for the caller that has no run of its
    own — a command that just ran a comparison. It opens the run *after* the fact, which the run
    record shows honestly by carrying the comparison's own start and completion times rather than
    the moment the rows were written.

    *initiated_by* defaults to the subject the comparison's runs authenticated as. A comparison
    that recorded none must be given one: `specs/model-lab` requires a run to name its initiating
    principal, and inventing a subject would make the provenance a fiction.
    """
    principal = initiated_by or comparison.identity_subject
    if not principal:
        raise ValueError(
            "A comparison run records the principal that initiated it. This comparison carries no "
            "identity subject, so pass initiated_by explicitly."
        )
    if not comparison.candidates:
        raise ValueError(
            "A comparison run records at least one candidate; this comparison ran none."
        )

    records = LabRecords(session)
    run_id = await records.open_run(
        initiated_by=principal,
        candidate_catalog_keys=[item.catalog_key for item in comparison.candidates],
        catalog_state=dict(catalog_state)
        if catalog_state is not None
        else {
            item.catalog_key: {"gateway_model": item.gateway_model}
            for item in comparison.candidates
        },
        dataset_version=comparison.configuration.dataset_version,
        commit_sha=comparison.configuration.commit_sha,
        started_at=comparison.started_at,
    )
    evidence = await persist_candidate_evaluations(session, run_id=run_id, comparison=comparison)
    await records.close_run(run_id, status=evidence.status, completed_at=comparison.completed_at)
    return evidence
