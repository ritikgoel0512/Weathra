/**
 * The pairwise arithmetic Compare Cities needs and the backend does not return — task 34.31.
 *
 * `POST /weather/comparison` answers with each candidate's statistics over the shared window. It
 * does not answer with the *difference* between two candidates, because a comparison of eight
 * places has twenty-eight pairs and the endpoint ranks rather than pairs. The screen shows two
 * places against each other, so the one pair it draws is subtracted here.
 *
 * **Every value subtracted came from the response.** Nothing is fetched for this, nothing is
 * estimated, and a statistic only one place reported produces no difference at all rather than a
 * difference against zero. The unit has to match on both sides: subtracting a Celsius mean from a
 * Fahrenheit one produces a number, and the number is wrong.
 *
 * This is a pure module with no React in it, so the rule `specs/deterministic-analytics` states —
 * that no figure is computed inside a component — is kept by construction and is testable on its
 * own. The method each difference names is the two statistics' own method, so a reader who opens
 * it finds what the backend said rather than what this file decided.
 */

import type { ComparisonCandidate, StatisticResult } from "@/lib/api/schema";

/** One statistic both places reported, and the signed gap between them. */
export interface Difference {
  /** `temperature_mean`, for keying and for the measure label a screen renders. */
  readonly measure: string;
  readonly statistic: string;
  /** Leading candidate's value minus the trailing candidate's. Signed: direction is the point. */
  readonly value: number;
  readonly unit: string | null;
  /** The leading candidate's own method for this statistic, for the disclosure beside it. */
  readonly method: string;
  /** Both raw values, so a screen can state the pair rather than only the gap. */
  readonly leading: number;
  readonly trailing: number;
}

function computed(entry: StatisticResult | undefined): number | null {
  if (!entry) return null;
  return typeof entry.value === "number" ? entry.value : null;
}

/**
 * Every statistic both candidates reported, with the first's value minus the second's.
 *
 * Ordered as the candidates were given, which the screen passes in rank order — so a positive
 * difference always reads "the better-ranked place is this much higher", whatever the criterion.
 */
export function differencesBetween(
  leading: ComparisonCandidate | undefined,
  trailing: ComparisonCandidate | undefined,
): readonly Difference[] {
  if (!leading || !trailing) return [];

  const other = new Map<string, StatisticResult>();
  for (const entry of trailing.supporting ?? []) {
    other.set(`${entry.statistic}:${entry.measure}`, entry);
  }

  const found: Difference[] = [];
  for (const entry of leading.supporting ?? []) {
    const match = other.get(`${entry.statistic}:${entry.measure}`);
    const mine = computed(entry);
    const theirs = computed(match);
    if (mine === null || theirs === null) continue;
    // Two figures in two units are not comparable, and a difference between them is not a figure.
    if ((entry.unit ?? null) !== (match?.unit ?? null)) continue;

    found.push({
      measure: entry.measure,
      statistic: entry.statistic,
      value: mine - theirs,
      unit: entry.unit ?? null,
      method: entry.method,
      leading: mine,
      trailing: theirs,
    });
  }
  return found;
}

/**
 * How a window sits against the years behind it, for one place.
 *
 * The same reading the Dashboard's anomaly card states, computed from the same two responses: the
 * window's own mean against the archive baseline's mean, and whether the gap clears the spread of
 * the reference years. "Usual" is one standard deviation of those years — the baseline reports it,
 * so it is not a threshold invented here.
 *
 * Null unless every part is present and both sides are in the same unit.
 */
export interface BaselineStanding {
  /** Window mean minus baseline mean, signed. */
  readonly difference: number;
  readonly unit: string | null;
  /** The baseline's own mean, and the spread of the years it averages. */
  readonly baseline: number;
  readonly spread: number;
  readonly years: number;
  readonly band: "above" | "within" | "below";
}

export function baselineStanding(
  windowMean: { value: number | null; unit: string | null } | null,
  baseline: {
    mean?: { value?: number | null; unit?: string | null } | null;
    standard_deviation?: { value?: number | null } | null;
    years_used?: readonly number[] | null;
  } | null,
): BaselineStanding | null {
  const current = windowMean?.value ?? null;
  const reference = typeof baseline?.mean?.value === "number" ? baseline.mean.value : null;
  const spread =
    typeof baseline?.standard_deviation?.value === "number"
      ? baseline.standard_deviation.value
      : null;
  if (current === null || reference === null || spread === null) return null;
  if ((windowMean?.unit ?? null) !== (baseline?.mean?.unit ?? null)) return null;

  const difference = current - reference;
  return {
    difference,
    unit: baseline?.mean?.unit ?? null,
    baseline: reference,
    spread,
    years: (baseline?.years_used ?? []).length,
    band:
      Math.abs(difference) <= spread ? "within" : difference > 0 ? "above" : "below",
  };
}

/**
 * The window mean a candidate reported, for the baseline standing above.
 *
 * `temperature_mean` where the comparison ran over daily statistics and `temperature` where it ran
 * over hourly ones — the same two names the Dashboard's own anomaly card accepts, for the same
 * reason: both are the arithmetic mean of the window's temperature in the same unit, and matching
 * only one of them silently loses the reading.
 */
export function windowMeanOf(
  candidate: ComparisonCandidate | undefined,
): { value: number | null; unit: string | null } | null {
  const entry = (candidate?.supporting ?? []).find(
    (result) =>
      result.statistic === "mean" &&
      (result.measure === "temperature_mean" || result.measure === "temperature"),
  );
  if (!entry) return null;
  return {
    value: typeof entry.value === "number" ? entry.value : null,
    unit: entry.unit ?? null,
  };
}
