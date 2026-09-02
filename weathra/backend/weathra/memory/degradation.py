"""What Weathra does when the memory store is gone.

``specs/memory`` asks for two things that pull in opposite directions, and the whole point of this
module is that they are decided in one place rather than at every call site:

* **Keep serving what does not need memory.** Forecast, historical, analytics, comparison, and
  location resolution are stateless. They take a location and a window and call a provider; a
  memory outage has nothing to do with them, and failing them would turn a degraded service into a
  down one.
* **Never answer a follow-up as though context had been applied.** "Which one is warmer?" with no
  access to what "one" referred to is not a question that can be answered — and answering it from a
  guess is worse than saying so, because the caller cannot tell the difference.

So the rule is not "carry on" and not "fail"; it is **carry on where memory was not needed, and say
so where it was**. ``MemoryStatus`` is that distinction made explicit, and it is the thing a
response carries so the UI can show it.

**Preferences degrade the same way.** With the store unreachable, the documented defaults apply —
which is the right answer, because they are what applies when nothing is set. But the status says
they are unavailable rather than *chosen*, so a person's stored imperial preference silently
reverting to metric is reported rather than presented as their setting.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field

from weathra.domain.errors import MemoryUnavailable

__all__ = [
    "CONTEXT_UNAVAILABLE",
    "PREFERENCES_UNAVAILABLE",
    "FollowUpRefused",
    "MemoryStatus",
    "follow_up_unavailable",
    "with_memory",
]

logger = logging.getLogger("weathra.memory.degradation")

CONTEXT_UNAVAILABLE = (
    "Weathra cannot reach its conversation memory right now, so it cannot tell what this question "
    "refers to. Ask it again naming the place and the dates and it will answer from live data."
)

PREFERENCES_UNAVAILABLE = (
    "Weathra cannot reach its preference store right now, so its documented defaults are in use "
    "rather than your saved settings."
)


class MemoryStatus(BaseModel):
    """Whether memory was reachable, and — if not — what that cost this answer.

    Carried on a response rather than logged, because the person reading the answer is the one who
    needs to know that their preferences were not applied to it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    available: bool = True
    note: str | None = Field(
        default=None, description="Set when unavailable: what could not be applied."
    )
    defaults_applied: bool = Field(
        default=False,
        description="Whether documented defaults stood in for the person's stored preferences.",
    )

    @classmethod
    def unavailable(cls, *, defaults_applied: bool = False) -> MemoryStatus:
        return cls(
            available=False,
            note=PREFERENCES_UNAVAILABLE if defaults_applied else CONTEXT_UNAVAILABLE,
            defaults_applied=defaults_applied,
        )


class FollowUpRefused(BaseModel):
    """A follow-up that could not be resolved because memory was unreachable.

    Deliberately not an answer with a caveat attached. A caveat under a confident number is read as
    a footnote; a refusal that names what is missing is read as the answer it is.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    answered: bool = Field(default=False)
    message: str = CONTEXT_UNAVAILABLE
    status: MemoryStatus = Field(default_factory=lambda: MemoryStatus.unavailable())
    question: str | None = None


def follow_up_unavailable(question: str | None = None) -> FollowUpRefused:
    """What a follow-up gets when its context cannot be read.

    A value rather than a raised error: the request as a whole has not failed — Weathra is up, the
    providers are up, and the same question asked in full would be answered. What failed is the part
    that made it a *follow-up*, and that is a statement about this turn rather than an outage.
    """
    logger.info("follow-up could not be resolved: conversation memory unavailable")
    return FollowUpRefused(question=question)


async def with_memory[Value](
    operation: Callable[[], Awaitable[Value]],
    *,
    fallback: Value,
    what: str,
) -> tuple[Value, MemoryStatus]:
    """Run a memory-backed read, falling back to ``fallback`` if the store is unreachable.

    For the reads whose absence is survivable — preferences, the saved-location list, a thread's
    title. **Not** for follow-up resolution: there the fallback would be a guess, which is what
    ``follow_up_unavailable`` exists to avoid. The two are separate functions rather than one with
    a flag precisely so a caller cannot reach for the survivable one by accident.

    Only ``MemoryUnavailable`` is caught. A ``ThreadNotFound`` or a validation error is not an
    outage and must reach the caller as itself.
    """
    try:
        return await operation(), MemoryStatus()
    except MemoryUnavailable:
        logger.warning("%s unavailable; continuing with documented defaults", what)
        return fallback, MemoryStatus.unavailable(defaults_applied=True)
