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
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.domain.entitlements import Resolution
from weathra.domain.evidence import InferenceAttempt
from weathra.evaluation.cases import (
    DATASET_VERSION,
    Category,
    EvaluationCase,
    ReferenceComputation,
    load_dataset,
)
from weathra.evaluation.harness import build_evaluation_app
from weathra.evaluation.integrity import InferenceIntegrity, RunOutcome, assess_integrity
from weathra.evaluation.metrics import CaseOutcome, MetricsReport, compute_metrics, figures_in
from weathra.evaluation.provisioning import EvaluationMode, TestIdentity
from weathra.evaluation.thresholds import GATED_METRICS, ThresholdReport, evaluate_thresholds

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
    policy_id: str | None = Field(
        default=None,
        description=(
            "The policy that resolved this run's model. `evaluation_fixed` for a live run, the "
            "pinned-candidate indicator for a comparison candidate, null for an offline run — "
            "which resolves nothing, because the scripted client is installed rather than chosen."
        ),
    )
    catalog_key: str | None = Field(
        default=None, description="The catalog entry the resolution selected. Never a vendor name."
    )
    resolution_reason: str | None = Field(
        default=None,
        description="The resolver's own ordered walk, so 'why this model' needs no re-resolution.",
    )
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
    inference_attempts: tuple[InferenceAttempt, ...] = ()
    model_served: bool = Field(
        default=True,
        description="Whether the configured model served every call this case made.",
    )


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
    def integrity(self) -> InferenceIntegrity | None:
        return self.thresholds.integrity

    @property
    def outcome(self) -> RunOutcome | None:
        return self.thresholds.run_outcome

    @property
    def provider_failed(self) -> bool:
        return self.thresholds.provider_failed

    @property
    def passed(self) -> bool | None:
        """The quality verdict, or ``None`` when the run has not earned one.

        ``None`` rather than ``False`` on a provider failure. The database column is already
        nullable and ``storage._verdict`` already renders null as "not scored", so the honest
        third answer needed no schema change to express — only somebody to stop collapsing it
        into the second.
        """
        return self.thresholds.passed

    @property
    def duration_seconds(self) -> float:
        return (self.completed_at - self.started_at).total_seconds()

    def report(self) -> str:
        """The human-readable report, for a terminal and for CI's log."""
        integrity = self.integrity
        banner: list[str] = []
        if self.provider_failed and integrity is not None:
            banner = [
                "  !! PROVIDER FAILURE — this run did not evaluate the configured model.",
                *(f"  {line}" for line in integrity.describe()),
                "  The metrics below were computed over deterministic-fallback output and are",
                "  NOT model-quality metrics. No threshold verdict is reported.",
                "",
            ]

        lines = [
            "Weathra evaluation",
            "=" * 60,
            *banner,
            f"dataset       {self.configuration.dataset_version}",
            f"mode          {self.configuration.mode.value}",
            f"provider      {self.configuration.weather_provider}",
            f"model         {self.configuration.llm_provider or '-'}/"
            f"{self.configuration.llm_model or '-'}"
            + (
                f"  (policy {self.configuration.policy_id}, {self.configuration.catalog_key})"
                if self.configuration.policy_id
                else ""
            ),
            f"embedder      {self.configuration.embedding_model}",
            f"commit        {self.configuration.commit_sha or '-'}",
            f"cases         {len(self.cases)} of {self.configuration.cases_selected} selected",
            f"served        {self.metrics.cases_scored} scored"
            + (
                f", {len(self.metrics.cases_quarantined)} quarantined"
                if self.metrics.cases_quarantined
                else ""
            ),
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

    # Every turn's attempts, not only the final one. A multi-turn case whose *second* turn fell
    # back is contaminated in exactly the dimension the memory metrics measure, and reading only
    # the last turn would miss a first-turn failure entirely.
    attempts = tuple(
        attempt for answer in answers for attempt in _attempts_in(answer.get("evidence") or {})
    )

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
        inference_attempts=attempts,
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
        inference_attempts=attempts,
        model_served=outcome.model_served,
    )


def _attempts_in(evidence: dict[str, Any]) -> tuple[InferenceAttempt, ...]:
    """The inference attempts an answer's evidence record carries.

    Parsed rather than trusted: the evidence arrives as JSON over HTTP like any other response
    field, and an unparseable entry is dropped with a warning rather than failing the run — a
    malformed provenance record is a reason to look at the record, not to lose the case.
    """
    raw = evidence.get("inference_attempts") or ()
    parsed: list[InferenceAttempt] = []
    for entry in raw:
        try:
            parsed.append(InferenceAttempt.model_validate(entry))
        except Exception:  # a bad entry must not take the run down
            logger.warning("could not read an inference attempt from the evidence record")
    return tuple(parsed)


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
    pinned_model: str | None = None,
    pinned_catalog_key: str | None = None,
    cases: Sequence[EvaluationCase] | None = None,
) -> RunResult:
    """Execute the dataset and score it. The function CI and the CLI both call.

    **The model comes from the policy layer.** `specs/evaluation` requires a live run to resolve
    its pinned model through the fixed-model evaluation policy rather than through the evaluation
    test user's subscription plan, so the harness pins the process and the resolution is read back
    from the broker. Nothing here selects a model, which is why ``LLM_MODEL`` no longer appears in
    this function: it was a second model-selection path, and the only reason a live run happened to
    use it was that the policy walk fell all the way through to it.

    *pinned_catalog_key* names the candidate a model comparison is measuring. `specs/evaluation`
    compares models "by executing several pinned runs, one per model", and this is that pin — a
    catalog key, validated against the database at resolution time, so a candidate run's record
    names a real catalog entry rather than a string.

    *pinned_model* is the offline half of the same pin: offline mode resolves nothing and installs
    a scripted client, so the candidate's gateway identifier is what the client *records* in order
    that each candidate's results are attributed to that candidate rather than to the shared
    offline client. ``None`` is every existing caller, unchanged.

    *cases* lets a caller supply the selection instead of re-deriving it from the filters, so a
    comparison selects once and every candidate provably runs the same set — the alternative is
    three independent selections that agree today.
    """
    selected = select_cases(category=category, case_id=case_id) if cases is None else tuple(cases)
    started = datetime.now(UTC)
    engines = Engines.create(settings)
    pacing = settings.evaluation_llm_min_interval_seconds if mode is EvaluationMode.LIVE else 0.0

    try:
        async with build_evaluation_app(
            settings, mode=mode, pinned_catalog_key=pinned_catalog_key
        ) as prepared:
            if pinned_model is not None and mode is EvaluationMode.OFFLINE:
                prepared.pinned_model_id = pinned_model
            identity = prepared.identity
            outcomes: list[CaseOutcome] = []
            records: list[CaseRecord] = []

            # Ask the configured model one question before spending the dataset on it. A withdrawn
            # model, an exhausted quota or a rejected credential all answer here, in one call
            # rather than eighty — which is exactly what should have happened to the Task 22.8
            # live runs instead of forty fallback answers being scored as model quality.
            pinned = await _resolve_pinned(prepared) if mode is EvaluationMode.LIVE else None
            resolution = pinned.resolution if pinned else None
            if pinned is not None:
                # Read off the client that will actually serve, not off the resolution: where the
                # two differ the record has to show what answered. `configuration.catalog_key`
                # below carries the resolution's own side of the same question.
                prepared.llm_provider = pinned.client.provider_id
                prepared.llm_model = pinned.client.model_id

            probe = await _preflight(mode, pinned)
            if probe is not None:
                return _aborted_run(
                    settings,
                    cases=selected,
                    prepared=prepared,
                    started=started,
                    probe=probe,
                    category=category,
                    case_id=case_id,
                    mode=mode,
                    resolution=resolution,
                )

            for index, case in enumerate(selected):
                if pacing > 0 and index > 0:
                    # Spacing, not a retry. Forty cases at up to two calls each would otherwise
                    # arrive as one burst and trip a free tier's per-minute ceiling on a model
                    # that is working perfectly well.
                    await asyncio.sleep(pacing)
                logger.info("running %s (%s)", case.case_id, case.category.value)
                prepared.script_for(case)
                outcome, record = await _execute_case(case, prepared.client, identity, settings)
                outcomes.append(outcome)
                records.append(record)

            metrics = compute_metrics(outcomes, selected)
            integrity = assess_integrity(
                outcomes,
                metrics,
                mode=mode,
                minimum_served_rate=settings.evaluation_min_served_rate,
                gated_metrics=GATED_METRICS,
                # Only when quarantine actually removed something; otherwise the two reports are
                # identical by construction and computing the second would be waste.
                metrics_before_quarantine=(
                    compute_metrics(outcomes, selected, quarantine=False)
                    if metrics.cases_quarantined
                    else metrics
                ),
            )
            thresholds = evaluate_thresholds(metrics, integrity=integrity)
            configuration = RunConfiguration(
                dataset_version=DATASET_VERSION,
                mode=mode,
                llm_provider=prepared.llm_provider,
                llm_model=prepared.llm_model,
                policy_id=str(resolution.policy_id) if resolution else None,
                catalog_key=resolution.catalog_key if resolution else None,
                resolution_reason=resolution.reason if resolution else None,
                weather_provider=prepared.weather_provider,
                embedding_model=settings.embedding_model_id,
                commit_sha=_commit_sha(),
                category_filter=category,
                case_filter=case_id,
                test_user=identity.recorded(),
                cases_selected=len(selected),
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


class PinnedInference(BaseModel):
    """What a live run is pinned to: the resolution that governed it, and the client that serves.

    Two facts rather than one, because they can differ and a run record that collapsed them would
    hide exactly the substitution `specs/evaluation` requires to be visible. They differ in one
    situation — a client explicitly installed over the resolved one, which is how the provider-
    outage suites exercise a live-shaped run without a credential.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", arbitrary_types_allowed=True)

    client: Any = Field(repr=False, exclude=True)
    resolution: Resolution


async def _resolve_pinned(prepared: Any) -> PinnedInference:
    """The model this live run is pinned to, from the policy layer rather than from `LLM_MODEL`.

    `specs/evaluation` requires a live run to resolve its pinned model "through a fixed-model
    evaluation policy rather than through the evaluation test user's subscription plan". So the
    runner asks the same broker the request path asks, on a process the harness has already
    pinned — which is what makes the run record's model and the model the cases actually reach the
    same fact rather than two settings that agree today.

    Resolved once, for `ROUTING`. The pinned policy applies to every role and has one candidate, so
    a second resolution would be the same answer; recording it once is what lets the run claim
    *one* model, which is the requirement.

    The client comes back with it, from the same binding, so the pre-flight probes what the cases
    will reach rather than something built alongside it.
    """
    from weathra.auth.rls import session_for
    from weathra.domain.entitlements import CallRole
    from weathra.domain.identity import Principal

    provider = prepared.app.state.inference
    principal = Principal(user_id=prepared.identity.user_id, email=prepared.identity.email)
    async with session_for(prepared.app.state.engines, principal) as session:
        # The restricted session, as a request would use — the catalog and policy reads a
        # resolution makes are the same reads under the same Row Level Security. `principal` is
        # handed over so the session binds claims; the pinned path never reads a plan from it.
        broker = provider.broker(session=session, principal=principal)
        binding = await broker.binding_for(CallRole.ROUTING)
    resolution = binding.resolution
    logger.info(
        "run pinned by policy %s to %s (%s/%s)",
        resolution.policy_id,
        resolution.catalog_key,
        resolution.gateway_provider,
        resolution.gateway_model,
    )
    return PinnedInference(client=binding.client, resolution=resolution)


async def _preflight(
    mode: EvaluationMode, pinned: PinnedInference | None
) -> InferenceAttempt | None:
    """Ask the pinned model one structured question. ``None`` means it answered.

    Only in live mode: offline substitutes a client that cannot fail this way, and spending a
    probe on it would test the stand-in.

    The probe goes through Weathra's own client and its own ``complete_json``, so it exercises the
    same translation and the same bounded JSON retry a case would. A probe that bypassed them
    could pass while every real call failed — and the client is the one the *resolution* produced,
    so what it proves is that the model the dataset is about to reach can answer, rather than that
    whatever `LLM_MODEL` names can.
    """
    if mode is not EvaluationMode.LIVE or pinned is None:
        return None

    from weathra.agents.llm.base import Message, classify_inference_failure
    from weathra.agents.plan import RoutingPlan
    from weathra.agents.supervisor import ROUTING_SYSTEM_PROMPT
    from weathra.domain.errors import WeathraError
    from weathra.domain.evidence import InferenceStage

    client = pinned.client
    started = time.perf_counter()
    try:
        await client.complete_json(
            system=ROUTING_SYSTEM_PROMPT,
            messages=[Message.user("Question: will it rain in Berlin tomorrow?")],
            schema=RoutingPlan,
        )
    except WeathraError as exc:
        status, http_status = classify_inference_failure(exc)
        latency = (time.perf_counter() - started) * 1000.0
        if status.served:
            # The model answered and could not produce a valid plan. That is a quality result, and
            # a quality result is what the dataset exists to measure — so the run proceeds and the
            # metrics say so, rather than the probe pre-judging the model.
            logger.warning("pre-flight produced invalid output; running the dataset anyway")
            return None
        logger.error("pre-flight failed (%s); aborting before any case runs", status.value)
        return InferenceAttempt(
            stage=InferenceStage.ROUTING,
            status=status,
            provider=client.provider_id,
            selected_model=client.model_id,
            http_status=http_status,
            error_code=exc.code,
            fallback_reason=(
                "Pre-flight: the configured model could not serve a call, so the dataset was "
                "not executed."
            ),
            latency_ms=latency,
        )

    logger.info("pre-flight served by %s/%s", client.provider_id, client.model_id)
    return None


def _aborted_run(
    settings: Settings,
    *,
    cases: tuple[EvaluationCase, ...],
    prepared: Any,
    started: datetime,
    probe: InferenceAttempt,
    category: str | None,
    case_id: str | None,
    mode: EvaluationMode,
    resolution: Resolution | None = None,
) -> RunResult:
    """A run that never executed a case, recorded honestly rather than not at all.

    It carries the probe's own attempt as its diagnostic. There are no case records because there
    were no cases — which is the point: a provider failure caught here costs one gateway call.
    """
    metrics = compute_metrics([], cases)
    integrity = assess_integrity(
        [],
        metrics,
        mode=mode,
        minimum_served_rate=settings.evaluation_min_served_rate,
        gated_metrics=GATED_METRICS,
    )
    integrity = integrity.model_copy(
        update={
            "attempts_by_status": {probe.status.value: 1},
            "reason": (
                f"Pre-flight: {probe.status.value}"
                + (f" (HTTP {probe.http_status})" if probe.http_status else "")
                + ". The dataset was not executed."
            ),
            "outcome": RunOutcome.PROVIDER_FAILURE,
        }
    )
    return RunResult(
        configuration=RunConfiguration(
            dataset_version=DATASET_VERSION,
            mode=mode,
            llm_provider=prepared.llm_provider,
            llm_model=prepared.llm_model,
            policy_id=str(resolution.policy_id) if resolution else None,
            catalog_key=resolution.catalog_key if resolution else None,
            resolution_reason=resolution.reason if resolution else None,
            weather_provider=prepared.weather_provider,
            embedding_model=settings.embedding_model_id,
            commit_sha=_commit_sha(),
            category_filter=category,
            case_filter=case_id,
            test_user=prepared.identity.recorded(),
            cases_selected=len(cases),
        ),
        cases=(),
        metrics=metrics,
        thresholds=evaluate_thresholds(metrics, integrity=integrity),
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
            "deterministic metric still computed. Exits 0 on a pass, 1 on a missed threshold, "
            "2 on a misconfiguration, and 3 when the configured model did not serve the run."
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
    parser.add_argument(
        "--min-served-rate",
        type=float,
        default=None,
        help=(
            "Proportion of cases the configured model must serve for the run to be scored as "
            "model quality. Defaults to EVALUATION_MIN_SERVED_RATE (1.0)."
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = Settings()
    if args.min_served_rate is not None:
        settings = settings.model_copy(update={"evaluation_min_served_rate": args.min_served_rate})
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

    if result.provider_failed:
        # Distinct from 1 on purpose. A provider outage and a model that scored badly are
        # different findings and must not share an exit code: CI gating on 1 would otherwise
        # report "Weathra got worse" every time the gateway had a bad afternoon.
        print(
            "\nThe configured model did not serve this run, so no quality verdict was produced.",
            file=sys.stderr,
        )
        return 3
    return 0 if result.passed else 1


if __name__ == "__main__":  # pragma: no cover - exercised through the console script
    raise SystemExit(main())
