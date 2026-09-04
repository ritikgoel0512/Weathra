"use client";

/**
 * The Forgot Password form — task 20.8.
 *
 * It asks Supabase Auth to send the recovery message (`resetPasswordForEmail`) and does nothing
 * else. Weathra mints no recovery token, stores none, and has no recovery table to leak: the
 * one-time token exists inside Supabase and travels only in the email.
 *
 * **The redirect goes through the existing callback.** `redirectTo` points at `/auth/confirm`
 * (task 20.6) with the recovery type named, so the returning link is completed by the same handler
 * that completes a verification link — one returning-link architecture, not two. The handler
 * validates the token server-side and lands the person on Reset Password with a session.
 *
 * **The answer is the same for an address with an account and one without.** That is the whole
 * requirement of `specs/authentication` here, and it is why the completion state is worded
 * conditionally, why a "no such user" refusal is recognised only in order to be ignored, and why
 * nothing about the submitted address is echoed back into the response. A screen that said "we
 * have sent you a link" would be telling a stranger which addresses have Weathra accounts.
 *
 * Nothing here logs, and nothing is written to storage.
 */

import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { Button, Input } from "@/components/ui";
import { looksLikeAnAddress } from "@/lib/auth/email";
import { AUTH_CONFIRM_PATH } from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import {
  RESET_REQUEST_FAILED,
  RESET_REQUEST_SENT,
  TOO_MANY_ATTEMPTS,
  isRateLimited,
  isUnknownAddress,
} from "./failures";

/**
 * Where the emailed link comes back to.
 *
 * Built from this page's own origin — never from anything a person typed — and naming the flow, so
 * the handler knows which one it is completing even in the form of the link that carries only an
 * authorization code.
 */
export function recoveryRedirectUrl(origin: string): string {
  return `${origin}${AUTH_CONFIRM_PATH}?type=recovery`;
}

export function ForgotPasswordForm(): ReactNode {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;

      const trimmed = email.trim();
      const invalid =
        trimmed.length === 0
          ? "Enter your email address."
          : looksLikeAnAddress(trimmed)
            ? undefined
            : "Enter a valid email address.";

      setFieldError(invalid);
      setFailure(null);
      // Nothing is sent for something that is not an address: the provider is never called, so
      // there is no request to rate-limit and nothing to answer about.
      if (invalid) return;

      setPending(true);
      try {
        const { error } = await supabaseBrowserClient().auth.resetPasswordForEmail(trimmed, {
          redirectTo: recoveryRedirectUrl(window.location.origin),
        });

        if (error && !isUnknownAddress(error)) {
          // A rate limit is not a disclosure: the provider applies it before it looks the address
          // up, so it says nothing about whether an account exists.
          setFailure(isRateLimited(error) ? TOO_MANY_ATTEMPTS : RESET_REQUEST_FAILED);
          setPending(false);
          return;
        }

        // The same completion for a known address, an unknown one, and a refusal that would have
        // told them apart — which is what makes the three indistinguishable.
        setSent(true);
        setPending(false);
      } catch {
        // A transport failure, and still not a place to say anything about the address.
        setFailure(RESET_REQUEST_FAILED);
        setPending(false);
      }
    },
    [email, pending],
  );

  if (sent) {
    return (
      <div className={styles.form}>
        <div className={styles.success} role="status" aria-live="polite">
          <p className={styles.successTitle}>Check your email</p>
          <p>{RESET_REQUEST_SENT}</p>
        </div>

        <Button
          variant="secondary"
          fullWidth
          autoFocus
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
        >
          Use a different address
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

      <Input
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        autoFocus
        required
        value={email}
        error={fieldError}
        disabled={pending}
        description="We will send a link to this address if it has a Weathra account."
        onChange={(event) => setEmail(event.target.value)}
      />

      <Button type="submit" variant="primary" fullWidth busy={pending}>
        {pending ? "Sending reset link…" : "Send reset link"}
      </Button>
    </form>
  );
}
