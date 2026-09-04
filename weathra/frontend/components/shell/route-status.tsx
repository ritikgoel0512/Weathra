/**
 * What a route says before its screen exists.
 *
 * Two honest states, and the distinction between them matters:
 *
 * - **`planned`** — a post-MVP destination. `specs/web-ui` requires the route to exist and to
 *   state plainly that the screen is not yet available, rather than rendering a broken or empty
 *   interface. The routing structure is real so the navigation is not lying about the product's
 *   shape; the screen is not, and this says so.
 * - **`in-progress`** — an MVP screen whose route the shell needs in order to be navigable, and
 *   whose content is task group 21. It does not claim to be a screen either.
 *
 * Deliberately static. It issues no request, holds no state and reads no session: a "not yet
 * available" page that fetched something would be doing the one thing the requirement exists to
 * prevent.
 */

import type { ReactNode } from "react";

import { Badge } from "@/components/ui";

import styles from "./shell.module.css";

export type RouteStatusKind = "planned" | "in-progress";

export interface RouteStatusProps {
  readonly title: string;
  readonly status: RouteStatusKind;
  /** What the destination will do, in one line. Optional, and never a promise about when. */
  readonly children?: ReactNode;
}

export function RouteStatus({ title, status, children }: RouteStatusProps): ReactNode {
  const planned = status === "planned";

  return (
    <section className={styles.routeStatus}>
      <div className={styles.routeStatusHeading}>
        <h1>{title}</h1>
        <Badge tone="neutral">{planned ? "Not yet available" : "In progress"}</Badge>
      </div>
      <p className={styles.routeStatusBody}>
        {planned
          ? "This screen is not yet available. Its place in Weathra is settled and its route is real, so nothing here is broken — there is simply nothing to show until it is built."
          : "This screen is not built yet. The navigation, the design system and the route are in place; the screen itself comes next."}
      </p>
      {children ? <p className={styles.routeStatusBody}>{children}</p> : null}
    </section>
  );
}
