"""The evaluation runner: execute the dataset, score it, and record what happened.

``weathra-evaluate``. Invocable from a command line and from CI, with a category filter and a
single-case filter so a subset can be re-run.

**Every case goes through the HTTP API as the authenticated test user.** Not through the graph
directly: the metrics include a backend successful-response rate and a source-attribution coverage
over *response fields*, and both of those are claims about the API. A runner that called the graph
would be measuring something a caller never sees.

**Offline mode is the default, and it is a real run.** The weather comes from the same stub the
test suite uses, the inference from the scripted fake, and the tokens from a locally-minted key
pair. Every deterministic metric — tool selection, numerical accuracy, groundedness, attribution,
retrieval quality, memory correctness, response rate — is computed exactly as in a live run.
``specs/evaluation`` requires that, and the reason is that a suite which needs a credential to run
at all is a suite nobody runs.

**The reference value is computed from the run's own evidence.** A numeric case declares a
statistic and a measure; the runner reads the series the run actually retrieved out of the evidence
record and computes the reference over *that*. Not over a fixture read separately — over the same
numbers the answer came from, which is what makes a mismatch mean the arithmetic was wrong rather
than that two fixtures differ.

**A failing case keeps its evidence.** The run record stores the answer and the full evidence for
every case, which is what makes a failure diagnosable without re-running it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.evaluation.cases import (
    DATASET_VERSION,
    Category,
    EvaluationCase,
    ReferenceComputation,
    load_dataset,
)
from weathra.evaluation.harness import build_evaluation_app
from weathra.evaluation.metrics import CaseOutcome, MetricsReport, compute_metrics, figures_in
from weathra.evaluation.provisioning import EvaluationMode, TestIdentity
from weathra.evaluation.thresholds import ThresholdReport, evaluate_thresholds

__all__ = ["RunConfiguration", "RunResult", "execute_run", "main"]

logger = logging.getLogger("weathra.evaluation.runner")


class RunConfiguration(BaseModel):
    """Everything about how a run was executed, recorded so it can be reproduced.

    ``specs/evaluation`` requires the *full* configuration, and the reason is that a metric change
    between two runs is meaningless without knowing whether the dataset, the model, the provider,
    or the embedding model changed underneath it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset_version: str
    mode: EvaluationMode
    llm_provider: str | None = None
    llm_model: str | None = None
    weather_provider: str
    embedding_model: str
    commit_sha: str | None = None
    category_filter: str | None = None
    case_filter: str | None = None
    test_user: dict[str, str | bool] = Field(
        default_factory=dict, description="The identity, never its credential."
    )
    cases_selected: int = Field(default=0, ge=0)


class CaseRecord(BaseModel):
    """One case's execution, kept whether it passed or failed."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    case_id: str
    category: Category
    passed: bool
    answer: str = ""
    evidence: dict[str, Any] = Field(
        default_factory=dict, description="The full record, so a failure is diagnosable."
    )
    per_metric: dict[str, Any] = Field(default_factory=dict)
    latency_ms: float | None = None
    http_status: int | None = None
    error: str | None = None


class RunResult(BaseModel):
    """A whole run: its configuration, its cases, its metrics, and its verdict."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    configuration: RunConfiguration
    cases: tuple[CaseRecord, ...]
    metrics: MetricsReport
    thresholds: ThresholdReport
    started_at: datetime
    completed_at: datetime

    @property
    def passed(self) -> bool:
        return self.thresholds.passed

    @property
    def duration_seconds(self) -> float:
        return (self.completed_at - self.started_at).total_seconds()

    def report(self) -> str:
        """The human-readable report, for a terminal and for CI's log."""
        lines = [
            "Weathra evaluation",
            "=" * 60,
            f"dataset       {self.configuration.dataset_version}",
            f"mode          {self.configuration.mode.value}",
            f"provider      {self.configuration.weather_provider}",
            f"model         {self.configuration.llm_provider or '-'}/"
            f"{self.configuration.llm_model or '-'}",
            f"embedder      {self.configuration.embedding_model}",
            f"commit        {self.configuration.commit_sha or '-'}",
            f"cases         {len(self.cases)} of {self.configuration.cases_selected} selected",
            f"duration      {self.duration_seconds:.1f}s",
            "",
            "Metrics",
            "-" * 60,
            *(f"  {line}" for line in self.metrics.describe()),
            "",
            "Latency",
            "-" * 60,
            f"  overall: median {self.metrics.latency.overall_median_ms or 0:.0f}ms, "
            f"p95 {self.metrics.latency.overall_p95_ms or 0:.0f}ms "
            f"({self.metrics.latency.samples} samples)",
            *(
                f"  {category}: median {values['median_ms']:.0f}ms, p95 {values['p95_ms']:.0f}ms"
                for category, values in sorted(self.metrics.latency.by_category.items())
            ),
            "",
            "Thresholds",
            "-" * 60,
            *(f"  {line}" for line in self.thresholds.describe()),
            "",
            self.thresholds.summary(),
        ]

        failing = [record for record in self.cases if not record.passed]
        if failing:
            lines.extend(["", "Failing cases", "-" * 60])
            lines.extend(
                f"  {record.case_id} ({record.category.value}): "
                f"{record.error or 'expectations not met'}"
                for record in failing
            )
        return "\n".join(lines)


# =========================================================================== reference values


def _series_from_evidence(evidence: dict[str, Any], measure: str) -> list[float]:
    """The values the run actually retrieved for one measure, out of its evidence record.

    Read from the evidence rather than from a fixture on disk, so the reference is computed over
    *the same numbers the answer came from*. A reference computed from a separately-read fixture
    would disagree with a correct answer the moment the two drifted, and the disagreement would
    look like a wrong answer.
    """
    values: list[float] = []

    for result in evidence.get("tool_results") or ():
        payload = (result or {}).get("payload") or {}
        for key in ("daily", "hourly"):
            series = payload.get(key)
            if not isinstance(series, dict):
                continue
            for entry in series.get("entries") or ():
                found = (entry or {}).get("values", {}).get(measure)
                if isinstance(found, int | float):
                    values.append(float(found))
        if values:
            # The first series carrying the measure is the one the answer is about; a later tool
            # call in the same run is a *different* window and averaging across both would be a
            # number nobody asked for.
            break

    return values


def _compute_reference(reference: ReferenceComputation, evidence: dict[str, Any]) -> float | None:
    """The deterministic reference for a numeric case, over the run's own retrieved series."""
    values = _series_from_evidence(evidence, reference.measure)
    if not values:
        return None

    statistic = reference.statistic
    if statistic == "mean":
        return sum(values) / len(values)
    if statistic == "minimum":
        return min(values)
    if statistic == "maximum":
        return max(values)
    if statistic == "range":
        return max(values) - min(values)
    if statistic == "total":
        return sum(values)
    if statistic == "count":
        return float(len(values))

    raise ValueError(
        f"{statistic!r} is not a reference statistic the runner computes. Add it here and to the "
        "case schema together, so a case cannot declare one that silently returns nothing."
    )


# =========================================================================== executing a case


def _resolution_of(answer: dict[str, Any]) -> dict[str, Any]:
    """One turn's resolution, in the vocabulary a case declares its expectations in."""
    resolved = answer.get("resolved") or {}
    period = resolved.get("period") or {}

    window_days: int | None = None
    if period.get("start_utc") and period.get("end_utc"):
        start = datetime.fromisoformat(str(period["start_utc"]).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(period["end_utc"]).replace("Z", "+00:00"))
        window_days = max(1, round((end - start).total_seconds() / 86_400))

    return {
        "locations": tuple(
            place.get("display_name", "") for place in resolved.get("locations") or ()
        ),
        "unit_system": resolved.get("unit_system"),
        "criterion": resolved.get("criterion"),
        "location_source": resolved.get("location_source"),
        "units_source": resolved.get("units_source"),
        "window_days": window_days,
    }


def _numbers_within(payload: Any, depth: int = 0) -> list[float]:
    """Every number nested anywhere in an evidence record."""
    if depth > 8 or isinstance(payload, bool):
        return []
    if isinstance(payload, int | float):
        return [float(payload)]
    if isinstance(payload, dict):
        return [value for item in payload.values() for value in _numbers_within(item, depth + 1)]
    if isinstance(payload, list | tuple):
        return [value for item in payload for value in _numbers_within(item, depth + 1)]
    return []


async def _execute_case(
    case: EvaluationCase,
    client: httpx.AsyncClient,
    identity: TestIdentity,
    settings: Settings,
) -> tuple[CaseOutcome, CaseRecord]:
    """Run one case through the API and reduce it to what the metrics score.

    A multi-turn case runs its turns in one thread, in order, so a follow-up resolves against the
    turn before it — which is the thing the memory metrics are about.
    """
    prefix = settings.api_version_prefix
    headers = identity.authorization()

    # Preferences the case declares, set before it runs and cleared after, so one case's stored
    # preference cannot change the next case's answer.
    if case.preferences:
        await _apply_preferences(client, prefix, headers, case.preferences)

    thread_id: str | None = None
    answers: list[dict[str, Any]] = []
    statuses: list[int] = []
    latencies: list[float] = []
    error: str | None = None

    try:
        for index, question in enumerate(case.questions):
            body: dict[str, Any] = {"question": question}
            turn = case.turns[index] if index < len(case.turns) else None
            # The turn's own units where it declares them, so a case can test one turn choosing
            # and the next inheriting from the conversation.
            requested_units = (turn.units if turn else None) or case.units
            if requested_units:
                body["units"] = requested_units
            if case.is_multi_turn:
                if index == 0:
                    body["create_thread"] = True
                else:
                    body["thread_id"] = thread_id

            started = time.perf_counter()
            response = await client.post(
                f"{prefix}/agent/ask", json=body, headers=headers, timeout=120.0
            )
            latencies.append((time.perf_counter() - started) * 1000.0)
            statuses.append(response.status_code)

            if response.status_code != 200:
                error = (
                    f"{response.status_code} on turn {index + 1}: "
                    f"{_error_code(response) or response.text[:120]}"
                )
                break

            payload = response.json()
            answers.append(payload["answer"])
            thread_id = payload.get("thread_id") or thread_id
    except httpx.HTTPError as failure:  # pragma: no cover - the harness has no network
        error = f"transport failure: {type(failure).__name__}"
    finally:
        if case.preferences:
            await client.delete(f"{prefix}/me/preferences", headers=headers)

    if not answers:
        outcome = CaseOutcome(
            case_id=case.case_id,
            category=case.category,
            http_status=statuses[-1] if statuses else None,
            schema_valid=False,
            latency_ms=latencies[-1] if latencies else None,
            error=error,
        )
        return outcome, CaseRecord(
            case_id=case.case_id,
            category=case.category,
            passed=False,
            latency_ms=outcome.latency_ms,
            http_status=outcome.http_status,
            error=error or "no answer was produced",
        )

    final = answers[-1]
    evidence = final.get("evidence") or {}

    reference_value = (
        _compute_reference(case.reference, evidence) if case.reference is not None else None
    )

    outcome = CaseOutcome(
        case_id=case.case_id,
        category=case.category,
        answer=final.get("answer_prose") or "",
        tools_called=tuple(call.get("tool", "") for call in evidence.get("tool_calls") or ()),
        agents_run=tuple(step.get("agent", "") for step in evidence.get("agents") or ()),
        evidence_values=tuple(_numbers_within(evidence)),
        evidence_fields=tuple(
            key
            for result in evidence.get("tool_results") or ()
            for key in ((result or {}).get("payload") or {})
        ),
        cited_documents=tuple(
            citation.get("document_id", "") for citation in evidence.get("citations") or ()
        ),
        attribution=tuple(final.get("attribution") or ()),
        resolutions=tuple(_resolution_of(answer) for answer in answers),
        asserted_figures=figures_in(final.get("answer_prose") or ""),
        reference_value=reference_value,
        latency_ms=sum(latencies) if latencies else None,
        http_status=statuses[-1] if statuses else None,
        schema_valid=True,
        clarification_asked=bool(final.get("clarification_question")),
        refused=bool(final.get("unanswered_parts")),
        carries_weather_data=bool(final.get("findings")),
    )

    return outcome, CaseRecord(
        case_id=case.case_id,
        category=case.category,
        passed=True,  # replaced once the metrics are computed
        answer=outcome.answer,
        evidence=evidence,
        latency_ms=outcome.latency_ms,
        http_status=outcome.http_status,
        error=error,
    )


def _error_code(response: httpx.Response) -> str | None:
    try:
        return str(response.json()["error"]["code"])
    except Exception:
        return None


async def _apply_preferences(
    client: httpx.AsyncClient, prefix: str, headers: dict[str, str], preferences: dict[str, str]
) -> None:
    """Set the preferences a case declares, through the API the way a person would."""
    body: dict[str, Any] = {}
    if "default_location" in preferences:
        body["default_location"] = preferences["default_location"]
    if "unit_system" in preferences:
        body["unit_system"] = preferences["unit_system"]
    if "forecast_horizon_days" in preferences:
        body["forecast_horizon_days"] = int(preferences["forecast_horizon_days"])
    if body:
        await client.put(f"{prefix}/me/preferences", json=body, headers=headers)


# =========================================================================== the run


def _commit_sha() -> str | None:
    """The commit under evaluation, so a stored run can be traced back to its code."""
    for variable in ("GITHUB_SHA", "WEATHRA_COMMIT_SHA"):
        found = os.environ.get(variable)
        if found:
            return found[:40]
    try:
        return (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout.strip()[:40]
            or None
        )
    except Exception:
        return None


def select_cases(
    *, category: str | None = None, case_id: str | None = None
) -> tuple[EvaluationCase, ...]:
    """The cases a run should execute, after its filters.

    ``specs/evaluation`` requires both filters so a subset can be re-run — which is what makes a
    failing case investigable without paying for the whole dataset again.
    """
    cases = load_dataset()

    if category is not None:
        try:
            wanted = Category(category)
        except ValueError:
            raise ValueError(
                f"{category!r} is not an evaluation category. Available: "
                f"{', '.join(entry.value for entry in Category)}."
            ) from None
        cases = tuple(case for case in cases if case.category is wanted)

    if case_id is not None:
        cases = tuple(case for case in cases if case.case_id == case_id)
        if not cases:
            raise ValueError(f"No case with identifier {case_id!r} is in the dataset.")

    return cases


async def execute_run(
    settings: Settings,
    *,
    mode: EvaluationMode = EvaluationMode.OFFLINE,
    category: str | None = None,
    case_id: str | None = None,
) -> RunResult:
    """Execute the dataset and score it. The function CI and the CLI both call."""
    cases = select_cases(category=category, case_id=case_id)
    started = datetime.now(UTC)
    engines = Engines.create(settings)

    try:
        async with build_evaluation_app(settings, mode=mode) as prepared:
            identity = prepared.identity
            outcomes: list[CaseOutcome] = []
            records: list[CaseRecord] = []

            for case in cases:
                logger.info("running %s (%s)", case.case_id, case.category.value)
                prepared.script_for(case)
                outcome, record = await _execute_case(case, prepared.client, identity, settings)
                outcomes.append(outcome)
                records.append(record)

            metrics = compute_metrics(outcomes, cases)
            thresholds = evaluate_thresholds(metrics)
            configuration = RunConfiguration(
                dataset_version=DATASET_VERSION,
                mode=mode,
                llm_provider=prepared.llm_provider,
                llm_model=prepared.llm_model,
                weather_provider=prepared.weather_provider,
                embedding_model=settings.embedding_model_id,
                commit_sha=_commit_sha(),
                category_filter=category,
                case_filter=case_id,
                test_user=identity.recorded(),
                cases_selected=len(cases),
            )
    finally:
        await engines.dispose()

    failing = _failing_case_ids(metrics)
    return RunResult(
        configuration=configuration,
        cases=tuple(
            record.model_copy(update={"passed": record.case_id not in failing})
            for record in records
        ),
        metrics=metrics,
        thresholds=thresholds,
        started_at=started,
        completed_at=datetime.now(UTC),
    )


def _failing_case_ids(metrics: MetricsReport) -> set[str]:
    """Every case that failed any metric it was applicable to.

    A case "passes" when nothing it was measured against failed. The lower-is-better rates are
    included: a case that hallucinated a figure did not pass, whatever else it got right.
    """
    failing: set[str] = set()
    for result in metrics.results.values():
        failing.update(result.failing_cases)
    return failing


# =========================================================================== the command line


def main(argv: list[str] | None = None) -> int:
    """``weathra-evaluate``. Exits non-zero when a threshold is missed, so CI can gate on it."""
    parser = argparse.ArgumentParser(
        prog="weathra-evaluate",
        description=(
            "Execute Weathra's evaluation dataset, compute the ten metrics, and report each "
            "acceptance threshold. Offline by default: no network, no credential, and every "
            "deterministic metric still computed."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=[entry.value for entry in EvaluationMode],
        default=EvaluationMode.OFFLINE.value,
        help="'offline' uses recorded fixtures and the scripted model; 'live' uses the real ones.",
    )
    parser.add_argument("--category", help="Run only one category.")
    parser.add_argument("--case", dest="case_id", help="Run only one case, by identifier.")
    parser.add_argument(
        "--json", dest="as_json", action="store_true", help="Emit the run record as JSON."
    )
    parser.add_argument(
        "--output", type=Path, help="Write the run record as JSON to this path as well."
    )
    parser.add_argument(
        "--persist",
        action="store_true",
        help="Store the run in the database for cross-run comparison.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = Settings()
    mode = EvaluationMode(args.mode)

    if mode is EvaluationMode.LIVE and not settings.inference_configured:
        print(
            "A live evaluation run needs an inference credential. Set OPENROUTER_API_KEY, or run "
            "with --mode offline, which computes every deterministic metric without one.",
            file=sys.stderr,
        )
        return 2

    result = asyncio.run(
        execute_run(settings, mode=mode, category=args.category, case_id=args.case_id)
    )

    if args.persist:
        from weathra.evaluation.storage import persist

        asyncio.run(persist(settings, result))

    payload = result.model_dump(mode="json")
    if args.output:
        args.output.write_text(json.dumps(payload, indent=2, sort_keys=True))
    print(json.dumps(payload, indent=2, sort_keys=True) if args.as_json else result.report())

    return 0 if result.passed else 1


if __name__ == "__main__":  # pragma: no cover - exercised through the console script
    raise SystemExit(main())
