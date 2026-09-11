"use client";

/**
 * "Deterministic Metrics" — the rail `04-compare-cities.png` puts beside its Climate Pulse chart,
 * with Weathra's own figures in it. Task 34.31.
 *
 * The artifact's rail holds `Mean Variance +2.4°C`, `Precip Delta +14.2mm`, `Gust Intensity 12%
 * Peak` and a red `CRITICAL ANOMALY` box naming a station and a 2.8σ deviation. Three of those five
 * things are inventions: Weathra computes no "gust intensity", no per-station deviation and no such
 * sigma, and `screens.md` §5 already refuses the station identifiers.
 *
 * What Weathra does have, for exactly this slot, is the *difference between the two places for
 * every statistic the comparison applied* — which is `differencesBetween`, a subtraction of two
 * figures the backend returned — and, since this pass fetches an archive baseline per place, the
 * same above/within/below reading the frozen Dashboard states on its own anomaly card. So the rail
 * keeps its shape and its position, holds three real differences under their real measure names,
 * and closes on a status that is computed rather than declared.
 *
 * **Three, and then the rest behind a control.** The artifact shows three; a comparison may apply
 * more. None is deleted — the ones past the third are one press away, with their methods.
 */

import type { ReactNode } from "react";

import { MethodNote, StatusMark } from "@/components/ui";
import type { BaselineStanding } from "@/lib/comparison/differences";
import { type Difference } from "@/lib/comparison/differences";
import { measureLabel, formatReading } from "@/lib/dashboard/briefing";

import styles from "./compare.module.css";

/** `+2.3 °C` — signed, because which way round a difference runs is the whole of its meaning. */
function signed(difference: Difference): string {
  const size = formatReading({ value: Math.abs(difference.value), unit: difference.unit });
  return `${difference.value >= 0 ? "+" : "−"}${size}`;
}

export interface DeterministicMetricsProps {
  /** Leading candidate minus trailing, per statistic both reported. */
  readonly differences: readonly Difference[];
  /** The two places' names, for the status line that names one of them. */
  readonly leading: string | null;
  readonly trailing: string | null;
  /** How each place's window sits against its own archive years, where both were retrieved. */
  readonly standings: readonly { readonly label: string; readonly standing: BaselineStanding | null }[];
}

export function DeterministicMetrics({
  differences,
  leading,
  trailing,
  standings,
}: DeterministicMetricsProps): ReactNode {
  const primary = differences.slice(0, 3);
  const rest = differences.slice(3);

  /*
   * The status: whichever place's window sits furthest outside its own archive spread, or that both
   * sit inside theirs. It is the Dashboard's own reading, per place, and the *comparison* of the
   * two readings is the only thing computed here — which of two already-computed standings is the
   * larger. Nothing is declared critical: a window inside its usual spread is the ordinary answer
   * and is drawn as one.
   */
  const outside = standings
    .filter((entry) => entry.standing !== null && entry.standing.band !== "within")
    .sort(
      (one, other) =>
        Math.abs(other.standing!.difference) - Math.abs(one.standing!.difference),
    );
  const flagged = outside[0] ?? null;
  const anyStanding = standings.some((entry) => entry.standing !== null);

  return (
    <section className={styles.metrics} aria-label="Deterministic metrics">
      <h3 className={styles.metricsTitle}>Deterministic metrics</h3>

      {primary.length === 0 ? (
        <p className={styles.note}>
          No statistic was reported for both places, so there is nothing to difference.
        </p>
      ) : (
        <ul className={styles.metricsList}>
          {primary.map((difference) => (
            <li className={styles.metric} key={`${difference.statistic}-${difference.measure}`}>
              <span className={styles.metricTerm}>{measureLabel(difference.measure)}</span>
              <span
                className={styles.metricValue}
                data-direction={difference.value >= 0 ? "up" : "down"}
              >
                {signed(difference)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        The difference is between two named places and in one direction; saying which way round it
        runs is the caption the figures above need, and it is one line rather than three.
      */}
      {primary.length > 0 && leading && trailing ? (
        <p className={styles.metricsCaption}>
          {leading.split(",")[0]} minus {trailing.split(",")[0]}, over the shared window.
        </p>
      ) : null}

      {rest.length > 0 ? (
        <details className={styles.metricsMore}>
          <summary className={styles.metricsMoreSummary}>
            All {differences.length} differences
          </summary>
          <ul className={styles.metricsList}>
            {rest.map((difference) => (
              <li className={styles.metric} key={`${difference.statistic}-${difference.measure}`}>
                <span className={styles.metricTerm}>{measureLabel(difference.measure)}</span>
                <span
                  className={styles.metricValue}
                  data-direction={difference.value >= 0 ? "up" : "down"}
                >
                  {signed(difference)}
                </span>
              </li>
            ))}
          </ul>
          {differences[0] ? <MethodNote method={differences[0].method} compact /> : null}
        </details>
      ) : null}

      {/*
        The artifact's alert box, in its place, saying what is true. Same status language as the
        frozen Dashboard — the mark carries the state as well as the tone, so neither shape nor
        colour is doing it alone.
      */}
      {anyStanding ? (
        <p
          className={styles.metricsStatus}
          data-tone={flagged ? "flag" : "calm"}
          data-status="baseline-band"
        >
          <StatusMark tone={flagged ? "flag" : "calm"} />
          <span className={styles.metricsStatusText}>
            <span className={styles.metricsStatusTitle}>
              {flagged
                ? `${flagged.label.split(",")[0]} is ${flagged.standing!.band} its usual range`
                : "Both within usual range"}
            </span>
            <span className={styles.metricsStatusDetail}>
              {flagged
                ? `${formatReading({
                    value: Math.abs(flagged.standing!.difference),
                    unit: flagged.standing!.unit,
                  })} from its ${flagged.standing!.years}-year archive average for these days.`
                : "Each place's window sits inside the spread of its own archive years."}
            </span>
          </span>
        </p>
      ) : null}
    </section>
  );
}
