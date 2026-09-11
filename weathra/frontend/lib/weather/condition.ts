/**
 * What the sky is doing, derived from the figures the provider actually reports.
 *
 * **Why this is derived rather than read.** `01-dashboard.png` labels its hero "Light Rain" and
 * every day card "SUNNY", "OVERCAST", "HEAVY RAIN". Weathra's provider integration carries no
 * condition code: `weather_code` is not in any response, and it is named in
 * `backend/weathra/agents/safety.py`'s severity-field guard, because a code that can encode a
 * thunderstorm is a severity claim and the project decided deliberately not to make one. So the
 * screens carried no condition at all, and a weather product whose hero cannot say whether it is
 * raining is not one.
 *
 * What the provider *does* report is cloud cover as a percentage, precipitation as a depth, and
 * (hourly) the chance of it. Cloud cover in oktas is the standard basis for a sky state — it is
 * what "partly cloudy" means — so the sky half of this is a unit conversion rather than a guess,
 * and the wet half is read off the precipitation figure itself.
 *
 * **What it will not say.** No thunderstorm, no snow, no fog, no severity of any kind. Those need
 * either a condition code or fields Weathra does not carry, and inferring a thunderstorm from heavy
 * rain is exactly the confident wrong answer `specs/safety-grounding` exists to prevent. A reading
 * with no cloud cover reported produces `null`, and the screen shows nothing rather than a default.
 *
 * The thresholds are the conventional ones and are stated here rather than buried in a component,
 * so the same rain is described the same way on the hero, the hourly strip and a comparison.
 */

export type ConditionKind = "clear" | "mostly-clear" | "partly-cloudy" | "cloudy" | "overcast" | "rain" | "heavy-rain";

export interface Condition {
  readonly kind: ConditionKind;
  /** What a person reads. Sentence case, because it sits under a temperature. */
  readonly label: string;
  /** Why it says that, for a title attribute — the figures, never a method. */
  readonly basis: string;
}

/** Millimetres in the period that count as raining, and as raining hard. */
const RAIN_MM = 0.1;
const HEAVY_RAIN_MM = 2.5;

/** Cloud cover percentages, on the conventional okta boundaries. */
const MOSTLY_CLEAR = 25;
const PARTLY_CLOUDY = 50;
const CLOUDY = 87;

const LABELS: Readonly<Record<ConditionKind, string>> = {
  clear: "Clear",
  "mostly-clear": "Mostly clear",
  "partly-cloudy": "Partly cloudy",
  cloudy: "Cloudy",
  overcast: "Overcast",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
};

export interface ConditionInput {
  /** Percentage, as the provider reports it. */
  readonly cloudCover?: number | null;
  /** Depth over the period the reading covers. */
  readonly precipitation?: number | null;
}

/**
 * The condition for one reading, or `null` when the provider reported nothing to derive it from.
 *
 * Precipitation wins over cloud cover: an overcast sky that is raining is described as rain,
 * because that is the thing a person needs to know.
 */
export function conditionFor(input: ConditionInput): Condition | null {
  const rain = numberOrNull(input.precipitation);
  const cloud = numberOrNull(input.cloudCover);

  if (rain !== null && rain >= HEAVY_RAIN_MM) {
    return make("heavy-rain", `${rain.toFixed(1)} mm of rain`);
  }
  if (rain !== null && rain >= RAIN_MM) {
    return make("rain", `${rain.toFixed(1)} mm of rain`);
  }
  if (cloud === null) return null;

  const basis = `${Math.round(cloud)}% cloud cover`;
  if (cloud < MOSTLY_CLEAR) return make("clear", basis);
  if (cloud < PARTLY_CLOUDY) return make("mostly-clear", basis);
  if (cloud < CLOUDY) return make("partly-cloudy", basis);
  if (cloud < 100) return make("cloudy", basis);
  return make("overcast", basis);
}

function make(kind: ConditionKind, basis: string): Condition {
  return { kind, label: LABELS[kind], basis };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether a condition is a wet one, for a component choosing an emphasis. */
export function isWet(condition: Condition | null): boolean {
  return condition?.kind === "rain" || condition?.kind === "heavy-rain";
}
