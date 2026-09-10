"use client";

/**
 * The persistent navigation — the twelve entries of `docs/design/design-system.md` §5.
 *
 * A real `<nav>` holding a real list of real links. Not a set of buttons calling `router.push`:
 * links are what a browser knows how to open in a new tab, what a screen reader announces as
 * navigation, and what works before any JavaScript arrives.
 *
 * **A planned destination is a link too.** `specs/web-ui` requires the routing structure to be
 * real and the route to say plainly that the screen is not yet available — so a planned entry is
 * reachable and marked, never hidden and never presented as working. Its accessible name carries
 * the marking as words, because a chip that only says "planned" visually says nothing to a person
 * who cannot see it.
 *
 * **They are separated from the built ones, and that is a fidelity fix.** All twelve used to sit in
 * one flat list — seven built and five not yet — so the planned five were read among the working
 * seven rather than after them. The product artifacts show a short primary navigation, and a flat
 * twelve read as a long roadmap. The planned five now sit under their own heading, in a quieter
 * treatment. Nothing is hidden, nothing is unreachable, and the marking is unchanged; only the
 * weight is.
 *
 * The split is `lib/routes.ts`: seven `MVP_SCREENS` (Dashboard, AI Weather Analyst, Historical
 * Analytics, Compare Cities, Agent Evidence, Saved Locations, Settings) and five
 * `POST_MVP_SCREENS` (Forecast Explorer, Weather Intelligence Report, Weather Scenario Lab,
 * Weather Watch, Travel Intelligence). This file counts them rather than hard-coding either
 * number, and `complete-product.test.tsx` asserts the rendered rail covers both lists exactly.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import {
  ACCOUNT_NAVIGATION,
  ADMIN_NAVIGATION,
  CORE_NAVIGATION,
  INTELLIGENCE_NAVIGATION,
  isActive,
  type Destination,
} from "@/lib/navigation";

import { Icon } from "./icons";
import styles from "./shell.module.css";

export interface NavigationProps {
  /** Closes the drawer when an entry is followed on a narrow viewport. */
  readonly onNavigate?: () => void;
  /**
   * Whether the acting principal holds the administrative role, as the backend reported it.
   *
   * A prop rather than a request made here, so this stays what it was: a rail that renders a model
   * and asks nothing. `AppShell` does the asking, once, where the query layer already is.
   *
   * Defaults to false — an absent or failed answer offers nothing, which is the safe direction.
   */
  readonly administrative?: boolean;
}

export function Navigation({ onNavigate, administrative = false }: NavigationProps): ReactNode {
  const pathname = usePathname() ?? "/";

  /*
   * The full model, in both modes.
   *
   * An earlier fidelity pass replaced this with the artifacts' four-entry list — Dashboard,
   * Analytics, Historical Data, Settings — so the rendered sidebar matched the mockup. That was the
   * wrong trade: it removed eight of Weathra's twelve destinations from the product, renamed
   * Historical Analytics to a generic "Analytics", and made two entries point at one route. The
   * sidebar in the artifacts is incomplete mockup content, which `lib/navigation.ts` and
   * `docs/design/screens.md` §5 both already record as superseded by this table.
   *
   * What the artifacts *do* govern is how the rail looks — compact rows, small icons, restrained
   * planned marks, the saved-locations subsection, the identity footer — and that is a matter for
   * `shell.module.css`, not for which destinations exist. Full navigation, Visily treatment.
   */
  const render = (entry: Destination): ReactNode => {
    const active = isActive(entry, pathname);
    return (
      <li key={entry.path}>
        <Link
          className={styles.item}
          href={entry.path}
          data-active={active ? "true" : undefined}
          data-status={entry.status}
          aria-current={active ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name={entry.icon} />
          <span className={styles.itemLabel}>{entry.title}</span>
          {entry.status === "planned" ? (
            /*
             * No badge. A "PLANNED" chip beside five of twelve entries made the primary navigation
             * read as a roadmap, which is not what the artifacts draw and not what a person opening
             * Weathra is looking at. The row is dimmed instead — `[data-status="planned"]` in
             * `shell.module.css` — and the caveat stays in the accessible name, because a
             * treatment that is only visual says nothing to somebody who cannot see it.
             *
             * The dimming goes away per screen, as each one is built. It does not go away first:
             * an unmarked entry leading to an unbuilt screen is a dead end in the one navigation
             * the product has.
             */
            <span className="weathra-visually-hidden">— coming soon</span>
          ) : null}
        </Link>
      </li>
    );
  };

  const group = (id: string, heading: string, entries: readonly Destination[]): ReactNode => (
    <section className={styles.plannedGroup} aria-labelledby={`weathra-${id}-heading`}>
      <h2 className={styles.plannedHeading} id={`weathra-${id}-heading`}>
        {heading}
      </h2>
      <ul className={styles.list} data-group={id}>
        {entries.map(render)}
      </ul>
    </section>
  );

  /*
   * Four groups, in the order the artifacts' sidebar reads: what the product does, what it
   * analyses, the account, and — for an administrator only — administration.
   *
   * Core is unheaded. A heading over the first group would push the Dashboard down the rail behind
   * a label that says nothing a person needs: they are looking at Weathra, and these are Weathra.
   */
  return (
    <>
      <ul className={styles.list} data-group="core">
        {CORE_NAVIGATION.map(render)}
      </ul>
      {group("intelligence", "Intelligence", INTELLIGENCE_NAVIGATION)}
      {group("account", "Account", ACCOUNT_NAVIGATION)}
      {administrative ? group("admin", "Admin", ADMIN_NAVIGATION) : null}
    </>
  );
}
