/**
 * What Reset Password shows when there is no recovery session to reset a password with — task 20.8.
 *
 * Three ways to arrive here, one state: the link expired, the link had already been used, or there
 * is no session at all (a bookmark, a typed URL, a tab left open until the recovery session went).
 * Each gets its own sentence — `specs/authentication` requires an expired reset to be *reported as
 * such* — and all three get the same way forward, which is to ask for another link.
 *
 * Presentational and server-renderable: it decides nothing. Whether a recovery session exists is
 * resolved against Supabase before this is rendered.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { FORGOT_PASSWORD_PATH } from "@/lib/routes";

import styles from "./auth.module.css";
import { RECOVERY_EXPIRED, RECOVERY_INVALID, RECOVERY_MISSING } from "./failures";

/** Why there is nothing to reset with. */
export type RecoveryProblem = "expired" | "invalid" | "missing";

const MESSAGES: Readonly<Record<RecoveryProblem, string>> = {
  expired: RECOVERY_EXPIRED,
  invalid: RECOVERY_INVALID,
  missing: RECOVERY_MISSING,
};

export function RecoveryUnavailable({ problem }: { readonly problem: RecoveryProblem }): ReactNode {
  return (
    <div className={styles.form}>
      <p className={styles.failure} role="alert">
        {MESSAGES[problem]}
      </p>

      {/*
        A link, not a button wrapped in one: the way forward is a navigation, and a `<button>` inside
        an `<a>` is two controls where a person expects one.
      */}
      <Link className={styles.actionLink} href={FORGOT_PASSWORD_PATH}>
        Request a new reset link
      </Link>
    </div>
  );
}
