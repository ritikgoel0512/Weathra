"""Storing runs, and comparing two of them.

``specs/evaluation`` requires reproducibility and cross-run comparison, and the comparison is the
part that earns its keep: a single run tells you whether Weathra passes today, and two runs tell
you whether a change made it better or worse.

**A dataset-version difference is flagged, not smoothed over.** This is the one thing a comparison
must not do quietly. If run A scored 92% on tool selection over 40 cases and run B scored 96% over
44, the difference may be four percentage points of improvement or it may be four new easy cases —
and reporting "up 4 points" without saying the dataset changed would be a misleading number
presented as a measurement.

**Runs are operational data, owned by nobody.** The ``evaluation_runs`` tables are classified
``operational`` (design.md decision 10): they belong to the deployment rather than to a person, they
carry no user-owned data beyond the test user's own subject, and they are written through the
privileged connection because a request-serving session has no business writing them.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.models import EvaluationCaseResult, EvaluationRun
from weathra.db.session import privileged_session
from weathra.evaluation.metrics import METRIC_NAMES, MetricName
from weathra.evaluation.runner import RunResult

__all__ = ["RunComparison", "compare_runs", "latest_runs", "persist"]

logger = logging.getLogger("weathra.evaluation.storage")


class MetricChange(BaseModel):
    """One metric's movement between two runs."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    metric: str
    earlier: float | None = None
    later: float | None = None
    change_points: float | None = Field(
        default=None, description="Later minus earlier, in percentage points."
    )
    lower_is_better: bool = False

    @property
    def direction(self) -> str:
        """Better, worse, or unchanged — accounting for which way the metric runs."""
        if self.change_points is None or abs(self.change_points) < 0.05:
            return "unchanged"
        improved = self.change_points < 0 if self.lower_is_better else self.change_points > 0
        return "better" if improved else "worse"

    def describe(self) -> str:
        if self.earlier is None or self.later is None:
            return f"{self.metric}: not comparable (one run did not measure it)"
        return (
            f"{self.metric}: {self.earlier * 100:.1f}% → {self.later * 100:.1f}% "
            f"({self.change_points:+.1f} points, {self.direction})"
        )


class RunComparison(BaseModel):
    """Two runs, side by side, with the caveats that make the numbers readable."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    earlier_run_id: str
    later_run_id: str
    changes: tuple[MetricChange, ...]
    dataset_versions_differ: bool = Field(
        description=(
            "True when the two runs used different dataset versions. Every change below is then "
            "a change in *both* the code and the questions, and cannot be attributed to either."
        )
    )
    earlier_dataset_version: str
    later_dataset_version: str
    modes_differ: bool = False
    earlier_mode: str = ""
    later_mode: str = ""
    earlier_passed: bool | None = None
    later_passed: bool | None = None

    @property
    def comparable(self) -> bool:
        """Whether the two runs measured the same thing under the same conditions."""
        return not self.dataset_versions_differ and not self.modes_differ

    def summary(self) -> str:
        lines: list[str] = []

        if self.dataset_versions_differ:
            lines.append(
                f"⚠ These runs used different dataset versions "
                f"({self.earlier_dataset_version} → {self.later_dataset_version}). The changes "
                "below reflect a change in the questions as well as in Weathra, and cannot be "
                "attributed to either."
            )
        if self.modes_differ:
            lines.append(
                f"⚠ These runs used different modes ({self.earlier_mode} → {self.later_mode}). "
                "An offline run and a live run measure different things — offline scripts the "
                "routing, so tool selection is not comparable across them."
            )

        lines.append(f"overall: {_verdict(self.earlier_passed)} → {_verdict(self.later_passed)}")
        lines.extend(f"  {change.describe()}" for change in self.changes)
        return "\n".join(lines)


def _verdict(passed: bool | None) -> str:
    if passed is None:
        return "not scored"
    return "PASS" if passed else "FAIL"


async def persist(settings: Settings, result: RunResult) -> str:
    """Store a run and its case results, and return the run's identifier.

    Under the privileged connection: these tables are operational, and a request-serving session
    has no grant to write them.
    """
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            run = EvaluationRun(
                dataset_version=result.configuration.dataset_version,
                mode=result.configuration.mode.value,
                llm_provider=result.configuration.llm_provider,
                llm_model=result.configuration.llm_model,
                weather_provider=result.configuration.weather_provider,
                embedding_model=result.configuration.embedding_model,
                commit_sha=result.configuration.commit_sha,
                # The subject only. ``TestIdentity`` excludes the token from serialization, so
                # there is nothing here that could authenticate as the test user.
                test_user_id=str(result.configuration.test_user.get("user_id") or "") or None,
                category_filter=result.configuration.category_filter,
                case_filter=result.configuration.case_filter,
                metrics=result.metrics.model_dump(mode="json"),
                # The integrity report rides inside the threshold report's own JSONB column: it is
                # the verdict object, and the caveat belongs with the verdict rather than beside
                # it. No schema change — ``thresholds`` has always been JSONB.
                thresholds=result.thresholds.model_dump(mode="json"),
                # Null on a provider failure. ``passed`` was already nullable and ``_verdict``
                # already renders null as "not scored"; the honest third answer needed no
                # migration, only somebody to stop collapsing it into "failed".
                passed=result.passed,
                started_at=result.started_at,
                completed_at=result.completed_at,
            )
            session.add(run)
            await session.flush()

            for record in result.cases:
                session.add(
                    EvaluationCaseResult(
                        run_id=run.id,
                        case_id=record.case_id,
                        category=record.category.value,
                        passed=record.passed,
                        answer=record.answer or None,
                        # Retained whether the case passed or failed: a failure is diagnosable
                        # from this without re-running it (``specs/evaluation``).
                        evidence=record.evidence,
                        per_metric={
                            **record.per_metric,
                            # Denormalized out of ``evidence`` so "which cases did the model
                            # actually answer" is one query rather than a JSON walk per row.
                            "inference": {
                                "model_served": record.model_served,
                                "statuses": [
                                    attempt.status.value for attempt in record.inference_attempts
                                ],
                            },
                        },
                        latency_ms=record.latency_ms,
                        http_status=record.http_status,
                    )
                )
            await session.flush()
            run_id = run.id
    finally:
        await engines.dispose()

    logger.info(
        "stored evaluation run %s (%s)",
        run_id,
        "not scored" if result.passed is None else ("pass" if result.passed else "fail"),
    )
    return run_id


async def latest_runs(settings: Settings, *, limit: int = 10) -> list[dict[str, object]]:
    """The most recent runs, newest first, for a comparison or a report."""
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            rows = (
                await session.execute(
                    select(EvaluationRun).order_by(EvaluationRun.started_at.desc()).limit(limit)
                )
            ).scalars()
            return [
                {
                    "id": row.id,
                    "dataset_version": row.dataset_version,
                    "mode": row.mode,
                    "llm_model": row.llm_model,
                    "passed": row.passed,
                    "verdict": _verdict(row.passed),
                    "started_at": row.started_at.isoformat(),
                }
                for row in rows
            ]
    finally:
        await engines.dispose()


async def compare_runs(settings: Settings, earlier_id: str, later_id: str) -> RunComparison:
    """Two stored runs, compared per metric, with a dataset difference flagged."""
    engines = Engines.create(settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            earlier = await session.get(EvaluationRun, earlier_id)
            later = await session.get(EvaluationRun, later_id)
    finally:
        await engines.dispose()

    if earlier is None or later is None:
        missing = [
            identifier
            for identifier, row in ((earlier_id, earlier), (later_id, later))
            if row is None
        ]
        raise ValueError(f"No stored evaluation run with identifier(s): {', '.join(missing)}.")

    changes: list[MetricChange] = []
    for name in METRIC_NAMES:
        before = _rate(earlier.metrics, name)
        after = _rate(later.metrics, name)
        changes.append(
            MetricChange(
                metric=name.value,
                earlier=before,
                later=after,
                change_points=(
                    None if before is None or after is None else (after - before) * 100.0
                ),
                lower_is_better=_lower_is_better(later.metrics, name),
            )
        )

    return RunComparison(
        earlier_run_id=earlier.id,
        later_run_id=later.id,
        changes=tuple(changes),
        dataset_versions_differ=earlier.dataset_version != later.dataset_version,
        earlier_dataset_version=earlier.dataset_version,
        later_dataset_version=later.dataset_version,
        modes_differ=earlier.mode != later.mode,
        earlier_mode=earlier.mode,
        later_mode=later.mode,
        earlier_passed=earlier.passed,
        later_passed=later.passed,
    )


def _rate(metrics: dict[str, object], name: MetricName) -> float | None:
    """One metric's rate out of a stored report, recomputed from its own numerator and denominator.

    Recomputed rather than read: the stored report keeps the basis, and a rate derived from it
    cannot disagree with the counts a reader sees next to it.
    """
    results = metrics.get("results") if isinstance(metrics, dict) else None
    if not isinstance(results, dict):
        return None
    entry = results.get(name.value)
    if not isinstance(entry, dict):
        return None

    denominator = entry.get("denominator")
    numerator = entry.get("numerator")
    if not isinstance(denominator, int) or not isinstance(numerator, int) or denominator == 0:
        return None
    return numerator / denominator


def _lower_is_better(metrics: dict[str, object], name: MetricName) -> bool:
    results = metrics.get("results") if isinstance(metrics, dict) else None
    if not isinstance(results, dict):
        return False
    entry = results.get(name.value)
    return bool(entry.get("lower_is_better")) if isinstance(entry, dict) else False
