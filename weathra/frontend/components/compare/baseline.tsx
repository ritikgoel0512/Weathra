"use client";

/**
 * "Decadal Climate Baseline" — the historical band `04-compare-cities.png` closes its analytics on.
 * Task 34.31.
 *
 * **This was an empty frame, and it did not have to be.** The panel carried the sentence "A
 * multi-decade baseline per place is not retrieved for a comparison. Historical Analytics computes
 * one place's baseline over the years the archive holds." That was true as a description of what
 * the *comparison endpoint* returns, and it was the wrong conclusion: the archive baseline endpoint
 * takes a place and a calendar window, this screen already knows both for every compared place, and
 * asking it twice is two requests through a contract that already exists. No new infrastructure,
 * no new backend, no new statistic — the same call the Dashboard's own baseline band makes, made
 * once per city.
 *
 * # What is drawn
 *
 * * **Per place, its own delta** — the window's mean against the mean of the reference years, which
 *   is `baselineStanding`. Signed, in the baseline's own unit, with the number of years it averages
 *   stated because `specs/historical` requires the years actually used to be named.
 * * **The plot** — one line per place, one mark per reference year, over the years both archives
 *   answered for. This is the real version of the artifact's chart.
 *
 * # What is refused
 *
 * The artifact draws a candlestick chart of invented market data with a `MODEL Z-SCORE 2.84σ`
 * callout on it, and describes both cities against "the 30-year WMO climate normal (1991-2020)".
 * Weathra cites no published normal, computes no such z-score, and holds however many archive years
 * the provider answers with — often fewer than requested, which is stated. `screens.md` §5 records
 * the candlestick as mockup filler and it is not imitated.
 */

import Link from "next/link";
import { useId, type ReactNode } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button, EmptyChart, ProvenanceSection, ScrollRegion } from "@/components/ui";
import type { Baseline } from "@/lib/api/schema";
import { baselineStanding, type BaselineStanding } from "@/lib/comparison/differences";
import { formatReading } from "@/lib/dashboard/briefing";

import styles from "./compare.module.css";

/** One compared place's archive answer, and how its window sits against it. */
export interface BaselineEntry {
  readonly label: string;
  readonly baseline: Baseline | null;
  readonly standing: BaselineStanding | null;
}

/** The two line colours, in rank order — the same pair the pulse chart uses. */
const SERIES_COLOURS = ["var(--color-accent)", "var(--color-class-historical)"] as const;

export function buildBaselineEntries(
  places: readonly { label: string; baseline: Baseline | null; windowMean: { value: number | null; unit: string | null } | null }[],
): readonly BaselineEntry[] {
  return places.map((place) => ({
    label: place.label,
    baseline: place.baseline,
    standing: baselineStanding(place.windowMean, place.baseline),
  }));
}

export function DecadalClimateBaseline({
  entries,
}: {
  readonly entries: readonly BaselineEntry[];
}): ReactNode {
  const described = useId();
  const drawable = entries.filter(
    (entry) => (entry.baseline?.yearly_means ?? []).length > 0,
  );

  /* Every year any archive answered for, ascending, so two series of unequal coverage align. */
  const years = [
    ...new Set(
      drawable.flatMap((entry) =>
        (entry.baseline?.yearly_means ?? []).map((point) => point.year),
      ),
    ),
  ].sort((one, other) => one - other);

  const rows = years.map((year) => {
    const row: Record<string, number | null> = { year };
    for (const entry of drawable) {
      row[entry.label] =
        (entry.baseline?.yearly_means ?? []).find((point) => point.year === year)?.value ?? null;
    }
    return row;
  });

  const unit = drawable[0]?.baseline?.mean?.unit ?? null;

  return (
    <ProvenanceSection
      dataClass="historical"
      title="Decadal Climate Baseline"
      eyebrow="This window against the years behind each place"
      attribution={null}
    >
      <div className={styles.baselineBand}>
        <div className={styles.baselineAccount}>
          {entries.length === 0 ? (
            <p className={styles.note}>
              No archive baseline was retrieved for the compared places.
            </p>
          ) : (
            <>
              <p className={styles.baselineLead}>
                {/*
                  One sentence naming what the deltas beneath it mean. The artifact's own version
                  cites a 30-year WMO normal; this names the years the archive actually answered
                  with, which is the statement `specs/historical` requires.
                */}
                Each place&rsquo;s window against the mean of the archive years for the same
                calendar days.
              </p>

              <dl className={styles.baselineDeltas}>
                {entries.map((entry) => (
                  <div className={styles.baselineDelta} key={entry.label}>
                    <dt className={styles.baselineDeltaTerm}>
                      {entry.label.split(",")[0]} delta
                    </dt>
                    <dd className={styles.baselineDeltaValue}>
                      {entry.standing ? (
                        <>
                          {entry.standing.difference >= 0 ? "+" : "−"}
                          {formatReading({
                            value: Math.abs(entry.standing.difference),
                            unit: entry.standing.unit,
                          })}
                        </>
                      ) : (
                        <span className={styles.note}>Not computable</span>
                      )}
                    </dd>
                    {entry.standing ? (
                      <dd className={styles.baselineDeltaNote}>
                        against {entry.standing.years}{" "}
                        {entry.standing.years === 1 ? "year" : "years"} of archive observations
                      </dd>
                    ) : null}
                  </div>
                ))}
              </dl>

              <Link href="/historical">
                <Button variant="secondary" size="sm">
                  Open Historical Analytics
                </Button>
              </Link>
            </>
          )}
        </div>

        <div className={styles.baselineChart}>
          <h3 className={styles.baselineChartTitle}>The reference years, per place</h3>
          {rows.length === 0 ? (
            <EmptyChart
              title="Archive years per place"
              reason="The archive reported no per-year means for this window."
              height={200}
            />
          ) : (
            <ScrollRegion label="Archive years per place" className={styles.baselineScroll}>
              <div
                className={styles.baselinePlot}
                role="img"
                aria-label={`Archive mean temperature per year for ${drawable
                  .map((entry) => entry.label)
                  .join(" and ")}.`}
                aria-describedby={described}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid
                      stroke="var(--color-border-subtle)"
                      strokeDasharray="2 6"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="year"
                      stroke="var(--color-border-strong)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="var(--color-border-strong)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      cursor={{ stroke: "var(--color-border-strong)" }}
                      contentStyle={{
                        background: "var(--color-surface-overlay)",
                        border: "1px solid var(--color-border-subtle)",
                        borderRadius: "8px",
                        fontSize: 12,
                      }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 11, color: "var(--color-text-muted)" }}
                      iconType="plainline"
                    />
                    {drawable.map((entry, index) => (
                      <Line
                        key={entry.label}
                        type="monotone"
                        dataKey={entry.label}
                        name={entry.label.split(",")[0]}
                        stroke={SERIES_COLOURS[index % SERIES_COLOURS.length]}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </ScrollRegion>
          )}
          <p className={styles.baselineNote} id={described}>
            One mark per year each archive reported
            {unit ? ` · ${unit}` : ""}, scaled to the years rather than from zero
          </p>
        </div>
      </div>
    </ProvenanceSection>
  );
}
