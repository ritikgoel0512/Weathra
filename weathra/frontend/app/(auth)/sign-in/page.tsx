/**
 * `/sign-in` — the Sign In screen.
 *
 * A server component, and its one job before rendering is the destination: `middleware.ts` puts the
 * screen a person was trying to reach into the `next` parameter, and `safeDestination` refuses
 * anything that is not a path on this origin. Validating here means an unsafe value never reaches
 * the client at all; the form checks it again anyway, because an open redirect on the screen that
 * asks for a password is worth two checks.
 *
 * The form itself is a client component — it holds the field state and calls Supabase. Everything
 * else on this screen is static.
 *
 * One other parameter is read: the marker the expired-session state sets on its way here (task
 * 20.9). `specs/web-ui` requires an expired session to be *said* rather than presented as a data
 * error, and somebody returned to a sign-in form with no explanation has been told nothing. It
 * carries no identity and grants nothing — it chooses a sentence.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";
import styles from "@/components/auth/auth.module.css";
import {
  CREATE_ACCOUNT_PATH,
  DESTINATION_PARAMETER,
  EXPIRED_PARAMETER,
  safeDestination,
} from "@/lib/routes";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const parameters = (await searchParams) ?? {};
  const requested = parameters[DESTINATION_PARAMETER];
  const destination = safeDestination(Array.isArray(requested) ? requested[0] : requested);

  const returned = parameters[EXPIRED_PARAMETER];
  const expired = (Array.isArray(returned) ? returned[0] : returned) === "1";

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Agentic weather intelligence, forecast analysis, and analytics."
      footer={
        <>
          Don&rsquo;t have an account?{" "}
          <Link className={styles.link} href={CREATE_ACCOUNT_PATH}>
            Create account
          </Link>
        </>
      }
    >
      {expired ? (
        <p className={styles.notice} role="status">
          Your session expired, so we signed you out. Sign in again to carry on where you left off.
        </p>
      ) : null}

      <SignInForm destination={destination} />
    </AuthShell>
  );
}
