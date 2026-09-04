/**
 * Badges, and the five data classes.
 *
 * `docs/design/design-system.md` §9 makes data class a *presentational primitive rather than
 * prose*: every figure on screen carries exactly one of OBSERVED, FORECAST, HISTORICAL, ANALYTICS
 * or AI INTERPRETATION, and the label is part of the badge rather than something a screen writes
 * beside it. That is what makes the distinction survive a screen being rewritten.
 *
 * The label text is fixed here, not passed in. A screen that could choose its own wording could
 * call an interpretation "analysis", and the whole point of the class is that the same content
 * always announces itself the same way. `AI INTERPRETATION` in particular is one label with one
 * spelling — the approved artifacts show both "AI INTERPRETATION" and "AGENT INTERPRETATION", and
 * two names for one class defeats the badge.
 *
 * This is the badge primitive only. The attribution footer, the uncertainty indicator and the
 * interpretation panel treatment are task 20.15.
 */

import type { ReactNode } from "react";

import type { DataClassName } from "@/lib/design/tokens";

import styles from "./primitives.module.css";

/** The word each data class announces itself with. */
export const DATA_CLASS_LABELS: Readonly<Record<DataClassName, string>> = {
  observed: "OBSERVED",
  forecast: "FORECAST",
  historical: "HISTORICAL",
  analytics: "ANALYTICS",
  interpretation: "AI INTERPRETATION",
};

/**
 * What each class means, for the description a screen or a legend can reuse.
 *
 * Kept beside the labels because the honest sentence about ANALYTICS — that Weathra computed it
 * deterministically — and the honest sentence about AI INTERPRETATION — that a language model
 * wrote it about figures it did not produce — are the two the interface must never blur.
 */
export const DATA_CLASS_DESCRIPTIONS: Readonly<Record<DataClassName, string>> = {
  observed: "Measured conditions retrieved from a weather provider.",
  forecast: "A provider's modelled forecast, shown with its uncertainty.",
  historical: "Past values retrieved from a historical archive.",
  analytics: "Computed deterministically by Weathra from retrieved values.",
  interpretation: "Written by a language model about the figures above, which it did not produce.",
};

export type BadgeTone = "neutral" | "accent" | "error" | "warning" | "ok" | "quota";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  /** Replaces the visible text for a screen reader, where the visible label is an abbreviation. */
  readonly "aria-label"?: string;
}

export function Badge({ tone = "neutral", children, ...rest }: BadgeProps): ReactNode {
  return (
    <span className={styles.badge} data-tone={tone} {...rest}>
      {children}
    </span>
  );
}

export interface DataClassBadgeProps {
  readonly dataClass: DataClassName;
}

/**
 * The data-class badge.
 *
 * `data-class` is on the element so a test — and task 21.9's review against the artifacts — can
 * assert which class a figure claims, without depending on a class name a CSS module generated.
 */
export function DataClassBadge({ dataClass }: DataClassBadgeProps): ReactNode {
  return (
    <span
      className={styles.badge}
      data-class={dataClass}
      title={DATA_CLASS_DESCRIPTIONS[dataClass]}
    >
      {DATA_CLASS_LABELS[dataClass]}
    </span>
  );
}
