/**
 * The product survives fidelity mode.
 *
 * An earlier fidelity pass made the rendered sidebar match `01-dashboard.png` by replacing the
 * navigation model with the artifact's four-entry list. That matched the picture and removed eight
 * of Weathra's twelve destinations from the application, renamed Historical Analytics to a generic
 * "Analytics", and pointed two entries at one route.
 *
 * These are the assertions that would have caught it. They run in *both* modes on purpose: the
 * point is not that fixture mode is configured a particular way, it is that the product's shape
 * cannot be traded away for a screenshot again. Where fixture mode is allowed to differ — a
 * workspace label, a decorative bell — that is asserted too, so the boundary is recorded rather
 * than assumed.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MVP_SCREENS, POST_MVP_SCREENS } from "@/lib/routes";
import { NAVIGATION } from "@/lib/navigation";

import { Navigation } from "./navigation";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

/** The complete set, from the route map rather than from a list written here. */
const EVERY_DESTINATION = [...MVP_SCREENS, ...POST_MVP_SCREENS];

describe("the complete Weathra navigation", () => {
  it("offers every destination the route map declares, and no others", () => {
    render(<Navigation />);
    const links = screen.getAllByRole("link");

    // Twelve, not four. The count is asserted so a silently dropped entry fails here.
    expect(links).toHaveLength(EVERY_DESTINATION.length);
    expect(NAVIGATION).toHaveLength(EVERY_DESTINATION.length);

    for (const screenRecord of EVERY_DESTINATION) {
      const link = links.find((candidate) => candidate.getAttribute("href") === screenRecord.path);
      expect(link, `no navigation entry for ${screenRecord.path}`).toBeDefined();
    }
  });

  it("names each destination by its product name", () => {
    render(<Navigation />);

    // The exact titles the route map fixes — including "Historical Analytics", which an earlier
    // pass rendered as the generic "Analytics".
    for (const screenRecord of EVERY_DESTINATION) {
      const link = screen.getByRole("link", { name: new RegExp(screenRecord.title, "i") });
      expect(link.getAttribute("href")).toBe(screenRecord.path);
    }

    expect(screen.queryByRole("link", { name: /^Analytics$/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Historical Data$/ })).toBeNull();
  });

  it("gives each destination exactly one entry", () => {
    render(<Navigation />);
    const paths = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    // The fixture list pointed both "Analytics" and "Historical Data" at `/historical`.
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps the planned destinations visible, and says they are planned", () => {
    render(<Navigation />);

    for (const planned of POST_MVP_SCREENS) {
      const link = screen.getByRole("link", { name: new RegExp(planned.title, "i") });
      expect(link.getAttribute("href")).toBe(planned.path);
      expect(link.getAttribute("data-status")).toBe("planned");
      // The status is in the accessible name, not only in a visual mark.
      expect(link).toHaveAccessibleName(/not yet available/i);
    }

    expect(POST_MVP_SCREENS.length).toBeGreaterThan(0);
  });

  it("groups the planned ones under their own heading rather than hiding them", () => {
    render(<Navigation />);
    const group = screen.getByRole("region", { name: /planned/i });
    for (const planned of POST_MVP_SCREENS) {
      expect(within(group).getByRole("link", { name: new RegExp(planned.title, "i") })).toBeTruthy();
    }
  });
});

describe("the active entry is the route you are on", () => {
  it.each([
    ["/", "Dashboard"],
    ["/analyst", "AI Weather Analyst"],
    ["/historical", "Historical Analytics"],
    ["/compare", "Compare Cities"],
    ["/evidence", "Agent Evidence"],
    ["/locations", "Saved Locations"],
    ["/settings", "Settings"],
  ])("marks %s as %s", async (pathname, title) => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      usePathname: () => pathname,
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ push: vi.fn() }),
    }));
    const { Navigation: Fresh } = await import("./navigation");
    render(<Fresh />);

    const active = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("data-active") === "true");

    // Exactly one, and it is the right one.
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("href")).toBe(pathname);
    expect(active[0]).toHaveAccessibleName(new RegExp(title, "i"));
    expect(active[0]?.getAttribute("aria-current")).toBe("page");
  });
});

describe("the breadcrumb identifies the screen, not the workspace", () => {
  /**
   * An earlier fidelity pass printed the artifacts' constant second segment — "Meteorology
   * Analytics" — as the final crumb on every route, so the trail said the same thing everywhere
   * and told you nothing about where you were. The label is a workspace name; it is kept, beside
   * the trail rather than in place of the screen.
   */
  const cases: readonly [string, string][] = [
    ["/analyst", "AI Weather Analyst"],
    ["/historical", "Historical Analytics"],
    ["/compare", "Compare Cities"],
    ["/evidence", "Agent Evidence"],
    ["/locations", "Saved Locations"],
    ["/settings", "Settings"],
  ];

  it.each(cases)("ends at the screen's own name on %s", async (pathname, title) => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      usePathname: () => pathname,
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ push: vi.fn() }),
    }));
    const { TopBar } = await import("./top-bar");
    render(<TopBar identity={{ name: "Sam Reed", monogram: "SR", email: "sam@example.test", known: true }} />);

    const trail = screen.getByRole("navigation", { name: /breadcrumb/i });
    const current = within(trail).getByText(title);
    expect(current.getAttribute("aria-current")).toBe("page");
    // The first crumb is still the Dashboard, as every artifact shows.
    expect(within(trail).getByRole("link", { name: /Dashboard/i })).toBeTruthy();
    /*
     * The workspace label is never the screen's identity. In production it is not rendered at all
     * (null here); in fidelity mode it sits beside the trail and must still not be the current
     * page. Both are acceptable; being the current page is not.
     */
    const workspace = within(trail).queryByText(/^Meteorology Analytics$/);
    if (workspace) expect(workspace.getAttribute("aria-current")).not.toBe("page");
  });

  it("says only Dashboard on the Dashboard", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ push: vi.fn() }),
    }));
    const { TopBar } = await import("./top-bar");
    render(<TopBar identity={{ name: "Sam Reed", monogram: "SR", email: "sam@example.test", known: true }} />);

    const trail = screen.getByRole("navigation", { name: /breadcrumb/i });
    const crumbs = within(trail).getAllByRole("listitem");
    expect(crumbs).toHaveLength(1);
    expect(within(trail).getByText("Dashboard").getAttribute("aria-current")).toBe("page");
  });
});
