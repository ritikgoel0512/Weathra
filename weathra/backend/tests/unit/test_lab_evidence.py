"""The document a comparison persists, and the one thing it must not be.

`lab/promotion.py` reads a persisted criteria document by asking ``criteria.get(name) is False``
for each gating criterion. That is a narrow contract, and the obvious way to satisfy the *schema* —
dumping ``SelectionCriteria`` — breaks it silently: a nested measurement object is not ``False``,
so every candidate would pass every gate and the promotion refusal would never fire again.

So the negative control here is the important test. The positive ones prove the five criteria are
all present and the measurements survive; the negative one proves the shape the gate actually needs
is the shape being written, and would catch a well-meaning simplification back to ``model_dump()``.

No database and no gateway: the criteria are pure functions over recorded outcomes, and the refusal
happens before the session is touched.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.comparison_support import (
    PRIMARY,
    SECONDARY,
    a_comparison,
    an_evidenced_candidate,
)
from weathra.evaluation.criteria import GATING_CRITERIA
from weathra.evaluation.provisioning import EvaluationMode
from weathra.lab.evidence import persist_candidate_evaluations


def test_the_recorded_document_names_all_five_criteria() -> None:
    """34.5 asks for "all five criteria per candidate", so all five are keys of the record."""
    recorded = an_evidenced_candidate(PRIMARY).criteria.recorded()  # type: ignore[union-attr]

    for criterion in (
        "structured_json_reliability",
        "groundedness",
        "latency",
        "planning",
        "cost",
    ):
        assert criterion in recorded, criterion


def test_a_gating_criterion_is_recorded_as_the_verdict_the_gate_reads() -> None:
    failing = an_evidenced_candidate(SECONDARY, grounded=False).criteria
    assert failing is not None
    recorded = failing.recorded()

    # Precisely the predicate `lab/promotion.py::criteria_failures` applies.
    failed = [name for name in GATING_CRITERIA if recorded.get(name) is False]
    assert failed == ["groundedness"]


def test_a_passing_candidate_records_both_gates_as_passed() -> None:
    recorded = an_evidenced_candidate(PRIMARY).criteria.recorded()  # type: ignore[union-attr]

    assert [name for name in GATING_CRITERIA if recorded.get(name) is False] == []
    assert recorded["promotion_blockers"] == []


def test_a_plain_model_dump_would_disable_the_gate() -> None:
    """The negative control, and the reason ``recorded()`` exists at all.

    A candidate that genuinely failed groundedness. Dumped, its gate key holds a measurement
    object, and the gate's ``is False`` finds nothing to refuse — so this asserts the failure mode
    rather than trusting a comment about it.
    """
    failing = an_evidenced_candidate(SECONDARY, grounded=False).criteria
    assert failing is not None
    assert failing.promotion_blockers() == ("groundedness",)

    dumped = failing.model_dump(mode="json")
    assert [name for name in GATING_CRITERIA if dumped.get(name) is False] == []


def test_the_measurements_survive_beside_the_verdicts() -> None:
    """A verdict without its figures would make the record unauditable."""
    recorded = an_evidenced_candidate(PRIMARY).criteria.recorded()  # type: ignore[union-attr]

    measured = recorded["measured"]
    assert measured["structured_json_reliability"]["first_attempt_valid_rate"] == 1.0
    assert measured["groundedness"]["groundedness"] == 1.0
    assert recorded["latency"]["overall_median_ms"] is not None
    assert recorded["cost"]["is_estimate"] is True


async def test_an_offline_comparison_is_refused_as_evidence() -> None:
    """Offline runs the stand-in, so its gates describe the harness. Recording them would let a
    scripted client promote a model."""
    comparison = a_comparison(an_evidenced_candidate(PRIMARY), mode=EvaluationMode.OFFLINE)

    with pytest.raises(ValueError, match="offline"):
        await persist_candidate_evaluations(
            cast(AsyncSession, cast(Any, None)), run_id="unused", comparison=comparison
        )
