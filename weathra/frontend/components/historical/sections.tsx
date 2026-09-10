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
  Badge,
  DataClassBadge,
  Meter,
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
import { placeLabel } from "@/lib/locations/place";
import {
  baselineYearsStatement,
  formatSigned,
  formatStatistic,
  isComputed,
  periodLabel,
  statisticAppliedLabel,
  statisticFor,
  unavailableReason,
} from "@/lib/historical/analysis";

import styles from "./historical.module.css";

/**
 * A tile glyph, drawn in the same stroke language as the navigation icons.
 *
 * Six of them rather than a shared icon set: these name measures, not destinations, and the two
 * vocabularies have no overlap. Decorative — `Metric` marks them `aria-hidden` and the tile's label
 * is what names the figure.
 */
function TileGlyph({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const GLYPHS = {
  // A thermometer.
  temperature: (
    <TileGlyph>
      <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z" />
      <path d="M12 9v6" />
    </TileGlyph>
  ),
  // A range, low to high.
  range: (
    <TileGlyph>
      <path d="M4 12h16" />
      <path d="M8 8l-4 4 4 4" />
      <path d="M16 8l4 4-4 4" />
    </TileGlyph>
  ),
  // A raindrop.
  precipitation: (
    <TileGlyph>
      <path d="M12 3.5c3 3.6 4.5 6.2 4.5 8.5a4.5 4.5 0 0 1-9 0c0-2.3 1.5-4.9 4.5-8.5z" />
    </TileGlyph>
  ),
  // Moving air.
  wind: (
    <TileGlyph>
      <path d="M4 9h9a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M4 14h13a2.5 2.5 0 1 1-2.5 2.5" />
    </TileGlyph>
  ),
  // Humidity: a drop with a level in it.
  humidity: (
    <TileGlyph>
      <path d="M12 3.5c3 3.6 4.5 6.2 4.5 8.5a4.5 4.5 0 0 1-9 0c0-2.3 1.5-4.9 4.5-8.5z" />
      <path d="M7.8 13.5h8.4" />
    </TileGlyph>
  ),
} as const;

/** The statistics the tile row reports for the selected period, in the artifact's order. */
const HEADLINE: readonly {
  statistic: Statistic;
  measure: Measure;
  label: string;
  icon: ReactNode;
}[] = [
  {
    statistic: "mean",
    measure: "temperature_mean",
    label: "Mean temperature",
    icon: GLYPHS.temperature,
  },
  {
    statistic: "minimum",
    measure: "temperature_min",
    label: "Lowest temperature",
    icon: GLYPHS.range,
  },
  {
    statistic: "maximum",
    measure: "temperature_max",
    label: "Highest temperature",
    icon: GLYPHS.range,
  },
  {
    statistic: "total",
    measure: "precipitation_sum",
    label: "Total precipitation",
    icon: GLYPHS.precipitation,
  },
  {
    statistic: "mean",
    measure: "wind_speed_max",
    label: "Mean wind speed",
    icon: GLYPHS.wind,
  },
  {
    statistic: "mean",
    measure: "relative_humidity",
    label: "Mean humidity",
    icon: GLYPHS.humidity,
  },
];

/**
 * The tile's comparison caption: how this period's figure moved against the earlier one.
 *
 * `03-historical-analytics.png` puts a short caption under every tile — "+3.2°C vs Normal". This is
 * that caption, and it is the backend's own delta: `PeriodComparison.deltas` carries one result per
 * measure with its method and its point count, so nothing here subtracts anything. Where the
 * backend computed no delta for a measure there is no caption, which is the same rule the figures
 * themselves follow.
 */
function tileDelta(
  comparison: PeriodComparison,
  statistic: Statistic,
  measure: Measure,
): { text: string; tone: "up" | "down" | "flat" } | undefined {
  const delta = (comparison.deltas ?? []).find(
    (result) => result.measure === measure && result.statistic === statistic,
  );
  const signed = formatSigned(delta);
  if (signed === null) return undefined;
  const unit = delta?.unit ? ` ${delta.unit}` : "";
  const value = Number(formatStatistic(delta));
  return {
    text: `${signed}${unit} against the earlier period`,
    tone: value > 0 ? "up" : value < 0 ? "down" : "flat",
  };
}

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
        location: placeLabel(history.location),
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
      {HEADLINE.map(({ statistic, measure, label, icon }) => {
        const result = statisticFor(comparison.later, statistic, measure);
        const value = formatStatistic(result);
        return (
          <Metric
            key={`${statistic}-${measure}`}
            dataClass="analytics"
            icon={icon}
            label={label}
            value={value ?? "Not computable"}
            delta={value === null ? undefined : tileDelta(comparison, statistic, measure)}
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
        location: placeLabel(comparison.location),
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
        Statistics applied to both sides:{" "}
        {(comparison.statistics_applied ?? []).map(statisticAppliedLabel).join("; ")}.
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
        location: placeLabel(baseline.location),
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
          location: placeLabel(baseline.location),
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

/* ------------------------------------------------------- deviation and anomaly */

export interface DeviationAnalysisProps {
  readonly comparison: BaselineComparison | null;
}

/**
 * "Deviation Analysis" — the bars `03-historical-analytics.png` puts under the baseline figures.
 *
 * The artifact labels three of them Temperature Drift, Precipitation Lag and Atmospheric
 * Instability, filled to percentages nobody computed. Weathra computes one of the three honestly:
 * the z-score against the baseline is exactly a normalised measure of temperature deviation, so
 * that bar carries it, scaled so three standard deviations fills the track and the note says so.
 *
 * **The other two are absent rather than empty.** There is no precipitation-lag or instability
 * statistic anywhere in `BaselineComparison`, and there is no plan to compute one, so a permanent
 * row reading "Not computed" tells a customer about a metric this product does not have while
 * denying it in the same breath. One real bar is a better panel than one real bar and two
 * apologies. The same call was made for the Dashboard's confidence matrix, for the same reason.
 */
export function DeviationAnalysis({ comparison }: DeviationAnalysisProps): ReactNode {
  const zResult = comparison?.z_score;
  const z = isComputed(zResult) ? (zResult?.value ?? null) : null;
  const drift = typeof z === "number" ? Math.min(Math.abs(z) / 3, 1) : null;

  return (
    <section className={styles.deviation} aria-label="Deviation analysis">
      <h3 className={styles.panelSubtitle}>Deviation analysis</h3>
      <Meter
        label="Temperature drift"
        value={drift}
        unavailable="Not computed"
        note={
          typeof z === "number"
            ? `z = ${z.toFixed(2)} against the baseline; the track is three standard deviations.`
            : "The backend reported no z-score for this window."
        }
      />
    </section>
  );
}

/**
 * "Anomaly Intelligence" — the right-hand panel of `03-historical-analytics.png`.
 *
 * The artifact fills it with a model's narrative about the archive. This screen consults no model:
 * every figure on it is retrieved or computed, and `docs/design/screens.md` §8 records that it
 * therefore carries no interpretation region. The panel is kept, and says that plainly rather than
 * being dropped — its absence changed the screen's composition, and "no model wrote anything here"
 * is a fact worth stating on a product built around who produced which number.
 *
 * What it does carry are the key figures the deterministic comparison produced, which is what a
 * reader wants from a panel in that position.
 */
export function AnomalyIntelligence({ comparison }: DeviationAnalysisProps): ReactNode {
  const zResult = comparison?.z_score;
  const z = isComputed(zResult) ? (zResult?.value ?? null) : null;
  const difference = comparison ? formatSigned(comparison.difference) : null;

  return (
    <section className={styles.anomaly} aria-label="Anomaly intelligence">
      <header className={styles.anomalyHead}>
        <h3 className={styles.panelSubtitle}>Anomaly intelligence</h3>
        <Badge tone="neutral">Deterministic</Badge>
      </header>

      <p className={styles.note}>
        Deterministic. Every figure is retrieved or computed.
      </p>

      <dl className={styles.anomalyFacts}>
        <div className={styles.anomalyFact}>
          <dt>Difference from baseline</dt>
          <dd>{difference ?? "Not computed"}</dd>
        </div>
        <div className={styles.anomalyFact}>
          <dt>Z-score</dt>
          <dd>{typeof z === "number" ? z.toFixed(2) : "Not computed"}</dd>
        </div>
        <div className={styles.anomalyFact}>
          <dt>Percentile</dt>
          {/*
            The artifact shows one. A percentile needs the ranked distribution the baseline was
            drawn from, and `BaselineComparison` carries the mean, the deviation and the extremes
            only — so it is stated as not reported rather than derived from figures that cannot
            support it.
          */}
          <dd>Not reported</dd>
        </div>
      </dl>
    </section>
  );
}
