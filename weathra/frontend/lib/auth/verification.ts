/**
 * The verification rules that are pure — the code's shape, its lifetime, and what a returning
 * verification link says when it comes back refused.
 *
 * Nothing here talks to Supabase and nothing here decides that anybody is verified. Verification is
 * a fact held by Supabase Auth and read back from the session it issues (`specs/authentication`);
 * this module only formats what a person types and reads what the provider put in a URL.
 *
 * There is no local "verified" flag, no verification token, and no verification store. Weathra has
 * no verification mechanism of its own to have a bug in.
 */

/** Supabase's email one-time codes are six digits. `{{ .Token }}` in the *Confirm signup* template. */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * How long a code stays usable, mirroring the project's **Email OTP Expiration** setting.
 *
 * This is a *presentation* constant, not an enforcement one — the provider decides whether a code
 * is still good, and this value never shortens or extends that. It exists because of a wrinkle in
 * what the provider tells us: GoTrue answers an unknown code and a stale code with the *same*
 * refusal ("expired or invalid", `otp_expired`), and `specs/authentication` requires the
 * incorrect-code and expired-code states to be distinguishable. So when the merged refusal arrives,
 * the screen splits it on how long ago the code being entered was sent — which it knows, because it
 * either sent it (the resend action) or the person arrived here directly from creating the account.
 *
 * The residual case is somebody returning to a tab hours later: their genuinely expired code reads
 * as incorrect. That is why the incorrect-code wording also points at the resend, and why the resend
 * control is present in every state rather than only in the expired one.
 *
 * Keep this in step with the Supabase project setting; a mismatch costs nothing but wording.
 */
export const VERIFICATION_CODE_LIFETIME_MS = 60 * 60 * 1000;

/**
 * The verification link types this application will act on.
 *
 * An allow-list, because the `type` in a returning URL is attacker-supplied like any other query
 * parameter: handing it to the provider unchecked would let a link ask this screen to complete a
 * *recovery* or an *email change* under the wording of email confirmation.
 */
export const VERIFICATION_LINK_TYPES = ["signup", "email"] as const;

export type VerificationLinkType = (typeof VERIFICATION_LINK_TYPES)[number];

/** The link type if it is one this screen completes, otherwise null. */
export function verificationLinkType(value: string | null | undefined): VerificationLinkType | null {
  return VERIFICATION_LINK_TYPES.includes(value as VerificationLinkType)
    ? (value as VerificationLinkType)
    : null;
}

/**
 * What a person typed, reduced to what a code can be.
 *
 * Digits only, capped at the code length — so a pasted "123 456", a copied "Code: 123456", and a
 * fat-fingered seventh digit all become the same six characters instead of a rejection.
 */
export function normalizeVerificationCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, VERIFICATION_CODE_LENGTH);
}

/** The rule the code entry states up front, and names when it is not met. */
export const VERIFICATION_CODE_RULE = `Enter the ${VERIFICATION_CODE_LENGTH}-digit code from the email.`;

/** The complaint about the code's *shape*, before the provider is troubled with it. */
export function verificationCodeFormatError(code: string): string | undefined {
  if (code.length === 0) return VERIFICATION_CODE_RULE;
  if (code.length < VERIFICATION_CODE_LENGTH) {
    return `The code is ${VERIFICATION_CODE_LENGTH} digits. Check the email and enter all of them.`;
  }
  return undefined;
}

/**
 * The link types the **callback handler** will complete — task 20.6.
 *
 * Wider than `VERIFICATION_LINK_TYPES` by exactly one: the same handler completes the returning
 * password-recovery link, because there is one returning-link architecture rather than two. Still
 * an allow-list, and still for the same reason — the `type` in a returning URL is attacker-supplied
 * like any other query parameter, and an unchecked one would let a link choose which flow the
 * handler thinks it is finishing.
 */
export const CALLBACK_LINK_TYPES = ["signup", "email", "recovery"] as const;

export type CallbackLinkType = (typeof CALLBACK_LINK_TYPES)[number];

/** The callback link type if it is one the handler completes, otherwise null. */
export function callbackLinkType(value: string | null | undefined): CallbackLinkType | null {
  return CALLBACK_LINK_TYPES.includes(value as CallbackLinkType)
    ? (value as CallbackLinkType)
    : null;
}

/** Whether a returning link is the password-recovery one rather than an email confirmation. */
export function isRecoveryLink(type: CallbackLinkType | null): boolean {
  return type === "recovery";
}

/**
 * Whether Supabase says this address is confirmed.
 *
 * The *only* definition of verified anywhere in the frontend. Both the screen and the returning-link
 * handler read it from the user Supabase returned; neither keeps a flag of its own, so there is one
 * place this can be wrong rather than two.
 */
export function isConfirmedUser(
  user: { email_confirmed_at?: string | null; confirmed_at?: string | null } | null | undefined,
): boolean {
  return Boolean(user?.email_confirmed_at ?? user?.confirmed_at);
}

/**
 * The refusal a callback puts in the URL when it sends somebody back to a screen.
 *
 * Weathra's own values, chosen so `readLinkRefusal` reads them back — never the provider's message,
 * its status, or its error identifier.
 */
export const LINK_REFUSAL_PARAMETERS: Readonly<Record<LinkRefusal, Readonly<Record<string, string>>>> = {
  expired: { error: "access_denied", error_code: "otp_expired" },
  invalid: { error: "access_denied", error_code: "invalid_link" },
};

/** How a returning verification link came back when it did not come back good. */
export type LinkRefusal = "expired" | "invalid";

/**
 * The refusal Supabase reports by redirecting back with it, read from a URL's parameters.
 *
 * Both the query string and the fragment are read by the caller and passed here as the same shape:
 * the provider uses one or the other depending on the flow, and which one it happened to use is not
 * a distinction this screen should care about.
 */
export function readLinkRefusal(parameters: URLSearchParams): LinkRefusal | null {
  const code = parameters.get("error_code");
  const error = parameters.get("error");
  if (!code && !error) return null;
  if (code === "otp_expired" || code === "expired_token") return "expired";
  return "invalid";
}
