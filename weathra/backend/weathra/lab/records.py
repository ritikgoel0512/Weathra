"""Task 32.2 — persisting a comparison, and the provenance that makes two of them comparable.

Three tables, created by `0007` and untouched here: `model_comparison_runs` for the run,
`model_comparison_results` for one model's outcome on one case, and `model_evaluations` for a
scored evaluation a result may point at.

**Provenance is the substance, not the paperwork.** A comparison that recorded only its numbers
would be unreadable a month later: two runs whose figures differ might have differed in the model,
the dataset version, the catalog, or the commit, and without all four written down there is no way
to tell which. So a run record states the initiating principal, the time, the dataset or the
question, the catalog as it stood, and the commit — once for the whole run, because they are
properties of the comparison rather than of any candidate.

**Results outlive their models.** `catalog_key` is `ON DELETE RESTRICT`, so a compared model cannot
be deleted out from under its own results, and disabling one changes nothing here. "What did this
model score before we withdrew it" stays answerable, which is the only reason to keep the record.

**Written on the administrative session.** These are operational tables the request role holds
`SELECT` on and nothing else (`0005`), so the writes come from the administrative path like every
other administrative write.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.usage import FailureClass

__all__ = [
    "RUN_STATUSES",
    "ComparisonResultRecord",
    "ComparisonRunRecord",
    "LabRecords",
]

logger = logging.getLogger("weathra.lab.records")

# The four the CHECK constraint admits. Named here so a caller cannot invent a fifth and discover
# it at the database rather than at the call site.
RUN_STATUSES: Final[tuple[str, ...]] = ("running", "completed", "partial", "failed")


class ComparisonResultRecord(BaseModel):
    """One model's outcome for one case. Every measure `specs/model-lab` names, or a null.

    Null and not zero, throughout. A candidate whose gateway reported no token counts has not been
    shown to have used none, and a comparison that filled those in with zeroes would make the
    cheapest model the one whose provider was least forthcoming.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    catalog_key: str
    gateway_model: str
    case_id: str
    policy_id: str | None = None
    latency_ms: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    estimated_cost: Decimal | None = None
    succeeded: bool
    failure_class: FailureClass | None = None
    evaluation_id: str | None = None
    usage_event_ids: tuple[str, ...] = Field(
        default=(), description="The telemetry this cell produced, so the two records agree."
    )
    agent_run_id: str | None = Field(
        default=None, description="Where the agent path ran, the run whose evidence explains it."
    )


class ComparisonRunRecord(BaseModel):
    """A whole comparison, as it is read back."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    initiated_by: str
    candidate_catalog_keys: tuple[str, ...]
    dataset_version: str | None = None
    question: str | None = None
    catalog_state: dict[str, Any] = Field(default_factory=dict)
    commit_sha: str | None = None
    status: str
    started_at: datetime
    completed_at: datetime | None = None
    results: tuple[ComparisonResultRecord, ...] = ()


class LabRecords:
    """Reads and writes the lab's three tables on whatever session it is given."""

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ---------------------------------------------------------------- writes

    async def open_run(
        self,
        *,
        initiated_by: str,
        candidate_catalog_keys: Sequence[str],
        catalog_state: Mapping[str, Any],
        dataset_version: str | None = None,
        question: str | None = None,
        commit_sha: str | None = None,
        started_at: datetime | None = None,
    ) -> str:
        """Record a run as ``running`` before any model is called, and return its identifier.

        Before, deliberately. A run recorded only on success would leave a comparison that crashed
        halfway with no trace of having happened, and "did anyone run this last week" is exactly
        the question an audit trail exists to answer.

        *started_at* exists for the one caller that legitimately cannot open the run first: a
        comparison executed out of process and persisted afterwards knows when it actually began,
        and defaulting to the insert time would misdate it by however long it took to run. Omit it
        and the row is stamped ``now()`` as before.
        """
        if dataset_version is None and question is None:
            raise ValueError(
                "A comparison run names a dataset version or an ad-hoc question; the table's "
                "CHECK refuses a row with neither, and so does this."
            )

        run_id = str(uuid.uuid4())
        await self._session.execute(
            text(
                "INSERT INTO model_comparison_runs (id, initiated_by, candidate_catalog_keys, "
                "  dataset_version, question, catalog_state, commit_sha, status, started_at) "
                "VALUES (CAST(:id AS uuid), CAST(:by AS uuid), CAST(:keys AS text[]), "
                "  :dataset, :question, CAST(:catalog AS jsonb), :commit, 'running', "
                "  coalesce(:started, now()))"
            ),
            {
                "id": run_id,
                "by": initiated_by,
                "keys": list(candidate_catalog_keys),
                "dataset": dataset_version,
                "question": question,
                "catalog": json.dumps(dict(catalog_state)),
                "commit": commit_sha,
                "started": started_at,
            },
        )
        return run_id

    async def record_result(self, run_id: str, result: ComparisonResultRecord) -> str:
        """One cell of the matrix."""
        result_id = str(uuid.uuid4())
        await self._session.execute(
            text(
                "INSERT INTO model_comparison_results (id, run_id, catalog_key, gateway_model, "
                "  case_id, policy_id, latency_ms, prompt_tokens, completion_tokens, "
                "  total_tokens, estimated_cost, succeeded, failure_class, evaluation_id, "
                "  usage_event_ids, agent_run_id, created_at) "
                "VALUES (CAST(:id AS uuid), CAST(:run AS uuid), :key, :model, :case, :policy, "
                "  :latency, :prompt, :completion, :total, CAST(:cost AS numeric), :ok, "
                "  :failure, CAST(:evaluation AS uuid), CAST(:events AS text[]), "
                "  CAST(:agent_run AS uuid), clock_timestamp())"
            ),
            {
                "id": result_id,
                "run": run_id,
                "key": result.catalog_key,
                "model": result.gateway_model,
                "case": result.case_id,
                "policy": result.policy_id,
                "latency": result.latency_ms,
                "prompt": result.prompt_tokens,
                "completion": result.completion_tokens,
                "total": result.total_tokens,
                "cost": str(result.estimated_cost) if result.estimated_cost is not None else None,
                "ok": result.succeeded,
                "failure": result.failure_class.value if result.failure_class else None,
                "evaluation": result.evaluation_id,
                "events": list(result.usage_event_ids),
                "agent_run": result.agent_run_id,
            },
        )
        return result_id

    async def close_run(
        self, run_id: str, *, status: str, completed_at: datetime | None = None
    ) -> None:
        """Mark a run finished. ``partial`` is a real outcome, not a failure.

        *completed_at* for the same reason ``open_run`` takes *started_at*: a comparison persisted
        after the fact finished when it finished, not when its rows were written.
        """
        if status not in RUN_STATUSES:
            raise ValueError(f"{status!r} is not a comparison status. Known: {RUN_STATUSES}.")
        await self._session.execute(
            text(
                "UPDATE model_comparison_runs "
                "   SET status = :status, completed_at = coalesce(:completed, now()) "
                " WHERE id = CAST(:id AS uuid)"
            ),
            {"status": status, "id": run_id, "completed": completed_at},
        )

    async def record_evaluation(
        self,
        *,
        catalog_key: str,
        gateway_model: str,
        dataset_version: str,
        metrics: Mapping[str, Any],
        criteria: Mapping[str, Any],
        passed: bool | None,
        commit_sha: str | None = None,
        evaluation_run_id: str | None = None,
    ) -> str:
        """One model's scored outcome for one run — the unit two runs are compared on.

        Kept apart from the per-case results because it answers a different question: a result
        says what happened to one case, an evaluation says what the model scored overall. A
        comparison across runs reads these; a diagnosis of one case reads those.
        """
        evaluation_id = str(uuid.uuid4())
        await self._session.execute(
            text(
                "INSERT INTO model_evaluations (id, catalog_key, gateway_model, "
                "  evaluation_run_id, dataset_version, commit_sha, metrics, criteria, passed, "
                "  recorded_at) "
                "VALUES (CAST(:id AS uuid), :key, :model, CAST(:run AS uuid), :dataset, :commit, "
                # clock_timestamp() and not now(): `now()` is *transaction* start time, so two
                # evaluations recorded in one comparison would share a timestamp and "the most
                # recent" — which is what the catalog observes and what a promotion gate reads —
                # would be whichever the planner happened to return first. The audit writer
                # learned this the same way.
                "  CAST(:metrics AS jsonb), CAST(:criteria AS jsonb), :passed, clock_timestamp())"
            ),
            {
                "id": evaluation_id,
                "key": catalog_key,
                "model": gateway_model,
                "run": evaluation_run_id,
                "dataset": dataset_version,
                "commit": commit_sha,
                "metrics": json.dumps(dict(metrics), default=str),
                "criteria": json.dumps(dict(criteria), default=str),
                "passed": passed,
            },
        )
        return evaluation_id

    # ---------------------------------------------------------------- reads

    async def run(self, run_id: str) -> ComparisonRunRecord | None:
        """One run and its results, or ``None``. Readable after a compared model is disabled."""
        row = (
            await self._session.execute(
                text(
                    "SELECT id, initiated_by, candidate_catalog_keys, dataset_version, question, "
                    "       catalog_state, commit_sha, status, started_at, completed_at "
                    "  FROM model_comparison_runs WHERE id = CAST(:id AS uuid)"
                ),
                {"id": run_id},
            )
        ).first()
        if row is None:
            return None

        cells = await self._session.execute(
            text(
                "SELECT catalog_key, gateway_model, case_id, policy_id, latency_ms, "
                "       prompt_tokens, completion_tokens, total_tokens, estimated_cost, "
                "       succeeded, failure_class, evaluation_id, usage_event_ids, agent_run_id "
                "  FROM model_comparison_results WHERE run_id = CAST(:id AS uuid) "
                " ORDER BY catalog_key, case_id"
            ),
            {"id": run_id},
        )
        return ComparisonRunRecord(
            id=str(row[0]),
            initiated_by=str(row[1]),
            candidate_catalog_keys=tuple(row[2] or ()),
            dataset_version=row[3],
            question=row[4],
            catalog_state=row[5] or {},
            commit_sha=row[6],
            status=row[7],
            started_at=row[8],
            completed_at=row[9],
            results=tuple(
                ComparisonResultRecord(
                    catalog_key=cell[0],
                    gateway_model=cell[1],
                    case_id=cell[2],
                    policy_id=cell[3],
                    latency_ms=cell[4],
                    prompt_tokens=cell[5],
                    completion_tokens=cell[6],
                    total_tokens=cell[7],
                    estimated_cost=cell[8],
                    succeeded=cell[9],
                    failure_class=FailureClass(cell[10]) if cell[10] else None,
                    evaluation_id=str(cell[11]) if cell[11] else None,
                    usage_event_ids=tuple(cell[12] or ()),
                    agent_run_id=str(cell[13]) if cell[13] else None,
                )
                for cell in cells
            ),
        )

    async def runs(self, *, limit: int = 50) -> tuple[ComparisonRunRecord, ...]:
        """Recent runs without their results, newest first. The listing an administrator reads."""
        rows = await self._session.execute(
            text(
                "SELECT id, initiated_by, candidate_catalog_keys, dataset_version, question, "
                "       catalog_state, commit_sha, status, started_at, completed_at "
                "  FROM model_comparison_runs ORDER BY started_at DESC LIMIT :limit"
            ),
            {"limit": limit},
        )
        return tuple(
            ComparisonRunRecord(
                id=str(row[0]),
                initiated_by=str(row[1]),
                candidate_catalog_keys=tuple(row[2] or ()),
                dataset_version=row[3],
                question=row[4],
                catalog_state=row[5] or {},
                commit_sha=row[6],
                status=row[7],
                started_at=row[8],
                completed_at=row[9],
            )
            for row in rows
        )

    async def latest_evaluations(
        self, catalog_keys: Sequence[str] | None = None
    ) -> dict[str, dict[str, Any]]:
        """The most recent scored outcome per model. What makes the catalog *observable*.

        `specs/model-catalog` asks an administrative catalog listing to carry "the outcome of the
        most recent health or evaluation observation for that model, where recorded". This is that
        outcome, keyed by catalog entry, and absent for a model nobody has evaluated — which is
        different from a model that scored nothing and is reported differently.
        """
        rows = await self._session.execute(
            text(
                "SELECT DISTINCT ON (catalog_key) catalog_key, gateway_model, dataset_version, "
                "       passed, recorded_at, criteria "
                "  FROM model_evaluations "
                " WHERE (CAST(:keys AS text[]) IS NULL OR catalog_key = ANY(CAST(:keys AS text[])))"
                " ORDER BY catalog_key, recorded_at DESC"
            ),
            {"keys": list(catalog_keys) if catalog_keys is not None else None},
        )
        return {
            str(row[0]): {
                "gateway_model": row[1],
                "dataset_version": row[2],
                "passed": row[3],
                "recorded_at": row[4].isoformat() if row[4] else None,
                "criteria": row[5] or {},
            }
            for row in rows
        }

    async def compare_evaluations(self, first: str, second: str) -> dict[str, Any]:
        """Two evaluation records, measure by measure, with a differing dataset version flagged.

        `specs/evaluation` requires the flag rather than a refusal: two runs on different dataset
        versions are still worth looking at, and quietly comparing them as though they were not is
        the failure. So the difference is reported *and* labelled.
        """
        rows = await self._session.execute(
            text(
                "SELECT id, catalog_key, gateway_model, dataset_version, metrics, criteria, "
                "       passed, recorded_at "
                "  FROM model_evaluations WHERE id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": [first, second]},
        )
        found = {str(row[0]): row for row in rows}
        missing = [identifier for identifier in (first, second) if identifier not in found]
        if missing:
            raise ValueError(f"No evaluation record for {missing}.")

        left, right = found[first], found[second]
        measures = sorted(set(left[4] or {}) | set(right[4] or {}))
        return {
            "dataset_version_differs": left[3] != right[3],
            "dataset_versions": {first: left[3], second: right[3]},
            "models": {first: left[1], second: right[1]},
            "metrics": {
                measure: {
                    first: (left[4] or {}).get(measure),
                    second: (right[4] or {}).get(measure),
                    "difference": _numeric_difference(
                        (left[4] or {}).get(measure), (right[4] or {}).get(measure)
                    ),
                }
                for measure in measures
            },
            "criteria": {first: left[5] or {}, second: right[5] or {}},
            "passed": {first: left[6], second: right[6]},
            "recorded_at": {
                first: left[7].isoformat() if left[7] else None,
                second: right[7].isoformat() if right[7] else None,
            },
        }


def _numeric_difference(left: Any, right: Any) -> float | None:
    """Null where either side is absent or not a number. Never a fabricated zero."""
    if not isinstance(left, int | float) or not isinstance(right, int | float):
        return None
    if isinstance(left, bool) or isinstance(right, bool):
        return None
    return float(right) - float(left)
