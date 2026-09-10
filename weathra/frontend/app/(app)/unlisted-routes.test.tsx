/**
 * The administrative route — task 33.4, revised for tasks 34.5 and 34.9.
 *
 * Plan & Usage used to be tested here as the other route with no screen behind it. It has one now
 * (task 34.10), so its suite lives with the screen in `components/plan/plan-usage.test.tsx`; what
 * remains of it here is the navigation and protection assertions at the bottom, which still cover
 * both routes.
 *
 * **Admin Model & AI Usage carries a narrower guarantee than it did, and the difference is a
 * requirement rather than a relaxation.** `specs/web-ui`'s *Administrative model policy confirmation* names one
 * panel of that screen as implemented in this change: the audited candidate-list confirmation task
 * 34.5 depends on. So the route does load something, and what it may load is exactly bounded —
 * policies, catalog observations, comparison runs and one policy's audit trail, every one of them a
 * read the backend refuses without the administrative role. What it still may not load is the
 * unbuilt panels' data: no token usage, no cost, no per-plan consumption, for anybody.
 *
 * The two assertions that matter for the new shape are therefore: an ordinary authenticated person
 * gets a not-permitted state with nothing behind it, and no usage or cost request is issued in any
 * state. The panel's own behaviour is tested in `components/admin/model-policy.test.tsx`.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";
import {
  ADMIN_MODEL_USAGE_PATH,
  PLAN_USAGE_PATH,
  UNLISTED_SCREENS,
  isProtectedPath,
} from "@/lib/routes";
import { ACCOUNT_NAVIGATION, ADMIN_NAVIGATION, NAVIGATION } from "@/lib/navigation";

import AdminModelUsagePage from "./admin/model-usage/page";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const ADMIN_FILES = [
  "./admin/model-usage/page.tsx",
  "../../components/admin/model-policy.tsx",
] as const;

/**
 * Every path that would carry the *unbuilt* panels' content.
 *
 * From `docs/api.md`: aggregate administrative usage and cost is `/api/v1/admin/usage`, and a
 * person's own plan and consumption is `/api/v1/me/usage`. Neither is any part of the policy
 * confirmation surface, and a request to either from this route is the failure this test exists
 * for — the panels they would feed are not built.
 */
const FORBIDDEN_PATHS = ["/api/v1/admin/usage", "/api/v1/me/usage"] as const;

/** Everything the confirmation surface is permitted to reach, and nothing else. */
const PERMITTED_ADMIN_METHODS = [
  "adminPolicies",
  "adminCatalog",
  "adminComparisons",
  "adminComparison",
  "confirmPolicyCandidates",
  "adminPolicyAudit",
] as const;

describe("Admin Model & AI Usage: one panel built, the rest stated as unbuilt", () => {
  /** A client that answers every administrative read the way the backend answers a non-admin. */
  function refusingClient(): ApiClient {
    const forbidden = () =>
      Promise.reject(
        new ApiError(403, {
          code: "forbidden",
          message: "This operation requires an administrative principal.",
        }),
      );
    return {
      adminPolicies: vi.fn(forbidden),
      adminCatalog: vi.fn(forbidden),
      adminComparisons: vi.fn(forbidden),
      adminComparison: vi.fn(forbidden),
      adminPolicyAudit: vi.fn(forbidden),
      confirmPolicyCandidates: vi.fn(forbidden),
      usage: vi.fn(() => Promise.reject(new Error("the unbuilt panels fetch nothing"))),
    } as unknown as ApiClient;
  }

  function mount(api: ApiClient) {
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <ApiProvider client={api}>
          <AdminModelUsagePage />
        </ApiProvider>
      </QueryClientProvider>,
    );
  }

  it("says which panels are not yet available", () => {
    mount(refusingClient());

    expect(screen.getByRole("heading", { name: "Admin Model & AI Usage" })).toBeInTheDocument();
    expect(
      screen.getByText(/Model status, token usage, estimated cost, latency, errors/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing about them is loaded here/)).toBeInTheDocument();
  });

  it("shows an ordinary authenticated person a not-permitted state with nothing behind it", async () => {
    mount(refusingClient());

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("Not permitted");
    expect(screen.queryByRole("button", { name: "Confirm candidate order" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Comparison run/)).toBeNull();
  });

  it("never asks for token usage, cost, or per-plan consumption", () => {
    const api = refusingClient();
    mount(api);

    expect(api.usage).not.toHaveBeenCalled();
    for (const file of ADMIN_FILES) {
      const text = source(file);
      for (const forbidden of FORBIDDEN_PATHS) {
        expect(text, `${file} references ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reaches the backend only through the typed client, and only for the permitted reads", () => {
    const panel = source("../../components/admin/model-policy.tsx");

    // No second way in: no raw fetch, no Supabase client, no hand-built Authorization header. The
    // token is the API client's business and is added there, once, per request.
    for (const reach of ["fetch(", "createClient", "Authorization", "localStorage", "document.cookie"]) {
      expect(panel, `model-policy.tsx references ${reach}`).not.toContain(reach);
    }

    // And the reads it does make are the six named ones. A method appearing here that is not in
    // that list is a panel that grew a capability its requirement does not cover.
    const called = [...panel.matchAll(/client\.([A-Za-z]+)\(/g)].map((match) => match[1]);
    expect(new Set(called)).toEqual(new Set(PERMITTED_ADMIN_METHODS));
  });
});

describe("the two routes that began without a navigation entry", () => {
  it("offers Plan & Usage to everybody, now that it has a screen", () => {
    // It was unlisted because it was unbuilt (task 33.4). Task 34.10 built it, so it is offered —
    // in its own Account group rather than among the seven weather screens, because it answers a
    // different kind of question.
    expect(ACCOUNT_NAVIGATION.map((entry) => entry.path)).toContain(PLAN_USAGE_PATH);
    expect(NAVIGATION.map((entry) => entry.path)).not.toContain(PLAN_USAGE_PATH);
  });

  it("keeps the administrative route out of the navigation everybody sees", () => {
    // Not because it is unbuilt — because most people may not open it. It is offered to a principal
    // the backend confirms holds the role, which `components/shell/shell.test.tsx` asserts both
    // ways; what is asserted here is that it is in no list rendered unconditionally.
    expect(NAVIGATION.map((entry) => entry.path)).not.toContain(ADMIN_MODEL_USAGE_PATH);
    expect(ACCOUNT_NAVIGATION.map((entry) => entry.path)).not.toContain(ADMIN_MODEL_USAGE_PATH);
    expect(ADMIN_NAVIGATION.map((entry) => entry.path)).toContain(ADMIN_MODEL_USAGE_PATH);
  });

  it("offers only administrative surfaces that exist", () => {
    expect(ADMIN_NAVIGATION.map(({ title }) => title)).toEqual(["Model & AI Usage"]);
  });

  it("protects both routes by the same default as every other screen", () => {
    for (const unlisted of UNLISTED_SCREENS) {
      expect(isProtectedPath(unlisted.path), unlisted.path).toBe(true);
    }
    // And the segment grants nothing: a nested administrative path is protected too.
    expect(isProtectedPath(`${ADMIN_MODEL_USAGE_PATH}/anything`)).toBe(true);
    expect(isProtectedPath(PLAN_USAGE_PATH)).toBe(true);
  });

  it("still names the two `specs/web-ui` left out of the sidebar to begin with", () => {
    expect(UNLISTED_SCREENS.map(({ title }) => title)).toEqual([
      "Admin Model & AI Usage",
      "Plan & Usage",
    ]);
  });
});
