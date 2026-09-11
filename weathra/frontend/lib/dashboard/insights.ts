/**
 * What Weathra can say about a forecast without asking a language model.
 *
 * **The gap this fills.** The Dashboard's Weathra Intelligence panel said *"Ask Weathra to read the
 * figures above"* and offered a button. That is a product promising its own headline feature rather
 * than delivering it: a person arriving on a populated Dashboard saw a forecast and an invitation
 * to press something, and nothing that answered *so what*.
 *
 * Every statement below is arithmetic over figures already on the screen — the same daily series
 * the forecast strip renders, and the same baseline the historical card shows. No model is called,
 * nothing is fetched, and nothing is asserted that the numbers do not contain. The AI Analyst
 * remains the deeper reading; this is the layer that should never have needed one.
 *
 * **What it will not do.** It does not predict, it does not explain *why*, and it does not describe
 * severity. Weathra's provider carries no condition code and no alerts, so "storm on Friday" is not
 * derivable and is not attempted — see `lib/weather/condition`. Each insight states a comparison
 * between figures and the day it belongs to, and nothing more.
 *
 * A statement is produced only when the figures support it. An insight list of two is correct when
 * two is what the data says; padding it would be the fabrication this product exists to avoid.
 */

import type { ForecastDay } from "./briefing";

export interface Insight {
  readonly key: string;
  /** The headline, six words at most. */
  readonly title: string;
  /** The figure that makes it true. */
  readonly value: string;
  /** Which day, or over what span. Absent when the insight is about the whole window. */
  readonly detail: string | null;
  /** Up, down or neutral — for the delta treatment a card gives it. */
  readonly direction: "up" | "down" | "flat";
}

/** A day's value for one measure, or null when the provider reported none. */
function readingOf(day: ForecastDay, key: string): number | null {
  if (key === "temperature_max") return day.high?.value ?? null;
  if (key === "temperature_min") return day.low?.value ?? null;
  const found = day.other.find((entry) => entry.key === key);
  return typeof found?.value === "number" ? found.value : null;
}

function unitOf(day: ForecastDay, key: string): string {
  if (key === "temperature_max") return day.high?.unit ?? "";
  if (key === "temperature_min") return day.low?.unit ?? "";
  return day.other.find((entry) => entry.key === key)?.unit ?? "";
}

/** `2026-09-12` → `Friday`, in the reader's locale, from the day's own local timestamp. */
function dayName(day: ForecastDay): string {
  const parsed = new Date(day.timeLocal);
  if (Number.isNaN(parsed.getTime())) return day.date;
  return parsed.toLocaleDateString(undefined, { weekday: "long" });
}

function round(value: number, places = 1): string {
  return value.toFixed(places).replace(/\.0$/, "");
}

/**
 * The insights a forecast window supports, strongest first.
 *
 * `baselineDifference` is the current period against its multi-year baseline where the Dashboard
 * has one; it is passed in rather than recomputed because the historical card already asked for it
 * and two requests for one figure would be a worse answer than none.
 */
export function insightsFor(
  days: readonly ForecastDay[],
  options: { readonly baselineDifference?: { value: number; unit: string; years: number } | null } = {},
): readonly Insight[] {
  const insights: Insight[] = [];
  if (days.length === 0) return insights;

  // ---------------------------------------------------------------- tomorrow against today
  const today = days[0];
  const tomorrow = days[1];
  if (today && tomorrow) {
    const from = readingOf(today, "temperature_max");
    const to = readingOf(tomorrow, "temperature_max");
    if (from !== null && to !== null) {
      const delta = to - from;
      // Half a degree is the smallest move worth a headline; below it the two days are the same day.
      if (Math.abs(delta) >= 0.5) {
        insights.push({
          key: "tomorrow-temperature",
          title: delta > 0 ? "Warmer tomorrow" : "Cooler tomorrow",
          value: `${delta > 0 ? "+" : "−"}${round(Math.abs(delta))} ${unitOf(tomorrow, "temperature_max")}`,
          detail: `against today's high of ${round(from)} ${unitOf(today, "temperature_max")}`,
          direction: delta > 0 ? "up" : "down",
        });
      } else {
        insights.push({
          key: "tomorrow-temperature",
          title: "Steady into tomorrow",
          value: `${round(to)} ${unitOf(tomorrow, "temperature_max")}`,
          detail: "much the same as today",
          direction: "flat",
        });
      }
    }
  }

  // ---------------------------------------------------------------- when it rains
  const wettest = strongest(days, "precipitation_sum");
  const likeliest = strongest(days, "precipitation_probability_max");
  if (likeliest && likeliest.value > 0) {
    insights.push({
      key: "rain-risk",
      title: "Rain most likely",
      value: `${round(likeliest.value, 0)}%`,
      detail: `on ${dayName(likeliest.day)}`,
      direction: "up",
    });
  } else if (wettest && wettest.value > 0) {
    insights.push({
      key: "rain-total",
      title: "Wettest day",
      value: `${round(wettest.value)} ${unitOf(wettest.day, "precipitation_sum")}`,
      detail: `on ${dayName(wettest.day)}`,
      direction: "up",
    });
  } else if (days.some((day) => readingOf(day, "precipitation_sum") !== null)) {
    insights.push({
      key: "rain-none",
      title: "No rain forecast",
      value: "0 mm",
      detail: `across the next ${days.length} days`,
      direction: "flat",
    });
  }

  // ---------------------------------------------------------------- the warmest day ahead
  const warmest = strongest(days, "temperature_max");
  if (warmest && days.length > 2) {
    insights.push({
      key: "warmest",
      title: "Warmest day",
      value: `${round(warmest.value)} ${unitOf(warmest.day, "temperature_max")}`,
      detail: `on ${dayName(warmest.day)}`,
      direction: "up",
    });
  }

  // ---------------------------------------------------------------- the wind, when it matters
  const gust = strongest(days, "wind_gust_max");
  if (gust && gust.value >= 50) {
    insights.push({
      key: "wind",
      title: "Strong gusts",
      value: `${round(gust.value, 0)} ${unitOf(gust.day, "wind_gust_max")}`,
      detail: `on ${dayName(gust.day)}`,
      direction: "up",
    });
  }

  // ---------------------------------------------------------------- against the years behind it
  const baseline = options.baselineDifference;
  if (baseline && Math.abs(baseline.value) >= 0.5) {
    insights.push({
      key: "baseline",
      title: baseline.value > 0 ? "Warmer than usual" : "Cooler than usual",
      value: `${baseline.value > 0 ? "+" : "−"}${round(Math.abs(baseline.value))} ${baseline.unit}`,
      detail: `against the ${baseline.years}-year average`,
      direction: baseline.value > 0 ? "up" : "down",
    });
  }

  return insights;
}

/** The day with the highest reported value for a measure, or null when none reported one. */
function strongest(
  days: readonly ForecastDay[],
  key: string,
): { day: ForecastDay; value: number } | null {
  let best: { day: ForecastDay; value: number } | null = null;
  for (const day of days) {
    const value = readingOf(day, key);
    if (value === null) continue;
    if (best === null || value > best.value) best = { day, value };
  }
  return best;
}

/**
 * The current window against the years behind it, from the two figures the Dashboard already holds.
 *
 * The baseline endpoint answers with the multi-year mean for this calendar window; the analysis
 * endpoint answers with the mean actually forecast for it. Neither response contains the
 * difference, because neither knows about the other — so it is subtracted here, once, from two
 * figures already on the screen rather than by asking for a third.
 *
 * `null` unless both sides reported a mean **in the same unit**: subtracting a Celsius mean from a
 * Fahrenheit one would produce a number, and the number would be wrong.
 */
export function baselineDifferenceOf(
  baseline: { mean?: { value?: number | null; unit?: string | null } | null; years_used?: number[] } | null,
  current: { value: number | null; unit: string | null } | null,
): { value: number; unit: string; years: number } | null {
  const reference = baseline?.mean;
  if (!reference || typeof reference.value !== "number" || !current || current.value === null) {
    return null;
  }
  const unit = reference.unit ?? "";
  if ((current.unit ?? "") !== unit) return null;

  return {
    value: current.value - reference.value,
    unit,
    years: baseline?.years_used?.length ?? 0,
  };
}
