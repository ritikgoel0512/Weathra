/**
 * The application's route map, and the authentication boundary drawn over it.
 *
 * Route *groups* — `(auth)` and `(app)` — carry the boundary in the file tree (design.md decision
 * 18), but a group name never appears in a URL, so `middleware.ts` cannot read the boundary off
 * the path. This module is where the boundary becomes something a path can be tested against.
 *
 * **Protected by default.** The list below enumerates what is *public*; everything else requires a
 * session. A deny-list would mean a screen added later is public until somebody remembers to list
 * it, and the failure mode of forgetting is an unprotected product screen. With an allow-list the
 * failure mode of forgetting is a sign-in redirect on a page that meant to be public — visible
 * immediately, and harmless.
 *
 * The screens come from `specs/web-ui`, which names them and separates the MVP set from the
 * post-MVP set. Their titles and paths are structure, not visual design: the design artifacts
 * (group 19) decide how navigation *looks*, and `docs/design/` records them.
 */

/** A screen the navigation surface can reach. */
export interface Screen {
  readonly path: string;
  readonly title: string;
}

/** The unauthenticated screens: the `(auth)` route group. */
export const AUTH_SCREENS: readonly Screen[] = [
  { path: "/sign-in", title: "Sign In" },
  { path: "/create-account", title: "Create Account" },
  { path: "/verify-email", title: "Verify Email" },
  { path: "/forgot-password", title: "Forgot Password" },
  { path: "/reset-password", title: "Reset Password" },
];

/**
 * Route handlers completing a flow a person entered from their email client.
 *
 * Public of necessity: someone following a verification or recovery link has no session yet —
 * completing the link is how they get one. The handler itself validates the one-time token, so the
 * route being public is not the same as the action being unauthenticated.
 */
export const AUTH_CALLBACK_PREFIX = "/auth/";

/** The protected MVP product screens, in navigation order. */
export const MVP_SCREENS: readonly Screen[] = [
  { path: "/", title: "Dashboard" },
  { path: "/analyst", title: "AI Weather Analyst" },
  { path: "/historical", title: "Historical Analytics" },
  { path: "/compare", title: "Compare Cities" },
  { path: "/evidence", title: "Agent Evidence" },
  { path: "/locations", title: "Saved Locations" },
  { path: "/settings", title: "Settings" },
];

/**
 * Routing structure reserved for the post-MVP screens, which `specs/web-ui` requires to exist and
 * to state plainly that they are not yet available — protected like any other product route, so
 * the boundary does not acquire an exception it would have to remember to close later.
 */
export const POST_MVP_SCREENS: readonly Screen[] = [
  { path: "/report", title: "Weather Intelligence Report" },
  { path: "/explorer", title: "Forecast Explorer" },
  { path: "/scenarios", title: "Weather Scenario Lab" },
  { path: "/watch", title: "Weather Watch" },
  { path: "/travel", title: "Travel Intelligence" },
];

/** Where an authenticated person lands when they have asked for no particular screen. */
export const DEFAULT_PROTECTED_PATH = "/";

/** Where an unauthenticated person is sent, and where an expired session returns them. */
export const SIGN_IN_PATH = "/sign-in";

/** The query parameter carrying the screen a person was trying to reach. */
export const DESTINATION_PARAMETER = "next";

function matches(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Whether the path is one of the unauthenticated authentication screens. */
export function isAuthPath(pathname: string): boolean {
  return AUTH_SCREENS.some((screen) => matches(pathname, screen.path));
}

/** Whether the path may be served without a session. */
export function isPublicPath(pathname: string): boolean {
  return isAuthPath(pathname) || pathname.startsWith(AUTH_CALLBACK_PREFIX);
}

/** Whether reaching the path requires a session. Everything not explicitly public does. */
export function isProtectedPath(pathname: string): boolean {
  return !isPublicPath(pathname);
}

/**
 * A destination read back from the `next` parameter, or null if it cannot be trusted.
 *
 * Only a path on this origin is accepted. `//evil.example` and `https://evil.example` are both
 * rejected: a browser reads a protocol-relative URL as another origin, so echoing one back into a
 * redirect would turn the sign-in screen into an open redirect — a phishing primitive handed out
 * by the very screen people are told to trust with their password.
 */
export function safeDestination(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/\\")) return null;
  return value;
}

/** The sign-in URL for an unauthenticated request, preserving where the person was going. */
export function signInPathFor(pathname: string, search = ""): string {
  const destination = `${pathname}${search}`;
  if (destination === DEFAULT_PROTECTED_PATH) return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?${DESTINATION_PARAMETER}=${encodeURIComponent(destination)}`;
}
