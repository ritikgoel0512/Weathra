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
  Badge,
  DataClassBadge,
  Meter,
  MethodNote,
  Metric,
  NOT_REPORTED,
  ProvenanceSection,
  StatusMark,
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
  // Pressure: stacked isobars.
  pressure: (
    <TileGlyph>
      <path d="M4 8h16" />
      <path d="M6 12h12" />
      <path d="M8 16h8" />
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

/**
 * The six metrics the tile row reports for the selected period, in the artifact's order.
 *
 * `03-historical-analytics.png` sets six equal cards: mean temperature, a min/max *range*,
 * precipitation, humidity, wind and pressure. Production drew the extremes as two separate cards
 * and had no pressure card at all, which is five of the artifact's six in a different rhythm.
 *
 * A `range` entry reads two statistics into one figure. It is not arithmetic — both numbers are the
 * backend's and neither is derived here — it is two of its figures printed as the pair they are.
 */
type HeadlineEntry = {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly statistic: Statistic;
  readonly measure: Measure;
  /** A second statistic, where the card reports a range rather than a figure. */
  readonly upper?: { readonly statistic: Statistic; readonly measure: Measure };
};

const HEADLINE: readonly HeadlineEntry[] = [
  {
    key: "mean-temperature",
    label: "Mean temperature",
    icon: GLYPHS.temperature,
    statistic: "mean",
    measure: "temperature_mean",
  },
  {
    key: "range",
    label: "Min / max range",
    icon: GLYPHS.range,
    statistic: "minimum",
    measure: "temperature_min",
    upper: { statistic: "maximum", measure: "temperature_max" },
  },
  {
    key: "precipitation",
    label: "Precipitation",
    icon: GLYPHS.precipitation,
    statistic: "total",
    measure: "precipitation_sum",
  },
  {
    key: "humidity",
    label: "Average humidity",
    icon: GLYPHS.humidity,
    statistic: "mean",
    measure: "relative_humidity",
  },
  {
    key: "wind",
    label: "Wind speed",
    icon: GLYPHS.wind,
    statistic: "mean",
    measure: "wind_speed_max",
  },
  {
    key: "pressure",
    label: "Average pressure",
    icon: GLYPHS.pressure,
    statistic: "mean",
    measure: "surface_pressure_mean",
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
        /*
         * The method, once, at footnote weight.
         *
         * Four of these stacked — each with its own "Computed by Weathra" line, its own method and
         * its own point counts — made the baseline panel three times the height of the chart it sits
         * beside, and it is the same sentence four times over. The badge above the panel already
         * says the figures are computed. `MethodNote` keeps its disclosure, so the counts are one
         * press away rather than printed four times.
         */
        <MethodNote
          method={result.method}
          pointsUsed={result.points_used}
          pointsExcluded={result.points_excluded}
          unit={result.unit || null}
          compact
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
  /*
   * **Six cards, always six, and never a figure the backend did not produce.**
   *
   * The row used to drop an uncomputed statistic and collect the absences into a sentence beneath,
   * which kept the row honest and cost it its rhythm: the artifact's band is six equal cards, and a
   * band that is four cards on one window and six on another is not that band. A card whose figure
   * the archive did not supply now stays, compactly, and says so in the place the figure would have
   * been — which is both smaller than the old sentence and easier to read than it, because the
   * absence sits under the name of the thing that is absent.
   */
  const cards = HEADLINE.map((entry) => {
    const lower = statisticFor(comparison.later, entry.statistic, entry.measure);
    const upper = entry.upper
      ? statisticFor(comparison.later, entry.upper.statistic, entry.upper.measure)
      : undefined;

    const lowerText = formatStatistic(lower);
    const upperText = entry.upper ? formatStatistic(upper) : null;

    /*
     * A range needs both ends. One end without the other is not a range, and printing it as though
     * it were would be this row inventing the half the archive did not supply.
     */
    const value = entry.upper
      ? lowerText !== null && upperText !== null
        ? `${lowerText} – ${upperText}`
        : null
      : lowerText;

    return { entry, lower, upper, value };
  });

  if (cards.every(({ value }) => value === null)) return null;

  return (
    <section className={styles.tiles} aria-label="Figures for the selected period">
      {cards.map(({ entry, lower, upper, value }) => (
        <Metric
          key={entry.key}
          dataClass="analytics"
          icon={entry.icon}
          label={entry.label}
          value={value ?? NOT_REPORTED}
          unit={value === null ? undefined : (lower?.unit ?? undefined)}
          /*
            The compact secondary fact the artifact puts under every figure. For a range it is the
            spread between the two ends the card already shows; for everything else it is the
            backend's own delta against the earlier period. Never the method and never a point
            count: `specs/deterministic-analytics` requires both to be reportable and neither is
            what somebody reads a metric card for, so they are one press away on the card's own
            section footer.
          */
          delta={
            value === null
              ? undefined
              : entry.upper
                ? spreadCaption(lower, upper)
                : tileDelta(comparison, entry.statistic, entry.measure)
          }
          note={
            value === null ? (
              <span className={styles.tileNote}>{unavailableReason(lower)}</span>
            ) : undefined
          }
        />
      ))}
    </section>
  );
}

/**
 * How wide the range is, from the two ends the card already shows.
 *
 * The one figure on this row that is not read straight off a `StatisticResult` — and it is a
 * subtraction of two numbers printed beside it rather than a statistic, which is why it is captioned
 * as a spread rather than badged as a computed result.
 */
function spreadCaption(
  lower: StatisticResult | undefined,
  upper: StatisticResult | undefined,
): { text: string; tone: "up" | "down" | "flat" } | undefined {
  const low = lower?.value;
  const high = upper?.value;
  if (typeof low !== "number" || typeof high !== "number") return undefined;
  const spread = Math.round((high - low) * 10) / 10;
  const unit = lower?.unit ? ` ${lower.unit}` : "";
  return { text: `${spread}${unit} spread`, tone: "flat" };
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
export function BaselinePanel({
  comparison,
  children = null,
}: BaselinePanelProps & { readonly children?: ReactNode }): ReactNode {
  const baseline: Baseline = comparison.baseline;
  const difference = formatSigned(comparison.difference);
  const rank = comparison.percentile_rank;

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Selected period vs historical baseline"
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
      {/*
        **Not "Historical Normal".**

        `03-historical-analytics.png` titles this "Selected Period vs Historical Normal" over a
        1991–2020 WMO baseline it does not have. What Weathra has is a finite baseline of archive
        years it names, so the title says baseline and this line says how many — a "normal" is a
        thirty-year climatological standard and calling five years one would be the fabrication the
        whole screen is built to avoid.
      */}
      <p className={styles.statement}>{comparison.characterization}</p>

      {/*
        The artifact's three tiles, and the three figures worth that prominence: how far this window
        sits from the baseline, how far that is in the baseline's own spread, and where it ranks
        among the years. The method behind each is on the section's footer and in the figures
        below, not captioned under the number.
      */}
      <div className={styles.tiles}>
        <Metric
          dataClass="analytics"
          label="Difference from baseline"
          value={difference ?? NOT_REPORTED}
          unit={difference === null ? undefined : (comparison.difference.unit || undefined)}
        />
        <Metric
          dataClass="analytics"
          label="Z-score"
          value={formatStatistic(comparison.z_score) ?? NOT_REPORTED}
          note={
            isComputed(comparison.z_score) ? undefined : (
              // A baseline with no spread has no z-score, and the reason is the backend's.
              <span className={styles.tileNote}>{unavailableReason(comparison.z_score)}</span>
            )
          }
        />
        <Metric
          dataClass="analytics"
          label="Percentile"
          value={
            isComputed(rank) ? `${Math.round(rank.value as number)}th` : NOT_REPORTED
          }
          note={
            isComputed(rank) ? undefined : (
              <span className={styles.tileNote}>{unavailableReason(rank)}</span>
            )
          }
        />
      </div>

      {/* The deviation meters, inside the card whose figures they are computed from. */}
      {children}

      {/*
        **Every figure still here, one press in.**

        The baseline's own mean, spread and extremes, the years it was built from, its coverage note
        and its labelling used to run down the face of this card — nine lines of method under three
        figures, which is the report the customer-level review objected to. `specs/deterministic-
        analytics` requires all of it to be reportable; it does not require it to be the first thing
        read.
      */}
      <details className={styles.baselineDetails}>
        <summary className={styles.baselineSummary}>Baseline figures and method</summary>

        <ul className={styles.figures}>
          <StatisticFigure result={baseline.mean} label="Baseline mean" />
          <StatisticFigure result={baseline.standard_deviation} label="Baseline standard deviation" />
          <StatisticFigure result={baseline.minimum} label="Baseline minimum" />
          <StatisticFigure result={baseline.maximum} label="Baseline maximum" />
        </ul>

        <div className={styles.baselineNotes}>
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
        </div>
      </details>
    </ProvenanceSection>
  );
}

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
/**
 * Where this window sits, said once and strongly — the artifact's right-hand intelligence card.
 *
 * **Deterministic, and badged as such.** `03-historical-analytics.png` badges its own version AI
 * INTERPRETATION over a paragraph about the North Atlantic jet stream and a claim about October
 * 1995. Nothing here is written by a model and nothing here is inferred: the status is the sign of
 * a difference the backend computed, and the sentences below it are the backend's own figures in
 * an order somebody reads. That is why the badge says DETERMINISTIC — the honest version of the
 * artifact's is not a quieter claim, it is a different one.
 */
export function AnomalyIntelligence({ comparison }: DeviationAnalysisProps): ReactNode {
  const zResult = comparison?.z_score;
  const z = isComputed(zResult) ? (zResult?.value ?? null) : null;
  const difference = comparison ? formatSigned(comparison.difference) : null;
  const rankResult = comparison?.percentile_rank;
  const unit = comparison?.baseline.mean.unit ?? "";
  const years = [...(comparison?.baseline.yearly_means ?? [])].sort(
    (left, right) => left.value - right.value,
  );
  const compared = comparison?.observed_or_forecast_value ?? null;
  const bounds = years.map((entry) => entry.value);
  const low = Math.min(...bounds, compared ?? Number.POSITIVE_INFINITY);
  const high = Math.max(...bounds, compared ?? Number.NEGATIVE_INFINITY);
  const span = high - low;

  /*
   * **The status is the sign of a computed number, and nothing more.**
   *
   * Not a threshold: Weathra does not define what makes a window "extreme", and a card that
   * declared one would be inventing the classification the artifact invents. Above, below, or level
   * with the baseline is a fact about `difference`, and how *far* is the z-score and the percentile
   * beside it, which a reader can weigh themselves.
   */
  const value = isComputed(comparison?.difference) ? (comparison?.difference.value ?? null) : null;
  const status =
    value === null
      ? { label: "Not computed", tone: "neutral" as const }
      : value > 0
        ? { label: "Above the historical baseline", tone: "warning" as const }
        : value < 0
          ? { label: "Below the historical baseline", tone: "accent" as const }
          : { label: "Level with the historical baseline", tone: "ok" as const };

  /*
   * Two or three sentences, each one a figure already on this screen put into words. Nothing is
   * characterised beyond what the figures say: no cause, no persistence, no record, no season.
   */
  const yearCount = comparison?.baseline.years_used.length ?? 0;
  const sentences = [
    difference !== null && comparison
      ? `The selected period is ${difference} ${comparison.difference.unit ?? ""}`.trim() +
        ` against Weathra's ${yearCount}-year historical baseline for this calendar period.`
      : null,
    typeof z === "number"
      ? `Its z-score of ${z.toFixed(2)} measures that distance in the baseline's own spread.`
      : null,
    isComputed(rankResult) && rankResult
      ? `It ranks at the ${Math.round(rankResult.value as number)}th percentile of the ${yearCount} reference years.`
      : null,
  ].filter((sentence): sentence is string => sentence !== null);

  return (
    <section className={styles.anomaly} aria-label="Anomaly intelligence">
      <header className={styles.anomalyHead}>
        <h3 className={styles.panelSubtitle}>Anomaly intelligence</h3>
        <Badge tone="neutral">Deterministic</Badge>
      </header>

      {/*
        The Dashboard's own anomaly mark, reused rather than redrawn: shape as well as colour, so
        neither carries the state alone. `flag` for a window away from its baseline in either
        direction, `calm` for one level with it — the *direction* is in the words beside it, which is
        where a direction belongs.
      */}
      <div className={styles.anomalyStatus} data-tone={status.tone}>
        <StatusMark tone={value !== null && value !== 0 ? "flag" : "calm"} />
        <span className={styles.anomalyStatusLabel}>{status.label}</span>
      </div>

      {sentences.length > 0 ? (
        <p className={styles.anomalyReading}>{sentences.join(" ")}</p>
      ) : (
        <p className={styles.note}>
          The backend computed no comparison for this window, so there is nothing to characterise.
        </p>
      )}

      {years.length >= 2 && span > 0 ? (
        <figure className={styles.spread}>
          <figcaption className={styles.spreadCaption}>
            Each reference year&rsquo;s mean for this window, and this window against them.
          </figcaption>
          <div
            className={styles.spreadTrack}
            role="img"
            aria-label={
              `${years.length} reference years, from ${low.toFixed(1)} to ${high.toFixed(1)} ` +
              `${unit}. This window is ${compared === null ? "not computed" : compared.toFixed(1) + " " + unit}.`
            }
          >
            {years.map((entry) => (
              <span
                key={entry.year}
                className={styles.spreadYear}
                style={{ left: `${((entry.value - low) / span) * 100}%` }}
                title={`${entry.year}: ${entry.value.toFixed(1)} ${unit}`}
              />
            ))}
            {compared === null ? null : (
              <span
                className={styles.spreadValue}
                style={{
                  // Clamped, so a window outside every reference year still lands on the track
                  // rather than off the end of it. The figures above carry the real distance.
                  left: `${Math.min(100, Math.max(0, ((compared - low) / span) * 100))}%`,
                }}
              />
            )}
          </div>
          <p className={styles.spreadScale}>
            <span>
              {low.toFixed(1)} {unit}
            </span>
            <span>
              {high.toFixed(1)} {unit}
            </span>
          </p>
        </figure>
      ) : null}
    </section>
  );
}
