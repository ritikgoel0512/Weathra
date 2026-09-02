/**
 * The route gate. Runs before anything renders, on every request that could be a page.
 *
 * `specs/web-ui` requires route protection to be applied *before* a protected screen renders and
 * to be one of two places authorization lives, never the only one — the backend validates the
 * bearer token on every call regardless of what this decides. What this buys is the experience: an
 * unauthenticated visitor is routed to sign-in with their destination kept, instead of watching a
 * product screen render and then empty itself out.
 *
 * Both directions are handled here, because both are the same question asked of the same session:
 * a visitor without one is sent to sign-in (task 20.2), and one who already has a session is sent
 * into the product rather than being shown a sign-in form (task 20.10).
 */

import type { NextRequest, NextResponse } from "next/server";

import {
  DEFAULT_PROTECTED_PATH,
  DESTINATION_PARAMETER,
  isAuthPath,
  isProtectedPath,
  safeDestination,
  signInPathFor,
} from "@/lib/routes";
import { redirectPreservingSession, updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search, searchParams } = request.nextUrl;
  const { response, user } = await updateSession(request);

  if (user === null && isProtectedPath(pathname)) {
    return redirectPreservingSession(request, signInPathFor(pathname, search), response);
  }

  if (user !== null && isAuthPath(pathname)) {
    // Where they were going before they were sent here, if they were sent here at all.
    const destination = safeDestination(searchParams.get(DESTINATION_PARAMETER));
    return redirectPreservingSession(
      request,
      destination ?? DEFAULT_PROTECTED_PATH,
      response,
    );
  }

  return response;
}

export const config = {
  /**
   * Everything except Next's own assets and static files.
   *
   * The gate is protected-by-default (`lib/routes.ts`), so the matcher must not become a second,
   * quieter allow-list: a page excluded here is a page with no gate at all. Only paths that cannot
   * be a screen are excluded — the build output, the favicon, and image files.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
