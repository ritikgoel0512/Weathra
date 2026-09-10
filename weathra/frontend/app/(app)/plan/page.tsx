/**
 * `/plan` — Plan & Usage.
 *
 * A screen now, not a placeholder. `specs/web-ui` requires the signed-in person to see their own
 * plan name, their consumption against allowance per dimension, and each window's reset time — and
 * `GET /me/usage` has answered all three since group 30, so the route was a stub in front of a
 * working endpoint.
 *
 * It shows one person's plan: their own. The endpoint answers for the validated token subject and
 * takes no argument that could name anybody else, so there is no other person's usage here, no
 * internal usage where the caller is not internal, and no cross-user cost total.
 *
 * The approved design is `docs/design/screens/10-plan-usage.png` (task 33.2, approved 2026-09-09).
 * Its billing half — subscription id, interval, next billing date, payment method, invoices, an
 * upgrade button — is refused in `docs/design/screens.md` §5, because this change bills nobody and
 * drawing a card would be an invented commercial relationship. Plans are assigned by an
 * administrator, and the screen says so rather than offering a checkout that does not exist.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PlanUsage } from "@/components/plan/plan-usage";

export const metadata: Metadata = { title: "Plan & Usage" };

export default function Page(): ReactNode {
  return <PlanUsage />;
}
