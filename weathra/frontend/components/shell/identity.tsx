/**
 * The signed-in identity area, at the foot of the navigation.
 *
 * Presentational and pure: the identity is resolved server-side in the protected layout and passed
 * in, so nothing here reads a session, and no component below the layout can accidentally become a
 * second place that decides who is signed in.
 */

import type { ReactNode } from "react";

import type { Identity } from "@/lib/auth/identity";
import { SHELL_FIXTURE, usingVisilyFixtures } from "@/lib/fixtures/visily";

import styles from "./shell.module.css";

export interface IdentityPanelProps {
  readonly identity: Identity;
  /** The sign-out control, passed from the server so the form's action stays server-side. */
  readonly signOutControl?: ReactNode;
}

export function IdentityPanel({ identity, signOutControl }: IdentityPanelProps): ReactNode {
  /*
   * Visual-fidelity review only. The artifacts draw a person glyph and one name at the foot of the
   * rail — no monogram tile and no address — where production shows both, because production has a
   * real person to identify. Fixed when the bundle is built, and always false in a deployed one.
   */
  const fidelity = usingVisilyFixtures();

  return (
    <div className={styles.identity} data-fidelity={fidelity ? "true" : undefined}>
      <div className={styles.identityPerson}>
        <span className={styles.monogram} aria-hidden="true">
          {fidelity ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <circle cx="12" cy="8.5" r="3.6" />
              <path d="M5 20a7 7 0 0 1 14 0" />
            </svg>
          ) : (
            identity.monogram
          )}
        </span>
        <span className={styles.identityText}>
          <span className={styles.identityName}>
            {fidelity ? SHELL_FIXTURE.person : identity.name}
          </span>
          {identity.email && !fidelity ? (
            <span className={styles.identityMeta}>{identity.email}</span>
          ) : null}
        </span>
      </div>
      {signOutControl}
    </div>
  );
}
