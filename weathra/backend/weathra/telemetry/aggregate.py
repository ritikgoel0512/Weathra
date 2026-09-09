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

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

__all__ = ["UsageAggregate", "UsageWindow", "aggregate_usage"]

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
