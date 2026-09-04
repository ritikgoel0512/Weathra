"use client";

/**
 * The password rules, stated under the field that asks for one.
 *
 * Shared by Create Account (task 20.4) and Reset Password (task 20.8) because it is the *same*
 * policy — `lib/auth/password.ts` declares it once, and a second copy of this list would be a
 * second place for the two screens to disagree about what they promised. `specs/authentication`
 * requires the rules to be stated before submission on both.
 *
 * A list rather than prose so each rule can carry its own met state, and each state is a word as
 * well as a mark — a tick that only exists as a colour says nothing to a person who cannot see it.
 */

import { useMemo, type ReactNode } from "react";

import { PASSWORD_RULES } from "@/lib/auth/password";

import styles from "./auth.module.css";

export interface PasswordRulesProps {
  readonly password: string;
  /** The address the "not your email address" rule is checked against. */
  readonly email?: string;
}

export function PasswordRules({ password, email }: PasswordRulesProps): ReactNode {
  const rules = useMemo(
    () =>
      PASSWORD_RULES.map((rule) => ({
        id: rule.id,
        label: rule.label,
        met: password.length > 0 && rule.satisfied(password, email),
      })),
    [password, email],
  );

  return (
    <ul className={styles.rules} aria-label="Password requirements">
      {rules.map((rule) => (
        <li key={rule.id} className={styles.rule} data-met={rule.met ? "true" : undefined}>
          <span className={styles.ruleMark} aria-hidden="true">
            {rule.met ? "✓" : "•"}
          </span>
          <span>{rule.label}</span>
          <span className="weathra-visually-hidden">{rule.met ? " — met" : " — not met yet"}</span>
        </li>
      ))}
    </ul>
  );
}
