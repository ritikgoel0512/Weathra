/**
 * Historical Analytics' adapter — task 21.3.
 *
 * Every function here *reads* a response the backend already produced. Nothing computes a
 * statistic, averages a series, derives a delta, or fills a gap. That is not a stylistic
 * preference: `specs/deterministic-analytics` puts every figure in the analytics engine with its
 * method and its point count attached, and a screen that recomputed one would be a second
 * implementation whose disagreements with the first nobody would notice.
 *
 * Three rules the functions below exist to enforce:
 *
 * **A gap is a gap.** A `null` in a series means the archive did not report that day, and it
 * travels through to the chart as `null` so the line breaks. Carrying the previous value forward,
 * or interpolating between neighbours, would draw an observation that was never made —
 * `docs/design/design-system.md` §7 forbids exactly that, and it is the one chart mistake that
 * manufactures data rather than merely obscuring it.
 *
 * **A statistic is found, never assembled.** `statisticFor` looks up a `StatisticResult` the
 * backend sent; when the backend sent none, the answer is `undefined` and the caller says so.
 * There is no fallback value anywhere in this file.
 *
 * **The unit comes from the result.** Every `StatisticResult` carries its own unit. The person's
 * preferred unit *system* is sent with the request; what comes back is what is displayed.
 */

import type { Baseline, Measure, Series, Statistic, StatisticResult } from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";

/* --------------------------------------------------------------------- statistics */

/** One statistic out of a comparison's results, or undefined when the backend sent none. */
export function statisticFor(
  results: readonly StatisticResult[] | undefined,
  statistic: Statistic,
  measure: Measure,
): StatisticResult | undefined {
  return results?.find((result) => result.statistic === statistic && result.measure === measure);
}

/** Whether the backend actually computed this figure. */
export function isComputed(result: StatisticResult | undefined): boolean {
  return result !== undefined && typeof result.value === "number" && Number.isFinite(result.value);
}

/**
 * A figure and its unit, as text, or null when the backend reported no value.
 *
 * At most one decimal place, and never more precision than arrived: rounding *up* the number of
 * digits would be inventing precision.
 */
export function formatStatistic(result: StatisticResult | undefined): string | null {
  if (!isComputed(result)) return null;
  const value = result?.value as number;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** The same, with an explicit sign — for a delta, where the direction is the point. */
export function formatSigned(result: StatisticResult | undefined): string | null {
  const figure = formatStatistic(result);
  if (figure === null) return null;
  return Number(figure) > 0 ? `+${figure}` : figure;
}

/** Why a figure is absent, in the backend's own words. */
export function unavailableReason(result: StatisticResult | undefined): string {
  if (result === undefined) return "The backend reported no result for this figure.";
  return result.reason?.trim() || "The backend reported no value for this figure.";
}

/* ------------------------------------------------------------------------ series */

/** One day of a historical series, as the charts read it. A null is an unreported day. */
export interface HistoricalPoint {
  /** The local calendar date, read as text so no timezone is re-applied. */
  readonly date: string;
  readonly values: Readonly<Record<string, number | null>>;
}

/** The local calendar date of a local timestamp, read as text rather than through `Date`. */
export function localDateOf(timeLocal: string): string {
  return /^(\d{4}-\d{2}-\d{2})/.exec(timeLocal)?.[1] ?? timeLocal;
}

/**
 * The daily series as chart rows, in the order the backend sent them.
 *
 * A measure the entry does not carry becomes `null` rather than being omitted, so every row has
 * the same shape and a missing day breaks the line instead of shortening it.
 */
export function pointsFrom(series: Series | undefined): HistoricalPoint[] {
  return (series?.entries ?? []).map((entry) => ({
    date: localDateOf(entry.time_local),
    values: entry.values,
  }));
}

/** Whether any row carries a usable number for this measure. An all-null series has no chart. */
export function hasValues(points: readonly HistoricalPoint[], measure: string): boolean {
  return points.some((point) => typeof point.values[measure] === "number");
}

/** How many days the archive did not report for a measure — stated rather than hidden. */
export function missingCount(points: readonly HistoricalPoint[], measure: string): number {
  return points.filter((point) => typeof point.values[measure] !== "number").length;
}

/** The unit the series declared for a measure, or null when it declared none. */
export function unitFor(series: Series | undefined, measure: string): string | null {
  return series?.units?.[measure] ?? null;
}

/* ---------------------------------------------------------------------- baselines */

/**
 * How a baseline states the years behind it.
 *
 * `specs/historical-weather` requires the years *actually used* to be reported rather than the
 * number requested, because a "ten-year average" computed from six years is a different number
 * from the one a reader assumed.
 */
export function baselineYearsStatement(baseline: Baseline): string {
  const years = baseline.years_used ?? [];
  if (years.length === 0) return "The archive reported no years for this calendar period.";
  const listed = years.join(", ");
  return `${years.length} ${years.length === 1 ? "year" : "years"} of ${baseline.years_requested} requested: ${listed}.`;
}

/** The reference value a baseline contributes to a chart, or null when it has none. */
export function baselineMeanOf(baseline: Baseline | undefined): number | null {
  const value = baseline?.mean?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------------ periods */

/** A period as the reader sees it: the local calendar dates the backend resolved. */
export function periodLabel(period: { start_local: string; end_local: string } | undefined): string | null {
  if (!period) return null;
  return `${localDateOf(period.start_local)} to ${localDateOf(period.end_local)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * The same window, said the way a sentence says it: `4 to 6 September`.
 *
 * `periodLabel` is the provenance form and stays exactly as it is — a footer stating which window a
 * figure covers wants the calendar dates, unambiguous and sortable. A customer-facing sentence does
 * not: "Over 2026-09-04 to 2026-09-06, Berlin leads…" is the engineering-copy tell task 34.31 was
 * sent to remove. Built from the string's own parts rather than through `toLocaleDateString`, for
 * the reason every other date on these screens is: the backend resolved this into the *location's*
 * timezone, and re-parsing it would re-express it in the reader's.
 */
export function periodSentence(
  period: { start_local: string; end_local: string } | undefined,
): string | null {
  const label = periodLabel(period);
  if (label === null) return null;
  const [start, end] = label.split(" to ");
  const from = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start ?? "");
  const to = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end ?? "");
  if (!from || !to) return label;

  const month = (match: RegExpExecArray) => MONTHS[Number(match[2]) - 1] ?? match[2];
  const day = (match: RegExpExecArray) => String(Number(match[3]));

  // Within one month, the month is said once: `4 to 6 September`.
  if (from[1] === to[1] && from[2] === to[2]) {
    return `${day(from)} to ${day(to)} ${month(to)}`;
  }
  return `${day(from)} ${month(from)} to ${day(to)} ${month(to)}`;
}

/** A date shifted by whole years, as an ISO calendar date. Used only to seed the form's defaults. */
export function yearsBefore(iso: string, years: number): string {
  const match = /^(\d{4})(-\d{2}-\d{2})$/.exec(iso);
  if (match === null) return iso;
  return `${Number(match[1]) - years}${match[2]}`;
}

/**
 * One entry of a comparison's `statistics_applied`, in words.
 *
 * The backend states these as `measure: statistic` — `temperature_mean: mean` — because that pair
 * is what it applied, and the measure key is the stable identifier the rest of the contract uses.
 * On screen it is an API key: the runtime audit of 2026-09-08 photographed `temperature_mean: mean`
 * in a sentence addressed to a person. The measure is relabelled through the same map every other
 * figure's label comes from, and the statistic is de-underscored; an entry in any other shape is
 * left exactly as the backend wrote it rather than guessed at.
 */
export function statisticAppliedLabel(entry: string): string {
  const [measure, statistic, ...rest] = entry.split(":");
  if (measure === undefined || statistic === undefined || rest.length > 0) return entry;
  const named = measureLabel(measure.trim());
  return `${named} (${statistic.trim().replace(/_/g, " ")})`;
}
