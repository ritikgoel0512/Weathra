/**
 * The shell — task 20.12's verification.
 *
 * What the task names: every MVP product screen is reachable, the signed-in identity is shown, and
 * a post-MVP route renders its not-yet-available state. Those are the first three groups below.
 * The rest cover the parts that are easy to get wrong and invisible when they are: the active
 * route's `aria-current`, the drawer's expanded state and its Escape key, the skip link, and the
 * fact that a planned entry's marking is *words* and not only a chip.
 *
 * `usePathname` is mocked because it is Next's router, not Weathra's: the shell's contract is that
 * it marks whichever destination the router reports.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Identity } from "@/lib/auth/identity";
import { SessionBoundary } from "@/lib/session/provider";
import { NAVIGATION } from "@/lib/navigation";
import {
  ADMIN_MODEL_USAGE_PATH,
  INTELLIGENCE_BUILT,
  MVP_SCREENS,
  POST_MVP_SCREENS,
} from "@/lib/routes";

import { AppShell } from "./app-shell";
import { RouteStatus } from "./route-status";

const pathname = vi.fn<() => string>(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * A link in the persistent rail.
 *
 * The top bar's breadcrumb names the Dashboard too — `01-dashboard.png` shows both — so a global
 * query for a link called "Dashboard" is ambiguous by design rather than by accident. These
 * assertions are about the rail, so they ask the rail.
 */
function navLink(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Weathra" })).getByRole("link", { name });
}

const IDENTITY: Identity = {
  name: "sam@example.test",
  email: null,
  monogram: "S",
  known: true,
};

beforeEach(() => {
  pathname.mockReturnValue("/");
});

/**
 * The shell as it is actually mounted — inside the session boundary.
 *
 * It moved there so the rail's SAVED LOCATIONS section can ask the backend for the person's places
 * (`components/shell/protected-frame.tsx`), which means the shell now needs the query layer and the
 * API client the boundary provides. The boundary takes an injected `fetch`, so these tests answer
 * the one request the rail makes with an empty list: none of them is about saved places, and an
 * empty list is the state a new account is in.
 */
beforeEach(() => {
  // The rail builds an API client, which reads its base URL from the public environment.
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
});

function renderShell(identity: Identity = IDENTITY, locations: unknown[] = []) {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "test-token"}
      fetch={async () =>
        new Response(JSON.stringify({ count: locations.length, limit: 20, locations }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
    >
      <AppShell identity={identity} signOutControl={<button type="submit">Sign out</button>}>
        <h1>Screen content</h1>
      </AppShell>
    </SessionBoundary>,
  );
}

describe("the shell frame", () => {
  it("renders one named navigation region and one main region", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Weathra" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders the screen into the main region", () => {
    renderShell();
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Screen content" }),
    ).toBeInTheDocument();
  });

  it("carries the brand as a link home", () => {
    renderShell();
    for (const brand of screen.getAllByRole("link", { name: "Weathra" })) {
      expect(brand).toHaveAttribute("href", "/");
    }
  });

  it("offers a skip link that targets the main region", () => {
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    const target = skip.getAttribute("href")?.slice(1);
    expect(target).toBeTruthy();
    expect(screen.getByRole("main")).toHaveAttribute("id", target);
    // Focusable, or the link moves the viewport and leaves focus behind.
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
  });
});

describe("every MVP product screen is reachable", () => {
  it("links to all seven", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    for (const screenEntry of MVP_SCREENS) {
      const link = within(navigation).getByRole("link", { name: screenEntry.title });
      expect(link).toHaveAttribute("href", screenEntry.path);
    }
  });

  it("shows all twelve destinations, keeping the recorded order within each group", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    // The built destinations and the not-yet-built ones are now two groups rather than one flat
    // list — the product artifacts show a short primary navigation, and twelve equal entries did
    // not read as one. All twelve are still here and still links; what changed is the weight.
    const shown = within(navigation)
      .getAllByRole("link")
      .map((link) => link.textContent ?? "")
      .filter((text) => NAVIGATION.some((entry) => text.includes(entry.title)));

    for (const entry of NAVIGATION) {
      expect(shown.some((text) => text.includes(entry.title))).toBe(true);
    }

    // Within each group, the recorded order is unchanged.
    const positionOf = (title: string) => shown.findIndex((text) => text.includes(title));
    for (const status of ["mvp", "planned"] as const) {
      const group = NAVIGATION.filter((entry) => entry.status === status).map((e) => e.title);
      const positions = group.map(positionOf);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }

    // And every built destination is listed before every planned one.
    const lastBuilt = Math.max(
      ...NAVIGATION.filter((e) => e.status !== "planned").map((e) => positionOf(e.title)),
    );
    const firstPlanned = Math.min(
      ...NAVIGATION.filter((e) => e.status === "planned").map((e) => positionOf(e.title)),
    );
    expect(lastBuilt).toBeLessThan(firstPlanned);
  });

  it("caveats an unbuilt destination in words rather than with a badge", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    // Only the ones still unbuilt. `INTELLIGENCE_BUILT` grows per checkpoint, and an entry that
    // has become a screen must stop being caveated on the same day.
    const unbuilt = POST_MVP_SCREENS.filter(
      (screenRecord) => !INTELLIGENCE_BUILT.includes(screenRecord.path),
    );
    expect(unbuilt.length).toBeGreaterThan(0);

    for (const planned of unbuilt) {
      // The accessible name carries the marking, so it is not colour-and-chip only.
      const link = within(navigation).getByRole("link", {
        name: `${planned.title} — coming soon`,
      });
      expect(link).toHaveAttribute("href", planned.path);
      expect(link).toHaveAttribute("data-status", "planned");
    }
  });

  it("does not mark an MVP destination as planned", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    for (const mvp of MVP_SCREENS) {
      expect(within(navigation).getByRole("link", { name: mvp.title })).toHaveAttribute(
        "data-status",
        "mvp",
      );
    }
  });
});

describe("the active route", () => {
  it("marks the current destination and only that one", () => {
    pathname.mockReturnValue("/historical");
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    const current = within(navigation)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Historical Analytics");
    expect(current[0]).toHaveAttribute("data-active", "true");
  });

  it("marks the Dashboard on the root path without claiming every path", () => {
    pathname.mockReturnValue("/");
    const { unmount } = renderShell();
    expect(navLink("Dashboard")).toHaveAttribute("aria-current", "page");
    unmount();

    pathname.mockReturnValue("/compare");
    renderShell();
    expect(navLink("Dashboard")).not.toHaveAttribute("aria-current");
    expect(navLink("Compare Cities")).toHaveAttribute("aria-current", "page");
  });

  it("marks a destination for a path nested beneath it", () => {
    pathname.mockReturnValue("/evidence/run-1");
    renderShell();
    expect(screen.getByRole("link", { name: "Agent Evidence" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks nothing for a path outside the model", () => {
    pathname.mockReturnValue("/somewhere-else");
    renderShell();
    const marked = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(marked).toEqual([]);
  });
});

describe("the signed-in identity", () => {
  it("shows who is signed in, from the session", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(within(navigation).getByText("sam@example.test")).toBeInTheDocument();
  });

  it("shows a declared name with the address beneath it", () => {
    renderShell({ name: "Sam Okafor", email: "sam@example.test", monogram: "S", known: true });
    // The rail's identity panel. The top bar names the same person again, as the artifacts do, so
    // this is scoped rather than global — the address appears only here.
    const rail = within(screen.getByRole("navigation", { name: "Weathra" }));
    expect(rail.getByText("Sam Okafor")).toBeInTheDocument();
    expect(rail.getByText("sam@example.test")).toBeInTheDocument();
  });

  it("shows no invented persona, title or role", () => {
    renderShell();
    // The approved artifacts' filler: recorded as mockup content in docs/design/screens.md §5.
    expect(screen.queryByText(/Aris Thorne/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lead Meteorologist/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Neural Agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/v4\./)).not.toBeInTheDocument();
  });

  it("carries the sign-out control it was given", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(within(navigation).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("the drawer", () => {
  it("is closed to begin with, and says so", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps one name and reports its state, rather than renaming itself", () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });
    expect(control).toHaveAttribute("aria-expanded", "false");
  });

  it("owns the navigation it toggles", () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });
    expect(control.getAttribute("aria-controls")).toBe(
      screen.getByRole("navigation", { name: "Weathra" }).getAttribute("id"),
    );
  });

  it("opens and closes from its control", async () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });

    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Weathra" })).toHaveAttribute(
      "data-open",
      "true",
    );

    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("navigation", { name: "Weathra" })).not.toHaveAttribute("data-open");
  });

  it("closes on Escape", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a destination is followed", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers a labelled way out of an open drawer", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    // The scrim behind the drawer: a tap anywhere outside closes it, and it says so.
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();
  });
});

describe("a route with no screen yet", () => {
  it("states plainly that a planned destination is not yet available", () => {
    render(<RouteStatus title="Weather Watch" status="planned" />);
    expect(screen.getByRole("heading", { name: "Weather Watch" })).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.getByText(/not yet available\./)).toBeInTheDocument();
  });

  it("says something different about an MVP screen that is not built", () => {
    render(<RouteStatus title="Dashboard" status="in-progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText(/not built yet/)).toBeInTheDocument();
    expect(screen.queryByText("Not yet available")).not.toBeInTheDocument();
  });

  it("renders neither a broken nor an empty interface", () => {
    render(
      <RouteStatus title="Travel Intelligence" status="planned">
        Weather intelligence along a route.
      </RouteStatus>,
    );
    const heading = screen.getByRole("heading", { name: "Travel Intelligence" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("Weather intelligence along a route.")).toBeInTheDocument();
  });
});

/* ------------------------------------------------- the administrative section */

/**
 * The rail offers Admin only to a principal the backend says holds the role — checkpoint B.
 *
 * The offer is a presentation convenience and the tests say so both ways: an ordinary person is
 * offered nothing, an administrator is offered a real link, and neither fact comes from anything
 * the browser could be told about itself.
 */
function renderShellAs(me: Record<string, unknown>) {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "test-token"}
      fetch={async (input: string) =>
        new Response(
          JSON.stringify(
            String(input).includes("/me/locations")
              ? { count: 0, limit: 20, locations: [] }
              : me,
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
    >
      <AppShell identity={IDENTITY} signOutControl={<button type="submit">Sign out</button>}>
        <h1>Screen content</h1>
      </AppShell>
    </SessionBoundary>,
  );
}

const ORDINARY = {
  user_id: "00000000-0000-4000-8000-000000000001",
  email_verified: true,
  profile_created_at: "2026-08-01T09:00:00Z",
  last_seen_at: "2026-09-10T09:00:00Z",
  created_now: false,
  administrative: false,
  preferences: { unit_system: "metric", forecast_horizon_days: 7, sources: {} },
};

describe("the administrative section of the rail", () => {
  it("is not offered to an ordinary authenticated person", async () => {
    renderShellAs(ORDINARY);
    // Wait for the rail to have rendered its model — a built entry every person has — so the
    // absence below is a real absence rather than a render that had not happened yet.
    await screen.findByRole("link", { name: "Dashboard" });

    expect(screen.queryByRole("heading", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Model & AI Usage/ })).toBeNull();
  });

  it("is offered to a principal the backend reports as administrative", async () => {
    renderShellAs({ ...ORDINARY, administrative: true });

    expect(await screen.findByRole("heading", { name: "Admin" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Model & AI Usage" });
    // A real link to the real route: openable in a new tab, announced as navigation, and no
    // hidden URL for an administrator to have to know.
    expect(link).toHaveAttribute("href", "/admin/model-usage");
  });

  it("offers nothing when the capability cannot be read", async () => {
    // The safe direction: an administrator waits a moment, everybody else is never offered it.
    renderShellAs({});
    await screen.findByRole("link", { name: "Dashboard" });

    expect(screen.queryByRole("heading", { name: "Admin" })).toBeNull();
  });

  it("marks the administrative entry as the page you are on", async () => {
    // The gap this closes: the section was offered correctly, but nothing in it was ever marked
    // active, because the active-state lookup only knew the destinations everybody sees. A section
    // you can reach but that never lights up reads as a link that did not work.
    pathname.mockReturnValue(ADMIN_MODEL_USAGE_PATH);
    renderShellAs({ ...ORDINARY, administrative: true });

    const link = await screen.findByRole("link", { name: "Model & AI Usage" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("is in the one navigation the drawer and the rail share", async () => {
    // Not a second navigation system: the shell renders one <nav>, and the header's menu button
    // opens that same element on a narrow viewport. So an administrator gets the entry on a phone
    // by the same code path, and a person without the role gets it on neither.
    renderShellAs({ ...ORDINARY, administrative: true });
    const link = await screen.findByRole("link", { name: "Model & AI Usage" });

    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(navigation.contains(link)).toBe(true);
    expect(screen.getByRole("button", { name: /menu/i })).toHaveAttribute(
      "aria-controls",
      navigation.id,
    );
  });

  it("survives a remount, which is what a refresh is", async () => {
    // A refresh re-resolves the session server-side and mounts the shell again; the capability is
    // read from the backend each time rather than remembered anywhere, so there is nothing to go
    // stale and nothing to restore.
    const first = renderShellAs({ ...ORDINARY, administrative: true });
    await screen.findByRole("heading", { name: "Admin" });
    first.unmount();

    renderShellAs({ ...ORDINARY, administrative: true });
    expect(await screen.findByRole("heading", { name: "Admin" })).toBeInTheDocument();
  });

  it("is gone once the session is not administrative any more", async () => {
    // Sign-out leaves the `(app)` group entirely and an expired session replaces the shell with the
    // expired state, so neither can leave this on screen. What this covers is the remaining case:
    // the same shell mounted for a session that does not hold the role shows nothing.
    const asAdmin = renderShellAs({ ...ORDINARY, administrative: true });
    await screen.findByRole("heading", { name: "Admin" });
    asAdmin.unmount();

    renderShellAs(ORDINARY);
    await screen.findByRole("link", { name: "Dashboard" });
    expect(screen.queryByRole("heading", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Model & AI Usage" })).toBeNull();
  });

  it("closes the drawer when an administrator follows it on a narrow viewport", async () => {
    // The mobile behaviour that makes the entry usable rather than merely present: the drawer is
    // the same <nav>, so following a link inside it has to dismiss it, exactly as the product
    // entries above already do.
    const person = userEvent.setup();
    renderShellAs({ ...ORDINARY, administrative: true });
    await screen.findByRole("link", { name: "Model & AI Usage" });

    await person.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("navigation", { name: "Weathra" })).toHaveAttribute(
      "data-open",
      "true",
    );

    await person.click(screen.getByRole("link", { name: "Model & AI Usage" }));
    expect(screen.getByRole("navigation", { name: "Weathra" })).not.toHaveAttribute("data-open");
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers only administrative surfaces that are actually implemented", async () => {
    renderShellAs({ ...ORDINARY, administrative: true });
    await screen.findByRole("heading", { name: "Admin" });

    // One panel exists. An entry per planned administrative surface would advertise a control
    // plane Weathra does not have.
    const section = screen.getByRole("heading", { name: "Admin" }).closest("section");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getAllByRole("link")).toHaveLength(1);
  });
});
