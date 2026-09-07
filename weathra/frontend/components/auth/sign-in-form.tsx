"use client";

/**
 * The Sign In form — task 20.7.
 *
 * Supabase Auth is the sole identity provider, and this calls it through the existing
 * `@supabase/ssr` browser client, which stores the session in **cookies** rather than
 * `localStorage` (design.md decision 18) — so the middleware and every server component can see it
 * on the very next request. That is why the navigation after a successful sign-in is
 * `router.replace` followed by `router.refresh()`: the replace moves the person, and the refresh
 * makes the server re-render with the session that now exists. Without the refresh the protected
 * layout would resolve the *previous* request's cookies and bounce them straight back here.
 *
 * Three behaviours here are requirements, not choices:
 *
 * **The failure message is the same for an unknown address and a wrong password.** `specs/authentication`
 * requires it, and the reason is that a distinguishable failure turns this form into an
 * account-existence oracle. Supabase's own message is never shown: it is an internal detail, and
 * some of its variants disclose exactly what this must not.
 *
 * **An unverified account is routed to verification, not signed in.** With email confirmation
 * required on the project, Supabase refuses the sign-in — so the refusal is what identifies the
 * case. The check on `email_confirmed_at` afterwards is defence in depth: if a session ever
 * arrives for an unconfirmed address, it is discarded rather than used, because
 * `specs/authentication` says an unverified account never gets a session usable against protected
 * features.
 *
 * **The destination is re-validated before it is used.** It arrives already checked from the
 * server component, and is checked again here — an open redirect handed out by the screen people
 * are told to trust with their password is the one bug worth checking twice.
 *
 * Nothing here logs. Not the password, not the session, not the provider's error.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { EyeIcon } from "@/components/shell/icons";
import { Button, Input } from "@/components/ui";
import {
  DEFAULT_PROTECTED_PATH,
  FORGOT_PASSWORD_PATH,
  VERIFY_EMAIL_PATH,
  safeDestination,
} from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import { SIGN_IN_FAILED, TOO_MANY_ATTEMPTS, isRateLimited, isUnverified } from "./failures";

import { AUTH_FIXTURE, usingVisilyFixtures } from "@/lib/fixtures/visily";

import { FixtureRememberRow } from "./fixture-auth";

interface FieldErrors {
  readonly email?: string;
  readonly password?: string;
}

export interface SignInFormProps {
  /** Where to go on success, already validated server-side. Re-validated here regardless. */
  readonly destination?: string | null;
}

export function SignInForm({ destination }: SignInFormProps): ReactNode {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const target = useMemo(
    () => safeDestination(destination) ?? DEFAULT_PROTECTED_PATH,
    [destination],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;

      // Presence only. The password *rules* belong to Create Account and to password reset, where
      // they are stated before submission; asserting them here would reject a person whose real
      // password predates a rule change and tell them nothing useful.
      const errors: { email?: string; password?: string } = {};
      if (email.trim().length === 0) errors.email = "Enter your email address.";
      if (password.length === 0) errors.password = "Enter your password.";
      setFieldErrors(errors);
      setFailure(null);
      if (errors.email || errors.password) return;

      setPending(true);
      try {
        const { data, error } = await supabaseBrowserClient().auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (error) {
          if (isUnverified(error)) {
            router.replace(
              `${VERIFY_EMAIL_PATH}?email=${encodeURIComponent(email.trim())}`,
            );
            return;
          }
          setFailure(isRateLimited(error) ? TOO_MANY_ATTEMPTS : SIGN_IN_FAILED);
          setPending(false);
          return;
        }

        // Defence in depth: a session for an address the provider has not confirmed is not a
        // session Weathra uses. Discard it and send them to verification.
        if (data.user && !data.user.email_confirmed_at) {
          await supabaseBrowserClient().auth.signOut();
          router.replace(`${VERIFY_EMAIL_PATH}?email=${encodeURIComponent(email.trim())}`);
          return;
        }

        if (!data.session) {
          setFailure(SIGN_IN_FAILED);
          setPending(false);
          return;
        }

        router.replace(target);
        // The session now exists in cookies; this is what makes the server see it.
        router.refresh();
      } catch {
        // A transport failure, not a credential judgement — and still not a place to say anything
        // about the account.
        setFailure(SIGN_IN_FAILED);
        setPending(false);
      }
    },
    [email, password, pending, router, target],
  );

  /* Fixed when the bundle is built, and always false in a deployed one. The form's behaviour is
   * identical either way; only its copy and one disabled control differ. */
  const fidelity = usingVisilyFixtures();

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
        /* The artifact prints a sample address in the field. Placeholder only — nothing prefilled. */
        placeholder={fidelity ? AUTH_FIXTURE.emailPlaceholder : undefined}
        autoComplete="email"
        inputMode="email"
        autoFocus
        required
        value={email}
        error={fieldErrors.email}
        disabled={pending}
        onChange={(event) => setEmail(event.target.value)}
      />

      <Input
        label="Password"
        type={passwordVisible ? "text" : "password"}
        name="password"
        /* The artifact draws the field with a masked value in it. Placeholder only. */
        placeholder={fidelity ? "••••••••" : undefined}
        autoComplete="current-password"
        required
        value={password}
        error={fieldErrors.password}
        disabled={pending}
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

      {/*
        The artifact puts a remember-me checkbox opposite the forgotten-password link. Weathra has
        no remember-me, so in fixture mode the box is rendered disabled beside the real link, and in
        production the link stands alone as it always has. One link either way.
      */}
      {fidelity ? (
        <FixtureRememberRow>
          <Link className={styles.link} href={FORGOT_PASSWORD_PATH}>
            {AUTH_FIXTURE.forgot}
          </Link>
        </FixtureRememberRow>
      ) : (
        <div className={styles.aside}>
          <Link className={styles.link} href={FORGOT_PASSWORD_PATH}>
            Forgot password?
          </Link>
        </div>
      )}

      <Button type="submit" variant="primary" fullWidth busy={pending}>
        {pending ? "Signing in…" : fidelity ? AUTH_FIXTURE.submit : "Sign in"}
      </Button>
    </form>
  );
}
