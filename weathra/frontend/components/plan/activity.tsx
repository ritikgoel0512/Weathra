"use client";

/**
 * Recent usage, as the activity chart `10-plan-usage.png` draws rather than the three figures
 * this panel used to be.
 *
 * The artifact's "RECENT USAGE ACTIVITY" is an area chart over the week with two derived tiles
 * beside it — a peak and a week-over-week delta. Production had the same window as a definition
 * list: calls, failures, tokens. Same numbers, none of the shape. The gap was never the data, it
 * was that `GET /me/usage` returned the window's *totals* and no series, so there was nothing to
 * plot. It now returns one point per day, and this is what draws it.
 *
 * # Where every figure here comes from
 *
 * * **The area** — `usage.recent.series`, one point per day, from `llm_usage_events` grouped by
 *   `date_trunc('day', created_at)` and read under the caller's own session, so Row Level Security
 *   scopes it to their rows. Not a sample and not an estimate: that table records every model call.
 * * **Peak** — the largest `calls` in the window. Stated with its date, because a peak with no day
 *   attached is a number rather than a fact.
 * * **Week on week** — the last seven days' calls against the seven before them, as a percentage
 *   of the earlier week. The formula is in `deltaOf` and is stated on screen in the caption, so
 *   nobody has to guess whether "+12%" is points or proportion.
 *
 * **A day with no calls is a zero, not a gap.** Every other chart in Weathra draws an absent
 * measurement as a gap, because a provider that reported no temperature did not report zero
 * degrees. This series is the opposite: the backend fills the window densely, and it is right to,
 * because a day with no rows is a day nothing was called. Drawing it as a gap would show an idle
 * week as an unobserved one.
 *
 * **What the artifact has here and Weathra does not:** its chart is unlabelled and its axis is
 * days of the week with no year, which is fine for a mockup and not for a record; ours states the
 * window. Its "PEAK VOLUME 2.1k Req" and "WEEKLY DELTA +12.4%" are the two tiles reproduced below,
 * with real arithmetic behind them.
 */

import { useId, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyChart } from "@/components/ui";
import type { UsageDay } from "@/lib/api/schema";

import styles from "./plan.module.css";

/** Axis styling shared with the administrative chart, so the two read as one system. */
const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

/** Seven days is the comparison window, because the artifact's delta is a weekly one. */
const WEEK = 7;

export interface ActivityPoint {
  readonly date: string;
  readonly label: string;
  readonly calls: number;
  readonly failures: number;
}

/** A day's ISO date as a short axis label. Parsed as UTC, which is the date the backend grouped by. */
function labelOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

export function pointsOf(series: readonly UsageDay[] | undefined): readonly ActivityPoint[] {
  return (series ?? []).map((day) => ({
    date: day.date,
    label: labelOf(day.date),
    calls: day.calls,
    failures: day.failures,
  }));
}

export interface Peak {
  readonly calls: number;
  readonly label: string;
}

/**
 * The busiest day in the window, with the day it was.
 *
 * Ties go to the earlier day, which only matters for reproducibility: the same series must produce
 * the same tile twice.
 */
export function peakOf(points: readonly ActivityPoint[]): Peak | null {
  let best: ActivityPoint | null = null;
  for (const point of points) {
    if (best === null || point.calls > best.calls) best = point;
  }
  return best === null || best.calls === 0 ? null : { calls: best.calls, label: best.label };
}

export interface Delta {
  readonly recent: number;
  readonly earlier: number;
  readonly percent: number | null;
}

/**
 * The last seven days against the seven before them.
 *
 * `percent = (recent - earlier) / earlier × 100`, and it is **null when the earlier week is zero**
 * rather than infinity or an arbitrary 100: a proportion of nothing is not a proportion, and a
 * tile reading "+∞%" or a confident "+100%" against a week that never happened would be inventing
 * a trend out of a first week of use. The two counts are returned alongside it so the panel can
 * state them instead.
 *
 * A window shorter than fourteen days returns null for the same reason — there is no earlier week
 * to compare against, only a partial one, and comparing against a partial week overstates growth.
 */
export function deltaOf(points: readonly ActivityPoint[]): Delta | null {
  if (points.length < WEEK * 2) return null;
  const sum = (slice: readonly ActivityPoint[]) =>
    slice.reduce((total, point) => total + point.calls, 0);

  const recent = sum(points.slice(-WEEK));
  const earlier = sum(points.slice(-WEEK * 2, -WEEK));
  return {
    recent,
    earlier,
    percent: earlier === 0 ? null : ((recent - earlier) / earlier) * 100,
  };
}

function ActivityTooltip({
  active,
  payload,
  label,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: ActivityPoint }[];
  readonly label?: string | number;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        {point.calls} {point.calls === 1 ? "call" : "calls"}
        {point.failures > 0 ? ` · ${point.failures} failed` : ""}
      </p>
    </div>
  );
}

export function ActivityChart({
  points,
  days,
}: {
  readonly points: readonly ActivityPoint[];
  readonly days: number;
}): ReactNode {
  const described = useId();
  const title = `Model calls per day over the last ${days} days`;

  // Not "no data": the window is dense, so an all-zero series means the account made no calls.
  // Saying that is more useful than an empty frame implying something failed to load.
  if (points.length === 0 || points.every((point) => point.calls === 0)) {
    return (
      <EmptyChart
        title={title}
        reason={`No model calls in the last ${days} days.`}
        height={180}
      />
    );
  }

  return (
    <figure className={styles.chart}>
      <div
        className={styles.chartPlot}
        role="img"
        aria-label={`${title}. The totals are stated beneath it.`}
        aria-describedby={described}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={[...points]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="usageActivityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
            <XAxis dataKey="label" {...AXIS} minTickGap={24} />
            <YAxis {...AXIS} width={36} allowDecimals={false} />
            <Tooltip cursor={{ stroke: "var(--color-border-strong)" }} content={<ActivityTooltip />} />
            <Area
              type="monotone"
              dataKey="calls"
              name="Model calls"
              stroke="var(--color-accent)"
              strokeWidth={2}
              fill="url(#usageActivityFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption className={styles.chartNote} id={described}>
        One point per day, from your own model calls. A day with no calls is a zero rather than a
        gap — every call is recorded, so an empty day is an idle one.
      </figcaption>
    </figure>
  );
}
