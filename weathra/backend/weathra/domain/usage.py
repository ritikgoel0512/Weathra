"""What a language model call cost, and what a plan allows (decisions 24, 25 and 27).

Two vocabularies that have to agree, so they live together: the per-call record
(``specs/llm-telemetry``) and the allowance dimensions counted from it (``specs/usage-limits``).
Keeping them in one module is what makes "consumption is reconcilable with the recorded events" a
property a reader can check by looking, rather than a claim about two files that drifted.

**A usage event holds metadata and never content.** No prompt, no completion, no retrieved
passage. That is not a field this module happens to omit — it is the reason the table can be
aggregated across users for an administrative screen without an isolation argument, because a
table with no content in it cannot leak content. Diagnosis goes through ``agent_run_id`` to the
evidence record, which has its own ownership and its own retention.

**Null is a measurement, zero is a claim.** Where the gateway reported no token counts, the token
fields and the estimated cost are ``None``. Recording them as ``0`` would assert that a call cost
nothing, which is a different and false statement; ``specs/llm-telemetry`` requires the
distinction, and the validators below enforce it rather than trusting each writer to remember.

The validators are the honest part of this module. A usage event is written on a background task
outside the answer path (decision 24), which means a malformed one is discovered — if the type does
not refuse it — as a confusing aggregate weeks later rather than as a failure at the call site.
"""

from __future__ import annotations

from datetime import date, datetime, tzinfo
from decimal import Decimal
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, GetCoreSchemaHandler, model_validator
from pydantic_core import core_schema

from weathra.domain.entitlements import CallRole, PlanCode, PolicyId

__all__ = [
    "INTERNAL_SUBJECT",
    "FailureClass",
    "QuotaDimension",
    "QuotaWindow",
    "SubjectKind",
    "UsageEvent",
    "UsageStatus",
    "WindowKey",
]


class SubjectKind(StrEnum):
    """Whose allowance a call is accounted against.

    Not the same question as "was there a principal". An administrator asking a product question as
    themselves has a perfectly good ``user_id`` and is still ``INTERNAL``, because
    ``specs/usage-limits`` accounts administrative, lab and evaluation traffic against the internal
    allowance rather than a product plan.
    """

    USER = "user"
    INTERNAL = "internal"


# The reserved subject internal traffic is counted against (design.md decision 25). Deliberately
# not UUID-shaped: every real subject is a Supabase auth UUID, so this can never collide with one,
# and a Row Level Security policy comparing a subject against the acting user's id therefore denies
# these rows to every caller without needing a clause of its own.
INTERNAL_SUBJECT = "internal"


class UsageStatus(StrEnum):
    """Whether the gateway call succeeded. Recorded for failures too — that is the point."""

    SUCCESS = "success"
    FAILURE = "failure"


class FailureClass(StrEnum):
    """Why a call failed, classified at the coarseness decisions can actually be made at.

    The classes are exactly those of ``specs/llm-telemetry`` and design.md decision 24, and the
    split that matters most is ``GATEWAY_RATE_LIMIT`` against the rest: a rate limit is a property
    of the gateway account rather than of the model, so it is the one failure that must never move
    a request to a different candidate (``specs/model-policy``).

    ``SCHEMA_VALIDATION`` is likewise not an infrastructure failure. It is a judgement about output,
    and output quality may never select a model.
    """

    TRANSPORT = "transport"
    TIMEOUT = "timeout"
    GATEWAY_RATE_LIMIT = "gateway_rate_limit"
    AUTH_CONFIG = "auth_config"
    SCHEMA_VALIDATION = "schema_validation"
    UNCLASSIFIED = "unclassified"

    @property
    def is_infrastructure(self) -> bool:
        """Whether this is the kind of failure that may move a call to the next candidate.

        The allowlist rather than the denylist, so a class added later fails closed: a new failure
        does not silently become grounds for changing the model.
        """
        return self in (FailureClass.TRANSPORT, FailureClass.TIMEOUT)


class QuotaWindow(StrEnum):
    """The period an allowance is counted over.

    ``CONCURRENT`` is not a calendar window and is named so it cannot be mistaken for one: it is a
    live gauge incremented on run start and decremented in a ``finally``, with no reset boundary
    because it has nothing to reset.
    """

    DAY = "day"
    MONTH = "month"
    CONCURRENT = "concurrent"


class QuotaDimension(StrEnum):
    """An allowance dimension, each enforceable independently (``specs/usage-limits``).

    ``ESTIMATED_COST_PER_MONTH`` is declared and deliberately not seeded with an allowance. The
    spec requires the model to *admit* a cost budget "without restructuring the allowance model",
    and the honest way to show that is for the dimension to exist and be expressible while nothing
    enforces it — an estimate is the wrong thing to refuse a request on, and this change ships no
    billing. A plan that leaves a dimension unset is unlimited in it, so its absence is not a
    limit of zero.
    """

    REQUESTS_PER_DAY = "requests_per_day"
    REQUESTS_PER_MONTH = "requests_per_month"
    TOKENS_PER_MONTH = "tokens_per_month"
    CONCURRENT_RUNS = "concurrent_runs"
    ESTIMATED_COST_PER_MONTH = "estimated_cost_per_month"

    @property
    def window(self) -> QuotaWindow:
        """The window this dimension is counted over."""
        if self is QuotaDimension.REQUESTS_PER_DAY:
            return QuotaWindow.DAY
        if self is QuotaDimension.CONCURRENT_RUNS:
            return QuotaWindow.CONCURRENT
        return QuotaWindow.MONTH

    @property
    def is_reservable(self) -> bool:
        """Whether admission can reserve this dimension atomically before the call.

        Request and concurrency dimensions can: the amount is one, known up front. Token and cost
        dimensions cannot, because the amount is not known until the call returns — they are
        pre-checked against the window's consumed total and settled from the recorded events
        afterwards, which admits a bounded overshoot of one request. Decision 25 states that trade
        rather than presenting the ceiling as exact.
        """
        return self in (
            QuotaDimension.REQUESTS_PER_DAY,
            QuotaDimension.REQUESTS_PER_MONTH,
            QuotaDimension.CONCURRENT_RUNS,
        )


# The key a concurrency counter lives under. Concurrency has no window, but `usage_counters` is
# keyed by (subject, dimension, window_key) for every dimension, and a nullable key would make the
# uniqueness constraint stop working — in PostgreSQL two rows with a NULL key are not duplicates.
_CONCURRENT_WINDOW_KEY = "current"


class WindowKey(str):
    """The string identifying one allowance window, such as ``2026-09-03`` or ``2026-09``.

    A ``str`` subclass for the same reason as ``PolicyId``: this is a database key and a group-by
    column, and a wrapper would be unwrapped at both. Immutable in the way a ``str`` is —
    ``__slots__`` is empty, so no attribute can be assigned to an instance.

    Deriving the window from a key rather than from a schedule is what makes a reset need no
    operator action and no cron entry: the boundary passing produces a *different key*, which has
    no row yet, which reads as zero consumed. It also leaves the closed window's row in place, so
    "what did this account use last month" stays answerable after the month ends.
    """

    __slots__ = ()

    def __new__(cls, value: str) -> Self:
        text = str(value)
        if not text.strip():
            raise ValueError("A window key cannot be blank; it is part of a uniqueness constraint.")
        return super().__new__(cls, text)

    def __repr__(self) -> str:
        return f"WindowKey({str(self)!r})"

    @classmethod
    def __get_pydantic_core_schema__(
        cls, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        """Validate through ``__new__`` wherever this appears on a pydantic model.

        Without this, pydantic cannot build a schema for a plain ``str`` subclass at all. With it,
        a bare string arriving from a database row or a JSON body is validated on the way in rather
        than trusted, and a bad one raises a ``ValidationError`` like any other field.
        """
        return core_schema.no_info_after_validator_function(cls, core_schema.str_schema())

    @classmethod
    def for_window(cls, window: QuotaWindow, moment: datetime, zone: tzinfo) -> Self:
        """The key *moment* falls in, for *window*, in the configured quota time zone.

        The zone is a parameter rather than a lookup because ``domain/`` reads no configuration —
        the caller passes what ``QUOTA_WINDOW_TIMEZONE`` resolved to. Getting it from the server's
        local time would make a day boundary depend on where the process happens to run, which is
        the sort of thing that is only noticed when two instances disagree about whether someone is
        over their limit.
        """
        if window is QuotaWindow.CONCURRENT:
            return cls(_CONCURRENT_WINDOW_KEY)
        if moment.tzinfo is None:
            raise ValueError(
                "A window key needs an aware instant; a naive datetime would be interpreted in "
                "whatever zone the process happens to run in."
            )
        local: date = moment.astimezone(zone).date()
        if window is QuotaWindow.DAY:
            return cls(local.isoformat())
        return cls(f"{local.year:04d}-{local.month:02d}")

    @classmethod
    def for_dimension(cls, dimension: QuotaDimension, moment: datetime, zone: tzinfo) -> Self:
        """The key *dimension* is counted under at *moment*."""
        return cls.for_window(dimension.window, moment, zone)


class UsageEvent(BaseModel):
    """One language model call, as recorded (``specs/llm-telemetry``).

    Exactly one of these exists per attempt, on every path — agent orchestration, evaluation and
    the lab alike — whether the call succeeded or failed. A retry is its own event carrying
    ``attempt`` and ``retried_event_id``, so "how often does this model need two tries" is a query
    rather than a guess.

    ``estimated_cost`` is an estimate and is labelled as one everywhere it surfaces. The price that
    produced it is copied onto the event at write time, which is what makes re-pricing a catalog
    entry unable to rewrite history.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    event_id: str = Field(min_length=1, description="Stable identifier for this event.")
    user_id: str | None = Field(
        default=None,
        description="The acting principal's auth subject. Null for a call with no principal — "
        "never a placeholder or a shared identifier.",
    )
    subject_kind: SubjectKind = Field(
        default=SubjectKind.USER, description="Whose allowance this is accounted against."
    )
    agent_run_id: str | None = Field(
        default=None, description="The run this call belongs to, where it belongs to one."
    )
    request_id: str | None = Field(default=None, description="The request correlation identifier.")

    catalog_key: str = Field(
        min_length=1, description="The catalog entry that served the call. The stable handle."
    )
    gateway_provider: str = Field(min_length=1, description="The gateway that served the call.")
    gateway_model: str = Field(
        min_length=1, description="The gateway model identifier actually used."
    )
    policy_id: PolicyId = Field(
        description="The resolved policy, or the recorded configured-fallback indicator."
    )
    plan: PlanCode | None = Field(
        default=None,
        description="The principal's effective plan at the time of the call. Null on an internal "
        "event, where the internal classification stands in its place.",
    )
    call_role: CallRole = Field(description="The role the call served.")

    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    estimated_cost: Decimal | None = Field(
        default=None, ge=0, description="An operational estimate. Never a billed amount."
    )
    cost_currency: str | None = Field(
        default=None, min_length=3, max_length=3, description="ISO 4217, where a cost was computed."
    )
    pricing_date: date | None = Field(
        default=None, description="The pricing basis: when the price used was recorded."
    )

    latency_ms: float = Field(
        ge=0,
        description="The gateway call's own wall-clock duration, excluding the telemetry write.",
    )
    status: UsageStatus = Field(description="Whether the gateway call succeeded.")
    failure_class: FailureClass | None = Field(
        default=None, description="How the failure is classified. Present exactly when it failed."
    )
    attempt: int = Field(default=1, ge=1, description="1 for a first attempt, 2 for its retry.")
    retried_event_id: str | None = Field(
        default=None, description="The event this one retried, on a retry."
    )
    created_at: datetime = Field(description="When the call was made.")

    @property
    def is_internal(self) -> bool:
        """Whether this is internal usage rather than a product plan's.

        Mirrors the generated column of design.md decision 27 exactly, so a Python aggregate and a
        SQL one cannot disagree about what "internal" means.
        """
        return self.user_id is None or self.subject_kind is SubjectKind.INTERNAL

    @model_validator(mode="after")
    def _coherent(self) -> Self:
        """The combinations that would be a lie if stored.

        Each of these has been chosen because the wrong version of it is *plausible* — a caller
        passing zero tokens for a call that reported none, an internal event carrying a plan, a
        failure with no classification. None would raise at the write; all of them would quietly
        corrupt an aggregate.
        """
        if self.status is UsageStatus.FAILURE and self.failure_class is None:
            raise ValueError(
                "A failed usage event must carry a failure classification. 'It failed somehow' is "
                "what FailureClass.UNCLASSIFIED is for, and it says so explicitly."
            )
        if self.status is UsageStatus.SUCCESS and self.failure_class is not None:
            raise ValueError("A successful usage event must not carry a failure classification.")

        if self.subject_kind is SubjectKind.USER and self.user_id is None:
            raise ValueError(
                "A user-subject usage event needs the acting principal's subject. An event with no "
                "principal is SubjectKind.INTERNAL, not a user event with a missing owner."
            )
        if self.is_internal and self.plan is not None:
            raise ValueError(
                "An internal usage event carries no plan: internal traffic is accounted against "
                "the internal allowance and must never be attributed to a product plan."
            )
        if not self.is_internal and self.plan is None:
            raise ValueError("A product usage event must record the plan in effect for the call.")

        known = (self.prompt_tokens, self.completion_tokens, self.total_tokens)
        if all(count is not None for count in known):
            prompt, completion, total = known
            assert prompt is not None and completion is not None and total is not None
            if prompt + completion != total:
                raise ValueError(
                    f"total_tokens ({total}) must be prompt_tokens ({prompt}) plus "
                    f"completion_tokens ({completion})."
                )
        if self.estimated_cost is not None and self.total_tokens is None:
            raise ValueError(
                "Estimated cost cannot be computed without token counts. Where the gateway "
                "reported none, cost is null rather than zero."
            )
        if (self.estimated_cost is None) != (self.cost_currency is None):
            raise ValueError(
                "An estimated cost and its currency are recorded together or not at all."
            )

        if self.retried_event_id is not None and self.attempt < 2:
            raise ValueError("An event that retried another is attempt 2 or later.")
        if self.retried_event_id == self.event_id and self.event_id:
            raise ValueError("A usage event cannot be its own retry.")
        return self
