/**
 * Reading a person's own plan and consumption — the arithmetic and the naming, kept out of the view.
 *
 * Everything here is derived from what `GET /me/usage` actually returns. Two rules run through it:
 *
 * **An unlimited dimension is not a full one.** `allowance` is null where the plan does not limit a
 * dimension, and a percentage computed from null would render as either 0% or NaN — one of which
 * says "none used" and the other says nothing at all. So an unlimited dimension has no bar and says
 * so in words.
 *
 * **Null is never zero.** `total_tokens` is null where the gateway reported no token counts, and
 * showing that as 0 would claim the calls used nothing. The same applies to `remaining` and to
 * `resets_at`, which is absent for concurrency because concurrency has no window — it falls as soon
 * as a run finishes.
 */

import type { DimensionView, PlanCode, UsageResponse } from "@/lib/api/schema";

/** Weathra's plans, in order. There is no `plus`: the middle tier is Pro, and the API's own enum agrees. */
export const PLANS: readonly { code: PlanCode; name: string }[] = [
  { code: "free", name: "Free" },
  { code: "pro", name: "Pro" },
  { code: "premium", name: "Premium" },
];

/** At or above this share of an allowance, a dimension is worth pointing at. */
export const NEAR_LIMIT = 0.8;

/**
 * A dimension's name, for a person.
 *
 * Derived from the identifier rather than mapped, so a dimension the backend adds later reads as
 * itself instead of disappearing behind a lookup that has not been updated. `requests_per_day`
 * becomes "Requests per day"; the window is shown separately, because it is a different fact.
 */
export function dimensionLabel(dimension: string): string {
  const words = dimension.replace(/_/g, " ").trim();
  return words.length === 0 ? dimension : words[0]!.toUpperCase() + words.slice(1);
}

/** How the period reads in a sentence. Unknown windows pass through as themselves. */
export function windowLabel(window: string): string {
  if (window === "day") return "Resets daily";
  if (window === "month") return "Resets monthly";
  if (window === "concurrent") return "At once";
  return window;
}

export interface DimensionReading {
  readonly dimension: string;
  readonly label: string;
  readonly window: string;
  readonly windowLabel: string;
  readonly consumed: number;
  readonly allowance: number | null;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
  readonly limited: boolean;
  /** 0–100, or null where the dimension is unlimited and a share of it means nothing. */
  readonly percentUsed: number | null;
  readonly nearLimit: boolean;
  readonly exhausted: boolean;
}

export function readDimension(view: DimensionView): DimensionReading {
  const allowance = view.allowance ?? null;
  const limited = allowance !== null && allowance > 0;
  const share = limited ? view.consumed / (allowance as number) : null;

  return {
    dimension: view.dimension,
    label: dimensionLabel(view.dimension),
    window: view.window,
    windowLabel: windowLabel(view.window),
    consumed: view.consumed,
    allowance,
    remaining: view.remaining ?? null,
    resetsAt: view.resets_at ?? null,
    limited,
    percentUsed: share === null ? null : Math.min(100, Math.round(share * 100)),
    nearLimit: share !== null && share >= NEAR_LIMIT && share < 1,
    exhausted: share !== null && share >= 1,
  };
}

/**
 * The dimension a "requests" headline should quote, or null when the plan limits no requests.
 *
 * Preferred over picking the first dimension: the order the backend returns them in is not a
 * statement about which one a person cares about, and a headline that silently followed it would
 * change meaning when a dimension was added.
 */
export function headlineDimension(
  dimensions: readonly DimensionView[],
): DimensionReading | null {
  const readings = dimensions.map(readDimension).filter((reading) => reading.limited);
  return (
    readings.find((reading) => reading.dimension.startsWith("requests")) ?? readings[0] ?? null
  );
}

/** Every dimension whose window turns over, soonest first. Concurrency has none and is left out. */
export function resetSchedule(dimensions: readonly DimensionView[]): readonly DimensionReading[] {
  return dimensions
    .map(readDimension)
    .filter((reading) => reading.resetsAt !== null)
    .sort((one, other) => (one.resetsAt as string).localeCompare(other.resetsAt as string));
}

/** The dimensions worth flagging: at or over their allowance. Empty is the normal case. */
export function pressuredDimensions(
  dimensions: readonly DimensionView[],
): readonly DimensionReading[] {
  return dimensions.map(readDimension).filter((reading) => reading.nearLimit || reading.exhausted);
}

/**
 * Whether this account's traffic is accounted as internal rather than against a product plan.
 *
 * True for an administrative principal, which is a fact the view has to state rather than hide: an
 * administrator reading a Free plan's allowances would otherwise think those were the limits their
 * own calls were spending.
 */
export function isInternal(usage: UsageResponse): boolean {
  return usage.internal === true;
}
