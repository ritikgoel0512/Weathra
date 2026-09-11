/**
 * What Weathra can and cannot truthfully say about buying a plan — the one place that decides.
 *
 * **The seam.** Everything commercial the product claims passes through `checkoutFor`. Today it
 * answers `unavailable` for every paid tier, because `PlansResponse.self_service` is the backend
 * saying there is no payment integration — not this file assuming it. When a payment provider is
 * added, that answer becomes `available` with somewhere to send the person, and no screen that
 * renders a plan needs to change: the cards, the selection state and the primary action already
 * read their wording from here.
 *
 * **What it refuses to do.** It never reports a subscription as active, never describes a payment
 * that has not happened, and never turns a chosen tier into an entitlement. A person who picks Pro
 * on the signup step has expressed a preference in their own browser; the backend has no row for
 * it, their allowances are unchanged, and the copy below says exactly that rather than implying a
 * purchase is in progress. The previous wording — *Ask about Pro*, then *Requested* — was truthful
 * and read like an internal approval queue; this is the same truth said the way a product says it.
 *
 * **Prices are absent, not hidden.** `PlanOfferView` carries a plan's code, name, rank and
 * allowances and no price, because no price exists in the database yet. A figure rendered here
 * would be one this file invented, so tiers state that pricing is not published instead. That is a
 * state the design accounts for and is the honest half of "what it costs, or whether pricing is
 * unavailable".
 */

import type { PlanAllowanceView, PlanOfferView, PlansResponse } from "@/lib/api/schema";

/** The canonical tiers. A fourth would be a product decision, not a rendering one. */
export const FREE = "free";

export type Checkout =
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly href: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What pressing a tier's button can honestly do.
 *
 * `current` for the tier the account is already on — there is nothing to buy and nothing to
 * activate, because a new account *is* on the default the moment it exists, with no row written.
 */
export function checkoutFor(plan: PlanOfferView, plans: PlansResponse): Checkout {
  if (plan.plan_code === plans.default_plan) return { kind: "current" };
  if (plans.self_service === true) {
    // The shape a payment provider fills in. Deliberately unreachable today.
    return { kind: "available", href: `/plan/checkout?tier=${encodeURIComponent(plan.plan_code)}` };
  }
  return {
    kind: "unavailable",
    reason: "Paid checkout is not enabled yet, so nothing is charged and nothing changes today.",
  };
}

/** The label on a tier's own button. One primary action per card. */
export function planActionLabel(plan: PlanOfferView, plans: PlansResponse): string {
  const checkout = checkoutFor(plan, plans);
  if (checkout.kind === "current") return "Start free";
  return `Choose ${plan.display_name}`;
}

/** The label on the step's primary action, which names the tier the person picked. */
export function continueLabel(plan: PlanOfferView | null): string {
  return plan ? `Continue with ${plan.display_name}` : "Continue";
}

/**
 * What a person is told after choosing a tier that cannot be bought yet.
 *
 * A state, not an error: they chose something, the choice is remembered, and the reason it is not
 * yet a subscription is stated once without apology or jargon.
 */
export function selectionNotice(
  plan: PlanOfferView,
  plans: PlansResponse,
): { readonly title: string; readonly detail: string } | null {
  const checkout = checkoutFor(plan, plans);
  if (checkout.kind !== "unavailable") return null;
  return {
    title: `${plan.display_name} selected`,
    detail: `${checkout.reason} Your account stays on ${nameOf(plans, plans.default_plan)} and keeps its allowances until a paid plan is actually activated.`,
  };
}

function nameOf(plans: PlansResponse, code: string): string {
  return plans.plans.find((plan) => plan.plan_code === code)?.display_name ?? code;
}

/** Whether any price at all is known. Today: none is, and the tiers say so rather than guess. */
export function pricingPublished(): boolean {
  return false;
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

  const best = gains[0];
  if (!best) return `More headroom than ${below.display_name}.`;

  const times = best.factor >= 2 ? `${Math.round(best.factor)}×` : `${Math.round((best.factor - 1) * 100)}% more`;
  return `${times} ${DIMENSION_PHRASES[best.dimension] ?? "capacity"} than ${below.display_name}.`;
}

/** Plain words for the dimensions the database counts in. No raw field names on a plan card. */
const DIMENSION_PHRASES: Record<string, string> = {
  requests_per_day: "daily questions",
  requests_per_month: "monthly questions",
  agent_runs_per_day: "daily agent runs",
  agent_runs_per_month: "monthly agent runs",
  tokens_per_day: "daily token budget",
  tokens_per_month: "monthly token budget",
  concurrent_runs: "runs at once",
  saved_locations: "saved locations",
};

/** The human label for one allowance row, for a card or a comparison table. */
export function allowanceLabel(allowance: PlanAllowanceView): string {
  const phrase = DIMENSION_PHRASES[allowance.dimension];
  if (phrase) return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return allowance.dimension.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}
