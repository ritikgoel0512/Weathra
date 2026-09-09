"""Task 32.2 and 32.8 — what a comparison records, and what makes two of them comparable.

The tables were created in `0007`; what is new is the code that writes and reads them. So these
tests are about the *record* rather than the schema: is it complete, does it link to the telemetry
and the evidence it claims to, does its provenance survive, and can it still be read after the
model it describes has been withdrawn.

That last one is the reason the records exist. "What did this model score before we retired it" is
the question a retirement makes people ask, and a record that vanished with the model would answer
it with silence.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from tests.db_support import insert_profile, new_user_id
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.usage import FailureClass
from weathra.lab.records import RUN_STATUSES, ComparisonResultRecord, LabRecords

pytestmark = pytest.mark.db

CATALOG_STATE = {
    "standard-general": {"gateway_model": "openai/gpt-oss-120b", "status": "enabled"},
    "frontier-reasoning": {"gateway_model": "nvidia/nemotron-3-ultra", "status": "enabled"},
}


async def an_administrator(engines: Engines) -> str:
    subject = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, subject)
    return subject


async def an_agent_run(engines: Engines, user_id: str) -> str:
    run_id = str(uuid.uuid4())
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await session.execute(
            text(
                "INSERT INTO agent_runs (id, user_id, request_id, question, envelope, evidence, "
                "duration_ms) VALUES (CAST(:id AS uuid), CAST(:u AS uuid), 'lab-1', 'q', "
                "'{}'::jsonb, '{}'::jsonb, 1.0)"
            ),
            {"id": run_id, "u": user_id},
        )
    return run_id


# =========================================================================== 32.2 the record


async def test_a_complete_result_record_round_trips(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Every measure `specs/model-lab` names, written and read back as written."""
    admin = await an_administrator(engines)
    agent_run = await an_agent_run(engines, admin)
    event_ids = (str(uuid.uuid4()), str(uuid.uuid4()))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general"],
            catalog_state=CATALOG_STATE,
            question="What is the forecast for Berlin?",
            commit_sha="a" * 40,
        )
        await records.record_result(
            run_id,
            ComparisonResultRecord(
                catalog_key="standard-general",
                gateway_model="openai/gpt-oss-120b",
                case_id="ad-hoc",
                policy_id="__lab_comparison__",
                latency_ms=812.5,
                prompt_tokens=1_200,
                completion_tokens=400,
                total_tokens=1_600,
                estimated_cost=Decimal("0.00012340"),
                succeeded=True,
                usage_event_ids=event_ids,
                agent_run_id=agent_run,
            ),
        )
        await records.close_run(run_id, status="completed")
        written = await records.run(run_id)

    assert written is not None
    assert written.status == "completed"
    assert written.completed_at is not None
    cell = written.results[0]
    assert cell.catalog_key == "standard-general"
    assert cell.gateway_model == "openai/gpt-oss-120b"
    assert cell.latency_ms == 812.5
    assert (cell.prompt_tokens, cell.completion_tokens, cell.total_tokens) == (1_200, 400, 1_600)
    assert cell.estimated_cost == Decimal("0.00012340")
    assert cell.succeeded is True
    assert cell.failure_class is None
    # The links `specs/model-lab` requires: the telemetry it produced, and the run whose evidence
    # record explains the answer.
    assert cell.usage_event_ids == event_ids
    assert cell.agent_run_id == agent_run


async def test_a_failed_cell_records_its_classification_and_no_fabricated_measures(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """A timeout is that candidate's outcome. Its tokens are unknown, and stay null."""
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general"],
            catalog_state=CATALOG_STATE,
            question="Berlin?",
        )
        await records.record_result(
            run_id,
            ComparisonResultRecord(
                catalog_key="standard-general",
                gateway_model="openai/gpt-oss-120b",
                case_id="ad-hoc",
                succeeded=False,
                failure_class=FailureClass.TIMEOUT,
            ),
        )
        written = await records.run(run_id)

    assert written is not None
    cell = written.results[0]
    assert cell.succeeded is False
    assert cell.failure_class is FailureClass.TIMEOUT
    assert cell.total_tokens is None and cell.estimated_cost is None


async def test_run_provenance_states_who_when_what_and_against_which_catalog(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general", "frontier-reasoning"],
            catalog_state=CATALOG_STATE,
            dataset_version="1.0.0",
            commit_sha="b" * 40,
        )
        written = await records.run(run_id)

    assert written is not None
    assert written.initiated_by == admin
    assert written.candidate_catalog_keys == ("standard-general", "frontier-reasoning")
    assert written.dataset_version == "1.0.0"
    assert written.commit_sha == "b" * 40
    assert written.catalog_state == CATALOG_STATE
    assert written.started_at is not None


async def test_a_run_naming_neither_a_dataset_nor_a_question_is_refused(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The table's CHECK refuses it, and so does the writer — before the round trip, where the
    message can name the field rather than the constraint."""
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        with pytest.raises(ValueError, match="dataset version or an ad-hoc question"):
            await LabRecords(session).open_run(
                initiated_by=admin,
                candidate_catalog_keys=["standard-general"],
                catalog_state={},
            )


async def test_a_run_is_recorded_before_any_model_is_called(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """A comparison that crashed halfway must still have left a trace of having happened."""
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        run_id = await LabRecords(session).open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general"],
            catalog_state=CATALOG_STATE,
            question="Berlin?",
        )
        opened = await LabRecords(session).run(run_id)

    assert opened is not None
    assert opened.status == "running"
    assert opened.completed_at is None


async def test_an_unknown_status_is_refused_rather_than_written(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general"],
            catalog_state=CATALOG_STATE,
            question="Berlin?",
        )
        with pytest.raises(ValueError, match="not a comparison status"):
            await records.close_run(run_id, status="finished-ish")
    assert set(RUN_STATUSES) == {"running", "completed", "partial", "failed"}


async def test_results_remain_readable_after_the_model_is_disabled(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/model-lab`: a compared model's results survive its withdrawal, attributed to it.

    The only reason to keep the record at all — a retirement is exactly when somebody asks what
    the model used to score.
    """
    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["frontier-reasoning"],
            catalog_state=CATALOG_STATE,
            question="Berlin?",
        )
        await records.record_result(
            run_id,
            ComparisonResultRecord(
                catalog_key="frontier-reasoning",
                gateway_model="nvidia/nemotron-3-ultra",
                case_id="ad-hoc",
                succeeded=True,
                latency_ms=500.0,
            ),
        )
        await session.execute(
            text("UPDATE model_catalog SET status = 'disabled' WHERE catalog_key = :k"),
            {"k": "frontier-reasoning"},
        )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        after = await LabRecords(session).run(run_id)

    assert after is not None
    assert after.results[0].catalog_key == "frontier-reasoning"
    assert after.results[0].latency_ms == 500.0


async def test_a_compared_model_cannot_be_deleted_out_from_under_its_results(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`ON DELETE RESTRICT`, asserted rather than assumed: without it the record would survive
    the disable and vanish on the delete, which is the worse of the two failures."""
    from sqlalchemy.exc import IntegrityError

    admin = await an_administrator(engines)
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        run_id = await records.open_run(
            initiated_by=admin,
            candidate_catalog_keys=["standard-general"],
            catalog_state=CATALOG_STATE,
            question="Berlin?",
        )
        await records.record_result(
            run_id,
            ComparisonResultRecord(
                catalog_key="standard-general",
                gateway_model="openai/gpt-oss-120b",
                case_id="ad-hoc",
                succeeded=True,
            ),
        )

    with pytest.raises(IntegrityError):
        async with privileged_session(engines.privileged_sessionmaker) as session:
            await session.execute(
                text("DELETE FROM model_catalog WHERE catalog_key = 'standard-general'")
            )


# =========================================================================== 32.8 comparability


async def test_two_models_evaluation_records_are_compared_measure_by_measure(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        first = await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="openai/gpt-oss-120b",
            dataset_version="1.0.0",
            metrics={"groundedness": 0.9, "tool_selection_accuracy": 1.0},
            criteria={"structured_json_reliability": True, "groundedness": True},
            passed=True,
        )
        second = await records.record_evaluation(
            catalog_key="frontier-reasoning",
            gateway_model="nvidia/nemotron-3-ultra",
            dataset_version="1.0.0",
            metrics={"groundedness": 0.75, "tool_selection_accuracy": 1.0},
            criteria={"structured_json_reliability": True, "groundedness": False},
            passed=False,
        )
        compared = await records.compare_evaluations(first, second)

    assert compared["dataset_version_differs"] is False
    assert compared["metrics"]["groundedness"]["difference"] == pytest.approx(-0.15)
    assert compared["metrics"]["tool_selection_accuracy"]["difference"] == 0.0
    assert compared["passed"] == {first: True, second: False}


async def test_a_differing_dataset_version_is_flagged_rather_than_refused(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """`specs/evaluation`: the comparison states that the version differs. Two runs on different
    datasets are still worth looking at; comparing them silently is the failure."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        first = await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="openai/gpt-oss-120b",
            dataset_version="1.0.0",
            metrics={"groundedness": 0.9},
            criteria={},
            passed=True,
        )
        second = await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="openai/gpt-oss-120b",
            dataset_version="1.1.0",
            metrics={"groundedness": 0.95},
            criteria={},
            passed=True,
        )
        compared = await records.compare_evaluations(first, second)

    assert compared["dataset_version_differs"] is True
    assert compared["dataset_versions"] == {first: "1.0.0", second: "1.1.0"}
    assert compared["metrics"]["groundedness"]["difference"] == pytest.approx(0.05)


async def test_a_measure_missing_from_one_side_reports_null_rather_than_a_difference(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """Subtracting from an absence invents a number, and the number would look like a regression."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        first = await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="a/model",
            dataset_version="1.0.0",
            metrics={"groundedness": 0.9, "memory_correctness": 1.0},
            criteria={},
            passed=True,
        )
        second = await records.record_evaluation(
            catalog_key="frontier-reasoning",
            gateway_model="b/model",
            dataset_version="1.0.0",
            metrics={"groundedness": 0.9},
            criteria={},
            passed=True,
        )
        compared = await records.compare_evaluations(first, second)

    assert compared["metrics"]["memory_correctness"]["difference"] is None


async def test_the_latest_evaluation_per_model_is_what_the_catalog_observes(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    """The most recent, not the best. An older passing run does not outrank a newer failing one."""
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="a/model",
            dataset_version="1.0.0",
            metrics={},
            criteria={"groundedness": True},
            passed=True,
        )
        await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="a/model",
            dataset_version="1.0.0",
            metrics={},
            criteria={"groundedness": False},
            passed=False,
        )
        observed = await records.latest_evaluations(["standard-general", "frontier-reasoning"])

    assert set(observed) == {"standard-general"}, "a model nobody evaluated is absent, not null"
    assert observed["standard-general"]["passed"] is False
    assert observed["standard-general"]["criteria"] == {"groundedness": False}


async def test_comparing_an_evaluation_that_does_not_exist_is_refused(
    engines: Engines, clean_database: None, seeded_reference_data: None
) -> None:
    async with privileged_session(engines.privileged_sessionmaker) as session:
        records = LabRecords(session)
        real = await records.record_evaluation(
            catalog_key="standard-general",
            gateway_model="a/model",
            dataset_version="1.0.0",
            metrics={},
            criteria={},
            passed=True,
        )
        with pytest.raises(ValueError, match="No evaluation record"):
            await records.compare_evaluations(real, str(uuid.uuid4()))
