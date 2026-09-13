/**
 * The Saved Locations workspace's view model — one reading of one overview, for every panel.
 *
 * `docs/design/screens/06-saved-locations.png` is a multi-location weather workspace rather than a
 * list of records: a header with search and one primary action, a grid of weather cards, a
 * cross-location summary against a comparison rail, and the allowance demoted to a strip. Every one
 * of those reads the *same* response, so they are derived here once rather than each panel deriving
 * its own version of the truth.
 *
 * Three rules hold here.
 *
 * **The arithmetic is the backend's.** `GET /me/locations/overview` retrieves each place's current
 * conditions once and computes the comparison in `analytics/saved_places.py`. Nothing below
 * computes a weather figure; it selects, labels and formats.
 *
 * **A place is named, never plotted.** The canonical resolved name is the identity on every card.
 * Coordinates are internal metadata and appear nowhere as a place's name.
 *
 * **What the artifact invents is refused.** No workspace id, no 124 grounding nodes, no telemetry
 * sync, no sensor calibration, no grounding precision, no model consensus, no compliance lock, and
 * no standing "attention required" banner. Each has a real equivalent here or no panel at all.
 */

import type {
  Measure,
  PlacesComparison,
  SavedLocationsOverview,
  SavedPlaceAttention,
  SavedPlaceCard,
} from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import { formatMeasured, roundTo } from "@/lib/format/figures";
import { friendlyName } from "@/lib/locations/place";
import { conditionFor, type Condition } from "@/lib/weather/condition";

/* ----------------------------------------------------------------- the cards */

export interface PlaceMetric {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface WorkspaceCard {
  readonly savedId: string;
  /** The canonical name a person reads. Never coordinates. */
  readonly name: string;
  /** What sits under it — region and country, where the place has them. */
  readonly qualifier: string | null;
  readonly isDefault: boolean;
  readonly watchCount: number;
  readonly metWatchCount: number;
  readonly temperature: string | null;
  readonly condition: Condition | null;
  readonly metrics: readonly PlaceMetric[];
  readonly observedAt: string | null;
  readonly provider: string | null;
  /** Why there is no weather. A saved place is never dropped for this. */
  readonly unavailable: string | null;
}

/** The three chips under the temperature, in the order the artifact puts them. */
const CHIPS: readonly Measure[] = ["precipitation", "relative_humidity", "wind_speed"];

/**
 * The place's own name, and the part of its identity that qualifies it.
 *
 * `friendlyName` composes the whole thing — "London, England, United Kingdom" — and the card wants
 * it in two lines: the name to read at a glance, and the rest under it. Split on the first comma of
 * the composed label rather than reassembling from the fields, so the two halves always add back up
 * to exactly what every other screen in the product shows.
 */
export function nameParts(location: SavedPlaceCard["location"]): {
  name: string;
  qualifier: string | null;
} {
  const whole = friendlyName(location);
  const comma = whole.indexOf(", ");
  return comma === -1
    ? { name: whole, qualifier: null }
    : { name: whole.slice(0, comma), qualifier: whole.slice(comma + 2) };
}

/** One saved place as its card reads it. */
export function cardsFrom(overview: SavedLocationsOverview): readonly WorkspaceCard[] {
  return (overview.places ?? []).map((place) => {
    const { name, qualifier } = nameParts(place.location);
    const values = place.conditions?.values ?? {};
    const units = place.conditions?.units ?? {};
    const temperature = values.temperature;

    return {
      savedId: place.saved_id,
      // A label the person typed outranks the provider's name for the place, because they chose it.
      name: place.label?.trim() || name,
      qualifier: place.label?.trim() ? friendlyName(place.location) : qualifier,
      isDefault: place.is_default ?? false,
      watchCount: place.watch_count ?? 0,
      metWatchCount: place.met_watch_count ?? 0,
      temperature:
        typeof temperature === "number"
          ? `${roundTo(temperature, 1)}${units.temperature ?? ""}`
          : null,
      condition: conditionFor(
        typeof values.weather_code === "number" ? values.weather_code : null,
      ),
      metrics: CHIPS.flatMap<PlaceMetric>((measure) => {
        const value = values[measure];
        return typeof value !== "number"
          ? []
          : [
              {
                key: measure,
                label: measureLabel(measure),
                value: formatMeasured(value, units[measure] ?? null),
              },
            ];
      }),
      observedAt: place.conditions?.observed_at ?? null,
      provider: place.conditions?.provider ?? null,
      unavailable: place.unavailable ?? null,
    };
  });
}

/** Saved places whose name or qualifier matches what was typed. Filters, never geocodes. */
export function filterCards(
  cards: readonly WorkspaceCard[],
  query: string,
): readonly WorkspaceCard[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return cards;
  return cards.filter((card) =>
    `${card.name} ${card.qualifier ?? ""}`.toLowerCase().includes(wanted),
  );
}

/* ------------------------------------------------------------- the overview */

export interface OverviewFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/**
 * The cross-location summary, as facts rather than prose.
 *
 * Every one is a max, a min or a count the backend computed over readings it had already
 * retrieved. No language model is called to fill this panel: a summary of four numbers does not
 * need one, and spending somebody's allowance to be told which of two cities is warmer would be
 * the clearest possible waste of it.
 */
export function overviewFactsFrom(
  comparison: PlacesComparison | null | undefined,
): readonly OverviewFact[] {
  if (!comparison) return [];
  const facts: OverviewFact[] = [];

  if (comparison.warmest) {
    facts.push({
      key: "warmest",
      label: "Warmest",
      value: comparison.warmest.name,
      note: formatMeasured(comparison.warmest.value, comparison.warmest.unit ?? null),
    });
  }
  if (comparison.coolest) {
    facts.push({
      key: "coolest",
      label: "Coolest",
      value: comparison.coolest.name,
      note: formatMeasured(comparison.coolest.value, comparison.coolest.unit ?? null),
    });
  }
  if (typeof comparison.temperature_spread === "number") {
    facts.push({
      key: "spread",
      label: "Temperature spread",
      value: formatMeasured(comparison.temperature_spread, comparison.temperature_unit ?? null),
      note: `Across ${comparison.compared} saved places`,
    });
  }
  if (comparison.windiest) {
    facts.push({
      key: "windiest",
      label: "Windiest",
      value: comparison.windiest.name,
      note: formatMeasured(comparison.windiest.value, comparison.windiest.unit ?? null),
    });
  }
  facts.push({
    key: "wet",
    label: "Reporting precipitation",
    value: String(comparison.reporting_precipitation ?? 0),
    note:
      (comparison.reporting_precipitation ?? 0) === 0
        ? "None of them, right now"
        : `Of ${comparison.compared} compared`,
  });

  return facts;
}

/**
 * One deterministic sentence about the saved places, assembled from the figures already returned.
 *
 * Assembled, never generated. A summary of four numbers does not need a language model, and
 * spending somebody's allowance to be told which of two cities is warmer would be the clearest
 * possible waste of it — so every clause below is a figure the backend computed, joined by fixed
 * words, and a clause whose figure is missing is simply not written.
 */
export function overviewSummaryFrom(
  comparison: PlacesComparison | null | undefined,
): string | null {
  if (!comparison) return null;
  const { warmest, coolest, windiest } = comparison;
  if (!warmest || !coolest) return null;

  const unit = comparison.temperature_unit ?? null;
  const clauses: string[] = [
    `${warmest.name} is currently the warmest saved location at ${formatMeasured(warmest.value, unit)}` +
      (typeof comparison.temperature_spread === "number" && comparison.temperature_spread > 0
        ? `, ${formatMeasured(comparison.temperature_spread, unit)} warmer than ${coolest.name}`
        : ""),
  ];

  if (windiest) {
    clauses.push(
      `${windiest.name === warmest.name ? "It" : windiest.name} also has the highest wind speed at ${formatMeasured(windiest.value, windiest.unit ?? null)}`,
    );
  }

  const wet = comparison.reporting_precipitation ?? 0;
  clauses.push(
    wet === 0
      ? "None of them is reporting measurable precipitation"
      : wet === 1 && comparison.wettest
        ? `${comparison.wettest.name} is the only one reporting measurable precipitation`
        : `${wet} of ${comparison.compared} are reporting measurable precipitation`,
  );

  return `${clauses.join(". ")}.`;
}

/* ------------------------------------------------------------ the comparison */

export interface ComparisonMeasureRow {
  readonly key: string;
  readonly label: string;
  readonly left: string | null;
  readonly right: string | null;
  readonly difference: string | null;
}

export interface ComparisonView {
  /** The two places being compared, named so the pair is never ambiguous. */
  readonly leftName: string;
  readonly rightName: string;
  readonly rows: readonly ComparisonMeasureRow[];
  /** Why these two, where they were chosen rather than being the only two. */
  readonly basis: string | null;
}

/** The measures the compact preview compares, in the order the cards show them. */
const COMPARED: readonly { measure: Measure; label: string; difference: boolean }[] = [
  { measure: "temperature", label: "Temperature", difference: true },
  { measure: "precipitation", label: "Precipitation", difference: false },
  { measure: "relative_humidity", label: "Humidity", difference: false },
  { measure: "wind_speed", label: "Wind", difference: false },
];

/**
 * A compact side-by-side of two saved places, across every measure both of them reported.
 *
 * It used to compare temperature alone, which threw away three quarters of a retrieval the page had
 * already paid for. It is still only a *preview*: Compare Cities ranks places against a criterion
 * over a window, and the button beneath this is how somebody gets that.
 *
 * **The pair is named, never implied.** Above two saved places there is no natural pair, so the
 * warmest and the coolest are chosen and the panel says that is what they are — an unlabelled pair
 * out of five would leave a reader guessing which two the figures belong to.
 */
export function comparisonFrom(
  cards: readonly WorkspaceCard[],
  overview: SavedLocationsOverview,
): ComparisonView | null {
  const byId = new Map((overview.places ?? []).map((place) => [place.saved_id, place]));
  const withReadings = cards.filter((card) => byId.get(card.savedId)?.conditions);
  if (withReadings.length < 2) return null;

  const comparison = overview.comparison;
  const warmestId = comparison?.warmest?.saved_id;
  const coolestId = comparison?.coolest?.saved_id;

  const chosen =
    withReadings.length > 2 && warmestId && coolestId
      ? [
          withReadings.find((card) => card.savedId === warmestId),
          withReadings.find((card) => card.savedId === coolestId),
        ].filter((card): card is WorkspaceCard => card !== undefined)
      : withReadings.slice(0, 2);

  if (chosen.length < 2) return null;
  const [left, right] = chosen as [WorkspaceCard, WorkspaceCard];

  const reading = (card: WorkspaceCard, measure: Measure) => {
    const place = byId.get(card.savedId);
    const value = place?.conditions?.values?.[measure];
    return typeof value === "number"
      ? { value, unit: place?.conditions?.units?.[measure] ?? null }
      : null;
  };

  return {
    leftName: left.name,
    rightName: right.name,
    basis:
      withReadings.length > 2
        ? `The warmest and coolest of your ${withReadings.length} places reporting a reading.`
        : null,
    rows: COMPARED.flatMap<ComparisonMeasureRow>(({ measure, label, difference }) => {
      const a = reading(left, measure);
      const b = reading(right, measure);
      // A measure neither of them reported is not a row; one that only one reported still is,
      // because "London 8.6 km/h, Berlin not reported" is a fact worth seeing.
      if (a === null && b === null) return [];
      return [
        {
          key: measure,
          label,
          left: a === null ? null : formatMeasured(a.value, a.unit),
          right: b === null ? null : formatMeasured(b.value, b.unit),
          difference:
            difference && a !== null && b !== null
              ? formatMeasured(Math.abs(a.value - b.value), a.unit)
              : null,
        },
      ];
    }),
  };
}

/* -------------------------------------------------------------- the usage */

export interface UsageFigure {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** The allowance, demoted to a strip. Real, and never the page's subject. */
export function usageFrom(overview: SavedLocationsOverview): readonly UsageFigure[] {
  const summary = overview.summary;
  return [
    { key: "saved", label: "Saved", value: `${summary.saved_count} / ${summary.limit}` },
    { key: "remaining", label: "Remaining", value: String(summary.remaining) },
    { key: "countries", label: "Countries", value: String(summary.country_count) },
    { key: "zones", label: "Time zones", value: String(summary.timezone_count) },
  ];
}

/** How full the allowance is, 0–1, for the usage bar. */
export function usageShare(overview: SavedLocationsOverview): number {
  const { saved_count: saved, limit } = overview.summary;
  return limit <= 0 ? 0 : Math.min(saved / limit, 1);
}

/* ----------------------------------------------------------- the attention */

export interface AttentionItem extends SavedPlaceAttention {
  readonly tone: "watch" | "unavailable";
}

/**
 * The places that genuinely want looking at.
 *
 * The artifact carries a standing ATMOSPHERIC ATTENTION REQUIRED banner. A banner that is always
 * there is decoration, and on a weather product decoration reading *attention required* is worse
 * than none — so this is empty whenever nothing is wrong, and the screen composes without it.
 */
export function attentionFrom(
  overview: SavedLocationsOverview,
): readonly AttentionItem[] {
  return (overview.attention ?? []).map((item) => ({
    ...item,
    tone: item.kind === "watch_met" ? "watch" : "unavailable",
  }));
}

/* --------------------------------------------------------------- formatting */

/** How long ago a reading was taken, for a card that has no room for a date. */
export function agoOf(value: string | null | undefined, now: Date): string {
  if (!value) return "not retrieved";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const minutes = Math.round((now.getTime() - parsed.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
