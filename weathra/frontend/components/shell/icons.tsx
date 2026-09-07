/**
 * The navigation icons.
 *
 * Hand-drawn as inline SVG rather than pulled from an icon package: twelve glyphs do not justify a
 * dependency, and inlining them means no extra request, no font, and no build step between the
 * design and what renders. Each one inherits `currentColor`, so an icon takes the accent when its
 * item is active without the component knowing a colour.
 *
 * Every icon is `aria-hidden`: the item's label is the accessible name, and an icon announced
 * beside it would say the same thing twice.
 */

import type { ReactNode } from "react";

import type { IconName } from "@/lib/navigation";

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  // Dashboard — a panel grid, the briefing's card layout.
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="4" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  // AI Weather Analyst — a conversation.
  analyst: (
    <>
      <path d="M20 12a8 8 0 1 1-3.2-6.4" />
      <path d="M4.5 19.5 6 15" />
      <path d="M9.5 12h5" />
    </>
  ),
  // Forecast Explorer — a forecast line over time.
  explorer: (
    <>
      <path d="M3 17.5 8 11l4 3.5L21 6" />
      <path d="M16 6h5v5" />
    </>
  ),
  // Historical Analytics — a bar series, past periods.
  historical: (
    <>
      <path d="M3 21h18" />
      <rect x="4" y="12" width="4" height="6" rx="1" />
      <rect x="10" y="7" width="4" height="11" rx="1" />
      <rect x="16" y="14" width="4" height="4" rx="1" />
    </>
  ),
  // Compare Cities — two places weighed against each other.
  compare: (
    <>
      <path d="M12 3v18" />
      <path d="M5 8h14" />
      <path d="M5 8 3 14h4z" />
      <path d="M19 8l-2 6h4z" />
    </>
  ),
  // Weather Intelligence Report — a composed document.
  report: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </>
  ),
  // Weather Scenario Lab — a branching alternative.
  scenarios: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v3a2 2 0 0 0 2 2h2.5" />
      <path d="M18 8.5v3a2 2 0 0 1-2 2h-2.5" />
    </>
  ),
  // Agent Evidence — the run record, step by step.
  evidence: (
    <>
      <path d="M5 5h14" />
      <path d="M5 12h9" />
      <path d="M5 19h5" />
      <circle cx="17.5" cy="17.5" r="3.5" />
      <path d="M20 20l1.5 1.5" />
    </>
  ),
  // Weather Watch — a condition being monitored.
  watch: (
    <>
      <path d="M12 4a6 6 0 0 1 6 6c0 4 2 5 2 5H4s2-1 2-5a6 6 0 0 1 6-6z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  // Travel Intelligence — a route between places.
  travel: (
    <>
      <path d="M6 21c3.5-4 5-6.5 5-9a5 5 0 0 0-10 0c0 2.5 1.5 5 5 9z" transform="translate(1)" />
      <circle cx="7" cy="12" r="1.5" />
      <path d="M13 6h4a3 3 0 0 1 0 6h-1" />
    </>
  ),
  // Saved Locations — a place, kept.
  locations: (
    <>
      <path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  // Settings — preferences.
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" />
    </>
  ),
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 20 }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Weathra mark: a sun behind cloud, drawn from the same stroke language. */
export function BrandMark({ size = 28 }: { readonly size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M9 2v1.5M9 12.5V14M3 8h1.5M13.5 8H15M4.8 3.8l1 1M12.2 11.2l1 1M4.8 12.2l1-1M12.2 4.8l1-1" />
      <path d="M9.5 20h8a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.3-1.2A4 4 0 0 0 9.5 20z" />
    </svg>
  );
}

/** The drawer control's glyph, which flips between the two states it toggles. */
export function MenuIcon({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {open ? (
        <>
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </>
      ) : (
        <>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </>
      )}
    </svg>
  );
}

/**
 * The password field's visibility glyph — `08-authentication.png` shows an eye inside the field's
 * trailing edge, where the implementation drew the words "Show"/"Hide".
 *
 * The words were there for a reason: an icon-only control needs an accessible name supplied
 * separately, and a name nobody can see is a name nobody checks. That reason is met without keeping
 * the words — the button carries an explicit `aria-label` ("Show password" / "Hide password") which
 * every test queries it by, so the name is asserted on every run rather than merely present. The
 * glyph is `aria-hidden`, as every other icon here is.
 */
export function EyeIcon({ off }: { readonly off: boolean }): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="M4 20 20 4" /> : null}
    </svg>
  );
}

/** The top bar's search glyph, inside the field's leading edge as every product artifact shows it. */
export function SearchIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4 4" />
    </svg>
  );
}

/**
 * The notification bell the product artifacts draw in the top bar.
 *
 * Rendered only in fidelity-fixture mode, and only as a decoration: Weathra has no notifications
 * (see `top-bar.tsx`), so there is no control behind it and nothing announces it. It exists here so
 * a screenshot of the strip has the artifact's width and rhythm.
 */
export function BellIcon(): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15L18 15.5z" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}
