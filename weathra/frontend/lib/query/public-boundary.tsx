"use client";

/**
 * The query layer for screens that read *public* data without a session.
 *
 * `SessionBoundary` is the authenticated counterpart: it mounts `QueryProvider` and `ApiProvider`
 * for everything inside `(app)`. Nothing mounted them for `(auth)`, because until Choose Your Plan
 * arrived no unauthenticated screen asked the backend for anything — they all talk to Supabase
 * directly. `/choose-plan` does ask: `GET /plans` is public, and reading it needs a query client and
 * an API client exactly like a protected screen does.
 *
 * Without this the hook threw `useApiClient was called outside an <ApiProvider>` during hydration,
 * which Next.js surfaces as "Application error: a client-side exception has occurred" — the whole
 * of the signup crash.
 *
 * The client here carries **no access token** on purpose. The route is reachable by somebody who
 * has just created an account and has not confirmed their address, so there is no session to send
 * and none is needed: the tiers are public. There is no `onSessionExpired` either — a 401 from a
 * public read is a backend fault to show, not a session to end.
 */

import { useMemo, type ReactNode } from "react";

import { createApiClient, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";

import { QueryProvider } from "./provider";

export interface PublicDataBoundaryProps {
  readonly children: ReactNode;
  /** Supplied by tests; an anonymous client is built otherwise. */
  readonly client?: ApiClient;
}

export function PublicDataBoundary({ children, client }: PublicDataBoundaryProps): ReactNode {
  return (
    <QueryProvider>
      <PublicApi client={client}>{children}</PublicApi>
    </QueryProvider>
  );
}

function PublicApi({ children, client }: PublicDataBoundaryProps): ReactNode {
  // Held in a memo so a re-render does not swap the client and re-issue every request under it.
  const anonymous = useMemo(() => client ?? createApiClient(), [client]);
  return <ApiProvider client={anonymous}>{children}</ApiProvider>;
}
