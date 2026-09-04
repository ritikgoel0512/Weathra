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
 */

import type { ReactNode } from "react";

import type { DataClassName } from "@/lib/design/tokens";

import { DataClassBadge } from "./badge";
import styles from "./primitives.module.css";

export interface MetricProps {
  readonly label: string;
  /** Already formatted, including its sign and precision. */
  readonly value: string;
  readonly unit?: string;
  /** What qualifies the figure: the period, the baseline, the method, the comparison. */
  readonly note?: ReactNode;
  /** The class this figure belongs to. Present on every weather-bearing metric. */
  readonly dataClass?: DataClassName;
}

export function Metric({ label, value, unit, note, dataClass }: MetricProps): ReactNode {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHeader}>
        <span className={styles.metricLabel}>{label}</span>
        {dataClass ? <DataClassBadge dataClass={dataClass} /> : null}
      </div>
      <div className={styles.metricValue}>
        <span>{value}</span>
        {unit ? <span className={styles.metricUnit}>{unit}</span> : null}
      </div>
      {note ? <div className={styles.metricNote}>{note}</div> : null}
    </div>
  );
}
