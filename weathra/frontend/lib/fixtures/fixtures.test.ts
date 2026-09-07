/**
 * The fixture flag, and what it may and may not do.
 *
 * `lib/fixtures/visily.ts` holds sample weather transcribed from the design mockups so a rendered
 * screen can be compared against one. That is a useful thing to have and a dangerous thing to leak,
 * so the boundary is asserted rather than trusted:
 *
 * - it is **off** unless a build set the flag to exactly `"true"`;
 * - no other value turns it on;
 * - it is **build-time**, so nothing a request carries can reach it.
 *
 * The screen-level guarantee — that `Dashboard` renders the real briefing when the flag is unset —
 * is covered by `components/dashboard/dashboard.test.tsx`, which runs with no flag set and asserts
 * the backend's own figures appear.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DASHBOARD_FIXTURE, usingVisilyFixtures } from "./visily";

const original = process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES;

afterEach(() => {
  process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES = original;
});

describe("the Visily fixture flag", () => {
  it("is off when nothing sets it", () => {
    delete process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES;
    expect(usingVisilyFixtures()).toBe(false);
  });

  it("is off for every value but the exact opt-in", () => {
    for (const value of ["", "false", "1", "yes", "TRUE", "true "]) {
      process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES = value;
      expect(usingVisilyFixtures(), `"${value}" must not enable fixtures`).toBe(false);
    }
  });

  it("is on only for the exact opt-in", () => {
    process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES = "true";
    expect(usingVisilyFixtures()).toBe(true);
  });

  it("reads a NEXT_PUBLIC_ flag, which Next inlines at build time", () => {
    // The property that matters: the switch is decided when the bundle is built, so no request —
    // no query parameter, header or cookie — can turn fixtures on in a deployed build.
    const source = usingVisilyFixtures.toString();
    expect(source).toContain("NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES");
  });
});

describe("the fixture content", () => {
  it("is the mockup's sample state, not a measurement", () => {
    // Transcribed from `01-dashboard.png`. Asserted so an accidental edit toward "realistic" values
    // is a failing test rather than a quiet drift into looking like real output.
    expect(DASHBOARD_FIXTURE.temperature).toBe("18");
    expect(DASHBOARD_FIXTURE.station).toBe("BER-CENTRAL-09");
    expect(DASHBOARD_FIXTURE.days).toHaveLength(7);
  });

  it("carries the sample-data disclosure the artifact itself prints", () => {
    expect(DASHBOARD_FIXTURE.footerSample).toMatch(/SAMPLE DATA/);
    expect(DASHBOARD_FIXTURE.confidenceFootnote).toMatch(/Sample data/);
  });
});
