/**
 * The two routes that exist without a screen behind them — task 33.4.
 *
 * `specs/web-ui` asks for three things from Admin Model & AI Usage and Plan & Usage in this
 * change, and they pull in different directions:
 *
 * 1. The route resolves and says plainly that the screen is not yet available.
 * 2. It renders nothing broken and nothing empty.
 * 3. **No catalog, usage, cost or lab request is issued** — for *any* visitor, not only for a
 *    person without the administrative role.
 *
 * The third is the one worth testing carefully, because it is the one an implementation drifts
 * away from: a page that fetches "just the catalog, to show what will be here" satisfies the first
 * two and breaks the requirement. So it is asserted twice, from opposite directions — nothing
 * reaches the network when the page renders, and the module has no way to reach it — and the
 * second assertion is the one that survives a page later becoming a client component.
 */

import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_MODEL_USAGE_PATH,
  PLAN_USAGE_PATH,
  UNLISTED_SCREENS,
  isProtectedPath,
} from "@/lib/routes";
import { NAVIGATION } from "@/lib/navigation";

import AdminModelUsagePage from "./admin/model-usage/page";
import PlanUsagePage from "./plan/page";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const PAGES = [
  {
    path: ADMIN_MODEL_USAGE_PATH,
    title: "Admin Model & AI Usage",
    Page: AdminModelUsagePage,
    file: "./admin/model-usage/page.tsx",
  },
  {
    path: PLAN_USAGE_PATH,
    title: "Plan & Usage",
    Page: PlanUsagePage,
    file: "./plan/page.tsx",
  },
] as const;

/**
 * Every path that would carry administrative or usage content, by prefix.
 *
 * From `docs/api.md`: the administrative control plane is under `/api/v1/admin/`, and a person's
 * own plan and consumption is `/api/v1/me/usage`. A request to any of them from either of these
 * routes is the failure this test exists for.
 */
const FORBIDDEN_PATHS = ["/api/v1/admin", "/api/v1/me/usage"] as const;

describe("the unlisted post-MVP routes", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error("no request may be issued from these routes")));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(PAGES)("$title states that it is not yet available", ({ Page, title }) => {
    render(<Page />);

    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.getByText(/This screen is not yet available/)).toBeInTheDocument();
  });

  it.each(PAGES)("$title renders nothing broken and nothing empty", ({ Page }) => {
    const { container } = render(<Page />);

    // Not an empty shell: there is a heading, a status and prose, and no failure state.
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(80);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(PAGES)("$title issues no request when it renders", ({ Page }) => {
    render(<Page />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(PAGES)("$title has no way to reach the network at all", ({ file }) => {
    const text = source(file);

    // The stronger form of the assertion above: not "it did not fetch this time", but "there is
    // nothing here that could". An ordinary authenticated person opening the administrative route
    // triggers no administrative request because the module holds no client, not because a
    // condition inside it declined to use one.
    for (const forbidden of FORBIDDEN_PATHS) {
      expect(text).not.toContain(forbidden);
    }
    for (const reach of ["useApiQuery", "useApiClient", "createApiClient", "fetch(", "createClient"]) {
      expect(text, `${file} references ${reach}`).not.toContain(reach);
    }
  });

  it.each(PAGES)("$title renders no administrative or usage content", ({ Page }) => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";

    // No catalog entry, no figure, no plan standing: the prose says what the screen will hold,
    // which is not the same as holding it.
    expect(text).not.toMatch(/\d+(\.\d+)?\s*(tokens|ms|%)/i);
    expect(text).not.toMatch(/\$\d/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps both out of the navigation while they are unbuilt", () => {
    // `docs/design/roadmap.md`, "Not in the navigation". Reachable by route; not advertised.
    for (const unlisted of UNLISTED_SCREENS) {
      expect(NAVIGATION.map((entry) => entry.path)).not.toContain(unlisted.path);
      expect(NAVIGATION.map((entry) => entry.title)).not.toContain(unlisted.title);
    }
  });

  it("protects both routes by the same default as every other screen", () => {
    for (const unlisted of UNLISTED_SCREENS) {
      expect(isProtectedPath(unlisted.path), unlisted.path).toBe(true);
    }
    // And the segment grants nothing: a nested administrative path is protected too.
    expect(isProtectedPath(`${ADMIN_MODEL_USAGE_PATH}/anything`)).toBe(true);
  });

  it("names the two screens `specs/web-ui` leaves out of the sidebar", () => {
    expect(UNLISTED_SCREENS.map(({ title }) => title)).toEqual([
      "Admin Model & AI Usage",
      "Plan & Usage",
    ]);
  });
});
