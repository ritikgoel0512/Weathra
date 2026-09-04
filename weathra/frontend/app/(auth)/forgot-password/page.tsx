/**
 * `/forgot-password` — the Forgot Password screen.
 *
 * The same shell as Sign In, Create Account and Verify Email, with a different title and a
 * different way out: `docs/design/design-system.md` §12 is one shell for all eight authentication
 * screens, and this is the seventh of them.
 *
 * Static. There is no session to resolve and nothing to fetch — a person here is, by definition,
 * somebody who cannot get one. The form inside it is the client component, and Supabase Auth is
 * what sends the message.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import styles from "@/components/auth/auth.module.css";
import { CREATE_ACCOUNT_PATH, SIGN_IN_PATH } from "@/lib/routes";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage(): ReactNode {
  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email you a link to set a new one."
      footer={
        <>
          Remembered it?{" "}
          <Link className={styles.link} href={SIGN_IN_PATH}>
            Sign in
          </Link>{" "}
          or{" "}
          <Link className={styles.link} href={CREATE_ACCOUNT_PATH}>
            create an account
          </Link>
          .
        </>
      }
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
