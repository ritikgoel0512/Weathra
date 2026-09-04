/**
 * What Weathra says when the identity provider refuses, and how it reads the refusal.
 *
 * Shared by every authentication screen deliberately. The non-disclosure rules are the kind of
 * logic that must not exist in two copies: a second implementation is a second chance to leak
 * whether an account exists, and the leak would be in whichever copy nobody reviewed.
 *
 * **The provider's own message is never shown.** Supabase's text is an internal detail, it changes
 * between versions, and some variants say exactly what `specs/authentication` forbids saying.
 */

/** A refusal from Supabase Auth, read structurally so a shape change degrades rather than throws. */
export interface ProviderFailure {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}

/**
 * The one thing a failed sign-in says.
 *
 * Not "that password is wrong" and not "we have no account for that address": both are true
 * statements that tell an attacker which half to keep.
 */
export const SIGN_IN_FAILED = "We could not sign you in. Check your email and password, then try again.";

/** The one thing a failed account creation says, for anything that is not a stated rule. */
export const SIGN_UP_FAILED = "We could not create your account just now. Try again in a moment.";

/**
 * Said instead when the provider refuses for rate limiting.
 *
 * Distinguishing this is not a disclosure — it says nothing about whether an account exists — and
 * conflating it with a credential failure would tell a person their password is wrong when it is
 * not.
 */
export const TOO_MANY_ATTEMPTS = "Too many attempts just now. Wait a moment, then try again.";

/** Whether the refusal is "this address has not been confirmed". */
export function isUnverified(failure: ProviderFailure): boolean {
  if (failure.code === "email_not_confirmed") return true;
  // The code is the reliable signal; the message is a fallback for a gateway that omits it.
  return /email not confirmed/i.test(failure.message ?? "");
}

/** Whether the refusal is a rate limit rather than a judgement about the credentials. */
export function isRateLimited(failure: ProviderFailure): boolean {
  return failure.code === "over_request_rate_limit" || failure.status === 429;
}

/**
 * Whether the refusal is "that address already has an account".
 *
 * Recognised in order to be *ignored*. With confirmations required, recent versions of the provider
 * already return a look-alike response rather than an error, so this is the path for a project
 * where that obfuscation is off — and the answer either way is the same response a new address
 * gets. See `components/auth/create-account-form.tsx`.
 */
export function isAlreadyRegistered(failure: ProviderFailure): boolean {
  if (failure.code === "user_already_exists" || failure.code === "email_exists") return true;
  return /already (registered|exists)|user already/i.test(failure.message ?? "");
}

/**
 * Whether the provider rejected the password itself.
 *
 * Reaching this means the provider's policy is stricter than the rules this application stated
 * before submission, which is a configuration mismatch rather than something a person did wrong —
 * so the screen answers with *Weathra's* stated rule rather than the provider's message.
 */
export function isWeakPassword(failure: ProviderFailure): boolean {
  return failure.code === "weak_password" || /password/i.test(failure.message ?? "");
}

/* -------------------------------------------------------------------------------------------- *
 * Verification — task 20.5
 * -------------------------------------------------------------------------------------------- */

/** The one thing a failed verification says when the cause is not the code itself. */
export const VERIFICATION_FAILED = "We could not verify your email just now. Try again in a moment.";

/**
 * The incorrect-code state.
 *
 * It points at the resend as well as at a retry, because the provider's merged refusal means a
 * genuinely stale code can land here — see `VERIFICATION_CODE_LIFETIME_MS`.
 */
export const CODE_INCORRECT =
  "That code is not right. Check the code in your email and try again, or ask for a new one.";

/** The expired-code state, deliberately worded so it cannot be mistaken for the incorrect one. */
export const CODE_EXPIRED =
  "That code has expired. Ask for a new code, then enter the one from the newest email.";

/** The one thing a failed resend says when the cause is not a rate limit. */
export const RESEND_FAILED = "We could not send a new code just now. Try again in a moment.";

/** Confirmation that a new code is on its way. Says nothing about whether an account exists. */
export const RESEND_CONFIRMED = "If that address needs verifying, a new code is on its way.";

/** A returning verification link that the provider refused, in the two forms it refuses it. */
export const LINK_EXPIRED =
  "That verification link has expired. Enter the code from your email, or ask for a new one.";
export const LINK_INVALID =
  "That verification link is no longer valid — it may have already been used. Enter the code from your email, or ask for a new one.";

/**
 * Whether the refusal is the provider's "expired or invalid" answer about a one-time code.
 *
 * GoTrue gives *one* code for both, which is why this is a single predicate rather than two, and
 * why `classifyCodeFailure` needs a second input to split it.
 */
export function isExpiredOrUnknownCode(failure: ProviderFailure): boolean {
  if (failure.code === "otp_expired" || failure.code === "expired_token") return true;
  return /expired or is invalid|token has expired/i.test(failure.message ?? "");
}

/** How a refusal about a submitted code is presented. */
export type CodeFailureKind = "incorrect" | "expired" | "rate_limited" | "unavailable";

/**
 * Read a refusal about a submitted code.
 *
 * `sentAt` is when the code being entered was sent and `now` is the moment of the refusal; together
 * with the provider's merged signal they are what separates "expired" from "incorrect". Passing
 * both in rather than reading the clock here keeps this a function of its arguments.
 */
export function classifyCodeFailure(
  failure: ProviderFailure,
  { sentAt, now, lifetimeMs }: { sentAt: number; now: number; lifetimeMs: number },
): CodeFailureKind {
  if (isRateLimited(failure)) return "rate_limited";
  // A refusal that is *not* about the code — a malformed request, a provider outage — is never
  // reported as a judgement about what the person typed.
  if (failure.status !== undefined && failure.status >= 500) return "unavailable";
  if (!isExpiredOrUnknownCode(failure)) return "incorrect";
  return now - sentAt >= lifetimeMs ? "expired" : "incorrect";
}

/**
 * The wait a rate-limited resend must state, in seconds, or null when the provider did not say.
 *
 * Only the *number* is taken from the provider's message. Its wording is never shown: it is an
 * internal detail that changes between versions, and the screen says the wait in Weathra's words.
 */
export function resendWaitSeconds(failure: ProviderFailure): number | null {
  const match = /(\d+)\s*second/i.exec(failure.message ?? "");
  if (!match) return null;
  const seconds = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The rate-limited resend state, stating how long to wait when the provider said how long. */
export function resendRateLimitedMessage(seconds: number | null): string {
  if (seconds === null) return "Too many requests just now. Wait a moment, then ask for a new code.";
  const unit = seconds === 1 ? "second" : "seconds";
  return `Too many requests. You can ask for a new code in ${seconds} ${unit}.`;
}

/* -------------------------------------------------------------------------------------------- *
 * Password recovery — task 20.8
 * -------------------------------------------------------------------------------------------- */

/**
 * The one thing a reset request says — for an address with an account and for one without.
 *
 * `specs/authentication`: "a reset request for an unknown address SHALL behave identically to one
 * for a known address". Conditional wording is what makes that true *and* honest: it promises
 * nothing about an address it will not confirm the existence of.
 */
export const RESET_REQUEST_SENT =
  "If that address has a Weathra account, a reset link is on its way. Check your email.";

/** The one thing a failed reset request says, when the cause is not a rate limit. */
export const RESET_REQUEST_FAILED = "We could not send a reset link just now. Try again in a moment.";

/** The expired reset, worded so it cannot be mistaken for a link that never worked. */
export const RECOVERY_EXPIRED =
  "That reset link has expired. Request a new one and use the link in the newest email.";

/** A reset link the provider refused for any other reason — most often one already used. */
export const RECOVERY_INVALID =
  "That reset link is no longer valid — it may have already been used. Request a new one.";

/** No recovery session at all: a bookmark, a typed address, or a tab left open too long. */
export const RECOVERY_MISSING =
  "This page needs an active reset link. Request one and follow it from your email.";

/** The one thing a failed password update says, when the cause is not a stated rule. */
export const PASSWORD_UPDATE_FAILED =
  "We could not update your password just now. Try again in a moment.";

/** The confirmation field's own complaint. Not a rule about the password — a rule about the pair. */
export const PASSWORD_MISMATCH = "The two passwords do not match.";

/**
 * Whether the refusal is "there is no account for that address".
 *
 * Recognised in order to be **ignored**. The provider answers a reset request for an unknown
 * address with a success in every configuration Weathra supports, so this is the path for one where
 * that is switched off — and the answer either way is the response a known address gets. Exactly
 * the treatment `isAlreadyRegistered` gets on Create Account, for exactly the same reason.
 */
export function isUnknownAddress(failure: ProviderFailure): boolean {
  if (failure.code === "user_not_found" || failure.status === 404) return true;
  return /user not found|no user/i.test(failure.message ?? "");
}

/**
 * Whether the refusal means the session doing the asking is gone.
 *
 * On Reset Password this is the recovery session having expired between following the link and
 * submitting the new password — an expired reset arriving late, which is shown as an expired reset
 * rather than as a failure to update.
 */
export function isSessionGone(failure: ProviderFailure): boolean {
  if (failure.code === "session_not_found" || failure.code === "refresh_token_not_found") return true;
  if (failure.status === 401 || failure.status === 403) return true;
  return /auth session missing|session (not found|expired)/i.test(failure.message ?? "");
}

/** Whether the provider refused because the new password is the one already in force. */
export function isSamePassword(failure: ProviderFailure): boolean {
  return failure.code === "same_password";
}
