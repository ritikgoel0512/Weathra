"use client";

/**
 * The Intelligent Command Center shell — the frame every protected screen renders inside.
 *
 * Four things live here and nowhere else: the brand, the persistent navigation, the signed-in
 * identity with its sign-out control, and the main content region. A screen renders into
 * `children` and never draws its own frame.
 *
 * A client component, for one reason: below 768 pixels the navigation is a drawer, and a drawer has
 * open state. Everything that does *not* need state stays on the server — the identity is resolved
 * in the protected layout and passed in, and the sign-out form is passed in as rendered output so
 * its server action is not reached through a client boundary.
 *
 * The drawer's accessibility is the part worth reading: the control reports `aria-expanded` and
 * owns the navigation through `aria-controls`; Escape closes it; following an entry closes it; and
 * when closed on a narrow viewport the navigation is hidden with `visibility`, which takes its
 * twelve links out of the tab order rather than leaving them focusable off-screen.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Identity } from "@/lib/auth/identity";
import { DEFAULT_PROTECTED_PATH } from "@/lib/routes";

import { FixtureBanner } from "@/components/ui";

import { BrandMark, MenuIcon } from "./icons";
import { IdentityPanel } from "./identity";
import { Navigation } from "./navigation";
import { SavedRail } from "./saved-rail";
import { TopBar } from "./top-bar";
import styles from "./shell.module.css";

const NAVIGATION_ID = "weathra-navigation";
const MAIN_ID = "weathra-main";

export interface AppShellProps {
  readonly identity: Identity;
  readonly signOutControl?: ReactNode;
  readonly children?: ReactNode;
}

export function AppShell({ identity, signOutControl, children }: AppShellProps): ReactNode {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);

  const close = useCallback(() => setDrawerOpen(false), []);

  /**
   * Dismissing the drawer — Escape, or the scrim — puts focus back on the control that opened it.
   *
   * Closing it hides the navigation with `visibility`, and a focused element inside something
   * hidden loses focus to the document: a keyboard user who opened the menu, moved into it and
   * changed their mind was returned to the top of the page with nothing focused, and had to tab
   * back through everything. Guarded on focus actually being inside the drawer, so dismissing it
   * while focus is elsewhere does not snatch it.
   *
   * Deliberately not called from the route-change close below: following an entry hands focus to
   * the screen that was opened, and pulling it back to the menu control would undo that.
   */
  const dismiss = useCallback(() => {
    const active = document.activeElement;
    const inDrawer = active instanceof Node && navigation.current?.contains(active);
    close();
    if (inDrawer) menuButton.current?.focus();
  }, [close]);

  // A route change closes the drawer. Without this, following an entry leaves the drawer over the
  // screen it just opened.
  useEffect(close, [pathname, close]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && drawerOpen) {
        event.stopPropagation();
        dismiss();
      }
    },
    [dismiss, drawerOpen],
  );

  return (
    <div className={styles.shell} onKeyDown={onKeyDown}>
      {/*
        First in the tab order, visible only on focus: twelve navigation links stand between the
        top of the page and its content, and a keyboard user should not have to pass them all to
        reach what they came for.
      */}
      {/* Says on screen that the figures are sample content, whenever fixture mode is on. */}
      <FixtureBanner />

      <a className={styles.skipLink} href={`#${MAIN_ID}`}>
        Skip to content
      </a>

      <header className={styles.header}>
        <button
          type="button"
          ref={menuButton}
          className={styles.menuButton}
          aria-expanded={drawerOpen}
          aria-controls={NAVIGATION_ID}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <MenuIcon open={drawerOpen} />
          <span>Menu</span>
        </button>
        <Link className={styles.brand} href={DEFAULT_PROTECTED_PATH}>
          <span className={styles.brandMark}>
            <BrandMark size={20} />
          </span>
          <span className={styles.brandName}>Weathra</span>
        </Link>
      </header>

      {drawerOpen ? (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close menu"
          onClick={dismiss}
        />
      ) : null}

      <nav
        ref={navigation}
        className={styles.navigation}
        id={NAVIGATION_ID}
        aria-label="Weathra"
        data-open={drawerOpen ? "true" : undefined}
      >
        <Link className={styles.brand} href={DEFAULT_PROTECTED_PATH}>
          <span className={styles.brandMark}>
            <BrandMark size={20} />
          </span>
          <span className={styles.brandName}>Weathra</span>
        </Link>

        {/*
          The entries scroll; the brand above and the identity below do not. The wrapper is the
          scroll container so that `.navigation` is not one: a scroll container clips both axes,
          and the collapsed tier's labels are drawn outside the rail.
        */}
        <div className={styles.navScroll}>
          <Navigation onNavigate={close} />
          {/* The artifacts' SAVED LOCATIONS section, under the primary navigation. */}
          <SavedRail onNavigate={close} />
        </div>

        <IdentityPanel identity={identity} signOutControl={signOutControl} />
      </nav>

      {/*
        `tabIndex={-1}` so the skip link can move focus here. Without it the link moves the
        viewport and leaves focus at the top of the page, which is the bug that makes skip links
        useless.
      */}
      <main className={styles.main} id={MAIN_ID} tabIndex={-1}>
        <div className={styles.mainInner}>
          {/*
            The header strip every product artifact carries above the content. It is inside `main`
            and above the skip link's target on purpose: it holds the breadcrumb that says where you
            are and the one global control the product has, both of which belong to the page rather
            than to the rail.
          */}
          <TopBar identity={identity} />
          {children}
        </div>
      </main>
    </div>
  );
}
