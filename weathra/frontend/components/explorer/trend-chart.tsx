"use client";

/**
 * Forecast Explorer's own temporal chart.
 *
 * **Its own, deliberately.** `components/historical/charts.tsx` already draws a temperature series
 * against a reference with precipitation bars, and reaching for it here would have been the obvious
 * move — but that module is shared with Historical Analytics, Scenario Lab and Weather Watch, and
 * Historical is frozen. A change made here to serve this screen's composition would land on all
 * four. `11-forecast-explorer.png` wants something the others do not: a filled area under a single
 * dominant line, precipitation on its own axis, and time labels a person reads rather than the ISO
 * instants the provider sends. That is a different figure, so it is a different component.
 *
 * Everything it draws is the provider's. Nothing is interpolated to fill a gap and nothing is
 * smoothed into a shape the series does not have: a missing entry breaks the line, which is what a
 * missing entry looks like.
 */

import type { ReactNode } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "./explorer.module.css";

/** One point on the chart, as the provider reported it. */
export interface TrendPoint {
  /** The provider's local timestamp, kept for the tooltip and the accessible description. */
  readonly at: string;
  /** What a reader sees on the axis: `Mon 08:00`, or `Mon` on a multi-day horizon. */
  readonly label: string;
  readonly temperature: number | null;
  readonly precipitation: number | null;
}

const AXIS = {
  stroke: "var(--color-text-muted)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--color-border-subtle)" },
} as const;

/**
 * How many labels the axis carries, whatever the horizon.
 *
 * A 14-day hourly series is several hundred points and an axis that labelled each would be a grey
 * band. Recharts' `interval` takes a count of ticks to skip, so this is derived from the series
 * length rather than fixed — six or seven labels at every horizon, which is what the artifact
 * draws.
 */
function tickInterval(points: number): number {
  return Math.max(0, Math.ceil(points / 7) - 1);
}

function Tip({
  active,
  payload,
  label,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { name?: string; value?: number | string; unit?: string }[];
  readonly label?: string | number;
}): ReactNode {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{String(label)}</p>
      {payload.map((entry) => (
        <p className={styles.tooltipRow} key={entry.name}>
          {entry.name}: {entry.value}
          {entry.unit ? ` ${entry.unit}` : ""}
        </p>
      ))}
    </div>
  );
}

export interface ForecastTrendChartProps {
  readonly points: readonly TrendPoint[];
  readonly temperatureUnit: string | null;
  readonly precipitationUnit: string | null;
  /** True where the provider reported precipitation at all; no axis is drawn for an absent series. */
  readonly hasPrecipitation: boolean;
  /** How many entries the provider left unreported, stated rather than closed over. */
  readonly missing: number;
}

export function ForecastTrendChart({
  points,
  temperatureUnit,
  precipitationUnit,
  hasPrecipitation,
  missing,
}: ForecastTrendChartProps): ReactNode {
  return (
    <figure className={styles.trend}>
      <div
        className={styles.trendPlot}
        role="img"
        aria-label={
          `Forecast temperature${temperatureUnit ? ` in ${temperatureUnit}` : ""} across the ` +
          `selected horizon${hasPrecipitation ? ", with precipitation" : ""}. ` +
          `The figures are in the forecast matrix below.`
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={[...points]} margin={{ top: 8, right: 4, bottom: 4, left: 0 }}>
            <defs>
              {/* The artifact fills under its line. One stop pair, so the fill reads as a tint. */}
              <linearGradient id="explorer-temperature-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.32} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid
              stroke="var(--color-border-subtle)"
              strokeDasharray="0"
              vertical={false}
            />
            <XAxis dataKey="label" {...AXIS} interval={tickInterval(points.length)} minTickGap={8} />
            <YAxis
              yAxisId="temperature"
              {...AXIS}
              width={38}
              unit={temperatureUnit ? ` ${temperatureUnit}` : undefined}
            />
            {hasPrecipitation ? (
              <YAxis yAxisId="precipitation" orientation="right" {...AXIS} width={34} />
            ) : null}

            <Tooltip content={<Tip />} cursor={{ stroke: "var(--color-border-strong)" }} />

            {hasPrecipitation ? (
              <Bar
                yAxisId="precipitation"
                dataKey="precipitation"
                name="Precipitation"
                unit={precipitationUnit ?? ""}
                fill="var(--color-class-forecast)"
                radius={[2, 2, 0, 0]}
                maxBarSize={18}
                isAnimationActive={false}
              />
            ) : null}

            {/*
              `connectNulls` is deliberately off. An unreported hour is a hole in what the provider
              sent, and a line drawn straight through it would be this screen inventing the reading
              that is missing.
            */}
            <Area
              yAxisId="temperature"
              type="monotone"
              dataKey="temperature"
              name="Temperature"
              unit={temperatureUnit ?? ""}
              stroke="var(--color-accent)"
              strokeWidth={2}
              fill="url(#explorer-temperature-fill)"
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {missing > 0 ? (
        <figcaption className={styles.quiet}>
          {missing} {missing === 1 ? "entry" : "entries"} in this window{" "}
          {missing === 1 ? "was" : "were"} not reported by the provider and{" "}
          {missing === 1 ? "is" : "are"} left as a gap.
        </figcaption>
      ) : null}
    </figure>
  );
}
