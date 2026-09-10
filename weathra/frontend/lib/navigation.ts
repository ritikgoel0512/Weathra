/**
 * The navigation model — the twelve entries of `docs/design/design-system.md` §5, in order.
 *
 * **Why this is not a list of links written into the sidebar.** Three facts about a destination
 * live in three different places, and the sidebar needs all three: its path and title are route
 * structure (`lib/routes.ts`), whether it is built is a property of this change, and its position
 * is a design decision recorded in `docs/design/`. Composing them here means the sidebar renders a
 * model rather than deciding one, and a test can assert the model covers exactly the screens the
 * route map declares — no destination invented, none quietly dropped.
 *
 * **The order is the recorded one, not the route map's.** `MVP_SCREENS` and `POST_MVP_SCREENS` are
 * split by *status*, because that is the authentication and implementation boundary. The
 * navigation interleaves them, because a person reads the product's structure rather than its
 * delivery schedule: Forecast Explorer sits next to the Analyst it belongs beside, marked as not
 * yet available.
 *
 * The four-item sidebar in the approved artifacts — Dashboard, Analytics, Historical Data,
 * Settings — is incomplete mockup content. `docs/design/screens.md` §5 records that this table
 * supersedes it.
 */

import {
  ACCOUNT_SCREENS,
  ADMIN_SCREENS,
  MVP_SCREENS,
  POST_MVP_SCREENS,
  type Screen,
} from "@/lib/routes";

/**
 * Whether a destination is built in this change.
 *
 * `planned` is not a softer word for "broken": `specs/web-ui` requires the route to exist and to
 * state plainly that the screen is not yet available, so the status is what the navigation and the
 * route both read to say the same thing.
 */
export type DestinationStatus = "mvp" | "planned" | "admin" | "account";

/**
 * The name of an icon in `components/shell/icons.tsx`.
 *
 * The registry is wider than the navigation: the last four name the Settings tab glyphs
 * `07-settings.png` draws, added for the runtime fidelity audit's finding 7.4. They are not
 * destinations and never appear in `ORDER`.
 */
export type IconName =
  | "dashboard"
  | "analyst"
  | "explorer"
  | "historical"
  | "compare"
  | "report"
  | "scenarios"
  | "evidence"
  | "watch"
  | "travel"
  | "locations"
  | "settings"
  | "general"
  | "intelligence"
  | "account"
  | "transparency";

export interface Destination extends Screen {
  readonly status: DestinationStatus;
  readonly icon: IconName;
}

/** The recorded order, by path, with the icon each entry carries. */
const ORDER: readonly { path: string; icon: IconName }[] = [
  { path: "/", icon: "dashboard" },
  { path: "/analyst", icon: "analyst" },
  { path: "/explorer", icon: "explorer" },
  { path: "/historical", icon: "historical" },
  { path: "/compare", icon: "compare" },
  { path: "/report", icon: "report" },
  { path: "/scenarios", icon: "scenarios" },
  { path: "/evidence", icon: "evidence" },
  { path: "/watch", icon: "watch" },
  { path: "/travel", icon: "travel" },
  { path: "/locations", icon: "locations" },
  { path: "/settings", icon: "settings" },
];

function destination({ path, icon }: { path: string; icon: IconName }): Destination {
  const mvp = MVP_SCREENS.find((screen) => screen.path === path);
  if (mvp) return { ...mvp, status: "mvp", icon };

  const planned = POST_MVP_SCREENS.find((screen) => screen.path === path);
  if (planned) return { ...planned, status: "planned", icon };

  // Unreachable through the tests, which assert the model and the route map agree. Thrown rather
  // than filtered so a path renamed in one place and not the other fails loudly at import.
  throw new Error(`${path} is in the navigation but not in the route map`);
}

/** The twelve entries, in the order the design record fixes. */
export const NAVIGATION: readonly Destination[] = ORDER.map(destination);

/**
 * The account section: built, offered to everybody, and about the account rather than the weather.
 */
export const ACCOUNT_NAVIGATION: readonly Destination[] = ACCOUNT_SCREENS.map((screen) => ({
  ...screen,
  status: "account" as const,
  icon: "account" as const,
}));

/**
 * The administrative section, shown only to a principal the backend says holds the role.
 *
 * Not part of `NAVIGATION`, and the separation is the point: `NAVIGATION` is what the product *is*,
 * the same for everybody, and this is what one person may additionally do. Merging them would mean
 * every assertion about the navigation model had to know who was asking.
 */
export const ADMIN_NAVIGATION: readonly Destination[] = ADMIN_SCREENS.map((screen) => ({
  ...screen,
  status: "admin" as const,
  icon: "intelligence" as const,
}));

/** The destination whose route the given path is on, or null for a path outside the model. */
export function destinationFor(pathname: string): Destination | null {
  // Longest path first, so `/` does not claim `/analyst`.
  const candidates = [...NAVIGATION].sort((one, other) => other.path.length - one.path.length);
  return (
    candidates.find((entry) =>
      entry.path === "/"
        ? pathname === "/"
        : pathname === entry.path || pathname.startsWith(`${entry.path}/`),
    ) ?? null
  );
}

/** Whether this destination is the one being shown. */
export function isActive(entry: Destination, pathname: string): boolean {
  return destinationFor(pathname)?.path === entry.path;
}
