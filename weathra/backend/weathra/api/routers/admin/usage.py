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
from weathra.telemetry.aggregate import (
    BUCKETS,
    GROUPINGS,
    UsageAggregate,
    UsageBucket,
    UsageWindow,
    aggregate_usage,
    aggregate_usage_series,
)

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
        str,
        Query(
            description="model, catalog_key, policy, plan, call_role, status, provider "
            "or failure_class."
        ),
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


# How many points a trend may return. A day bucket over the maximum period is 400 points and an
# hour bucket over two days is 48; an hour bucket over 400 days would be 9,600, which is not a
# chart. The cap is enforced rather than documented, and it names the bucket that would fit.
MAX_SERIES_POINTS = 800


class UsageSeriesResponse(BaseModel):
    """The same measures as `/admin/usage`, cut by time rather than by dimension."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: str = Field(description="The width of one point: 'hour' or 'day'.")
    window: UsageWindow
    points: tuple[UsageBucket, ...] = Field(
        description=(
            "One entry per (bucket, internal) pair, dense across the window. A bucket with no "
            "calls is a zero rather than a gap: this table records every call, so an empty hour "
            "is an idle hour rather than an unobserved one."
        )
    )


@router.get(
    "/usage/series",
    response_model=UsageSeriesResponse,
    summary="Language model usage over time",
)
async def read_usage_series(
    request: Request,
    principal: AdministrativePrincipal,
    session: AdministrativeSession,
    days: Annotated[int, Query(ge=1, le=MAX_PERIOD_DAYS)] = DEFAULT_PERIOD_DAYS,
    bucket: Annotated[str, Query(description="hour or day.")] = "day",
) -> UsageSeriesResponse:
    """Calls, failures, tokens, estimated cost and median latency per bucket.

    `/admin/usage` answers *which model, which plan, which policy*; this answers *when*, which is
    the other half of what `specs/llm-telemetry` asks an administrative reader to be able to see
    and the one the aggregate could not express. Same table, same internal split, same rule that a
    measure leaves and a row never does.
    """
    annotate(request, acting_user_id=principal.user_id)
    if bucket not in BUCKETS:
        raise ValidationFailed(
            f"{bucket!r} is not a bucket width this endpoint supports.",
            details={"field": "bucket", "supported": sorted(BUCKETS)},
        )

    width = BUCKETS[bucket]
    end = datetime.now(UTC)
    window = UsageWindow(start=end - timedelta(days=days), end=end)

    # Both halves of the internal split are returned for every bucket, so the point budget is
    # twice the bucket count. Refused rather than truncated: a silently shortened window is a
    # chart that says something other than what was asked for.
    points = 2 * int(timedelta(days=days) / width)
    if points > MAX_SERIES_POINTS:
        raise ValidationFailed(
            f"{days} days bucketed by {bucket} is {points} points, over the {MAX_SERIES_POINTS} "
            "this endpoint returns. Ask for a shorter period or a wider bucket.",
            details={"field": "bucket", "points": points, "maximum": MAX_SERIES_POINTS},
        )

    series = await aggregate_usage_series(session, bucket=bucket, window=window)
    return UsageSeriesResponse(bucket=bucket, window=window, points=series)
