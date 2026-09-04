/**
 * The signed-in identity area, at the foot of the navigation.
 *
 * Presentational and pure: the identity is resolved server-side in the protected layout and passed
 * in, so nothing here reads a session, and no component below the layout can accidentally become a
 * second place that decides who is signed in.
 */

import type { ReactNode } from "react";

import type { Identity } from "@/lib/auth/identity";

import styles from "./shell.module.css";

export interface IdentityPanelProps {
  readonly identity: Identity;
  /** The sign-out control, passed from the server so the form's action stays server-side. */
  readonly signOutControl?: ReactNode;
}

export function IdentityPanel({ identity, signOutControl }: IdentityPanelProps): ReactNode {
  return (
    <div className={styles.identity}>
      <div className={styles.identityPerson}>
        <span className={styles.monogram} aria-hidden="true">
          {identity.monogram}
        </span>
        <span className={styles.identityText}>
          <span className={styles.identityName}>{identity.name}</span>
          {identity.email ? (
            <span className={styles.identityMeta}>{identity.email}</span>
          ) : null}
        </span>
      </div>
      {signOutControl}
    </div>
  );
}
