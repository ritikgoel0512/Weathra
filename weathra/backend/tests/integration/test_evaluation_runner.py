"""Tasks 22.2, 22.5, 22.6, 22.7 — provisioning, the runner, offline mode, and comparison.

`db` because a run authenticates as a provisioned user, writes evidence records, and stores itself
— all of which are rows. Offline throughout: no Supabase, no inference credential, no network.
"""

from __future__ import annotations

import json
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import SecretStr
from sqlalchemy import text

from weathra.agents.llm.openrouter import OpenRouterClient
from weathra.config import Settings
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.errors import ProviderUnavailable
from weathra.evaluation.cases import DATASET_VERSION, Category, load_dataset
from weathra.evaluation.fixtures import MissingFixture, build_offline_transport, recorded_places
from weathra.evaluation.harness import PreparedApp
from weathra.evaluation.integrity import RunOutcome
from weathra.evaluation.metrics import MetricName
from weathra.evaluation.offline_llm import OFFLINE_PROVIDER_ID
from weathra.evaluation.provisioning import (
    TEST_USER_EMAIL,
    EvaluationMode,
    provision_test_user,
)
from weathra.evaluation.runner import (
    RunResult,
    _aborted_run,
    _preflight,
    execute_run,
    select_cases,
)
from weathra.evaluation.storage import compare_runs, latest_runs, persist

pytestmark = pytest.mark.db


@pytest.fixture
def evaluation_settings(migrated_database: str, clean_database: None) -> Settings:
    """Settings for an offline evaluation run against the test database."""
    return Settings(
        supabase_url="https://project.supabase.co",
        database_url=migrated_database,
        database_url_privileged=migrated_database,
        database_pool_size=2,
        database_pool_max_overflow=0,
        mcp_transport="in-process",
        embedding_model_id="weathra-hashing-v1",
        http_backoff_seconds=0,
    )


# =========================================================================== 22.2 provisioning


async def test_a_run_with_no_existing_test_user_provisions_one_and_authenticates(
    evaluation_settings: Settings,
) -> None:
    """``specs/evaluation``: without manual intervention. This is the whole requirement."""
    engines = Engines.create(evaluation_settings)
    try:
        identity, validator = await provision_test_user(
            evaluation_settings, engines, mode=EvaluationMode.OFFLINE
        )

        assert identity.provisioned_now, "the first run created the user"
        assert identity.email == TEST_USER_EMAIL
        assert identity.mode is EvaluationMode.OFFLINE

        # And the token it minted authenticates against the validator it seeded.
        assert validator is not None
        principal = await validator.validate(identity.access_token.get_secret_value())
        assert principal.user_id == identity.user_id

        async with privileged_session(engines.privileged_sessionmaker) as session:
            found = await session.scalar(
                text("SELECT count(*) FROM profiles WHERE user_id = :id"),
                {"id": identity.user_id},
            )
        assert found == 1
    finally:
        await engines.dispose()


async def test_a_second_run_reuses_the_same_user(evaluation_settings: Settings) -> None:
    """The email is derived rather than random, so a re-run does not accumulate accounts."""
    engines = Engines.create(evaluation_settings)
    try:
        first, _ = await provision_test_user(
            evaluation_settings, engines, mode=EvaluationMode.OFFLINE
        )
        second, _ = await provision_test_user(
            evaluation_settings, engines, mode=EvaluationMode.OFFLINE
        )

        assert first.user_id == second.user_id
        assert first.provisioned_now
        assert not second.provisioned_now
    finally:
        await engines.dispose()


async def test_the_recorded_identity_carries_no_credential(
    evaluation_settings: Settings,
) -> None:
    """A run record is archived by CI and read by people."""
    engines = Engines.create(evaluation_settings)
    try:
        identity, _ = await provision_test_user(
            evaluation_settings, engines, mode=EvaluationMode.OFFLINE
        )
        token = identity.access_token.get_secret_value()

        recorded = identity.recorded()
        assert set(recorded) == {"user_id", "email", "mode", "provisioned_now"}
        assert token not in json.dumps(recorded)

        # And serializing the identity itself excludes it too.
        serialized = identity.model_dump_json()
        assert token not in serialized
        assert "access_token" not in serialized
        assert token not in repr(identity)
    finally:
        await engines.dispose()


async def test_a_live_run_without_a_service_role_key_says_what_is_missing(
    evaluation_settings: Settings,
) -> None:
    engines = Engines.create(evaluation_settings)
    try:
        import httpx

        with pytest.raises(ValueError, match="SUPABASE_SERVICE_ROLE_KEY"):
            await provision_test_user(
                evaluation_settings,
                engines,
                mode=EvaluationMode.LIVE,
                client=httpx.AsyncClient(),
            )
    finally:
        await engines.dispose()


# =========================================================================== 22.6 offline mode


def test_offline_mode_replays_recorded_payloads() -> None:
    """Genuine Open-Meteo responses, so the whole normalization stack is exercised."""
    transport = build_offline_transport()
    assert transport is not None
    assert set(recorded_places()) >= {"Berlin", "Munich", "Lisbon"}


def test_a_request_no_fixture_covers_fails_loudly() -> None:
    """Not with an empty payload, and not by reaching the network."""
    import httpx

    transport = build_offline_transport()
    request = httpx.Request(
        "GET",
        "https://api.open-meteo.com/v1/forecast?latitude=-33.87&longitude=151.21&forecast_days=3",
    )
    with pytest.raises(MissingFixture) as raised:
        transport.handle_request(request)

    assert "Berlin" in str(raised.value), "the error names what is recorded"
    assert "record_evaluation_fixtures" in str(raised.value), "and how to add more"


def test_a_replayed_forecast_is_clipped_to_the_requested_horizon() -> None:
    """Otherwise every offline window would be the recording's full sixteen days."""
    import httpx

    transport = build_offline_transport()
    response = transport.handle_request(
        httpx.Request(
            "GET",
            "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&forecast_days=3",
        )
    )
    payload = json.loads(response.content)
    assert len(payload["daily"]["time"]) == 3
    assert len(payload["hourly"]["time"]) == 72


async def test_offline_mode_computes_the_deterministic_metrics_with_no_network(
    evaluation_settings: Settings,
) -> None:
    """``specs/evaluation``: the deterministic metrics run without external services."""
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )

    assert result.configuration.mode is EvaluationMode.OFFLINE, "the mode is recorded"
    assert result.metrics.result(MetricName.RAG_RETRIEVAL_QUALITY).applicable
    assert result.metrics.result(MetricName.BACKEND_SUCCESSFUL_RESPONSE_RATE).value == 1.0
    assert result.metrics.result(MetricName.TOOL_SELECTION_ACCURACY).value == 1.0


# =========================================================================== 22.5 the runner


async def test_a_filtered_run_records_its_whole_configuration(
    evaluation_settings: Settings,
) -> None:
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="historical"
    )

    configuration = result.configuration
    assert configuration.dataset_version == DATASET_VERSION
    assert configuration.mode is EvaluationMode.OFFLINE
    assert configuration.weather_provider == "open-meteo"
    assert configuration.embedding_model == "weathra-hashing-v1"
    assert configuration.category_filter == "historical"
    assert configuration.case_filter is None
    assert configuration.cases_selected == len(select_cases(category="historical"))
    assert configuration.llm_provider == "offline"
    assert configuration.llm_model

    # The identity, without its credential.
    assert configuration.test_user["user_id"]
    assert set(configuration.test_user) == {"user_id", "email", "mode", "provisioned_now"}
    assert "token" not in json.dumps(configuration.test_user)


async def test_a_single_case_filter_runs_only_that_case(
    evaluation_settings: Settings,
) -> None:
    """What makes a failing case investigable without paying for the whole dataset."""
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="kn-dew-point"
    )

    assert len(result.cases) == 1
    assert result.cases[0].case_id == "kn-dew-point"
    assert result.configuration.case_filter == "kn-dew-point"


async def test_the_run_record_carries_no_credential_anywhere(
    evaluation_settings: Settings,
) -> None:
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="kn-dew-point"
    )
    serialized = json.dumps(result.model_dump(mode="json"))

    assert "access_token" not in serialized
    assert "eyJ" not in serialized, "nothing JWT-shaped"
    assert "service_role" not in serialized


async def test_evidence_is_retained_for_every_case_including_a_failing_one(
    evaluation_settings: Settings,
) -> None:
    """``specs/evaluation``: a failure is diagnosable from the record without re-running it."""
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="cf-berlin-tomorrow"
    )

    record = result.cases[0]
    assert record.evidence, "the full evidence record"
    assert record.evidence["tool_calls"], "including the calls"
    assert record.evidence["agents"], "and the agents that ran"
    assert record.answer, "and the answer as it was written"
    assert record.latency_ms is not None
    assert record.http_status == 200


async def test_a_refusal_case_is_recorded_with_its_reason(
    evaluation_settings: Settings,
) -> None:
    """An unresolvable place is a *correct* outcome, and the record shows what happened."""
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="cf-unresolvable-place"
    )

    record = result.cases[0]
    assert record.http_status == 200, "a clarifying question is a successful response"
    assert record.evidence["tool_calls"] == [], "and nothing was retrieved"


async def test_an_unknown_category_filter_lists_the_available_ones() -> None:
    with pytest.raises(ValueError, match="not an evaluation category"):
        select_cases(category="hand-waving")
    for category in Category:
        assert select_cases(category=category.value)


async def test_an_unknown_case_filter_says_so() -> None:
    with pytest.raises(ValueError, match="No case with identifier"):
        select_cases(case_id="nobody-wrote-this-case")


async def test_the_report_names_a_failing_threshold_and_its_margin(
    evaluation_settings: Settings,
) -> None:
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )
    report = result.report()

    assert "Weathra evaluation" in report
    assert "Thresholds" in report
    assert "Latency" in report
    assert DATASET_VERSION in report
    for outcome in result.thresholds.outcomes:
        if outcome.passed is False:
            assert "short by" in outcome.describe()


# =========================================================================== 22.7 persistence


async def test_a_run_is_stored_and_can_be_read_back(evaluation_settings: Settings) -> None:
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )
    run_id = await persist(evaluation_settings, result)

    assert run_id
    stored = await latest_runs(evaluation_settings, limit=5)
    assert [entry["id"] for entry in stored] == [run_id]
    assert stored[0]["dataset_version"] == DATASET_VERSION
    assert stored[0]["mode"] == "offline"

    engines = Engines.create(evaluation_settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            cases = await session.scalar(
                text("SELECT count(*) FROM evaluation_case_results WHERE run_id = :id"),
                {"id": run_id},
            )
            evidence_kept = await session.scalar(
                text(
                    "SELECT count(*) FROM evaluation_case_results "
                    "WHERE run_id = :id AND evidence <> '{}'::jsonb"
                ),
                {"id": run_id},
            )
    finally:
        await engines.dispose()

    assert cases == len(result.cases)
    assert evidence_kept and evidence_kept > 0, "the evidence was retained"


async def test_two_runs_are_compared_per_metric(evaluation_settings: Settings) -> None:
    first = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )
    second = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )

    earlier = await persist(evaluation_settings, first)
    later = await persist(evaluation_settings, second)

    comparison = await compare_runs(evaluation_settings, earlier, later)

    assert comparison.earlier_run_id == earlier
    assert comparison.later_run_id == later
    assert not comparison.dataset_versions_differ
    assert comparison.comparable
    assert comparison.changes, "every metric is compared"

    # Two identical runs move nowhere, which is the property that makes a real change legible.
    for change in comparison.changes:
        if change.earlier is not None and change.later is not None:
            assert change.direction == "unchanged", change.describe()


async def test_a_dataset_version_difference_is_flagged(
    evaluation_settings: Settings,
) -> None:
    """The one thing a comparison must not do quietly.

    The stored version is edited directly rather than by shipping two datasets: what is being
    tested is that the *comparison* notices, and that is a property of the comparison.
    """
    first = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )
    second = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category="knowledge"
    )
    earlier = await persist(evaluation_settings, first)
    later = await persist(evaluation_settings, second)

    engines = Engines.create(evaluation_settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("UPDATE evaluation_runs SET dataset_version = :version WHERE id = :id"),
                {"version": "2.0.0", "id": later},
            )
    finally:
        await engines.dispose()

    comparison = await compare_runs(evaluation_settings, earlier, later)

    assert comparison.dataset_versions_differ
    assert not comparison.comparable
    assert comparison.earlier_dataset_version == DATASET_VERSION
    assert comparison.later_dataset_version == "2.0.0"
    assert "different dataset versions" in comparison.summary()
    assert "cannot be attributed" in comparison.summary()


async def test_comparing_an_unknown_run_says_which_one(
    evaluation_settings: Settings,
) -> None:
    import uuid

    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="kn-dew-point"
    )
    stored = await persist(evaluation_settings, result)
    missing = str(uuid.uuid4())

    with pytest.raises(ValueError, match=missing):
        await compare_runs(evaluation_settings, stored, missing)


async def test_a_mode_difference_is_flagged_too(evaluation_settings: Settings) -> None:
    """An offline run and a live run measure different things, and tool selection most of all."""
    first = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="kn-dew-point"
    )
    second = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, case_id="kn-dew-point"
    )
    earlier = await persist(evaluation_settings, first)
    later = await persist(evaluation_settings, second)

    engines = Engines.create(evaluation_settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("UPDATE evaluation_runs SET mode = 'live' WHERE id = :id"), {"id": later}
            )
    finally:
        await engines.dispose()

    comparison = await compare_runs(evaluation_settings, earlier, later)
    assert comparison.modes_differ
    assert not comparison.comparable
    assert "different modes" in comparison.summary()


# =========================================================================== the whole dataset


async def test_the_whole_offline_run_passes_every_threshold(
    evaluation_settings: Settings,
) -> None:
    """The acceptance run, offline. Slow enough to be worth its own test and worth having.

    If this fails, one of two things is true and the report says which: Weathra regressed, or the
    dataset's expectations moved. Either way the failing case identifiers name where to look.
    """
    result = await execute_run(evaluation_settings, mode=EvaluationMode.OFFLINE)

    assert len(result.cases) == len(load_dataset())
    assert result.passed, result.report()

    for name in (
        MetricName.TOOL_SELECTION_ACCURACY,
        MetricName.NUMERICAL_CALCULATION_ACCURACY,
        MetricName.GROUNDEDNESS,
        MetricName.SOURCE_ATTRIBUTION_COVERAGE,
        MetricName.RAG_RETRIEVAL_QUALITY,
        MetricName.MEMORY_CORRECTNESS,
        MetricName.MULTI_TURN_CONTEXTUAL_CORRECTNESS,
        MetricName.BACKEND_SUCCESSFUL_RESPONSE_RATE,
    ):
        assert result.metrics.result(name).applicable, f"{name.value} measured nothing"

    assert result.metrics.result(MetricName.HALLUCINATION_RATE).value == 0.0
    assert result.metrics.latency.overall_median_ms is not None


async def test_the_run_reports_latency_per_category(evaluation_settings: Settings) -> None:
    result = await execute_run(evaluation_settings, mode=EvaluationMode.OFFLINE)
    by_category = result.metrics.latency.by_category

    assert set(by_category) == {category.value for category in Category}
    for values in by_category.values():
        assert values["p95_ms"] >= values["median_ms"]


def test_the_evaluation_fixtures_ship_with_the_package() -> None:
    """So an offline run works from an installed wheel, not only from a source tree."""
    manifest = Path(__file__).resolve().parents[2] / "weathra" / "evaluation" / "fixtures"
    assert (manifest / "manifest.json").exists()

    pyproject = (Path(__file__).resolve().parents[2] / "pyproject.toml").read_text()
    assert "evaluation/fixtures/*.json" in pyproject or "evaluation/fixtures" in pyproject


# =========================================================================== task 22.9
#
# Provider-failure classification, end to end through the real app. Task 22.8's live runs produced
# forty deterministic-fallback answers, scored them as model quality, missed the thresholds, and
# exited 1 — the same exit code a genuinely weak model produces. These assert the whole path.


async def test_an_offline_run_records_every_case_as_model_served(
    evaluation_settings: Settings,
) -> None:
    """CI's gate. The offline client is a real ``LLMClient`` and answers every call, so the new
    integrity check must be invisible to it — a false provider failure here would break the
    pull-request workflow on every run."""
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category=Category.KNOWLEDGE.value
    )

    assert result.metrics.cases_quarantined == ()
    assert result.outcome is RunOutcome.NOT_APPLICABLE
    assert result.provider_failed is False
    assert result.passed is not None, "an offline run still gets a real verdict"
    assert all(record.model_served for record in result.cases)
    assert all(record.inference_attempts for record in result.cases), (
        "every case must record what answered it, offline included"
    )


async def test_offline_attempts_name_the_offline_client_rather_than_a_gateway(
    evaluation_settings: Settings,
) -> None:
    result = await execute_run(
        evaluation_settings, mode=EvaluationMode.OFFLINE, category=Category.KNOWLEDGE.value
    )
    attempts = [a for record in result.cases for a in record.inference_attempts]

    assert attempts, "the run made calls"
    assert {a.status.value for a in attempts} == {"served"}
    assert {a.stage.value for a in attempts} == {"routing", "synthesis"}
    assert all(a.provider == OFFLINE_PROVIDER_ID for a in attempts)


async def test_a_gateway_that_404s_every_call_is_a_provider_failure_not_a_threshold_failure(
    evaluation_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Task 22.8 scenario, reproduced: a withdrawn model answering 404 for every call.

    The run must not say the model performed badly. It must say the model did not answer.
    """
    result = await _run_with_failing_gateway(evaluation_settings, monkeypatch)

    assert result.outcome is RunOutcome.PROVIDER_FAILURE
    assert result.passed is None, "a provider outage produces no quality verdict"
    assert result.thresholds.missed == (), "and names no missed threshold"
    assert "PROVIDER FAILURE" in result.report()
    assert "NOT model-quality metrics" in result.report()


async def test_a_provider_failure_run_persists_with_no_verdict_and_keeps_its_diagnostics(
    evaluation_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``passed`` was always nullable and ``_verdict`` always rendered null as "not scored". The
    honest third answer needed no migration — only somebody to stop collapsing it into "failed"."""
    result = await _run_with_failing_gateway(evaluation_settings, monkeypatch)
    run_id = await persist(evaluation_settings, result)

    engines = Engines.create(evaluation_settings)
    try:
        async with privileged_session(engines.privileged_sessionmaker) as session:
            stored = (
                await session.execute(
                    text("select passed, thresholds from evaluation_runs where id = :id"),
                    {"id": run_id},
                )
            ).one()
    finally:
        await engines.dispose()

    assert stored.passed is None, "not false — the model was never measured"
    integrity = stored.thresholds["integrity"]
    assert integrity["outcome"] == "provider_failure"
    assert integrity["reason"]

    runs = await latest_runs(evaluation_settings, limit=1)
    assert runs[0]["verdict"] == "not scored"


async def test_the_preflight_aborts_before_spending_the_dataset(
    evaluation_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One gateway call, not eighty. This is what should have happened to both historical runs."""
    result = await _run_with_failing_gateway(evaluation_settings, monkeypatch)

    assert result.cases == (), "no case may execute once the pinned model has failed its probe"
    assert result.outcome is RunOutcome.PROVIDER_FAILURE

    # A provider failure is exactly the case that must carry an integrity verdict, so its absence is
    # asserted rather than assumed — and asserting it is also what tells the type checker that the
    # two reads below are reads of a verdict and not of `None`.
    integrity = result.integrity
    assert integrity is not None, "a provider failure must record why the run is not model quality"
    assert "Pre-flight" in (integrity.reason or "")
    assert integrity.attempts_by_status == {"model_unavailable": 1}


async def _run_with_failing_gateway(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> RunResult:
    """A live-mode run whose gateway answers 404, with every other boundary left offline.

    Live mode only so the pinned-model path and the integrity classifier actually run; the token,
    the weather and the corpus stay offline, so this needs no credential and no network.
    """
    import httpx

    from weathra.evaluation import harness as harness_module

    live = settings.model_copy(
        update={
            "openrouter_api_key": SecretStr("test-credential-never-sent-anywhere"),
            "llm_max_retries": 0,
        }
    )

    real_build = harness_module.build_evaluation_app

    def _offline_but_live(
        app_settings: Settings, *, mode: EvaluationMode
    ) -> AbstractAsyncContextManager[PreparedApp]:
        # Provision and transport as offline; classify as live. The seam that lets a provider
        # outage be exercised without a credential or a network.
        return real_build(app_settings, mode=EvaluationMode.OFFLINE)

    async def _always_404(*args: object, **kwargs: object) -> dict[str, object]:
        raise ProviderUnavailable(
            "openrouter rejected the request with status 404.",
            details={"provider": "openrouter", "status": 404, "attempts": 1},
        )

    monkeypatch.setattr(OpenRouterClient, "complete_json", _always_404)
    monkeypatch.setattr(OpenRouterClient, "complete", _always_404)

    async with real_build(live, mode=EvaluationMode.OFFLINE) as prepared:
        # The real gateway client, over the offline transport, in place of the scripted one.
        prepared.app.state.inference.override(
            OpenRouterClient(client=httpx.AsyncClient(), settings=live)
        )
        prepared.mode = EvaluationMode.LIVE
        prepared.llm_provider = "openrouter"
        prepared.llm_model = live.llm_model
        probe = await _preflight(prepared, EvaluationMode.LIVE)
        assert probe is not None
        return _aborted_run(
            live,
            cases=select_cases(category=Category.KNOWLEDGE.value),
            prepared=prepared,
            started=datetime.now(UTC),
            probe=probe,
            category=Category.KNOWLEDGE.value,
            case_id=None,
            mode=EvaluationMode.LIVE,
        )
