/**
 * The Weather Watch screen's icon set — outline, currentColor, one stroke weight.
 *
 * Drawn here rather than pulled from a library for the reason every other screen in this product
 * draws its own: an icon set is a dependency that ships several hundred glyphs to deliver nine, and
 * nine is what this screen uses. Every one is decorative and `aria-hidden`; the label beside it
 * names the thing, so nothing here is the only carrier of meaning.
 */

import type { ReactNode } from "react";

export type WatchIconName =
  | "watch"
  | "place"
  | "threshold"
  | "trend"
  | "activity"
  | "evidence"
  | "schedule"
  | "alert"
  | "stable"
  | "plus"
  | "paused"
  | "silent";

const PATHS: Readonly<Record<WatchIconName, ReactNode>> = {
  // A bell, for the watch itself.
  watch: (
    <>
      <path d="M6.5 10a5.5 5.5 0 1 1 11 0c0 3.2.7 4.9 1.6 6H4.9c.9-1.1 1.6-2.8 1.6-6Z" />
      <path d="M10 19.2a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  // A pin.
  place: (
    <>
      <path d="M12 21s6.5-5.6 6.5-10.4A6.5 6.5 0 0 0 5.5 10.6C5.5 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  // A line crossing a level.
  threshold: (
    <>
      <path d="M3 14h18" strokeDasharray="3 3" />
      <path d="M4 19c2.6 0 3.4-10 7-10s4.4 7 9 7" />
    </>
  ),
  trend: <path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5M20.5 6.5h-4.6M20.5 6.5v4.6" />,
  // A pulse.
  activity: <path d="M3 12h3.5L9 6.5l4 11 2.6-5.5H21" />,
  // A document with a link through it.
  evidence: (
    <>
      <path d="M7 3.8h6.5L18 8.3V20a1.2 1.2 0 0 1-1.2 1.2H7A1.2 1.2 0 0 1 5.8 20V5A1.2 1.2 0 0 1 7 3.8Z" />
      <path d="M13.2 3.9V8.4H17.8M9 13h6M9 16.6h4" />
    </>
  ),
  // A clock, for the cadence.
  schedule: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.1 1.9" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 19.4H3L12 4.2Z" />
      <path d="M12 10v4.1M12 17.1v.1" />
    </>
  ),
  stable: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.2l2.6 2.6 5-5.4" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  paused: <path d="M9.6 6.5v11M14.4 6.5v11" />,
  // A crossed-out wave: the provider said nothing.
  silent: (
    <>
      <path d="M3.5 13h3l2-4 3 8 2-5h6.5" />
      <path d="M4.5 4.5l15 15" />
    </>
  ),
};

export function WatchIcon({
  name,
  size = 16,
}: {
  readonly name: WatchIconName;
  readonly size?: number;
}): ReactNode {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
