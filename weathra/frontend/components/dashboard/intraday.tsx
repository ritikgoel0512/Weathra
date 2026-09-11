"use client";

/**
 * The Dashboard's intra-day chart — the region `01-dashboard.png` labels "24H INTRA-DAY PROJECTION".
 *
 * It exists rather than reusing Historical Analytics' `RecordedAgainstBaselineChart` because the
 * two charts answer different questions and the reuse was visible in the 2026-09-11 capture: a
 * week-long temperature line with a rotated unit label on the axis, a full gridline set and a
 * figure table under it. That is the right chart for an archive audit and the wrong one for the
 * band a person meets on the way past. Here the frame is the subject — one curve, its fill, the
 * chance of rain beneath it, and time along the bottom.
 *
 * **Two axes, and the second one cannot be placed wrongly.** `charts.tsx` refuses a second y-axis
 * on the historical charts for a stated reason: where you put it decides whether two series look
 * correlated, and nobody declared the choice. That objection is answered here rather than ignored.
 * The right-hand axis is a *probability* — its domain is fixed at 0–100 because that is the whole
 * range the measure can take, so there is no placement to argue about and no correlation implied by
 * one. The bars are drawn low and recessive against the curve for the same reason: they are the
 * hour's own chance of rain, not a second reading of the temperature beside them.
 *
 * **A gap is still a gap.** `connectNulls` is off, and the hours the provider did not report are
 * counted under the chart, exactly as the historical charts count theirs.
 */

import { useId, type ReactNode } from "react";
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

import { ScrollRegion } from "@/components/ui";
import type { ForecastResponse } from "@/lib/api/schema";

import styles from "./dashboard.module.css";

/** The measure keys the provider reports hourly, named once. */
const TEMPERATURE = "temperature";
const CHANCE = "precipitation_probability";

/** One hour, as the chart plots it. */
interface Hour {
  /** `14:00` — the hour's own local clock time, read as text so no timezone is re-applied. */
  readonly label: string;
  readonly timeLocal: string;
  readonly temperature: number | null;
  readonly chance: number | null;
}

/** `2026-09-04T14:00:00+02:00` → `14:00`, from the stamp's own text. */
function clockOf(timeLocal: string): string {
  return /T(\d{2}:\d{2})/.exec(timeLocal)?.[1] ?? timeLocal;
}

/**
 * The window the band is named for: the next 24 reported hours, starting at the first one.
 *
 * Not the whole horizon. The provider returns a week of hours — 168 of them from Open-Meteo — and
 * plotting all of them makes the curve a comb of seven diurnal cycles in 600 pixels, which is what
 * "24H INTRA-DAY PROJECTION" exists to not be. The days beyond the first are the strip above.
 */
export function intradayHours(forecast: ForecastResponse): Hour[] {
  const entries = forecast.hourly?.entries ?? [];
  return entries.slice(0, 24).map((entry) => ({
    label: clockOf(entry.time_local),
    timeLocal: entry.time_local,
    temperature: typeof entry.values?.[TEMPERATURE] === "number" ? entry.values[TEMPERATURE] : null,
    chance: typeof entry.values?.[CHANCE] === "number" ? entry.values[CHANCE] : null,
  }));
}

/** The hour a figure belongs to, for the footer statements. Null when nothing was reported. */
export function peakOf(
  hours: readonly Hour[],
  key: "temperature" | "chance",
): { readonly value: number; readonly at: string } | null {
  let best: { value: number; at: string } | null = null;
  for (const hour of hours) {
    const value = hour[key];
    if (typeof value !== "number") continue;
    if (best === null || value > best.value) best = { value, at: hour.label };
  }
  return best;
}

function IntradayTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: string | number; value?: number | null }[];
  label?: string | number;
  unit: string | null;
}): ReactNode {
  if (!active || !payload?.length) return null;
  const at = (key: string): number | null | undefined =>
    payload.find((entry) => entry.dataKey === key)?.value;
  const temperature = at("temperature");
  const chance = at("chance");

  return (
    <div className={styles.chartTooltip}>
      <p className={styles.chartTooltipName}>{String(label)}</p>
      <p className={styles.chartTooltipValue}>
        {typeof temperature === "number"
          ? `${temperature}${unit ? ` ${unit}` : ""}`
          : "Temperature not reported"}
      </p>
      {typeof chance === "number" ? (
        <p className={styles.chartTooltipValue}>{chance}% chance of rain</p>
      ) : null}
    </div>
  );
}

export interface IntradayChartProps {
  readonly hours: readonly Hour[];
  /** The unit the provider declared for temperature, or null where it declared none. */
  readonly unit: string | null;
}

export function IntradayChart({ hours, unit }: IntradayChartProps): ReactNode {
  const described = useId();
  const fill = useId().replace(/:/g, "");
  const missing = hours.filter((hour) => hour.temperature === null).length;
  const drawnChance = hours.some((hour) => typeof hour.chance === "number");

  return (
    <figure className={styles.intraday}>
      <figcaption className={styles.intradayLegend}>
        <span className={styles.intradayLegendItem} data-series="temperature">
          Temperature{unit ? ` (${unit})` : ""}
        </span>
        {drawnChance ? (
          <span className={styles.intradayLegendItem} data-series="chance">
            Chance of rain (%)
          </span>
        ) : null}
      </figcaption>

      <ScrollRegion label="Intra-day projection chart" className={styles.intradayScroll}>
        <div
          className={styles.intradayPlot}
          role="img"
          aria-label={`Temperature${unit ? ` in ${unit}` : ""} and the chance of rain, hour by hour, across the next 24 reported hours. The figures are in the table below.`}
          aria-describedby={described}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={hours as Hour[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                {/* The artifact fills under its curve. A gradient, so the fill reads as depth
                    beneath the line rather than as a second solid region with an edge of its own. */}
                <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.26} />
                  <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.01} />
                </linearGradient>
              </defs>

              {/* Horizontal hairlines only. Vertical ones turn a 24-column chart into a grid. */}
              {/* Hairlines, dashed and quiet. A solid grid competes with the curve drawn on it. */}
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="2 6"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke="var(--color-border-strong)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                tickLine={false}
                interval={3}
              />
              <YAxis
                yAxisId="temperature"
                stroke="var(--color-border-strong)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                tickLine={false}
                width={34}
              />
              {/*
                Fixed at the measure's own full range. A probability axis has nowhere else to go,
                which is what makes the second scale here honest — see the note at the top.
              */}
              <YAxis
                yAxisId="chance"
                orientation="right"
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                stroke="var(--color-border-strong)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                tickLine={false}
                width={30}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)" }}
                content={<IntradayTooltip unit={unit} />}
              />

              {/*
                **Recessive, and narrower than its slot.** The first capture of this chart drew 24
                bars at 38% of a saturated violet across the full width of every hour, which read
                as a solid block with a thin line over it — the support had become the subject. A
                quarter-opacity bar at two thirds of its band leaves the curve the loudest thing in
                the frame, which is the artifact's own balance.
              */}
              {drawnChance ? (
                <Bar
                  yAxisId="chance"
                  dataKey="chance"
                  name="Chance of rain"
                  /*
                    Finding 16 of the customer-level review of 2026-09-11: at 26% of a violet across
                    two thirds of every hour, 24 of these read as one solid block behind the curve
                    and the card looked like an engineering plot rather than the artifact's. The
                    artifact draws a handful of narrow blue columns under a bright line. Same
                    figures, same axis, less ink.
                  */
                  fill="var(--color-class-forecast)"
                  fillOpacity={0.34}
                  barSize={9}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              ) : null}

              <Area
                yAxisId="temperature"
                type="monotone"
                dataKey="temperature"
                name="Temperature"
                /* The accent, so the curve is unmistakably the subject and the bars beneath it are
                   unmistakably not. Both were the same forecast blue. */
                stroke="var(--color-accent)"
                strokeWidth={2.5}
                fill={`url(#${fill})`}
                dot={false}
                activeDot={{ r: 4 }}
                // An hour the provider did not report breaks the curve rather than being bridged.
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ScrollRegion>

      {/*
        **One short line, on the disclosure's own rule.** It read "Every hour in this window was
        reported by the provider." across the full width of the widest card on the screen — a
        sentence about completeness where the artifact has nothing at all. The gap case keeps its
        count, because a gap is a fact about the chart and has to be stated where the chart is.
      */}
      <div className={styles.intradayRule}>
        <p className={styles.intradayNote} id={described}>
          {missing === 0
            ? `All ${hours.length} hours reported.`
            : `${missing} of ${hours.length} hours not reported, and left as gaps.`}
        </p>
      </div>

      {/* Every value is also text — the rule the historical charts set, kept here. */}
      <details className={styles.intradayFigures}>
        <summary className={styles.intradayFiguresSummary}>Show the figures</summary>
        <ScrollRegion label="Intra-day figures">
          <table className={styles.intradayTable}>
            <caption className={styles.intradayTableCaption}>
              Temperature and chance of rain, hour by hour.
            </caption>
            <thead>
              <tr>
                <th scope="col">Hour</th>
                <th scope="col">Temperature{unit ? ` (${unit})` : ""}</th>
                <th scope="col">Chance of rain (%)</th>
              </tr>
            </thead>
            <tbody>
              {hours.map((hour) => (
                <tr key={hour.timeLocal}>
                  <th scope="row">{hour.label}</th>
                  <td>{hour.temperature === null ? "Not reported" : hour.temperature}</td>
                  <td>{hour.chance === null ? "Not reported" : hour.chance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </details>
    </figure>
  );
}
