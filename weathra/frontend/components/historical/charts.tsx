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
  ComposedChart,
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
/**
 * Both series as text, behind one control.
 *
 * The combined plot has one accessible name and two series, so its text alternative has to carry
 * both — a table of temperatures alone would describe half the figure. Same control, same wording
 * and same behaviour as the single-series table above; a `—` is a day the archive did not report,
 * which is not the same fact as a zero and is not written as one.
 */
function OverviewFigureTable({
  rows,
  temperatureUnit,
  precipitationUnit,
  caption,
  hasPrecipitation,
}: {
  readonly rows: readonly {
    readonly date: string;
    readonly temperature: number | null;
    readonly precipitation: number | null;
  }[];
  readonly temperatureUnit: string | null;
  readonly precipitationUnit: string | null;
  readonly caption: string;
  readonly hasPrecipitation: boolean;
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
                  Mean temperature{temperatureUnit ? ` (${temperatureUnit})` : null}
                </th>
                {hasPrecipitation ? (
                  <th scope="col">
                    Precipitation total{precipitationUnit ? ` (${precipitationUnit})` : null}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.date}>
                  <th scope="row">{row.date}</th>
                  {/* "not reported", not a dash and never a zero: a day the archive did not
                      answer for is a different fact from a day it measured as nothing. */}
                  <td>{row.temperature === null ? "not reported" : row.temperature}</td>
                  {hasPrecipitation ? (
                    <td>{row.precipitation === null ? "not reported" : row.precipitation}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The artifact's centrepiece: temperature against its baseline, with precipitation beneath it.
 *
 * `03-historical-analytics.png` draws one plot, not two — a temperature line, a dashed normal, and
 * precipitation bars on their own right-hand axis. Weathra was drawing the line and the bars as two
 * separate figures stacked down the page, which is the same data in half the density and loses the
 * one thing a combined plot is *for*: seeing that the wet days were the cold ones.
 *
 * Both series are the archive's own. The baseline is a reference line at the mean the backend
 * computed over the years it actually used, and it is absent rather than guessed when no baseline
 * was returned. A day the archive did not report breaks the line rather than being bridged, and
 * contributes no bar.
 */
export function ArchiveOverviewChart({
  points,
  temperature,
  precipitation,
  temperatureUnit,
  precipitationUnit,
  baselineValue,
  baselineLabel,
  title,
  missing,
}: {
  readonly points: readonly HistoricalPoint[];
  readonly temperature: string;
  readonly precipitation: string | null;
  readonly temperatureUnit: string | null;
  readonly precipitationUnit: string | null;
  readonly baselineValue: number | null;
  readonly baselineLabel: string | null;
  readonly title: string;
  readonly missing: number;
}): ReactNode {
  const described = useId();
  const rows = points.map((point) => ({
    // `point.date` is already the local calendar date, read as text so no timezone is re-applied.
    date: point.date,
    temperature: point.values[temperature] ?? null,
    precipitation: precipitation === null ? null : (point.values[precipitation] ?? null),
  }));

  return (
    <figure className={styles.chart} data-chart="archive-overview">
      <figcaption className={styles.chartCaption}>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="recorded" /> Recorded
          </span>
          {baselineValue === null ? null : (
            <span className={styles.legendItem}>
              <span className={styles.legendLine} data-series="baseline" /> Normal
            </span>
          )}
          {precipitation === null ? null : (
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} data-series="precipitation" /> Precipitation
            </span>
          )}
        </span>
      </figcaption>

      <ScrollRegion label={`${title} chart`} className={styles.chartScroll}>
        <div
          className={styles.chartPlotTall}
          role="img"
          aria-label={`${title}. Recorded temperature${
            temperatureUnit ? ` in ${temperatureUnit}` : ""
          }${baselineLabel ? `, against ${baselineLabel}` : ""}${
            precipitation === null ? "" : ", with daily precipitation"
          }. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
              <XAxis dataKey="date" {...AXIS} minTickGap={24} />
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
              {precipitation === null ? null : (
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
              )}
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={<OverviewTooltip temperatureUnit={temperatureUnit} precipitationUnit={precipitationUnit} />}
              />
              {baselineValue === null ? null : (
                <ReferenceLine
                  yAxisId="temperature"
                  y={baselineValue}
                  stroke="var(--color-class-analytics)"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  label={{
                    value: baselineLabel ?? "Normal",
                    position: "insideTopRight",
                    fill: "var(--color-text-muted)",
                    fontSize: 11,
                  }}
                />
              )}
              {precipitation === null ? null : (
                <Bar
                  yAxisId="precipitation"
                  dataKey="precipitation"
                  name="Precipitation"
                  fill="var(--color-class-forecast)"
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
              )}
              <Line
                yAxisId="temperature"
                type="monotone"
                dataKey="temperature"
                name="Recorded"
                stroke="var(--color-class-historical)"
                strokeWidth={2}
                /*
                 * Dots, not a bare line. A day the archive did not report breaks the series, and a
                 * broken series is drawn as isolated points — which `dot={false}` renders as
                 * nothing at all. The 1440 capture of 2026-09-10 showed a chart with no temperature
                 * on it for exactly that reason: two reported days either side of one gap.
                 */
                dot={{ r: 2, strokeWidth: 0, fill: "var(--color-class-historical)" }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {missing === 0
          ? "Every day in this window was reported by the archive."
          : `${missing} ${missing === 1 ? "day" : "days"} in this window ${
              missing === 1 ? "was" : "were"
            } not reported by the archive and ${missing === 1 ? "is" : "are"} left as a gap.`}
      </p>

      <OverviewFigureTable
        rows={rows}
        temperatureUnit={temperatureUnit}
        precipitationUnit={precipitationUnit}
        caption={title}
        hasPrecipitation={precipitation !== null}
      />
    </figure>
  );
}

/** Both series at one date, each named and each with its own unit. */
function OverviewTooltip({
  active,
  payload,
  label,
  temperatureUnit,
  precipitationUnit,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: string | number; value?: number | null }[];
  label?: string | number;
  temperatureUnit: string | null;
  precipitationUnit: string | null;
}): ReactNode {
  if (!active || !payload?.length) return null;
  const at = (key: string): number | null | undefined =>
    payload.find((entry) => entry.dataKey === key)?.value;
  const temperature = at("temperature");
  const rain = at("precipitation");

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        Recorded:{" "}
        {typeof temperature === "number"
          ? `${temperature}${temperatureUnit ? ` ${temperatureUnit}` : ""}`
          : "not reported"}
      </p>
      {rain === undefined ? null : (
        <p className={styles.tooltipValue}>
          Precipitation:{" "}
          {typeof rain === "number"
            ? `${rain}${precipitationUnit ? ` ${precipitationUnit}` : ""}`
            : "not reported"}
        </p>
      )}
    </div>
  );
}

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
