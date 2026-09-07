/**
 * A chart's frame, with a state for having nothing to draw.
 *
 * The artifacts are full of charts, and several of Weathra's chart regions have no series behind
 * them at some point — an hourly forecast the provider did not supply, a baseline that could not be
 * computed. The implementation replaced those panels with a sentence, which is how a chart region
 * stops being a chart region: `03-historical-analytics.png` and `01-dashboard.png` both show a
 * plotted frame, and a paragraph where a plot should be reads as a different screen.
 *
 * So the frame is always drawn — the plot area, its baseline and its gridlines — and the reason
 * there is no series sits inside it. Nothing is plotted that was not measured; what is preserved is
 * the geometry, which is the part the artifact actually fixes.
 *
 * The empty state is a `role="img"` with the reason as its name rather than a decorative graphic
 * with text beside it, so a screen reader gets the same sentence a sighted reader does, once.
 */

import type { ReactNode } from "react";

import styles from "./primitives.module.css";

export interface ChartFrameProps {
  /** What the chart would show. Used as the empty state's accessible name. */
  readonly title: string;
  /** Why there is nothing to plot. One short sentence. */
  readonly reason: string;
  /** Roughly how tall the plot should be, matching the chart it stands in for. */
  readonly height?: number;
}

export function EmptyChart({ title, reason, height = 220 }: ChartFrameProps): ReactNode {
  return (
    <div className={styles.emptyChart} style={{ minHeight: `${height}px` }}>
      <div
        className={styles.emptyChartPlot}
        role="img"
        aria-label={`${title}. ${reason}`}
      >
        {/* The gridlines an axis would have. Decorative: the label above carries the meaning. */}
        <span className={styles.emptyChartGrid} aria-hidden="true" />
        <p className={styles.emptyChartReason} aria-hidden="true">
          {reason}
        </p>
      </div>
    </div>
  );
}
