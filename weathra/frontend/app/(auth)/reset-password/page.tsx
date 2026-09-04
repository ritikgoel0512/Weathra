/**
 * `/reset-password` — where a returning recovery link lands.
 *
 * A server component, and its one job before rendering is the question that decides everything on
 * this screen: **is there a recovery session?** `currentUser()` asks Supabase — it validates the
 * session's token with the provider rather than reading what a cookie decodes to — and only an
 * answer of "yes" produces a form that can change a password. Everything else produces the
 * expired-or-invalid state with the way to request another link.
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
 * The Forgot Password screen requests the link; `/auth/confirm` completes it. Neither is here.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { RecoveryUnavailable, type RecoveryProblem } from "@/components/auth/recovery-unavailable";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import styles from "@/components/auth/auth.module.css";
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
  const problem: RecoveryProblem | null = refusal ?? (user ? null : "missing");

  const destination = safeDestination(one(parameters, DESTINATION_PARAMETER));

  return (
    <AuthShell
      title="Set a new password"
      subtitle={
        problem
          ? "This reset can no longer be completed."
          : "Choose a password you have not used here before."
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
      {problem ? (
        <RecoveryUnavailable problem={problem} />
      ) : (
        <ResetPasswordForm email={user?.email ?? null} destination={destination} />
      )}
    </AuthShell>
  );
}
