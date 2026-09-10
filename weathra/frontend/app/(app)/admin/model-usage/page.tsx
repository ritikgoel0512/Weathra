/**
 * `/admin/model-usage` — Admin Model & AI Usage.
 *
 * **One panel of this screen is built, and the route says which.** `specs/web-ui` keeps the screen
 * post-MVP with one named exception: the administrative *model policy confirmation* surface, added
 * to the spec for this change because the audited candidate-list write it carries is the only
 * administrative write the MVP's own evidence trail depends on (task 34.5). Model status, token
 * usage, cost, latency, errors and plan usage are still designed rather than built, and the
 * paragraph below states that rather than leaving a reader to infer it from panels that are absent.
 *
 * **What that changes about the earlier guarantee, and what it does not.** Until this change the
 * requirement was that *no* catalog, usage, cost or lab request be issued from this route for any
 * visitor at all, and the guarantee was a property of this module: it held no client, so it could
 * not have fetched. That is now narrower and still exact. The unbuilt panels fetch nothing — there
 * is no token-usage, cost or plan-consumption request here for anybody — and the policy panel's
 * reads are administrative reads the backend refuses to a caller without the role, which is why an
 * ordinary authenticated person reaching this path is shown a not-permitted state rather than an
 * empty screen dressed as a working one.
 *
 * Authorization is still not this module's business. The role is a row in `admin_roles` keyed by the
 * validated token subject (`docs/authentication.md`); nothing on this page decides who may look,
 * and the route is protected by the same default as every other product route.
 *
 * The screen's approved design is `docs/design/screens/09-admin-model-ai-usage.png` (task 33.1,
 * approved 2026-09-09). The panel built here is not drawn in it — the artifact composes the usage,
 * cost and comparison views, not an audited policy confirmation — and that divergence is recorded in
 * `docs/design/screens.md` §8, alongside §5's standing refusals of its composite scores, invented
 * model names and export controls.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ModelPolicyPanel } from "@/components/admin/model-policy";
import { Badge } from "@/components/ui";

import styles from "@/components/admin/admin.module.css";

export const metadata: Metadata = { title: "Admin Model & AI Usage" };

export default function Page(): ReactNode {
  return (
    <div className={styles.screen}>
      <div className={styles.screenHead}>
        <h1>Admin Model & AI Usage</h1>
        <Badge tone="neutral">Partly available</Badge>
      </div>
      <p className={styles.unbuilt}>
        Model status, token usage, estimated cost, latency, errors and per-plan consumption are not
        yet available on this screen, and nothing about them is loaded here. What is built is the
        model policy surface below: the recorded comparison evidence behind each policy&rsquo;s
        candidate list, and the audited write that confirms it.
      </p>
      <ModelPolicyPanel />
    </div>
  );
}
