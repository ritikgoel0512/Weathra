"""Bounded infrastructure failover, as a client that wraps a client.

`specs/model-policy`: when a call fails because the gateway reports the model unavailable, returns
a server error, times out, or the network fails, the next enabled candidate of the *same resolved
policy* is attempted in declared order, bounded by `LLM_FAILOVER_MAX_MODELS`.

**What must never trigger it, and why each one is a rule rather than an oversight:**

* **A gateway rate limit.** 429 is a property of the *account*, not of the model. Weathra's
  candidates share one gateway account, so moving to another model changes nothing except which
  model gets blamed. It is handled by bounded retry against the same model — which
  `OpenRouterClient` already does, honouring the stated delay up to a ceiling — and then reported
  as a rate limit.
* **Output that failed schema validation.** The model answered. Being wrong is a quality result,
  and quality may never select a model: allowing it would turn this loop into "try increasingly
  expensive models until the answer looks acceptable", which is the exact behaviour the spec
  forbids and the exact behaviour that is easiest to arrive at by accident.
* **A missing credential.** Nothing is reachable, so there is no second thing to try.

So the eligible set is an *allowlist* — model-unavailable, provider-error, timeout — and a failure
class added later fails closed rather than silently becoming grounds for changing the model.

**Escalation is impossible by construction rather than by check.** The wrapper is handed the
candidates it may use, which the resolver drew from the caller's own resolved policy. There is no
call it can make to ask for others, so "a Free-plan caller never reaches a Pro or Premium
candidate" is a property of what was passed in.

**Every attempt is recorded, including the ones that failed.** `attempts` carries one entry per
model tried, in order, with its outcome — which is what makes an answer served by the second
candidate legible afterwards instead of looking like the first one worked.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable, Sequence

from pydantic import BaseModel

from weathra.agents.llm.base import (
    Completion,
    LLMClient,
    Message,
    classify_inference_failure,
)
from weathra.domain.entitlements import Resolution
from weathra.domain.errors import WeathraError
from weathra.domain.evidence import InferenceStatus
from weathra.entitlements.records import CatalogEntry

__all__ = ["FAILOVER_ELIGIBLE", "AttemptRecord", "FailoverClient"]

logger = logging.getLogger("weathra.agents.llm.failover")

# The only outcomes that may move a call to another model. An allowlist, so a status added later
# does not silently join it (`specs/model-policy`).
FAILOVER_ELIGIBLE: frozenset[InferenceStatus] = frozenset(
    {
        InferenceStatus.MODEL_UNAVAILABLE,
        InferenceStatus.PROVIDER_ERROR,
        InferenceStatus.TIMEOUT,
    }
)


class AttemptRecord(BaseModel):
    """One model attempted, and what became of it."""

    model_config = {"frozen": True, "extra": "forbid"}

    attempt_number: int
    catalog_key: str
    gateway_provider: str
    gateway_model: str
    status: InferenceStatus
    http_status: int | None = None
    error_code: str | None = None
    latency_ms: float | None = None

    @property
    def served(self) -> bool:
        return self.status.served


class FailoverClient:
    """An `LLMClient` that walks the resolved policy's remaining candidates on an outage.

    Satisfies the same two-method contract, so nothing above it knows failover exists — which is
    what keeps the nodes free of it. `provider_id` and `model_id` track whichever client is current,
    so a completion still reports what actually answered.
    """

    __slots__ = ("_attempts", "_build", "_current", "_max_models", "_remaining", "_resolution")

    def __init__(
        self,
        primary: LLMClient,
        *,
        resolution: Resolution,
        remaining: Sequence[CatalogEntry],
        build: Callable[[Resolution], LLMClient],
        max_models: int,
    ) -> None:
        self._current = primary
        self._resolution = resolution
        self._remaining = list(remaining)
        self._build = build
        # Counting the first attempt, so `LLM_FAILOVER_MAX_MODELS=1` means "no failover" rather
        # than "one spare", which is the reading an operator setting a bound of one expects.
        self._max_models = max(1, max_models)
        self._attempts: list[AttemptRecord] = []

    # ---------------------------------------------------------------- identity

    @property
    def provider_id(self) -> str:
        return self._current.provider_id

    @property
    def model_id(self) -> str:
        return self._current.model_id

    @property
    def attempts(self) -> tuple[AttemptRecord, ...]:
        """Every model tried in order, with its outcome. Empty before the first call."""
        return tuple(self._attempts)

    @property
    def failed_over(self) -> bool:
        """Whether anything beyond the first candidate was attempted."""
        return len(self._attempts) > 1

    # ---------------------------------------------------------------- the contract

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        return await self._attempt(lambda client: client.complete(system=system, messages=messages))

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        return await self._attempt(
            lambda client: client.complete_json(system=system, messages=messages, schema=schema)
        )

    # ---------------------------------------------------------------- the loop

    async def _attempt[Result](self, call: Callable[[LLMClient], Awaitable[Result]]) -> Result:
        """Run *call* against the current client, moving on only for an infrastructure failure.

        The candidate list is consumed as it goes, so a run that failed over once during routing
        does not re-attempt the model it already knows is down when it comes to synthesise.
        """
        budget = self._max_models

        while True:
            started = time.perf_counter()
            try:
                result = await call(self._current)
            except WeathraError as failure:
                elapsed = (time.perf_counter() - started) * 1000.0
                status, http_status = classify_inference_failure(failure)
                self._record(status, http_status, failure.code, elapsed)

                budget -= 1
                if status not in FAILOVER_ELIGIBLE:
                    # A rate limit, invalid output, or a missing credential. Another model would
                    # answer the wrong question about what went wrong.
                    raise
                if budget <= 0 or not self._remaining:
                    raise
                self._advance(status)
                continue

            elapsed = (time.perf_counter() - started) * 1000.0
            self._record(InferenceStatus.SERVED, None, None, elapsed)
            return result

    def _advance(self, because: InferenceStatus) -> None:
        """Move to the next candidate of the same policy, in declared order."""
        entry = self._remaining.pop(0)
        self._resolution = self._resolution.model_copy(
            update={
                "catalog_key": entry.catalog_key,
                "gateway_provider": entry.gateway_provider,
                "gateway_model": entry.gateway_model,
                "reason": (
                    f"{self._resolution.reason}; failed over to {entry.catalog_key} "
                    f"after {because.value}"
                ),
            }
        )
        self._current = self._build(self._resolution)
        logger.info(
            "failing over to %s after %s (policy=%s)",
            entry.catalog_key,
            because.value,
            self._resolution.policy_id,
        )

    def _record(
        self,
        status: InferenceStatus,
        http_status: int | None,
        error_code: str | None,
        latency_ms: float,
    ) -> None:
        self._attempts.append(
            AttemptRecord(
                attempt_number=len(self._attempts) + 1,
                catalog_key=self._resolution.catalog_key,
                gateway_provider=self._resolution.gateway_provider,
                gateway_model=self._resolution.gateway_model,
                status=status,
                http_status=http_status,
                error_code=error_code,
                latency_ms=latency_ms,
            )
        )

    # ---------------------------------------------------------------- what actually served

    @property
    def resolution(self) -> Resolution:
        """The resolution as it now stands, naming whichever candidate is current.

        Read after the call rather than before: an answer served by the second candidate must be
        recorded as served by the second candidate, not by the one the walk started with.
        """
        return self._resolution
