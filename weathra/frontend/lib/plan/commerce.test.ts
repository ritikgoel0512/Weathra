import { describe, expect, it } from "vitest";

import type { PlanOfferView, PlansResponse } from "@/lib/api/schema";
import {
  BILLING_NOTE,
  allowanceLabel,
  continueLabel,
  planActionLabel,
  planChangePrompt,
  planSelection,
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
    self_service: true,
    assignment_note: "",
    count: 3,
    ...overrides,
  } as PlansResponse;
}

describe("what the product may say about a plan", () => {
  it("reports the tier the account is actually on as current, not the default", () => {
    // The old bug in miniature: reading `default_plan` here made Free look current to somebody on
    // Premium, and nothing showed it because no tier was selectable.
    expect(planSelection(PREMIUM_PLAN, plans(), "premium")).toEqual({ kind: "current" });
    expect(planSelection(FREE_PLAN, plans(), "premium")).toEqual({ kind: "selectable" });
    // The only caller that reaches this branch is the signup step, where pressing the tier you are
    // on is a real action. The comparison table renders a marking rather than a button.
    expect(planActionLabel(PREMIUM_PLAN, plans(), "premium")).toBe("Start premium");
    expect(selectionNotice(PREMIUM_PLAN, plans(), "premium")).toBeNull();
  });

  it("offers every tier the account is not on, in both directions", () => {
    for (const [offer, label] of [
      [PRO_PLAN, "Choose Pro"],
      [PREMIUM_PLAN, "Choose Premium"],
    ] as const) {
      expect(planSelection(offer, plans(), "free").kind).toBe("selectable");
      expect(planActionLabel(offer, plans(), "free")).toBe(label);
    }
    // Downgrading is a choice like any other — a tier a person cannot leave is not one they chose.
    expect(planSelection(FREE_PLAN, plans(), "premium").kind).toBe("selectable");
    expect(planActionLabel(FREE_PLAN, plans(), "premium")).toBe("Choose Free");
  });

  it("stops offering a change when the backend says tiers are not self-selectable", () => {
    const selection = planSelection(PRO_PLAN, plans({ self_service: false }), "free");
    expect(selection.kind).toBe("unavailable");
    // And says why, rather than leaving a control mysteriously dead.
    expect(selection).toHaveProperty("reason");
    const notice = selectionNotice(PRO_PLAN, plans({ self_service: false }), "free");
    expect(notice?.title).toBe("Pro not applied");
    expect(notice?.detail).toMatch(/stays on Free/);
  });

  it("says what a change does and does not do before it happens", () => {
    const prompt = planChangePrompt(PRO_PLAN, FREE_PLAN);
    expect(prompt.title).toBe("Change plan to Pro?");
    expect(prompt.lines.join(" ")).toMatch(/allowances update immediately/i);
    expect(prompt.lines.join(" ")).toMatch(/No payment will be charged/i);
    expect(prompt.lines.join(" ")).toMatch(/Pricing is not currently published/i);
  });

  it("warns that a smaller tier is smaller, and only when it is", () => {
    expect(planChangePrompt(FREE_PLAN, PREMIUM_PLAN).lines[0]).toMatch(/allows less/);
    expect(planChangePrompt(PREMIUM_PLAN, FREE_PLAN).lines[0]).not.toMatch(/allows less/);
    // Nothing already used is removed, whichever way it goes — the claim the backend makes too.
    for (const current of [FREE_PLAN, PREMIUM_PLAN, null]) {
      expect(planChangePrompt(PRO_PLAN, current).lines[0]).toMatch(/Nothing you have already used/);
    }
  });

  it("never uses a word that would imply money moved", () => {
    const everything = [
      BILLING_NOTE,
      planChangePrompt(PREMIUM_PLAN, FREE_PLAN).lines.join(" "),
      planActionLabel(PRO_PLAN, plans(), "free"),
      selectionNotice(PRO_PLAN, plans({ self_service: false }), "free")?.detail ?? "",
    ].join(" ");
    for (const forbidden of [
      /invoice/i,
      /subscribed/i,
      /payment received/i,
      /\bcard\b/i,
      /billed/i,
      /\bbuy\b/i,
      /purchase/i,
      /checkout/i,
      /\$|€|£/,
    ]) {
      expect(everything).not.toMatch(forbidden);
    }
  });

  it("states the commercial position in one sentence a screen can show anywhere", () => {
    expect(BILLING_NOTE).toMatch(/allowances/i);
    expect(BILLING_NOTE).toMatch(/Pricing is not published/i);
    expect(BILLING_NOTE).toMatch(/does not charge your account/i);
  });

  it("names the chosen tier on the step's primary action", () => {
    expect(continueLabel(null)).toBe("Continue");
    expect(continueLabel(PRO_PLAN)).toBe("Continue with Pro");
  });

  it("publishes no price, because the plans contract carries none", () => {
    // A figure here would be one this module invented. The screens say so instead of guessing.
    expect(pricingPublished()).toBe(false);
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
