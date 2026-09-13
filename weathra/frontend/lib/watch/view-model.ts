/**
 * The Weather Watch screen's view model — one reading of one dashboard, for every panel.
 *
 * `docs/design/screens/14-weather-watch.png` is a monitoring workspace rather than a form: a header,
 * four counters, watched places against an active-watch rail, a threshold plot against what changed,
 * the evidence against the activity feed, and a quick way to add another watch. Every one of those
 * reads the *same* response, so they are derived here once rather than each panel deriving its own
 * version of the truth and disagreeing about whether a condition is met.
 *
 * Three rules hold here.
 *
 * **The arithmetic is the backend's.** `GET /me/watch-dashboard` returns the states, the counted
 * transitions, the margins and the evidence sentence as they were computed when the check happened.
 * Nothing below computes a weather figure; it selects, labels, formats, and turns two numbers the
 * backend already returned into a bar length.
 *
 * **Monitoring is scheduled, not live.** No string here says real-time, continuous, or live. A
 * watch was *checked* at a moment and will be checked again at another, and both moments are named.
 *
 * **What the artifact invents is refused.** No 96.4% confidence, no 82 anomalies, no 98.4%
 * grounding, no model recalibration, no 124 nodes, no compliance lock, no emergency alert. Each has
 * a real equivalent here or no tile at all.
 */

import type {
  Measure,
  WatchChange,
  WatchDashboard,
  WatchDetail,
  WatchEventRecord,
  WatchRecord,
  WatchState,
  WatchedLocation,
} from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import { formatMeasured, roundTo, signedOf } from "@/lib/format/figures";
import { friendlyName } from "@/lib/locations/place";

/* --------------------------------------------------------------- the states */

/** What each state is called on screen, and how it is coloured. */
export interface StateLook {
  readonly label: string;
  readonly tone: "met" | "watching" | "silent" | "degraded" | "paused" | "pending";
  /** One line naming what the state actually means, for a title attribute or a caption. */
  readonly meaning: string;
}

/**
 * The six states as a person reads them.
 *
 * `not_met` is labelled *Watching* rather than "Not met" because that is what the watch is doing —
 * it is enabled, it was checked, and the condition did not hold. "Not met" reads as a failure of the
 * watch rather than as its ordinary working state. Every other label is the literal fact, including
 * the two that are about Weathra rather than about the weather: a provider that reported nothing and
 * a retrieval that did not complete are different, and both are different from a calm sky.
 */
export const STATE_LOOK: Readonly<Record<WatchState, StateLook>> = {
  met: {
    label: "Met",
    tone: "met",
    meaning: "The condition held when this watch was last checked.",
  },
  not_met: {
    label: "Watching",
    tone: "watching",
    meaning: "Checked, and the condition did not hold.",
  },
  no_reading: {
    label: "No reading",
    tone: "silent",
    meaning: "The provider reported nothing for this measure, which is not the same as a calm one.",
  },
  degraded: {
    label: "Not checked",
    tone: "degraded",
    meaning: "The forecast could not be retrieved, so Weathra has no answer rather than a negative one.",
  },
  paused: { label: "Paused", tone: "paused", meaning: "Disabled, so it is not being checked." },
  pending: {
    label: "Pending",
    tone: "pending",
    meaning: "Created, and not yet checked.",
  },
};

export function lookOf(state: WatchState | null | undefined): StateLook {
  return STATE_LOOK[state ?? "pending"];
}

/* ----------------------------------------------------------------- the rule */

/**
 * The unit each watchable measure is stated in, for the metric unit system.
 *
 * A threshold is typed before anything has been retrieved, so on a watch that has never been
 * checked there is no provider unit to borrow — and "Wind gust above 70" without one is a number
 * nobody can act on. These are the units the provider reports these measures in, so a rule reads
 * the same before and after the first check rather than gaining a unit when the check lands.
 */
export const MEASURE_UNITS: Readonly<Record<string, string>> = {
  temperature: "°C",
  apparent_temperature: "°C",
  precipitation: "mm",
  precipitation_probability: "%",
  relative_humidity: "%",
  wind_speed: "km/h",
  wind_gust: "km/h",
};

/** A watch's condition in words: the measure, the direction, and the number somebody typed. */
export function ruleOf(watch: WatchRecord): string {
  // The provider's own unit where a check has reported one; the measure's otherwise.
  const unit = watch.last_unit || MEASURE_UNITS[watch.measure] || "";
  const suffix = unit ? ` ${unit}` : "";
  return `${measureLabel(watch.measure)} ${watch.comparison} ${roundTo(watch.threshold, 1)}${suffix}`;
}

/** What a sentence about this watch calls its place: its label, or the place's own name. */
export function placeOf(watch: WatchRecord): string {
  return watch.label?.trim() || friendlyName(watch.location);
}

/* ------------------------------------------------------------- the counters */

export interface Counter {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/**
 * The four figures across the top, and nothing beyond what was counted.
 *
 * The artifact's fourth is a countdown to the next refresh, which is the one of the four that can
 * be honestly derived rather than invented: the backend returns the moment the schedule is next
 * expected to reach these watches, and the remaining time is arithmetic on it. Where no watch has
 * ever been checked there is no such moment, and the tile says the cadence instead of counting down
 * to a time nobody has.
 */
export function countersFrom(dashboard: WatchDashboard, now: Date): readonly Counter[] {
  const summary = dashboard.summary;

  return [
    {
      key: "watches",
      label: "Active watches",
      value: String(summary.active_watch_count),
      note: summary.met_count === 0 ? "None currently met" : `${summary.met_count} currently met`,
    },
    {
      key: "locations",
      label: "Locations monitored",
      value: String(summary.monitored_location_count),
      note: summary.monitored_location_count === 1 ? "One place" : "Distinct places",
    },
    {
      key: "changes",
      label: "Changes detected",
      value: String(summary.changes_detected),
      note: `Recorded in the last ${summary.changes_window_hours} hours`,
    },
    nextRefreshCounter(summary.next_evaluation_at ?? null, summary.cadence_minutes, now),
  ];
}

/** The fourth tile: how long until the schedule next reaches these watches. */
function nextRefreshCounter(
  next: string | null,
  cadenceMinutes: number,
  now: Date,
): Counter {
  const at = next === null ? null : new Date(next);
  const valid = at !== null && !Number.isNaN(at.getTime());

  if (!valid) {
    return {
      key: "next",
      label: "Next evaluation",
      value: everyOf(cadenceMinutes),
      note: "No watch has been checked yet",
    };
  }

  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  return {
    key: "next",
    label: "Next evaluation",
    value: minutes <= 0 ? "Due" : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`,
    // Never "live" and never "real-time": a schedule is what this is.
    note: minutes <= 0 ? "Scheduled pass expected" : `Then every ${everyOf(cadenceMinutes)}`,
  };
}

function everyOf(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${minutes} min`;
}

/* --------------------------------------------------- the watched places */

export interface PlaceCard {
  readonly id: string;
  /** A watch at this place, so selecting the card selects something the detail panels can show. */
  readonly watchId: string | null;
  readonly name: string;
  readonly state: WatchState;
  readonly watchCount: number;
  readonly metCount: number;
  readonly conditions: readonly { key: string; label: string; value: string }[];
  readonly checked: string | null;
  readonly provider: string | null;
}

/**
 * One card per watched place, carrying what that place's own last retrieval reported.
 *
 * Each card also carries one of its watches, chosen the way the backend chooses the selected one —
 * anything met first — so clicking a place opens the watch at it that most wants attention rather
 * than whichever happened to be created first.
 */
export function placeCardsFrom(dashboard: WatchDashboard): readonly PlaceCard[] {
  const watches = dashboard.watches ?? [];

  return (dashboard.watched_locations ?? []).map((place) => ({
    id: place.location_id,
    watchId: representativeOf(watches, place),
    name: friendlyName(place.location),
    state: place.state,
    watchCount: place.watch_count,
    metCount: place.met_count,
    conditions: conditionsOf(place),
    checked: place.last_evaluated_at ?? null,
    provider: place.provider ?? null,
  }));
}

/** Which watch at a place a click on its card should open. */
function representativeOf(
  watches: readonly WatchRecord[],
  place: WatchedLocation,
): string | null {
  const here = watches.filter(
    (watch) =>
      watch.location.latitude === place.location.latitude &&
      watch.location.longitude === place.location.longitude,
  );
  return (here.find((watch) => watch.state === "met") ?? here[0])?.id ?? null;
}

/** The headline measures a place card shows. Absent where the provider reported nothing. */
function conditionsOf(place: WatchedLocation): { key: string; label: string; value: string }[] {
  const units = (place.units ?? {}) as Partial<Record<Measure, string>>;
  return Object.entries(place.conditions ?? {}).map(([measure, value]) => ({
    key: measure,
    label: measureLabel(measure),
    value: formatMeasured(value as number, units[measure as Measure] ?? null),
  }));
}

/* ------------------------------------------------------------ the plot */

export interface ThresholdPoint {
  readonly label: string;
  readonly stamp: string;
  readonly value: number | null;
  /** The same value, carried only where it satisfies the condition, so the breach can be shaded. */
  readonly breach: number | null;
  readonly threshold: number;
}

/**
 * The selected watch's series against its threshold, as one row per instant.
 *
 * `breach` is the same number as `value`, present only on the hours that satisfy the condition. It
 * is what lets the plot shade the part of the window that crosses the line without a second series
 * or a computed band: one field, drawn twice, so what is shaded and what is plotted cannot differ.
 */
export function thresholdPointsFrom(detail: WatchDetail | null | undefined): ThresholdPoint[] {
  if (!detail?.series) return [];
  const measure = detail.watch.measure;
  const { threshold, comparison } = detail.watch;

  return (detail.series.entries ?? []).map((entry) => {
    const raw = entry.values?.[measure];
    const value = typeof raw === "number" ? raw : null;
    const satisfies =
      value !== null && (comparison === "above" ? value > threshold : value < threshold);

    return {
      label: hourLabelOf(entry.time_local),
      stamp: entry.time_local,
      value,
      breach: satisfies ? value : null,
      threshold,
    };
  });
}

/**
 * A local timestamp's day and hour, as text.
 *
 * Sliced rather than parsed: `2026-09-13T15:00:00+01:00` already *is* the local reading, and putting
 * it through `Date` would re-apply an offset to a figure that has one.
 */
export function hourLabelOf(timeLocal: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(timeLocal);
  return match === null ? timeLocal : `${match[2]}/${match[1]} ${match[3]}`;
}

/* ------------------------------------------------------- the plot's figures */

export interface PlotFigure {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/**
 * Three or four real figures under the plot, and no confidence among them.
 *
 * Each is either the reading the check was made on, the number somebody typed, the difference
 * between them, or the first hour of the retrieved window that sits past the line. Nothing here is
 * a statistic about a distribution, because there is no distribution — a threshold check has one
 * comparison in it.
 */
export function plotFiguresFrom(detail: WatchDetail | null | undefined): readonly PlotFigure[] {
  const outcome = detail?.outcome;
  if (!detail || !outcome) return [];

  const unit = outcome.unit ?? null;
  const figures: PlotFigure[] = [
    {
      key: "reading",
      label: "Latest reading",
      value: outcome.value === null || outcome.value === undefined
        ? "Not reported"
        : formatMeasured(outcome.value, unit),
      note: outcome.matched_at_local ? `At ${hourLabelOf(outcome.matched_at_local)}` : undefined,
    },
    {
      key: "threshold",
      label: "Threshold",
      value: formatMeasured(outcome.threshold, unit),
      note: `Watching for ${detail.watch.comparison}`,
    },
  ];

  if (typeof outcome.margin === "number") {
    figures.push({
      key: "margin",
      label: outcome.margin >= 0 ? "Past the threshold by" : "Short of the threshold by",
      value: formatMeasured(Math.abs(outcome.margin), unit),
    });
  }

  if (outcome.crossing) {
    figures.push({
      key: "crossing",
      label: "First crossing",
      value: hourLabelOf(outcome.crossing.at_local),
      note: formatMeasured(outcome.crossing.value, unit),
    });
  } else if (typeof outcome.peak === "number") {
    figures.push({
      key: "peak",
      label: detail.watch.comparison === "above" ? "Window peak" : "Window low",
      value: formatMeasured(outcome.peak, unit),
      note: "Nothing in the window crosses",
    });
  }

  return figures;
}

/* ----------------------------------------------------------- what changed */

export interface ChangeCard {
  readonly key: string;
  readonly heading: string;
  readonly summary: string;
  readonly tone: "up" | "down" | "flat";
}

/** What each kind of change is called at the top of its card. */
const CHANGE_HEADINGS: Readonly<Record<string, string>> = {
  condition_met: "State change",
  condition_cleared: "State change",
  reading_lost: "Reading lost",
  reading_recovered: "Reading recovered",
  state_changed: "State change",
  reading_moved: "Forecast shift",
  crossing_moved: "Threshold timing",
  crossing_appeared: "Threshold timing",
  crossing_cleared: "Threshold timing",
  watch_created: "Watch created",
};

/** Up to three real differences from the previous check. Never padded, never invented. */
export function changeCardsFrom(changes: readonly WatchChange[] | undefined): readonly ChangeCard[] {
  return (changes ?? []).slice(0, 3).map((change, index) => ({
    key: `${change.kind}-${index}`,
    heading: CHANGE_HEADINGS[change.kind] ?? "Change",
    summary: change.summary,
    tone:
      typeof change.delta === "number" && change.delta !== 0
        ? change.delta > 0
          ? "up"
          : "down"
        : "flat",
  }));
}

/* ----------------------------------------------------------- the activity */

export interface ActivityRow {
  readonly id: string;
  readonly icon: "created" | "met" | "cleared" | "lost" | "recovered" | "moved" | "checked";
  readonly title: string;
  readonly detail: string;
  readonly at: string;
}

const ACTIVITY_ICONS: Readonly<Record<string, ActivityRow["icon"]>> = {
  watch_created: "created",
  condition_met: "met",
  condition_cleared: "cleared",
  reading_lost: "lost",
  reading_recovered: "recovered",
  reading_moved: "moved",
  crossing_moved: "moved",
  crossing_appeared: "moved",
  crossing_cleared: "moved",
};

/** The recorded transitions, newest first, exactly as they were written. */
export function activityFrom(events: readonly WatchEventRecord[] | undefined): readonly ActivityRow[] {
  return (events ?? []).map((event) => ({
    id: event.id,
    icon: ACTIVITY_ICONS[event.event_type] ?? "checked",
    title: CHANGE_HEADINGS[event.event_type] ?? "Watch event",
    detail: event.summary,
    at: event.occurred_at,
  }));
}

/* -------------------------------------------------------------- the engine */

export interface EngineStatus {
  readonly label: string;
  readonly tone: "ok" | "warning" | "neutral";
  readonly detail: string;
}

/**
 * What the header says about the monitoring itself.
 *
 * Three states and all three are about Weathra rather than about the weather: watches are being
 * checked, some check could not complete, or there is nothing to check. It is never called *live* —
 * the engine is a scheduled job, and a green light saying otherwise would be the screen's single
 * most misleading pixel.
 */
export function engineStatusFrom(dashboard: WatchDashboard): EngineStatus {
  const watches = dashboard.watches ?? [];
  const active = watches.filter((watch) => watch.enabled);
  const degraded = active.filter((watch) => watch.state === "degraded");

  if (active.length === 0) {
    return {
      label: "Idle",
      tone: "neutral",
      detail: "No enabled watches, so nothing is being checked.",
    };
  }
  if (degraded.length > 0) {
    return {
      label: "Degraded",
      tone: "warning",
      detail: `${degraded.length} of ${active.length} could not be checked on the last pass.`,
    };
  }
  return {
    label: "Scheduled",
    tone: "ok",
    detail: `${active.length} watch${active.length === 1 ? "" : "es"} on a ${everyOf(
      dashboard.summary.cadence_minutes,
    )} schedule.`,
  };
}

/* ------------------------------------------------------- the footer status */

export interface StatusItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** The footer strip: four real system facts, and no node counts. */
export function statusStripFrom(dashboard: WatchDashboard, engine: EngineStatus): readonly StatusItem[] {
  const summary = dashboard.summary;
  const provider = (dashboard.watched_locations ?? []).find((place) => place.provider)?.provider;

  return [
    { key: "engine", label: "Watch engine", value: engine.label },
    {
      key: "checked",
      label: "Last evaluation",
      value: summary.last_evaluation_at ? whenOf(summary.last_evaluation_at) : "Not yet",
    },
    { key: "provider", label: "Provider", value: provider ?? "Not reported" },
    { key: "watches", label: "Watches", value: String((dashboard.watches ?? []).length) },
  ];
}

/* --------------------------------------------------------------- formatting */

/** A moment, in the one format this screen reads times in. */
export function whenOf(value: string | null | undefined): string {
  if (!value) return "not checked yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** How long ago, in words, for a row that has no room for a date. */
export function agoOf(value: string | null | undefined, now: Date): string {
  if (!value) return "never checked";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const minutes = Math.round((now.getTime() - parsed.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A signed figure with its unit, for a delta that has a direction. */
export function signedFigure(value: number, unit: string | null | undefined): string {
  return signedOf(value, unit ?? null);
}
