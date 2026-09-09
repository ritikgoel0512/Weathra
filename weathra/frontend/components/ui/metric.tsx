/**
 * The metric readout: one figure, its unit, its class, and the note that qualifies it.
 *
 * The figure arrives as a string, already formatted. That is deliberate — precision, rounding and
 * unit conversion are the backend's answers (`specs/analytics` fixes them, and a person's unit
 * preference is applied where the value is produced), and a component that took a number would
 * have to guess how many decimals to show. Guessing is how a deterministic figure acquires a
 * digit nobody computed.
 *
 * Tabular numerals come from the style, so a column of these lines up.
 *
 * `icon` and `delta` were added for finding 3.4 of the runtime fidelity audit of 2026-09-08:
 * `03-historical-analytics.png` draws a glyph on every tile and a short caption under every figure
 * — "+3.2°C vs Normal", "12.9° Spread" — and production drew a label, a number, and a method note.
 * Both are optional and neither invents anything: the glyph is decorative and `aria-hidden`, and
 * the delta is a figure the backend computed, passed in already formatted, like `value`.
 */

import type { ReactNode } from "react";

import type { DataClassName } from "@/lib/design/tokens";

import { DataClassBadge } from "./badge";
import styles from "./primitives.module.css";

export interface MetricProps {
  readonly label: string;
  /** A glyph for the measure. Decorative: the label is what names the figure. */
  readonly icon?: ReactNode;
  /** Already formatted, including its sign and precision. */
  readonly value: string;
  readonly unit?: string;
  /**
   * The short comparison caption the artifact's tiles carry, under the figure and above the note.
   *
   * A figure the backend computed, formatted by the caller — this component does no arithmetic, for
   * the same reason it takes `value` as a string. `tone` colours it; "flat" is the default and is
   * also what an unsigned caption like "4 rain days" wants.
   */
  readonly delta?: { readonly text: string; readonly tone?: "up" | "down" | "flat" };
  /** What qualifies the figure: the period, the baseline, the method, the comparison. */
  readonly note?: ReactNode;
  /** The class this figure belongs to. Present on every weather-bearing metric. */
  readonly dataClass?: DataClassName;
}

export function Metric({
  label,
  icon,
  value,
  unit,
  delta,
  note,
  dataClass,
}: MetricProps): ReactNode {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHeader}>
        {icon ? (
          <span className={styles.metricIcon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className={styles.metricLabel}>{label}</span>
        {dataClass ? <DataClassBadge dataClass={dataClass} /> : null}
      </div>
      <div className={styles.metricValue}>
        <span>{value}</span>
        {unit ? <span className={styles.metricUnit}>{unit}</span> : null}
      </div>
      {delta ? (
        <div className={styles.metricDelta} data-tone={delta.tone ?? "flat"}>
          {delta.text}
        </div>
      ) : null}
      {note ? <div className={styles.metricNote}>{note}</div> : null}
    </div>
  );
}
