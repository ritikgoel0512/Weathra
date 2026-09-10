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
  INTELLIGENCE_BUILT,
  INTELLIGENCE_SCREENS,
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
export type DestinationStatus = "mvp" | "planned" | "admin" | "account" | "intelligence";

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

/** The icon each group's entries carry, by path. Drawn from `ORDER`, so one place names them. */
const ICONS: Record<string, IconName> = Object.fromEntries(
  ORDER.map((entry) => [entry.path, entry.icon]),
);

function destination({ path, icon }: { path: string; icon: IconName }): Destination {
  const mvp = MVP_SCREENS.find((screen) => screen.path === path);
  if (mvp) return { ...mvp, status: "mvp", icon };

  const planned = POST_MVP_SCREENS.find((screen) => screen.path === path);
  if (planned) return { ...planned, status: "planned", icon };

  // Unreachable through the tests, which assert the model and the route map agree. Thrown rather
  // than filtered so a path renamed in one place and not the other fails loudly at import.
  throw new Error(`${path} is in the navigation but not in the route map`);
}

/**
 * The twelve product entries, in the order the design record fixes.
 *
 * Kept as the flat union of core and intelligence, because that is what "the product's screens"
 * means and several assertions are about exactly that set. The rail renders the groups.
 */
export const NAVIGATION: readonly Destination[] = ORDER.map(destination);

/**
 * The seven core product screens, in the recorded order.
 *
 * "Core" is the group heading the artifacts' sidebar uses, and the split is the one a person reads:
 * these answer a question about the weather somewhere, and the intelligence group below analyses it.
 */
export const CORE_NAVIGATION: readonly Destination[] = MVP_SCREENS.map((screen) => ({
  ...screen,
  status: "mvp" as const,
  icon: ICONS[screen.path] ?? "dashboard",
}));

/**
 * The intelligence section.
 *
 * A screen here carries `status: "intelligence"` once it is built and `"planned"` until then, and
 * the rail marks only the second. The marking goes away per screen rather than all at once: an
 * unmarked entry that leads to "not yet available" is a dead end in the primary navigation, and
 * five of them would read as a product that does not work rather than one still being built.
 */
export const INTELLIGENCE_NAVIGATION: readonly Destination[] = INTELLIGENCE_SCREENS.map(
  (screen) => ({
    ...screen,
    status: INTELLIGENCE_BUILT.includes(screen.path)
      ? ("intelligence" as const)
      : ("planned" as const),
    icon: ICONS[screen.path] ?? "explorer",
  }),
);

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

/**
 * Every destination the product can be *on*, whoever is looking.
 *
 * Wider than `NAVIGATION` on purpose. What the rail offers depends on who is asking — the account
 * group is offered to everybody and the administrative one only to an administrator — but "which
 * screen is this?" does not: a person standing on a route is standing on it either way, and the
 * answer decides the active state in the rail and the name in the top bar. Leaving the two extra
 * groups out meant `/plan` and `/admin/model-usage` had no active entry and no title, which is how
 * a section that was correctly offered still looked like it had not been reached.
 *
 * It carries no capability. This is a path-to-title map, and the administrative route refuses a
 * caller without the role whether or not this can name it.
 */
export const ALL_DESTINATIONS: readonly Destination[] = [
  ...NAVIGATION,
  ...ACCOUNT_NAVIGATION,
  ...ADMIN_NAVIGATION,
];

/** The destination whose route the given path is on, or null for a path outside the model. */
export function destinationFor(pathname: string): Destination | null {
  // Longest path first, so `/` does not claim `/analyst`.
  const candidates = [...ALL_DESTINATIONS].sort(
    (one, other) => other.path.length - one.path.length,
  );
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
