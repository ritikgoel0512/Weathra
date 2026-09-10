"use client";

/**
 * The Create Account form — task 20.4.
 *
 * Supabase Auth is the sole identity provider; this calls `signUp` through the existing
 * `@supabase/ssr` browser client. Weathra creates no account of its own, hashes nothing, stores no
 * password material, and issues no token.
 *
 * Three behaviours are requirements rather than choices, and each is the reason a line of this file
 * looks the way it does:
 *
 * **The rules are stated before submission.** `lib/auth/password.ts` declares them once; the screen
 * lists them under the field, marks which are met as a person types, and — when a submission fails
 * one — names *that* rule. `specs/authentication` asks for exactly this, and the failure mode it is
 * avoiding is a password rejected after the fact by a rule nobody mentioned.
 *
 * **An already-registered address gets the response a new one gets.** Not "that address is taken".
 * Confirming that an address has a Weathra account tells a stranger something about a person who
 * did not choose to tell them, so the refusal is recognised and then deliberately ignored: the
 * screen routes to verification either way. Somebody who already has an account and typed the wrong
 * password is served by the sign-in and reset links, which is why both are on this screen
 * permanently rather than shown in response to anything.
 *
 * **Verification is mandatory and belongs to Supabase.** With confirmations required, `signUp`
 * returns no session, so there is nothing to sign in with — and if a session ever *does* come back
 * (a project with confirmations switched off), it is discarded rather than used. Nothing here marks
 * anybody verified, and there is no verification mechanism outside the provider's.
 *
 * Nothing here logs, and nothing is written to storage. The password lives in component state for
 * the life of the submission and nowhere else.
 */

import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { EyeIcon } from "@/components/shell/icons";
import { Button, Input } from "@/components/ui";
import { looksLikeAnAddress } from "@/lib/auth/email";
import { PASSWORD_MINIMUM_LENGTH, passwordFailureMessage } from "@/lib/auth/password";
import { CHOOSE_PLAN_PATH } from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import { PasswordRules } from "./password-rules";
import {
  SIGN_UP_FAILED,
  TOO_MANY_ATTEMPTS,
  isAlreadyRegistered,
  isRateLimited,
  isWeakPassword,
} from "./failures";

interface FieldErrors {
  readonly email?: string;
  readonly password?: string;
}

export function CreateAccountForm(): ReactNode {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;

      const trimmed = email.trim();
      const errors: { email?: string; password?: string } = {};
      if (trimmed.length === 0) errors.email = "Enter your email address.";
      else if (!looksLikeAnAddress(trimmed)) errors.email = "Enter a valid email address.";

      if (password.length === 0) errors.password = "Choose a password.";
      else errors.password = passwordFailureMessage(password, trimmed);

      setFieldErrors(errors);
      setFailure(null);
      // No account is created for a password that fails a stated rule: the provider is never
      // called, so there is nothing to undo and nothing to leak.
      if (errors.email || errors.password) return;

      setPending(true);
      try {
        const { data, error } = await supabaseBrowserClient().auth.signUp({
          email: trimmed,
          password,
        });

        if (error && !isAlreadyRegistered(error)) {
          if (isRateLimited(error)) {
            setFailure(TOO_MANY_ATTEMPTS);
          } else if (isWeakPassword(error)) {
            // The provider's policy is stricter than the rules this screen stated. Answer with
            // Weathra's own rule rather than the provider's wording, and treat it as a field
            // failure so it appears where the password is.
            setFieldErrors({
              password: `Choose a password of at least ${PASSWORD_MINIMUM_LENGTH} characters.`,
            });
          } else {
            setFailure(SIGN_UP_FAILED);
          }
          setPending(false);
          return;
        }

        // A session here means the project is not requiring confirmation. Discard it: an
        // unverified account never holds a session Weathra will use.
        if (data?.session) {
          await supabaseBrowserClient().auth.signOut();
        }

        // The same destination for a new address, an existing one, and an obfuscated look-alike
        // response — which is what makes the three indistinguishable.
        // The plan step, then verification. It is between the two because it needs no session —
        // everything on it is public — and because a tier is the thing somebody wants to know
        // about while they are still deciding, not after they have been sent to their inbox.
        router.replace(`${CHOOSE_PLAN_PATH}?email=${encodeURIComponent(trimmed)}`);
      } catch {
        // A transport failure, and still not a place to say anything about the address.
        setFailure(SIGN_UP_FAILED);
        setPending(false);
      }
    },
    [email, password, pending, router],
  );

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
        error={fieldErrors.email}
        disabled={pending}
        onChange={(event) => setEmail(event.target.value)}
      />

      <div className={styles.passwordGroup}>
        <Input
          label="Password"
          type={passwordVisible ? "text" : "password"}
          name="password"
          autoComplete="new-password"
          required
          value={password}
          error={fieldErrors.password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
          description="Checked against the rules below before your account is created."
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

        <PasswordRules password={password} email={email} />
      </div>

      <Button type="submit" variant="primary" fullWidth busy={pending}>
        {pending ? "Creating your account…" : "Create account"}
      </Button>
    </form>
  );
}
