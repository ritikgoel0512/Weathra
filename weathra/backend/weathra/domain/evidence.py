"""The evidence record and the response envelope (design.md decision 14).

This is the module that makes grounding structural rather than aspirational. The envelope is
assembled by code; the language model contributes ``answer_prose`` and nothing else. Attribution is
not something a model remembers to include — it is a field the code fills, which is what makes
"source attribution coverage = 100%" a reachable number rather than a hope.

The record is also the audit trail. ``specs/agent-orchestration`` requires it to be sufficient for
a reader to verify every figure and claim in an answer *without re-running the question*, so it
carries the tool calls with their arguments, the tool results, every analytics result with its
method, the knowledge chunks cited, the provider and model, and per-step timings.

Nothing in here may carry credential material or a raw upstream payload — the same rule that
applies to logs and error bodies applies to an evidence record, and it is checked.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from weathra.domain.analytics import AnomalyReport, StatisticResult, TrendReport
from weathra.domain.location import Location
from weathra.domain.weather import DataClass, Period, UncertaintyStatement

__all__ = [
    "AgentName",
    "AgentStep",
    "AnswerEnvelope",
    "Attribution",
    "EvidenceRecord",
    "Finding",
    "GroundingReport",
    "InferenceAttempt",
    "InferenceStage",
    "InferenceStatus",
    "KnowledgeCitation",
    "ResolvedContext",
    "StepStatus",
    "ToolCall",
    "ToolResult",
]


class AgentName(StrEnum):
    """The four specialized agents, plus the two nodes that frame a run.

    Kept as an enum because ``specs/agent-orchestration`` requires each agent's responsibility to
    stay separately identifiable in the execution record, not merged into a free-text label.
    """

    SUPERVISOR = "supervisor"
    FORECAST = "forecast"
    HISTORICAL = "historical"
    ANALYTICS = "analytics"
    RAG = "rag"
    SYNTHESIS = "synthesis"


class StepStatus(StrEnum):
    """How a step ended. ``skipped`` covers a step a budget cut short."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class InferenceStage(StrEnum):
    """Which call a language model was asked to make.

    The *role* rather than the node, so a second node needing a structured decision records
    ``ROUTING`` without a new member. These are the two roles the graph actually has.
    """

    ROUTING = "routing"
    SYNTHESIS = "synthesis"


class InferenceStatus(StrEnum):
    """How one language model call attempt ended.

    The distinction this enum exists to hold is between a model that **answered badly** and a
    model that **did not answer**. ``INVALID_OUTPUT`` is the first: the gateway returned a
    completion and its content failed schema validation, which is a quality result and is scored
    as one. Every other non-served member is the second: no completion came back, so anything the
    run went on to produce was produced without a model.

    Collapsing those two would let a genuinely weak model launder its failures as an outage, and
    would let an outage be reported as a weak model. Task 22.8's live runs were the latter.
    """

    SERVED = "served"
    INVALID_OUTPUT = "invalid_output"
    RATE_LIMITED = "rate_limited"
    MODEL_UNAVAILABLE = "model_unavailable"
    PROVIDER_ERROR = "provider_error"
    TIMEOUT = "timeout"
    NOT_CONFIGURED = "not_configured"

    @property
    def served(self) -> bool:
        """Whether the configured model actually produced a completion.

        ``INVALID_OUTPUT`` counts: the model answered, and being wrong is a quality outcome.
        """
        return self in _SERVED_STATUSES

    @property
    def infrastructure_failure(self) -> bool:
        """Whether this outcome is the provider's doing rather than the model's judgement.

        The predicate a failover rule may read (``specs/model-policy``) and the one the
        evaluation integrity classifier reads. ``NOT_CONFIGURED`` is excluded deliberately: a
        missing or rejected credential is a configuration fault, and retrying or failing over
        would send an operator to a status page when the answer is on their settings screen.
        """
        return self in _INFRASTRUCTURE_STATUSES


_SERVED_STATUSES = frozenset({InferenceStatus.SERVED, InferenceStatus.INVALID_OUTPUT})
_INFRASTRUCTURE_STATUSES = frozenset(
    {
        InferenceStatus.RATE_LIMITED,
        InferenceStatus.MODEL_UNAVAILABLE,
        InferenceStatus.PROVIDER_ERROR,
        InferenceStatus.TIMEOUT,
    }
)


class InferenceAttempt(BaseModel):
    """One language model call attempt, and what became of it.

    **Why this is on the evidence record and not only in a log.** ``specs/agent-orchestration``
    requires the record to be sufficient for a reader to verify every claim in the answer without
    re-running it. "A language model wrote this sentence" is such a claim, and until this type
    existed it was the one claim the record could not support: ``llm_provider`` and ``llm_model``
    are read off the *configured* client, so they name a model whether or not it answered.

    **The policy fields are nullable on purpose.** ``catalog_key``, ``policy_id``, ``plan`` and
    ``resolution_reason`` are filled by the model policy layer when it lands. They are declared
    now so that layer *populates an existing record* rather than introducing a second, parallel
    one that can drift from this one — the same reason the telemetry event of
    ``specs/llm-telemetry`` is a projection of this type rather than a re-derivation.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    stage: InferenceStage
    attempt_number: int = Field(default=1, ge=1, description="1-based, within the stage.")
    status: InferenceStatus
    provider: str | None = None
    selected_model: str | None = Field(
        default=None, description="What was asked for, before the gateway had a say."
    )
    served_model: str | None = Field(
        default=None,
        description=(
            "As the gateway reported it. Differs from ``selected_model`` when a route "
            "substituted one, which is a fact worth seeing rather than smoothing over."
        ),
    )
    catalog_key: str | None = Field(default=None, description="Filled by the model policy layer.")
    policy_id: str | None = Field(default=None, description="Filled by the model policy layer.")
    plan: str | None = Field(default=None, description="Filled by the model policy layer.")
    resolution_reason: str | None = None
    http_status: int | None = Field(
        default=None, description="Present where the failure carried one; a 404 is not a 500."
    )
    error_code: str | None = Field(
        default=None, description="The ``WeathraError`` code, so the existing hierarchy is reused."
    )
    fallback_reason: str | None = Field(
        default=None, description="Why the run continued as it did, in a reader's words."
    )
    latency_ms: float | None = Field(default=None, ge=0.0)

    @property
    def served(self) -> bool:
        return self.status.served


class Attribution(BaseModel):
    """Who supplied a piece of data, for where, for when, and when it was fetched.

    One per source. A forecast-plus-historical answer carries two, because
    ``specs/safety-grounding`` requires each part to carry its own provider, period, and retrieval
    time rather than one blended credit line.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(min_length=1)
    location: Location
    data_class: DataClass
    period: Period | None = Field(
        default=None, description="For a window. Null when the datum is a single instant."
    )
    timestamp_utc: AwareDatetime | None = Field(
        default=None, description="For a single instant, such as current conditions."
    )
    retrieved_at: AwareDatetime

    @model_validator(mode="after")
    def _covers_a_period_or_an_instant(self) -> Self:
        if self.period is None and self.timestamp_utc is None:
            raise ValueError("Attribution must state the period or the timestamp the data covers.")
        return self


class Finding(BaseModel):
    """One structured value the answer rests on, with everything needed to check it.

    Findings are what the UI renders as data, next to but visually distinct from the prose. A
    figure in the prose that has no matching finding is what the numeric audit reports.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str = Field(min_length=1, description="What this figure is, in plain words.")
    value: float | None = Field(
        default=None, description="Null states 'unavailable' — never a filled-in estimate."
    )
    text_value: str | None = Field(
        default=None, description="For a non-numeric finding: a direction sector, a trend."
    )
    unit: str | None = None
    data_class: DataClass
    method: str | None = Field(
        default=None, description="Set for a computed statistic; null for a retrieved reading."
    )
    points_used: int | None = Field(default=None, ge=0)
    attribution: Attribution
    unavailable_reason: str | None = Field(
        default=None, description="Why there is no value. Required when there is none."
    )
    supporting: StatisticResult | None = Field(
        default=None, description="The analytics result this finding was taken from, verbatim."
    )

    @model_validator(mode="after")
    def _absence_is_explained(self) -> Self:
        if self.value is None and self.text_value is None and not self.unavailable_reason:
            raise ValueError(
                f"Finding {self.label!r} carries no value and must state why it is unavailable "
                "rather than reading as an empty result."
            )
        if self.value is not None and self.unavailable_reason:
            raise ValueError("A finding cannot both carry a value and be unavailable.")
        if self.data_class is DataClass.AI_INTERPRETATION:
            raise ValueError(
                "A finding is retrieved or computed data. Model-written content belongs in "
                "answer_prose, which is labelled AI interpretation."
            )
        return self


class ToolCall(BaseModel):
    """A tool invocation as it was actually made."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    sequence: int = Field(ge=1, description="Execution order within the run.")
    tool: str = Field(min_length=1)
    agent: AgentName
    arguments: dict[str, Any] = Field(
        default_factory=dict, description="What was passed. Never a credential."
    )
    started_at: AwareDatetime
    duration_ms: float = Field(ge=0.0)


class ToolResult(BaseModel):
    """What a tool returned, or the coded reason it did not.

    A failure is a failure here: ``specs/mcp-weather-server`` forbids returning a success carrying
    empty or zeroed weather values, and this model cannot express that.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    sequence: int = Field(ge=1, description="Matches the ToolCall it answers.")
    tool: str = Field(min_length=1)
    ok: bool
    data_class: DataClass | None = Field(
        default=None, description="What the result was. Null for an error."
    )
    attribution: Attribution | None = None
    payload: dict[str, Any] | None = Field(
        default=None, description="The normalized result. Never a raw upstream payload."
    )
    error_code: str | None = None
    error_message: str | None = None

    @model_validator(mode="after")
    def _outcome_is_unambiguous(self) -> Self:
        if self.ok and (self.error_code or self.error_message):
            raise ValueError("A successful tool result must not carry an error.")
        if self.ok and self.data_class is None:
            raise ValueError("A successful tool result must state its data class.")
        if not self.ok and not self.error_code:
            raise ValueError("A failed tool result must carry its stable error code.")
        if not self.ok and self.payload:
            raise ValueError(
                "A failed tool result must not carry weather values; an error is never "
                "presented as data."
            )
        return self


class AgentStep(BaseModel):
    """One agent's turn in the run, in order, with what it cost."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    sequence: int = Field(ge=1)
    agent: AgentName
    status: StepStatus
    started_at: AwareDatetime
    duration_ms: float = Field(ge=0.0)
    reason: str | None = Field(
        default=None, description="Why the supervisor selected it, or why it failed or was skipped."
    )


class KnowledgeCitation(BaseModel):
    """A retrieved knowledge chunk the answer drew on."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    document_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    topic: str | None = None
    chunk_position: int = Field(ge=0)
    score: float = Field(description="Relevance score. Only above-threshold chunks are cited.")
    text: str = Field(min_length=1, description="The chunk as retrieved. Data, not instruction.")


class GroundingReport(BaseModel):
    """What the grounding layers found (design.md decision 15).

    Deliberately a *report* rather than a gate for the numeric audit: a false positive — a
    legitimately rounded or unit-converted value — must not destroy a correct answer. So an
    unmatched figure is listed with ``verified: false`` instead of suppressing the response. The
    zero-retrieval case is different and is hard-blocked before this report is built.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    verified: bool = Field(
        description="True when every figure in the prose matched a finding or evidence value."
    )
    method: str = Field(
        min_length=1,
        description="How figures were extracted and matched, including the rounding tolerance.",
    )
    figures_checked: int = Field(ge=0)
    ungrounded_figures: tuple[str, ...] = Field(
        default=(), description="Figures found in the prose that the evidence does not support."
    )
    prose_discarded: bool = Field(
        default=False,
        description="True when the hard zero-retrieval guard fired and the prose was withheld.",
    )
    note: str | None = None

    @model_validator(mode="after")
    def _verified_means_nothing_unmatched(self) -> Self:
        if self.verified and self.ungrounded_figures:
            raise ValueError("A verified grounding report cannot list ungrounded figures.")
        if not self.verified and not (self.ungrounded_figures or self.prose_discarded or self.note):
            raise ValueError(
                "An unverified grounding report must say what was unmatched or why it failed."
            )
        return self


class ResolvedContext(BaseModel):
    """What the run decided the question was actually about.

    ``specs/agent-orchestration`` requires an answer to *state* which location and window it
    resolved to, and where a default came from — so a person can tell "you used my saved default"
    from "you guessed".
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    locations: tuple[Location, ...] = ()
    period: Period | None = None
    unit_system: str | None = None
    criterion: str | None = None
    location_source: Literal["request", "thread", "preferences", "none"] = "request"
    units_source: Literal["request", "thread", "preferences", "default"] = "default"
    statement: str | None = Field(
        default=None, description="The plain sentence shown to the reader."
    )


class EvidenceRecord(BaseModel):
    """Everything the run did, sufficient to check every figure without re-running it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    request_id: str = Field(min_length=1)
    thread_id: str | None = None
    question: str = Field(min_length=1)
    routing_reason: str | None = Field(
        default=None, description="Why the supervisor chose the agents it chose."
    )
    routing_source: Literal["model", "deterministic_fallback"] = "model"
    agents: tuple[AgentStep, ...] = ()
    tool_calls: tuple[ToolCall, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    analytics_results: tuple[StatisticResult, ...] = ()
    anomaly_reports: tuple[AnomalyReport, ...] = ()
    trend_reports: tuple[TrendReport, ...] = ()
    citations: tuple[KnowledgeCitation, ...] = ()
    attributions: tuple[Attribution, ...] = ()
    data_classes: tuple[DataClass, ...] = ()
    llm_provider: str | None = Field(
        default=None,
        description=(
            "The *configured* provider. Null when no inference was configured at all. This is "
            "not evidence that it answered — read ``inference_attempts`` for that."
        ),
    )
    llm_model: str | None = Field(
        default=None, description="The *configured* model, on the same terms as ``llm_provider``."
    )
    inference_attempts: tuple[InferenceAttempt, ...] = Field(
        default=(),
        description=(
            "Every language model call attempt this run made, in order. Empty on a run that "
            "needed no inference."
        ),
    )
    started_at: AwareDatetime
    completed_at: AwareDatetime
    total_duration_ms: float = Field(ge=0.0)
    steps_used: int = Field(default=0, ge=0)
    partial: bool = Field(
        default=False, description="True when a budget was exhausted before a complete answer."
    )
    partial_reason: str | None = None

    @model_validator(mode="after")
    def _record_is_internally_consistent(self) -> Self:
        if self.completed_at < self.started_at:
            raise ValueError("An evidence record cannot complete before it started.")

        call_sequences = [call.sequence for call in self.tool_calls]
        if len(set(call_sequences)) != len(call_sequences):
            raise ValueError("Tool call sequence numbers must be unique within a run.")

        known = set(call_sequences)
        orphans = [result.sequence for result in self.tool_results if result.sequence not in known]
        if orphans:
            raise ValueError(f"Tool results with no matching call: {sorted(orphans)}")

        agent_sequences = [step.sequence for step in self.agents]
        if agent_sequences != sorted(agent_sequences):
            raise ValueError("Agent steps must be recorded in execution order.")

        if self.partial and not self.partial_reason:
            raise ValueError("A partial run must state which bound it hit.")
        return self

    @property
    def model_served(self) -> bool:
        """Whether the configured model materially served this run.

        Every attempt the run made, served. Not "at least one": a run whose routing came from a
        model and whose prose came from ``code_written_summary`` is a run a reader must not be
        told a model wrote. False on a run that made no attempt at all, because a model that was
        never asked did not serve anything.
        """
        return bool(self.inference_attempts) and all(
            attempt.served for attempt in self.inference_attempts
        )

    @property
    def fallback_used(self) -> bool:
        """Whether any part of this run proceeded without the model it asked for."""
        return any(not attempt.served for attempt in self.inference_attempts)

    @property
    def retrieval_happened(self) -> bool:
        """Whether anything was actually retrieved or computed.

        The hard guard in ``agents/grounding.py`` reads this: prose containing a weather figure
        while this is false is discarded outright (design.md decision 15, layer 2).
        """
        return bool(
            [result for result in self.tool_results if result.ok]
            or self.analytics_results
            or self.anomaly_reports
            or self.trend_reports
        )

    @property
    def agents_in_order(self) -> tuple[AgentName, ...]:
        return tuple(step.agent for step in self.agents)


class AnswerEnvelope(BaseModel):
    """The response an answer-bearing endpoint returns.

    The division of labour is the design: ``answer_prose`` is model-written and labelled AI
    interpretation; every figure, label, and attribution in the other fields was placed there by
    code. The model has no authority over the envelope.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    request_id: str = Field(min_length=1)
    thread_id: str | None = None
    answer_prose: str = Field(
        description=(
            "Model-written interpretation of results it did not compute. Empty when the hard "
            "grounding guard withheld it."
        )
    )
    prose_data_class: Literal[DataClass.AI_INTERPRETATION] = DataClass.AI_INTERPRETATION
    findings: tuple[Finding, ...] = ()
    uncertainty: UncertaintyStatement | None = Field(
        default=None, description="Present whenever the answer contains a forecast figure."
    )
    attribution: tuple[Attribution, ...] = ()
    resolved: ResolvedContext | None = None
    grounding: GroundingReport
    evidence: EvidenceRecord
    clarification_question: str | None = Field(
        default=None,
        description="Set instead of an answer when a reference could not be resolved — asked "
        "rather than assumed.",
    )
    unanswered_parts: tuple[str, ...] = Field(
        default=(),
        description="Parts of a multi-part question that could not be answered, named explicitly "
        "rather than silently dropped.",
    )
    llm_provider: str | None = None
    llm_model: str | None = None

    @model_validator(mode="after")
    def _envelope_is_honest(self) -> Self:
        # Prose with nothing behind it is exactly what the zero-retrieval guard exists to prevent.
        # A clarifying question or a citation is a legitimate answer carrying no findings.
        nothing_behind_the_prose = not (
            self.findings or self.evidence.citations or self.clarification_question
        )
        if (
            self.answer_prose.strip()
            and nothing_behind_the_prose
            and self.evidence.retrieval_happened
        ):
            raise ValueError("An answer that retrieved data must carry the findings it rests on.")
        if self.findings and not self.attribution:
            raise ValueError(
                "Every weather-bearing answer states its source provider, location, period, and "
                "retrieval time in structured fields."
            )
        unexplained = not (
            self.grounding.ungrounded_figures
            or self.grounding.prose_discarded
            or self.grounding.note
        )
        if not self.grounding.verified and unexplained:
            raise ValueError("An unverified answer must say what was unverified.")
        return self

    @property
    def has_weather_data(self) -> bool:
        return bool(self.findings)
