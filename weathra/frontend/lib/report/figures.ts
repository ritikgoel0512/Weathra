/**
 * How a figure is *read* on the Weather Intelligence Report — presentation only.
 *
 * Every number in this product is computed to full float precision and stored that way, because
 * that is what an audit of the arithmetic needs. What reaches a screen is a different question, and
 * the answer had been decided per call site: one decimal here, `roundTo(_, 2)` there, and the raw
 * value wherever nobody had thought about it. Production showed `20.142857142857142 °C`,
 * `6.700000000000001 mm` and `18.671428571428573 km/h`, which is a polished report with a machine
 * talking to itself inside it.
 *
 * So the precision is a property of the **unit**, in one table, used by every surface of the report:
 *
 *     temperature   1    precipitation  1    wind     1
 *     humidity, %   1    pressure       1    inHg     2
 *     sigma         2    anything else  2
 *
 * Rounding is only ever *downward* in digits. `roundTo` drops trailing zeros, so `71.0 %` reads
 * "71 %" and `70.5 %` reads "70.5 %" — the "whole number unless it needs a decimal" rule, without
 * a second branch to keep in step.
 *
 * **Nothing here mutates a stored value.** The API response, the evidence record, the analytics
 * results and the provenance payload keep every digit they arrived with; `formatProse` in
 * particular returns a *new string* for rendering and the original prose is what the grounding
 * check ran against and what Agent Evidence shows. This module is the last step before a pixel.
 */

import { roundTo } from "./view-model";

/**
 * Decimal places by unit, matched case-insensitively against the unit the backend supplied.
 *
 * Ordered longest-first where one unit is a prefix of another, so `inHg` is never read as `in`.
 */
const PLACES: readonly (readonly [readonly string[], number])[] = [
  [["°c", "°f", "c", "f", "k"], 1],
  [["mm", "cm", "inch", "inches"], 1],
  [["km/h", "kmh", "m/s", "mph", "kt", "kn", "knots"], 1],
  [["%"], 1],
  [["hpa", "mbar", "mb"], 1],
  [["inhg"], 2],
  [["σ"], 2],
];

/** How many places a figure in this unit is read at. Two for a unit this table does not know. */
export function placesFor(unit: string | null | undefined): number {
  const key = (unit ?? "").trim().toLowerCase();
  if (key.length === 0) return 2;
  for (const [units, places] of PLACES) {
    if (units.includes(key)) return places;
  }
  return 2;
}

/** A measured figure and its unit, at the precision that unit is read at. */
export function formatMeasured(value: number, unit: string | null | undefined): string {
  const figure = roundTo(value, placesFor(unit));
  return unit ? `${figure} ${unit}` : figure;
}

/** The figure alone, for a caller that sets the unit apart from it. */
export function formatFigureFor(value: number, unit: string | null | undefined): string {
  return roundTo(value, placesFor(unit));
}

/**
 * The units a measurement in prose can carry, longest-first so a prefix never wins.
 *
 * Deliberately not `in`: "6 in" is a precipitation depth and "6 in the window" is a sentence, and
 * no regex can tell them apart. `inch` and `inches` are unambiguous and are what the provider's own
 * imperial unit string says.
 */
const PROSE_UNITS = [
  "°C",
  "°F",
  "km/h",
  "m/s",
  "mph",
  "inHg",
  "hPa",
  "mbar",
  "inches",
  "inch",
  "mm",
  "cm",
  "kt",
  "kn",
  "%",
  "σ",
];

/**
 * A number carrying one of those units, with whatever spacing the writer used between them.
 *
 * The trailing guard is `[A-Za-z0-9]` rather than a word boundary so that a measurement ending a
 * sentence — "…by 1.5 °C." — still matches, while `mm` inside `mmol` does not.
 */
const MEASURED = new RegExp(
  `(-?\\d+(?:\\.\\d+)?)(\\s*)(${PROSE_UNITS.map((unit) =>
    unit.replace(/[/]/g, "\\/"),
  ).join("|")})(?![A-Za-z0-9])`,
  "g",
);

/**
 * A bare float long enough that nothing measured it to that precision.
 *
 * Five places, not two, and that margin is the whole safety of this rule: a figure a writer chose
 * to give to three decimals is left alone, and only the ones that are plainly a float's tail get
 * shortened. The lookarounds keep it off anything that is not a decimal number on its own — a
 * timestamp's fractional seconds (`:` before), an identifier or a version (`\w` or `.` either
 * side), a date.
 */
const BARE = /(?<![\w.:-])(-?\d+\.\d{5,})(?![\d.:])/g;

/** A coordinate: a long float carrying the bare degree mark, with no scale letter after it. */
const COORDINATE = /(-?\d+\.\d{5,})°(?![CF])/g;

/**
 * Prose, with its measurements read at the precision their units are read at.
 *
 * Display only, and it takes a copy: the stored prose is what the run's grounding check matched
 * against and what Agent Evidence renders, and rewriting that record to make a page tidier would
 * make the audit disagree with the answer it audited. The wording is never touched — every
 * replacement is a number for a shorter number, in place.
 *
 * Order matters. Coordinates go first, because a degree mark with no scale letter after it is the
 * one case the measured pass would otherwise leave to the bare-float rule and round too hard.
 * Measurements go next, and the bare-float sweep last, by which point anything carrying a unit is
 * already short enough not to match it.
 */
export function formatProse(text: string): string {
  return text
    .replace(COORDINATE, (_match, value: string) => `${roundTo(Number(value), 4)}°`)
    .replace(
      MEASURED,
      (_match, value: string, gap: string, unit: string) =>
        `${roundTo(Number(value), placesFor(unit))}${gap}${unit}`,
    )
    .replace(BARE, (_match, value: string) => roundTo(Number(value), 2));
}
