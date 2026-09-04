/**
 * The unauthenticated layout — the `(auth)` route group's frame.
 *
 * The group is the authentication boundary in the file tree (design.md decision 18): `(app)`
 * resolves a session and refuses without one, and this one deliberately does not, because a person
 * arriving here has no session yet — getting one is the point.
 *
 * It does not need to redirect an already-authenticated person either. `middleware.ts` does that
 * before anything renders (task 20.10), which is both earlier and the only place that can see the
 * `next` parameter it has to honour.
 *
 * All this contributes is the page: the ground, and a centred column. The shell inside it is
 * `components/auth/auth-shell.tsx`.
 */

import type { ReactNode } from "react";

import styles from "@/components/auth/auth.module.css";

export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return <main className={styles.page}>{children}</main>;
}
