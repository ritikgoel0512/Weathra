"""Usage totals for an administrative reader — counts and sums, never rows.

`specs/llm-telemetry` allows an administrative reader aggregate usage across users, and the reason
that is safe is worth restating rather than assuming: the table holds no prompt, no completion and
no retrieved passage, so a total across accounts discloses nothing about anybody's questions. The
API here enforces the shape that argument depends on — every function returns measures, and none
returns a row.

**Internal usage is split out by the generated column, not by a filter somebody remembers.**
`is_internal` is computed by the database from `user_id IS NULL OR subject_kind = 'internal'`
(design.md decision 27), so a lab or evaluation call cannot be counted against a plan even by an
aggregate that forgot to exclude it. Every grouping below carries the split.

**Percentiles come from PostgreSQL.** `percentile_cont` over the latency column is exact for the
rows it sees and costs one pass; pulling latencies into Python to sort them would move the whole
retention window across the wire to compute two numbers.

**Nulls stay out of the averages.** A call whose gateway reported no tokens contributes to the call
count and to nothing else — `sum` and `percentile_cont` both ignore nulls, which is the behaviour
wanted here and is stated because the alternative reading (unknown as zero) would quietly deflate
every token total.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

__all__ = [
    "BUCKETS",
    "UsageAggregate",
    "UsageBucket",
    "UsageWindow",
    "aggregate_usage",
    "aggregate_usage_series",
]

# The dimensions `specs/llm-telemetry` requires aggregation by. Named here so a caller cannot ask
# for a grouping the index does not support, and so an injection through a group-by is impossible
# by construction rather than by escaping.
GROUPINGS: dict[str, str] = {
    "model": "gateway_model",
    "catalog_key": "catalog_key",
    "policy": "policy_id",
    "plan": "plan",
    "call_role": "call_role",
    "status": "status",
    "provider": "gateway_provider",
    # Why a call failed, not merely that it did. `specs/llm-telemetry` asks for failure counts
    # split by classification, and `status` only separates success from failure — a reader looking
    # at a failure rate cannot tell a gateway rate limit (an account property, never a reason to
    # move a request to another model) from a schema validation (a judgement about output, which
    # may never select one). Null on every successful call, which is what makes the null group the
    # successes rather than an unclassified failure.
    "failure_class": "failure_class",
}


class UsageWindow(BaseModel):
    """The period an aggregate covers. Both bounds explicit, because "recent" is not a period."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    start: datetime
    end: datetime


class UsageAggregate(BaseModel):
    """One group's measures.

    ``estimated_cost_total`` is a `Decimal` all the way from the column, and is an estimate
    wherever it is shown — never a billed amount (`specs/usage-limits`).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    group: str | None = Field(description="The grouping value. Null where the column was null.")
    is_internal: bool = Field(
        description="Internal usage is reported separately and never counted against a plan."
    )
    calls: int = Field(ge=0)
    failures: int = Field(ge=0)
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    estimated_cost_total: Decimal | None = None
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None

    @property
    def failure_rate(self) -> float:
        """Failures over calls. Zero calls is a zero rate rather than a division by zero."""
        return (self.failures / self.calls) if self.calls else 0.0


async def aggregate_usage(
    session: AsyncSession,
    *,
    by: str = "model",
    window: UsageWindow | None = None,
) -> tuple[UsageAggregate, ...]:
    """Usage measures grouped by one dimension, split into product and internal.

    Runs as one statement over the window. Reading it privileged is what an administrative screen
    does; reading it under the restricted role returns only the acting principal's own rows, which
    is a perfectly sensible "my usage" view and needs no separate query.
    """
    column = GROUPINGS.get(by)
    if column is None:
        raise ValueError(f"{by!r} is not an aggregation dimension. Available: {sorted(GROUPINGS)}.")

    rows = await session.execute(
        text(
            f"""
            SELECT {column} AS grouping,
                   is_internal,
                   count(*) AS calls,
                   count(*) FILTER (WHERE status = 'failure') AS failures,
                   sum(prompt_tokens) AS prompt_tokens,
                   sum(completion_tokens) AS completion_tokens,
                   sum(total_tokens) AS total_tokens,
                   sum(estimated_cost) AS estimated_cost_total,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
              FROM llm_usage_events
             WHERE (CAST(:start AS timestamptz) IS NULL
                    OR created_at >= CAST(:start AS timestamptz))
               AND (CAST(:end AS timestamptz) IS NULL
                    OR created_at < CAST(:end AS timestamptz))
             GROUP BY {column}, is_internal
             ORDER BY is_internal, calls DESC, {column} NULLS LAST
            """
            # The grouping column is interpolated, and is safe because it comes from GROUPINGS
            # above rather than from a caller: an unknown dimension is refused before we get here.
        ),
        {"start": window.start if window else None, "end": window.end if window else None},
    )
    return tuple(
        UsageAggregate(
            group=row[0],
            is_internal=row[1],
            calls=row[2],
            failures=row[3],
            prompt_tokens=row[4],
            completion_tokens=row[5],
            total_tokens=row[6],
            estimated_cost_total=row[7],
            latency_p50_ms=row[8],
            latency_p95_ms=row[9],
        )
        for row in rows
    )


# =============================================================== the same measures, over time

# How a period is cut into points. Two, because they are the two a bounded retention window can
# usefully draw: hours for a day or two, days for anything longer. Named here for the same reason
# `GROUPINGS` is — the value reaches SQL, and an allowlist is what makes that safe.
BUCKETS: dict[str, timedelta] = {
    "hour": timedelta(hours=1),
    "day": timedelta(days=1),
}


class UsageBucket(BaseModel):
    """One point on a usage trend. The same measures as `UsageAggregate`, cut by time instead.

    Carries no grouping dimension and no subject, for the same reason `UsageAggregate` carries no
    subject: a point on a chart is a measure, and this one is reachable by an administrator across
    every account.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    start: datetime = Field(description="The bucket's inclusive start, truncated to its width.")
    is_internal: bool = Field(
        description="Internal usage stays separate here too, so a trend cannot blend the two."
    )
    calls: int = Field(ge=0)
    failures: int = Field(ge=0)
    total_tokens: int | None = None
    estimated_cost_total: Decimal | None = None
    latency_p50_ms: float | None = None


async def aggregate_usage_series(
    session: AsyncSession,
    *,
    bucket: str = "day",
    window: UsageWindow,
) -> tuple[UsageBucket, ...]:
    """The usage measures as a time series over `window`, gap-filled with zeros.

    **A bucket with no rows is a zero, not a gap, and that is a claim worth defending.** Everywhere
    else in Weathra an absent measurement is drawn as a gap — a provider that reported no
    temperature for an hour did not report zero degrees. This table is the opposite case: it
    records *every* model call, success and failure alike, so an hour with no rows is an hour in
    which nothing was called. Reporting that as a gap would misdescribe an idle period as an
    unobserved one. So the series is dense across the window, both halves of the internal split,
    and a chart can draw it as a continuous line without inventing anything.

    Runs one grouped statement and fills the empty buckets in Python, where the window bounds are
    already known — a `generate_series` join would move the same arithmetic into SQL and make the
    statement considerably harder to read for no measurable gain at this size.

    Subject-free like `aggregate_usage`: read under the privileged role it covers every account,
    read under a caller's own session Row Level Security scopes it to their rows. That is what lets
    one function serve both the administrative trend and a person's own.
    """
    width = BUCKETS.get(bucket)
    if width is None:
        raise ValueError(f"{bucket!r} is not a bucket width. Available: {sorted(BUCKETS)}.")

    rows = await session.execute(
        text(
            """
            SELECT date_trunc(:bucket, created_at) AS bucket_start,
                   is_internal,
                   count(*) AS calls,
                   count(*) FILTER (WHERE status = 'failure') AS failures,
                   sum(total_tokens) AS total_tokens,
                   sum(estimated_cost) AS estimated_cost_total,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
              FROM llm_usage_events
             WHERE created_at >= CAST(:start AS timestamptz)
               AND created_at < CAST(:end AS timestamptz)
             GROUP BY bucket_start, is_internal
            """
            # `:bucket` is bound rather than interpolated — `date_trunc` takes its field as an
            # ordinary text argument — and is still checked against BUCKETS above so an unknown
            # width is a clear refusal here rather than a database error two layers down.
        ),
        {"bucket": bucket, "start": window.start, "end": window.end},
    )
    observed = {
        (row[0], row[1]): UsageBucket(
            start=row[0],
            is_internal=row[1],
            calls=row[2],
            failures=row[3],
            total_tokens=row[4],
            estimated_cost_total=row[5],
            latency_p50_ms=row[6],
        )
        for row in rows
    }

    return tuple(
        observed.get(
            (start, internal),
            UsageBucket(start=start, is_internal=internal, calls=0, failures=0),
        )
        for start in _slots(window, width)
        for internal in (False, True)
    )


def _slots(window: UsageWindow, width: timedelta) -> tuple[datetime, ...]:
    """Every bucket start in the window, truncated the way `date_trunc` truncates.

    Truncation has to match the database's or the fill would never find the observed rows: both
    floor to the bucket, so the keys agree.
    """
    start = _floor(window.start, width)
    slots: list[datetime] = []
    current = start
    while current < window.end:
        slots.append(current)
        current += width
    return tuple(slots)


def _floor(moment: datetime, width: timedelta) -> datetime:
    """`date_trunc('day', …)` and `date_trunc('hour', …)`, in Python."""
    if width >= timedelta(days=1):
        return moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return moment.replace(minute=0, second=0, microsecond=0)
