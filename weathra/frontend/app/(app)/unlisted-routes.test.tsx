/**
 * The administrative route — task 33.4, revised for tasks 34.5, 34.9 and 34.18.
 *
 * Plan & Usage used to be tested here as the other route with no screen behind it. It has one now
 * (task 34.10), so its suite lives with the screen in `components/plan/plan-usage.test.tsx`; what
 * remains of it here is the navigation and protection assertions at the bottom, which still cover
 * both routes.
 *
 * **The screen is no longer one built panel and a paragraph of apology.** Task 34.18 built the
 * dashboard the artifact composes — KPIs, the usage chart, the grouped table, the product/internal
 * split, failures and the catalog — from the two administrative endpoints that already existed. So
 * this file's guarantee moves with it: what is bounded is no longer *how little* the route loads
 * but *what* it may load, and from where.
 *
 * Three things are asserted here and nowhere else. An ordinary authenticated person gets a
 * not-permitted state with no figures behind it, because every request this route issues is one the
 * backend refuses without the role. The route never asks for the acting person's *own* plan or
 * consumption, which is a different question from the estate's. And the reads it makes are exactly
 * the named administrative ones, reached through the typed client — a method appearing in either
 * component that is not on the list is a panel that grew a capability its requirement does not
 * cover.
 *
 * Each panel's own behaviour is tested beside it: `components/admin/model-policy.test.tsx` and
 * `components/admin/overview.test.tsx`.
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
  "../../components/admin/overview.tsx",
  "../../components/admin/principals.tsx",
  "../../components/admin/routing.tsx",
] as const;

/** The components the route renders. Every one is scanned; adding a file to the screen adds it here. */
const ADMIN_COMPONENTS = ADMIN_FILES.filter((path) => path.includes("components/admin/"));

/**
 * The path that would carry somebody's *own* plan and consumption.
 *
 * `/api/v1/me/usage` answers for the acting person, and an administrative screen has no business
 * asking it: an operator looking at the estate is not looking at their own allowance. Aggregate
 * administrative usage (`/api/v1/admin/usage`) is a different endpoint and is legitimately read
 * here, since task 34.18 built the panels it feeds.
 */
const FORBIDDEN_PATHS = ["/api/v1/me/usage"] as const;

/**
 * Model names the artifact draws and Weathra does not have.
 *
 * `09-admin-model-ai-usage.png` populates its model table with four vendor models and its
 * comparison lab with two versions of an in-house engine. Copying any of them would put a model
 * Weathra cannot resolve in front of an operator making an operational decision. The catalog table
 * renders `model_catalog`, so the fixture's own names appear and these never do.
 */
const FICTIONAL_MODELS = [
  "GPT-4o",
  "Claude 3.5",
  "Llama 3.1",
  "Gemini 1.5",
  "WEATHRA-CORE",
] as const;

/** Everything the two administrative panels are permitted to reach, and nothing else. */
const PERMITTED_ADMIN_METHODS = [
  "adminUsage",
  "adminPlans",
  "adminPrincipals",
  "assignPlan",
  "setPolicyFallback",
  "setPlanPolicies",
  "adminPolicies",
  "adminCatalog",
  "adminComparisons",
  "adminComparison",
  "confirmPolicyCandidates",
  "adminPolicyAudit",
] as const;

describe("Admin Model & AI Usage: built from what Weathra records, refused to everybody else", () => {
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
      adminUsage: vi.fn(forbidden),
      adminPolicies: vi.fn(forbidden),
      adminCatalog: vi.fn(forbidden),
      adminComparisons: vi.fn(forbidden),
      adminComparison: vi.fn(forbidden),
      adminPolicyAudit: vi.fn(forbidden),
      confirmPolicyCandidates: vi.fn(forbidden),
      usage: vi.fn(() => Promise.reject(new Error("this route never asks for the caller's own"))),
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

  it("names the screen and says what its cost figure is", () => {
    mount(refusingClient());

    expect(screen.getByRole("heading", { name: "Admin Model & AI Usage" })).toBeInTheDocument();
    // The one qualification that must survive every redesign of this screen: the column is an
    // operational estimate priced from the catalog, and calling it a bill would be a false claim
    // about money.
    expect(screen.getByText(/not\s+a billed amount/)).toBeInTheDocument();
  });

  it("shows an ordinary authenticated person a not-permitted state with no figures behind it", async () => {
    mount(refusingClient());

    // Both panels refuse, so there is more than one; each says the same thing for the same reason.
    const refusals = await screen.findAllByRole("alert");
    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) expect(refusal).toHaveTextContent(/Not permitted|not permitted/);

    expect(screen.queryByRole("button", { name: "Confirm candidate order" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("img", { name: /by model/i })).toBeNull();
  });

  it("never asks for the acting person's own plan or consumption", () => {
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

  it("writes no model name of its own, fictional or real", () => {
    // The catalog table is rendered from the API. A model name written into a component would be
    // both a vendor coupling and, in this screen's case, a figure an operator could act on.
    for (const file of ADMIN_FILES) {
      const text = source(file);
      for (const fictional of FICTIONAL_MODELS) {
        expect(text, `${file} names ${fictional}`).not.toContain(fictional);
      }
    }
  });

  it("reaches the backend only through the typed client, and only for the permitted reads", () => {
    const components = ADMIN_COMPONENTS;

    // No second way in: no raw fetch, no Supabase client, no hand-built Authorization header. The
    // token is the API client's business and is added there, once, per request.
    for (const file of components) {
      const text = source(file);
      for (const reach of ["fetch(", "createClient", "Authorization", "localStorage", "document.cookie"]) {
        expect(text, `${file} references ${reach}`).not.toContain(reach);
      }
    }

    const called = components.flatMap((file) =>
      [...source(file).matchAll(/client\.([A-Za-z]+)\(/g)].map((match) => match[1]),
    );
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
