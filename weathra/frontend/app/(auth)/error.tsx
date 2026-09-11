"use client";

/**
 * The `(auth)` group's error boundary.
 *
 * Next.js has exactly one behaviour for an uncaught render error with no boundary above it: the
 * unstyled "Application error: a client-side exception has occurred" screen, with the real message
 * stripped out of a production build. Somebody halfway through creating an account met that screen,
 * and it told them nothing — not what failed, not whether their account exists, not where to go.
 *
 * So the boundary exists, and what it says is shaped by *when* it can be reached. Everything in
 * this group happens around an account that has usually already been created by the time anything
 * here can break, so the two things worth offering are a retry and a way to sign in — never a dead
 * end, and never a claim about whether the account was made, which this cannot know.
 */

import Link from "next/link";
import { useEffect, type ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui";
import { CREATE_ACCOUNT_PATH, SIGN_IN_PATH } from "@/lib/routes";

import styles from "@/components/auth/auth.module.css";

export default function AuthError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  useEffect(() => {
    // The browser console is the only place a production build keeps the detail; the digest is what
    // ties this screen to the server-side log entry.
    console.error("Authentication screen failed", error);
  }, [error]);

  return (
    <AuthShell
      title="That screen did not load"
      subtitle="Something on this page failed to start. Nothing you have already submitted was lost."
      footer={
        <>
          Need to start again? <Link href={CREATE_ACCOUNT_PATH}>Create an account</Link>
        </>
      }
    >
      <div className={styles.planFallback}>
        {error.digest ? <p className={styles.planNote}>Reference {error.digest}</p> : null}
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link className={styles.planContinue} href={SIGN_IN_PATH}>
          <Button variant="secondary">Go to sign in</Button>
        </Link>
      </div>
    </AuthShell>
  );
}
