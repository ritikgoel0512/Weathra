"""Task 32.9 — what a promotion may rest on, and what it may not.

`specs/evaluation` draws one asymmetry and this module is it: a candidate may be promoted *for*
being cheaper or faster, and may not be promoted *despite* failing structured JSON reliability or
groundedness. Latency and cost are reported and never block; the two gates block.

**Only against recorded evidence, and only where there is some.** A candidate nobody has evaluated
is not refused here. Treating an absence of evidence as a failure would make an evaluation a
precondition for every catalog change rather than a basis for one — and the first thing anybody
would do is add a model to a policy so they could evaluate it, which is the loop this would create.

**The gate is overridable, and the override is recorded.** A person who has read the evidence may
promote anyway; what they may not do is promote silently. The route asks for an explicit
acknowledgement and writes the overridden criteria into the audit row, so the decision has an
author and a basis rather than just an effect.

Living in `lab/` rather than in `evaluation/` is deliberate: the administrative router needs it,
and `api/` may not reach the evaluation package — that package builds an application, and a
request must not. What the router needs is the *judgement*, which is here, over the *criteria*,
which are computed there.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from weathra.evaluation.criteria import GATING_CRITERIA
from weathra.lab.records import LabRecords

__all__ = ["GATING_CRITERIA", "criteria_failures"]

# Re-exported so the administrative router names one import rather than two, and so the set the
# route enforces is provably the set `evaluation/criteria.py` computes.
BLOCKING: Final[tuple[str, ...]] = GATING_CRITERIA


async def criteria_failures(
    session: AsyncSession, catalog_keys: Sequence[str]
) -> dict[str, list[str]]:
    """Which gating criteria each candidate's most recent evaluation says it failed.

    Reads the recorded outcome rather than recomputing one: a promotion is a decision about
    evidence that already exists, and re-running an evaluation inside a policy edit would make the
    edit slow, expensive and non-deterministic.

    A candidate with no recorded evaluation contributes nothing to the result — see the module
    docstring for why that is a decision rather than an oversight.
    """
    observed = await LabRecords(session).latest_evaluations(list(catalog_keys))
    failures: dict[str, list[str]] = {}
    for key in catalog_keys:
        criteria = observed.get(key, {}).get("criteria") or {}
        failed = [name for name in GATING_CRITERIA if criteria.get(name) is False]
        if failed:
            failures[key] = failed
    return failures
