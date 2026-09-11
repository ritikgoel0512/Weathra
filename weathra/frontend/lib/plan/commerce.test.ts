import { describe, expect, it } from "vitest";

import type { PlanOfferView, PlansResponse } from "@/lib/api/schema";
import {
  allowanceLabel,
  checkoutFor,
  continueLabel,
  planActionLabel,
  pricingPublished,
  selectionNotice,
  valueProposition,
} from "./commerce";

function plan(
  code: string,
  name: string,
  rank: number,
  allowances: readonly { dimension: string; allowance: number }[],
): PlanOfferView {
  return {
    plan_code: code,
    display_name: name,
    rank,
    allowances: allowances.map((entry) => ({
      dimension: entry.dimension,
      window: "day",
      allowance: entry.allowance,
    })),
  } as unknown as PlanOfferView;
}

const FREE_PLAN = plan("free", "Free", 1, [{ dimension: "requests_per_day", allowance: 25 }]);
const PRO_PLAN = plan("pro", "Pro", 2, [{ dimension: "requests_per_day", allowance: 250 }]);
const PREMIUM_PLAN = plan("premium", "Premium", 3, [
  { dimension: "requests_per_day", allowance: 1000 },
]);

function plans(overrides: Partial<PlansResponse> = {}): PlansResponse {
  return {
    plans: [FREE_PLAN, PRO_PLAN, PREMIUM_PLAN],
    default_plan: "free",
    self_service: false,
    assignment_note: "",
    count: 3,
    ...overrides,
  } as PlansResponse;
}

describe("what the product may say about buying a plan", () => {
  it("reports the default tier as current rather than as something to buy", () => {
    expect(checkoutFor(FREE_PLAN, plans())).toEqual({ kind: "current" });
    expect(planActionLabel(FREE_PLAN, plans())).toBe("Start free");
    // Nothing to activate: a new account is on the default the moment it exists.
    expect(selectionNotice(FREE_PLAN, plans())).toBeNull();
  });

  it("refuses to offer checkout while the backend says there is no payment integration", () => {
    const checkout = checkoutFor(PRO_PLAN, plans());
    expect(checkout.kind).toBe("unavailable");
    expect(checkout).not.toHaveProperty("href");
  });

  it("offers a paid tier the way a product does, not as a request queue", () => {
    expect(planActionLabel(PRO_PLAN, plans())).toBe("Choose Pro");
    expect(planActionLabel(PREMIUM_PLAN, plans())).toBe("Choose Premium");
  });

  it("states the commercial boundary without implying a purchase or an entitlement", () => {
    const notice = selectionNotice(PRO_PLAN, plans());
    expect(notice?.title).toBe("Pro selected");
    expect(notice?.detail).toMatch(/not enabled yet/);
    expect(notice?.detail).toMatch(/stays on Free/);
    // None of the words a product uses when money has actually moved.
    for (const forbidden of [/invoice/i, /subscribed/i, /payment received/i, /card/i, /billed/i]) {
      expect(notice?.detail).not.toMatch(forbidden);
    }
  });

  it("names the chosen tier on the step's primary action", () => {
    expect(continueLabel(null)).toBe("Continue");
    expect(continueLabel(PRO_PLAN)).toBe("Continue with Pro");
  });

  it("publishes no price, because the plans contract carries none", () => {
    // A figure here would be one this module invented. The screens say so instead of guessing.
    expect(pricingPublished()).toBe(false);
  });

  it("opens a checkout only once the backend says self-service exists", () => {
    // The seam a payment provider fills in. Nothing else about the screens changes that day.
    const checkout = checkoutFor(PRO_PLAN, plans({ self_service: true }));
    expect(checkout.kind).toBe("available");
    expect(checkout).toHaveProperty("href");
  });
});

describe("what a tier is worth, derived rather than written", () => {
  it("states the starter tier without inventing a benefit", () => {
    expect(valueProposition(FREE_PLAN, plans())).toMatch(/starter allowance/);
  });

  it("computes the gain against the tier below from the allowances themselves", () => {
    // 25 → 250 a day. The sentence is arithmetic, so it stays true when a row is edited.
    expect(valueProposition(PRO_PLAN, plans())).toBe("10× the daily questions of Free.");
  });

  it("falls back to a truthful phrase when nothing measurably increases", () => {
    const flat = plan("pro", "Pro", 2, [{ dimension: "requests_per_day", allowance: 25 }]);
    expect(valueProposition(flat, plans({ plans: [FREE_PLAN, flat] }))).toBe(
      "More headroom than Free.",
    );
  });

  it("uses plain words for the dimensions the database counts in", () => {
    expect(allowanceLabel(PRO_PLAN.allowances[0]!)).toBe("Daily questions");
    // An unmapped dimension is still readable, never a raw field name with underscores.
    const odd = plan("x", "X", 9, [{ dimension: "vector_storage_nodes", allowance: 1 }]);
    expect(allowanceLabel(odd.allowances[0]!)).toBe("Vector storage nodes");
  });
});
