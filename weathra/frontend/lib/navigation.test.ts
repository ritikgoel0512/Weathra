/**
 * The navigation model against the two things that fix it: the route map, and the design record.
 *
 * The risk this covers is a navigation that drifts — an entry invented because a mockup showed one,
 * a screen dropped because nobody noticed, an order that stopped matching the approved design. All
 * three are silent failures in a hand-written list of links, so the list is a model and this
 * asserts it against `lib/routes.ts` and against `docs/design/design-system.md` §5.
 *
 * The last test is reachability, which is the one task 20.12 names: every entry resolves to a page
 * file that exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADMIN_MODEL_USAGE_PATH, PLAN_USAGE_PATH } from "@/lib/routes";

import {
  ADMIN_NAVIGATION,
  ALL_DESTINATIONS,
  NAVIGATION,
  destinationFor,
  isActive,
} from "./navigation";
import { MVP_SCREENS, POST_MVP_SCREENS } from "./routes";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * A path under the frontend root.
 *
 * `join(process.cwd(), …)` rather than `new URL(…, import.meta.url)`: Vite rewrites the latter at
 * transform time as an asset reference, and a template literal with a computed segment resolves to
 * the string "undefined" instead of a file. Vitest runs with the frontend root as its working
 * directory, which is what makes this the reliable form for a path built from data.
 */
function projectPath(...segments: string[]): string {
  return join(process.cwd(), ...segments);
}

const RECORD = read("../../docs/design/design-system.md");

/** The twelve rows of the navigation table in §5, in the order the record lists them. */
function recordedNavigation(): { position: number; title: string; planned: boolean }[] {
  const rows: { position: number; title: string; planned: boolean }[] = [];
  for (const line of RECORD.split("\n")) {
    const match = /^\| (\d+) \| ([^|]+?) \| ([^|]+?) \|$/.exec(line.trim());
    if (!match) continue;
    const [, position, title, status] = match;
    if (!position || !title || !status) continue;
    rows.push({
      position: Number(position),
      title: title.trim(),
      planned: status.includes("Post-MVP"),
    });
  }
  return rows;
}

describe("the navigation model", () => {
  it("has the twelve entries the design record fixes, in that order", () => {
    const recorded = recordedNavigation();
    expect(recorded).toHaveLength(12);
    expect(recorded.map((row) => row.position)).toEqual([...Array(12)].map((_, i) => i + 1));

    expect(NAVIGATION.map((entry) => entry.title)).toEqual(recorded.map((row) => row.title));
  });

  it("marks as planned exactly the entries the record marks as post-MVP", () => {
    const recorded = recordedNavigation();
    NAVIGATION.forEach((entry, index) => {
      const row = recorded[index];
      expect(row).toBeDefined();
      expect(entry.status, `${entry.title} has the wrong status`).toBe(
        row?.planned ? "planned" : "mvp",
      );
    });
  });

  it("invents no destination and drops none", () => {
    const routed = [...MVP_SCREENS, ...POST_MVP_SCREENS];
    expect(NAVIGATION).toHaveLength(routed.length);

    const navigated = new Set(NAVIGATION.map((entry) => entry.path));
    for (const screen of routed) {
      expect(navigated, `${screen.title} is routed but not navigable`).toContain(screen.path);
    }
    for (const entry of NAVIGATION) {
      expect(routed.map((screen) => screen.path)).toContain(entry.path);
    }
  });

  it("takes each entry's title and path from the route map rather than restating them", () => {
    const routed = new Map([...MVP_SCREENS, ...POST_MVP_SCREENS].map((s) => [s.path, s.title]));
    for (const entry of NAVIGATION) {
      expect(entry.title).toBe(routed.get(entry.path));
    }
  });

  it("gives every entry its own icon", () => {
    const icons = NAVIGATION.map((entry) => entry.icon);
    expect(new Set(icons).size).toBe(NAVIGATION.length);
    for (const icon of icons) {
      expect(read("../components/shell/icons.tsx")).toContain(`${icon}:`);
    }
  });

  it("does not advertise the administrative or plan screens", () => {
    // `docs/design/roadmap.md` keeps both out of the navigation while they are unbuilt.
    for (const entry of NAVIGATION) {
      expect(entry.title).not.toMatch(/Admin|Plan & Usage/);
    }
  });
});

describe("the active destination", () => {
  it("resolves a path to the destination it belongs to", () => {
    expect(destinationFor("/")?.title).toBe("Dashboard");
    expect(destinationFor("/analyst")?.title).toBe("AI Weather Analyst");
    expect(destinationFor("/settings")?.title).toBe("Settings");
  });

  it("keeps the Dashboard from claiming every path", () => {
    // `/` is a prefix of everything, so a naive prefix match makes every screen the Dashboard.
    expect(destinationFor("/evidence")?.path).toBe("/evidence");
    expect(destinationFor("/evidence/run-1")?.path).toBe("/evidence");
  });

  it("treats a nested path as its destination", () => {
    const evidence = NAVIGATION.find((entry) => entry.path === "/evidence");
    expect(evidence).toBeDefined();
    if (evidence) {
      expect(isActive(evidence, "/evidence/run-1")).toBe(true);
      expect(isActive(evidence, "/evidencex")).toBe(false);
    }
  });

  it("has no active destination outside the model", () => {
    expect(destinationFor("/sign-in")).toBeNull();
    expect(destinationFor("/nothing-here")).toBeNull();
  });

  it("makes exactly one entry active for each destination's own path", () => {
    for (const entry of NAVIGATION) {
      const active = NAVIGATION.filter((candidate) => isActive(candidate, entry.path));
      expect(active.map((one) => one.path)).toEqual([entry.path]);
    }
  });
});

describe("every destination is reachable", () => {
  for (const entry of NAVIGATION) {
    it(`${entry.title} has a page at ${entry.path}`, () => {
      const directory = entry.path === "/" ? "." : entry.path;
      const file = projectPath("app", "(app)", directory, "page.tsx");
      expect(existsSync(file), `${file} is missing`).toBe(true);
    });
  }

  it("puts every destination inside the protected route group", () => {
    // A page outside `(app)/` would be a product screen with no session gate on it.
    for (const entry of NAVIGATION) {
      const directory = entry.path === "/" ? "." : entry.path;
      expect(existsSync(projectPath("app", directory, "page.tsx"))).toBe(false);
    }
  });
});

describe("the destinations a person can be standing on", () => {
  it("includes the account and administrative groups, not only what everybody sees", () => {
    // What the rail *offers* depends on who is asking; which screen you are *on* does not. Leaving
    // these out left `/plan` and `/admin/model-usage` with no active entry and no title.
    expect(ALL_DESTINATIONS.map((entry) => entry.path)).toContain(PLAN_USAGE_PATH);
    expect(ALL_DESTINATIONS.map((entry) => entry.path)).toContain(ADMIN_MODEL_USAGE_PATH);
  });

  it("names the administrative route, so the rail can mark it and the top bar can title it", () => {
    expect(destinationFor(ADMIN_MODEL_USAGE_PATH)?.title).toBe("Model & AI Usage");
    expect(destinationFor(PLAN_USAGE_PATH)?.title).toBe("Plan & Usage");
  });

  it("marks the administrative entry active on its own route and on no other", () => {
    const admin = ADMIN_NAVIGATION[0]!;
    expect(isActive(admin, ADMIN_MODEL_USAGE_PATH)).toBe(true);
    expect(isActive(admin, PLAN_USAGE_PATH)).toBe(false);
    expect(isActive(admin, "/")).toBe(false);
  });

  it("still answers null for a path outside the product", () => {
    expect(destinationFor("/sign-in")).toBeNull();
    expect(destinationFor("/nothing-here")).toBeNull();
  });
});
