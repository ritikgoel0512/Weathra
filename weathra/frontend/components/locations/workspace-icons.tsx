/**
 * The Saved Locations workspace's icon set — outline, currentColor, one stroke weight.
 *
 * Drawn here rather than pulled from a library for the reason every other screen in this product
 * draws its own: an icon set is a dependency that ships several hundred glyphs to deliver seven.
 * Every one is decorative and `aria-hidden`; the label beside it names the thing.
 */

import type { ReactNode } from "react";

export type PlaceIconName =
  | "place"
  | "grid"
  | "compare"
  | "analytics"
  | "usage"
  | "alert"
  | "unavailable";

const PATHS: Readonly<Record<PlaceIconName, ReactNode>> = {
  place: (
    <>
      <path d="M12 21s6.5-5.6 6.5-10.4A6.5 6.5 0 0 0 5.5 10.6C5.5 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </>
  ),
  compare: (
    <>
      <path d="M7 20V9M17 20V4" />
      <path d="M4 20h16" />
      <path d="M12 20v-7" />
    </>
  ),
  analytics: <path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5M20.5 6.5h-4.6M20.5 6.5v4.6" />,
  usage: (
    <>
      <rect x="3.5" y="9" width="17" height="6" rx="3" />
      <path d="M3.5 12h6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 19.4H3L12 4.2Z" />
      <path d="M12 10v4.1M12 17.1v.1" />
    </>
  ),
  // A crossed-out cloud: the provider said nothing.
  unavailable: (
    <>
      <path d="M7.2 18.5a4 4 0 0 1-.4-8 5.2 5.2 0 0 1 9.8-1.3" />
      <path d="M4.5 4.5l15 15" />
    </>
  ),
};

export function PlaceIcon({
  name,
  size = 16,
}: {
  readonly name: PlaceIconName;
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
