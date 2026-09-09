"""The seam that makes a gateway client's own retries visible to telemetry.

`complete_json` retries a bounded number of times when the model's output fails schema validation,
and that loop lives inside the gateway client. Anything wrapping the client sees one call however
many POSTs happened underneath — so "how often does this model need two tries", which
`specs/evaluation` scores as the structured-output reliability criterion, would be unanswerable
from outside.

This is the narrowest fix that works: a list the client appends to and the instrumented wrapper
drains. Not a callback, because a callback invoked from inside the retry loop would let telemetry
raise into the answer path; not a return value, because `complete_json` returns the validated
object and widening that contract would reach every caller.

**One log per client instance, and clients are per call role per run** (`agents/llm/factory.py`),
so there is no sharing to race over. The log is cleared at the start of each outer call rather than
trusted to be empty, because a call that raised before draining would otherwise leave entries for
the next one to claim.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.evidence import InferenceStatus

__all__ = ["GatewayAttempt", "GatewayAttemptLog"]


class GatewayAttempt(BaseModel):
    """One POST to the gateway, and what came back.

    Token counts are optional and stay optional: a gateway that reported no usage produces ``None``
    here and ``None`` in the event, never a zero. A zero would be a measured claim that a call cost
    nothing.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    attempt_number: int = Field(ge=1)
    status: InferenceStatus
    served_model: str | None = None
    http_status: int | None = None
    error_code: str | None = None
    latency_ms: float = Field(ge=0.0)
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class GatewayAttemptLog:
    """Per-client record of the gateway calls one outer call made.

    Deliberately not thread-safe and deliberately not shared. A client serves one call role in one
    run, and its calls are sequential; a lock here would suggest a concurrency this does not have.
    """

    __slots__ = ("_attempts",)

    def __init__(self) -> None:
        self._attempts: list[GatewayAttempt] = []

    def record(self, attempt: GatewayAttempt) -> None:
        self._attempts.append(attempt)

    def clear(self) -> None:
        self._attempts.clear()

    def drain(self) -> tuple[GatewayAttempt, ...]:
        """Everything recorded since the last clear, in order, emptying the log."""
        drained = tuple(self._attempts)
        self._attempts.clear()
        return drained

    def __len__(self) -> int:
        return len(self._attempts)
