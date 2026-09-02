"""The routing plan: what the model is allowed to decide, and the router for when it cannot.

Design.md decision 2 is the reason this file is shaped the way it is. The model does not emit tool
calls; it proposes *capabilities*. So the plan is a small, closed vocabulary — four capabilities and
their parameters — validated against a pydantic schema before anything executes.

**The closed vocabulary is the tool-catalog guard.** ``Capability`` is an enum, so a plan naming
something outside the catalog fails schema validation, and ``complete_json`` returns that failure
to the model with the valid names in it (``specs/agent-orchestration``: "an error result is
returned to the model rather than anything being executed"). There is no code path from a
model-proposed name to an execution, because a name that is not one of these four cannot be
parsed into a plan at all.

**The fallback router is not a nicety.** The first configured model may be a free-tier one, and a
model that cannot produce valid JSON three times running must not mean the person gets no answer.
So ``fallback_plan`` routes on keywords and dates deterministically — worse routing than a working
model, and enormously better than a failure. The evidence record says which router ran
(``routing_source``), because a reader is owed the difference.

**Scope lives here too.** ``in_scope`` is part of the plan rather than a separate model call: the
same routing decision that says "this is a forecast question" is the one that says "this is not a
weather question at all", and splitting them would be two chances for the model to disagree with
itself. The deterministic router makes the same judgement from the same keywords.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from weathra.domain.comparison import Criterion

__all__ = [
    "OUT_OF_SCOPE_REASON",
    "Capability",
    "PlanStep",
    "RoutingPlan",
    "extract_location",
    "fallback_plan",
    "looks_like_weather",
]

logger = logging.getLogger("weathra.agents.plan")


class Capability(StrEnum):
    """The four capabilities the supervisor may route to, and nothing else.

    A closed enum on purpose: this *is* the catalog as far as the model is concerned, so a proposed
    capability outside it fails validation rather than reaching an executor.
    """

    FORECAST = "forecast"
    HISTORICAL = "historical"
    ANALYTICS = "analytics"
    RAG = "rag"


class PlanStep(BaseModel):
    """One capability to run, with the parameters it needs.

    Every field is optional except the capability and the reason, because the plan is a *routing*
    decision: a step that omits a location is resolved from thread context or preferences by
    ``agents/context.py``, which is where "where did this location come from" is answerable.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    capability: Capability
    reason: str = Field(
        min_length=1, description="Why this capability. Recorded in the evidence record."
    )

    location: str | None = Field(
        default=None, description="As the person said it. Resolved by the geocoder, not here."
    )
    locations: tuple[str, ...] = Field(default=(), description="For a comparison across places.")
    days: int | None = Field(default=None, ge=1, le=16, description="Forecast horizon.")
    start_date: date | None = None
    end_date: date | None = None
    statistics: tuple[str, ...] = Field(
        default=(), description="Statistic names for the analytics capability."
    )
    measure: str | None = Field(default=None, description="Which measure a statistic is over.")
    criterion: Criterion | None = Field(default=None, description="For a comparison.")
    concept: str | None = Field(
        default=None, description="The concept to look up, for the knowledge capability."
    )
    question_part: str | None = Field(
        default=None,
        description="Which part of a multi-part question this step answers, for labelling.",
    )
    uses_previous_result: bool = Field(
        default=False,
        description=(
            "True when this step operates on an earlier step's retrieved series — analytics over "
            "a forecast, for instance. What makes the ordering meaningful rather than incidental."
        ),
    )
    parallel_group: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Steps sharing a group run concurrently. A step with no group runs on its own, in "
            "order. A step that uses a previous result may not share a group with it."
        ),
    )

    @model_validator(mode="after")
    def _dates_are_ordered(self) -> Self:
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("A historical range must not end before it starts.")
        return self

    @property
    def named_locations(self) -> tuple[str, ...]:
        """Every place this step names, whether given singly or as a comparison list."""
        if self.locations:
            return self.locations
        return (self.location,) if self.location else ()


class RoutingPlan(BaseModel):
    """The supervisor's decision: which capabilities, in what order, and why."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    steps: tuple[PlanStep, ...] = Field(
        default=(), description="In execution order. Empty for an out-of-scope question."
    )
    reason: str = Field(min_length=1, description="The routing rationale, in one or two sentences.")
    in_scope: bool = Field(
        default=True,
        description="False for a question that is not about weather, climate, or their concepts.",
    )
    out_of_scope_reason: str | None = Field(
        default=None, description="Required when out of scope: what Weathra does instead."
    )
    unanswerable_parts: tuple[str, ...] = Field(
        default=(),
        description=(
            "Parts of the question no capability can address, named so the answer can say so "
            "rather than quietly dropping them."
        ),
    )

    @model_validator(mode="after")
    def _plan_is_coherent(self) -> Self:
        if not self.in_scope:
            if self.steps:
                raise ValueError("An out-of-scope question routes to no capability.")
            if not self.out_of_scope_reason:
                raise ValueError("An out-of-scope decision must say why.")
        elif not self.steps and not self.unanswerable_parts:
            raise ValueError(
                "An in-scope plan must either route to a capability or name what it cannot answer."
            )

        for index, step in enumerate(self.steps):
            if step.uses_previous_result and index == 0:
                raise ValueError(
                    "The first step cannot use a previous result; there is no previous step."
                )
        return self

    @property
    def capabilities(self) -> tuple[Capability, ...]:
        return tuple(step.capability for step in self.steps)

    @property
    def touches_weather_data(self) -> bool:
        """Whether the plan retrieves or computes anything, as opposed to only explaining."""
        return any(step.capability is not Capability.RAG for step in self.steps)

    def execution_groups(self) -> tuple[tuple[PlanStep, ...], ...]:
        """The steps batched into what can run concurrently, in order.

        A step that uses a previous result always starts a new batch, whatever group the model
        assigned it: a dependency the plan declares and the schedule ignores is not a dependency.
        """
        groups: list[list[PlanStep]] = []
        current_group_id: int | None = None

        for step in self.steps:
            starts_new = (
                not groups
                or step.uses_previous_result
                or step.parallel_group is None
                or step.parallel_group != current_group_id
            )
            if starts_new:
                groups.append([step])
                current_group_id = step.parallel_group
            else:
                groups[-1].append(step)

        return tuple(tuple(group) for group in groups)


# =========================================================================== the fallback router

# Keyword sets, deliberately explicit rather than a model call: this router exists precisely for
# when the model is not usable.
_HISTORICAL_WORDS = frozenset(
    {
        "was",
        "were",
        "last",
        "past",
        "previous",
        "historical",
        "history",
        "yesterday",
        "ago",
        "since",
        "record",
        "records",
        "normal",
        "average",
        "typically",
        "usually",
        "climatology",
        "baseline",
    }
)

_FORECAST_WORDS = frozenset(
    {
        "will",
        "forecast",
        "tomorrow",
        "today",
        "tonight",
        "next",
        "upcoming",
        "coming",
        "outlook",
        "expect",
        "expected",
        "going",
        "weekend",
        "now",
        "currently",
        "current",
    }
)

_ANALYTICS_WORDS = frozenset(
    {
        "average",
        "mean",
        "median",
        "total",
        "sum",
        "max",
        "maximum",
        "min",
        "minimum",
        "percentile",
        "trend",
        "trending",
        "anomaly",
        "anomalous",
        "unusual",
        "variance",
        "spread",
        "range",
        "statistics",
        "compare",
        "comparison",
        "warmest",
        "coolest",
        "driest",
        "wettest",
        "windiest",
    }
)

# Concept questions: "what is", "why does", "explain", "how does ... work".
_CONCEPT_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "mean" has to *end a clause* here. An unanchored "\w+ mean" also matches "what is *the
    # mean* temperature", which is the opposite kind of question — a statistic, not a definition —
    # so the lookahead requires punctuation, an "and", or the end of the question after it.
    re.compile(
        r"\bwhat (?:does|do|is|are) [\w\s'-]{2,40}?\bmeans?\b(?=\s*(?:[?.!,;]|and\b|$))",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:explain|explains|define|definition of|meaning of|difference between)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bwhy (?:is|are|does|do)\b", re.IGNORECASE),
    re.compile(
        r"\bhow (?:is|are|does|do) .{0,40}\b(?:work|works|calculated|measured|computed)\b",
        re.IGNORECASE,
    ),
)

# Words that mean "statistic" in a data question and "signify" in a definition question. Counting
# "mean" as analytics in "what does dew point mean?" would retrieve a week of weather to average.
_AMBIGUOUS_ANALYTICS_WORDS = frozenset({"mean", "average", "range", "normal"})

# Words that put a question inside Weathra's subject at all.
_WEATHER_WORDS = frozenset(
    {
        "weather",
        "temperature",
        "temperatures",
        "rain",
        "rainfall",
        "rainy",
        "precipitation",
        "snow",
        "snowfall",
        "wind",
        "windy",
        "gust",
        "gusts",
        "humidity",
        "humid",
        "pressure",
        "cloud",
        "clouds",
        "cloudy",
        "sunny",
        "sunshine",
        "forecast",
        "climate",
        "storm",
        "hot",
        "cold",
        "warm",
        "cool",
        "dry",
        "wet",
        "freezing",
        "frost",
        "uv",
        "dew",
        "degrees",
        "celsius",
        "fahrenheit",
        "outlook",
        "conditions",
        "meteorological",
        "heatwave",
        "drought",
    }
)

_WORD = re.compile(r"[a-z']+")

# A place after a preposition: "in Berlin", "for Springfield, Illinois", "near New York City".
# Capitalisation is the signal, which is why this is a *fallback* router: it works on ordinary
# written questions and gives up on lowercase ones rather than guessing.
_PLACE_AFTER_PREPOSITION = re.compile(
    r"\b(?:in|for|at|near|around|over)\s+"
    # A capitalised name of up to four words, optionally comma-qualified: "Springfield, Illinois".
    r"([A-Z][\w'-]*(?:[ -][A-Z][\w'-]*){0,3}(?:,\s*[A-Z][\w'-]*(?:[ -][A-Z][\w'-]*){0,2})?)"
)

# Capitalised words that are dates, not places. Without these, "in June" and "for Monday" become
# location lookups that fail and turn into a clarifying question about a place nobody named.
_NOT_A_PLACE = frozenset(
    {
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "today",
        "tomorrow",
        "tonight",
        "yesterday",
        "weathra",
        "celsius",
        "fahrenheit",
        "i",
    }
)

# Trailing words a place name should not end with: "in Berlin tomorrow" is Berlin.
_TRAILING_NOISE = frozenset({"tomorrow", "today", "tonight", "yesterday", "now", "next", "this"})

OUT_OF_SCOPE_REASON = (
    "Weathra answers questions about weather, climate, and the meteorological concepts behind "
    "them. This question is outside that, so Weathra is not the right tool for it."
)


def _words(question: str) -> frozenset[str]:
    return frozenset(_WORD.findall(question.lower()))


def looks_like_weather(question: str) -> bool:
    """Whether a question is plausibly about weather, by vocabulary alone.

    Used by the deterministic router and as a *cross-check* on the model's own scope decision. It
    is intentionally generous: a false "in scope" costs a capability run that finds nothing, while
    a false "out of scope" refuses a question Weathra could have answered.
    """
    return bool(_words(question) & _WEATHER_WORDS) or any(
        pattern.search(question) for pattern in _CONCEPT_PATTERNS
    )


def _looks_conceptual(question: str) -> bool:
    return any(pattern.search(question) for pattern in _CONCEPT_PATTERNS)


def extract_location(question: str) -> str | None:
    """The place a question names, by capitalisation after a preposition, or ``None``.

    Deliberately conservative, and safe *because* the result is resolved through the geocoder: a
    wrong guess becomes ``LocationNotFound`` and a clarifying question, never a confident answer
    about the wrong city. Without this, every question routed by the fallback router would ask
    "which place?" even when the question said so plainly — which is the difference between a
    usable no-credential deployment and a useless one.
    """
    for match in _PLACE_AFTER_PREPOSITION.finditer(question):
        candidate = _trim_place(match.group(1))
        if candidate:
            return candidate
    return None


def _trim_place(candidate: str) -> str | None:
    """Strip trailing temporal words, then reject anything that is only a date or a stop word."""
    parts = candidate.strip().rstrip(".,?!").split()
    while parts and parts[-1].lower().strip(",") in _TRAILING_NOISE:
        parts.pop()
    if not parts:
        return None

    cleaned = " ".join(parts)
    words = {part.lower().strip(",") for part in parts}
    if words <= _NOT_A_PLACE:
        return None
    return cleaned


def fallback_plan(question: str, *, now: datetime | None = None) -> RoutingPlan:
    """A plan derived from keywords and dates, for when the model cannot produce one.

    Worse routing than a working model, and enormously better than no answer. The evidence record
    marks a run that came through here as ``deterministic_fallback`` so a reader knows.
    """
    moment = now or datetime.now(tz=None)
    words = _words(question)

    if not looks_like_weather(question):
        return RoutingPlan(
            steps=(),
            reason="The deterministic router found no weather vocabulary in the question.",
            in_scope=False,
            out_of_scope_reason=OUT_OF_SCOPE_REASON,
        )

    place = extract_location(question)
    conceptual = _looks_conceptual(question)
    historical = bool(words & _HISTORICAL_WORDS)
    forecast = bool(words & _FORECAST_WORDS)
    analytics_words = words & _ANALYTICS_WORDS
    if conceptual:
        analytics_words -= _AMBIGUOUS_ANALYTICS_WORDS
    analytics = bool(analytics_words)

    steps: list[PlanStep] = []

    if conceptual:
        steps.append(
            PlanStep(
                capability=Capability.RAG,
                reason="The deterministic router matched a concept-question pattern.",
                concept=question,
            )
        )

    # A question with no tense marker is about now, which is a forecast-window question. Defaulting
    # to the archive instead would answer a "what is it like?" with last week. A purely conceptual
    # question retrieves nothing: "what does dew point mean?" is answered from the knowledge base.
    wants_data = not conceptual or historical or forecast or analytics
    if wants_data:
        if historical and not forecast:
            end = (moment.date() if moment else date.today()) - timedelta(days=1)
            steps.append(
                PlanStep(
                    capability=Capability.HISTORICAL,
                    reason="The deterministic router matched past-tense or historical vocabulary.",
                    location=place,
                    start_date=end - timedelta(days=6),
                    end_date=end,
                )
            )
        else:
            steps.append(
                PlanStep(
                    capability=Capability.FORECAST,
                    location=place,
                    reason=(
                        "The deterministic router matched forward-looking vocabulary."
                        if forecast
                        else "The deterministic router found no tense marker and defaulted to the "
                        "current window."
                    ),
                )
            )

        if analytics:
            steps.append(
                PlanStep(
                    capability=Capability.ANALYTICS,
                    reason="The deterministic router matched statistical vocabulary.",
                    uses_previous_result=True,
                )
            )

    if not steps:  # pragma: no cover - `wants_data` guarantees at least one
        steps.append(
            PlanStep(
                capability=Capability.FORECAST,
                reason="The deterministic router had nothing more specific to go on.",
            )
        )

    logger.info("deterministic router chose %s", ", ".join(step.capability.value for step in steps))
    return RoutingPlan(
        steps=tuple(steps),
        reason=(
            "The model could not produce a valid routing plan, so Weathra routed this "
            "deterministically from the question's vocabulary."
        ),
    )
