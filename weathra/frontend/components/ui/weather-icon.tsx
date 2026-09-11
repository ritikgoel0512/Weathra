import type { ReactNode } from "react";

import type { Condition, ConditionKind } from "@/lib/weather/condition";

import styles from "./primitives.module.css";

/**
 * One drawing per sky state, from the vocabulary `lib/weather/condition` derives.
 *
 * Inline SVG rather than an icon font or a sprite: these are six shapes, they must inherit the
 * accent and muted colours the theme sets, and a weather product should not fetch a stylesheet to
 * draw a cloud.
 *
 * **It draws only what the condition says.** There is no sun-behind-rain, no thunderstorm and no
 * snowflake, because the provider carries nothing that would distinguish them — see
 * `lib/weather/condition` for why that is a decision rather than an omission. A condition of `null`
 * renders nothing at all, which is what an unreported sky should look like.
 *
 * The drawing is decorative: every place that uses it states the condition in text beside it, so
 * the icon is `aria-hidden` and the label carries the meaning.
 */
export function WeatherIcon({
  condition,
  size = 24,
}: {
  readonly condition: Condition | null;
  readonly size?: number;
}): ReactNode {
  if (!condition) return null;
  return (
    <svg
      className={styles.weatherIcon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-condition={condition.kind}
    >
      {SHAPES[condition.kind]}
    </svg>
  );
}

const SUN = <circle cx="12" cy="12" r="4" />;
const SUN_RAYS = (
  <>
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </>
);
const CLOUD = <path d="M7 18h9a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1.4A3.3 3.3 0 0 0 7 18Z" />;
const SMALL_SUN = <circle cx="8" cy="8" r="3" />;

const SHAPES: Readonly<Record<ConditionKind, ReactNode>> = {
  clear: (
    <>
      {SUN}
      {SUN_RAYS}
    </>
  ),
  "mostly-clear": (
    <>
      {SMALL_SUN}
      <path d="M8 2.5v1.5M2.5 8h1.5M4.3 4.3l1 1M11.7 4.3l-1 1" />
      {CLOUD}
    </>
  ),
  "partly-cloudy": (
    <>
      {SMALL_SUN}
      {CLOUD}
    </>
  ),
  cloudy: (
    <>
      <path d="M5 13a3 3 0 0 1 2.6-3 4.5 4.5 0 0 1 8.4-1" opacity="0.55" />
      {CLOUD}
    </>
  ),
  overcast: (
    <>
      <path d="M4 12a3 3 0 0 1 3-3h10a3 3 0 0 1 0 6H7a3 3 0 0 1-3-3Z" opacity="0.55" />
      {CLOUD}
    </>
  ),
  rain: (
    <>
      {CLOUD}
      <path d="M9 20.5l-.7 1.5M13 20.5l-.7 1.5M17 20.5l-.7 1.5" />
    </>
  ),
  "heavy-rain": (
    <>
      {CLOUD}
      <path d="M8.5 20l-1.2 2.5M12.5 20l-1.2 2.5M16.5 20l-1.2 2.5M10.5 20l-1.2 2.5M14.5 20l-1.2 2.5" />
    </>
  ),
};
