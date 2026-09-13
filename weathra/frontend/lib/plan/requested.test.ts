/**
 * The tier held from signup, and the one moment it can be applied.
 *
 * The property worth testing is not that a value round-trips through `localStorage` — it is what
 * happens when it does not: a note from a browser that refuses storage, a note somebody edited by
 * hand, a write that failed. None of those may cost a person their sign-in, and none may quietly
 * apply a tier nobody asked for.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "@/lib/api/client";

import {
  REQUESTED_PLAN_KEY,
  applyRequestedPlan,
  forgetRequestedPlan,
  readRequestedPlan,
  rememberRequestedPlan,
} from "./requested";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function api(result: unknown): ApiClient {
  return {
    choosePlan: vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  } as unknown as ApiClient;
}

describe("the tier held from signup", () => {
  it("remembers a choice and gives it back", () => {
    rememberRequestedPlan("premium");
    expect(readRequestedPlan()).toBe("premium");
    forgetRequestedPlan();
    expect(readRequestedPlan()).toBeNull();
  });

  it("has nothing to say when nothing was chosen", () => {
    expect(readRequestedPlan()).toBeNull();
  });

  it("refuses a value that is not a tier this client could ask for", () => {
    // `localStorage` is writable by anything on the origin, so what comes out of it is input.
    for (const forged of ["plus", "enterprise", "free; drop table", "", "  pro  "]) {
      window.localStorage.setItem(REQUESTED_PLAN_KEY, forged);
      expect(readRequestedPlan(), `${forged} was accepted`).toBeNull();
    }
  });

  it("survives a browser that refuses storage entirely", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() => rememberRequestedPlan("pro")).not.toThrow();
    expect(readRequestedPlan()).toBeNull();
  });
});

describe("applying it", () => {
  it("writes the held tier once, then forgets it", async () => {
    rememberRequestedPlan("pro");
    const client = api({ plan_code: "pro", plan_name: "Pro" });

    expect(await applyRequestedPlan(client)).toBe("pro");
    expect(client.choosePlan).toHaveBeenCalledWith({ plan_code: "pro" });
    // Cleared, so a later change of mind is not undone at the next sign-in.
    expect(readRequestedPlan()).toBeNull();

    await applyRequestedPlan(client);
    expect(client.choosePlan).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when nothing is held", async () => {
    const client = api({ plan_code: "pro" });
    expect(await applyRequestedPlan(client)).toBeNull();
    expect(client.choosePlan).not.toHaveBeenCalled();
  });

  it("keeps the note when the write fails, and never throws", async () => {
    rememberRequestedPlan("premium");
    const client = api(new Error("the network went away"));

    await expect(applyRequestedPlan(client)).resolves.toBeNull();
    // Kept: a dropped connection must not cost somebody the tier they picked.
    expect(readRequestedPlan()).toBe("premium");
  });

  it("reports the tier the backend confirmed, not the one that was asked for", async () => {
    rememberRequestedPlan("premium");
    // A backend that answered with something else is the authority; this reads back what it said.
    expect(await applyRequestedPlan(api({ plan_code: "free", plan_name: "Free" }))).toBe("free");
  });
});
