/**
 * The two routes that carry no navigation entry — task 33.4, revised for task 34.5.
 *
 * **Plan & Usage is unchanged and still holds the strict form of the guarantee.** `specs/web-ui`
 * asks three things of it in this change: the route resolves and says plainly that the screen is
 * not yet available, it renders nothing broken and nothing empty, and **no catalog, usage, cost or
 * lab request is issued** — for any visitor, not only for a person without the administrative role.
 * The third is the one an implementation drifts away from, so it is asserted twice, from opposite
 * directions: nothing reaches the network when the page renders, and the module has no way to
 * reach it.
 *
 * **Admin Model & AI Usage now carries a narrower guarantee, and the difference is a requirement
 * rather than a relaxation.** `specs/web-ui`'s *Administrative model policy confirmation* names one
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";
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

describe("Plan & Usage: the route with no screen behind it", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error("no request may be issued from this route")));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("states that it is not yet available", () => {
    render(<PlanUsagePage />);

    expect(screen.getByRole("heading", { name: "Plan & Usage" })).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.getByText(/This screen is not yet available/)).toBeInTheDocument();
  });

  it("renders nothing broken and nothing empty", () => {
    const { container } = render(<PlanUsagePage />);

    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(80);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("issues no request when it renders", () => {
    render(<PlanUsagePage />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no way to reach the network at all", () => {
    const text = source("./plan/page.tsx");

    for (const forbidden of ["/api/v1/admin", "/api/v1/me/usage"]) {
      expect(text).not.toContain(forbidden);
    }
    for (const reach of [
      "useApiQuery",
      "useApiClient",
      "createApiClient",
      "fetch(",
      "createClient",
    ]) {
      expect(text, `plan/page.tsx references ${reach}`).not.toContain(reach);
    }
  });

  it("renders no plan or usage content", () => {
    const { container } = render(<PlanUsagePage />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/\d+(\.\d+)?\s*(tokens|ms|%)/i);
    expect(text).not.toMatch(/\$\d/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

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

describe("both unlisted routes", () => {
  it("keeps both out of the navigation while their screens are unbuilt", () => {
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
    expect(isProtectedPath(PLAN_USAGE_PATH)).toBe(true);
  });

  it("names the two screens `specs/web-ui` leaves out of the sidebar", () => {
    expect(UNLISTED_SCREENS.map(({ title }) => title)).toEqual([
      "Admin Model & AI Usage",
      "Plan & Usage",
    ]);
  });
});
