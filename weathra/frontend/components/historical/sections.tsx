"use client";

/**
 * Historical Analytics' surfaces — task 21.3, against
 * `docs/design/screens/03-historical-analytics.png`.
 *
 * The artifact establishes the order this reproduces: a row of stat tiles across the top, the wide
 * chart card beneath, and the period-against-baseline panel below it. What it does not establish,
 * and what the specs do, is what goes in them.
 *
 * Two rules run through every component here:
 *
 * **Retrieved and computed are two regions, not one.** The observations are badged HISTORICAL; the
 * statistics over them — means, extremes, deltas, z-scores — are badged ANALYTICS and carry the
 * method that produced each one. `specs/safety-grounding` requires a Weathra-computed baseline to be
 * labelled a computed historical statistic and *not* a raw observation, and the artifact's own
 * "1991-2020 WMO baseline" is exactly the claim that must not be made: Weathra computes its own
 * baseline from the years the archive served, and says which they were.
 *
 * **An absent figure says why.** Every statistic the backend could not compute renders its own
 * `reason`, never a zero and never a dash that could be read as one.
 */

import type { ReactNode } from "react";

import {
  AttributionFooter,
  DataClassBadge,
  Metric,
  MethodNote,
  ProvenanceSection,
} from "@/components/ui";
import type {
  Baseline,
  BaselineComparison,
  HistoryResponse,
  Measure,
  PeriodComparison,
  Statistic,
  StatisticResult,
} from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import {
  baselineYearsStatement,
  formatSigned,
  formatStatistic,
  isComputed,
  periodLabel,
  statisticFor,
  unavailableReason,
} from "@/lib/historical/analysis";

import styles from "./historical.module.css";

/** The statistics the tile row reports for the selected period, in the artifact's order. */
const HEADLINE: readonly { statistic: Statistic; measure: Measure; label: string }[] = [
  { statistic: "mean", measure: "temperature_mean", label: "Mean temperature" },
  { statistic: "minimum", measure: "temperature_min", label: "Lowest temperature" },
  { statistic: "maximum", measure: "temperature_max", label: "Highest temperature" },
  { statistic: "total", measure: "precipitation_sum", label: "Total precipitation" },
  { statistic: "mean", measure: "wind_speed_max", label: "Mean daily maximum wind" },
];

/** What a `StatisticResult` reads as, or the backend's reason for having no value. */
function StatisticFigure({
  result,
  label,
}: {
  readonly result: StatisticResult | undefined;
  readonly label: string;
}): ReactNode {
  const value = formatStatistic(result);

  return (
    <li className={styles.figure}>
      <span className={styles.figureLabel}>{label}</span>
      {value === null ? (
        <span className={styles.note}>Not computable: {unavailableReason(result)}</span>
      ) : (
        <span className={styles.figureValue}>
          {value}
          {result?.unit ? <span className={styles.figureUnit}> {result.unit}</span> : null}
        </span>
      )}
      {result ? (
        <MethodNote
          method={result.method}
          pointsUsed={result.points_used}
          pointsExcluded={result.points_excluded}
          unit={result.unit || null}
        />
      ) : null}
    </li>
  );
}

/* --------------------------------------------------------------- the retrieved band */

export interface ObservationsProps {
  readonly history: HistoryResponse;
  readonly children: ReactNode;
}

/**
 * The observations themselves, badged HISTORICAL, with the charts inside them.
 *
 * The covered period is stated separately from the requested one: the archive's reporting lag means
 * a request for the last few days comes back shorter than it was asked for, and
 * `specs/historical-weather` requires that to be said rather than left for a reader to notice.
 */
export function Observations({ history, children }: ObservationsProps): ReactNode {
  return (
    <ProvenanceSection
      dataClass="historical"
      title="Recorded observations"
      attribution={{
        provider: history.provider,
        location: history.location?.display_name ?? null,
        retrievedAt: history.retrieved_at,
        period: {
          start: history.covered_period.start_local,
          end: history.covered_period.end_local,
          timezone: history.covered_period.timezone ?? null,
        },
        units: history.units,
      }}
    >
      {history.partial ? (
        <p className={styles.coverage} role="status">
          {/* Never silently shortened: the response says which part is missing, and so does this. */}
          {history.unavailable_note ??
            "Part of the requested range is not yet in the archive, so this covers less than was asked for."}{" "}
          Requested {periodLabel(history.requested_period)}; covered{" "}
          {periodLabel(history.covered_period)}.
        </p>
      ) : null}

      {children}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------- the analytics tiles */

export interface HeadlineFiguresProps {
  readonly comparison: PeriodComparison;
}

/**
 * The stat tiles across the top: the selected period's own statistics.
 *
 * They come from the period comparison's later side, which is the selected period — the same
 * deterministic results the comparison is built from, rather than a second set computed for
 * display. Each carries the ANALYTICS badge, because a mean of observations is a computed figure
 * and not one of them.
 */
export function HeadlineFigures({ comparison }: HeadlineFiguresProps): ReactNode {
  return (
    <section className={styles.tiles} aria-label="Figures for the selected period">
      {HEADLINE.map(({ statistic, measure, label }) => {
        const result = statisticFor(comparison.later, statistic, measure);
        const value = formatStatistic(result);
        return (
          <Metric
            key={`${statistic}-${measure}`}
            dataClass="analytics"
            label={label}
            value={value ?? "Not computable"}
            unit={value === null ? undefined : (result?.unit ?? undefined)}
            note={
              value === null ? (
                // An absent statistic says why, in the backend's own words. Never a dash that
                // could be read as a zero, and never a method note implying it was computed.
                <span className={styles.tileNote}>{unavailableReason(result)}</span>
              ) : (
                <span className={styles.tileNote}>
                  {result?.method} · {result?.points_used} points
                </span>
              )
            }
          />
        );
      })}
    </section>
  );
}

/* --------------------------------------------------------------- period comparison */

export interface PeriodComparisonPanelProps {
  readonly comparison: PeriodComparison;
}

/**
 * Two past periods, their statistics, and the deltas between them.
 *
 * The deltas are the backend's: `specs/deterministic-analytics` computes them with a method and a
 * point count, and subtracting two figures here would be a second implementation of that rule. The
 * shared basis is stated because the comparison is only meaningful if both sides were measured the
 * same way, and unequal lengths are called out rather than left to be inferred from the dates.
 */
export function PeriodComparisonPanel({ comparison }: PeriodComparisonPanelProps): ReactNode {
  const percentages = comparison.percentage_changes ?? {};

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Period against period"
      attribution={{
        provider: comparison.provider,
        location: comparison.location?.display_name ?? null,
        period: {
          start: comparison.later_period.start_local,
          end: comparison.later_period.end_local,
          timezone: comparison.later_period.timezone ?? null,
        },
        units: comparison.unit_system,
      }}
    >
      <p className={styles.statement}>{comparison.basis}</p>

      <dl className={styles.periods}>
        <div className={styles.period}>
          <dt>Earlier period</dt>
          <dd>{periodLabel(comparison.earlier_period)}</dd>
        </div>
        <div className={styles.period}>
          <dt>Later period</dt>
          <dd>{periodLabel(comparison.later_period)}</dd>
        </div>
      </dl>

      {comparison.lengths_differ ? (
        <p className={styles.note}>
          The two periods are of different lengths. Totals are affected by that; means are not.
        </p>
      ) : null}

      <ul className={styles.deltas}>
        {(comparison.deltas ?? []).map((delta, index) => {
          const figure = formatSigned(delta);
          const percentage = percentages[delta.measure];
          return (
            <li className={styles.figure} key={`${delta.measure}-${index}`}>
              <span className={styles.figureLabel}>{measureLabel(delta.measure)}</span>
              {figure === null ? (
                <span className={styles.note}>Not computable: {unavailableReason(delta)}</span>
              ) : (
                <span className={styles.figureValue}>
                  {figure}
                  {delta.unit ? <span className={styles.figureUnit}> {delta.unit}</span> : null}
                  {typeof percentage === "number" ? (
                    <span className={styles.figureUnit}>
                      {" "}
                      ({percentage > 0 ? "+" : ""}
                      {Math.round(percentage * 10) / 10}%)
                    </span>
                  ) : null}
                </span>
              )}
              <MethodNote method={delta.method} pointsUsed={delta.points_used} unit={delta.unit || null} />
            </li>
          );
        })}
      </ul>

      <p className={styles.note}>
        Statistics applied to both sides: {(comparison.statistics_applied ?? []).join("; ")}.
      </p>
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------ baseline comparison */

export interface BaselinePanelProps {
  readonly comparison: BaselineComparison;
}

/**
 * The selected period placed against the baseline of the years before it.
 *
 * The years actually used are stated, and so is the fact that this is Weathra's own statistic
 * rather than a published climate normal — `specs/historical-weather` requires both, and the
 * artifact's "1991-2020 WMO baseline" is the claim they exist to prevent.
 */
export function BaselinePanel({ comparison }: BaselinePanelProps): ReactNode {
  const baseline: Baseline = comparison.baseline;
  const difference = formatSigned(comparison.difference);

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Selected period against its baseline"
      attribution={{
        provider: baseline.provider,
        location: baseline.location?.display_name ?? null,
        period: {
          start: baseline.calendar_period.start_local,
          end: baseline.calendar_period.end_local,
          timezone: baseline.calendar_period.timezone ?? null,
        },
        units: baseline.unit_system,
      }}
    >
      <p className={styles.statement}>{comparison.characterization}</p>

      <div className={styles.tiles}>
        <Metric
          dataClass="analytics"
          label={`Difference from the baseline (${measureLabel(comparison.measure)})`}
          value={difference ?? "Not computable"}
          unit={difference === null ? undefined : (comparison.difference.unit || undefined)}
          note={<span className={styles.tileNote}>{comparison.difference.method}</span>}
        />
        <Metric
          dataClass="analytics"
          label="Z-score against the baseline"
          value={formatStatistic(comparison.z_score) ?? "Undefined"}
          note={
            <span className={styles.tileNote}>
              {isComputed(comparison.z_score)
                ? comparison.z_score.method
                : // A baseline with no spread has no z-score, and the reason is the backend's.
                  unavailableReason(comparison.z_score)}
            </span>
          }
        />
      </div>

      {/* The baseline's own figures, so the comparison above can be checked against them. */}
      <ul className={styles.figures}>
        <StatisticFigure result={baseline.mean} label="Baseline mean" />
        <StatisticFigure result={baseline.standard_deviation} label="Baseline standard deviation" />
        <StatisticFigure result={baseline.minimum} label="Baseline minimum" />
        <StatisticFigure result={baseline.maximum} label="Baseline maximum" />
      </ul>

      <AttributionFooter
        attribution={{
          provider: baseline.provider,
          location: baseline.location?.display_name ?? null,
          period: {
            start: baseline.calendar_period.start_local,
            end: baseline.calendar_period.end_local,
            timezone: baseline.calendar_period.timezone ?? null,
          },
          units: baseline.unit_system,
        }}
      >
        <p className={styles.noteStrong} data-baseline-years="true">
          Baseline years: {baselineYearsStatement(baseline)}
        </p>
        {baseline.coverage_note ? <p className={styles.note}>{baseline.coverage_note}</p> : null}
        <p className={styles.note}>{baseline.labelling}</p>
        {comparison.forecast_side_caveat ? (
          <p className={styles.note}>{comparison.forecast_side_caveat}</p>
        ) : null}
        <p className={styles.note}>
          Both sides are observations. This is not a measure of how accurate a past forecast was.
        </p>
      </AttributionFooter>
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------------- the data class */

/** The pair of badges the artifact puts above the chart card: what is retrieved, what is computed. */
export function ClassKey(): ReactNode {
  return (
    <p className={styles.classKey}>
      <DataClassBadge dataClass="historical" />
      <span className={styles.note}>what the archive recorded</span>
      <DataClassBadge dataClass="analytics" />
      <span className={styles.note}>what Weathra computed from it</span>
    </p>
  );
}
