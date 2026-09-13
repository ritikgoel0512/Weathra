/**
 * The report's glyphs — the measures on its tiles and the subject of each of its regions.
 *
 * Drawn here rather than imported, for the reason `components/shell/icons.tsx` already gives: a
 * handful of glyphs does not justify a dependency, and inlining them means no request, no font and
 * no build step between the design and what renders. Same stroke language as the navigation set —
 * a 24-unit box, `currentColor`, 1.6 stroke, round caps — so a measure glyph beside a figure and a
 * nav glyph beside a link are visibly the same hand.
 *
 * **Every one is decorative and every one is `aria-hidden`.** The label beside a glyph is what
 * names the figure; an icon announced next to "Temperature" would say it twice. Nothing here
 * encodes a value: the thermometer is the same thermometer at 2 °C and at 32 °C, and the alert
 * triangle is drawn because the backend flagged an entry, never because this module decided
 * something was alarming.
 *
 * `12-weather-intelligence-report.png` puts a glyph on every metric tile and at the head of every
 * panel, and the screen had none — which is most of why it read as a page of text where the
 * artifact reads as an instrument. These are those glyphs.
 */

import type { ReactNode } from "react";

/** The measures the report's tiles draw, and the subjects its regions are about. */
export type ReportIconName =
  | "temperature"
  | "precipitation"
  | "humidity"
  | "wind"
  | "pressure"
  | "uv"
  | "cloud"
  | "dew"
  | "gust"
  | "interpretation"
  | "outlook"
  | "changed"
  | "analytics"
  | "history"
  | "alert"
  | "grounding"
  | "verified";

const PATHS: Readonly<Record<ReportIconName, ReactNode>> = {
  // A thermometer: a stem, a bulb, and the scale ticks beside it.
  temperature: (
    <>
      <path d="M11 14.8V5.5a2 2 0 1 1 4 0v9.3" />
      <circle cx="13" cy="17.5" r="3.2" />
      <path d="M17.5 7.5H19M17.5 11H19" />
    </>
  ),
  // Rain: a cloud with fall under it.
  precipitation: (
    <>
      <path d="M7 15h9a3.4 3.4 0 0 0 .4-6.8A4.9 4.9 0 0 0 7 9.4 2.9 2.9 0 0 0 7 15Z" />
      <path d="M9 18l-.8 2M13 18l-.8 2M17 18l-.8 2" />
    </>
  ),
  // Humidity: a droplet.
  humidity: <path d="M12 3.5s5.5 5.6 5.5 9.4a5.5 5.5 0 0 1-11 0C6.5 9.1 12 3.5 12 3.5Z" />,
  // Wind: moving air, two streams with a curl.
  wind: (
    <>
      <path d="M3 9h9.5a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M3 14h13a2.5 2.5 0 1 1-2.5 2.5" />
      <path d="M3 19h6" />
    </>
  ),
  // Pressure: a dial with a needle.
  pressure: (
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-4.5" />
      <circle cx="12" cy="17" r="1.2" />
    </>
  ),
  // UV: the sun and its rays.
  uv: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  // Cloud cover.
  cloud: <path d="M7 17h9.5a4 4 0 0 0 .4-8A5.4 5.4 0 0 0 6.9 10.4 3.3 3.3 0 0 0 7 17Z" />,
  // Dew point: a droplet on a surface.
  dew: (
    <>
      <path d="M12 4s4.4 4.6 4.4 7.7a4.4 4.4 0 1 1-8.8 0C7.6 8.6 12 4 12 4Z" />
      <path d="M4 20h16" />
    </>
  ),
  // A gust: wind, with the leading stream drawn through.
  gust: (
    <>
      <path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M3 13h7" />
      <path d="M3 18h12a2.5 2.5 0 1 1-2.5 2.5" />
    </>
  ),
  // Interpretation: a four-point spark, the mark this product uses for a model's own writing.
  interpretation: (
    <>
      <path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9Z" />
      <path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7Z" />
    </>
  ),
  // The outlook: time ahead.
  outlook: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 1.8" />
      <path d="M9 2.5h6" />
    </>
  ),
  // What changed: two directions between two retrievals.
  changed: (
    <>
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </>
  ),
  // Analytics: a computed trend over a series.
  analytics: (
    <>
      <path d="M3 20h18" />
      <path d="M4 16l5-5 3.5 3L20 6" />
      <path d="M15.5 6H20v4.5" />
    </>
  ),
  // The record: an archive, read back through time.
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1" />
      <path d="M3 14.5v-4h4" />
      <path d="M12 8.5V12l2.5 1.6" />
    </>
  ),
  // Attention: the warning triangle, drawn only where the backend flagged something.
  alert: (
    <>
      <path d="M12 4.5 21 19.5H3Z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.2" />
    </>
  ),
  // Grounding: the store each figure was read out of.
  grounding: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
  // Checked: the tick the footer uses for a state the backend actually reported.
  verified: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.2l2.6 2.6 5-5.4" />
    </>
  ),
};

export function ReportIcon({
  name,
  size = 16,
}: {
  readonly name: ReportIconName;
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
