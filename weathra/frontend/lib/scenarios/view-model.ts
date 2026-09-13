/**
 * The Weather Scenario Lab's view model — one reading of one run, for the whole screen.
 *
 * `docs/design/screens/13-weather-scenario-lab.png` is a workspace, not a form: an assumptions
 * rail, a baseline card against a calculated card, a baseline-versus-scenario plot, four delta
 * tiles, an interpretation with its key deltas, a historical correlation block, and a disclaimer.
 * Every one of those reads the *same* run, so they are derived here once rather than each panel
 * deriving its own version of the truth and disagreeing at the edges.
 *
 * Three rules hold here.
 *
 * **The arithmetic is the backend's.** `POST /weather/scenario` applies the assumptions in
 * `analytics/scenario.py`, counts what they did in `summarise_effects`, and places the scenario
 * mean against the archive with the same comparison every other screen uses. Nothing below computes
 * a weather figure; it selects, labels, formats, and — for the two bar panels — takes a ratio of
 * two figures the backend already returned so a bar has a length.
 *
 * **A scenario is a transformation, not a forecast.** The product says so in its own words, and
 * this module never writes a sentence that could be read as a prediction. The interpretation is
 * assembled from the backend's own statements plus a lead line naming what was applied.
 *
 * **What the artifact invents is refused.** No 94.2% model matching, no 2.84σ over an institutional
 * normal, no inference-confidence bar, no evaporation rate, no thermal inertia, no infrastructure
 * tier, no 124 active nodes. Each has a real equivalent here or no tile at all.
 */

import type {
  Location,
  ScenarioAssumptions,
  ScenarioMeasure,
  ScenarioResponse,
  Series,
} from "@/lib/api/schema";
import {
  formatMeasured,
  formatSigma,
  roundTo,
  signedOf,
  toneOf,
} from "@/lib/format/figures";
import { measureLabel } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";

/* ------------------------------------------------------------- the controls */

/**
 * The four assumptions the backend accepts, with the ranges the lab offers.
 *
 * The offered range is deliberately narrower than the contract's: the endpoint validates
 * temperature to ±30 °C and wind to ±200 km/h, which are the bounds of what it will *accept*
 * rather than the bounds of a useful edge case. A slider that spends nine tenths of its travel on
 * values nobody reaches is a worse control than a shorter one, and typing an out-of-range figure
 * is still possible for anybody who wants it.
 */
export const ASSUMPTION_CONTROLS = [
  {
    key: "temperature_delta",
    label: "Temperature shift",
    unit: "°C",
    min: -10,
    max: 10,
    step: 0.5,
    measure: "temperature",
  },
  {
    key: "precipitation_percent",
    label: "Precipitation change",
    unit: "%",
    min: -100,
    max: 200,
    step: 5,
    measure: "precipitation",
  },
  {
    key: "relative_humidity_delta",
    label: "Humidity shift",
    unit: "pts",
    min: -30,
    max: 30,
    step: 1,
    measure: "relative_humidity",
  },
  {
    key: "wind_speed_delta",
    label: "Wind speed shift",
    unit: "km/h",
    min: -30,
    max: 50,
    step: 1,
    measure: "wind_speed",
  },
] as const;

export type AssumptionKey = (typeof ASSUMPTION_CONTROLS)[number]["key"];

export type AssumptionValues = Readonly<Record<AssumptionKey, number>>;

/** Every assumption at zero: the retrieved forecast, unchanged. */
export const BASELINE_ASSUMPTIONS: AssumptionValues = {
  temperature_delta: 0,
  precipitation_percent: 0,
  relative_humidity_delta: 0,
  wind_speed_delta: 0,
};

/** Whether anything has actually been supposed. A run of zeros is a baseline, not a scenario. */
export function isBaseline(values: AssumptionValues): boolean {
  return Object.values(values).every((value) => value === 0);
}

/** The request body's assumptions: only the ones actually made, as the contract wants them. */
export function assumptionsFor(values: AssumptionValues): ScenarioAssumptions {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => Number.isFinite(value) && value !== 0),
  ) as ScenarioAssumptions;
}

/** A stated assumption, formatted the way the artifact writes them: signed, with its unit. */
export function formatAssumption(key: AssumptionKey, value: number): string {
  const control = ASSUMPTION_CONTROLS.find((entry) => entry.key === key)!;
  const figure = roundTo(value, control.step < 1 ? 1 : 0);
  return `${value > 0 ? "+" : ""}${figure} ${control.unit}`;
}

/* --------------------------------------------------------------- the figures */

export interface LabFigure {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly tone?: "up" | "down" | "flat";
}

/** One measure's row out of the run, or null where no assumption addressed it. */
function measureFor(result: ScenarioResponse, measure: string): ScenarioMeasure | null {
  return (result.measures ?? []).find((entry) => entry.measure === measure) ?? null;
}

/** The mean of a measure across a series. Used only where the backend reported no row for it. */
function meanOf(series: Series | undefined, measure: string): number | null {
  const values = (series?.entries ?? [])
    .map((entry) => entry.values?.[measure])
    .filter((value): value is number => typeof value === "number");
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* --------------------------------------------------------------- the cards */

export interface BaselineCard {
  /** The representative figure, already formatted, or null where the provider reported none. */
  readonly headline: string | null;
  readonly headlineUnit: string | null;
  readonly caption: string;
  readonly supporting: readonly LabFigure[];
  readonly provider: string | null;
}

/**
 * What Weathra starts from: the retrieved forecast's own mean temperature, and three measures
 * beside it.
 *
 * The artifact calls this "CURRENT OBSERVED MEAN" over a station id. There is no station — the
 * baseline is a forecast series for a place, which is what the badge says — and the figure is the
 * mean of that series rather than a single instant, because a scenario is applied to the whole
 * window and a card claiming to show "now" would be describing a different thing from the chart
 * under it.
 */
export function baselineCardFrom(result: ScenarioResponse | null): BaselineCard | null {
  if (!result) return null;
  const units = result.baseline?.units ?? {};
  const mean = meanOf(result.baseline, "temperature");

  return {
    headline: mean === null ? null : roundTo(mean, 1),
    headlineUnit: units.temperature ?? null,
    caption: "Mean across the retrieved window",
    supporting: (["relative_humidity", "wind_speed", "precipitation"] as const)
      .flatMap<LabFigure>((measure) => {
        const value = meanOf(result.baseline, measure);
        return value === null
          ? []
          : [
              {
                key: measure,
                label: measureLabel(measure),
                value: formatMeasured(value, units[measure] ?? null),
              },
            ];
      }),
    provider: result.attribution?.provider ?? null,
  };
}

export interface ImpactCard extends BaselineCard {
  /** The signed movement of the headline figure, where an assumption moved it. */
  readonly delta: string | null;
  readonly tone: "up" | "down" | "flat";
}

/** What the assumptions make of it — the same three measures, after. */
export function impactCardFrom(result: ScenarioResponse | null): ImpactCard | null {
  if (!result) return null;
  const units = result.scenario?.units ?? {};
  const mean = meanOf(result.scenario, "temperature");
  const temperature = measureFor(result, "temperature");
  const difference = temperature?.difference ?? null;

  return {
    headline: mean === null ? null : roundTo(mean, 1),
    headlineUnit: units.temperature ?? null,
    caption: "Mean under the stated assumptions",
    delta:
      typeof difference === "number" && difference !== 0
        ? signedOf(difference, units.temperature ?? null)
        : null,
    tone: typeof difference === "number" ? toneOf(difference) : "flat",
    supporting: (["relative_humidity", "wind_speed", "precipitation"] as const)
      .flatMap<LabFigure>((measure) => {
        const value = meanOf(result.scenario, measure);
        if (value === null) return [];
        const row = measureFor(result, measure);
        const moved = typeof row?.difference === "number" && row.difference !== 0;
        return [
          {
            key: measure,
            label: measureLabel(measure),
            value: formatMeasured(value, units[measure] ?? null),
            note: moved ? signedOf(row!.difference!, units[measure] ?? null) : undefined,
            tone: typeof row?.difference === "number" ? toneOf(row.difference) : undefined,
          },
        ];
      }),
    provider: result.attribution?.provider ?? null,
  };
}

/* ------------------------------------------------------------ the delta strip */

/**
 * The artifact's four delta tiles, one per adjustable measure, always four.
 *
 * A measure no assumption addressed reads "Unchanged" rather than "+0.0", because those are
 * different facts: one is an assumption that cancelled out and the other is an assumption nobody
 * made. The artifact's fourth tile is an "ATM. STABILITY INDEX" percentage, which nothing computes;
 * humidity takes the slot, and it is the fourth quantity this lab can actually adjust.
 */
export function deltaTilesFrom(result: ScenarioResponse | null): LabFigure[] {
  if (!result) return [];
  const units = result.scenario?.units ?? {};

  return ASSUMPTION_CONTROLS.map((control) => {
    const row = measureFor(result, control.measure);
    const difference = row?.difference;

    if (row === null || typeof difference !== "number") {
      return {
        key: control.measure,
        label: control.label,
        value: "Unchanged",
        note: "No assumption applied",
        tone: "flat" as const,
      };
    }

    return {
      key: control.measure,
      label: control.label,
      value: signedOf(difference, units[control.measure] ?? row.unit ?? null),
      note: row.method,
      tone: toneOf(difference),
    };
  });
}

/* ------------------------------------------------------- the key what-if bars */

export interface KeyDelta extends LabFigure {
  /** 0–1, this movement against the largest in the run. A bar length, not a statistic. */
  readonly share: number;
}

/**
 * The artifact's "KEY WHAT-IF DELTA" bars, as the movements the run actually produced.
 *
 * Its two rows are an evaporation rate and a thermal inertia, neither of which Weathra computes.
 * These are the measures an assumption moved, ranked by how far each moved relative to its own
 * retrieved mean — the same ratio the backend ranks sensitivity by, so the bars and the sentence
 * beside them cannot disagree. The share is a bar length: it is stated as a percentage of the
 * largest movement in the run and is never presented as a figure about the weather.
 */
export function keyDeltasFrom(result: ScenarioResponse | null): KeyDelta[] {
  if (!result) return [];
  const units = result.scenario?.units ?? {};

  const rows = (result.measures ?? [])
    .filter((row) => typeof row.difference === "number" && row.difference !== 0)
    .map((row) => {
      const base = row.baseline_mean;
      const magnitude =
        typeof base === "number" && base !== 0
          ? Math.abs(row.difference! / base)
          : Math.abs(row.difference!);
      return { row, magnitude };
    });

  const largest = Math.max(...rows.map((entry) => entry.magnitude), 0);

  return rows
    .sort((left, right) => right.magnitude - left.magnitude)
    .slice(0, 3)
    .map(({ row, magnitude }) => ({
      key: row.measure,
      label: measureLabel(row.measure),
      value: signedOf(row.difference!, units[row.measure] ?? row.unit ?? null),
      note: `${roundTo(magnitude * 100, 1)}% of its retrieved mean`,
      tone: toneOf(row.difference!),
      share: largest === 0 ? 0 : magnitude / largest,
    }));
}

/* ------------------------------------------------------ the interpretation */

/**
 * The lab's reading of its own run — deterministic, and labelled as such.
 *
 * The artifact attributes this block to a "neural simulation engine v8.2" and carries an AI
 * INTERPRETATION badge. No language model is called here and none should be: a scenario is
 * arithmetic, the endpoint's own docstring refuses to spend somebody's allowance on a slider
 * movement, and a badge claiming a model wrote this would be false. It carries ANALYTICS.
 *
 * Every sentence is either assembled from figures the backend returned or is one of the backend's
 * own statements, in this order: what was applied, what that counted through to, which assumption
 * dominated, and what the result is not.
 */
export function interpretationFrom(
  result: ScenarioResponse | null,
  location: Location,
): readonly string[] {
  if (!result) return [];

  const applied = ASSUMPTION_CONTROLS.map((control) => {
    const value = (result.assumptions as Record<string, number | null | undefined>)[control.key];
    return typeof value === "number" && value !== 0
      ? `${control.label.toLowerCase()} ${formatAssumption(control.key, value)}`
      : null;
  }).filter((clause): clause is string => clause !== null);

  const lead =
    applied.length === 0
      ? `No assumption is applied, so this is the retrieved ${result.horizon_days}-day forecast for ${friendlyName(location)}, unchanged.`
      : `Applied to the retrieved ${result.horizon_days}-day forecast for ${friendlyName(location)}: ${applied.join(", ")}.`;

  const closing =
    "It is a transformation of a retrieved forecast, not a physical model of the atmosphere: a series two degrees warmer is not the weather a warmer atmosphere would produce.";

  return [lead, result.effects?.risk?.detail, result.effects?.sensitivity?.detail, closing].filter(
    (sentence): sentence is string => Boolean(sentence),
  );
}

/* --------------------------------------------------------- the archive block */

export interface HistoricalView {
  readonly headline: string;
  readonly figures: readonly LabFigure[];
  readonly analog: LabFigure | null;
  readonly method: string;
  readonly years: number;
  readonly provider: string | null;
  readonly labelling: string;
}

/**
 * The archive block, from the comparison the backend already made.
 *
 * The artifact's "MODEL MATCHING 94.2%" and "BASELINE SIGMA 2.84σ" are a correlation against an
 * institutional normal that Weathra neither holds nor computes. What replaces them sits in the same
 * two slots and is real: the scenario's distance from the archive baseline as a z-score, its
 * percentile rank among the archived years, and the single year whose own mean for this window sits
 * closest to the scenario's — a nearest neighbour in one dimension, with the distance printed so it
 * can be judged rather than trusted.
 */
export function historicalFrom(result: ScenarioResponse | null): HistoricalView | null {
  const history = result?.history;
  if (!history) return null;

  const comparison = history.comparison;
  const baseline = comparison.baseline;
  const figures: LabFigure[] = [];

  const zScore = comparison.z_score?.value;
  if (typeof zScore === "number") {
    figures.push({
      key: "sigma",
      label: "Distance from baseline",
      value: formatSigma(zScore),
      note: "Standard deviations from the archive mean",
      tone: toneOf(zScore),
    });
  }

  const difference = comparison.difference?.value;
  if (typeof difference === "number") {
    figures.push({
      key: "difference",
      label: "Against archive mean",
      value: signedOf(difference, comparison.difference.unit ?? null),
      tone: toneOf(difference),
    });
  }

  const rank = comparison.percentile_rank?.value;
  if (typeof rank === "number") {
    figures.push({
      key: "rank",
      label: "Percentile among archived years",
      value: `${roundTo(rank, 1)}%`,
    });
  }

  return {
    headline: comparison.characterization,
    figures: figures.slice(0, 3),
    analog: history.nearest_analog
      ? {
          key: "analog",
          label: `Nearest archived year · ${history.nearest_analog.year}`,
          value: formatMeasured(history.nearest_analog.mean, history.nearest_analog.unit ?? null),
          note: `${formatMeasured(history.nearest_analog.distance, history.nearest_analog.unit ?? null)} from this scenario's mean`,
        }
      : null,
    method: history.method,
    years: baseline?.years_used?.length ?? 0,
    provider: baseline?.provider ?? null,
    labelling: baseline?.labelling ?? "",
  };
}

/* ------------------------------------------------------------ the run's basis */

export interface BasisRow {
  readonly label: string;
  readonly value: string;
  readonly complete: boolean;
}

/**
 * The artifact's "INFERENCE CONFIDENCE" bar, as the four things that are either present or not.
 *
 * There is no inference and no confidence to report: the transformation is exact arithmetic, so a
 * percentage there would be measuring nothing. What a person actually needs to know before reading
 * a run is which of its inputs arrived — the forecast, the hours it carries, the archive it is
 * compared against, and whether any hour hit a physical bound. Each row is a fact with a yes or a
 * no behind it.
 */
export function basisFrom(result: ScenarioResponse | null): BasisRow[] {
  if (!result) return [];

  const hours = result.baseline?.entries?.length ?? 0;
  const clipped = (result.measures ?? []).reduce((sum, row) => sum + (row.clipped ?? 0), 0);
  const excluded = (result.measures ?? []).reduce((sum, row) => sum + (row.points_excluded ?? 0), 0);

  return [
    {
      label: "Baseline forecast",
      value: `${hours} hour${hours === 1 ? "" : "s"} retrieved`,
      complete: hours > 0,
    },
    {
      label: "Archive comparison",
      value: result.history ? `${result.history.comparison.baseline?.years_used?.length ?? 0} years` : "Unavailable",
      complete: Boolean(result.history),
    },
    {
      label: "Hours held at a bound",
      value: clipped === 0 ? "None" : `${clipped}`,
      complete: clipped === 0,
    },
    {
      label: "Hours with nothing to adjust",
      value: excluded === 0 ? "None" : `${excluded}`,
      complete: excluded === 0,
    },
  ];
}
