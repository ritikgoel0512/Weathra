"""The shapes a model comparison produces, and nothing that produces them.

**Why this module exists at all.** ``lab/`` may import the *pure* half of ``evaluation/`` and not
the half that boots an application — `tests/test_architecture.py` states the rule and names the
reason: a lab run happens inside a request, and a request that started a second Weathra would be a
failure that looks entirely reasonable in a diff. These record types are shared by both halves.
``model_compare.py`` builds them and ``lab/evidence.py`` persists them, so leaving them beside the
engine forced the request-path module to import the engine to read its own data.

So the data lives here and the engine stays where it was. There is no app, no network, no database
and no I/O of any kind below this line — the deepest thing it reaches is ``criteria.py``, which is
scoring over recorded numbers. That is what makes it importable from ``lab/``, and the property is
worth keeping: anything added here that opens a connection or builds an application belongs in
``runner.py`` or ``harness.py`` instead, and moving it here would quietly re-open the boundary this
module was split out to close.

``domain/`` would be the usual home for shared record shapes and is the wrong one here: it is layer
zero and may import nothing, while ``CandidateOutcome`` carries a ``SelectionCriteria``. Moving
that too would mean moving the scoring framework into the domain layer to satisfy a lint rule,
which is the tail wagging the dog.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from weathra.evaluation.criteria import SelectionCriteria

__all__ = [
    "CandidateCase",
    "CandidateOutcome",
    "EvaluationMode",
    "ModelComparison",
    "PinnedConfiguration",
]


class EvaluationMode(StrEnum):
    """Where a run gets its weather, its inference, and its tokens.

    Lives here rather than in ``provisioning.py`` for the same reason as everything else in this
    module: it is a two-value enum that decides what a record *means* — an offline comparison's
    reliability figure measures the harness, not a model — and the module that provisions a
    Supabase user is not somewhere a request-path module can follow it to.
    """

    OFFLINE = "offline"
    LIVE = "live"


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
