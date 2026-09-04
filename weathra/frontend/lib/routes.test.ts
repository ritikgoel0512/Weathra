/**
 * The route map is the authentication boundary in machine-readable form, so what it contains is
 * worth asserting directly: `specs/web-ui` names seven MVP product screens and five post-MVP ones,
 * and a screen missing from this table is a screen the navigation cannot reach (task 20.12) even
 * though the gate still protects it.
 */

import { describe, expect, it } from "vitest";

import {
  AUTH_CONFIRM_PATH,
  AUTH_SCREENS,
  completesAuthFlow,
  EVIDENCE_PATH,
  evidencePath,
  isAuthPath,
  isProtectedPath,
  isPublicPath,
  MVP_SCREENS,
  POST_MVP_SCREENS,
  safeDestination,
  signInPathFor,
} from "./routes";

describe("the route map", () => {
  it("lists the seven MVP product screens the spec names", () => {
    expect(MVP_SCREENS.map(({ title }) => title)).toEqual([
      "Dashboard",
      "AI Weather Analyst",
      "Historical Analytics",
      "Compare Cities",
      "Agent Evidence",
      "Saved Locations",
      "Settings",
    ]);
  });

  it("reserves routing structure for the five post-MVP screens", () => {
    expect(POST_MVP_SCREENS.map(({ title }) => title)).toEqual([
      "Weather Intelligence Report",
      "Forecast Explorer",
      "Weather Scenario Lab",
      "Weather Watch",
      "Travel Intelligence",
    ]);
  });

  it("protects every product route, MVP and post-MVP alike", () => {
    for (const { path } of [...MVP_SCREENS, ...POST_MVP_SCREENS]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it("leaves the authentication screens public", () => {
    for (const { path } of AUTH_SCREENS) {
      expect(isPublicPath(path), path).toBe(true);
      expect(isAuthPath(path), path).toBe(true);
    }
  });

  it("protects anything not explicitly made public", () => {
    expect(isProtectedPath("/a-screen-added-next-month")).toBe(true);
    expect(isProtectedPath("/settings/notifications")).toBe(true);
  });

  it("does not let a public prefix leak protection away from a nested route", () => {
    // `/sign-in-preview` is not `/sign-in`, and must not inherit its public treatment by prefix.
    expect(isPublicPath("/sign-in-preview")).toBe(false);
    expect(isPublicPath("/sign-in/help")).toBe(true);
  });
});

describe("a destination read back from the sign-in URL", () => {
  it("accepts a path on this origin", () => {
    expect(safeDestination("/compare?a=Berlin")).toBe("/compare?a=Berlin");
  });

  it("rejects anything a browser would read as another origin", () => {
    for (const hostile of [
      "//evil.example",
      "https://evil.example",
      "http://evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeDestination(hostile), hostile).toBeNull();
    }
  });

  it("rejects nothing at all", () => {
    expect(safeDestination(null)).toBeNull();
    expect(safeDestination("")).toBeNull();
  });
});

describe("the sign-in path for a gated request", () => {
  it("carries the destination, encoded", () => {
    expect(signInPathFor("/evidence/abc", "?tab=tools")).toBe(
      "/sign-in?next=%2Fevidence%2Fabc%3Ftab%3Dtools",
    );
  });

  it("omits a destination that is where sign-in lands anyway", () => {
    expect(signInPathFor("/")).toBe("/sign-in");
  });
});

describe("the returning-link callback", () => {
  it("is public, and is not one of the authentication screens", () => {
    // Someone following a verification link has no session yet — completing the link is how they
    // get one — but the route is a handler, not a screen the gate should redirect people off.
    expect(isPublicPath(AUTH_CONFIRM_PATH)).toBe(true);
    expect(isProtectedPath(AUTH_CONFIRM_PATH)).toBe(false);
    expect(isAuthPath(AUTH_CONFIRM_PATH)).toBe(false);
  });

  it("names the two screens a completed flow may leave somebody on, and only those", () => {
    expect(completesAuthFlow("/verify-email", new URLSearchParams("completed=verification"))).toBe(true);
    expect(completesAuthFlow("/reset-password", new URLSearchParams("completed=recovery"))).toBe(true);

    // A marker for the wrong screen, the wrong flow, or no marker at all changes nothing.
    expect(completesAuthFlow("/verify-email", new URLSearchParams("completed=recovery"))).toBe(false);
    expect(completesAuthFlow("/reset-password", new URLSearchParams("completed=verification"))).toBe(false);
    expect(completesAuthFlow("/sign-in", new URLSearchParams("completed=verification"))).toBe(false);
    expect(completesAuthFlow("/verify-email", new URLSearchParams())).toBe(false);
  });
});

describe("the evidence route", () => {
  it("addresses one stored run under the navigation destination", () => {
    expect(EVIDENCE_PATH).toBe("/evidence");
    expect(evidencePath("2f0a9c1e-6c1f-4f0e-9b6b-9d0f6b7f1a23")).toBe(
      "/evidence/2f0a9c1e-6c1f-4f0e-9b6b-9d0f6b7f1a23",
    );
  });

  it("encodes the identifier so it can never add a segment of its own", () => {
    expect(evidencePath("a/b")).toBe("/evidence/a%2Fb");
    expect(evidencePath("../settings")).toBe("/evidence/..%2Fsettings");
  });

  it("stays a protected path, with and without a record", () => {
    expect(isProtectedPath(EVIDENCE_PATH)).toBe(true);
    expect(isProtectedPath(evidencePath("run-1"))).toBe(true);
  });
});
