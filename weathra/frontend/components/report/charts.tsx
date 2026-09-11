"use client";

/**
 * The Weather Intelligence Report's plots — the graphical half of
 * `docs/design/screens/12-weather-intelligence-report.png`.
 *
 * The artifact is a *report with charts through it*: a forecast timeline, a plotted comparison
 * against the record, and a deviation figure. The implementation had the artifact's sections and
 * none of its graphics — six stacked cards of `<dl>` figures and prose — which the production
 * fidelity review of 2026-09-10 graded NOT CLOSE for exactly that reason. These are the plots that
 * close it.
 *
 * **Every series here is retrieved or deterministically computed, and nothing is drawn that was not
 * returned.** A measure the provider did not supply has no axis, no bar and no line: the caller
 * omits the chart rather than passing zeros, and `EmptyChart` keeps the geometry when a region is
 * expected but the series behind it is absent. `docs/design/screens.md` §5 refuses the artifact's
 * convergence percentages, sensor nodes and model-consensus figures; none of them appears here.
 *
 * **The chart idiom is `components/historical/charts.tsx`'s, deliberately.** Same recessive axis
 * treatment, same solid hairline grid, same `connectNulls={false}` so a gap is a gap, same
 * "the figures are also a table" rule. What is not shared is the *wording*: those charts describe
 * an archive that did not report, and this window is a forecast, so a copy would have printed the
 * wrong noun on every note. The geometry is common; the sentence is per surface.
 *
 * **Two axes, and why that is allowed here when `historical/charts.tsx` refused it.** The refusal
 * there was against putting temperature and precipitation on left and right scales *of the same
 * plot* so the reader infers a correlation from where the axes were placed. The temperature line
 * and the precipitation bars below it are the same objection, so they are not overlaid: the bars
 * are drawn against their own axis in their own band at the foot of the plot, which is the
 * artifact's own arrangement and is read as two stacked facts rather than as one crossing.
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button, ScrollRegion } from "@/components/ui";

import styles from "./report.module.css";

/** The axis and grid treatment every Weathra chart shares: recessive, solid, hairline. */
const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

/** One plotted instant: what to print on the axis, and the values measured at it. */
export interface TimelinePoint {
  /** The axis label, read out of the local timestamp as text. No timezone is re-applied. */
  readonly label: string;
  /** The full local timestamp, for the tooltip and the table. */
  readonly stamp: string;
  readonly temperature: number | null;
  readonly precipitation: number | null;
}

/**
 * A local timestamp's day and hour, as text.
 *
 * Sliced rather than parsed: `2026-09-04T12:00:00+02:00` already *is* the local reading, and
 * putting it through `Date` would re-apply an offset to a figure that has one. Same reasoning as
 * `localDateOf` in `lib/historical/analysis.ts`.
 */
export function hourLabelOf(timeLocal: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(timeLocal);
  if (match === null) return timeLocal;
  return `${match[2]}/${match[1]} ${match[3]}`;
}

/** The tooltip, which enhances the axis and the table rather than gating either. */
function TimelineTooltip({
  active,
  payload,
  temperatureUnit,
  precipitationUnit,
}: {
  active?: boolean;
  payload?: readonly { payload?: TimelinePoint }[];
  temperatureUnit: string | null;
  precipitationUnit: string | null;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipStamp}>{point.stamp}</p>
      <p className={styles.tooltipValue}>
        Temperature:{" "}
        {point.temperature === null
          ? "not reported"
          : `${point.temperature}${temperatureUnit ? ` ${temperatureUnit}` : ""}`}
      </p>
      {point.precipitation === null ? null : (
        <p className={styles.tooltipValue}>
          Precipitation: {point.precipitation}
          {precipitationUnit ? ` ${precipitationUnit}` : ""}
        </p>
      )}
    </div>
  );
}

/** The plotted figures as a table, behind one control. A number is never only a pixel. */
function TimelineFigures({
  points,
  temperatureUnit,
  precipitationUnit,
  caption,
}: {
  readonly points: readonly TimelinePoint[];
  readonly temperatureUnit: string | null;
  readonly precipitationUnit: string | null;
  readonly caption: string;
}): ReactNode {
  const [shown, setShown] = useState(false);

  return (
    <div className={styles.figures}>
      <Button size="sm" onClick={() => setShown((open) => !open)} aria-expanded={shown}>
        {shown ? "Hide the figures" : "Show the figures"}
      </Button>
      {shown ? (
        <ScrollRegion label={`${caption} figures`} className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Temperature{temperatureUnit ? ` (${temperatureUnit})` : null}</th>
                <th scope="col">
                  Precipitation{precipitationUnit ? ` (${precipitationUnit})` : null}
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.stamp}>
                  <th scope="row">{point.stamp}</th>
                  {/* Never a zero for an absent reading: they are different facts. */}
                  <td>{point.temperature === null ? "not reported" : point.temperature}</td>
                  <td>{point.precipitation === null ? "not reported" : point.precipitation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      ) : null}
    </div>
  );
}

export interface ForecastTimelineChartProps {
  readonly points: readonly TimelinePoint[];
  readonly temperatureUnit: string | null;
  readonly precipitationUnit: string | null;
  /** The baseline mean, drawn as the reference the artifact draws. Null when none was computed. */
  readonly baselineValue: number | null;
  /** What the reference line is, in words — the years behind it. */
  readonly baselineLabel: string | null;
  /** Hours in the window the provider reported no temperature for. Stated, never smoothed over. */
  readonly missing: number;
  readonly title: string;
}

/**
 * The forecast window: temperature through it, precipitation under it, the record behind it.
 *
 * This is the artifact's central plot. The temperature line carries `class-forecast`, the baseline
 * reference `class-analytics` and the precipitation bars `class-observed`, which are the same three
 * colours as the badges beside them — the chart and its labels cannot disagree about what a series
 * is.
 */
export function ForecastTimelineChart({
  points,
  temperatureUnit,
  precipitationUnit,
  baselineValue,
  baselineLabel,
  missing,
  title,
}: ForecastTimelineChartProps): ReactNode {
  const described = useId();
  const hasPrecipitation = points.some((point) => typeof point.precipitation === "number");

  return (
    <figure className={styles.chart} data-chart="forecast-timeline">
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="forecast" /> Temperature
          </span>
          {baselineValue === null ? null : (
            <span className={styles.legendItem}>
              <span className={styles.legendLine} data-series="baseline" /> Baseline
            </span>
          )}
          {hasPrecipitation ? (
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} data-series="precipitation" /> Precipitation
            </span>
          ) : null}
        </span>
      </figcaption>

      <ScrollRegion label={`${title} chart`} className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`${title}. Forecast temperature${
            temperatureUnit ? ` in ${temperatureUnit}` : ""
          }${baselineLabel ? `, against ${baselineLabel}` : ""}${
            hasPrecipitation ? ", with precipitation per reported hour" : ""
          }. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={[...points]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              {/* Solid hairlines: a dashed grid reads as a threshold that is not there. */}
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="0"
                vertical={false}
              />
              <XAxis dataKey="label" {...AXIS} minTickGap={28} />
              <YAxis
                yAxisId="temperature"
                {...AXIS}
                width={52}
                label={
                  temperatureUnit
                    ? {
                        value: temperatureUnit,
                        angle: -90,
                        position: "insideLeft",
                        fill: "var(--color-text-muted)",
                        fontSize: 11,
                      }
                    : undefined
                }
              />
              {hasPrecipitation ? (
                <YAxis
                  yAxisId="precipitation"
                  orientation="right"
                  {...AXIS}
                  width={44}
                  label={
                    precipitationUnit
                      ? {
                          value: precipitationUnit,
                          angle: 90,
                          position: "insideRight",
                          fill: "var(--color-text-muted)",
                          fontSize: 11,
                        }
                      : undefined
                  }
                />
              ) : null}
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={
                  <TimelineTooltip
                    temperatureUnit={temperatureUnit}
                    precipitationUnit={precipitationUnit}
                  />
                }
              />
              {baselineValue === null ? null : (
                <ReferenceLine
                  yAxisId="temperature"
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
              {hasPrecipitation ? (
                <Bar
                  yAxisId="precipitation"
                  dataKey="precipitation"
                  name="Precipitation"
                  fill="var(--color-class-observed)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={18}
                  isAnimationActive={false}
                />
              ) : null}
              <Line
                yAxisId="temperature"
                type="linear"
                dataKey="temperature"
                name="Temperature"
                stroke="var(--color-class-forecast)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                // An hour the provider did not report breaks the line rather than being bridged.
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {missing === 0
          ? "Every hour in this window was reported by the provider."
          : `${missing} ${missing === 1 ? "hour" : "hours"} in this window ${
              missing === 1 ? "was" : "were"
            } not reported and ${missing === 1 ? "is" : "are"} left as a gap.`}
      </p>

      <TimelineFigures
        points={points}
        temperatureUnit={temperatureUnit}
        precipitationUnit={precipitationUnit}
        caption={title}
      />
    </figure>
  );
}

/** One entry that stood out, as the backend scored it. */
export interface DeviationPoint {
  readonly label: string;
  readonly stamp: string;
  /** Signed distance from the series median, in the measure's own unit. */
  readonly deviation: number;
  /** In median-absolute-deviations — what the threshold is compared against. */
  readonly score: number;
}

export interface DeviationChartProps {
  readonly points: readonly DeviationPoint[];
  /** The score beyond which the backend called an entry anomalous. Drawn as the reference. */
  readonly threshold: number;
  readonly unit: string | null;
  readonly title: string;
  readonly method: string;
}

/**
 * How far each flagged entry sat from the window's median, against the threshold that flagged it.
 *
 * The artifact's "2.84 σ OUTLIER" tile as a plot. The bar is the entry's deviation *score*, which
 * is the figure the threshold is expressed in, so the reference line and the bars share a scale —
 * plotting the raw deviation against a score threshold would draw a line that means nothing where
 * it is drawn. The unit-bearing deviation is in the tooltip and the label, where it is a fact
 * rather than a geometry.
 */
export function DeviationChart({
  points,
  threshold,
  unit,
  title,
  method,
}: DeviationChartProps): ReactNode {
  const described = useId();
  const rows = useMemo(() => [...points], [points]);

  return (
    <figure className={styles.chart} data-chart="deviation">
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="threshold" /> Threshold {threshold}
          </span>
        </span>
      </figcaption>

      <ScrollRegion label={`${title} chart`} className={styles.chartScroll}>
        <div
          className={styles.chartPlotShort}
          role="img"
          aria-label={`${title}. Deviation score per flagged entry, against a threshold of ${threshold}. The figures are in the list below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="0"
                vertical={false}
              />
              <XAxis dataKey="label" {...AXIS} minTickGap={20} />
              <YAxis {...AXIS} width={40} />
              <ReferenceLine
                y={threshold}
                stroke="var(--color-status-warning)"
                strokeDasharray="5 4"
                strokeWidth={2}
              />
              <Bar dataKey="score" name="Deviation score" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                {rows.map((row) => (
                  <Cell
                    key={row.stamp}
                    fill={
                      row.score >= threshold
                        ? "var(--color-status-warning)"
                        : "var(--color-class-analytics)"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {method}
      </p>

      <ul className={styles.deviationList}>
        {rows.map((row) => (
          <li key={row.stamp}>
            <span className={styles.deviationStamp}>{row.stamp}</span>
            <span className={styles.deviationValue}>
              {row.deviation > 0 ? "+" : ""}
              {row.deviation}
              {unit ? ` ${unit}` : ""} · {row.score} from the median
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
