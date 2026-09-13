/**
 * `/reset-password` — where recovery ends, by either of its two doors.
 *
 * A server component, and its one job before rendering is the question that decides everything on
 * this screen: **is there a recovery session?** `currentUser()` asks Supabase — it validates the
 * session's token with the provider rather than reading what a cookie decodes to — and only an
 * answer of "yes" produces a form that can change a password.
 *
 * An answer of "no" used to end the flow, and that was the bug: Supabase's recovery template
 * decides whether the email carries a `{{ .ConfirmationURL }}` link or a six-digit `{{ .Token }}`,
 * and under a code-only template no link ever arrives to create the session this page insisted on.
 * Recovery was unfinishable — the person held a valid code and the product had nowhere to type it.
 * So "no session" now renders the code entry (`RecoveryCodeForm`), which calls `verifyOtp` with
 * `type: "recovery"` to establish the very session the link would have established and then hands
 * over to the same password form. Two doors, one room: there is no second way to set a password.
 *
 * That ordering is the security property. The URL carries a marker saying which flow completed
 * (task 20.6) and may carry a refusal the provider reported, but neither *grants* anything: the
 * marker's only power is over `middleware.ts`, which uses it to decide whether an authenticated
 * person is left on this authentication screen instead of being sent into the product. A person
 * arriving with the marker and no session gets the same screen as one arriving with nothing.
 *
 * The address the rules are checked against comes from the session Supabase returned, never from
 * the query string — so "not your email address" is checked against the account actually being
 * changed.
 *
 * The Forgot Password screen requests the email; `/auth/confirm` completes the link. Neither is
 * here, and neither *grants* anything — the session comes from the provider on both paths.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { RECOVERY_EXPIRED, RECOVERY_INVALID } from "@/components/auth/failures";
import { RecoveryCodeForm } from "@/components/auth/recovery-code-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import styles from "@/components/auth/auth.module.css";
import { looksLikeAnAddress } from "@/lib/auth/email";
import { readLinkRefusal } from "@/lib/auth/verification";
import { DESTINATION_PARAMETER, SIGN_IN_PATH, safeDestination } from "@/lib/routes";
import { currentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set a new password" };

type SearchParameters = Record<string, string | string[] | undefined>;

/** A query parameter as one value: a repeated parameter is read as its first occurrence. */
function one(parameters: SearchParameters, name: string): string | undefined {
  const value = parameters[name];
  return Array.isArray(value) ? value[0] : value;
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  readonly searchParams?: Promise<SearchParameters>;
}): Promise<ReactNode> {
  const parameters = (await searchParams) ?? {};

  const refusal = readLinkRefusal(
    new URLSearchParams(
      Object.entries(parameters).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value] as [string, string]] : [],
      ),
    ),
  );

  // The callback already told us the link failed; there is no session to look for.
  const user = refusal ? null : await currentUser();

  const destination = safeDestination(one(parameters, DESTINATION_PARAMETER));

  /*
   * The address the reset was requested for, carried here by Forgot Password.
   *
   * Checked rather than trusted, exactly as Verify Email checks the same parameter: it is echoed
   * into the page and handed to the provider alongside the code, and it arrived from outside.
   */
  const candidate = one(parameters, "email")?.trim();
  const email = candidate && looksLikeAnAddress(candidate) ? candidate : null;

  /*
   * A refused link is a reason to offer the code, not to close the screen.
   *
   * Supabase's recovery template sends a six-digit code, a link, or both, and which one arrives is
   * configuration rather than something this page can know. Refusing the link used to end the flow
   * here — which, under a code-only template, meant recovery could not be completed at all. The
   * refusal is now stated above the code entry and the person can still finish.
   */
  const problem = refusal === "expired" ? RECOVERY_EXPIRED : refusal ? RECOVERY_INVALID : null;

  return (
    <AuthShell
      title="Set a new password"
      subtitle={
        user
          ? "Choose a password you have not used here before."
          : "Confirm the reset code we emailed you, then choose a new password."
      }
      footer={
        <>
          Know your password?{" "}
          <Link className={styles.link} href={SIGN_IN_PATH}>
            Sign in
          </Link>
        </>
      }
    >
      {user ? (
        <ResetPasswordForm email={user.email ?? null} destination={destination} />
      ) : (
        <RecoveryCodeForm email={email} destination={destination} initialProblem={problem} />
      )}
    </AuthShell>
  );
}
