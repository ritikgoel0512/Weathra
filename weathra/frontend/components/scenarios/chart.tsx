"use client";

/**
 * The lab's one plot: the retrieved forecast and the scenario over the same instants.
 *
 * `13-weather-scenario-lab.png` draws the baseline as a muted dashed line, the scenario as a solid
 * cyan one, and precipitation as bars along the floor — one picture answering "what did my
 * assumptions do, hour by hour". The screen before this drew the *scenario* against a flat
 * reference line at the forecast's mean, which compares a series to a number and cannot show a
 * change in shape at all.
 *
 * **Both series come from the response.** `ScenarioResponse` carries the baseline exactly as the
 * provider returned it and the scenario with the assumptions applied, on the same instants and in
 * the same units, so the two lines are plotted rather than one being reconstructed from the other.
 *
 * **A gap is a gap.** `connectNulls={false}`: an hour the provider reported nothing for breaks both
 * lines rather than being bridged, which is the same rule every other chart in this product
 * follows.
 */

import { useId, useState, type ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button, ScrollRegion } from "@/components/ui";
import { formatMeasured, placesFor, roundTo } from "@/lib/format/figures";

import styles from "./scenarios.module.css";

/** The axis and grid treatment every Weathra chart shares: recessive, solid, hairline. */
const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

export interface ScenarioPoint {
  readonly label: string;
  readonly stamp: string;
  readonly baseline: number | null;
  readonly scenario: number | null;
  readonly precipitation: number | null;
}

/** The two series as one row per instant. A measure absent from either side stays null. */
export function pointsFor(
  baseline: { entries?: readonly { time_local: string; values?: Record<string, number | null> }[] } | undefined,
  scenario: { entries?: readonly { time_local: string; values?: Record<string, number | null> }[] } | undefined,
): ScenarioPoint[] {
  const after = new Map(
    (scenario?.entries ?? []).map((entry) => [entry.time_local, entry.values ?? {}]),
  );

  return (baseline?.entries ?? []).map((entry) => {
    const moved = after.get(entry.time_local) ?? {};
    const value = (values: Record<string, number | null>, key: string): number | null =>
      typeof values[key] === "number" ? values[key] : null;

    return {
      label: hourLabelOf(entry.time_local),
      stamp: entry.time_local,
      baseline: value(entry.values ?? {}, "temperature"),
      scenario: value(moved, "temperature"),
      precipitation: value(moved, "precipitation"),
    };
  });
}

/**
 * A local timestamp's day and hour, as text.
 *
 * Sliced rather than parsed: `2026-09-10T12:00:00+02:00` already *is* the local reading, and
 * putting it through `Date` would re-apply an offset to a figure that has one.
 */
export function hourLabelOf(timeLocal: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(timeLocal);
  return match === null ? timeLocal : `${match[2]}/${match[1]} ${match[3]}`;
}

function ScenarioTooltip({
  active,
  payload,
  unit,
  precipitationUnit,
}: {
  active?: boolean;
  payload?: readonly { payload?: ScenarioPoint }[];
  unit: string | null;
  precipitationUnit: string | null;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipStamp}>{point.stamp}</p>
      <p className={styles.tooltipValue}>
        Baseline: {point.baseline === null ? "not reported" : formatMeasured(point.baseline, unit)}
      </p>
      <p className={styles.tooltipValue}>
        Scenario: {point.scenario === null ? "not reported" : formatMeasured(point.scenario, unit)}
      </p>
      {point.precipitation === null ? null : (
        <p className={styles.tooltipValue}>
          Precipitation: {formatMeasured(point.precipitation, precipitationUnit)}
        </p>
      )}
    </div>
  );
}

/** The plotted figures as a table, behind one control. A number is never only a pixel. */
function ScenarioFigures({
  points,
  unit,
  precipitationUnit,
}: {
  readonly points: readonly ScenarioPoint[];
  readonly unit: string | null;
  readonly precipitationUnit: string | null;
}): ReactNode {
  const [shown, setShown] = useState(false);

  return (
    <div className={styles.figures}>
      <Button size="sm" onClick={() => setShown((open) => !open)} aria-expanded={shown}>
        {shown ? "Hide the figures" : "Show the figures"}
      </Button>
      {shown ? (
        <ScrollRegion label="Scenario figures" className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>
              Baseline and scenario, hour by hour
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Baseline{unit ? ` (${unit})` : null}</th>
                <th scope="col">Scenario{unit ? ` (${unit})` : null}</th>
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
                  <td>
                    {point.baseline === null
                      ? "not reported"
                      : roundTo(point.baseline, placesFor(unit))}
                  </td>
                  <td>
                    {point.scenario === null
                      ? "not reported"
                      : roundTo(point.scenario, placesFor(unit))}
                  </td>
                  <td>
                    {point.precipitation === null
                      ? "not reported"
                      : roundTo(point.precipitation, placesFor(precipitationUnit))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      ) : null}
    </div>
  );
}

export function TemporalImpactChart({
  points,
  unit,
  precipitationUnit,
  changed,
}: {
  readonly points: readonly ScenarioPoint[];
  readonly unit: string | null;
  readonly precipitationUnit: string | null;
  /** Whether an assumption actually moved the series. Both lines are drawn either way. */
  readonly changed: boolean;
}): ReactNode {
  const described = useId();
  const hasPrecipitation = points.some((point) => typeof point.precipitation === "number");
  const missing = points.filter((point) => point.baseline === null).length;

  return (
    <figure className={styles.chart} data-chart="temporal-impact">
      <figcaption className={styles.chartCaption}>
        <span className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="baseline" /> Baseline
          </span>
          <span className={styles.legendItem}>
            <span className={styles.legendLine} data-series="scenario" />{" "}
            {changed ? "Scenario" : "Scenario (overlapping)"}
          </span>
          {hasPrecipitation ? (
            <span className={styles.legendItem}>
              <span className={styles.legendSwatch} data-series="precipitation" /> Precipitation
            </span>
          ) : null}
        </span>
      </figcaption>

      <ScrollRegion label="Temporal impact projection chart" className={styles.chartScroll}>
        <div
          className={styles.chartPlot}
          role="img"
          aria-label={`Temperature through the window${unit ? ` in ${unit}` : ""}: the retrieved forecast${
            changed
              ? " and the scenario it was adjusted into"
              : " and the scenario, which overlaps it exactly because no assumption is applied"
          }${hasPrecipitation ? ", with precipitation per reported hour" : ""}. The figures are in the table below.`}
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
              {hasPrecipitation ? (
                <YAxis yAxisId="precipitation" orientation="right" {...AXIS} width={40} />
              ) : null}
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={
                  <ScenarioTooltip unit={unit} precipitationUnit={precipitationUnit} />
                }
              />
              {hasPrecipitation ? (
                <Bar
                  yAxisId="precipitation"
                  dataKey="precipitation"
                  name="Precipitation"
                  fill="var(--color-class-observed)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={14}
                  isAnimationActive={false}
                />
              ) : null}
              {/*
                Both series are always drawn, and the two states differ only in which one is dashed.
                After a run the retrieved series is the muted dashed one and the scenario reads solid
                over it. With nothing supposed the two are the *same numbers*, so drawing one line
                and calling it Baseline leaves a reader wondering whether the scenario failed: the
                baseline goes solid underneath and the scenario rides it as an accented dash, which
                is what an exact overlap looks like when it is deliberate.
              */}
              <Line
                yAxisId="temperature"
                type="monotone"
                dataKey="baseline"
                name="Baseline"
                stroke="var(--color-text-muted)"
                strokeWidth={changed ? 1.6 : 2.4}
                strokeDasharray={changed ? "5 4" : "0"}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="temperature"
                type="monotone"
                dataKey="scenario"
                name="Scenario"
                stroke="var(--color-accent)"
                strokeWidth={changed ? 2.4 : 1.8}
                strokeDasharray={changed ? "0" : "5 6"}
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
        {changed
          ? missing === 0
            ? "Every hour in the retrieved window carried a temperature to adjust."
            : `${missing} ${missing === 1 ? "hour" : "hours"} in this window had no temperature to adjust and ${
                missing === 1 ? "is" : "are"
              } left as a gap.`
          : `Scenario overlaps baseline — no adjustments applied.${
              missing === 0
                ? ""
                : ` ${missing} ${missing === 1 ? "hour" : "hours"} in this window carried no temperature and ${
                    missing === 1 ? "is" : "are"
                  } left as a gap.`
            }`}
      </p>

      <ScenarioFigures points={points} unit={unit} precipitationUnit={precipitationUnit} />
    </figure>
  );
}
