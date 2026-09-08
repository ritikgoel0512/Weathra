"use client";

/**
 * The loading, empty and error states, as the design system's version of them.
 *
 * `components/view-state.tsx` already carries the *obligation* to render four branches; it
 * deliberately carries no appearance, because inventing one before the design was approved would
 * have been the generic styling `specs/web-ui` rules out. These are the appearances, and the two
 * fit together: a screen renders `ViewStateSwitch` and hands it these.
 *
 * Each one is honest about a specific thing the spec names:
 *
 * - Loading is distinct from empty, and announces itself once through a live region.
 * - Empty says what to enter or what is not there, so an empty result is never dressed as an
 *   answer.
 * - Error shows *the backend's own message* and offers a retry that needs no page reload. It does
 *   not translate, soften, or replace that message with a friendlier one.
 */

import type { ReactNode } from "react";

import type { ViewFailure } from "@/lib/query/state";

import { Button } from "./button";
import styles from "./primitives.module.css";
import { Skeleton } from "./skeleton";

export interface LoadingStateProps {
  /** What is being fetched, for the live-region announcement. */
  readonly label?: string;
  /** How many placeholder lines to show. Match it to the shape that is coming. */
  readonly lines?: number;
  /**
   * The shape of the thing being waited for.
   *
   * `lines` is the default and right for a panel's contents. `band` is for a screen that opens on
   * a wide hero and then splits into two columns — the Dashboard's composition — and draws that
   * instead of a paragraph. The runtime audit of 2026-09-08 photographed the Dashboard mid-load as
   * six grey text lines: an accurate placeholder for a paragraph, and no indication at all of the
   * screen that was coming.
   */
  readonly shape?: "lines" | "band";
}

export function LoadingState({
  label = "Loading",
  lines = 3,
  shape = "lines",
}: LoadingStateProps): ReactNode {
  return (
    <div className={styles.state} role="status" aria-live="polite">
      {/* The global utility from app/globals.css: announced, not drawn. */}
      <span className="weathra-visually-hidden">{label}</span>
      {shape === "band" ? (
        <div className={styles.stateBand}>
          <Skeleton height="var(--space-7)" radius="var(--radius-lg)" />
          <div className={styles.stateBandColumns}>
            <Skeleton height="var(--space-7)" radius="var(--radius-lg)" />
            <Skeleton height="var(--space-7)" radius="var(--radius-lg)" />
          </div>
          <Skeleton height="var(--space-6)" radius="var(--radius-lg)" />
        </div>
      ) : (
        <div className={styles.stateLoading}>
          {Array.from({ length: lines }, (_, index) => (
            <Skeleton key={index} width={index === lines - 1 ? "60%" : "100%"} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  /** What to enter, or what is not there yet. Not an apology. */
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps): ReactNode {
  return (
    <div className={styles.state}>
      <p className={styles.stateTitle}>{title}</p>
      {children ? <div className={styles.stateBody}>{children}</div> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /** The failure as the query layer described it, message and request id included. */
  readonly failure: Pick<ViewFailure, "message" | "requestId">;
  readonly title?: string;
  /** Runs the request again in place. Omitted only where a retry cannot help. */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export function ErrorState({
  failure,
  title = "That request did not complete",
  onRetry,
  retryLabel = "Try again",
}: ErrorStateProps): ReactNode {
  return (
    <div className={`${styles.state} ${styles.stateError}`} role="alert">
      <p className={styles.stateTitle}>{title}</p>
      <p className={styles.stateBody}>{failure.message}</p>
      {failure.requestId ? (
        <p className={styles.stateMeta}>Request {failure.requestId}</p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
