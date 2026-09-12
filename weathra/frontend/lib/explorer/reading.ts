/**
 * What Forecast Explorer reads out of the three responses it already has.
 *
 * Pure functions, in one file, because every one of them is a *presentation* decision over data the
 * backend already computed — which hours to show, what to call an instant, which three of the
 * findings lead — and each one is a place a screen could accidentally start inventing. A sampling
 * rule that silently dropped the wettest hour, or a label that shifted an instant into the reader's
 * own timezone, would both be wrong in ways a component test over rendered markup would not notice.
 *
 * Nothing here computes a weather figure. Every number these return came from a provider or from
 * `/weather/analysis`.
 */

import type { AnalysisResponse, SeriesEntry, StatisticResult } from "@/lib/api/schema";

/* ------------------------------------------------------------------ local time */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * A provider instant as a person reads it: `Mon 08:00`.
 *
 * **Parsed textually, never through `Date` arithmetic on the viewer's clock.** `time_local` is
 * already the instant *at the place* with its offset attached — `2026-09-04T08:00:00+02:00` is
 * eight in the morning in Berlin. Handing that to `new Date()` and formatting it produces eight in
 * the morning *wherever the reader is sitting*, which is a different hour and a wrong one. The
 * weekday needs a calendar, so the date part alone goes through `Date.UTC`, where no offset can
 * reach it.
 *
 * Returns null for anything that is not the shape the contract promises, because a half-parsed
 * timestamp is worse than an absent one.
 */
export function localLabel(timeLocal: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(timeLocal ?? "");
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${weekday} ${hour}:${minute}`;
}

/** The hour alone, for a horizon short enough that every entry is the same day. */
export function hourLabel(timeLocal: string | null | undefined): string | null {
  const match = /[T ](\d{2}:\d{2})/.exec(timeLocal ?? "");
  return match ? (match[1] ?? null) : null;
}

/** The calendar day an entry falls on, as the provider stated it. */
function dayOf(timeLocal: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(timeLocal ?? "");
  return match ? (match[1] ?? null) : null;
}

function hourOf(timeLocal: string | null | undefined): number | null {
  const match = /[T ](\d{2}):/.exec(timeLocal ?? "");
  return match ? Number(match[1]) : null;
}

/* --------------------------------------------------------------- the matrix rows */

/**
 * The hours the matrix leads with, at every horizon.
 *
 * `11-forecast-explorer.png` shows five rows at four-hourly intervals and calls the table
 * high-resolution. Production rendered every entry the provider sent — 28 rows at three days, and
 * well past a hundred at fourteen — which is the whole dataset presented as a page rather than a
 * table somebody reads.
 *
 * The rule is deterministic and stated: the entries closest to these local hours, one per day, in
 * order, capped. Nothing is averaged, nothing is interpolated, and every row is an entry the
 * provider actually sent — `full` keeps all of them, which is what the disclosure beneath renders.
 */
const PREFERRED_HOURS = [8, 12, 16, 20] as const;

export function matrixRows(
  entries: readonly SeriesEntry[],
  limit = 8,
): readonly SeriesEntry[] {
  if (entries.length <= limit) return entries;

  /*
   * One pass per preferred hour rather than a filter, so a horizon whose entries are six-hourly
   * still yields rows: the entry *nearest* each preferred hour is taken, and a day that has no
   * entry within three hours of one contributes nothing for it rather than a distant stand-in.
   */
  const chosen = new Map<string, SeriesEntry>();
  for (const entry of entries) {
    const day = dayOf(entry.time_local);
    const hour = hourOf(entry.time_local);
    if (day === null || hour === null) continue;

    for (const preferred of PREFERRED_HOURS) {
      const distance = Math.abs(hour - preferred);
      if (distance > 3) continue;
      const key = `${day}|${preferred}`;
      const held = chosen.get(key);
      const heldHour = held ? hourOf(held.time_local) : null;
      if (held === undefined || heldHour === null || Math.abs(heldHour - preferred) > distance) {
        chosen.set(key, entry);
      }
    }
  }

  const sampled = [...chosen.values()].sort((left, right) =>
    (left.time_local ?? "").localeCompare(right.time_local ?? ""),
  );

  // A series whose stamps this build cannot read falls back to the first `limit` entries, which is
  // still every row being a real entry — just not the ones the rule would have preferred.
  return (sampled.length > 0 ? sampled : [...entries]).slice(0, limit);
}

/* ------------------------------------------------------------------ the signals */

/** One thing the window shows, in the words a reader uses, from a figure the backend computed. */
export interface TrendSignal {
  readonly key: string;
  readonly text: string;
  /** When it happens, where the statistic carried an instant. */
  readonly when: string | null;
}

/**
 * Which computed findings lead, and how each one reads.
 *
 * The artifact's version of this list is three invented anomalies — a rain probability that
 * increased 12%, a North-West cold air incursion, a pressure drift at station BER-09. Two of those
 * are causal claims about an atmosphere Weathra does not model and the third names a station it
 * does not read.
 *
 * What replaces them is the same slot filled from `/weather/analysis`: the three statistics a
 * person would actually look for, phrased. Each is one finding, said once. A statistic the analysis
 * did not compute produces no signal rather than a sentence about its absence — the full list is a
 * press away and that is where an absence is worth explaining.
 */
const SIGNALS: readonly {
  readonly key: string;
  /** Every measure name this signal may arrive under. The analysis names the hourly measure for a
   *  forecast window and the daily aggregate for a daily one; both are the same reading. */
  readonly measures: readonly string[];
  readonly statistic: string;
  readonly say: (value: string) => string;
}[] = [
  {
    key: "warmest",
    measures: ["temperature_max", "temperature"],
    statistic: "maximum",
    say: (value) => `Warmest point of the window reaches ${value}`,
  },
  {
    key: "coldest",
    measures: ["temperature_min", "temperature"],
    statistic: "minimum",
    say: (value) => `Coldest point falls to ${value}`,
  },
  {
    key: "precipitation",
    measures: ["precipitation_sum", "precipitation"],
    statistic: "total",
    say: (value) => `${value} of precipitation forecast across the window`,
  },
  {
    key: "gust",
    measures: ["wind_gust_max", "wind_gust"],
    statistic: "maximum_gust",
    say: (value) => `Strongest gust reaches ${value}`,
  },
  {
    key: "wind",
    measures: ["wind_speed_max", "wind_speed"],
    statistic: "maximum",
    say: (value) => `Highest wind speed reaches ${value}`,
  },
];

function computed(result: StatisticResult | undefined): result is StatisticResult {
  return result !== undefined && typeof result.value === "number" && Number.isFinite(result.value);
}

export function trendSignals(
  analysis: AnalysisResponse | null,
  limit = 3,
): readonly TrendSignal[] {
  if (analysis === null) return [];

  const signals: TrendSignal[] = [];
  for (const entry of SIGNALS) {
    if (signals.length >= limit) break;
    const found = analysis.findings.find(
      (finding) =>
        entry.measures.includes(finding.measure) && finding.statistic === entry.statistic,
    );
    if (!computed(found)) continue;

    const rounded = Math.round((found.value as number) * 10) / 10;
    const figure = `${rounded}${found.unit ? ` ${found.unit}` : ""}`;
    signals.push({
      key: entry.key,
      text: entry.say(figure),
      when: localLabel(found.occurred_at_local),
    });
  }
  return signals;
}

/* ------------------------------------------------------------------- coverage */

/**
 * How much of the returned series carries a value — the one proportion on this screen that is
 * arithmetic rather than invention.
 *
 * The artifact prints "vector alignment 96%" and "grounding precision 88%" beside it, neither of
 * which any endpoint produces. This is a count of entries over a count of entries.
 */
export function coverageOf(
  entries: readonly SeriesEntry[],
  measure: string,
): { readonly reported: number; readonly total: number } {
  const total = entries.length;
  const reported = entries.filter((entry) => {
    const value = entry.values?.[measure];
    return typeof value === "number" && Number.isFinite(value);
  }).length;
  return { reported, total };
}
