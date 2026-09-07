"use client";

/**
 * The protected frame: the session boundary with the application shell rendered inside it.
 *
 * This exists for one structural reason. `01-dashboard.png` — and every other product artifact —
 * puts the person's saved locations in the navigation rail, and painting them means *asking the
 * backend for them*. The shell used to render outside `SessionBoundary`, which owns the query cache
 * and the authenticated API client, so the rail had nothing to ask with. Moving the shell inside
 * the boundary through its `frame` prop gives it the query layer, while the expired-session state
 * still replaces only the screen — a person whose session lapsed keeps the navigation and sees the
 * expiry where their content was, rather than losing the whole frame.
 *
 * It is a client component because `frame` is a function, and a server component cannot hand a
 * function to a client one. `identity` and `signOutControl` are still resolved on the server and
 * passed through: the sign-out control arrives as already-rendered output so its server action is
 * never reached across a client boundary.
 */

import type { ReactNode } from "react";

import type { Identity } from "@/lib/auth/identity";
import { SessionBoundary } from "@/lib/session/provider";

import { AppShell } from "./app-shell";

export interface ProtectedFrameProps {
  readonly identity: Identity;
  readonly signOutControl?: ReactNode;
  readonly children?: ReactNode;
}

export function ProtectedFrame({
  identity,
  signOutControl,
  children,
}: ProtectedFrameProps): ReactNode {
  return (
    <SessionBoundary
      initialStatus="active"
      frame={(content) => (
        <AppShell identity={identity} signOutControl={signOutControl}>
          {content}
        </AppShell>
      )}
    >
      {children}
    </SessionBoundary>
  );
}
