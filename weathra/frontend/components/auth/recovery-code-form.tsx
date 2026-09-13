"use client";

/**
 * The recovery **code** entry — the second way into Reset Password.
 *
 * # Why this exists
 *
 * Recovery had exactly one entry: the link. `forgot-password` asked Supabase to send a recovery
 * message, `/auth/confirm` exchanged the token the link carried, and `/reset-password` rendered a
 * password form only once that exchange had produced a session. That is a complete flow *provided
 * the email carries a link*.
 *
 * Supabase's recovery template decides that, not Weathra: a template written with `{{ .Token }}`
 * sends a six-digit code and no link at all. Under that configuration every part of the flow above
 * still worked and the flow as a whole could not be completed — the person held a valid code and
 * the product had nowhere to type it, so `/reset-password` answered with "this page needs an active
 * reset link" no matter what they did. Verification already had both doors for this exact reason
 * (`verify-email-form.tsx`); recovery had one.
 *
 * So this is the missing door, and it is deliberately the *same* door: `verifyOtp` with
 * `type: "recovery"` establishes precisely the session the link would have established, and the
 * component then hands over to `ResetPasswordForm` — the same form, the same password policy, the
 * same success state. There is no second way to set a password, and nothing here is a second
 * authorisation: a typed code that Supabase refuses grants nothing, and the form that follows is
 * reached only once Supabase has returned a session for it.
 *
 * # What it does not do
 *
 * * **It does not decide that anybody may reset.** The code goes to the provider and the session
 *   comes back from the provider. No local flag stands in for either.
 * * **It does not confirm whether an address has an account.** The resend says "if that address has
 *   a Weathra account" for the same reason `RESET_REQUEST_SENT` does — `specs/authentication`
 *   requires a request for an unknown address to be indistinguishable from one for a known address.
 * * **It shows no provider wording.** Refusals are classified into Weathra's own sentences, exactly
 *   as the verification code entry classifies them.
 *
 * Nothing here logs. Not the code, not the address, not the session, not the provider's error.
 */

import Link from "next/link";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { Button, Input } from "@/components/ui";
import { looksLikeAnAddress } from "@/lib/auth/email";
import {
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_LIFETIME_MS,
  VERIFICATION_CODE_RULE,
  normalizeVerificationCode,
  verificationCodeFormatError,
} from "@/lib/auth/verification";
import { FORGOT_PASSWORD_PATH } from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import {
  CODE_EXPIRED,
  CODE_INCORRECT,
  RECOVERY_ADDRESS_UNKNOWN,
  RECOVERY_CODE_PROMPT,
  RECOVERY_RESEND_CONFIRMED,
  RESET_REQUEST_FAILED,
  TOO_MANY_ATTEMPTS,
  VERIFICATION_FAILED,
  classifyCodeFailure,
  resendRateLimitedMessage,
  resendWaitSeconds,
} from "./failures";
import { recoveryRedirectUrl } from "./forgot-password-form";
import { ResetPasswordForm } from "./reset-password-form";

export interface RecoveryCodeFormProps {
  /**
   * The address the reset was requested for, carried from Forgot Password through the URL and
   * already checked to look like an address. Editable when it is absent, because a person who
   * opened this screen from a bookmark still knows which account they are resetting.
   */
  readonly email?: string | null;
  /** Where to go after the password is set, already validated server-side. Re-validated there. */
  readonly destination?: string | null;
  /**
   * A refusal the returning link already produced, shown above the code entry rather than in place
   * of it: a link that expired and a code that still works arrive in the same email, so a refused
   * link is a reason to offer the other door, not to close both.
   */
  readonly initialProblem?: string | null;
}

type Pending = "code" | "resend" | null;

export function RecoveryCodeForm({
  email: initialEmail,
  destination,
  initialProblem,
}: RecoveryCodeFormProps): ReactNode {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<string | null>(initialProblem ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [sentAt, setSentAt] = useState(() => Date.now());

  /**
   * The address the recovery session belongs to, once one exists.
   *
   * Held separately from the field so the password rules are checked against the account actually
   * being changed, the way the link path checks them against the session Supabase returned.
   */
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending !== null) return;

      const address = email.trim();
      const addressProblem = looksLikeAnAddress(address)
        ? undefined
        : "Enter the email address you asked us to reset.";
      const shapeProblem = verificationCodeFormatError(code);

      setEmailError(addressProblem);
      setCodeError(shapeProblem);
      setFailure(null);
      setNotice(null);
      // Nothing is sent for an address that is not one, or a code that is not the right shape:
      // the provider is never asked to judge input the screen can already see is wrong.
      if (addressProblem || shapeProblem) return;

      setPending("code");
      try {
        const { data, error } = await supabaseBrowserClient().auth.verifyOtp({
          email: address,
          token: code,
          type: "recovery",
        });

        if (error) {
          const kind = classifyCodeFailure(error, {
            sentAt,
            now: Date.now(),
            lifetimeMs: VERIFICATION_CODE_LIFETIME_MS,
          });
          if (kind === "rate_limited") setFailure(TOO_MANY_ATTEMPTS);
          else if (kind === "unavailable") setFailure(VERIFICATION_FAILED);
          else setCodeError(kind === "expired" ? CODE_EXPIRED : CODE_INCORRECT);
          setPending(null);
          return;
        }

        // A code the provider accepted without returning a session is not a reset that can proceed.
        if (!data?.session) {
          setFailure(VERIFICATION_FAILED);
          setPending(null);
          return;
        }

        setVerifiedEmail(data.user?.email ?? address);
        setPending(null);
      } catch {
        // A transport failure, not a judgement about the code.
        setFailure(VERIFICATION_FAILED);
        setPending(null);
      }
    },
    [code, email, pending, sentAt],
  );

  const onResend = useCallback(async () => {
    if (pending !== null) return;

    const address = email.trim();
    if (!looksLikeAnAddress(address)) {
      setEmailError("Enter the email address you asked us to reset.");
      return;
    }

    setEmailError(undefined);
    setFailure(null);
    setNotice(null);
    setPending("resend");
    try {
      // The same request Forgot Password makes, through the same redirect, so whichever of the two
      // the template sends — a code or a link — the new email is the one this screen expects.
      const { error } = await supabaseBrowserClient().auth.resetPasswordForEmail(address, {
        redirectTo: recoveryRedirectUrl(window.location.origin),
      });

      if (error) {
        setFailure(
          resendWaitSeconds(error) !== null || error.status === 429
            ? resendRateLimitedMessage(resendWaitSeconds(error))
            : RESET_REQUEST_FAILED,
        );
        setPending(null);
        return;
      }

      // The code being entered is now the new one, so the expiry window restarts with it.
      setSentAt(Date.now());
      setCode("");
      setCodeError(undefined);
      setNotice(RECOVERY_RESEND_CONFIRMED);
      setPending(null);
    } catch {
      setFailure(RESET_REQUEST_FAILED);
      setPending(null);
    }
  }, [email, pending]);

  // The code was accepted and Supabase issued the recovery session. From here it is the ordinary
  // Reset Password form — the same one the link path reaches, with the same policy and success.
  if (verifiedEmail !== null) {
    return <ResetPasswordForm email={verifiedEmail} destination={destination} />;
  }

  return (
    <div className={styles.form}>
      {failure ? (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      ) : null}

      {notice ? (
        <p className={styles.notice} role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <p className={styles.notice}>
        {initialEmail ? (
          <>
            We sent a reset code to{" "}
            <strong className={styles.noticeStrong}>{initialEmail}</strong>.{" "}
            {RECOVERY_CODE_PROMPT}
          </>
        ) : (
          RECOVERY_ADDRESS_UNKNOWN
        )}
      </p>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {/*
          Shown even when the address arrived in the URL: `verifyOtp` for a recovery code needs the
          address alongside the code, and a person who mistyped it at Forgot Password would
          otherwise have no way to correct it without starting again.
        */}
        <Input
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          error={emailError}
          disabled={pending !== null}
          onChange={(event) => setEmail(event.target.value)}
        />

        <Input
          label="Reset code"
          name="code"
          // A numeric keypad on a phone, and the browser's own one-time-code autofill.
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={VERIFICATION_CODE_LENGTH}
          autoFocus={Boolean(initialEmail)}
          required
          value={code}
          error={codeError}
          description={VERIFICATION_CODE_RULE}
          disabled={pending !== null}
          onChange={(event) => setCode(normalizeVerificationCode(event.target.value))}
        />

        <Button
          type="submit"
          variant="primary"
          fullWidth
          busy={pending === "code"}
          disabled={pending !== null}
        >
          {pending === "code" ? "Checking your code…" : "Continue"}
        </Button>
      </form>

      <div className={styles.resend}>
        <span>Didn&rsquo;t get the email?</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onResend}
          busy={pending === "resend"}
          disabled={pending !== null}
        >
          {pending === "resend" ? "Sending…" : "Resend code"}
        </Button>
      </div>

      <p className={styles.aside}>
        <Link className={styles.link} href={FORGOT_PASSWORD_PATH}>
          Start again with a different address
        </Link>
      </p>
    </div>
  );
}
