"use client";

/**
 * The comparison chart — task 21.4, in the shared chart frame of
 * `docs/design/design-system.md` §7.
 *
 * One bar per candidate, one measure, one axis. The artifact puts a dual-axis line-and-bar chart
 * and a financial candlestick panel here; `docs/design/screens.md` §5 already refuses the
 * candlestick, and a second y-axis would make any relationship between two curves an artifact of
 * where the axes were placed. What a comparison actually needs is the one figure the ranking turns
 * on, drawn once per place.
 *
 * **The bar is the measurement, not the score.** For a single-measure criterion the backend negates
 * the score when lower is better, so "driest" arrives as a negative number whose magnitude is a
 * precipitation total. `comparableFigure` unwinds that: the bar carries the supporting statistic's
 * own value in its own unit, and the rank stays on the card where it belongs.
 *
 * **Every value is also text.** The figure table beneath the chart carries each candidate's number
 * and rank, so nothing here is readable only as a pixel or only through a tooltip.
 *
 * **The bars wear the class of the figures they draw**, which is finding 4.4 of the runtime
 * fidelity audit of 2026-09-08. They were the ANALYTICS violet on every comparison — the colour of
 * the *ranking*, which is a computation, applied to marks that are not the score. The bar is the
 * supporting statistic's own measured value, so it takes that data's own class: FORECAST for a
 * comparison over a forecast window, HISTORICAL for one over the archive, exactly as the two
 * Historical Analytics charts already colour their observed and computed series. `SharedBasis`
 * badges the same class in words beside the chart, so the colour repeats a stated fact rather than
 * carrying one alone.
 *
 * Every class colour is measured against `surface-raised` at 3:1 by `lib/design/tokens.test.ts`'s
 * contrast table, whose stated reason is that a class colour is also a chart series — so this
 * switches between colours the suite already holds to that floor rather than introducing one.
 */

import { useId, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui";
import type { ComparisonResult } from "@/lib/api/schema";
import { criterionLabel, rankedRows } from "@/lib/comparison/ranking";
import { dataClassFor } from "@/lib/design/data-class";

import styles from "./compare.module.css";

const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  name,
}: {
  active?: boolean;
  payload?: readonly { value?: number | null }[];
  label?: string | number;
  unit: string | null;
  name: string;
}): ReactNode {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        {name}: {typeof value === "number" ? `${value}${unit ? ` ${unit}` : ""}` : "not reported"}
      </p>
    </div>
  );
}

export interface ComparisonChartProps {
  readonly result: ComparisonResult;
}

/** The candidates' comparable figures, side by side in rank order. */
export function ComparisonChart({ result }: ComparisonChartProps): ReactNode {
  const { rows, unit, label } = rankedRows(result);
  const [shown, setShown] = useState(false);
  const described = useId();

  // A one-bar chart is a stat tile with extra chrome, and a comparison of one is not a comparison.
  if (rows.length < 2 || label === null) return null;

  const title = `${label.charAt(0).toUpperCase()}${label.slice(1)} by place`;

  /*
   * The class of the figures the bars draw. ANALYTICS remains the fallback for a result whose class
   * the backend did not report: the bar is still a figure a computation selected, so the ranking's
   * own class is the honest answer when the data's is unknown.
   */
  const sourceClass = dataClassFor(result.data_class) ?? "analytics";

  return (
    <figure className={styles.chart} data-chart="comparison" data-series-class={sourceClass}>
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.note}>
          Ranked by {criterionLabel(result.criterion).toLowerCase()}
        </span>
      </figcaption>

      <div className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`${title}${unit ? `, in ${unit}` : ""}, for ${rows.length} places. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[...rows]} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barCategoryGap={8}>
              {/* Solid hairlines: a dashed grid reads as a threshold that is not there. */}
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
              <XAxis dataKey="label" {...AXIS} interval={0} />
              <YAxis
                {...AXIS}
                width={56}
                label={
                  unit
                    ? { value: unit, angle: -90, position: "insideLeft", fill: "var(--color-text-muted)", fontSize: 11 }
                    : undefined
                }
              />
              <Tooltip
                cursor={{ fill: "var(--color-surface-raised)" }}
                content={<ChartTooltip unit={unit} name={label} />}
              />
              <Bar
                dataKey="value"
                name={label}
                fill={`var(--color-class-${sourceClass})`}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p className={styles.chartNote} id={described}>
        One bar per place, over the shared window. The bar is the measured figure the ranking turns
        on, not the rank.
      </p>

      <div className={styles.figures}>
        <Button size="sm" onClick={() => setShown((open) => !open)} aria-expanded={shown}>
          {shown ? "Hide the figures" : "Show the figures"}
        </Button>
        {shown ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.tableCaption}>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">Place</th>
                  <th scope="col">Rank</th>
                  <th scope="col">
                    {label}
                    {unit ? ` (${unit})` : null}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>
                      {row.rank}
                      {row.tied ? " (tied)" : null}
                    </td>
                    <td>{Math.round(row.value * 10) / 10}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
