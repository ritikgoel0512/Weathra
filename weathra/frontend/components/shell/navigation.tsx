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
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { NAVIGATION, isActive } from "@/lib/navigation";

import { Icon } from "./icons";
import styles from "./shell.module.css";

export interface NavigationProps {
  /** Closes the drawer when an entry is followed on a narrow viewport. */
  readonly onNavigate?: () => void;
}

export function Navigation({ onNavigate }: NavigationProps): ReactNode {
  const pathname = usePathname() ?? "/";

  return (
    <ul className={styles.list}>
      {NAVIGATION.map((entry) => {
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
                <>
                  <span className={styles.plannedMark} aria-hidden="true">
                    Planned
                  </span>
                  <span className="weathra-visually-hidden">— not yet available</span>
                </>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
