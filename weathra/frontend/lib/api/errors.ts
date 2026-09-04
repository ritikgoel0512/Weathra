/**
 * The error codes the frontend has to recognise by name.
 *
 * Codes are the stable half of the backend's error contract (design.md decision 16) — the message
 * is written for a person and may be reworded, the code is what a client branches on. Almost
 * nothing in the frontend needs to branch: it shows the backend's message and offers a retry. Two
 * cases are different, and both change what *screen* a person sees rather than what text appears
 * on it.
 *
 * These lists mirror `weathra/domain/errors.py`, and
 * `backend/tests/test_frontend_error_codes.py` fails if the backend grows an authentication code
 * this file does not name — so the mirror cannot rot silently, which is the usual fate of a copied
 * list.
 */

/**
 * Every code that means "there is no valid session", including the ones that arrive mid-stream.
 *
 * `specs/web-ui` requires these to produce the expired-session state and a return to sign-in, and
 * specifically *not* to be shown as a data or server error. The stream's terminal error event
 * carries the same codes the REST endpoints do, so one list serves both.
 */
export const AUTHENTICATION_ERROR_CODES: readonly string[] = [
  "authentication_failed",
  "token_missing",
  "token_malformed",
  "token_expired",
  "token_signature_invalid",
  "token_issuer_invalid",
  "token_audience_invalid",
  "token_unknown_key",
  "email_not_verified",
];

/**
 * The agent surface has no inference credential configured.
 *
 * The Analyst states that it is unavailable and names the missing configuration; every other
 * screen stays fully usable, which is the property the backend is built to preserve.
 */
export const AGENT_NOT_CONFIGURED_CODE = "agent_not_configured";

/**
 * No evidence record with that identifier — for this caller.
 *
 * The backend answers an unknown identifier and one belonging to another user with this same code,
 * message and status, deliberately and byte for byte, so the endpoint cannot be used to discover
 * which record identifiers exist. Agent Evidence branches on it only to choose *which state* to
 * render — a decision that cannot be retried, rather than a failure that can — and never to tell
 * the two cases apart, because nothing in the response tells them apart.
 */
export const EVIDENCE_NOT_FOUND_CODE = "evidence_not_found";

/** Whether a code means the session is gone. */
export function isAuthenticationCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && AUTHENTICATION_ERROR_CODES.includes(code);
}
