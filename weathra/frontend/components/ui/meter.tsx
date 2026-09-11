/**
 * A labelled bar — the "Confidence Matrix", "Node Health Index" and "Deviation Analysis" geometry
 * the artifacts use in several places.
 *
 * `01-dashboard.png` fills its bars with 94% and 82%, `06-saved-locations.png` with 98/92/84, and
 * `04-compare-cities.png` with a correlation score. None of those is a figure any Weathra endpoint
 * produces. The bar is therefore a component with two states, and the second one is the important
 * one: given no value it draws the same track at the same size and says the figure is not
 * available, rather than filling to a number nobody computed.
 *
 * `role="meter"` only when there is something to measure; an unavailable bar is plain text and a
 * decorative track, because a meter with no value announces as one anyway.
 */

import type { ReactNode } from "react";

import styles from "./primitives.module.css";

export interface MeterProps {
  readonly label: string;
  /** 0–1. `null` when the backend supplies no such figure. */
  readonly value?: number | null;
  /** What to say in place of a value. */
  readonly unavailable?: string;
  /**
   * The figure to print, when a percentage of the bar's length is the wrong thing to print.
   *
   * Added for Compare Cities' correlation bar. There the bar's length is |r| — a bar has no
   * direction — and the percentage that length implies is not the statistic: `r = -0.9` fills
   * 90% of the track and means the two places move *oppositely*, so a headline reading "90%"
   * would be confidently wrong. The caller passes "-0.90" instead. Omit it wherever the value
   * really is a proportion, as a data density is, and the percentage is right.
   */
  readonly valueLabel?: string;
  /** Optional short note under the bar. */
  readonly note?: ReactNode;
}

export function Meter({
  label,
  value = null,
  unavailable = "Not available",
  valueLabel,
  note,
}: MeterProps): ReactNode {
  const known = typeof value === "number" && Number.isFinite(value);
  const percent = known ? Math.max(0, Math.min(1, value)) * 100 : 0;

  return (
    <div className={styles.meter} data-known={known ? "true" : "false"}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>{label}</span>
        <span className={styles.meterValue}>
          {known ? (valueLabel ?? `${Math.round(percent)}%`) : unavailable}
        </span>
      </div>
      <div
        className={styles.meterTrack}
        {...(known
          ? {
              role: "meter",
              "aria-valuenow": Math.round(percent),
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-label": label,
              // The figure a sighted reader sees, so a screen reader is not told the bar's length
              // where that length is not the statistic.
              ...(valueLabel ? { "aria-valuetext": valueLabel } : {}),
            }
          : { "aria-hidden": true })}
      >
        <span className={styles.meterFill} style={{ width: `${percent}%` }} />
      </div>
      {note ? <p className={styles.meterNote}>{note}</p> : null}
    </div>
  );
}
