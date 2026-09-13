"use client";

/**
 * Temporal Watch Analysis — the selected watch's series against the number somebody typed.
 *
 * This is the chart the screen exists for, and the one the previous build got wrong: it drew a
 * generic temperature forecast with no threshold on it at all, so the plot beside a watch could not
 * answer the only question the watch asks. Here the threshold is a line, the hours that satisfy the
 * condition are shaded, and the first crossing is marked — which together make "when and why is this
 * met" a thing you read rather than work out.
 *
 * **The shaded part and the plotted part are one field.** `breach` carries the same number as
 * `value`, present only on the hours past the line. Drawing it as a second area means what is shaded
 * and what is plotted cannot disagree; a computed band would be a second opinion about the same
 * comparison.
 *
 * **A gap is a gap.** `connectNulls={false}`: an hour the provider reported nothing for breaks the
 * line rather than being bridged, which is the rule every chart in this product follows.
 */

import { useId, useState, type ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button, ScrollRegion } from "@/components/ui";
import { formatMeasured, placesFor, roundTo } from "@/lib/format/figures";
import type { ThresholdPoint } from "@/lib/watch/view-model";

import styles from "./watch.module.css";

/** The axis and grid treatment every Weathra chart shares: recessive, solid, hairline. */
const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

function WatchTooltip({
  active,
  payload,
  unit,
  comparison,
}: {
  active?: boolean;
  payload?: readonly { payload?: ThresholdPoint }[];
  unit: string | null;
  comparison: string;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipStamp}>{point.stamp}</p>
      <p className={styles.tooltipValue}>
        {point.value === null ? "Not reported" : formatMeasured(point.value, unit)}
      </p>
      <p className={styles.tooltipNote}>
        {point.breach === null
          ? `Not ${comparison} ${formatMeasured(point.threshold, unit)}`
          : `${comparison === "above" ? "Above" : "Below"} ${formatMeasured(point.threshold, unit)}`}
      </p>
    </div>
  );
}

/** The plotted figures as a table, behind one control. A number is never only a pixel. */
function WatchFigures({
  points,
  unit,
}: {
  readonly points: readonly ThresholdPoint[];
  readonly unit: string | null;
}): ReactNode {
  const [shown, setShown] = useState(false);

  return (
    <div className={styles.figures}>
      <Button size="sm" onClick={() => setShown((open) => !open)} aria-expanded={shown}>
        {shown ? "Hide the figures" : "Show the figures"}
      </Button>
      {shown ? (
        <ScrollRegion label="Watch figures" className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>
              The retrieved window against the threshold, hour by hour
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Reading{unit ? ` (${unit})` : null}</th>
                <th scope="col">Past the threshold</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.stamp}>
                  <th scope="row">{point.stamp}</th>
                  {/* Never a zero for an absent reading: they are different facts. */}
                  <td>
                    {point.value === null ? "not reported" : roundTo(point.value, placesFor(unit))}
                  </td>
                  <td>{point.value === null ? "—" : point.breach === null ? "No" : "Yes"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      ) : null}
    </div>
  );
}

export function TemporalWatchChart({
  points,
  unit,
  comparison,
  measureLabel,
  crossingStamp,
}: {
  readonly points: readonly ThresholdPoint[];
  readonly unit: string | null;
  readonly comparison: string;
  readonly measureLabel: string;
  /** The local instant of the first crossing, marked on the axis where there is one. */
  readonly crossingStamp: string | null;
}): ReactNode {
  const described = useId();
  const threshold = points[0]?.threshold ?? 0;
  const missing = points.filter((point) => point.value === null).length;
  const breaching = points.filter((point) => point.breach !== null).length;
  const crossingLabel =
    crossingStamp === null
      ? null
      : (points.find((point) => point.stamp === crossingStamp)?.label ?? null);

  if (points.length === 0) {
    return (
      <p className={styles.chartUnavailable}>
        The forecast behind this watch could not be retrieved, so there is nothing to plot. The
        figures beside it are from the last check that did complete.
      </p>
    );
  }

  return (
    <figure className={styles.chart} data-chart="temporal-watch">
      <figcaption className={styles.chartCaption}>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="reading" /> {measureLabel}
          </span>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="threshold" /> Threshold
          </span>
          {breaching > 0 ? (
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} data-series="breach" /> Condition holds
            </span>
          ) : null}
        </span>
      </figcaption>

      <ScrollRegion label="Temporal watch analysis chart" className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`${measureLabel} through the retrieved window${
            unit ? ` in ${unit}` : ""
          }, against a threshold of ${formatMeasured(threshold, unit)}. ${
            breaching === 0
              ? "No hour in the window is past the threshold."
              : `${breaching} of ${points.length} hours are past it.`
          } The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={[...points]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <defs>
                <linearGradient id="watch-breach" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-status-warning)" stopOpacity={0.34} />
                  <stop offset="100%" stopColor="var(--color-status-warning)" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              {/* Solid hairlines: a dashed grid reads as a threshold that is not there. */}
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="0"
                vertical={false}
              />
              <XAxis dataKey="label" {...AXIS} minTickGap={28} />
              <YAxis
                {...AXIS}
                width={52}
                label={
                  unit
                    ? {
                        value: unit,
                        angle: -90,
                        position: "insideLeft",
                        fill: "var(--color-text-muted)",
                        fontSize: 11,
                      }
                    : undefined
                }
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={<WatchTooltip unit={unit} comparison={comparison} />}
              />

              {/* The hours the condition holds, shaded under the line that produced them. */}
              <Area
                type="monotone"
                dataKey="breach"
                name="Condition holds"
                stroke="none"
                fill="url(#watch-breach)"
                connectNulls={false}
                isAnimationActive={false}
              />

              {/* The number somebody typed, drawn as what it is: a level, not a measurement. */}
              <ReferenceLine
                y={threshold}
                stroke="var(--color-status-warning)"
                strokeDasharray="5 4"
                strokeWidth={1.6}
              />
              {crossingLabel === null ? null : (
                <ReferenceLine
                  x={crossingLabel}
                  stroke="var(--color-status-warning)"
                  strokeDasharray="2 3"
                  strokeWidth={1.2}
                />
              )}

              <Line
                type="monotone"
                dataKey="value"
                name={measureLabel}
                stroke="var(--color-accent)"
                strokeWidth={2.2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      <p className={styles.chartNote} id={described}>
        {breaching === 0
          ? `No hour in the retrieved window is ${comparison} ${formatMeasured(threshold, unit)}.`
          : `${breaching} of ${points.length} retrieved hours ${
              breaching === 1 ? "is" : "are"
            } ${comparison} ${formatMeasured(threshold, unit)}.`}
        {missing === 0
          ? ""
          : ` ${missing} ${missing === 1 ? "hour" : "hours"} carried no reading and ${
              missing === 1 ? "is" : "are"
            } left as a gap.`}
      </p>

      <WatchFigures points={points} unit={unit} />
    </figure>
  );
}
