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
 *
 * `QuotaState` is the fifth, added in task 33.5. It is not one of the four resolutions — an
 * exhausted allowance is a refusal of one request rather than a state a view is in — and it is
 * here because it is a *design-system* state (`design-system.md` §11) that must be visually and
 * textually separate from the error above it.
 */

import type { ReactNode } from "react";

import { limitSentence, type QuotaRefusal } from "@/lib/api/quota";
import type { ViewFailure } from "@/lib/query/state";

import { Badge } from "./badge";
import { Button } from "./button";
import styles from "./primitives.module.css";
import { formatInstant } from "./provenance";
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

/* ------------------------------------------------------- the exhausted allowance */

export interface QuotaStateProps {
  /** The refusal as the backend described it. */
  readonly refusal: QuotaRefusal;
  /**
   * Asks the same question again.
   *
   * Offered only where waiting could actually change the answer — a concurrency limit lifts when a
   * run finishes. For a day or a month, a retry gets the same refusal, and a control that invites
   * one is a control that lies about what pressing it does.
   */
  readonly onRetry?: () => void;
}

/**
 * An exhausted allowance, as its own state.
 *
 * Four things make it the state `specs/web-ui` asks for rather than a restyled error:
 *
 * - **Its own words.** The title says the allowance is used up. It does not say a request failed,
 *   and it does not say Weathra could not be reached — because neither happened.
 * - **Its own colour.** `status-quota` is deliberately not a shade of red (`tokens.md`): an
 *   exhausted allowance is not a failure, and the palette says so before the text does.
 * - **The limit and the reset, named.** From the refusal's own figures, and withheld rather than
 *   invented where the backend sent none.
 * - **What is unaffected, said.** A person who has hit their limit still has every screen that
 *   needs no model, and their thread, saved places and preferences are untouched. This component
 *   removes nothing; it is rendered *beside* what is already on screen.
 */
export function QuotaState({ refusal, onRetry }: QuotaStateProps): ReactNode {
  const limit = limitSentence(refusal);
  const resets = formatInstant(refusal.resetsAt);

  return (
    <div
      className={`${styles.state} ${styles.stateQuota}`}
      role="status"
      data-quota="true"
      data-quota-dimension={refusal.dimension ?? undefined}
    >
      <div className={styles.stateQuotaHeading}>
        <Badge tone="quota">Allowance used</Badge>
        <p className={styles.stateTitle}>You have used your plan&rsquo;s allowance</p>
      </div>

      {/* The backend's own sentence, which names the window and what stays available. */}
      <p className={styles.stateBody}>{refusal.message}</p>

      <dl className={styles.stateQuotaFacts}>
        <div>
          <dt>Limit</dt>
          <dd>{limit ?? "The backend did not report the figures."}</dd>
        </div>
        <div>
          <dt>Resets</dt>
          <dd>
            {resets !== null ? (
              <time dateTime={refusal.resetsAt ?? undefined}>{resets}</time>
            ) : refusal.window === "concurrent" ? (
              "As soon as one of your questions finishes."
            ) : (
              "The backend did not report a reset time."
            )}
          </dd>
        </div>
      </dl>

      <p className={styles.stateMeta}>
        This is your plan&rsquo;s limit, not a failure: nothing went wrong with Weathra or with the
        inference provider. Your conversation, saved locations and preferences are unchanged, and
        you are still signed in.
      </p>

      {refusal.requestId ? (
        <p className={styles.stateMeta}>Request {refusal.requestId}</p>
      ) : null}

      {onRetry && refusal.window === "concurrent" ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Ask again
        </Button>
      ) : null}
    </div>
  );
}
