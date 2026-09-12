/**
 * What the sky is doing, as the **provider** reports it.
 *
 * **This used to be inferred, and that was the defect.** Until the backend carried a condition, this
 * module derived a sky state from cloud cover and precipitation. It was careful, it was documented,
 * and it was still Weathra doing meteorology: `specs/safety-grounding` forbids characterising a
 * condition the retrieved data does not describe, and a percentage of cloud is not a description of
 * weather. `weather_code` is now requested from Open-Meteo and carried through the domain and the
 * API, so every label below is a translation of the provider's own published code.
 *
 * The codes are WMO 4677 as Open-Meteo publishes them. Translating a code to words is not a claim:
 * the provider said 61, and 61 means slight rain. What is *not* done is any judgement on top —
 * nothing here decides a storm is dangerous, and the severity referral in
 * `backend/weathra/agents/safety.py` remains the only thing that speaks to danger.
 *
 * One mapping, used by the hero, the hourly strip, the daily cards, Compare, Explorer and Watch, so
 * the same code is never described two ways on two screens.
 */

export type ConditionKind =
  | "clear"
  | "mostly-clear"
  | "partly-cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "heavy-rain"
  | "snow"
  | "showers"
  | "thunderstorm";

export interface Condition {
  readonly code: number;
  readonly kind: ConditionKind;
  /** What a person reads, as the provider's own code means it. */
  readonly label: string;
}

/**
 * WMO 4677, grouped the way Open-Meteo documents its own values.
 *
 * Grouped rather than one label per code because "slight", "moderate" and "dense" drizzle are three
 * codes and one thing to a reader; the distinction that survives is the one a person acts on.
 */
const CODES: readonly (readonly [readonly number[], ConditionKind, string])[] = [
  [[0], "clear", "Clear"],
  [[1], "mostly-clear", "Mostly clear"],
  [[2], "partly-cloudy", "Partly cloudy"],
  [[3], "overcast", "Overcast"],
  [[45, 48], "fog", "Fog"],
  [[51, 53, 55, 56, 57], "drizzle", "Drizzle"],
  [[61, 66], "rain", "Light rain"],
  [[63], "rain", "Rain"],
  [[65, 67], "heavy-rain", "Heavy rain"],
  [[71, 73, 75, 77, 85, 86], "snow", "Snow"],
  [[80, 81], "showers", "Showers"],
  [[82], "heavy-rain", "Violent showers"],
  [[95, 96, 99], "thunderstorm", "Thunderstorm"],
];

const BY_CODE = new Map<number, Condition>();
for (const [codes, kind, label] of CODES) {
  for (const code of codes) BY_CODE.set(code, { code, kind, label });
}

/**
 * The condition for a provider code, or `null` where none was reported.
 *
 * `null` for an unreported code *and* for a code this mapping does not know: inventing a label for
 * an unrecognised number would be describing weather nobody reported. The screens render nothing
 * rather than a guess, which is the same thing they did before any of this existed.
 */
export function conditionFor(code: number | null | undefined): Condition | null {
  if (typeof code !== "number" || !Number.isFinite(code)) return null;
  return BY_CODE.get(Math.trunc(code)) ?? null;
}

/** Whether a condition is a wet one, for a component choosing an emphasis. */
export function isWet(condition: Condition | null): boolean {
  return (
    condition !== null &&
    (["drizzle", "rain", "heavy-rain", "showers", "thunderstorm"] as const).includes(
      condition.kind as "drizzle" | "rain" | "heavy-rain" | "showers" | "thunderstorm",
    )
  );
}

/** The measure key the provider's code arrives under, instantaneous and daily. */
export const WEATHER_CODE = "weather_code";
export const WEATHER_CODE_DOMINANT = "weather_code_dominant";

/**
 * What the backend labels the condition reading inside a current-conditions result.
 *
 * `weathra/agents/nodes/support.py`'s own `_CURRENT_LABELS`, which is a fixed table rather than
 * free text, and `test_the_condition_reading_is_labelled_what_the_frontend_looks_for` pins it from
 * the other side so the two cannot drift apart quietly.
 *
 * **Why the label and not the unit.** A `Finding` reaches a screen as a label, a value and a unit,
 * with no measure key on it, so something has to identify the one figure that is a published code
 * rather than a quantity. The unit would be the natural key — the domain gives a code one that
 * names what the number *is* — but that string contains the name of a standards body, and
 * `lib/design/product-copy.test.ts` forbids those in shipped source without exception. The rule is
 * right and the exception is not worth making: the label is the backend's own constant, it is what
 * the panel renders anyway, and it is pinned on both sides.
 */
export const CONDITION_FINDING_LABEL = "Condition";

/**
 * The condition a reported figure describes, when that figure is the condition reading.
 *
 * `null` for everything else, so a caller can ask this of every figure it renders and get an answer
 * only where there is one. It is the same `conditionFor` the Dashboard, Compare, the Explorer and
 * Watch use — this only recognises the carrier, so the Analyst's Current conditions panel and the
 * Dashboard's hero cannot describe code 3 two different ways.
 */
export function conditionForFinding(
  label: string | null | undefined,
  value: number | null | undefined,
): Condition | null {
  return label?.trim() === CONDITION_FINDING_LABEL ? conditionFor(value) : null;
}
