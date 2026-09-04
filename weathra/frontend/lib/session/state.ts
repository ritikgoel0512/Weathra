/**
 * The session-state layer's pure half — task 20.9.
 *
 * Two questions live here, and both are the kind that must have exactly one answer in the whole
 * application:
 *
 * **Is this failure an authentication failure?** `specs/web-ui` requires an expired session to
 * produce the expired-session state and a return to sign-in, and requires it *not* to be presented
 * as a data or server error. The corollary matters just as much and is the easier one to get wrong:
 * a weather provider being unavailable, a range outside coverage, an unreachable backend, a 500 —
 * none of those is a reason to tell somebody they have been signed out. So the test is narrow and
 * explicit rather than "the request failed".
 *
 * **What does the session status become?** A transition table rather than assignments scattered
 * through a component, because one of its properties is load-bearing: **`expired` is terminal.**
 * Once the layer has decided the session is gone it cannot be talked back into `active` by a late
 * response, and a second authentication failure changes nothing — which is what makes an
 * expire/refresh/retry loop unrepresentable rather than merely unlikely.
 *
 * Nothing here reads a token, holds one, or knows what one looks like.
 */

import { isAuthenticationCode } from "@/lib/api/errors";

/**
 * Where the session layer is.
 *
 * `pending` is "we do not know yet" — never "signed out". The distinction is the requirement: a
 * screen must not flash protected content while resolution is in progress, and must not tell a
 * person they are signed out while they are not.
 */
export type SessionStatus = "pending" | "active" | "expired";

/** What can happen to a session while somebody is using the application. */
export type SessionEvent = "resolved" | "authentication-failed" | "request-failed";

interface DescribedFailure {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly code?: unknown;
}

/**
 * Whether a thrown value means "there is no valid session".
 *
 * Read structurally rather than by `instanceof`, for the same reason `describeFailure` is: a value
 * that has crossed a React Query cache, a serialization boundary, or a test's fake still describes
 * the same failure, and a check insisting on the class would quietly answer "no" for all of them.
 *
 * Three signals, each sufficient: the client's own `SessionExpired`, a 401, and one of the
 * backend's authentication codes — the last of which is how an authentication failure arrives
 * inside a stream's terminal event, where there is no status code to read.
 *
 * A 403 is deliberately **not** one of them. Being refused something is not the same as having no
 * session, and treating it as an expiry would sign a person out for opening a screen they are not
 * entitled to.
 */
export function isAuthenticationFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const described = error as DescribedFailure;

  if (described.name === "SessionExpired") return true;
  if (described.status === 401) return true;
  return isAuthenticationCode(typeof described.code === "string" ? described.code : null);
}

/**
 * The status after an event.
 *
 * `expired` absorbs everything: a late success, another 401, a retry that arrives after the person
 * has already been told. That absorption is the loop protection.
 */
export function nextStatus(current: SessionStatus, event: SessionEvent): SessionStatus {
  if (current === "expired") return "expired";
  if (event === "authentication-failed") return "expired";
  if (event === "resolved") return "active";
  // An ordinary request failure says nothing about the session, and must not.
  return current;
}

/** Whether protected content may be rendered in this status. Only one of the three qualifies. */
export function mayRenderProtectedContent(status: SessionStatus): boolean {
  return status === "active";
}
