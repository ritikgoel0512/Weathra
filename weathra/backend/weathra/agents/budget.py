"""Bounded execution: a step count and a wall clock, both of which return a partial answer.

``specs/agent-orchestration`` requires a bound on both and a *partial result reporting what was
gathered* when either is hit. Two separate bounds because they fail differently: a graph that loops
burns steps without time, and a provider that is slow burns time without steps.

**Exhaustion is not an error.** A budget that raised would throw away the work already done, which
is the opposite of what the spec asks for — the run stops, the evidence record is kept, the
findings already retrieved go into the envelope, and ``partial_reason`` names which bound was hit.
Something is better than nothing, and *labelled* something is better still.

**The wall clock is set below the token lifetime.** ``AGENT_WALL_CLOCK_BUDGET_SECONDS`` defaults
below the access-token lifetime so a long stream cannot outlive the credential that authorized it
(design.md decision 19). That is a security property, not a latency one.

**It measures real time, not logical time.** ``started_at`` defaults to the moment the budget is
constructed, which is the moment the run begins executing. A run whose *state* carries an earlier
logical timestamp — a replay, or a test pinning the weather to a fixed date — is not therefore out
of time.

**The budget is checked between steps, not inside them.** A step in flight is allowed to finish:
cancelling a tool call mid-request would leave the evidence record describing a call whose outcome
nobody knows, and the cost of finishing one call is bounded by the HTTP timeout anyway.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from weathra.config import Settings

__all__ = ["Budget", "BudgetState"]

logger = logging.getLogger("weathra.agents.budget")


@dataclass(frozen=True, slots=True)
class BudgetState:
    """Whether there is room for another step, and if not, which bound stopped the run."""

    exhausted: bool
    reason: str | None = None
    steps_used: int = 0
    seconds_used: float = 0.0


@dataclass(slots=True)
class Budget:
    """The bounds one run executes under, and the clock it is measured against."""

    max_steps: int
    max_seconds: float
    started_at: datetime
    steps_used: int = 0

    @classmethod
    def from_settings(cls, settings: Settings, *, started_at: datetime | None = None) -> Budget:
        return cls(
            max_steps=settings.agent_max_steps,
            max_seconds=settings.agent_wall_clock_budget_seconds,
            started_at=started_at or datetime.now(UTC),
        )

    def elapsed_seconds(self, now: datetime | None = None) -> float:
        return ((now or datetime.now(UTC)) - self.started_at).total_seconds()

    def check(self, *, now: datetime | None = None) -> BudgetState:
        """Whether another step may start.

        The step bound is checked first because it is the cheaper failure to explain: "this took
        more steps than allowed" is a routing problem, and "this took too long" is usually an
        upstream one.
        """
        elapsed = self.elapsed_seconds(now)

        if self.steps_used >= self.max_steps:
            return BudgetState(
                exhausted=True,
                reason=(
                    f"The run reached its limit of {self.max_steps} steps before every part of "
                    f"the question was answered. What had been gathered by then is reported below."
                ),
                steps_used=self.steps_used,
                seconds_used=elapsed,
            )

        if elapsed >= self.max_seconds:
            return BudgetState(
                exhausted=True,
                reason=(
                    f"The run reached its time limit of {self.max_seconds:g} seconds before every "
                    f"part of the question was answered. What had been gathered by then is "
                    f"reported below."
                ),
                steps_used=self.steps_used,
                seconds_used=elapsed,
            )

        return BudgetState(exhausted=False, steps_used=self.steps_used, seconds_used=elapsed)

    def spend(self, steps: int = 1) -> None:
        """Record that a step ran. Called after the step, so a step in flight always finishes."""
        self.steps_used += steps

    @property
    def remaining_steps(self) -> int:
        return max(0, self.max_steps - self.steps_used)
