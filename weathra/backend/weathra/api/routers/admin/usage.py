"""Task 31.5 — the aggregate usage an administrator reads, and the rows they never do.

One route, and its whole design is in what it returns. `specs/llm-telemetry` requires aggregation
by model, policy, plan, call role, status and period; `specs/authentication` requires that holding
the administrative role grants no access to another user's data. Those two are only compatible
because a usage event holds no content — no prompt, no completion, no retrieved passage — and
because this route returns *measures* rather than rows.

**No row ever leaves this route.** `aggregate_usage` runs one grouped statement and returns counts,
sums and percentiles. There is no parameter here that narrows to a subject, and no shape in the
response that could carry one, so "an administrator cannot read one person's usage" is a property
of the query rather than a filter somebody could forget.

**Internal usage is separated, not excluded.** `specs/usage-limits` requires it reported apart from
each product plan's, which is what the generated `is_internal` column on the events table is for:
the split is computed by the database from the row's own shape rather than by a flag a writer sets.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from weathra.api.middleware import annotate
from weathra.api.routers.admin.deps import AdministrativeSession
from weathra.auth.deps import AdministrativePrincipal
from weathra.domain.errors import ValidationFailed
from weathra.telemetry.aggregate import GROUPINGS, UsageAggregate, UsageWindow, aggregate_usage

__all__ = ["router"]

logger = logging.getLogger("weathra.api.admin.usage")

router = APIRouter(prefix="/admin", tags=["administration"])

# How far back a period may reach. Bounded because the retention window is bounded — asking for a
# year returns whatever survived it, and a request that scans further than the data goes is a slow
# query with no more to say.
MAX_PERIOD_DAYS = 400
DEFAULT_PERIOD_DAYS = 30


class UsageSummaryResponse(BaseModel):
    """Aggregate usage over one period, grouped one way, split internal from product."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    grouped_by: str = Field(description="The dimension the measures are grouped by.")
    window: UsageWindow
    groups: tuple[UsageAggregate, ...] = Field(
        description="One entry per (group, internal) pair. Never a row, and never a subject."
    )


@router.get("/usage", response_model=UsageSummaryResponse, summary="Aggregate language model usage")
async def read_usage(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    by: Annotated[
        str, Query(description="model, catalog_key, policy, plan, call_role, status, or provider.")
    ] = "model",
    days: Annotated[int, Query(ge=1, le=MAX_PERIOD_DAYS)] = DEFAULT_PERIOD_DAYS,
) -> UsageSummaryResponse:
    """Call counts, token totals, estimated cost, failure rate and latency, grouped and split.

    ``by`` is checked against an allowlist rather than interpolated, so a grouping the index does
    not support is a 400 and an injection through a group-by is impossible by construction.

    Estimated cost is exactly that — an operational estimate, priced from what the catalog said at
    the time of each call, never a billed amount and never presented as one.
    """
    annotate(request, acting_user_id=principal.user_id)
    if by not in GROUPINGS:
        raise ValidationFailed(
            f"{by!r} is not a grouping this endpoint supports.",
            details={"field": "by", "supported": sorted(GROUPINGS)},
        )

    end = datetime.now(UTC)
    window = UsageWindow(start=end - timedelta(days=days), end=end)
    groups = await aggregate_usage(session, by=by, window=window)
    return UsageSummaryResponse(grouped_by=by, window=window, groups=groups)
