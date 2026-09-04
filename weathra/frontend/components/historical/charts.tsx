"use client";

/**
 * Historical Analytics' charts — task 21.3, in the shared chart frame of
 * `docs/design/design-system.md` §7 (Recharts, per design.md decision 18).
 *
 * **Two charts, not one with two axes.** The artifact draws temperature and precipitation together
 * against a left and a right scale. A second y-axis makes any relationship between the two curves
 * an artifact of where the axes were placed — the same data reads as correlated or uncorrelated
 * depending on a choice nobody declared. So the two measures get one chart each, one axis each,
 * each labelled with its own unit. Recorded in `docs/design/screens.md` §8.
 *
 * **A series' colour is its data class.** The recorded line wears `class-historical` and the
 * baseline wears `class-analytics`, the same two colours as the badges beside them, so the chart
 * and the labels cannot disagree about what a line is. The baseline is dashed and named with the
 * years behind it, because §7 asks for a baseline to read as a reference rather than as a peer.
 *
 * **A gap is a gap.** `connectNulls` is off and no smoothing is applied. A day the archive did not
 * report leaves a break in the line, and the count of such days is stated beneath the chart. Drawing
 * through it would be inventing an observation.
 *
 * **Every value is also text.** Each chart ships a table of its own figures, so a number is never
 * only a pixel and never only a tooltip.
 */

import { useId, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button, ScrollRegion } from "@/components/ui";
import type { HistoricalPoint } from "@/lib/historical/analysis";

import styles from "./historical.module.css";

/** The axis and grid treatment every Weathra chart shares: recessive, solid, hairline. */
const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

interface ChartRow {
  readonly date: string;
  readonly value: number | null;
}

function rowsFor(points: readonly HistoricalPoint[], measure: string): ChartRow[] {
  return points.map((point) => {
    const value = point.values[measure];
    // A null stays null. Recharts leaves a break for it, which is what an unreported day is.
    return { date: point.date, value: typeof value === "number" ? value : null };
  });
}

/** The tooltip, which enhances the axis and the table rather than gating either. */
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
      <p className={styles.tooltipDate}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        {name}: {typeof value === "number" ? `${value}${unit ? ` ${unit}` : ""}` : "not reported"}
      </p>
    </div>
  );
}

/** The figures of one chart, as a table. Toggled, so it is available without crowding the chart. */
function FigureTable({
  rows,
  unit,
  caption,
  valueLabel,
}: {
  readonly rows: readonly ChartRow[];
  readonly unit: string | null;
  readonly caption: string;
  readonly valueLabel: string;
}): ReactNode {
  const [shown, setShown] = useState(false);

  return (
    <div className={styles.figures}>
      <Button size="sm" onClick={() => setShown((open) => !open)} aria-expanded={shown}>
        {shown ? "Hide the figures" : "Show the figures"}
      </Button>
      {shown ? (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">
                  {valueLabel}
                  {unit ? ` (${unit})` : null}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.date}>
                  <th scope="row">{row.date}</th>
                  {/* Never a zero for an absent reading. */}
                  <td>{row.value === null ? "not reported" : row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export interface HistoricalChartProps {
  readonly points: readonly HistoricalPoint[];
  readonly measure: string;
  readonly unit: string | null;
  /** What the series is called, in words. Names the chart, so one series needs no legend. */
  readonly seriesLabel: string;
  readonly title: string;
  /** The number of days in the window the archive did not report. Stated, never smoothed over. */
  readonly missing: number;
}

export interface TemperatureChartProps extends HistoricalChartProps {
  /** The baseline mean, drawn as a reference. Null when the backend computed none. */
  readonly baselineValue: number | null;
  /** The years the baseline covers, so the reference line says what it is. */
  readonly baselineLabel: string | null;
}

/**
 * The recorded series against its baseline.
 *
 * Two series, so a legend is present; the baseline is also direct-labelled on its own line, which
 * is where the years behind it belong.
 */
export function RecordedAgainstBaselineChart({
  points,
  measure,
  unit,
  seriesLabel,
  title,
  missing,
  baselineValue,
  baselineLabel,
}: TemperatureChartProps): ReactNode {
  const rows = rowsFor(points, measure);
  const described = useId();

  return (
    <figure className={styles.chart} data-chart="recorded-against-baseline">
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="recorded" /> {seriesLabel}
          </span>
          {baselineValue === null ? null : (
            <span className={styles.legendItem}>
              <span className={styles.legendLine} data-series="baseline" /> Baseline
            </span>
          )}
        </span>
      </figcaption>

      <ScrollRegion label={`${title} chart`} className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`${title}. ${seriesLabel}${unit ? ` in ${unit}` : ""}${
            baselineLabel ? `, against ${baselineLabel}` : ""
          }. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              {/* Solid hairlines: a dashed grid reads as a threshold that is not there. */}
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
              <XAxis dataKey="date" {...AXIS} minTickGap={24} />
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
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={<ChartTooltip unit={unit} name={seriesLabel} />}
              />
              {baselineValue === null ? null : (
                <ReferenceLine
                  y={baselineValue}
                  stroke="var(--color-class-analytics)"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  label={{
                    value: baselineLabel ?? "Baseline",
                    position: "insideTopRight",
                    fill: "var(--color-text-muted)",
                    fontSize: 11,
                  }}
                />
              )}
              <Line
                type="linear"
                dataKey="value"
                name={seriesLabel}
                stroke="var(--color-class-historical)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                // A day the archive did not report breaks the line rather than being bridged.
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {missing === 0
          ? "Every day in this window was reported by the archive."
          : `${missing} ${missing === 1 ? "day" : "days"} in this window ${missing === 1 ? "was" : "were"} not reported by the archive and ${missing === 1 ? "is" : "are"} left as a gap.`}
      </p>

      <FigureTable rows={rows} unit={unit} valueLabel={seriesLabel} caption={title} />
    </figure>
  );
}

/** The recorded precipitation, as bars on their own scale. One series, so the title names it. */
export function PrecipitationChart({
  points,
  measure,
  unit,
  seriesLabel,
  title,
  missing,
}: HistoricalChartProps): ReactNode {
  const rows = rowsFor(points, measure);
  const described = useId();

  return (
    <figure className={styles.chart} data-chart="precipitation">
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
      </figcaption>

      <ScrollRegion label={`${title} chart`} className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`${title}. ${seriesLabel}${unit ? ` in ${unit}` : ""}. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barCategoryGap={2}>
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
              <XAxis dataKey="date" {...AXIS} minTickGap={24} />
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
                content={<ChartTooltip unit={unit} name={seriesLabel} />}
              />
              <Bar
                dataKey="value"
                name={seriesLabel}
                fill="var(--color-class-historical)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {missing === 0
          ? "Every day in this window was reported by the archive."
          : `${missing} ${missing === 1 ? "day" : "days"} in this window ${missing === 1 ? "was" : "were"} not reported by the archive and ${missing === 1 ? "is" : "are"} shown as no bar rather than as zero.`}
      </p>

      <FigureTable rows={rows} unit={unit} valueLabel={seriesLabel} caption={title} />
    </figure>
  );
}
