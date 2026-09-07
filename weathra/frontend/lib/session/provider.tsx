"use client";

/**
 * The session boundary — task 20.9's shared layer, and the only place in the frontend that decides
 * a session has ended.
 *
 * It sits between the protected layout, which has already resolved the session **on the server**,
 * and the screens, which make authenticated calls. Three things pass through it:
 *
 * **The pending state.** A boundary that does not yet know renders the design system's loading
 * state — not the screen, and not "you are signed out". `specs/web-ui` forbids the first (a flash
 * of protected content) and honesty forbids the second. On a protected route this state is never
 * seen: the layout resolves the session server-side and seeds the boundary `active`, which is the
 * structural reason there is nothing to flash. The pending path exists for a client-only mount,
 * and resolves it by asking Supabase — which is also what refreshes an expiring token.
 *
 * **The 401 interceptor.** The API client already turns a 401 into `SessionExpired` and calls
 * `onSessionExpired` (task 20.11); this is what was missing — something to *receive* it. A session
 * that ends replaces the screen with the expired-session state, and the person keeps their place.
 * An ordinary failure — an unreachable backend, a 500, a range outside coverage — reaches the
 * screen's own error branch untouched, because `isAuthenticationFailure` is narrow on purpose.
 *
 * **Cross-user state.** Everything cached was fetched for the session that just ended, so the query
 * cache is cancelled and cleared when it does. The cache also *lives* here, inside the boundary
 * inside the protected layout, so signing out unmounts it rather than leaving one person's answers
 * in memory for the next person to sign in on the same machine.
 *
 * **No loop is representable.** `expired` is terminal in `nextStatus`, the transition runs once
 * behind a ref, and the query layer already refuses to retry a 401 (`shouldRetry`). Nothing here
 * re-attempts a request, refreshes in response to a rejection, or navigates on its own.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createApiClient, type AccessTokenSource } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { QueryProvider } from "@/lib/query/provider";
import { browserAccessToken } from "@/lib/supabase/browser";
import { LoadingState } from "@/components/ui";
import { SessionExpiredState } from "@/components/session/session-expired";

import { mayRenderProtectedContent, nextStatus, type SessionStatus } from "./state";

export interface SessionValue {
  readonly status: SessionStatus;
  /** Called by the 401 interceptor. Idempotent, and one way only. */
  readonly markExpired: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/** The session state. Throws rather than returning null, so a missing boundary fails at the edge. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession was called outside a <SessionBoundary>.");
  }
  return value;
}

export interface SessionBoundaryProps {
  readonly children: ReactNode;
  /**
   * Seeded from the server-resolved session. The protected layout passes `"active"` because it has
   * already validated it with Supabase — which is what keeps the pending state off a screen that
   * has nothing to wait for.
   */
  readonly initialStatus?: SessionStatus;
  /**
   * Injected by tests. The client is built **here** rather than accepted whole, because the
   * interceptor is the point: a client handed in from outside would carry somebody else's
   * `onSessionExpired`, or none, and the wiring under test would be the test's own.
   */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injected by tests; the browser session's token otherwise. */
  readonly accessToken?: AccessTokenSource;
  /** What the pending state announces. */
  readonly pendingLabel?: string;
  /**
   * The chrome the gated content renders inside — the application shell.
   *
   * It is a render prop rather than a wrapper around `SessionBoundary` because the shell needs the
   * query layer and the API client this boundary provides: `01-dashboard.png` puts the person's
   * saved locations in the navigation rail, and painting them means asking the backend for them.
   * Rendering the shell *outside* the boundary would leave the rail with no way to ask; rendering
   * it *inside* the gate would replace the whole frame with the expired-session state, so a person
   * whose session lapsed would lose the navigation along with the screen. Between the two is
   * exactly where it belongs.
   */
  readonly frame?: (content: ReactNode) => ReactNode;
}

export function SessionBoundary(props: SessionBoundaryProps): ReactNode {
  // The cache is created inside the boundary so its lifetime is the session's: signing out unmounts
  // this, and one person's answers do not outlive their session.
  return (
    <QueryProvider>
      <SessionGate {...props} />
    </QueryProvider>
  );
}

function SessionGate({
  children,
  initialStatus = "pending",
  fetch: injectedFetch,
  accessToken,
  pendingLabel = "Checking your session",
  frame,
}: SessionBoundaryProps): ReactNode {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>(initialStatus);

  // One transition, ever. A second 401 from a request already in flight finds this closed.
  const settled = useRef(false);

  const markExpired = useCallback(() => {
    if (settled.current) return;
    settled.current = true;

    setStatus((current) => nextStatus(current, "authentication-failed"));
    // Stop what is in flight before clearing, so a late response cannot repopulate the cache with
    // the previous session's data.
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  /**
   * Resolve a boundary that was mounted without a server-resolved answer.
   *
   * `browserAccessToken()` reads the session from the cookie store and asks Supabase to refresh it
   * when the access token has expired and the refresh token has not — so this is the transparent
   * refresh, and a refresh that *cannot* happen ends here as an expired session rather than as a
   * request failure a screen would show as a data error.
   */
  useEffect(() => {
    if (initialStatus !== "pending") return;

    let live = true;
    void (async () => {
      try {
        const token = await browserAccessToken();
        if (!live) return;
        if (token === null) markExpired();
        else setStatus((current) => nextStatus(current, "resolved"));
      } catch {
        // Unreachable identity provider. Not a session Weathra can vouch for, and not a message
        // about the provider either.
        if (live) markExpired();
      }
    })();

    return () => {
      live = false;
    };
  }, [initialStatus, markExpired]);

  /**
   * The API client every screen in the boundary uses, with the 401 interceptor already attached.
   *
   * The token is read per call (task 20.11), so a transparently refreshed one is the one that gets
   * sent — a client that captured the first token would start failing partway through a session,
   * and that failure would arrive here looking exactly like an expiry.
   */
  const client = useMemo(
    () =>
      createApiClient({
        accessToken: accessToken ?? browserAccessToken,
        ...(injectedFetch ? { fetch: injectedFetch } : {}),
        onSessionExpired: markExpired,
      }),
    [accessToken, injectedFetch, markExpired],
  );

  const value = useMemo<SessionValue>(() => ({ status, markExpired }), [status, markExpired]);

  const gated =
    status === "expired" ? (
      <SessionExpiredState />
    ) : mayRenderProtectedContent(status) ? (
      children
    ) : (
      <LoadingState label={pendingLabel} />
    );

  return (
    <SessionContext.Provider value={value}>
      <ApiProvider client={client}>{frame ? frame(gated) : gated}</ApiProvider>
    </SessionContext.Provider>
  );
}
