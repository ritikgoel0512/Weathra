"use client";

/**
 * The Reset Password form — task 20.8.
 *
 * Reached only from a returning recovery link: `/auth/confirm` (task 20.6) validates the one-time
 * token with Supabase, establishes the session, and lands the person here. The page above this form
 * resolves that session **server-side** before rendering it, so by the time this component exists,
 * Supabase has already said there is somebody to change a password for. There is no client-side
 * "recovery authorised" flag, and no query parameter grants anything — a marker in the URL only
 * decides whether the route gate leaves a person on this screen, never whether the update is
 * allowed.
 *
 * **The password rules are the same ones.** `lib/auth/password.ts` is the single policy, stated
 * here by the same `PasswordRules` checklist Create Account states, and a rejected password names
 * the rule it failed. There is no second policy and no second copy of the list.
 *
 * **A submission that fails a rule never reaches the provider.** Nothing is sent, so there is
 * nothing to undo — and the confirmation field is checked against the first before either is used.
 *
 * **Success is what Supabase says it is.** The success state appears after `updateUser` returns
 * without an error, never before, and the form is gone by then — a recovery that has been spent
 * cannot be spent again from this screen. A session that has expired between following the link and
 * submitting is reported as an *expired reset*, with the way to request another, rather than as a
 * failure to update.
 *
 * Nothing here logs. Not the password, not the confirmation, not the session, not the provider's
 * error.
 */

import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { EyeIcon } from "@/components/shell/icons";
import { Button, Input } from "@/components/ui";
import { passwordFailureMessage } from "@/lib/auth/password";
import { DEFAULT_PROTECTED_PATH, safeDestination } from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import {
  PASSWORD_MISMATCH,
  PASSWORD_UPDATE_FAILED,
  TOO_MANY_ATTEMPTS,
  isRateLimited,
  isSamePassword,
  isSessionGone,
} from "./failures";
import { PasswordRules } from "./password-rules";
import { RecoveryUnavailable } from "./recovery-unavailable";

export interface ResetPasswordFormProps {
  /**
   * The address the recovery session belongs to, read from Supabase by the page — not from the URL.
   * It is what the "not your email address" rule is checked against.
   */
  readonly email?: string | null;
  /** Where to go afterwards, already validated server-side. Re-validated here regardless. */
  readonly destination?: string | null;
}

interface FieldErrors {
  readonly password?: string;
  readonly confirmation?: string;
}

export function ResetPasswordForm({ email, destination }: ResetPasswordFormProps): ReactNode {
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [recoveryGone, setRecoveryGone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const target = safeDestination(destination) ?? DEFAULT_PROTECTED_PATH;

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;

      const errors: { password?: string; confirmation?: string } = {};
      if (password.length === 0) errors.password = "Choose a new password.";
      else errors.password = passwordFailureMessage(password, email ?? undefined);

      if (confirmation.length === 0) errors.confirmation = "Repeat your new password.";
      else if (confirmation !== password) errors.confirmation = PASSWORD_MISMATCH;

      setFieldErrors(errors);
      setFailure(null);
      // The existing password stays in force: the provider is never called for a password that
      // fails a stated rule, or for a pair that does not match.
      if (errors.password || errors.confirmation) return;

      setPending(true);
      try {
        const { error } = await supabaseBrowserClient().auth.updateUser({ password });

        if (error) {
          if (isSessionGone(error)) {
            // The reset expired between following the link and submitting it. That is an expired
            // reset, and it gets the expired-reset state rather than a generic failure.
            setRecoveryGone(true);
          } else if (isRateLimited(error)) {
            setFailure(TOO_MANY_ATTEMPTS);
          } else if (isSamePassword(error)) {
            setFieldErrors({ password: "Choose a password different from your current one." });
          } else {
            setFailure(PASSWORD_UPDATE_FAILED);
          }
          setPending(false);
          return;
        }

        setUpdated(true);
        setPending(false);
      } catch {
        // A transport failure, not a judgement about the password.
        setFailure(PASSWORD_UPDATE_FAILED);
        setPending(false);
      }
    },
    [confirmation, email, password, pending],
  );

  const onContinue = useCallback(() => {
    router.replace(target);
    // The session lives in cookies; this is what makes the server see it.
    router.refresh();
  }, [router, target]);

  // Arrived valid, then went stale. Same state, same way forward as a link that was expired on
  // arrival — and the form is gone, so the spent recovery cannot be submitted again.
  if (recoveryGone) return <RecoveryUnavailable problem="expired" />;

  if (updated) {
    return (
      <div className={styles.form}>
        <div className={styles.success} role="status" aria-live="polite">
          <p className={styles.successTitle}>Password updated</p>
          <p>Your new password is in force. You are signed in.</p>
        </div>
        <Button variant="primary" fullWidth autoFocus onClick={onContinue}>
          Continue to Weathra
        </Button>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      {failure ? (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      ) : null}

      <div className={styles.passwordGroup}>
        <Input
          label="New password"
          type={passwordVisible ? "text" : "password"}
          name="password"
          autoComplete="new-password"
          autoFocus
          required
          value={password}
          error={fieldErrors.password}
          disabled={pending}
          description="Checked against the rules below before your password is changed."
          onChange={(event) => setPassword(event.target.value)}
          trailing={
            <button
              type="button"
              className={styles.reveal}
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              <EyeIcon off={passwordVisible} />
            </button>
          }
        />

        <PasswordRules password={password} email={email ?? undefined} />
      </div>

      <Input
        label="Confirm new password"
        type={passwordVisible ? "text" : "password"}
        name="confirmation"
        autoComplete="new-password"
        required
        value={confirmation}
        error={fieldErrors.confirmation}
        disabled={pending}
        onChange={(event) => setConfirmation(event.target.value)}
      />

      <Button type="submit" variant="primary" fullWidth busy={pending}>
        {pending ? "Updating your password…" : "Reset password"}
      </Button>
    </form>
  );
}
