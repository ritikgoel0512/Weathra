"use client";

/**
 * The Weather Intelligence Report's non-plot regions — the tiles, strips and panels that carry the
 * artifact's graphical weight between the charts in `./charts.tsx`.
 *
 * `docs/design/screens/12-weather-intelligence-report.png` is a two-column intelligence report: a
 * hero over the location with three figure tiles under it, a column of observed metric tiles beside
 * it, a day strip, a "what changed" panel, a historical-context panel, an anomaly panel, and a
 * grounding footer. Production had the same *sections* rendered as description lists and
 * paragraphs, which the fidelity review of 2026-09-10 graded NOT CLOSE. These are the same
 * sections with the artifact's hierarchy:
 *
 *     VISUALISATION or METRIC  →  SHORT LABEL  →  ONE SHORT INTERPRETATION
 *
 * Nothing below composes a sentence about the weather. Every interpretation line is either a
 * figure the backend computed, a phrase the backend wrote (`characterization`, `summary`,
 * `labelling`, a `DayChange.statement`), or a statement of method. Where a field is absent the
 * region is omitted — never drawn with a zero, an estimate or a filled-in bar.
 */

import type { ReactNode } from "react";

import {
  Badge,
  DataClassBadge,
  LocationImage,
  Metric,
  Meter,
  UncertaintyIndicator,
} from "@/components/ui";
import type {
  Baseline,
  BaselineComparison,
  CurrentResponse,
  DayChange,
  ForecastResponse,
  Location,
  StatisticResult,
  TrendReport,
  WhatChanged,
} from "@/lib/api/schema";
import { formatReading, measureLabel, readingsFrom } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";

import styles from "./report.module.css";

/** A statistic's figure with its unit, or the backend's reason there is none. */
export function figureOf(result: StatisticResult | null | undefined): string | null {
  if (!result) return null;
  if (result.value === null || result.value === undefined) return null;
  return formatReading({ value: result.value, unit: result.unit ?? null });
}

/** A signed figure, so a delta reads as a direction before it reads as a number. */
function signedOf(value: number, unit: string | null | undefined): string {
  return `${value > 0 ? "+" : ""}${formatReading({ value, unit: unit ?? null })}`;
}

/** Which way a delta points, for the tile's tone. Never a colour on its own — the sign leads. */
function toneOf(value: number): "up" | "down" | "flat" {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/* ------------------------------------------------------------------- the hero */

export interface ReportHeroProps {
  readonly location: Location;
  readonly current: CurrentResponse | null;
  /** The deterministic reading of the window, written by code from the findings only. */
  readonly summary: string | null;
  readonly comparison: BaselineComparison | null;
  readonly trend: TrendReport | null;
  readonly forecast: ForecastResponse | null;
}

/**
 * The artifact's opening band: the place, photographed, with the window's headline under it.
 *
 * The artifact titles this "Immediate Convective Alert: Localized Thermal Drift" and attributes it
 * to a neural agent. Weathra's headline is `AnalysisResponse.summary` — written by code from the
 * computed findings, with no model involved — and it is labelled as computed rather than as an
 * alert, because nothing here decides that a condition is urgent.
 *
 * The three tiles beneath are the artifact's CONFIDENCE / EVIDENCE NODES / DRIFT VARIANCE row.
 * Weathra has a real figure for two of them and refuses the third: the forecast's own confidence
 * band with the horizon it applies at, and the signed distance from the baseline with its z-score.
 * There is no node count, so there is no node tile.
 */
export function ReportHero({
  location,
  current,
  summary,
  comparison,
  trend,
  forecast,
}: ReportHeroProps): ReactNode {
  const nearest = forecast?.uncertainty?.horizon?.[0] ?? null;
  const temperature = current?.values?.temperature;
  const difference = comparison?.difference;
  const zScore = comparison?.z_score;

  return (
    <section className={styles.hero} aria-labelledby="report-hero-title">
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="hero"
        scrim="strong"
      >
        <div className={styles.heroOverlay}>
          <p className={styles.heroPlace}>{friendlyName(location)}</p>
          {typeof temperature === "number" ? (
            <p className={styles.heroReadout}>
              {formatReading({ value: temperature, unit: current?.units?.temperature ?? null })}
            </p>
          ) : null}
          {current ? <DataClassBadge dataClass="observed" /> : null}
        </div>
      </LocationImage>

      <div className={styles.heroBody}>
        <div className={styles.heroHeading}>
          <DataClassBadge dataClass="analytics" />
          <h2 className={styles.heroTitle} id="report-hero-title">
            Computed reading of this window
          </h2>
        </div>
        {summary ? <p className={styles.heroSummary}>{summary}</p> : null}

        <div className={styles.heroTiles}>
          {nearest ? (
            <Metric
              label="Nearest-horizon confidence"
              value={nearest.confidence}
              dataClass="forecast"
              note={`At ${nearest.hours_ahead} h into the horizon.`}
            />
          ) : null}

          {difference && typeof difference.value === "number" ? (
            <Metric
              label="Against the baseline"
              value={signedOf(difference.value, difference.unit)}
              dataClass="analytics"
              delta={
                zScore && typeof zScore.value === "number"
                  ? { text: `${zScore.value} standard deviations`, tone: toneOf(zScore.value) }
                  : undefined
              }
              note={comparison?.characterization ?? undefined}
            />
          ) : null}

          {trend && typeof trend.magnitude === "number" ? (
            <Metric
              label="Trend across the window"
              value={signedOf(trend.magnitude, trend.unit)}
              dataClass="analytics"
              delta={{ text: trend.direction, tone: toneOf(trend.slope_per_day) }}
              note={trend.method}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- the observed tiles */

/**
 * Every measure the provider reported now, one tile each.
 *
 * The artifact draws six. Weathra draws as many as came back and no placeholder for the rest: a
 * tile for a measure the provider did not supply would be a labelled empty box, which reads as a
 * failure rather than as an absence. The grid is `auto-fit`/`minmax` so two tiles fill the column
 * as honestly as six do — the thin-data rule of `docs/design/design-system.md` §13.
 */
export function ObservedNow({ current }: { readonly current: CurrentResponse }): ReactNode {
  const readings = readingsFrom(current.values, current.units);
  if (readings.length === 0) return null;

  return (
    <div className={styles.observedGrid} data-observed-count={readings.length}>
      {readings.map((reading) => (
        <Metric
          key={reading.key}
          label={measureLabel(reading.key)}
          value={formatReading(reading)}
          dataClass="observed"
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- the day strip */

/** One day of the outlook, as the artifact's card: the day, its range, its bar. */
interface OutlookDay {
  readonly date: string;
  readonly weekday: string;
  readonly maximum: number | null;
  readonly minimum: number | null;
  readonly precipitation: number | null;
}

/**
 * The weekday of a local calendar date.
 *
 * Read as a UTC instant of the *already-local* date, which is calendar arithmetic on a date string
 * rather than a timezone conversion — `2026-09-04` is Friday in every zone that calls it that.
 */
function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()] ?? "";
}

function numberOr(value: number | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

export function outlookDaysFrom(forecast: ForecastResponse | null): OutlookDay[] {
  return (forecast?.daily?.entries ?? []).map((entry) => {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(entry.time_local)?.[1] ?? entry.time_local;
    const values = entry.values ?? {};
    return {
      date,
      weekday: weekdayOf(date),
      maximum: numberOr(values.temperature_max),
      minimum: numberOr(values.temperature_min),
      precipitation:
        numberOr(values.precipitation_sum) ?? numberOr(values.precipitation_probability_max),
    };
  });
}

/**
 * The outlook as the artifact's row of day cards.
 *
 * Each card carries a range bar drawn from that day's own minimum and maximum against the window's
 * span — geometry from two retrieved figures and nothing else. A day the provider reported neither
 * for gets the card, the date, and the reason there is no bar, because dropping it would silently
 * shorten the week.
 */
export function OutlookStrip({
  days,
  unit,
  precipitationUnit,
}: {
  readonly days: readonly OutlookDay[];
  readonly unit: string | null;
  readonly precipitationUnit: string | null;
}): ReactNode {
  const values = days.flatMap((day) =>
    [day.minimum, day.maximum].filter((value): value is number => value !== null),
  );
  const floor = values.length > 0 ? Math.min(...values) : 0;
  const ceiling = values.length > 0 ? Math.max(...values) : 1;
  const span = ceiling - floor || 1;

  return (
    <ol className={styles.days}>
      {days.map((day) => {
        const { minimum, maximum } = day;
        // Both, or neither: a bar drawn from one end and an assumed other end is a fabricated span.
        const drawable = minimum !== null && maximum !== null;
        const offset = drawable ? ((minimum - floor) / span) * 100 : 0;
        const length = drawable ? Math.max(((maximum - minimum) / span) * 100, 4) : 0;

        return (
          <li className={styles.day} key={day.date}>
            <span className={styles.dayName}>{day.weekday}</span>
            <span className={styles.dayDate}>{day.date.slice(5)}</span>
            {drawable ? (
              <>
                <span className={styles.dayHigh}>{formatReading({ value: maximum, unit })}</span>
                <span
                  className={styles.dayRange}
                  role="img"
                  aria-label={`${formatReading({ value: minimum, unit })} to ${formatReading({ value: maximum, unit })}`}
                >
                  <span
                    className={styles.dayRangeFill}
                    style={{ insetInlineStart: `${offset}%`, inlineSize: `${length}%` }}
                  />
                </span>
                <span className={styles.dayLow}>{formatReading({ value: minimum, unit })}</span>
              </>
            ) : (
              <span className={styles.dayUnreported}>Not reported</span>
            )}
            {day.precipitation === null ? null : (
              <span className={styles.dayPrecipitation}>
                {formatReading({ value: day.precipitation, unit: precipitationUnit })}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------- what has moved */

/**
 * The artifact's "What changed?" column, from `GET /weather/changes`.
 *
 * It listed only the backend's one-line statement. The endpoint also returns a `DayChange` per day
 * — both retrievals, the signed movement, its unit, and whether the movement cleared the measure's
 * materiality margin — and that is the panel the artifact draws. An immaterial movement is shown as
 * one, rather than being dropped or promoted.
 */
export function WhatMoved({ changes }: { readonly changes: WhatChanged }): ReactNode {
  const moved = (changes.changes ?? []).filter(
    (change): change is DayChange & { change: number } => typeof change.change === "number",
  );

  return (
    <div className={styles.moved}>
      <p className={styles.movedStatement}>{changes.statement}</p>
      {moved.length === 0 ? null : (
        <ul className={styles.movedList}>
          {moved.map((change) => (
            <li className={styles.movedRow} key={`${change.local_date}-${change.measure}`}>
              <span className={styles.movedDate}>{change.local_date}</span>
              <span className={styles.movedValue} data-tone={toneOf(change.change)}>
                {signedOf(change.change, change.unit)}
              </span>
              <span className={styles.movedMeasure}>
                {measureLabel(change.measure)}
                {change.material ? "" : " · inside the margin"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- findings */

/**
 * The computed findings as tiles rather than as a description list.
 *
 * Figure first, label under it, method under that — one short line each. The method *is* the
 * interpretation: `specs/analytics` requires a computed figure to travel with how it was computed,
 * and the artifact's tiles carry a caption in exactly that position. A statistic the engine could
 * not compute keeps its tile and states the backend's reason, which is a different fact from a
 * figure of zero.
 */
export function StatisticTiles({
  results,
}: {
  readonly results: readonly StatisticResult[];
}): ReactNode {
  if (results.length === 0) return null;

  return (
    <div className={styles.findings}>
      {results.map((result, index) => {
        const value = figureOf(result);
        return (
          <Metric
            key={`${result.measure}-${result.statistic}-${index}`}
            label={`${measureLabel(result.measure)} · ${result.statistic.replace(/_/g, " ")}`}
            value={value ?? "Not computable"}
            dataClass="analytics"
            note={value === null ? (result.reason ?? undefined) : result.method}
          />
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- historical context */

/**
 * The artifact's "Historical Context" column: the record this window is being read against.
 *
 * Its decadal stability index and model-alignment bars are refused — no endpoint produces either.
 * What is drawn instead is the one proportion the baseline genuinely supports: how much of the
 * requested archive was actually available, which is the figure `coverage_note` states in words.
 * A meter over a figure the backend gave in words is the same claim, not a new one.
 */
export function HistoricalContext({
  baseline,
  comparison,
}: {
  readonly baseline: Baseline;
  readonly comparison: BaselineComparison | null;
}): ReactNode {
  const years = baseline.years_used?.length ?? 0;
  const requested = baseline.years_requested ?? 0;
  const coverage = requested > 0 ? years / requested : null;
  const spread = figureOf(baseline.standard_deviation);

  return (
    <div className={styles.historical}>
      <p className={styles.historicalLabelling}>{baseline.labelling}</p>

      <div className={styles.historicalTiles}>
        <Metric
          label="Baseline mean"
          value={figureOf(baseline.mean) ?? "Not computable"}
          dataClass="historical"
          note={`${measureLabel(baseline.measure)} over ${years} year${years === 1 ? "" : "s"}.`}
        />
        <Metric
          label="Baseline range"
          value={`${figureOf(baseline.minimum) ?? "—"} – ${figureOf(baseline.maximum) ?? "—"}`}
          dataClass="historical"
          note={spread ? `Standard deviation ${spread}.` : undefined}
        />
      </div>

      {comparison?.characterization ? (
        <p className={styles.historicalCharacterization}>{comparison.characterization}</p>
      ) : null}

      <Meter
        label="Archive coverage"
        value={coverage}
        unavailable="Not stated"
        note={
          baseline.coverage_note ??
          `${years} of the ${requested} requested year${requested === 1 ? "" : "s"} were available.`
        }
      />
    </div>
  );
}

/* ------------------------------------------------------- confidence by horizon */

/**
 * Confidence across the horizon, as the bands the backend actually returned.
 *
 * `specs/web-ui` requires a forecast figure's confidence to be shown with its basis, and the
 * artifact prints a percentage nobody computes. `UncertaintyStatement.horizon` is a list of bands
 * at measured distances, so that is what is drawn: one chip per horizon point, and the basis under
 * them through the shared indicator, which is where the disclosure belongs.
 */
export function HorizonConfidence({
  forecast,
}: {
  readonly forecast: ForecastResponse;
}): ReactNode {
  const uncertainty = forecast.uncertainty;
  const horizon = uncertainty?.horizon ?? [];
  const nearest = horizon[0] ?? null;

  return (
    <div className={styles.horizon}>
      {horizon.length > 0 ? (
        <ol className={styles.horizonScale}>
          {horizon.map((point) => (
            <li className={styles.horizonStep} key={point.time_utc} data-confidence={point.confidence}>
              <span className={styles.horizonBar} aria-hidden="true" />
              <span className={styles.horizonHours}>{point.hours_ahead} h</span>
              <span className={styles.horizonBand}>{point.confidence}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {nearest && uncertainty ? (
        <UncertaintyIndicator
          confidence={nearest.confidence}
          basis={uncertainty.basis}
          hoursAhead={nearest.hours_ahead}
          spreadAvailable={uncertainty.spread_available}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- source footer */

export interface SourceRow {
  readonly name: string;
  readonly detail: string;
  readonly dataClass: "observed" | "forecast" | "historical" | "analytics";
}

/**
 * The artifact's "Grounding Evidence" panel: every surface this report was read from.
 *
 * Its version is a retrieval score over three named third-party feeds with millisecond latencies.
 * None of those exists here. What does is the set of providers the five reads actually reported,
 * each with what it supplied and when it was retrieved — which is the claim the artifact's panel
 * is shaped like and the only one this product can make.
 */
export function SourceFooter({ rows }: { readonly rows: readonly SourceRow[] }): ReactNode {
  if (rows.length === 0) return null;

  return (
    <ul className={styles.sources}>
      {rows.map((row) => (
        <li className={styles.source} key={`${row.name}-${row.dataClass}`}>
          <span className={styles.sourceMark} data-class={row.dataClass} aria-hidden="true" />
          <span className={styles.sourceName}>{row.name}</span>
          <span className={styles.sourceDetail}>{row.detail}</span>
          <Badge tone="neutral">{row.dataClass}</Badge>
        </li>
      ))}
    </ul>
  );
}
