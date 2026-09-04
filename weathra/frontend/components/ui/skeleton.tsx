/**
 * The loading placeholder.
 *
 * Hidden from assistive technology: a screen reader announcing six grey rectangles is worse than
 * silence, and the announcement belongs to the one live region `LoadingState` renders. The shimmer
 * is removed entirely under `prefers-reduced-motion` rather than slowed down.
 */

import type { ReactNode } from "react";

import styles from "./primitives.module.css";

export interface SkeletonProps {
  readonly width?: string;
  readonly height?: string;
  readonly radius?: string;
}

export function Skeleton({
  width = "100%",
  height = "var(--space-4)",
  radius,
}: SkeletonProps): ReactNode {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}
