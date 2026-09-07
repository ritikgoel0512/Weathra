"use client";

/**
 * The application top bar — the header strip every product artifact carries.
 *
 * All seven product artifacts under `docs/design/screens/` put the same strip above the content: a
 * breadcrumb on the left, a search field in the middle, and the signed-in person on the right. The
 * implementation had none of it, which is a large part of why a rendered screen and its artifact did
 * not read as the same product.
 *
 * Two of the three are reproduced as the artifacts show them. The third is reproduced *honestly*,
 * and the difference is worth stating rather than hiding:
 *
 * **The breadcrumb.** The artifacts print `Dashboard › Meteorology Analytics` on every screen. The
 * second segment never changes, so it is not a location — it is a workspace label. The trail is the
 * real path in both modes: the Dashboard, then the screen you are actually on, from
 * `lib/navigation.ts`. In fidelity mode the workspace label is rendered *beside* the trail, which
 * is where the artifacts' shape comes from without the trail losing its meaning.
 *
 * **The search.** The artifacts label it "Search locations or data…". There is no endpoint that
 * searches "data", and a field that quietly searched nothing would be the fabrication this pass is
 * meant to remove. There *is* a location resolver — the same one the Dashboard's briefing entry
 * uses — so the field is a location search and says so. Submitting hands the name to the Dashboard,
 * which resolves it through the backend exactly as if it had been typed there, ambiguity handling
 * and all. Nothing about it is decorative.
 *
 * **The notification bell is not here.** It is the one element of the strip with no truthful form:
 * Weathra has no notifications, Weather Watch is post-MVP (`docs/design/roadmap.md`), and the
 * artifacts draw it with an unread dot. A bell that never rings, or that rings with an invented
 * count, is worse than the gap. Recorded in `docs/design/screens.md` §8.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import type { Identity } from "@/lib/auth/identity";
import { destinationFor } from "@/lib/navigation";
import { DEFAULT_PROTECTED_PATH } from "@/lib/routes";

import { BellIcon, SearchIcon } from "./icons";
import styles from "./shell.module.css";

import { SHELL_FIXTURE, usingVisilyFixtures } from "@/lib/fixtures/visily";

/** The place-search parameter the Dashboard reads. Shared so the two cannot drift. */
export const PLACE_PARAM = "place";

export interface TopBarProps {
  readonly identity: Identity;
}

export function TopBar({ identity }: TopBarProps): ReactNode {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");

  const here = destinationFor(pathname);
  const onDashboard = pathname === DEFAULT_PROTECTED_PATH;

  /*
   * Visual-fidelity review only, and the three differences are exactly the three this file's
   * comment above records as deliberate divergences. In fixture mode they are reproduced as the
   * artifacts draw them so a side-by-side is comparing the same strip; in production every one of
   * them stays as it is. Fixed when the bundle is built, and always false in a deployed one.
   */
  const fidelity = usingVisilyFixtures();

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const asked = query.trim();
      if (asked === "") return;
      // The Dashboard owns resolution; this only carries the name to it.
      router.push(`${DEFAULT_PROTECTED_PATH}?${PLACE_PARAM}=${encodeURIComponent(asked)}`);
      setQuery("");
    },
    [query, router],
  );

  return (
    <div className={styles.topBar}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <ol className={styles.breadcrumbList}>
          <li>
            {onDashboard ? (
              <span aria-current="page">Dashboard</span>
            ) : (
              <Link href={DEFAULT_PROTECTED_PATH}>Dashboard</Link>
            )}
          </li>
          {here && !onDashboard ? (
            <li>
              <span className={styles.breadcrumbSeparator} aria-hidden="true">
                ›
              </span>
              <span className={styles.breadcrumbCurrent} aria-current="page">
                {here.title}
              </span>
            </li>
          ) : null}
        </ol>
        {/*
          The artifacts print `Dashboard › Meteorology Analytics` on every screen. An earlier
          fidelity pass rendered that literally, which replaced each screen's identity with a
          constant and told you nothing about where you were. "Meteorology Analytics" is a
          *workspace* label, so it is rendered as one: beside the trail, subdued, and outside the
          breadcrumb's own list so it is not announced as a location. The final crumb is the screen.
        */}
        {fidelity ? <span className={styles.workspaceTag}>{SHELL_FIXTURE.breadcrumb[1]}</span> : null}
      </nav>

      <form className={styles.search} onSubmit={submit} role="search">
        <label className={styles.searchLabel} htmlFor="weathra-place-search">
          Search locations
        </label>
        <span className={styles.searchField}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            id="weathra-place-search"
            className={styles.searchInput}
            type="search"
            name={PLACE_PARAM}
            value={query}
            autoComplete="off"
            placeholder={fidelity ? "Search locations or data…" : "Search locations…"}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
        <p className={styles.searchHint} id="weathra-place-search-hint">
          Briefs the Dashboard on a place. Weathra resolves the name before it retrieves anything.
        </p>
      </form>

      {/*
        The name is explicit because the visible text is hidden below the wide tier and the monogram
        is decorative — without it the link is a nameless tab stop on every product screen at 360
        pixels, which is what `tests/e2e/axe.spec.ts` reported.
      */}
      <div className={styles.topRight}>
        {/*
          The artifacts draw a notification bell with an unread dot. Weathra has no notifications,
          so production omits it entirely (see this file's note) — in fixture mode it is drawn as a
          decorative mark with no control behind it, purely so the strip has the artifact's width
          and rhythm. It is `aria-hidden` and not focusable: nothing announces it, nothing reaches
          it by keyboard, and it cannot be mistaken for a feature.
        */}
        {fidelity ? (
          <span className={styles.topBell} aria-hidden="true">
            <BellIcon />
            <span className={styles.topBellDot} />
          </span>
        ) : null}

        <Link
          className={styles.topIdentity}
          href="/settings"
          aria-label={`Account settings for ${identity.name}`}
          data-fidelity={fidelity ? "true" : undefined}
        >
          <span className={styles.topMonogram} aria-hidden="true">
            {fidelity ? null : identity.monogram}
            {fidelity ? <span className={styles.topPresence} /> : null}
          </span>
          <span className={styles.topIdentityText}>
            <span className={styles.topIdentityName}>{identity.name}</span>
            <span className={styles.topIdentityMeta}>Account settings</span>
          </span>
        </Link>
      </div>
    </div>
  );
}
