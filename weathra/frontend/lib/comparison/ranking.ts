/**
 * Compare Cities' adapter — task 21.4.
 *
 * Reads a `ComparisonResult`. It ranks nothing, scores nothing and compares nothing: the ranking,
 * the scores, the component weights and the tie tolerance all arrived computed, because
 * `specs/location-comparison` puts every scoring input in the deterministic analytics layer and a
 * screen that re-derived one would be a second implementation nobody would notice disagreeing.
 *
 * Two readings need care, and both are about not misrepresenting a number the backend sent:
 *
 * **A raw score is not a measurement.** For a single-measure criterion the backend scores on the
 * measure itself and *negates* it when lower is better — so "driest" comes back as a negative
 * score whose magnitude is a precipitation total. Putting that on a chart axis would show a
 * negative rainfall. So `comparableFigure` returns the *supporting statistic's* own value for a
 * single-measure criterion, in its own unit, and the 0-1 composite score only where the score is
 * genuinely a 0-1 quantity.
 *
 * **A tie is a fact, not a rounding artifact.** `tied` and the shared rank come from the backend,
 * which applied its own tolerance. Nothing here compares two scores.
 */

import type {
  ComparisonCandidate,
  ComparisonResult,
  Criterion,
  StatisticResult,
} from "@/lib/api/schema";

/* -------------------------------------------------------------------- criteria */

/** What each criterion is called on screen, and what "best" means under it. */
export const CRITERION_LABELS: Readonly<Record<Criterion, string>> = {
  warmest: "Warmest",
  coolest: "Coolest",
  driest: "Driest",
  wettest: "Wettest",
  least_windy: "Least windy",
  outdoor_suitability: "Best for being outdoors",
};

/** The order the criteria are offered in. The backend's own list, not a subset. */
export const CRITERIA: readonly Criterion[] = [
  "warmest",
  "coolest",
  "driest",
  "wettest",
  "least_windy",
  "outdoor_suitability",
];

/** A criterion's name. An unrecognised one is titled from itself rather than dropped. */
export function criterionLabel(criterion: string): string {
  const known = CRITERION_LABELS[criterion as Criterion];
  if (known) return known;
  const words = criterion.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Whether this candidate was scored by combining several measures.
 *
 * Read from the candidate's own contributions rather than from the criterion name, so a backend
 * that made another criterion composite would be rendered correctly on the day it did.
 */
export function isComposite(candidate: ComparisonCandidate): boolean {
  return (candidate.contributions ?? []).length > 0;
}

/* ------------------------------------------------------------------- the figure */

/** The one figure that can honestly be compared across candidates, with what it is. */
export interface ComparableFigure {
  readonly value: number;
  readonly unit: string | null;
  /** What the figure is, for an axis label and a table column. */
  readonly label: string;
}

/**
 * The figure to show beside a candidate, and to plot.
 *
 * A single-measure criterion scores on the measure itself, so the honest figure is that
 * statistic's own value — never the score, which the backend negates when lower is better. A
 * composite score is a 0-1 quantity and is comparable as it stands.
 */
export function comparableFigure(candidate: ComparisonCandidate): ComparableFigure | null {
  if (isComposite(candidate)) {
    return { value: candidate.score, unit: null, label: "Outdoor-suitability score (0–1)" };
  }

  const supporting = candidate.supporting?.[0];
  const value = supporting?.value;
  if (supporting === undefined || typeof value !== "number" || !Number.isFinite(value)) return null;

  return {
    value,
    unit: supporting.unit || null,
    label: supporting.measure.replace(/_/g, " "),
  };
}

/** One row of the comparison chart and its table. A candidate with no figure has no row. */
export interface RankedRow {
  readonly label: string;
  readonly rank: number;
  readonly value: number;
  readonly tied: boolean;
}

/** The rows the chart draws, in rank order, and what they are measuring. */
export function rankedRows(result: ComparisonResult): {
  readonly rows: readonly RankedRow[];
  readonly unit: string | null;
  readonly label: string | null;
} {
  const rows: RankedRow[] = [];
  let unit: string | null = null;
  let label: string | null = null;

  for (const candidate of byRank(result)) {
    const figure = comparableFigure(candidate);
    if (figure === null) continue;
    unit ??= figure.unit;
    label ??= figure.label;
    rows.push({
      label: candidate.label,
      rank: candidate.rank,
      value: figure.value,
      tied: candidate.tied === true,
    });
  }

  return { rows, unit, label };
}

/* ---------------------------------------------------------------- the candidates */

/** The candidates in the order the backend ranked them; ties keep their shared rank. */
export function byRank(result: ComparisonResult): ComparisonCandidate[] {
  return [...(result.candidates ?? [])].sort(
    (left, right) => left.rank - right.rank || left.label.localeCompare(right.label),
  );
}

/** Every rank the ranking shares, so a tie can be said rather than merely repeated. */
export function tiedRanks(result: ComparisonResult): ReadonlySet<number> {
  const counts = new Map<number, number>();
  for (const candidate of result.candidates ?? []) {
    counts.set(candidate.rank, (counts.get(candidate.rank) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([rank]) => rank));
}

/** A statistic's figure and unit, as text, or null when the backend reported no value. */
export function formatStatistic(result: StatisticResult | undefined): string | null {
  const value = result?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  const figure = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return result?.unit ? `${figure} ${result.unit}` : figure;
}

/** A share of a composite score, as a percentage of the whole. Presentation, not arithmetic. */
export function weightPercentage(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

/* ------------------------------------------------------------------- the request */

/** A location entry the person has typed. Blank rows are not locations. */
export function namedLocations(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * Why this comparison cannot be sent yet, or null when it can.
 *
 * The check the client owes the person before a request: `specs/location-comparison` requires two
 * or more locations, and the backend refuses one — but making somebody wait for a round trip to
 * learn that a comparison of one place is not a comparison is a worse way to be told.
 */
export function blockingReason(entries: readonly string[]): string | null {
  const named = namedLocations(entries);
  if (named.length < 2) {
    return "A comparison needs at least two locations. Add another place to compare against.";
  }
  const seen = new Set<string>();
  for (const name of named) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) return `${name} is listed twice. A place cannot be compared with itself.`;
    seen.add(key);
  }
  return null;
}
