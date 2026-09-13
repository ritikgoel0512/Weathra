/**
 * The tier somebody picked during signup, and how it becomes their actual plan.
 *
 * **Why it is not written when it is chosen.** The plan step sits between creating an account and
 * verifying the address, and a person there has no session yet — Supabase issues one only once the
 * address is confirmed. `PUT /me/plan` needs a validated token, so choosing Pro on that screen
 * cannot write anything, however much the screen would like to. The choice is therefore *held* and
 * applied at the first moment it can be: the next successful sign-in.
 *
 * **It is a note, not an entitlement.** Nothing reads this to decide what a person may use — the
 * plan is a row in `user_plans` and the backend is the only thing that says what it is. If the note
 * is lost (a different browser, cleared storage, a private window) the account is simply on Free,
 * which is where every new account starts, and the person changes tier on Plan & Usage in one
 * press. Losing it costs a preference, never an allowance.
 *
 * **It is cleared once applied, and only once applied.** A note that survived a successful write
 * would re-apply itself at every sign-in, quietly undoing a later change of mind; one cleared on a
 * failed write would lose the choice to a dropped connection.
 */

import { createApiClient, type ApiClient } from "@/lib/api/client";
import type { PlanCode } from "@/lib/api/schema";
import { browserAccessToken } from "@/lib/supabase/browser";

import { asPlanCode } from "./usage";

/** Where a chosen tier is remembered until there is a session to apply it with. */
export const REQUESTED_PLAN_KEY = "weathra.requested-plan";

export function rememberRequestedPlan(code: string): void {
  try {
    window.localStorage.setItem(REQUESTED_PLAN_KEY, code);
  } catch {
    // A browser that refuses storage loses the note and nothing else: no entitlement depends on
    // it, so there is nothing here worth failing a screen over.
  }
}

/**
 * The held choice, if there is one this client could actually ask for.
 *
 * Validated rather than trusted: `localStorage` is writable by anything on the origin, and a value
 * from it reaching a request body unchecked is the shape of a bug worth not having. An unknown
 * tier reads as no note at all.
 */
export function readRequestedPlan(): PlanCode | null {
  try {
    return asPlanCode(window.localStorage.getItem(REQUESTED_PLAN_KEY) ?? "");
  } catch {
    return null;
  }
}

export function forgetRequestedPlan(): void {
  try {
    window.localStorage.removeItem(REQUESTED_PLAN_KEY);
  } catch {
    // As above.
  }
}

/**
 * Apply the held choice, if any. Never throws, and never blocks what called it.
 *
 * Signing in must succeed whether or not this does: a tier is a preference, and a person locked
 * out of their account because a plan write failed would be the worst possible trade. So every
 * failure is swallowed and the note is kept for the next attempt.
 *
 * **It builds its own client rather than taking one from context.** The only provider around the
 * `(auth)` group is `PublicDataBoundary`, whose client carries no access token by design — right
 * for reading public tiers, useless for a protected write. Sign-in is also the one moment the
 * token exists but no authenticated boundary has mounted yet. A client built here reads the
 * session that was just established. A test passes its own.
 *
 * Returns the tier that was applied, for a caller that wants to say so.
 */
export async function applyRequestedPlan(client?: ApiClient): Promise<PlanCode | null> {
  const wanted = readRequestedPlan();
  if (wanted === null) return null;
  try {
    const api = client ?? createApiClient({ accessToken: browserAccessToken });
    const usage = await api.choosePlan({ plan_code: wanted });
    forgetRequestedPlan();
    return (usage.plan_code as PlanCode | undefined) ?? wanted;
  } catch {
    return null;
  }
}
