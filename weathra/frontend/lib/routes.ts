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

/**
 * The authentication paths, named.
 *
 * A screen that links to another writes the constant, not the string: a path typed twice is a path
 * that can be renamed once. `SIGN_IN_PATH` is further down, beside the redirect it belongs to.
 */
export const CREATE_ACCOUNT_PATH = "/create-account";
export const VERIFY_EMAIL_PATH = "/verify-email";
export const FORGOT_PASSWORD_PATH = "/forgot-password";
export const RESET_PASSWORD_PATH = "/reset-password";

/** The unauthenticated screens: the `(auth)` route group. */
export const AUTH_SCREENS: readonly Screen[] = [
  { path: "/sign-in", title: "Sign In" },
  { path: CREATE_ACCOUNT_PATH, title: "Create Account" },
  { path: VERIFY_EMAIL_PATH, title: "Verify Email" },
  { path: FORGOT_PASSWORD_PATH, title: "Forgot Password" },
  { path: RESET_PASSWORD_PATH, title: "Reset Password" },
];

/**
 * Route handlers completing a flow a person entered from their email client.
 *
 * Public of necessity: someone following a verification or recovery link has no session yet —
 * completing the link is how they get one. The handler itself validates the one-time token, so the
 * route being public is not the same as the action being unauthenticated.
 */
export const AUTH_CALLBACK_PREFIX = "/auth/";

/** The one returning-link handler: verification and recovery both come back through it (task 20.6). */
export const AUTH_CONFIRM_PATH = `${AUTH_CALLBACK_PREFIX}confirm`;

/**
 * How a callback tells the screen it lands on which flow it just completed.
 *
 * A Weathra-controlled marker and nothing more. It carries no token, and it is **not** a claim that
 * anybody is verified: the screen it lands on resolves the session server-side and shows its
 * success state only if Supabase agrees. What the marker actually decides is narrower — whether an
 * already-authenticated person is allowed to *stay* on an authentication screen, which is the one
 * thing `middleware.ts` cannot work out from the path alone.
 */
export const COMPLETED_PARAMETER = "completed";
export const COMPLETED_VERIFICATION = "verification";
export const COMPLETED_RECOVERY = "recovery";

/**
 * Whether this authentication screen is completing a flow that *needed* the session to exist.
 *
 * Task 20.10 redirects an already-authenticated person off the authentication screens, and it is
 * right about every one of them except these two moments: the verification success state exists
 * precisely because a session was just established, and setting a new password after a recovery
 * link requires the recovery session. Bouncing either would make the flow that created the session
 * impossible to finish.
 */
export function completesAuthFlow(pathname: string, parameters: URLSearchParams): boolean {
  const completed = parameters.get(COMPLETED_PARAMETER);
  if (pathname === VERIFY_EMAIL_PATH) return completed === COMPLETED_VERIFICATION;
  if (pathname === RESET_PASSWORD_PATH) return completed === COMPLETED_RECOVERY;
  return false;
}

/**
 * Agent Evidence, which is the one MVP screen addressed by a record rather than by a name.
 *
 * `/evidence` is the navigation destination and explains where a record comes from;
 * `/evidence/{id}` is one stored run. The identifier is always the backend's — it comes from an
 * answer's `evidence_id` and is never constructed here — and it is encoded on the way into the path
 * so an identifier that ever stops being a UUID cannot smuggle a segment into the URL.
 */
export const EVIDENCE_PATH = "/evidence";

/** The route for one stored run. */
export function evidencePath(evidenceId: string): string {
  return `${EVIDENCE_PATH}/${encodeURIComponent(evidenceId)}`;
}

/** The protected MVP product screens, in navigation order. */
export const MVP_SCREENS: readonly Screen[] = [
  { path: "/", title: "Dashboard" },
  { path: "/analyst", title: "AI Weather Analyst" },
  { path: "/historical", title: "Historical Analytics" },
  { path: "/compare", title: "Compare Cities" },
  { path: EVIDENCE_PATH, title: "Agent Evidence" },
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

/**
 * Says that the person is back at sign-in because their session ran out, rather than because they
 * asked to be. `specs/web-ui` requires an expired session to be *said*, not silently presented as
 * a fresh sign-in — and a marker in the URL is the only thing that survives the navigation.
 *
 * It carries no identity and grants nothing: the sign-in screen reads it to choose a sentence.
 */
export const EXPIRED_PARAMETER = "expired";

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

/**
 * Where the expired-session state sends somebody, keeping their place.
 *
 * The destination goes through `safeDestination` first even though it comes from the browser's own
 * address bar — this is the one function that turns a *current location* into a redirect target,
 * and a value that has been through a rewrite, a proxy, or a crafted link is not automatically a
 * path on this origin just because a browser is currently showing it.
 */
export function expiredSignInPath(pathname: string, search = ""): string {
  const destination = safeDestination(`${pathname}${search}`);
  const base =
    destination === null || destination === DEFAULT_PROTECTED_PATH
      ? SIGN_IN_PATH
      : `${SIGN_IN_PATH}?${DESTINATION_PARAMETER}=${encodeURIComponent(destination)}`;
  return `${base}${base.includes("?") ? "&" : "?"}${EXPIRED_PARAMETER}=1`;
}
