"""Task 32.2 and 32.8, completed — the evidence a promotion may cite, actually written.

``record_evaluation`` and ``model_comparison_results.evaluation_id`` both existed and neither had a
writer, so ``model_evaluations`` stayed empty and the promotion gate had nothing to read. These
tests are about that join: does a finished comparison land as rows, do those rows attach to the
right run and the right candidate, and does the gate then see what the comparison measured.

The honesty tests carry as much weight as the positive ones. A candidate that timed out must leave
*no* evaluation row rather than a row of nulls, because a row of nulls is a measurement claim about
a model nobody measured — and it is the kind of row a promotion would later be defended with.

Every comparison here is assembled by ``tests/comparison_support.py`` from recorded outcomes and
scored by the canonical functions. No gateway is reached by any test in this file.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.comparison_support import (
    COMMIT,
    DATASET,
    PRIMARY,
    SECONDARY,
    a_comparison,
    a_failed_candidate,
    an_evidenced_candidate,
    an_unscored_candidate,
)
from tests.db_support import insert_profile, new_user_id
from weathra.db.engine import Engines
from weathra.db.session import privileged_session
from weathra.domain.usage import FailureClass
from weathra.evaluation.criteria import GATING_CRITERIA
from weathra.lab.evidence import NO_CASE_SCORED, record_comparison
from weathra.lab.promotion import criteria_failures
from weathra.lab.records import LabRecords

pytestmark = pytest.mark.db


async def an_administrator(engines: Engines) -> str:
    subject = new_user_id()
    async with privileged_session(engines.privileged_sessionmaker) as session:
        await insert_profile(session, subject)
    return subject


# =========================================================================== A and B


async def test_one_scored_candidate_lands_with_all_five_criteria(
    engines: Engines, clean_database: None
) -> None:
    admin = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

        row = (
            await session.execute(
                text(
                    "SELECT catalog_key, gateway_model, dataset_version, commit_sha, criteria, "
                    "       passed FROM model_evaluations WHERE id = CAST(:id AS uuid)"
                ),
                {"id": evidence.evaluation_ids[PRIMARY]},
            )
        ).one()

    assert row[0] == PRIMARY
    assert row[2] == DATASET
    assert row[3] == COMMIT
    criteria = row[4]
    for criterion in (
        "structured_json_reliability",
        "groundedness",
        "latency",
        "planning",
        "cost",
    ):
        assert criterion in criteria, criterion
    # The mode is in the evidence itself, so a decision read later says what it rested on.
    assert criteria["mode"] == "live"
    assert evidence.status == "completed"


async def test_two_candidates_each_get_their_own_evaluation(
    engines: Engines, clean_database: None
) -> None:
    """Two rows, two distinct identifiers, and each candidate's own measurements in its own row."""
    admin = await an_administrator(engines)
    comparison = a_comparison(
        an_evidenced_candidate(PRIMARY),
        an_evidenced_candidate(SECONDARY, grounded=False),
    )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

        rows = (
            await session.execute(
                text("SELECT catalog_key, criteria FROM model_evaluations ORDER BY catalog_key")
            )
        ).all()

    assert evidence.evidenced_keys == (PRIMARY, SECONDARY)
    assert len({*evidence.evaluation_ids.values()}) == 2
    recorded = {row[0]: row[1] for row in rows}
    assert recorded[PRIMARY]["groundedness"] is True
    # The candidate that failed a criterion is recorded as having failed it — 34.5 asks for the
    # outcome "including any candidate that failed a criterion", which requires the row to exist.
    assert recorded[SECONDARY]["groundedness"] is False
    assert recorded[SECONDARY]["promotion_blockers"] == ["groundedness"]


# =========================================================================== C and E


async def test_a_candidate_that_did_not_complete_gets_no_criteria(
    engines: Engines, clean_database: None
) -> None:
    admin = await an_administrator(engines)
    comparison = a_comparison(
        an_evidenced_candidate(PRIMARY),
        a_failed_candidate(SECONDARY, failure="TimeoutError"),
    )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

        keys = [
            row[0]
            for row in (
                await session.execute(text("SELECT catalog_key FROM model_evaluations"))
            ).all()
        ]
        run = await LabRecords(session).run(evidence.run_id)

    assert keys == [PRIMARY], "the timed-out candidate must leave no evaluation row"
    assert SECONDARY not in evidence.evaluation_ids
    assert evidence.unevidenced[SECONDARY] == "TimeoutError"
    # A comparison in which one of two candidates produced nothing is partial, not completed.
    assert evidence.status == "partial"

    assert run is not None
    failed_cells = [cell for cell in run.results if cell.catalog_key == SECONDARY]
    assert failed_cells, "the failure is still recorded as that candidate's outcome"
    for cell in failed_cells:
        assert cell.succeeded is False
        assert cell.failure_class is FailureClass.UNCLASSIFIED
        assert cell.evaluation_id is None
        assert cell.latency_ms is None
        assert cell.prompt_tokens is None, "an unmeasured token count stays null, never zero"


async def test_a_candidate_that_scored_nothing_is_unevidenced(
    engines: Engines, clean_database: None
) -> None:
    """The pre-flight aborts a run and ``execute_run`` still returns a result. Completed, yes;
    measured, no — and only the second one earns an evaluation row."""
    admin = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY), an_unscored_candidate(SECONDARY))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

    assert evidence.unevidenced[SECONDARY] == NO_CASE_SCORED
    assert SECONDARY not in evidence.evaluation_ids
    assert evidence.status == "partial"


async def test_an_exhausted_budget_is_reported_as_partial(
    engines: Engines, clean_database: None
) -> None:
    admin = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY), budget_exhausted=True)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)
        status = (
            await session.execute(
                text("SELECT status FROM model_comparison_runs WHERE id = CAST(:id AS uuid)"),
                {"id": evidence.run_id},
            )
        ).scalar_one()

    assert status == "partial"


async def test_a_comparison_that_evidenced_nothing_is_failed(
    engines: Engines, clean_database: None
) -> None:
    admin = await an_administrator(engines)
    comparison = a_comparison(a_failed_candidate(PRIMARY), a_failed_candidate(SECONDARY))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

    assert evidence.evaluation_ids == {}
    assert evidence.status == "failed"


# =========================================================================== D


async def test_the_evidence_is_tied_to_its_run_and_its_candidate(
    engines: Engines, clean_database: None
) -> None:
    """The association 34.5 has to cite: run -> cell -> evaluation, per candidate."""
    admin = await an_administrator(engines)
    comparison = a_comparison(
        an_evidenced_candidate(PRIMARY, case_ids=("case-one", "case-two")),
        an_evidenced_candidate(SECONDARY, case_ids=("case-one", "case-two")),
        case_ids=("case-one", "case-two"),
    )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison, initiated_by=admin)

        joined = (
            await session.execute(
                text(
                    "SELECT r.catalog_key, r.case_id, e.catalog_key, e.gateway_model "
                    "  FROM model_comparison_results r "
                    "  JOIN model_evaluations e ON e.id = r.evaluation_id "
                    " WHERE r.run_id = CAST(:run AS uuid) "
                    " ORDER BY r.catalog_key, r.case_id"
                ),
                {"run": evidence.run_id},
            )
        ).all()
        run = await LabRecords(session).run(evidence.run_id)

    # Every cell reaches the evaluation of its own candidate, never another candidate's.
    assert [(row[0], row[1]) for row in joined] == [
        (PRIMARY, "case-one"),
        (PRIMARY, "case-two"),
        (SECONDARY, "case-one"),
        (SECONDARY, "case-two"),
    ]
    for cell_key, _case_id, evaluation_key, _model in joined:
        assert cell_key == evaluation_key

    assert run is not None
    assert run.initiated_by == admin
    assert run.dataset_version == DATASET
    assert run.commit_sha == COMMIT
    # The comparison's own clock, not the moment the rows were written.
    assert run.started_at == comparison.started_at
    assert run.completed_at == comparison.completed_at


async def test_the_initiating_principal_defaults_to_the_run_identity(
    engines: Engines, clean_database: None
) -> None:
    subject = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY), identity_subject=subject)

    async with privileged_session(engines.privileged_sessionmaker) as session:
        evidence = await record_comparison(session, comparison)
        run = await LabRecords(session).run(evidence.run_id)

    assert run is not None
    assert run.initiated_by == subject


async def test_a_comparison_with_no_principal_is_refused() -> None:
    """Provenance is required, so it is never invented."""
    comparison = a_comparison(an_evidenced_candidate(PRIMARY))

    with pytest.raises(ValueError, match="initiated_by"):
        await record_comparison(None, comparison)  # type: ignore[arg-type]


# =========================================================================== F and G


async def test_recording_evidence_touches_no_usage_and_no_plan(
    engines: Engines, clean_database: None
) -> None:
    """Recording is bookkeeping over a finished run: it makes no call, so it spends no allowance.

    Asserted rather than assumed, because the isolation `specs/usage-limits` requires would be lost
    quietly — a consumption row written here would be attributed to somebody's plan.
    """
    admin = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_comparison(session, comparison, initiated_by=admin)

        assert (
            await session.execute(text("SELECT count(*) FROM llm_usage_events"))
        ).scalar_one() == 0
        assert (
            await session.execute(text("SELECT count(*) FROM usage_counters"))
        ).scalar_one() == 0
        # The seeded allowances are untouched: no plan gained or lost entitlement.
        plans = (
            (await session.execute(text("SELECT plan_code FROM subscription_plans ORDER BY rank")))
            .scalars()
            .all()
        )
        assert list(plans) == ["free", "pro", "premium"]


async def test_recording_evidence_promotes_nothing(engines: Engines, clean_database: None) -> None:
    """`specs/model-lab`: promotion is a separate authorized write. Recording is not one."""
    admin = await an_administrator(engines)
    comparison = a_comparison(an_evidenced_candidate(PRIMARY))

    async with privileged_session(engines.privileged_sessionmaker) as session:
        before = (
            await session.execute(
                text(
                    "SELECT policy_id, candidate_catalog_keys FROM model_policies "
                    " ORDER BY policy_id"
                )
            )
        ).all()

        await record_comparison(session, comparison, initiated_by=admin)

        after = (
            await session.execute(
                text(
                    "SELECT policy_id, candidate_catalog_keys FROM model_policies "
                    " ORDER BY policy_id"
                )
            )
        ).all()
        audit = (await session.execute(text("SELECT count(*) FROM admin_audit"))).scalar_one()
        statuses = (
            (await session.execute(text("SELECT DISTINCT status FROM model_catalog")))
            .scalars()
            .all()
        )

    assert after == before, "no policy candidate list moved"
    assert audit == 0, "recording evidence writes no audit row, because it decides nothing"
    assert set(statuses) == {"enabled"}


# =========================================================================== H


async def test_the_promotion_gate_reads_the_persisted_evidence(
    engines: Engines, clean_database: None
) -> None:
    """The join this repair exists for: the gate refuses on what the comparison measured.

    Before it, ``criteria_failures`` had no rows to read and returned nothing for every candidate,
    so a failing model was indistinguishable from an unevaluated one.
    """
    admin = await an_administrator(engines)
    comparison = a_comparison(
        an_evidenced_candidate(PRIMARY),
        an_evidenced_candidate(SECONDARY, grounded=False),
    )

    async with privileged_session(engines.privileged_sessionmaker) as session:
        await record_comparison(session, comparison, initiated_by=admin)
        failures = await criteria_failures(session, [PRIMARY, SECONDARY])

    assert PRIMARY not in failures, "a candidate that passed both gates is not a blocker"
    assert failures[SECONDARY] == ["groundedness"]
    assert set(failures[SECONDARY]) <= set(GATING_CRITERIA)
