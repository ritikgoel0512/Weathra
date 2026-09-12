"""The graph's state: everything one run carries, and the one field a caller may never set.

**Identity is not an input.** ``user_id`` comes from the validated token, through ``Principal``,
and the only way to build a state is ``GraphState.begin(principal=...)``. There is no code path
that takes a user id as a string from anywhere else. That is design.md decision 4 made structural:
two identity paths mean two authorization paths and a standing risk that a node reads the wrong
one. The ``thread_key`` is composed from the same principal, so state and checkpoint cannot end up
scoped to different people.

**A pydantic model rather than a TypedDict.** LangGraph accepts either. A model gives the run's
state validation on every node return and serialization for the checkpointer, and it lets
``user_id`` carry a validator that refuses to be empty — which a TypedDict cannot.

**Accumulating fields are appended, never replaced.** A run's tool calls, agent steps, findings
and citations grow as nodes execute; the ``with_*`` helpers return a new state with one more of
something. Nodes therefore never mutate shared state, which is what makes the parallel execution
groups in ``agents/plan.py`` safe to run concurrently.

**Structured results are per capability.** ``retrievals`` holds what the forecast and historical
nodes fetched, keyed so the analytics node can find the series it is meant to compute over rather
than guessing at the most recent one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator

from weathra.agents.plan import Capability, RoutingPlan
from weathra.domain.evidence import (
    AgentStep,
    Attribution,
    Finding,
    InferenceAttempt,
    KnowledgeCitation,
    ToolCall,
    ToolResult,
)
from weathra.domain.identity import Principal
from weathra.domain.location import Location
from weathra.domain.satellite import SatelliteObservation
from weathra.domain.weather import DataClass, Period, Series, UnitSystem

__all__ = ["GraphState", "Retrieval"]


class Retrieval(BaseModel):
    """One capability's structured result, as the next capability needs it.

    Carries the *series* rather than a rendered summary so the analytics node computes over the
    same numbers the forecast node retrieved — no re-fetch, no re-parse, and no chance of the two
    disagreeing about what the data was.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    capability: Capability
    location: Location
    period: Period | None = None
    data_class: DataClass
    unit_system: UnitSystem
    provider: str = Field(min_length=1)
    retrieved_at: datetime
    daily: Series | None = None
    hourly: Series | None = None
    payload: dict[str, Any] = Field(
        default_factory=dict, description="The tool's normalized result, for the evidence record."
    )
    attribution: Attribution
    question_part: str | None = None

    @property
    def series(self) -> Series | None:
        """The series analytics should compute over: daily where there is one."""
        return self.daily or self.hourly


class GraphState(BaseModel):
    """One agent run, from the question to the envelope.

    Every field a node writes is here; nothing is passed sideways. A run that is resumed from a
    checkpoint is this object, revalidated.
    """

    model_config = ConfigDict(extra="forbid")

    # ---------------------------------------------------------------- the request

    question: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    user_id: str = Field(
        min_length=1,
        description=(
            "The acting user's authentication subject. Set only from a validated Principal by "
            "``begin``; never accepted from a request body, header, or parameter."
        ),
    )
    thread_id: str | None = None
    thread_key: str | None = Field(
        default=None,
        description="The composed ``{user_id}:{thread_id}`` checkpointer key, when threaded.",
    )
    requested_unit_system: UnitSystem | None = Field(
        default=None, description="What the request asked for. Null means 'apply the default'."
    )
    focus: Location | None = Field(
        default=None,
        description=(
            "The place this conversation is pointed at, chosen deliberately by the caller and "
            "already resolved. Null when the caller pointed it nowhere."
        ),
    )
    started_at: datetime

    # ---------------------------------------------------------------- routing

    plan: RoutingPlan | None = None
    routing_source: str = Field(default="model", pattern="^(model|deterministic_fallback)$")
    routing_attempts: int = Field(default=0, ge=0)

    # ---------------------------------------------------------------- inference provenance

    inference_attempts: tuple[InferenceAttempt, ...] = Field(
        default=(),
        description=(
            "Every language model call attempt, in order, whatever became of it. What makes "
            "'did a model write this answer' a question the evidence record can answer."
        ),
    )

    # ---------------------------------------------------------------- resolved context

    locations: tuple[Location, ...] = ()
    period: Period | None = None
    unit_system: UnitSystem = UnitSystem.METRIC
    location_source: str = Field(
        default="request", pattern="^(request|focus|thread|preferences|none)$"
    )
    units_source: str = Field(default="default", pattern="^(request|thread|preferences|default)$")
    context_statement: str | None = None
    clarification_question: str | None = None

    # ---------------------------------------------------------------- results

    retrievals: tuple[Retrieval, ...] = ()
    findings: tuple[Finding, ...] = ()
    satellite_observations: tuple[SatelliteObservation, ...] = ()
    citations: tuple[KnowledgeCitation, ...] = ()
    attributions: tuple[Attribution, ...] = ()
    data_classes: tuple[DataClass, ...] = ()

    # ---------------------------------------------------------------- the record

    agent_steps: tuple[AgentStep, ...] = ()
    tool_calls: tuple[ToolCall, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    analytics_payloads: tuple[dict[str, Any], ...] = Field(
        default=(), description="Statistic, anomaly, and trend results, tagged by kind."
    )

    # ---------------------------------------------------------------- synthesis and bounds

    answer_prose: str = ""
    unanswered_parts: tuple[str, ...] = ()
    steps_used: int = Field(default=0, ge=0)
    partial: bool = False
    partial_reason: str | None = None
    failures: tuple[str, ...] = Field(
        default=(), description="Human-readable reasons a step could not complete."
    )

    @field_validator("user_id")
    @classmethod
    def _identity_is_present(cls, value: str) -> str:
        """An identity with no subject is not an identity, and every owned write is scoped by it."""
        if not value.strip():
            raise ValueError("A graph run must carry the acting user's authentication subject.")
        return value.strip()

    # ---------------------------------------------------------------- construction

    @classmethod
    def begin(
        cls,
        *,
        question: str,
        request_id: str,
        principal: Principal,
        thread_id: str | None = None,
        requested_unit_system: UnitSystem | None = None,
        focus: Location | None = None,
        started_at: datetime | None = None,
    ) -> Self:
        """Start a run for one authenticated principal.

        The *only* constructor the request path uses. Taking a ``Principal`` rather than a user id
        means there is no signature here into which a caller-supplied identifier would fit, and the
        thread key is composed from the same subject so state and checkpoint always agree.
        """
        return cls(
            question=question,
            request_id=request_id,
            user_id=principal.user_id,
            thread_id=thread_id,
            thread_key=principal.thread_key(thread_id) if thread_id else None,
            requested_unit_system=requested_unit_system,
            focus=focus,
            started_at=started_at or datetime.now(UTC),
        )

    # ---------------------------------------------------------------- accumulation

    def with_updates(self, **values: Any) -> Self:
        """A copy with the named fields replaced. Nodes return these rather than mutating."""
        return self.model_copy(update=values)

    def with_step(self, step: AgentStep) -> Self:
        return self.model_copy(
            update={"agent_steps": (*self.agent_steps, step), "steps_used": self.steps_used + 1}
        )

    def with_tool_exchange(self, call: ToolCall, result: ToolResult) -> Self:
        return self.model_copy(
            update={
                "tool_calls": (*self.tool_calls, call),
                "tool_results": (*self.tool_results, result),
            }
        )

    def with_retrieval(self, retrieval: Retrieval) -> Self:
        """Record a capability's structured result, its attribution, and its data class."""
        return self.model_copy(
            update={
                "retrievals": (*self.retrievals, retrieval),
                "attributions": _appended(self.attributions, retrieval.attribution),
                "data_classes": _appended(self.data_classes, retrieval.data_class),
            }
        )

    def with_findings(self, findings: tuple[Finding, ...]) -> Self:
        classes = self.data_classes
        for finding in findings:
            classes = _appended(classes, finding.data_class)
        return self.model_copy(
            update={"findings": (*self.findings, *findings), "data_classes": classes}
        )

    def with_satellite(self, observation: SatelliteObservation) -> Self:
        """Record one retrieved satellite observation, and the class it belongs to."""
        classes = self.data_classes
        if DataClass.SATELLITE_OBSERVATION not in classes:
            classes = (*classes, DataClass.SATELLITE_OBSERVATION)
        return self.model_copy(
            update={
                "satellite_observations": (*self.satellite_observations, observation),
                "data_classes": classes,
            }
        )

    def with_citations(self, citations: tuple[KnowledgeCitation, ...]) -> Self:
        return self.model_copy(update={"citations": (*self.citations, *citations)})

    def with_analytics(self, kind: str, payload: dict[str, Any]) -> Self:
        return self.model_copy(
            update={"analytics_payloads": (*self.analytics_payloads, {"kind": kind, **payload})}
        )

    def with_failure(self, reason: str) -> Self:
        return self.model_copy(update={"failures": (*self.failures, reason)})

    def with_inference_attempt(self, attempt: InferenceAttempt) -> Self:
        """Append one call attempt. Every attempt, including every failed one.

        Appended rather than replaced: a run makes one attempt per stage today, and the failover
        of ``specs/model-policy`` will make several. A field holding "the last attempt" would
        quietly lose the earlier failures that explain the run.
        """
        return self.model_copy(update={"inference_attempts": (*self.inference_attempts, attempt)})

    # ---------------------------------------------------------------- reading

    @property
    def next_sequence(self) -> int:
        """The next tool-call sequence number. One-based, matching the evidence record."""
        return len(self.tool_calls) + 1

    @property
    def next_step_sequence(self) -> int:
        return len(self.agent_steps) + 1

    @property
    def retrieval_happened(self) -> bool:
        """Whether anything was retrieved or computed — what the hard grounding guard reads."""
        return bool(
            [result for result in self.tool_results if result.ok] or self.analytics_payloads
        )

    def retrieval_for(self, capability: Capability) -> Retrieval | None:
        """The most recent result from one capability, for a step that builds on it."""
        for retrieval in reversed(self.retrievals):
            if retrieval.capability is capability:
                return retrieval
        return None

    @property
    def latest_series_retrieval(self) -> Retrieval | None:
        """The most recent retrieval carrying a series, for analytics over a prior step."""
        for retrieval in reversed(self.retrievals):
            if retrieval.series is not None:
                return retrieval
        return None

    @property
    def primary_location(self) -> Location | None:
        return self.locations[0] if self.locations else None


def _appended[Item](existing: tuple[Item, ...], candidate: Item) -> tuple[Item, ...]:
    """Append unless it is already there, so a two-provider answer does not list one twice."""
    return existing if candidate in existing else (*existing, candidate)
