/**
 * `/plan` — Plan & Usage.
 *
 * A route, not a screen, on the same terms as every other post-MVP destination: `specs/web-ui`
 * requires it to exist and to state plainly that it is not yet available. The screen is designed
 * in task 33.2 and implemented after the MVP; `docs/design/roadmap.md` records it.
 *
 * **It fetches nothing.** `/me/usage` exists and would answer — which is precisely why the
 * restraint is worth stating: a not-yet-available screen that quietly loaded a person's plan and
 * consumption would be a screen, and a half-built one. When the view is built it will show the
 * signed-in person their own plan and nobody else's; until then this issues no request.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Plan & Usage" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Plan & Usage" status="planned">
      Your plan, what you have used against each allowance, and when each window resets — your own
      usage only. Nothing about it is loaded here.
    </RouteStatus>
  );
}
