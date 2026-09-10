"""Task 32.6 to 32.8 — one comparison, several candidates, everything else held still.

`specs/evaluation` is precise about what a candidate comparison is and is not. It is the *existing*
dataset, runner and metric definitions applied once per candidate. It is not a separate procedure
with its own scoring, because a second scoring path is a second set of numbers that will eventually
disagree with the first, and the disagreement will surface as a promotion decision nobody can
defend.

So this module is deliberately thin. It selects the cases **once**, snapshots the configuration
**once**, and calls `execute_run` per candidate with the model as the only thing that differs. What
it adds is the three things a comparison needs and a single run does not:

* **the pinned configuration, stated once** — dataset version, weather fixtures, corpus, embedding
  model, analytics and commit belong to the comparison rather than to each candidate, and a record
  that repeated them per candidate could not prove they were the same;
* **isolation of failure** — a candidate that raises or times out is recorded as that candidate's
  outcome and the comparison continues, because the point of comparing four models is not lost
  when one of them is broken;
* **the five criteria** — `evaluation/criteria.py` computes them from what each run recorded, and
  the comparison reports them side by side.

**Nothing here chooses a model.** It produces evidence; promotion is a separate authorized write
(`specs/model-lab`). The two are kept apart on purpose: a comparison that could promote would make
"the lab changed production" a thing that can happen by accident.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.errors import ValidationFailed
from weathra.entitlements.records import CatalogEntry
from weathra.evaluation.cases import DATASET_VERSION, EvaluationCase
from weathra.evaluation.criteria import SelectionCriteria, compute_criteria
from weathra.evaluation.metrics import CaseOutcome
from weathra.evaluation.provisioning import EvaluationMode
from weathra.evaluation.runner import RunResult, execute_run, select_cases
from weathra.lab.compare import LabRunner, resolve_candidates
from weathra.lab.evidence import ComparisonEvidence, record_comparison

__all__ = [
    "CandidateCase",
    "CandidateOutcome",
    "ModelComparison",
    "PinnedConfiguration",
    "compare_candidates",
    # Re-exported: candidate resolution belongs to `lab/` because the administrative router needs
    # it and may not reach this package, and a caller here should not have to know that.
    "resolve_candidates",
]

logger = logging.getLogger("weathra.evaluation.model_compare")


class PinnedConfiguration(BaseModel):
    """Everything a comparison holds fixed, stated once for the whole run.

    Once, and not per candidate, because that is the claim: two candidates scored against
    different fixtures are not comparable, and a record that repeated the fields per candidate
    could describe that state without contradicting itself.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset_version: str
    mode: EvaluationMode
    weather_provider: str
    embedding_model: str
    commit_sha: str | None = None
    category_filter: str | None = None
    case_filter: str | None = None
    case_ids: tuple[str, ...] = Field(
        default=(), description="The exact cases every candidate ran, in order."
    )


class CandidateCase(BaseModel):
    """What one candidate did on one case, as the comparison measured it.

    Carried so a persisted comparison can name a real per-case measurement instead of a null. The
    fields are only the ones the runner actually recorded per case: no token counts, because the
    evaluation runner does not attribute them per case, and a zero there would make the least
    forthcoming provider look like the cheapest one.

    The failure is a *classification*, never the recorded error text — that string can carry a
    provider's payload, and a comparison record is read by people and archived by CI.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    case_id: str
    succeeded: bool
    latency_ms: float | None = None


class CandidateOutcome(BaseModel):
    """One candidate's whole showing: its run, its criteria, or the failure that stopped it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str
    gateway_model: str
    completed: bool
    criteria: SelectionCriteria | None = None
    cases: tuple[CandidateCase, ...] = Field(
        default=(), description="Per case, what this candidate did. Empty where it never ran one."
    )
    metrics: dict[str, float | None] = Field(default_factory=dict)
    cases_scored: int = Field(default=0, ge=0)
    passed: bool | None = None
    failure: str | None = Field(
        default=None,
        description="The failure classification, where the candidate did not complete. Never a "
        "provider's message, which may carry a payload.",
    )


class ModelComparison(BaseModel):
    """A whole comparison: what was held fixed, and what each candidate did with it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    configuration: PinnedConfiguration
    candidates: tuple[CandidateOutcome, ...]
    started_at: datetime
    completed_at: datetime
    identity_subject: str | None = Field(
        default=None,
        description="The subject every candidate's run authenticated as — the derived evaluation "
        "user. Recorded because `specs/model-lab` asks a run to name its initiating principal, "
        "and a comparison run persisted without one could not say who executed it.",
    )
    budget_exhausted: bool = Field(
        default=False,
        description="Whether the wall-clock budget stopped the comparison before every candidate "
        "ran. The result is partial and names what completed.",
    )

    @property
    def is_partial(self) -> bool:
        return self.budget_exhausted or any(not item.completed for item in self.candidates)

    def completed_keys(self) -> tuple[str, ...]:
        return tuple(item.catalog_key for item in self.candidates if item.completed)

    def differences(self, first: str, second: str) -> dict[str, dict[str, float | None]]:
        """Each recorded measure's difference between two candidates.

        `specs/model-lab` asks for the difference per measure rather than a verdict, and the
        distinction is the point: a difference is a measured fact, and which of two models is
        better is a judgement somebody has to make and record.
        """
        left = self._candidate(first)
        right = self._candidate(second)
        measures = sorted(set(left.metrics) | set(right.metrics))
        return {
            measure: {
                first: left.metrics.get(measure),
                second: right.metrics.get(measure),
                "difference": _difference(left.metrics.get(measure), right.metrics.get(measure)),
            }
            for measure in measures
        }

    def _candidate(self, catalog_key: str) -> CandidateOutcome:
        for item in self.candidates:
            if item.catalog_key == catalog_key:
                return item
        raise KeyError(f"{catalog_key!r} was not a candidate in this comparison.")


def _difference(left: float | None, right: float | None) -> float | None:
    """Null where either side is unmeasured. Subtracting from an absence invents a number."""
    if left is None or right is None:
        return None
    return right - left


# =========================================================================== the comparison


async def compare_candidates(
    settings: Settings,
    candidates: Sequence[CatalogEntry],
    *,
    mode: EvaluationMode = EvaluationMode.OFFLINE,
    category: str | None = None,
    case_id: str | None = None,
    cases: Sequence[EvaluationCase] | None = None,
    time_budget_seconds: float | None = None,
) -> ModelComparison:
    """Run every candidate over the same cases and score each with the existing metrics.

    The bounds are enforced by the caller that has the settings to enforce them with
    (`lab/compare.py`); what this enforces is the wall clock, because only the loop knows how much
    of it is left. A budget reached mid-comparison stops before the next candidate and returns a
    partial result naming what completed — never a truncated candidate scored as though it had
    finished, which would be a fabricated measurement.
    """
    selected = (
        tuple(cases) if cases is not None else select_cases(category=category, case_id=case_id)
    )
    if not selected:
        raise ValidationFailed(
            "The selection matched no evaluation case.", details={"field": "cases"}
        )

    started = datetime.now(UTC)
    deadline = (time.monotonic() + time_budget_seconds) if time_budget_seconds else None
    outcomes: list[CandidateOutcome] = []
    exhausted = False
    pinned: PinnedConfiguration | None = None
    subject: str | None = None

    for entry in candidates:
        if deadline is not None and time.monotonic() >= deadline:
            exhausted = True
            logger.info("comparison budget reached; %d candidate(s) ran", len(outcomes))
            break

        outcome, configuration, identity = await _run_candidate(
            settings,
            entry,
            mode=mode,
            category=category,
            case_id=case_id,
            cases=selected,
        )
        outcomes.append(outcome)
        pinned = pinned or configuration
        subject = subject or identity

    return ModelComparison(
        configuration=pinned
        or PinnedConfiguration(
            dataset_version=DATASET_VERSION,
            mode=mode,
            weather_provider=settings.default_weather_provider,
            embedding_model=settings.embedding_model_id,
            category_filter=category,
            case_filter=case_id,
            case_ids=tuple(case.case_id for case in selected),
        ),
        candidates=tuple(outcomes),
        started_at=started,
        completed_at=datetime.now(UTC),
        budget_exhausted=exhausted,
        identity_subject=subject,
    )


async def _run_candidate(
    settings: Settings,
    entry: CatalogEntry,
    *,
    mode: EvaluationMode,
    category: str | None,
    case_id: str | None,
    cases: Sequence[EvaluationCase],
) -> tuple[CandidateOutcome, PinnedConfiguration | None, str | None]:
    """One candidate's run, with its failure caught rather than propagated.

    `specs/evaluation`: a model that fails or times out does not abort the comparison. Caught
    broadly on purpose — the failure of one candidate is data about that candidate, and letting it
    end the comparison would throw away the three results that did complete.

    Only the exception *type* is recorded. A provider's message can carry a payload, and a
    comparison record is read by people and archived by CI.
    """
    try:
        result = await execute_run(
            settings,
            mode=mode,
            category=category,
            case_id=case_id,
            # Both halves of the same pin: the catalog key is what a live run resolves through
            # (validated against the catalog, no plan read), and the gateway identifier is what an
            # offline run records so a candidate's results are attributed to that candidate.
            pinned_catalog_key=entry.catalog_key,
            pinned_model=entry.gateway_model,
            cases=cases,
        )
    except asyncio.CancelledError:  # pragma: no cover - a cancelled comparison is not a candidate
        raise
    except Exception as failure:
        logger.warning(
            "candidate %s did not complete: %s", entry.catalog_key, type(failure).__name__
        )
        return (
            CandidateOutcome(
                catalog_key=entry.catalog_key,
                gateway_model=entry.gateway_model,
                completed=False,
                failure=type(failure).__name__,
            ),
            None,
            None,
        )

    outcomes = _outcomes_of(result)
    return (
        CandidateOutcome(
            catalog_key=entry.catalog_key,
            gateway_model=entry.gateway_model,
            completed=True,
            cases=tuple(
                CandidateCase(
                    case_id=outcome.case_id,
                    # The runner records a case's failure in ``error``; a case that carries one
                    # did not succeed. Only the fact is copied, never the text.
                    succeeded=outcome.error is None,
                    latency_ms=outcome.latency_ms,
                )
                for outcome in outcomes
            ),
            criteria=compute_criteria(
                catalog_key=entry.catalog_key,
                gateway_model=result.configuration.llm_model or entry.gateway_model,
                outcomes=outcomes,
                cases=cases,
                metrics=result.metrics,
                input_price_per_million=Decimal(str(entry.input_price_per_million)),
                output_price_per_million=Decimal(str(entry.output_price_per_million)),
                currency=entry.price_currency,
            ),
            metrics={name: result.metrics.results[name].value for name in result.metrics.results},
            cases_scored=result.metrics.cases_scored,
            passed=result.thresholds.passed,
        ),
        PinnedConfiguration(
            dataset_version=result.configuration.dataset_version,
            mode=result.configuration.mode,
            weather_provider=result.configuration.weather_provider,
            embedding_model=result.configuration.embedding_model,
            commit_sha=result.configuration.commit_sha,
            category_filter=category,
            case_filter=case_id,
            case_ids=tuple(case.case_id for case in cases),
        ),
        # The subject only, exactly as `evaluation/storage.py` records it: ``TestIdentity``
        # keeps the token out of serialization, so there is nothing here that could authenticate.
        str(result.configuration.test_user.get("user_id") or "") or None,
    )


def _outcomes_of(result: RunResult) -> tuple[CaseOutcome, ...]:
    """Rebuild the scoring records from what the run recorded.

    The runner keeps `CaseRecord`s, which are the archived shape; the criteria are computed from
    `CaseOutcome`s, which are the scoring shape. Rebuilding rather than re-executing is what makes
    a stored comparison re-scorable — the same property `specs/evaluation` asks of a stored run.
    """
    return tuple(
        CaseOutcome(
            case_id=record.case_id,
            category=record.category,
            answer=record.answer,
            latency_ms=record.latency_ms,
            http_status=record.http_status,
            error=record.error,
            inference_attempts=record.inference_attempts,
            tools_called=tuple(
                call.get("tool", "")
                for call in record.evidence.get("tool_calls", [])
                if isinstance(call, dict)
            ),
        )
        for record in result.cases
    )


# =========================================================================== the command


def main(argv: list[str] | None = None) -> int:
    """``weathra-compare``. Run one comparison and, with ``--persist``, record its evidence.

    A command rather than a route, and not by preference: `api/` may not reach this package,
    because the evaluation runner builds an application and a request must not. So the shipped path
    that runs a comparison is this, alongside ``weathra-evaluate`` which runs a single model.

    The bounds are not re-implemented here. ``LabRunner.plan`` is the one place that reads
    ``MODEL_LAB_MAX_MODELS``, ``MODEL_LAB_MAX_CASES`` and the selection rule, so it is asked before
    anything runs — and because it requires a dataset selection, a bare invocation cannot silently
    become a full forty-case comparison across four models.

    Exit codes follow ``weathra-evaluate``: 0 when every candidate completed, 1 when some did, 2 on
    a misconfiguration or a refused selection, and 3 when no candidate completed at all.
    """
    parser = argparse.ArgumentParser(
        prog="weathra-compare",
        description=(
            "Run Weathra's evaluation dataset across several catalog candidates, holding "
            "everything but the model fixed, and report the five selection criteria for each. "
            "Offline by default, which measures the harness rather than the models; --mode live "
            "measures the models. --persist records the evidence a promotion may cite."
        ),
    )
    parser.add_argument(
        "--candidates",
        required=True,
        help="Comma-separated catalog keys, which must be enabled in the catalog.",
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--category", help="Compare over one category of the dataset.")
    selection.add_argument("--case", dest="case_id", help="Compare over one case, by identifier.")
    parser.add_argument(
        "--mode",
        choices=[entry.value for entry in EvaluationMode],
        default=EvaluationMode.OFFLINE.value,
        help="'offline' uses the scripted model; 'live' uses the real ones over the gateway.",
    )
    parser.add_argument(
        "--persist",
        action="store_true",
        help=(
            "Record the comparison run and each candidate's five criteria. Live runs only: "
            "offline numbers describe the stand-in, and the promotion gate reads these rows."
        ),
    )
    parser.add_argument(
        "--json", dest="as_json", action="store_true", help="Emit the comparison as JSON."
    )
    parser.add_argument("--output", type=Path, help="Write the comparison as JSON to this path.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = Settings()
    mode = EvaluationMode(args.mode)
    keys = [key.strip() for key in args.candidates.split(",") if key.strip()]
    if not keys:
        print("--candidates named no catalog key.", file=sys.stderr)
        return 2
    if mode is EvaluationMode.LIVE and not settings.inference_configured:
        print(
            "A live comparison needs an inference credential. Set OPENROUTER_API_KEY, or run "
            "with --mode offline, which exercises the plumbing without one.",
            file=sys.stderr,
        )
        return 2
    if args.persist and mode is not EvaluationMode.LIVE:
        print(
            f"--persist records evidence a promotion may cite, and a {mode.value} comparison "
            "measures the harness rather than the candidates. Re-run with --mode live to record.",
            file=sys.stderr,
        )
        return 2

    try:
        comparison, evidence = asyncio.run(
            _run_command(
                settings,
                keys=keys,
                mode=mode,
                category=args.category,
                case_id=args.case_id,
                persist=args.persist,
            )
        )
    except (ValidationFailed, ValueError) as refused:
        print(str(refused), file=sys.stderr)
        return 2

    payload = comparison.model_dump(mode="json")
    if evidence is not None:
        payload["evidence"] = evidence.model_dump(mode="json")
    if args.output:
        args.output.write_text(json.dumps(payload, indent=2, sort_keys=True))
    print(json.dumps(payload, indent=2, sort_keys=True) if args.as_json else _report(comparison))

    if evidence is not None:
        print(
            f"\nRecorded comparison run {evidence.run_id} "
            f"({evidence.status}); evidence for {', '.join(evidence.evidenced_keys) or 'nothing'}.",
            file=sys.stderr,
        )
        for key, reason in sorted(evidence.unevidenced.items()):
            print(f"  no evidence for {key}: {reason}", file=sys.stderr)

    completed = len(comparison.completed_keys())
    if completed == 0:
        print("\nNo candidate completed, so the comparison produced no evidence.", file=sys.stderr)
        return 3
    return 0 if completed == len(comparison.candidates) and not comparison.budget_exhausted else 1


async def _run_command(
    settings: Settings,
    *,
    keys: Sequence[str],
    mode: EvaluationMode,
    category: str | None,
    case_id: str | None,
    persist: bool,
) -> tuple[ModelComparison, ComparisonEvidence | None]:
    """Resolve the candidates against the catalog, check the bounds, run, and record.

    The catalog is read on the privileged connection because these are operational tables, the
    same reason `evaluation/storage.py` gives for the run tables. Nothing here serves a request.
    """
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            candidates = await resolve_candidates(session, catalog_keys=keys)
            # The canonical bounds, asked before a single model is called.
            LabRunner(settings).plan(candidates=candidates, category=category, case_id=case_id)

        comparison = await compare_candidates(
            settings,
            candidates,
            mode=mode,
            category=category,
            case_id=case_id,
            time_budget_seconds=settings.model_lab_time_budget_seconds,
        )

        if not persist:
            return comparison, None
        async with privileged_session(engines.privileged_sessionmaker) as session:
            return comparison, await record_comparison(session, comparison)
    finally:
        await engines.dispose()


def _report(comparison: ModelComparison) -> str:
    """One line per candidate: what it scored, or why it has no score."""
    configuration = comparison.configuration
    lines = [
        f"Comparison over dataset {configuration.dataset_version} "
        f"({configuration.mode.value}), {len(configuration.case_ids)} case(s), "
        f"{len(comparison.candidates)} candidate(s)",
    ]
    for candidate in comparison.candidates:
        if not candidate.completed:
            lines.append(f"  {candidate.catalog_key}: did not complete ({candidate.failure})")
            continue
        criteria = candidate.criteria
        blockers = criteria.promotion_blockers() if criteria is not None else ()
        lines.append(
            f"  {candidate.catalog_key}: {candidate.cases_scored} case(s) scored, "
            f"gates {'failed: ' + ', '.join(blockers) if blockers else 'passed'}"
        )
    if comparison.budget_exhausted:
        lines.append("  the wall-clock budget stopped the comparison; the result is partial")
    return "\n".join(lines)


if __name__ == "__main__":  # pragma: no cover - exercised through the console script
    raise SystemExit(main())
