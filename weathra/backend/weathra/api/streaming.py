"""Server-sent events: Weathra's own event vocabulary, in order, always terminated.

Design.md decision 17. A client renders progress from these, so the vocabulary is Weathra's rather
than the graph's internals: ``routing``, ``agent_start``, ``agent_end``, ``tool_start``,
``tool_end``, ``answer_delta``, ``final``, ``error``. A stream that leaked node names would tie a
frontend to the orchestration's shape, and re-routing a capability would break a progress bar.

**Every event carries the request id and a monotonic sequence number.** ``specs/http-api`` requires
both, and they do different jobs: the id correlates the stream with the log lines and the error
bodies, and the sequence lets a client detect a gap or an out-of-order render rather than trusting
arrival order.

**Every stream ends with exactly one terminal event.** ``final`` or ``error``, never both and never
neither. The response status is already 200 by the time the first byte goes out, so a client that
merely saw the connection close would have to guess whether the answer was complete — which is the
one thing a streaming interface must not make it guess.

**A disconnect abandons the run without an unhandled error.** A client closing the tab raises
inside the generator when the next event is written; that is normal, not a failure, so it is caught
and logged at debug. Letting it propagate would fill an error log with people navigating away.

**The events are queued, not pushed.** The graph calls ``emit`` synchronously as it goes and the
generator drains the queue while the run task progresses. That keeps the graph free of any
knowledge of HTTP or of async generators — it hands over a value and carries on.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.evidence import AnswerEnvelope

__all__ = ["StreamEmitter", "StreamEvent", "StreamEventType", "sse_headers"]

logger = logging.getLogger("weathra.api.streaming")


class StreamEventType(StrEnum):
    """The event vocabulary of design.md decision 17. Weathra's, not LangGraph's."""

    ROUTING = "routing"
    AGENT_START = "agent_start"
    AGENT_END = "agent_end"
    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    ANSWER_DELTA = "answer_delta"
    FINAL = "final"
    ERROR = "error"


TERMINAL_EVENTS = frozenset({StreamEventType.FINAL, StreamEventType.ERROR})


class StreamEvent(BaseModel):
    """One event, with everything a client needs to correlate and order it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: StreamEventType
    sequence: int = Field(ge=1, description="Monotonic within the stream, starting at 1.")
    request_id: str = Field(min_length=1)
    data: dict[str, Any] = Field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.type in TERMINAL_EVENTS

    def encode(self) -> str:
        """The SSE wire form: a named event and one JSON data line.

        A named event rather than an untyped one, so a browser can use
        ``addEventListener('tool_start')`` instead of parsing every message to find out what it is.
        """
        payload = json.dumps(
            {"sequence": self.sequence, "request_id": self.request_id, **self.data},
            default=str,
        )
        return f"event: {self.type.value}\ndata: {payload}\n\n"


def sse_headers() -> dict[str, str]:
    """Headers a streaming response needs to actually stream.

    ``no-cache`` and ``no-transform`` because an intermediary that buffered or compressed the body
    would hold every event until the run finished, which defeats the endpoint. ``X-Accel-Buffering``
    is nginx-specific and harmless elsewhere; Cloud Run's proxy respects the cache directives.
    """
    return {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


class StreamEmitter:
    """Collects events from a run and hands them to the response generator in order.

    Given to the graph as an optional dependency. The graph calls ``emit`` and knows nothing about
    HTTP; without one, the same graph runs unstreamed — which is why ``/ask`` and ``/stream`` are
    one implementation rather than two.
    """

    __slots__ = ("_events", "_request_id", "_sequence", "result")

    def __init__(self, *, request_id: str) -> None:
        self._request_id = request_id
        self._sequence = 0
        self._events: asyncio.Queue[StreamEvent] = asyncio.Queue()
        self.result: Any = None

    # ---------------------------------------------------------------- emitting

    def emit(self, event_type: StreamEventType, **data: Any) -> None:
        """Queue one event. Synchronous, so a graph node can call it without awaiting."""
        self._sequence += 1
        self._events.put_nowait(
            StreamEvent(
                type=event_type,
                sequence=self._sequence,
                request_id=self._request_id,
                data=data,
            )
        )

    def routing(self, *, capabilities: list[str], source: str, reason: str | None) -> None:
        self.emit(StreamEventType.ROUTING, capabilities=capabilities, source=source, reason=reason)

    def agent_start(self, agent: str, *, reason: str | None = None) -> None:
        self.emit(StreamEventType.AGENT_START, agent=agent, reason=reason)

    def agent_end(self, agent: str, *, status: str, duration_ms: float) -> None:
        self.emit(StreamEventType.AGENT_END, agent=agent, status=status, duration_ms=duration_ms)

    def tool_start(self, tool: str, *, agent: str) -> None:
        # The tool's *name*, not its arguments: arguments are in the evidence record, and a
        # progress indicator does not need coordinates.
        self.emit(StreamEventType.TOOL_START, tool=tool, agent=agent)

    def tool_end(self, tool: str, *, ok: bool, duration_ms: float) -> None:
        self.emit(StreamEventType.TOOL_END, tool=tool, ok=ok, duration_ms=duration_ms)

    def answer_delta(self, text: str) -> None:
        self.emit(StreamEventType.ANSWER_DELTA, text=text)

    # ---------------------------------------------------------------- terminal events

    def final_event(self, envelope: AnswerEnvelope, *, evidence_id: str | None) -> str:
        """The one successful terminal event, already encoded."""
        self._sequence += 1
        return StreamEvent(
            type=StreamEventType.FINAL,
            sequence=self._sequence,
            request_id=self._request_id,
            data={
                "answer": envelope.model_dump(mode="json"),
                "evidence_id": evidence_id,
            },
        ).encode()

    def error_event(self, *, code: str, message: str) -> str:
        """The one failing terminal event, already encoded.

        Carries the same code and message the non-streaming endpoint would have returned, so a
        client handles a failure identically either way.
        """
        self._sequence += 1
        return StreamEvent(
            type=StreamEventType.ERROR,
            sequence=self._sequence,
            request_id=self._request_id,
            data={"code": code, "message": message},
        ).encode()

    # ---------------------------------------------------------------- draining

    async def drain_while[Result](self, work: Awaitable[Result]) -> AsyncIterator[str]:
        """Yield queued events while ``work`` runs, then stop.

        The run goes into a task so the queue can be drained as it fills. A short poll rather than
        a sentinel value because the run's completion is the only signal that no more events are
        coming, and racing a sentinel against a cancellation is more machinery than this needs.
        """
        task: asyncio.Task[Result] = asyncio.create_task(_awaited(work))

        try:
            while not task.done() or not self._events.empty():
                try:
                    event = await asyncio.wait_for(self._events.get(), timeout=0.05)
                except TimeoutError:
                    continue
                yield event.encode()
        except asyncio.CancelledError:
            # The client went away. Abandon the run rather than leaving it to finish into a
            # response nobody is reading.
            logger.debug("stream cancelled by the client; abandoning the run")
            task.cancel()
            raise
        finally:
            if not task.done():
                # Reached when the generator is closed early — a disconnect, or a caller breaking
                # out. Awaiting the task here would hold the connection open for a run whose
                # output has nowhere to go.
                task.cancel()

        self.result = await task


async def _awaited[Result](work: Awaitable[Result]) -> Result:
    """Wrap an awaitable so it can be scheduled as a task."""
    return await work
