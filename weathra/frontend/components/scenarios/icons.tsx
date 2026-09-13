/**
 * The lab's glyphs, in the stroke language `components/shell/icons.tsx` established.
 *
 * Hand-drawn inline SVG for the reason that file gives: a handful of glyphs does not justify a
 * dependency, and inlining them means no request, no font and no build step between the design and
 * what renders. Every one is decorative and `aria-hidden`; the label beside it names the thing.
 */

import type { ReactNode } from "react";

export type LabIconName =
  | "sliders"
  | "baseline"
  | "impact"
  | "projection"
  | "insight"
  | "archive"
  | "warning"
  | "check";

const PATHS: Readonly<Record<LabIconName, ReactNode>> = {
  // Assumptions: three tracks with a handle on each.
  sliders: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  // The retrieved series: a level reference.
  baseline: (
    <>
      <path d="M3 15h18" />
      <path d="M5 11l4-4 4 5 6-6" />
    </>
  ),
  // What the assumptions make of it: a step up from that reference.
  impact: (
    <>
      <path d="M3 18h18" />
      <path d="M5 14l5-5 4 3 5-7" />
      <path d="M15 3h4v4" />
    </>
  ),
  // The projection over time.
  projection: (
    <>
      <path d="M3 20V4" />
      <path d="M3 20h18" />
      <path d="M6 15c3-6 6 2 9-3l3-3" />
    </>
  ),
  // An interpretation: a reading drawn over figures.
  insight: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
  // The archive, read back.
  archive: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.5 21 19.5H3Z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.2l2.6 2.6 5-5.4" />
    </>
  ),
};

export function LabIcon({
  name,
  size = 16,
}: {
  readonly name: LabIconName;
  readonly size?: number;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
