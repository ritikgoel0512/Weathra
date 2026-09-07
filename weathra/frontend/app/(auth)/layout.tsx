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
 *
 * **It is also where the appearance is chosen.** `docs/design/screens/08-authentication.png` is the
 * approved shell for all eight authentication screens and is rendered in the light appearance,
 * where the seven product artifacts are Midnight Intelligence. So this group opts into `light` and
 * the product stays dark — the division the artifacts draw. Nothing here consults
 * `prefers-color-scheme`: an appearance that followed the machine is what previously served the
 * whole product in a palette no product artifact depicts.
 */

import type { ReactNode } from "react";

import { FixtureAuthGround } from "@/components/auth/fixture-auth";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

import styles from "@/components/auth/auth.module.css";

export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  /*
   * Visual-fidelity review only. `08-authentication.png` sits on generated imagery that
   * `screens.md` §5 refuses to invent for the product — right for production, wrong for a
   * side-by-side, because the ground is most of the artifact's pixels. In fixture mode it is drawn
   * (originated as SVG, nothing sourced) and the card takes the artifact's narrower width. The flag
   * is inlined at build time, so a production build folds this to `false`.
   */
  const fidelity = usingVisilyFixtures();

  return (
    <main
      className={styles.page}
      data-appearance="light"
      data-fidelity={fidelity ? "true" : undefined}
    >
      {fidelity ? <FixtureAuthGround /> : null}
      {children}
    </main>
  );
}
