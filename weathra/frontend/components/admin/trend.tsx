"use client";

/**
 * "Token usage & estimated cost" — the chart `09-admin-model-ai-usage.png` leads with.
 *
 * The artifact's largest panel plots two series against a *time* axis running 00:00 to 23:59.
 * Production had one chart and it was the wrong shape: `GET /admin/usage` groups a period by
 * model, policy or plan and returns no time dimension at all, so the screen could answer *which
 * model* but never *when*. The production fidelity review recorded that as the one thing keeping
 * this screen from its artifact — "one chart rather than two: the endpoint aggregates a period
 * into groups and returns no time series".
 *
 * `GET /admin/usage/series` is that series. Same table, same internal split, same rule that a
 * measure leaves and a row never does.
 *
 * # Where every figure comes from
 *
 * * **Tokens** — `sum(total_tokens)` per bucket over `llm_usage_events`, which the gateway reports
 *   per call. Null where a gateway reported none, and null is not zero: a call whose token count
 *   was never returned did not use nothing.
 * * **Estimated cost** — `sum(estimated_cost)` per bucket. Priced per call from what the catalog
 *   said at the time, in the currency the row carries. An operational estimate and never a billed
 *   amount, which is why the axis says *estimated* and the tile beside it repeats it.
 * * **The buckets** — `date_trunc('hour' | 'day', created_at)`, dense across the window.
 *
 * **Product and internal are separate lines, not a total.** `specs/usage-limits` requires internal
 * usage reported apart from every product plan, and a single line summing the two would report a
 * number that belongs to no plan. The toggle chooses which is drawn; the default is product,
 * because that is the one an operator is usually asking about.
 *
 * **What the artifact draws here and Weathra does not:** its own axis has no date on it, its
 * "DAILY DELTA −$12.40" sits beside a cost breakdown by model, policy and plan simultaneously, and
 * its footer asserts "ESTIMATED COST SYNCED". The delta is reproduced below from the series; the
 * three-way simultaneous breakdown is what the grouped chart above already is, one grouping at a
 * time; the footer is refused with the rest of the invented status apparatus (`screens.md` §5).
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyChart,
} from "@/components/ui";
import type { UsageBucket, UsageSeriesResponse } from "@/lib/api/schema";

import styles from "./admin.module.css";

const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

export interface TrendPoint {
  readonly start: string;
  readonly label: string;
  readonly calls: number;
  readonly tokens: number | null;
  readonly cost: number | null;
}

function labelOf(start: string, bucket: string): string {
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return start;
  return bucket === "hour"
    ? parsed.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      })
    : parsed.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
}

/**
 * One side of the internal split, in chart order.
 *
 * Cost arrives as a decimal string so no precision is lost between Postgres and the wire; it is
 * parsed here, at the last moment before it is plotted, and nowhere else.
 */
export function pointsOf(
  points: readonly UsageBucket[],
  bucket: string,
  internal: boolean,
): readonly TrendPoint[] {
  return points
    .filter((point) => point.is_internal === internal)
    .map((point) => ({
      start: point.start,
      label: labelOf(point.start, bucket),
      calls: point.calls,
      tokens: point.total_tokens ?? null,
      cost:
        point.estimated_cost_total === null ||
        point.estimated_cost_total === undefined
          ? null
          : Number(point.estimated_cost_total),
    }))
    .sort((left, right) => left.start.localeCompare(right.start));
}

/**
 * The artifact's "DAILY DELTA": the last bucket's cost against the one before it.
 *
 * Absolute rather than proportional, which is what the artifact shows and also the honest choice
 * for money — a percentage against a near-zero previous bucket is a large number about nothing.
 * Null when either bucket reported no cost at all, because an estimate cannot be differenced
 * against an absence.
 */
export function costDeltaOf(points: readonly TrendPoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!.cost;
  const previous = points[points.length - 2]!.cost;
  return last === null || previous === null ? null : last - previous;
}

/** Totals across the window, for the caption. Null stays null: absent is not zero. */
export function totalsOf(points: readonly TrendPoint[]): {
  readonly tokens: number | null;
  readonly cost: number | null;
  readonly calls: number;
} {
  let tokens: number | null = null;
  let cost: number | null = null;
  let calls = 0;
  for (const point of points) {
    calls += point.calls;
    if (point.tokens !== null) tokens = (tokens ?? 0) + point.tokens;
    if (point.cost !== null) cost = (cost ?? 0) + point.cost;
  }
  return { tokens, cost, calls };
}

/**
 * How many decimal places a cost axis needs for its ticks to be distinguishable.
 *
 * Two is right for dollars and wrong for fractions of a cent, and the administrative screen sees
 * both: a busy month is `$482.50`, a free-tier week is `$0.03`. At two places the four-width pass
 * photographed a cost axis reading **`$0.01` at two different heights** — the ticks at 0.006 and
 * 0.012 both rounding to the same string, which is an axis that cannot be read.
 *
 * Derived once from the largest value in the window rather than per tick, so every label on one
 * axis carries the same precision. A mixed-precision axis is its own kind of unreadable.
 */
function costDecimals(largest: number): number {
  if (largest >= 1) return 2;
  if (largest >= 0.01) return 3;
  if (largest >= 0.001) return 4;
  return 5;
}

function money(value: number | null, decimals = 2): string {
  return value === null ? "—" : `$${value.toFixed(decimals)}`;
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function TrendTooltip({
  active,
  payload,
  label,
  decimals = 2,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: TrendPoint }[];
  readonly label?: string | number;
  readonly decimals?: number;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        {count(point.tokens)} tokens · {money(point.cost, decimals)} estimated ·{" "}
        {point.calls} {point.calls === 1 ? "call" : "calls"}
      </p>
    </div>
  );
}

export function UsageTrend({
  series,
}: {
  readonly series: UsageSeriesResponse;
}): ReactNode {
  const [internal, setInternal] = useState(false);
  const described = useId();
  const points = useMemo(
    () => pointsOf(series.points, series.bucket, internal),
    [series, internal],
  );
  const totals = totalsOf(points);
  const delta = costDeltaOf(points);
  // The largest cost in this window sets the precision for the axis, the tooltip and the delta.
  const decimals = costDecimals(
    Math.max(0, ...points.map((point) => Math.abs(point.cost ?? 0))),
  );
  const side = internal ? "Internal" : "Product";
  const title = `${side} token usage and estimated cost per ${series.bucket}`;

  return (
    <Card aria-labelledby="admin-trend">
      <CardHeader
        title="Token usage and estimated cost over time"
        titleId="admin-trend"
        headingLevel={3}
        subtitle={`One point per ${series.bucket}, from recorded usage events. Estimated cost is an operational estimate, never a billed amount.`}
        badge={<Badge tone={internal ? "neutral" : "accent"}>{side}</Badge>}
      />
      <CardBody>
        {/*
          The split is a control rather than two lines on one plot: summing product and internal
          would draw a total that belongs to no plan, and `specs/usage-limits` requires them
          reported apart.
        */}
        <div
          className={styles.trendControls}
          role="group"
          aria-label="Which usage to plot"
        >
          <Button
            size="sm"
            variant={internal ? "ghost" : "secondary"}
            onClick={() => setInternal(false)}
            aria-pressed={!internal}
          >
            Product
          </Button>
          <Button
            size="sm"
            variant={internal ? "secondary" : "ghost"}
            onClick={() => setInternal(true)}
            aria-pressed={internal}
          >
            Internal
          </Button>
        </div>

        {points.length === 0 || totals.calls === 0 ? (
          <EmptyChart
            title={title}
            reason={`No ${side.toLowerCase()} calls were recorded in this period.`}
            height={220}
          />
        ) : (
          <figure className={styles.chart}>
            <div
              className={styles.chartPlot}
              role="img"
              aria-label={`${title}. ${count(totals.tokens)} tokens and ${money(totals.cost, decimals)} estimated across the window.`}
              aria-describedby={described}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={[...points]}
                  margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="adminTokenFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--color-accent)"
                        stopOpacity={0.4}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--color-accent)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="var(--color-border-subtle)"
                    strokeDasharray="0"
                    vertical={false}
                  />
                  <XAxis dataKey="label" {...AXIS} minTickGap={28} />
                  {/* Two axes, because tokens and money are not the same quantity and a shared
                      scale would flatten whichever is smaller into the baseline. */}
                  <YAxis yAxisId="tokens" {...AXIS} width={56} />
                  <YAxis
                    yAxisId="cost"
                    orientation="right"
                    {...AXIS}
                    width={56}
                    tickFormatter={(value: number) => money(value, decimals)}
                  />
                  <Tooltip
                    cursor={{ stroke: "var(--color-border-strong)" }}
                    content={<TrendTooltip decimals={decimals} />}
                  />
                  <Legend
                    wrapperStyle={{
                      fontSize: 11,
                      color: "var(--color-text-muted)",
                    }}
                    iconType="plainline"
                  />
                  <Area
                    yAxisId="tokens"
                    type="monotone"
                    dataKey="tokens"
                    name="Tokens"
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    fill="url(#adminTokenFill)"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Area
                    yAxisId="cost"
                    type="monotone"
                    dataKey="cost"
                    name="Estimated cost"
                    stroke="var(--color-class-analytics)"
                    strokeWidth={2}
                    fill="none"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <figcaption className={styles.chartNote} id={described}>
              A bucket the gateway reported no tokens or no pricing for is drawn
              as a gap rather than as a zero — unlike the call count, which is
              dense, because every call is recorded and only its token report
              can be missing.
            </figcaption>
          </figure>
        )}

        <div className={styles.trendTotals}>
          <div className={styles.trendTotal}>
            <span className={styles.trendLabel}>Tokens</span>
            <span className={styles.trendValue}>{count(totals.tokens)}</span>
            <span className={styles.trendNote}>across the window</span>
          </div>
          <div className={styles.trendTotal}>
            <span className={styles.trendLabel}>Estimated cost</span>
            <span className={styles.trendValue}>
              {money(totals.cost, decimals)}
            </span>
            <span className={styles.trendNote}>
              an estimate, not an amount owed
            </span>
          </div>
          <div className={styles.trendTotal}>
            <span className={styles.trendLabel}>
              Last {series.bucket} delta
            </span>
            <span className={styles.trendValue}>
              {delta === null
                ? "—"
                : `${delta >= 0 ? "+" : "−"}${money(Math.abs(delta), decimals).slice(1)}`}
            </span>
            <span className={styles.trendNote}>
              {delta === null
                ? "No priced pair to compare"
                : `against the previous ${series.bucket}`}
            </span>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
