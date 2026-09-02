"""What a run reports as it happens, expressed so the graph never learns about HTTP.

The streaming endpoint needs to know when routing finished, when each agent started and ended, and
when each tool was called. The graph is the only place that knows those things. But ``agents/`` sits
*below* ``api/`` in the layer rule, so the graph cannot import the SSE emitter — and should not:
an orchestration that knew about server-sent events would be an orchestration that could only be
used behind one.

So the graph calls a Protocol. ``api/streaming.StreamEmitter`` satisfies it structurally, and so
would a metrics collector, a test spy, or nothing at all — ``run_agent``'s observer is optional,
which is what keeps ``/ask`` and ``/stream`` one implementation instead of two.

**Every method returns ``None`` and none of them is awaited.** An observer that could fail, block,
or change a value would be a participant in the run rather than a witness to it. A slow observer
would slow the answer; one that raised would lose it. So the contract is deliberately powerless:
tell it what happened, carry on regardless.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

__all__ = ["RunObserver"]


@runtime_checkable
class RunObserver(Protocol):
    """A witness to a run's progress. Cannot influence it, and is never awaited."""

    def routing(self, *, capabilities: list[str], source: str, reason: str | None) -> None:
        """The plan is decided: which capabilities, from which router, and why."""
        ...

    def agent_start(self, agent: str, *, reason: str | None = None) -> None:
        """One capability node is beginning."""
        ...

    def agent_end(self, agent: str, *, status: str, duration_ms: float) -> None:
        """It finished, succeeded or not, having taken this long."""
        ...

    def tool_start(self, tool: str, *, agent: str) -> None:
        """A tool call is going out. The name only — arguments belong in the evidence record."""
        ...

    def tool_end(self, tool: str, *, ok: bool, duration_ms: float) -> None:
        """It came back."""
        ...

    def answer_delta(self, text: str) -> None:
        """A piece of the written answer.

        Emitted as one whole delta today: the synthesis call is not token-streamed, because the
        prose is checked against the evidence *after* it is written (``agents/grounding.py``) and
        streaming a figure the audit is about to flag would show a person a number Weathra is
        still deciding whether to stand behind.
        """
        ...
