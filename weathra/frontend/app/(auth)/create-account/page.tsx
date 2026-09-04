/**
 * `/create-account` — the Create Account screen.
 *
 * The same shell as Sign In, with a different title and a different way out. That is the whole
 * point of `docs/design/design-system.md` §12: eight authentication screens, one shell, and no
 * screen inventing its own.
 *
 * The footer carries **both** routes `specs/authentication` requires be offered to somebody whose
 * address already has an account — sign in, and reset the password. They are permanently visible
 * rather than shown in response to a submission, because a link that appears only when an address
 * is already registered *is* the disclosure the requirement forbids.
 *
 * Static: no session to resolve, and nothing to fetch. The form inside it is the client component.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { CreateAccountForm } from "@/components/auth/create-account-form";
import styles from "@/components/auth/auth.module.css";
import { FORGOT_PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/routes";

export const metadata: Metadata = { title: "Create account" };

export default function CreateAccountPage(): ReactNode {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Agentic weather intelligence, forecast analysis, and analytics."
      footer={
        <>
          Already have an account?{" "}
          <Link className={styles.link} href={SIGN_IN_PATH}>
            Sign in
          </Link>{" "}
          or{" "}
          <Link className={styles.link} href={FORGOT_PASSWORD_PATH}>
            reset your password
          </Link>
          .
        </>
      }
    >
      <CreateAccountForm />
    </AuthShell>
  );
}
