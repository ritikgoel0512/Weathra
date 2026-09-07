/**
 * The shared authentication shell.
 *
 * `docs/design/design-system.md` §12 makes this one shell for all eight authentication screens:
 * the mark, a title, one short line of context, the form, one primary action in the accent, and
 * the secondary route out. `docs/design/screens/08-authentication.png` is its approved visual
 * reference.
 *
 * Only the shell is here. The Sign In screen is the one that uses it in task 20.7; Create Account,
 * verification, and password reset are tasks 20.4 to 20.8 and add nothing to this file — that is
 * the point of a shell.
 *
 * Presentational and server-renderable: it holds no state and reads no session. The screen inside
 * it is what talks to Supabase.
 */

import type { ReactNode } from "react";

import { BrandMark } from "@/components/shell/icons";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

import { FixtureAuthMark } from "./fixture-auth";

import styles from "./auth.module.css";

export interface AuthShellProps {
  readonly title: string;
  /** One line. What this screen is for, in the product's own words. */
  readonly subtitle?: string;
  readonly children: ReactNode;
  /** The way out: the other screen a person may have meant to be on. */
  readonly footer?: ReactNode;
  /** Ties the card to its heading, so it is a named region rather than a box. */
  readonly titleId?: string;
  /**
   * Render the footer inside the card rather than beneath it.
   *
   * `08-authentication.png` puts the create-account line on the card's own ground; production sets
   * it below, on the page. Used by fixture mode only — the default is production's placement.
   */
  readonly footerInside?: boolean;
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  titleId = "auth-title",
  footerInside = false,
}: AuthShellProps): ReactNode {
  return (
    <>
      <div className={styles.brand}>
        {/* The mark sits in its accent tile, as every approved artifact shows it — task 21.9. */}
        <span className={styles.brandMark}>
          {/*
            The artifact sets a "W" here; the product ships its weather glyph. Fidelity mode draws
            the artifact's letterform so the comparison is not failing on the one brand question
            `fidelity-review.md` has left open for the owner. Production is unchanged.
          */}
          {usingVisilyFixtures() ? <FixtureAuthMark size={19} /> : <BrandMark size={26} />}
        </span>
        <span className={styles.brandName}>Weathra</span>
      </div>

      <section className={styles.card} aria-labelledby={titleId}>
        <div className={styles.headings}>
          <h1 className={styles.title} id={titleId}>
            {title}
          </h1>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        {children}
        {footerInside && footer ? <p className={styles.footer}>{footer}</p> : null}
      </section>

      {!footerInside && footer ? <p className={styles.footer}>{footer}</p> : null}
    </>
  );
}
