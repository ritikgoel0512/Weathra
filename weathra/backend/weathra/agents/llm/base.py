"""The language-model contract: two methods, Weathra's own types, no vendor anywhere.

Design.md decision 3. The whole surface Weathra needs from an inference provider is a conversation
turn that comes back as prose and a conversation turn that comes back as a validated object. That
is two methods, so the contract is two methods — and because it is that small, ``specs/
agent-orchestration``'s "substituting another implementation SHALL NOT change any behavior" is a
claim the type system can nearly carry on its own.

**Why a Protocol and not a base class.** Nothing here is inherited. ``FakeLLMClient`` and
``OpenRouterClient`` have no code in common — one reads from a script, the other POSTs — and a
shared base would exist only to hold the two attributes they both declare. A Protocol says what a
client must do without saying anything about how, which is what makes the fake a real
implementation rather than a mock of one.

**Why Weathra's own message types.** A vendor's message dict is a vendor coupling wearing a
dictionary's clothes: the moment a node builds ``{"role": "assistant", "tool_calls": [...]}`` it
has encoded one provider's schema into the graph. ``Message`` is the shape Weathra means, and each
client translates it on the way out.

**Why ``complete_json`` is here and not in the nodes.** Routing decisions are the JSON path, and
every node that made one would otherwise reimplement prompt-for-JSON, parse, validate, retry —
four chances to get the retry bound wrong. Doing it in the abstraction also means a provider that
gains native structured output can implement it natively without touching a single node
(design.md decision 3).

**Identity is part of the contract.** ``provider_id`` and ``model_id`` are declared attributes,
not configuration a caller looks up separately, because ``specs/agent-orchestration`` requires
*every answer* to report which provider and model produced it. Reading them off the client that did
the work is the only way that cannot drift.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from enum import StrEnum
from typing import Any, Protocol, Self, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from weathra.domain.errors import (
    AgentNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
    ValidationFailed,
    WeathraError,
)
from weathra.domain.evidence import InferenceStatus

__all__ = [
    "JSON_INSTRUCTION",
    "Completion",
    "LLMClient",
    "Message",
    "Role",
    "TokenUsage",
    "classify_inference_failure",
    "extract_json_object",
    "system_message",
    "user_message",
    "validate_against",
]

logger = logging.getLogger("weathra.agents.llm")


class Role(StrEnum):
    """Who said a message. Weathra's vocabulary, mapped per provider on the way out."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class Message(BaseModel):
    """One conversation turn.

    ``name`` carries a tool's name on a ``TOOL`` message. Tool *results* travel as content — data,
    never instruction (``specs/agent-orchestration``: text arriving from tool results is treated as
    data, and instructions embedded in it do not alter routing).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    role: Role
    content: str
    name: str | None = Field(
        default=None, description="The tool that produced a TOOL message's content."
    )

    @classmethod
    def user(cls, content: str) -> Self:
        return cls(role=Role.USER, content=content)

    @classmethod
    def assistant(cls, content: str) -> Self:
        return cls(role=Role.ASSISTANT, content=content)

    @classmethod
    def tool_result(cls, name: str, content: str) -> Self:
        return cls(role=Role.TOOL, content=content, name=name)


def user_message(content: str) -> Message:
    return Message.user(content)


def system_message(content: str) -> Message:
    return Message(role=Role.SYSTEM, content=content)


class TokenUsage(BaseModel):
    """What a completion cost, when the provider says.

    All three fields are optional because not every gateway reports usage, and an unreported count
    must not become a zero — a zero would go into an evidence record as a measured fact.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)

    @property
    def reported(self) -> bool:
        return self.total_tokens is not None or self.prompt_tokens is not None


class Completion(BaseModel):
    """What a client returns: the text, and who produced it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    text: str
    provider_id: str = Field(min_length=1)
    model_id: str = Field(
        min_length=1,
        description=(
            "As *reported by the response* where the gateway says, so a provider silently "
            "substituting a model is visible in the evidence record rather than hidden by the "
            "configured value."
        ),
    )
    usage: TokenUsage = Field(default_factory=TokenUsage)
    finish_reason: str | None = None
    attempts: int = Field(default=1, ge=1, description="How many calls this completion took.")

    @property
    def truncated(self) -> bool:
        """Whether the provider stopped for length rather than because it was finished."""
        return self.finish_reason == "length"


@runtime_checkable
class LLMClient(Protocol):
    """The contract. Two methods, and the identity of whoever is behind them.

    The identity is declared read-only. Nothing outside a client ever assigns to it — a caller
    *reads* which model answered — and requiring settability would exclude an implementation that
    computes it, which the failover wrapper does: its current model changes as it walks a policy's
    candidates, so it has to be a property rather than a field set once at construction.
    """

    @property
    def provider_id(self) -> str:
        """The gateway behind this client."""
        ...

    @property
    def model_id(self) -> str:
        """The model this client is bound to."""
        ...

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        """One conversation turn, returned as prose."""
        ...

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        """One conversation turn, returned as an instance of ``schema``.

        Raises ``ValidationFailed`` when the model cannot produce a valid instance within the
        configured attempts. Raising rather than returning a partial object is deliberate: a
        routing decision that half-parsed is not a decision.
        """
        ...


# =========================================================================== JSON enforcement

JSON_INSTRUCTION = (
    "Reply with a single JSON object and nothing else. No prose before or after it, no markdown "
    "code fence, no explanation. The object must match this JSON Schema:"
)


def extract_json_object(text: str) -> dict[str, Any]:
    """The JSON object in a model's reply, however it chose to wrap it.

    Models fence JSON in ``` blocks and preface it with "Here is the plan:" no matter how firmly
    the prompt says not to. Recovering from that here rather than spending a retry on it is worth
    the small amount of leniency: the alternative is a second round-trip to fix punctuation.

    What this does *not* do is repair the JSON itself. A truncated object or a trailing comma is a
    real failure and goes back to the model with the error, because guessing at what a malformed
    routing decision meant is exactly the kind of helpfulness that produces a confident wrong
    answer.
    """
    stripped = text.strip()

    if stripped.startswith("```"):
        # ```json\n{...}\n``` — drop the fence line and everything after the closing fence.
        without_open = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = without_open.rsplit("```", 1)[0].strip()

    try:
        decoded = json.loads(stripped)
    except ValueError:
        # A preamble before the object: take from the first brace to its match.
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start == -1 or end <= start:
            raise ValidationFailed(
                "The model's reply contained no JSON object.",
                details={"reply_length": len(text)},
            ) from None
        try:
            decoded = json.loads(stripped[start : end + 1])
        except ValueError as exc:
            raise ValidationFailed(
                f"The model's reply was not valid JSON: {exc}",
                details={"reply_length": len(text)},
            ) from exc

    if not isinstance(decoded, dict):
        raise ValidationFailed(
            f"The model returned a JSON {type(decoded).__name__}, not an object.",
            details={"reply_length": len(text)},
        )
    return decoded


def validate_against[Schema: BaseModel](payload: Mapping[str, Any], schema: type[Schema]) -> Schema:
    """Validate a decoded object against the schema, or raise ``ValidationFailed``.

    The error message carries pydantic's own field-level detail, because that is what goes back to
    the model on the retry — "expected one of forecast, historical, analytics" is correctable and
    "invalid" is not.
    """
    try:
        return schema.model_validate(dict(payload))
    except ValidationError as exc:
        raise ValidationFailed(
            f"The model's JSON did not match {schema.__name__}: {_readable(exc)}",
            details={"schema": schema.__name__, "errors": exc.error_count()},
        ) from exc


def _readable(error: ValidationError) -> str:
    """Pydantic's errors as one line a model can act on."""
    parts = []
    for detail in error.errors():
        location = ".".join(str(part) for part in detail["loc"]) or "(root)"
        parts.append(f"{location}: {detail['msg']}")
    return "; ".join(parts)


# =========================================================================== failure classification


def classify_inference_failure(error: WeathraError) -> tuple[InferenceStatus, int | None]:
    """One provider failure, as the status and provider code an evidence record should carry.

    Written once and shared by both call sites, because the alternative is two ``except`` ladders
    that agree today and drift later — and the whole point of the classification is that a reader
    can trust the difference between "the model was withdrawn" and "the model answered badly".

    The HTTP status is what separates a **withdrawn model** from a **broken gateway**. Both arrive
    as ``ProviderUnavailable``; only ``details["status"]`` tells them apart, and Task 22.8's live
    runs were the 404 case. A reachability failure carries no status and is classified as a
    timeout, because "could not reach it" and "did not answer in time" are the same condition to
    everyone downstream.
    """
    status = error.details.get("status") if isinstance(error.details, dict) else None
    http_status = status if isinstance(status, int) else None

    if isinstance(error, ValidationFailed):
        # The model answered. Being wrong about the schema is a quality result, not an outage.
        return InferenceStatus.INVALID_OUTPUT, http_status
    if isinstance(error, ProviderRateLimited):
        return InferenceStatus.RATE_LIMITED, http_status or 429
    if isinstance(error, ProviderTimeout):
        return InferenceStatus.TIMEOUT, http_status
    if isinstance(error, AgentNotConfigured):
        return InferenceStatus.NOT_CONFIGURED, http_status
    if isinstance(error, ProviderUnavailable):
        if http_status == 404:
            return InferenceStatus.MODEL_UNAVAILABLE, http_status
        if http_status is None:
            # No status at all: the request never got a reply. Reachability, not a bad request.
            return InferenceStatus.TIMEOUT, None
        return InferenceStatus.PROVIDER_ERROR, http_status
    return InferenceStatus.PROVIDER_ERROR, http_status
