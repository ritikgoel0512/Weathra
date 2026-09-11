"use client";

/**
 * The plot the Dashboard's baseline band closes on: each reference year's own mean, against the
 * baseline those means average to.
 *
 * **Why this is not `RecordedAgainstBaselineChart`.** That component is the right chart for an
 * archive audit and has four other callers — Historical Analytics, Forecast Explorer, Weather Watch
 * and the Scenario Lab — so the four things wrong with it *here* cannot be fixed there without
 * changing four screens this pass is not allowed to touch:
 *
 * - its y-axis starts at zero, which turned a real 13.6–15.8 °C spread into a flat line;
 * - it hangs the unit off the axis as a rotated label, which is the loudest thing in a small frame;
 * - its own x-axis is a series of dates, so its missing-point note says "day" where these are
 *   years;
 * - its figure table is opened by a full-width `Button`, which outweighs the plot beside it.
 *
 * Everything else it does is kept, because those parts were right: a gap stays a gap, the baseline
 * is dashed and named with the years behind it rather than drawn as a peer, and every value is also
 * text.
 *
 * **No arithmetic happens here.** The per-year means and the baseline are the backend's, passed
 * through untouched; this file chooses an axis and draws them.
 */

import { useId, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ScrollRegion } from "@/components/ui";
import type { YearlyMean } from "@/lib/api/schema";

import styles from "./dashboard.module.css";

/** One reference year, as the chart plots it. */
interface YearRow {
  readonly year: string;
  readonly value: number;
  readonly pointsUsed: number;
}

/**
 * The vertical window the figures actually occupy, padded so the line is readable.
 *
 * A zero-based axis is the honest default for a *magnitude* — a total, a count, a sum — because the
 * height of the mark is then proportional to the quantity. These are annual mean temperatures, and
 * no reading of them is proportional to its distance from 0 °C: the question the band asks is how
 * the years differ from each other, and a scale from zero answers it by hiding the difference. The
 * 2026-09-11 capture is the evidence — three means a full 2.2 °C apart drawn as one flat line.
 *
 * The padding is a tenth of the observed range on each side, floored at 0.5° so a set of nearly
 * equal years does not get a microscopic window that magnifies noise into a trend. Both bounds are
 * then rounded outwards to a half degree, so the ticks are readable numbers rather than the data's
 * own decimals. The axis is stated under the chart either way, because a scale that does not start
 * at zero is a thing a reader is entitled to be told rather than left to notice.
 */
export function baselineDomain(values: readonly number[]): [number, number] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max((high - low) / 10, 0.5);
  return [Math.floor((low - pad) * 2) / 2, Math.ceil((high + pad) * 2) / 2];
}

function YearTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: readonly { value?: number | null; payload?: YearRow }[];
  label?: string | number;
  unit: string | null;
}): ReactNode {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  const points = payload[0]?.payload?.pointsUsed;
  return (
    <div className={styles.chartTooltip}>
      <p className={styles.chartTooltipName}>{String(label)}</p>
      <p className={styles.chartTooltipValue}>
        {typeof value === "number" ? `${value}${unit ? ` ${unit}` : ""}` : "Not computable"}
      </p>
      {typeof points === "number" ? (
        <p className={styles.chartTooltipValue}>
          from {points} {points === 1 ? "day" : "days"}
        </p>
      ) : null}
    </div>
  );
}

export interface BaselineYearsChartProps {
  readonly years: readonly YearlyMean[];
  /** The baseline those years average to, drawn as the reference. Null where it is not computable. */
  readonly baselineValue: number | null;
  /** The unit the backend declared for the measure, or null where it declared none. */
  readonly unit: string | null;
  /** What the figures are — `Average temperature`, from the same phrasing the band's list uses. */
  readonly measureLabel: string;
}

export function BaselineYearsChart({
  years,
  baselineValue,
  unit,
  measureLabel,
}: BaselineYearsChartProps): ReactNode {
  const described = useId();
  const rows: YearRow[] = years.map((entry) => ({
    year: String(entry.year),
    value: entry.value,
    pointsUsed: entry.points_used,
  }));

  const plotted = rows.map((row) => row.value);
  const domain = baselineDomain(
    baselineValue === null ? plotted : [...plotted, baselineValue],
  );

  return (
    <figure className={styles.years}>
      {/*
        The unit lives here, next to what it measures, instead of rotated ninety degrees against
        the axis. One line at the meta step says what the marks are, what they are measured in and
        what the dashed line is — which is what the rotated label, the legend and the reference
        label were between them saying three times.
      */}
      <figcaption className={styles.yearsLegend}>
        <span className={styles.yearsLegendItem} data-series="year">
          {measureLabel}
          {unit ? ` (${unit})` : ""} per reference year
        </span>
        {baselineValue === null ? null : (
          <span className={styles.yearsLegendItem} data-series="baseline">
            {years.length}-year average
          </span>
        )}
      </figcaption>

      <ScrollRegion label="Reference years chart" className={styles.yearsScroll}>
        <div
          className={styles.yearsPlot}
          role="img"
          aria-label={`${measureLabel}${unit ? ` in ${unit}` : ""} for each reference year, from ${rows[0]?.year ?? "the first year"} to ${rows[rows.length - 1]?.year ?? "the last"}${
            baselineValue === null ? "" : `, against the ${years.length}-year average`
          }. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="0"
                vertical={false}
              />
              {/* Years, and labelled as years. These marks are one per year, not one per day. */}
              <XAxis
                dataKey="year"
                stroke="var(--color-border-strong)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                domain={domain}
                stroke="var(--color-border-strong)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                tickLine={false}
                width={38}
                // No `label`: the unit is in the caption above, where it is read rather than
                // decoded. See the note on this component.
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={<YearTooltip unit={unit} />}
              />

              {baselineValue === null ? null : (
                /* Dashed and named, so the baseline reads as a reference rather than as a peer. */
                <ReferenceLine
                  y={baselineValue}
                  stroke="var(--color-class-analytics)"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                />
              )}

              <Line
                type="linear"
                dataKey="value"
                name={measureLabel}
                stroke="var(--color-class-historical)"
                strokeWidth={2.5}
                // A dot per year: there are a handful of marks and each one is a figure somebody
                // may want to point at, which is not true of 24 hourly readings.
                dot={{ r: 3.5, strokeWidth: 0, fill: "var(--color-class-historical)" }}
                activeDot={{ r: 5 }}
                // A year the archive could not compute a mean for breaks the line rather than
                // being bridged. `build_baseline` drops such a year, so this is belt and braces.
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.yearsNote} id={described}>
        {`One mark per year the archive reported. The scale runs ${domain[0]}–${domain[1]}${
          unit ? ` ${unit}` : ""
        } rather than from zero, so the difference between the years is visible.`}
      </p>

      {/* Every value is also text — and a disclosure rather than a full-width button, so the
          control does not outweigh the plot it belongs to. */}
      <details className={styles.yearsFigures}>
        <summary className={styles.yearsFiguresSummary}>Show the figures</summary>
        <table className={styles.yearsTable}>
          <caption className={styles.yearsTableCaption}>
            {measureLabel} per reference year, and the days each was computed from.
          </caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">
                {measureLabel}
                {unit ? ` (${unit})` : ""}
              </th>
              <th scope="col">Days used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <th scope="row">{row.year}</th>
                <td>{row.value}</td>
                <td>{row.pointsUsed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
