"""Telemetry as a decorator over the client, written outside the answer path (decision 24).

The same pattern as `CachedProvider` and `FailoverClient`: something that satisfies `LLMClient` and
wraps something else that does. Instrumentation is therefore not a call inside every node — which
would be one place per node to forget — and a node cannot tell it is there.

**Latency measures the gateway call and nothing else.** The timer starts immediately before the
inner call and stops immediately after, so the recorded figure excludes projection, cost
arithmetic and the write. `specs/llm-telemetry` requires exactly that: telemetry must not change
the latency of the call it measures.

**Retries inside `complete_json` are visible, and that took a seam.** The bounded schema retries
live inside the gateway client, so a wrapper around it sees one call whatever happened underneath.
`GatewayAttemptLog` is that seam: the client appends one entry per POST it makes, and this wrapper
drains the log afterwards and emits one event per entry, each carrying its attempt number and the
identifier of the event it retried. Without it, "how often does this model need two tries" — which
is the structured-output reliability criterion in `specs/evaluation` — would be unanswerable.

**Nothing here decides anything.** The model, the policy and the plan arrive in the `CallContext`
already decided by the resolver. This module classifies an outcome and records it; it never asks
the catalog what a model is, and it has no session to ask with.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence

from pydantic import BaseModel

from weathra.agents.llm.attempts import GatewayAttemptLog
from weathra.agents.llm.base import (
    Completion,
    LLMClient,
    Message,
    classify_inference_failure,
)
from weathra.domain.errors import WeathraError
from weathra.domain.evidence import InferenceAttempt, InferenceStage, InferenceStatus
from weathra.domain.usage import UsageEvent
from weathra.telemetry.context import CallContext
from weathra.telemetry.projection import project_attempt

__all__ = ["InstrumentedLLMClient", "UsageRecorder"]

logger = logging.getLogger("weathra.agents.llm.instrumented")

# What the wrapper hands its events to. A callable rather than a class so the request path can pass
# a background scheduler and a test can pass a list's `append` — neither needs to know the other
# exists.
UsageRecorder = Callable[[Sequence[UsageEvent]], None]

# Which stage a call role records under. The two vocabularies are deliberately parallel
# (design.md decision 22); mapping rather than casting keeps a rename in one from mis-filing every
# event under the other.
_STAGE_BY_ROLE = {
    "routing": InferenceStage.ROUTING,
    "synthesis": InferenceStage.SYNTHESIS,
    # A lab comparison is a synthesis call by shape. It is told apart from product usage by the
    # subject kind on the event, never by the stage.
    "lab": InferenceStage.SYNTHESIS,
}


class InstrumentedLLMClient:
    """An `LLMClient` that records one usage event per gateway attempt.

    Wraps whatever it is given — a gateway client, or the failover wrapper around one — so the
    ordering is deliberate: instrumentation on the outside sees every candidate a failover walk
    attempted, because each is a separate inner call.
    """

    __slots__ = ("_attempts", "_context", "_inner", "_recorder")

    def __init__(
        self,
        inner: LLMClient,
        *,
        context: CallContext,
        recorder: UsageRecorder,
        attempts: GatewayAttemptLog | None = None,
    ) -> None:
        self._inner = inner
        self._context = context
        self._recorder = recorder
        self._attempts = attempts

    @property
    def provider_id(self) -> str:
        return self._inner.provider_id

    @property
    def model_id(self) -> str:
        return self._inner.model_id

    # ---------------------------------------------------------------- the contract

    async def complete(self, *, system: str, messages: Sequence[Message]) -> Completion:
        return await self._timed(lambda: self._inner.complete(system=system, messages=messages))

    async def complete_json[Schema: BaseModel](
        self, *, system: str, messages: Sequence[Message], schema: type[Schema]
    ) -> Schema:
        return await self._timed(
            lambda: self._inner.complete_json(system=system, messages=messages, schema=schema)
        )

    # ---------------------------------------------------------------- the measurement

    async def _timed[Result](self, call: Callable[[], Awaitable[Result]]) -> Result:
        """Run the inner call, time it, and record what became of it.

        The recording happens after the timer stops and after the result is in hand, so a slow
        projection cannot inflate a latency figure, and a failure in recording cannot turn a
        successful call into a failed one — the emit is wrapped, because a telemetry bug must not
        become an outage.
        """
        if self._attempts is not None:
            self._attempts.clear()

        started = time.perf_counter()
        try:
            result = await call()
        except WeathraError as failure:
            elapsed = (time.perf_counter() - started) * 1000.0
            status, http_status = classify_inference_failure(failure)
            self._emit(status, http_status, failure.code, elapsed, served_model=None)
            raise

        elapsed = (time.perf_counter() - started) * 1000.0
        served = result.model_id if isinstance(result, Completion) else None
        self._emit(InferenceStatus.SERVED, None, None, elapsed, served_model=served)
        return result

    def _emit(
        self,
        status: InferenceStatus,
        http_status: int | None,
        error_code: str | None,
        elapsed_ms: float,
        *,
        served_model: str | None,
    ) -> None:
        """Project this call's attempts onto events and hand them to the recorder.

        One event per *gateway* attempt where the client reported them, and one for the call
        otherwise. The distinction matters for `complete_json`: three schema retries are three
        calls to the gateway and three events, linked by `retried_event_id`, rather than one event
        that reports the last outcome and hides the two before it.
        """
        try:
            events = self._project(status, http_status, error_code, elapsed_ms, served_model)
            if events:
                self._recorder(events)
        except Exception as failure:
            # Both the projection *and* the hand-off are inside this guard, and the second half is
            # the one that matters: `specs/llm-telemetry` requires a telemetry failure never to be
            # reported to a caller as a weather or agent error, and a recorder that raised would
            # have turned a perfectly good answer into a 500. The request path's recorder schedules
            # a background task and does not raise — but "does not raise today" is not the
            # guarantee the spec asks for.
            #
            # Not silent: the type goes in the line. Its message may carry a provider payload.
            logger.warning(
                "could not record usage for %s: %s",
                self._context.call_role.value,
                type(failure).__name__,
            )

    def _project(
        self,
        status: InferenceStatus,
        http_status: int | None,
        error_code: str | None,
        elapsed_ms: float,
        served_model: str | None,
    ) -> list[UsageEvent]:
        stage = _STAGE_BY_ROLE[self._context.call_role.value]
        reported = self._attempts.drain() if self._attempts is not None else ()

        if not reported:
            attempt = InferenceAttempt(
                stage=stage,
                attempt_number=1,
                status=status,
                provider=self.provider_id,
                selected_model=self.model_id,
                served_model=served_model,
                catalog_key=self._context.catalog_key,
                policy_id=str(self._context.resolution.policy_id),
                plan=self._context.plan.value if self._context.plan else None,
                resolution_reason=self._context.resolution.reason,
                http_status=http_status,
                error_code=error_code,
                latency_ms=elapsed_ms,
            )
            event = project_attempt(attempt, self._context)
            return [event] if event is not None else []

        events: list[UsageEvent] = []
        # Retries are linked *within one outer call* and never across two. A second `complete()`
        # is a separate call, not a retry of the first — and `UsageEvent` refuses an event that
        # claims to have retried something while being attempt one, which is how this was found.
        previous: str | None = None
        for gateway in reported:
            attempt = InferenceAttempt(
                stage=stage,
                attempt_number=gateway.attempt_number,
                status=gateway.status,
                provider=self.provider_id,
                selected_model=self.model_id,
                served_model=gateway.served_model,
                catalog_key=self._context.catalog_key,
                policy_id=str(self._context.resolution.policy_id),
                plan=self._context.plan.value if self._context.plan else None,
                resolution_reason=self._context.resolution.reason,
                http_status=gateway.http_status,
                error_code=gateway.error_code,
                latency_ms=gateway.latency_ms,
            )
            event = project_attempt(
                attempt,
                self._context,
                event_id=str(uuid.uuid4()),
                # A retry names the event it retried, so the pair reconstructs "needed two tries"
                # without anyone having to correlate by timestamp.
                retried_event_id=previous if gateway.attempt_number > 1 else None,
                prompt_tokens=gateway.prompt_tokens,
                completion_tokens=gateway.completion_tokens,
                total_tokens=gateway.total_tokens,
            )
            if event is None:
                continue
            previous = event.event_id
            events.append(event)
        return events
