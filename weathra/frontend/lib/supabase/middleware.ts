/**
 * The session-refresh helper `middleware.ts` runs on every matched request.
 *
 * Two jobs, and they are one operation because Supabase's refresh writes cookies:
 *
 * 1. **Refresh the session.** An access token is short-lived by design (design.md decision 17 sets
 *    the agent's wall-clock budget below its lifetime). Refreshing here means every server
 *    component, route handler and middleware check downstream sees a valid session, and a person
 *    who left a tab open overnight is not signed out for it.
 * 2. **Report who is signed in**, so the caller can gate the route before anything renders.
 *
 * **Why the cookies are written to the request *and* the response.** A refresh issues new cookies.
 * The response must carry them so the browser stores them; the request must carry them so the
 * server components rendering *this* response read the new session rather than the expired one
 * they arrived with. Writing only the response leaves this render one token behind, which shows up
 * as an intermittent, unreproducible sign-out — the failure mode the Supabase SSR guidance warns
 * about, and the reason this helper is a named, tested unit rather than a few lines inlined into
 * `middleware.ts`.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { publicEnv } from "@/lib/env";

export interface SessionResult {
  /**
   * The response to return, or to copy cookies from when the caller redirects instead. It carries
   * any refreshed session cookies; discarding it discards the refresh.
   */
  readonly response: NextResponse;
  /** The signed-in user, or null. */
  readonly user: User | null;
}

/** Refresh the session for this request and report who it belongs to. */
export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request });

  const client = createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(updates: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of updates) {
          request.cookies.set(name, value);
        }
        // Rebuilt from the mutated request so this render reads the refreshed session, then the
        // cookies are set on the new response for the browser.
        response = NextResponse.next({ request });
        for (const { name, value, options } of updates) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser()` validates the token with Supabase rather than trusting the cookie's contents, and
  // is what triggers the refresh when the access token has expired but the refresh token has not.
  const {
    data: { user },
  } = await client.auth.getUser();

  return { response, user };
}

/**
 * A redirect that keeps the session cookies the refresh just issued.
 *
 * A bare `NextResponse.redirect` drops them, so a person whose token refreshed on the request that
 * redirected them would arrive at sign-in with the *old* cookies — signed out by the very request
 * that renewed their session.
 */
export function redirectPreservingSession(
  request: NextRequest,
  destination: string,
  refreshed: NextResponse,
): NextResponse {
  const url = request.nextUrl.clone();
  const [pathname, search = ""] = destination.split("?");
  url.pathname = pathname ?? "/";
  url.search = search;

  const redirect = NextResponse.redirect(url);
  for (const cookie of refreshed.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}
