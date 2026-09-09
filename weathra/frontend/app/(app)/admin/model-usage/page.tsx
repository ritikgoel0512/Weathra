/**
 * `/admin/model-usage` — Admin Model & AI Usage.
 *
 * A route, not a screen. `specs/web-ui` requires the destination to exist and to say plainly that
 * it is not yet available; the screen itself is designed in task 33.1 and implemented after the
 * MVP, and is recorded in `docs/design/roadmap.md` under "Not in the navigation".
 *
 * **It fetches nothing, for anybody.** The requirement is not "fetch only for an administrator":
 * it is that no catalog, usage, cost or lab request is issued from this route in this change, for
 * any visitor at all. So there is no query, no client, no session read and no administrative
 * import here — which is why the guarantee is a property of the module rather than of a condition
 * inside it. An ordinary person reaching this path learns exactly what an administrator does:
 * that the screen is not built.
 *
 * The administrative role stays server-held regardless (`docs/authentication.md`). Nothing on this
 * page decides anything about authorization, and nothing here is the gate for the moment it does.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RouteStatus } from "@/components/shell/route-status";

export const metadata: Metadata = { title: "Admin Model & AI Usage" };

export default function Page(): ReactNode {
  return (
    <RouteStatus title="Admin Model & AI Usage" status="planned">
      Model status, token usage, estimated cost, latency, errors, per-plan consumption and the
      internal model comparison — the administrative view of the model layer, for the people who
      hold the administrative role. Nothing about it is loaded here.
    </RouteStatus>
  );
}
