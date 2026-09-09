/**
 * The Dashboard's adapter — task 21.1.
 *
 * The screen consumes the documented API and nothing else (`specs/web-ui`), so everything here is a
 * *reading* of a response the backend already returns: which measures it reported, what unit it
 * expressed each in, which day is which. Nothing is computed from weather values, nothing is
 * defaulted, and nothing is filled in.
 *
 * Three rules the functions below exist to enforce, each of which would otherwise be re-decided in
 * every card:
 *
 * **An absent measure is absent.** The API is explicit that a `null` value means the provider did
 * not report the measure and is never a zero. A reading with no value is dropped rather than
 * rendered as `0`, which would be a fabricated measurement in the most literal sense.
 *
 * **The unit comes from the response.** Every series and every current-conditions payload carries
 * its own `units` map, and that map is the only source of a unit shown on screen. The person's
 * preferred unit *system* is sent with the request; what comes back is what is displayed.
 *
 * **Nothing invents a name.** A measure the frontend has no label for is titled from its own key
 * rather than dropped or guessed at, so a backend that grows a measure shows it honestly on the day
 * it appears.
 */

import type {
  DayChange,
  Location,
  PreferenceView,
  Period,
  Series,
  WhatChanged,
} from "@/lib/api/schema";

/* ------------------------------------------------------------------ what changed */

/**
 * *What Changed?* — the forecast's movement since the last earlier snapshot of the same window.
 *
 * Both types come straight from the generated contract (`lib/api/schema.ts`), which is generated
 * from the backend's OpenAPI document — so they are `WhatChanged` and `DayChange` in
 * `weathra/weather/snapshots.py` rather than a hand-kept copy of them. `GET /api/v1/weather/changes`
 * returns that domain result unchanged; the screen reads it and computes no part of it.
 *
 * Three states reach the section, and the last two are different facts:
 *
 * - **A comparison** — `comparison_available` is true, both retrieval times are present, and
 *   `changes` carries the per-day deltas with their materiality.
 * - **No prior snapshot** — `comparison_available` is false, there is no previous retrieval time
 *   and no deltas. Never rendered as a zero delta, which would claim the forecast had not moved.
 * - **Unavailable** — no report at all, because the request failed. The section takes `null` for
 *   this, and it is deliberately distinct from the state above.
 */
export type WhatChangedReport = WhatChanged;

export type { DayChange };

/* --------------------------------------------------------------------- measures */

/**
 * What each measure is called on screen.
 *
 * Presentation naming for keys the API already defines — not a claim about what any of them means
 * and not a value of any kind.
 */
export const MEASURE_LABELS: Readonly<Record<string, string>> = {
  temperature: "Temperature",
  temperature_max: "High",
  temperature_min: "Low",
  temperature_mean: "Mean temperature",
  apparent_temperature: "Feels like",
  apparent_temperature_max: "Feels like, high",
  apparent_temperature_min: "Feels like, low",
  precipitation: "Precipitation",
  precipitation_sum: "Precipitation total",
  precipitation_hours: "Precipitation hours",
  precipitation_probability: "Precipitation probability",
  precipitation_probability_max: "Precipitation probability, highest",
  precipitation_probability_mean: "Precipitation probability, mean",
  wind_speed: "Wind speed",
  wind_speed_max: "Wind speed, highest",
  wind_gust: "Wind gust",
  wind_gust_max: "Wind gust, highest",
  wind_direction: "Wind direction",
  wind_direction_dominant: "Prevailing wind direction",
  relative_humidity: "Relative humidity",
  relative_humidity_mean: "Relative humidity, mean",
  dew_point: "Dew point",
  dew_point_mean: "Dew point, mean",
  surface_pressure: "Surface pressure",
  surface_pressure_mean: "Surface pressure, mean",
  cloud_cover: "Cloud cover",
  cloud_cover_mean: "Cloud cover, mean",
  uv_index: "UV index",
  uv_index_max: "UV index, highest",
};

/** A measure's name. An unrecognised key is titled from itself rather than dropped or guessed. */
export function measureLabel(key: string): string {
  const known = MEASURE_LABELS[key];
  if (known) return known;
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One reported figure: what it is, what it reads, and the unit the backend expressed it in. */
export interface Reading {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** From the response's own units map. Absent when the backend declared none for the measure. */
  readonly unit: string | null;
}

/**
 * The reported readings of a values map, in the order the backend listed them.
 *
 * A `null` value is *not reported* — dropped rather than shown as zero.
 */
export function readingsFrom(
  values: Readonly<Record<string, number | null>> | undefined,
  units: Readonly<Record<string, string>> | undefined,
): Reading[] {
  if (!values) return [];
  return Object.entries(values).flatMap(([key, value]) =>
    typeof value === "number" && Number.isFinite(value)
      ? [{ key, label: measureLabel(key), value, unit: units?.[key] ?? null }]
      : [],
  );
}

/** One named reading out of a map, or null when the backend did not report it. */
export function readingFor(
  key: string,
  values: Readonly<Record<string, number | null>> | undefined,
  units: Readonly<Record<string, string>> | undefined,
): Reading | null {
  return readingsFrom(values, units).find((reading) => reading.key === key) ?? null;
}

/**
 * A figure and its unit, as text.
 *
 * At most one decimal place, and never more precision than arrived: rounding *up* the number of
 * digits would be inventing precision, and rounding is applied only downward.
 */
export function formatReading(reading: Pick<Reading, "value" | "unit">): string {
  const rounded = Math.round(reading.value * 10) / 10;
  const figure = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return reading.unit ? `${figure} ${reading.unit}` : figure;
}

/* --------------------------------------------------------------------- forecast */

/** One day of the daily forecast series, as the strip renders it. */
export interface ForecastDay {
  /** The local calendar date, from the entry's own local timestamp. */
  readonly date: string;
  readonly timeLocal: string;
  readonly high: Reading | null;
  readonly low: Reading | null;
  /** Everything else the provider reported for the day. */
  readonly other: Reading[];
}

/* --------------------------------------------------------------- precipitation */

/**
 * What a day's card shows where `01-dashboard.png` shows a condition glyph — finding 1.8 of the
 * runtime fidelity audit of 2026-09-08.
 *
 * The artifact captions each day "LIGHT RAIN", "SUNNY", "OVERCAST". Weathra's provider reports no
 * condition, and it never will from this endpoint: the daily series carries figures. So this is
 * **not** a condition. It is the day's own precipitation, read back — a total in millimetres and
 * the day's maximum probability — and the glyph is a picture of that figure rather than a guess at
 * the sky. A dry day is drawn as "no precipitation reported for it", never as sunshine, because
 * zero rainfall is not evidence of clear sky and drawing a sun would be exactly the fabrication
 * this product exists to avoid.
 *
 * `null` when the provider reported neither figure: no glyph and no caption, on the same rule as
 * every other absent value on the screen.
 */
export type PrecipitationOutlookLevel = "wet" | "possible" | "dry";

export interface DayPrecipitation {
  readonly level: PrecipitationOutlookLevel;
  /** The caption under the glyph — a retrieved figure, formatted, never a word for the weather. */
  readonly caption: string;
  /** The glyph's accessible name, naming every figure it was drawn from. */
  readonly description: string;
}

/** The probability at which a day is drawn as one precipitation is expected on. */
const PRECIPITATION_LIKELY_PERCENT = 50;

export function dayPrecipitationFrom(day: ForecastDay): DayPrecipitation | null {
  const total = day.other.find((reading) => reading.key === "precipitation_sum") ?? null;
  const chance = day.other.find((reading) => reading.key === "precipitation_probability_max") ?? null;
  if (total === null && chance === null) return null;

  const totalText = total ? formatReading(total) : null;
  const chanceText = chance ? `${formatReading(chance)} chance` : null;
  // Both where both were reported, so the caption never implies the other figure is missing.
  const description = [totalText, chanceText].filter((part) => part !== null).join(", ");

  if (total !== null && total.value > 0) {
    return { level: "wet", caption: totalText ?? "", description: `Precipitation ${description}` };
  }
  if (chance !== null && chance.value >= PRECIPITATION_LIKELY_PERCENT) {
    return {
      level: "possible",
      caption: chanceText ?? "",
      description: `Precipitation ${description}`,
    };
  }
  return { level: "dry", caption: "No rain", description: `Precipitation ${description}` };
}

/** The local calendar date of a local timestamp, read as text so no timezone is re-applied. */
export function localDateOf(timeLocal: string): string {
  return /^(\d{4}-\d{2}-\d{2})/.exec(timeLocal)?.[1] ?? timeLocal;
}

/** The daily series, read into rows. Entries the backend did not send produce no rows. */
export function forecastDaysFrom(series: Series | undefined): ForecastDay[] {
  return (series?.entries ?? []).map((entry) => {
    const readings = readingsFrom(entry.values, series?.units);
    return {
      date: localDateOf(entry.time_local),
      timeLocal: entry.time_local,
      high: readings.find((reading) => reading.key === "temperature_max") ?? null,
      low: readings.find((reading) => reading.key === "temperature_min") ?? null,
      other: readings.filter(
        (reading) => reading.key !== "temperature_max" && reading.key !== "temperature_min",
      ),
    };
  });
}

/* ------------------------------------------------------------------ preferences */

/**
 * The location the briefing is for, or null when the person has saved no default.
 *
 * `specs/memory` has preferences report whether each value was *chosen* or assumed, and a default
 * location is only ever chosen — Weathra does not infer one from use. Null here is a real state
 * with its own screen, not a failure.
 */
export function briefingLocationFrom(preferences: PreferenceView | undefined): Location | null {
  return preferences?.default_location ?? null;
}

/** Whether the person chose this preference or Weathra assumed it, for the attribution line. */
export function preferenceSource(
  preferences: PreferenceView | undefined,
  field: string,
): string | null {
  const source = preferences?.sources?.[field];
  return typeof source === "string" ? source : null;
}

/* ------------------------------------------------------------------- historical */

/** The calendar window a baseline is asked for, taken from the forecast period's own local bounds. */
export function calendarWindowFrom(period: Period | undefined): { start: string; end: string } | null {
  if (!period) return null;
  const start = localDateOf(period.start_local);
  const end = localDateOf(period.end_local);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  return { start, end };
}
