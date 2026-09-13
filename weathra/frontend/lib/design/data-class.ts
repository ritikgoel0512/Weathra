/**
 * The five data classes, and the three tiers of provenance underneath them — task 20.15.
 *
 * `docs/design/design-system.md` §9 fixes the five classes and `specs/web-ui` requires every
 * displayed weather value to carry one. Two things are needed before a screen can do that, and both
 * live here because both must have exactly one answer:
 *
 * **The backend's names are not the design's names.** The API reports `current`,
 * `historical_observation`, `computed_statistic`, `ai_interpretation`; the design system's badges
 * are OBSERVED, HISTORICAL, ANALYTICS, AI INTERPRETATION. A screen translating for itself is a
 * screen that can translate wrongly, and mislabelling a model's prose as a measurement is the one
 * mistake this interface must not make. `dataClassFor` returns `null` for anything it does not
 * recognise rather than guessing — an unlabelled figure is recoverable, a wrongly labelled one is
 * not.
 *
 * **Three tiers, not five.** The classes distinguish *what a figure is*; the tier distinguishes
 * *who produced it*, which is the distinction the architecture actually turns on:
 *
 * | Tier | Classes | Produced by |
 * |---|---|---|
 * | `retrieved` | observed, forecast, historical | A weather provider, through the MCP layer |
 * | `computed` | analytics | Weathra's deterministic analytics engine |
 * | `interpretation` | interpretation | The language model, about figures it did not produce |
 *
 * The tier is what `ProvenanceSection` puts on the DOM, so the separation between retrieved data,
 * deterministic calculation, and model-written language is a property a test can assert rather
 * than a layout somebody has to keep remembering.
 */

import type { DataClassName } from "./tokens";

/** Who produced a figure. The distinction the locked architecture turns on. */
export type ProvenanceTier = "retrieved" | "computed" | "interpretation";

/**
 * The data class each of the backend's `DataClass` values means.
 *
 * Mirrors `weathra/domain/weather.py`'s `DataClass` through the generated `lib/api/schema.ts`. It
 * is written out rather than derived so that a value appearing on one side and not the other is a
 * type error here instead of a silently unbadged figure on screen.
 */
export const DATA_CLASS_BY_API: Readonly<Record<string, DataClassName>> = {
  current: "observed",
  forecast: "forecast",
  historical_observation: "historical",
  computed_statistic: "analytics",
  ai_interpretation: "interpretation",
};

/** The design system's data class for a backend `data_class`, or null if it is not one of them. */
export function dataClassFor(value: string | null | undefined): DataClassName | null {
  if (typeof value !== "string") return null;
  return DATA_CLASS_BY_API[value] ?? null;
}

const TIERS: Readonly<Record<DataClassName, ProvenanceTier>> = {
  observed: "retrieved",
  forecast: "retrieved",
  historical: "retrieved",
  analytics: "computed",
  interpretation: "interpretation",
};

/** Which tier a data class belongs to. */
export function tierOf(dataClass: DataClassName): ProvenanceTier {
  return TIERS[dataClass];
}

/**
 * Whether the figure was *retrieved* from a weather provider rather than produced here.
 *
 * Observed, forecast and historical values are all a provider's numbers. Weathra normalizes them
 * and never computes one of its own into this tier.
 */
export function isRetrieved(dataClass: DataClassName): boolean {
  return tierOf(dataClass) === "retrieved";
}

/** Whether the figure was computed deterministically by Weathra's analytics engine. */
export function isComputed(dataClass: DataClassName): boolean {
  return tierOf(dataClass) === "computed";
}

/** Whether this is language a model wrote about figures it did not produce. */
export function isInterpretation(dataClass: DataClassName): boolean {
  return tierOf(dataClass) === "interpretation";
}

/**
 * The confidence bands a forecast figure can carry, as the backend reports them.
 *
 * Three named bands and nothing between: `specs/web-ui` asks for confidence to be presented with
 * its basis, and a band is the honest resolution a single provider's output supports. A percentage
 * would be precision Weathra does not have.
 */
export const CONFIDENCE_LEVELS = ["high", "moderate", "low"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** The confidence band, or null when the value is not one Weathra recognises. */
export function confidenceLevelFor(value: string | null | undefined): ConfidenceLevel | null {
  return CONFIDENCE_LEVELS.includes(value as ConfidenceLevel) ? (value as ConfidenceLevel) : null;
}

/* ------------------------------------------------ classes the five do not cover */

/**
 * How a stored class the design system fixes no badge for is shown.
 *
 * `design-system.md` §9 fixes five classes and their colours, and `satellite_observation` — kept
 * apart in the domain so a picture of a region is never conflated with a provider's figure for a
 * place — is not one of them. Adding a sixth is a design-system change; *naming* the class a reader
 * is looking at is a wiring one, and until this existed the evidence table printed `not reported`
 * in the one column whose whole job is to say what kind of claim a row supports.
 *
 * So the class keeps its own **word** and borrows a **colour**. `SATELLITE` is the backend's own
 * `satellite_observation` said the way the five fixed labels say theirs, and the colour is
 * observed's because an image from orbit is an observation — the same choice the Analyst's source
 * rail already made, written down once here so the two surfaces cannot drift apart. Borrowing a
 * colour is never a claim that this *is* that class: the word is what the reader reads.
 */
export interface UnbadgedClass {
  /** The word the badge announces, in the register of the five fixed labels. */
  readonly label: string;
  /** The class whose colour it borrows. */
  readonly dataClass: DataClassName;
  /** What it means, for the badge's title — the honest sentence, as the five fixed ones have. */
  readonly description: string;
}

/** Every stored class this build can name but the design system fixes no badge for. */
export const UNBADGED_CLASSES: Readonly<Record<string, UnbadgedClass>> = {
  satellite_observation: {
    label: "SATELLITE",
    dataClass: "observed",
    description: "Imagery observed from orbit. A picture of a region, carrying no figure of its own.",
  },
};

/** The borrowed-badge spec for a stored class, or null when one of the five covers it — or nothing does. */
export function unbadgedClassFor(value: string | null | undefined): UnbadgedClass | null {
  if (typeof value !== "string") return null;
  return UNBADGED_CLASSES[value] ?? null;
}
