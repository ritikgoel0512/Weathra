"""The evaluation case format, and loading the dataset from data files.

``specs/evaluation`` requires the dataset to be *structured data in the repository, not literals
inside test code*, and the reason is worth being explicit about: a dataset embedded in a test file
is a dataset only the person who wrote that test can extend, and it cannot be versioned, diffed, or
reviewed as the artifact it is. So the cases live in ``evaluation/dataset/*.json`` and this module
is the schema they are validated against.

**Every case declares its own expectations.** Identifier, category, question or turn sequence,
expected tools or agents, forbidden tools, expected answer characteristics, and — where the case
asserts a number — the reference value or the deterministic computation that produces it. The model
forbids extra fields and requires the ones the spec names, so a case that half-declares what it
expects fails to load rather than scoring as a pass.

**Reference values are computed, not written down.** A case asserting "the mean is 11.9" would be
asserting a number somebody typed. Instead a numeric case declares *how* to compute its reference —
a statistic over a measure, over a named fixture window — and the runner computes it over the same
fixture data the answer came from. That is what makes numerical accuracy a real measurement rather
than a match against a hard-coded expectation that drifts when a fixture is re-recorded.

**Multi-turn cases declare per-turn resolution.** What each turn's references are expected to
resolve to — which locations, which units, which window, which criterion — because "the follow-up
worked" is not checkable and "the follow-up resolved to Berlin and Munich in metric over 3 days" is.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

__all__ = [
    "DATASET_DIRECTORY",
    "DATASET_VERSION",
    "REQUIRED_CATEGORIES",
    "Category",
    "EvaluationCase",
    "ExpectedResolution",
    "ReferenceComputation",
    "Turn",
    "load_dataset",
]

DATASET_DIRECTORY = Path(__file__).parent / "dataset"

# The dataset's own version, bumped when a case is added, removed, or its expectations change.
# Recorded on every run, so a cross-run comparison can flag that the two ran different datasets
# rather than reporting a metric change that is really a dataset change.
DATASET_VERSION = "1.0.0"


class Category(StrEnum):
    """The six categories ``specs/evaluation`` requires, and no others.

    A closed set: a case in a seventh category would not be covered by the composition requirement
    and would silently dilute every rate it appeared in.
    """

    CURRENT_AND_FORECAST = "current_and_forecast"
    HISTORICAL = "historical"
    COMPARISON = "comparison"
    ANALYTICS = "analytics"
    KNOWLEDGE = "knowledge"
    MEMORY = "memory"


REQUIRED_CATEGORIES: tuple[Category, ...] = tuple(Category)

# The minimum per category, from the spec. Asserted by the composition test.
MINIMUM_PER_CATEGORY = 4


class ExpectedResolution(BaseModel):
    """What one turn's references are expected to resolve to.

    Every field optional, because a turn may establish some things and inherit others — which is
    exactly what a follow-up *is*. A field that is set is checked; one that is not is not asserted.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    locations: tuple[str, ...] = Field(
        default=(), description="Display names, in the order the answer should resolve them."
    )
    unit_system: str | None = None
    window_days: int | None = Field(default=None, ge=1)
    criterion: str | None = None
    location_source: str | None = Field(
        default=None,
        description="'request', 'thread', 'preferences', or 'none' — where it should come from.",
    )
    units_source: str | None = None


class Turn(BaseModel):
    """One question in a sequence, and what it should resolve to."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    question: str = Field(min_length=1)
    expected_resolution: ExpectedResolution | None = Field(
        default=None,
        description="Required on a multi-turn case: what this turn's references resolve to.",
    )
    expected_tools: tuple[str, ...] = ()
    expected_answer_characteristics: tuple[str, ...] = Field(
        default=(),
        description="Substrings or figures the answer should carry. Checked case-insensitively.",
    )
    expects_clarification: bool = Field(
        default=False,
        description="True when the honest outcome is a question rather than an answer.",
    )
    units: str | None = Field(
        default=None,
        description=(
            "The unit system this turn asks in. Declared per turn because a units case is about "
            "one turn choosing and the next inheriting, and a case-level value could not say that."
        ),
    )


class ReferenceComputation(BaseModel):
    """How to compute a case's reference value, rather than what somebody typed it was.

    The runner computes this over the *same* fixture data the answer was produced from, which is
    what makes numerical accuracy a measurement. A hard-coded expectation would have to be edited
    every time a fixture was re-recorded, and the edit would look like a passing test.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    statistic: str = Field(
        min_length=1, description="'mean', 'minimum', 'maximum', 'range', 'total', 'count'."
    )
    measure: str = Field(min_length=1, description="Which measure to compute over.")
    tolerance: float = Field(
        default=1e-6,
        ge=0.0,
        description=(
            "Relative tolerance. 1e-6 for floating-point values per the spec; a case asserting an "
            "integer or a count sets 0 for an exact match."
        ),
    )
    exact: bool = Field(
        default=False, description="True for integers and counts, which must match exactly."
    )


class EvaluationCase(BaseModel):
    """One case, declaring everything needed to score it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    case_id: str = Field(min_length=1, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    category: Category
    description: str = Field(
        min_length=1, description="What this case is testing, for a person reading a failure."
    )

    question: str | None = Field(
        default=None, description="For a single-turn case. Mutually exclusive with `turns`."
    )
    turns: tuple[Turn, ...] = Field(default=(), description="For a multi-turn case, in order.")

    expected_tools: tuple[str, ...] = Field(
        default=(), description="Every one of these must be called at least once."
    )
    expected_agents: tuple[str, ...] = Field(
        default=(), description="Every one of these must appear in the run's agent sequence."
    )
    forbidden_tools: tuple[str, ...] = Field(
        default=(), description="None of these may be called. A conceptual case forbids them all."
    )
    expected_answer_characteristics: tuple[str, ...] = Field(
        default=(), description="Substrings the answer should carry, checked case-insensitively."
    )
    forbidden_answer_characteristics: tuple[str, ...] = Field(
        default=(),
        description="Substrings the answer must NOT carry — a severity claim, a fabricated figure.",
    )

    reference: ReferenceComputation | None = Field(
        default=None, description="Set when the case asserts a number."
    )
    relevant_documents: tuple[str, ...] = Field(
        default=(), description="For a conceptual case: which corpus documents are relevant."
    )
    expected_resolution: ExpectedResolution | None = Field(
        default=None, description="For a single-turn case that asserts what it resolved to."
    )

    expects_clarification: bool = Field(
        default=False, description="True when the honest outcome is a question, not an answer."
    )
    expects_refusal: bool = Field(
        default=False, description="True when the honest outcome is a stated refusal."
    )
    units: str | None = Field(default=None, description="The unit system to ask in, if it matters.")
    preferences: dict[str, str] = Field(
        default_factory=dict,
        description="Preferences to set for the test user before this case runs.",
    )

    @model_validator(mode="after")
    def _declares_one_shape_of_question(self) -> Self:
        if self.question and self.turns:
            raise ValueError(
                f"Case {self.case_id!r} declares both a question and a turn sequence; a case is "
                "one or the other."
            )
        if not self.question and not self.turns:
            raise ValueError(f"Case {self.case_id!r} declares no question.")
        return self

    @model_validator(mode="after")
    def _multi_turn_cases_declare_per_turn_resolution(self) -> Self:
        """``specs/evaluation``: a multi-turn case declares what each turn resolves to.

        Enforced at load time rather than checked in the runner: a memory case that forgot to say
        what it expected would otherwise pass memory correctness by having nothing to compare.
        """
        if len(self.turns) > 1:
            missing = [
                index
                for index, turn in enumerate(self.turns, start=1)
                if turn.expected_resolution is None and not turn.expects_clarification
            ]
            if missing:
                raise ValueError(
                    f"Case {self.case_id!r} is multi-turn but turns {missing} declare no expected "
                    "resolution. A memory case with nothing to compare would pass vacuously."
                )
        return self

    @model_validator(mode="after")
    def _a_knowledge_case_names_its_relevant_documents(self) -> Self:
        if self.category is Category.KNOWLEDGE and not (
            self.relevant_documents or self.expects_refusal
        ):
            raise ValueError(
                f"Case {self.case_id!r} is a knowledge case but names no relevant document, so "
                "retrieval quality could not be scored for it."
            )
        return self

    # ---------------------------------------------------------------- reading

    @property
    def is_multi_turn(self) -> bool:
        return len(self.turns) > 1

    @property
    def questions(self) -> tuple[str, ...]:
        """Every question this case asks, in order."""
        if self.question:
            return (self.question,)
        return tuple(turn.question for turn in self.turns)

    @property
    def asserts_a_number(self) -> bool:
        return self.reference is not None

    @property
    def expects_weather_data(self) -> bool:
        """Whether the answer should carry weather figures, and so needs full attribution."""
        return self.category is not Category.KNOWLEDGE or bool(self.expected_tools)


def _case_files() -> Iterator[Path]:
    return iter(sorted(DATASET_DIRECTORY.glob("*.json")))


@lru_cache(maxsize=1)
def load_dataset() -> tuple[EvaluationCase, ...]:
    """Every case, validated, in a stable order.

    Cached because the runner, the metrics, and several tests all read it, and it is immutable
    data. Sorted by identifier so a run's case order does not depend on the filesystem.
    """
    cases: list[EvaluationCase] = []
    seen: set[str] = set()

    for path in _case_files():
        payload = json.loads(path.read_text())
        entries = payload if isinstance(payload, list) else payload.get("cases", [])

        for entry in entries:
            case = EvaluationCase.model_validate(entry)
            if case.case_id in seen:
                raise ValueError(
                    f"Duplicate case identifier {case.case_id!r} in {path.name}. Identifiers are "
                    "how a failing case is named in a report, so they must be unique."
                )
            seen.add(case.case_id)
            cases.append(case)

    if not cases:  # pragma: no cover - the dataset ships with the package
        raise ValueError(f"No evaluation cases found under {DATASET_DIRECTORY}.")

    return tuple(sorted(cases, key=lambda case: case.case_id))


def cases_in(category: Category) -> tuple[EvaluationCase, ...]:
    return tuple(case for case in load_dataset() if case.category is category)


def composition() -> dict[Category, int]:
    """How many cases each category has. Read by the composition test and the run report."""
    counts = dict.fromkeys(Category, 0)
    for case in load_dataset():
        counts[case.category] += 1
    return counts
