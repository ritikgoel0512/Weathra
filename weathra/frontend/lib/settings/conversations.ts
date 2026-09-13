/**
 * How the Settings page reads its conversation list.
 *
 * Two concerns, both presentational: how many rows open by default, and how a stored instant is
 * written. Nothing here deletes, expires or reorders anything — retention is the backend's and the
 * order is the list's.
 */

import type { ThreadSummary } from "@/lib/api/schema";

/**
 * How many conversations the page opens with.
 *
 * Settings rendered every retained conversation in full, which on an account that had used the
 * Analyst made the tab several screens of history with the actual settings above it. Three is
 * enough to recognise the recent ones and few enough that the page stays a settings surface; the
 * count above them says how many there are and the rest are one press away, so nothing is hidden.
 */
export const CONVERSATIONS_SHOWN = 3;

/**
 * A stored instant, written the way a person reads a date.
 *
 * `formatInstant` writes `2026-09-13 08:16 UTC`, which is right for a provenance footer where the
 * figure is evidence. Here it is a date somebody is deciding something about, so the month is a
 * word. Still UTC, and still the backend's own instant — nothing is converted.
 */
export function readableInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;

  const day = at.getUTCDate();
  const month = at.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${day} ${month} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/** The conversations shown before "View all" is pressed. */
export function visibleConversations(
  threads: readonly ThreadSummary[],
  expanded: boolean,
): readonly ThreadSummary[] {
  return expanded ? threads : threads.slice(0, CONVERSATIONS_SHOWN);
}
