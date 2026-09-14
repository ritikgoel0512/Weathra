/**
 * What Weathra can and cannot truthfully say about a plan — the one place that decides.
 *
 * **The seam.** Everything a screen claims about tiers passes through here. What it answers changed
 * on 2026-09-13: a tier used to be an administrative assignment, so every paid card was inert and
 * said so. Tiers are now **self-selectable** — `PlansResponse.self_service` is the backend saying
 * so, not this file assuming it — and `PUT /me/plan` is the write behind that.
 *
 * **Selectable is not purchasable, and the distinction is the whole honesty of this module.**
 * Weathra bills nobody: no payment integration, no card, no invoice, no subscription record, and
 * no published price. Choosing Premium changes what you are allowed and which class of model
 * answers you, and charges nothing. So the copy below says *change plan*, never *buy*, *upgrade to*
 * or *subscribe*, and `pricingPublished()` still answers false. The day a payment provider exists,
 * a price appears in the contract and this file is where that reaches the screens.
 *
 * **What it still refuses to do.** It never reports a subscription as active, never describes a
 * payment that has not happened, and never claims a tier took effect before the backend said so —
 * that last one is the mutation's job, and `planSelection` deliberately returns what a control may
 * *offer*, not what has happened.
 *
 * **Prices are absent, not hidden.** `PlanOfferView` carries a plan's code, name, rank, allowances
 * and model tier, and no price, because no price exists in the database. A figure rendered here
 * would be one this file invented.
 */

import type { PlanAllowanceView, PlanOfferView, PlansResponse } from "@/lib/api/schema";

/** The canonical tiers. A fourth would be a product decision, not a rendering one. */
export const FREE = "free";

/**
 * What a tier's control may offer, given where the account already is.
 *
 * `current` carries no action: a tier you are on is not one to choose. `selectable` is a real
 * write. `unavailable` survives for the case the backend still owns — a deployment that turns
 * `self_service` off — and carries the reason rather than leaving a control mysteriously dead.
 */
export type PlanSelection =
  | { readonly kind: "current" }
  | { readonly kind: "selectable" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What pressing a tier's button can honestly do.
 *
 * `currentPlan` is the account's actual tier from `GET /me/usage` — not the default. Reading the
 * default here was the old bug in miniature: it made *Free* look current to everybody, including
 * somebody on Premium, because with nothing selectable the distinction never showed.
 */
export function planSelection(
  plan: PlanOfferView,
  plans: PlansResponse,
  currentPlan: string | null,
): PlanSelection {
  if (currentPlan !== null && plan.plan_code === currentPlan) return { kind: "current" };
  if (plans.self_service === true) return { kind: "selectable" };
  return {
    kind: "unavailable",
    reason: "Changing tier is not enabled on this deployment.",
  };
}

/**
 * The label on a tier's own button. One primary action per card, and it never says "buy".
 *
 * The `current` wording is *"Start free"* rather than *"Your plan"* because the only caller that
 * reaches that branch is the signup step, where pressing the tier you are already on is a real
 * action — it picks that tier as the choice — and the card already carries a *Current plan* badge
 * saying where the account stands. The comparison table never asks: a tier the account is on gets
 * no button there, only a marking.
 */
export function planActionLabel(
  plan: PlanOfferView,
  plans: PlansResponse,
  currentPlan: string | null,
): string {
  const selection = planSelection(plan, plans, currentPlan);
  if (selection.kind === "current") return `Start ${plan.display_name.toLowerCase()}`;
  return `Choose ${plan.display_name}`;
}

/**
 * What a person is asked before their tier changes, and why it is asked at all.
 *
 * A plan change is instant, free and reversible, so the confirmation is not a safety rail — it is
 * there because *allowances change immediately* and somebody moving down should learn that before
 * it happens rather than from a meter afterwards. Three short lines: what will change, what will
 * not, and no payment.
 */
export function planChangePrompt(
  plan: PlanOfferView,
  current: PlanOfferView | null,
): { readonly title: string; readonly lines: readonly string[] } {
  const direction =
    current === null || current.rank === plan.rank
      ? null
      : plan.rank > current.rank
        ? "up"
        : "down";
  return {
    title: `Change plan to ${plan.display_name}?`,
    lines: [
      direction === "down"
        ? "Your allowances update immediately, and this tier allows less than your current one. Nothing you have already used is removed."
        : "Your allowances update immediately. Nothing you have already used is removed.",
      "No payment will be charged. Pricing is not currently published.",
    ],
  };
}

/** The one-line truth about tiers, for anywhere a screen would otherwise imply a subscription. */
export const BILLING_NOTE =
  "Plan tiers control your product allowances and which class of model answers you. Pricing is not published, and changing tier does not charge your account.";

/** The label on the step's primary action, which names the tier the person picked. */
export function continueLabel(plan: PlanOfferView | null): string {
  return plan ? `Continue with ${plan.display_name}` : "Continue";
}

/**
 * What a person is told after choosing a tier, in the case where choosing did not change anything.
 *
 * Null once the choice is real, which is the normal case now — the screen reports the confirmed
 * change instead, from what the backend returned. This survives for a deployment with
 * `self_service` off, where a person must not be left thinking a tier took effect.
 */
export function selectionNotice(
  plan: PlanOfferView,
  plans: PlansResponse,
  currentPlan: string | null,
): { readonly title: string; readonly detail: string } | null {
  const selection = planSelection(plan, plans, currentPlan);
  if (selection.kind !== "unavailable") return null;
  return {
    title: `${plan.display_name} not applied`,
    detail: `${selection.reason} Your account stays on ${nameOf(plans, currentPlan ?? plans.default_plan)} and keeps its allowances.`,
  };
}

/**
 * What a person is told after picking a tier during signup, where it cannot be written yet.
 *
 * The signup step has no session — the address is not verified — so the choice is held in the
 * browser and applied at the first sign-in. That is a real delay and it is stated rather than
 * papered over: somebody who reads "Selected" and expects Premium's allowances immediately has
 * been misled by one word. Null for the tier the account is already on, and null where the choice
 * cannot be honoured at all (`selectionNotice` speaks there instead).
 */
export function heldPlanNotice(
  plan: PlanOfferView,
  plans: PlansResponse,
  currentPlan: string | null,
): { readonly title: string; readonly detail: string } | null {
  if (planSelection(plan, plans, currentPlan).kind !== "selectable") return null;
  return {
    title: `${plan.display_name} selected`,
    detail: `Your account starts on ${nameOf(plans, currentPlan ?? plans.default_plan)}. Weathra moves you to ${plan.display_name} when you sign in after verifying your address — nothing is charged, and you can change tier at any time in Plan & Usage.`,
  };
}

export function nameOf(plans: PlansResponse, code: string): string {
  return plans.plans.find((plan) => plan.plan_code === code)?.display_name ?? code;
}

/** Whether any price at all is known. Today: none is, and the tiers say so rather than guess. */
export function pricingPublished(): boolean {
  return false;
}

/** What a capability tier is called on screen. The backend's own vocabulary, said for a reader. */
const TIER_NAMES: Readonly<Record<string, string>> = {
  economy: "Economy model",
  standard: "Standard model",
  frontier: "Frontier model",
};

/**
 * The class of model a tier answers with, or null where the plan maps no synthesis policy.
 *
 * This is the difference between the tiers that is *not* a number, and until `/plans` carried it a
 * comparison could only say "bigger allowances". It is three rows deep in the database — plan →
 * policy → catalog entry — and the backend resolves it; nothing here asserts which model a plan
 * gets.
 */
export function modelTierLabel(plan: PlanOfferView): string | null {
  const tier = plan.model_tier;
  if (!tier) return null;
  return TIER_NAMES[tier] ?? `${tier.charAt(0).toUpperCase()}${tier.slice(1)} model`;
}

/**
 * A tier's one-line value proposition, **derived from its allowances** rather than written here.
 *
 * The temptation on a plan card is a list of benefits somebody typed. Weathra cannot back one: the
 * plans contract carries allowances and nothing else, so a bullet promising priority access or a
 * better model would be a claim no row supports. What genuinely differs between tiers is how much
 * they allow, so that is what is said — and it is computed against the tier below, so the sentence
 * stays true when an allowance is edited in the database.
 */
export function valueProposition(
  plan: PlanOfferView,
  plans: PlansResponse,
): string {
  const ordered = [...plans.plans].sort((left, right) => left.rank - right.rank);
  const index = ordered.findIndex((entry) => entry.plan_code === plan.plan_code);
  const below = index > 0 ? ordered[index - 1] : undefined;

  if (!below) return "Everything Weathra does, within a starter allowance.";

  const gains = plan.allowances
    .map((allowance) => {
      const previous = below.allowances.find(
        (entry) => entry.dimension === allowance.dimension && entry.window === allowance.window,
      );
      if (!previous) return null;
      const now = Number(allowance.allowance);
      const was = Number(previous.allowance);
      if (!Number.isFinite(now) || !Number.isFinite(was) || was <= 0 || now <= was) return null;
      return { dimension: allowance.dimension, factor: now / was };
    })
    .filter((entry): entry is { dimension: string; factor: number } => entry !== null)
    .sort((left, right) => right.factor - left.factor);

  // The model comes first when it actually changes: which model answers is a bigger difference to a
  // person than how many times they may ask, and it is the one a bigger number cannot express.
  const tier = modelTierLabel(plan);
  const beneath = modelTierLabel(below);
  if (tier && beneath && tier !== beneath) {
    return `${tier}, where ${below.display_name} uses the ${beneath.toLowerCase()}.`;
  }

  const best = gains[0];
  if (!best) return `More headroom than ${below.display_name}.`;

  const subject = DIMENSION_PHRASES[best.dimension] ?? "capacity";
  return best.factor >= 2
    ? `${Math.round(best.factor)}× the ${subject} of ${below.display_name}.`
    : `${Math.round((best.factor - 1) * 100)}% more ${subject} than ${below.display_name}.`;
}

/** Plain words for the dimensions the database counts in. No raw field names on a plan card. */
const DIMENSION_PHRASES: Record<string, string> = {
  requests_per_day: "daily questions",
  requests_per_month: "monthly questions",
  agent_runs_per_day: "daily agent runs",
  agent_runs_per_month: "monthly agent runs",
  tokens_per_day: "daily token budget",
  tokens_per_month: "monthly token budget",
  concurrent_runs: "concurrent AI tasks",
  saved_locations: "saved locations",
};

/** The human label for one allowance row, for a card or a comparison table. */
export function allowanceLabel(allowance: PlanAllowanceView): string {
  const phrase = DIMENSION_PHRASES[allowance.dimension];
  if (phrase) return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return allowance.dimension.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}
