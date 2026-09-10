/**
 * `/admin/model-usage` — Admin Model & AI Usage.
 *
 * **The screen is built from what Weathra actually records.** `specs/web-ui` kept it post-MVP with
 * one named exception, the administrative model *policy confirmation* surface that task 34.5's
 * evidence trail depends on. This change adds the rest of the screen the artifact composes — the
 * KPI row, the usage chart, the grouped table, the product/internal split, the failures panel and
 * the model catalog — from two administrative endpoints that already existed: `GET /admin/usage`,
 * which returns aggregate measures and never a row or a subject, and `GET /admin/models`.
 *
 * **What the panels do not do is invent the artifact's operational estate.** No model name is
 * written in this codebase; the catalog table renders whatever `model_catalog` holds. The composite
 * quality and cost-efficiency scores, the per-tier user headcounts, the export and audit-report
 * controls and the "all services operational" footer are absent rather than styled out of sight,
 * and `docs/design/screens.md` §5 records why for each.
 *
 * Authorization is still not this module's business. The role is a row in `admin_roles` keyed by the
 * validated token subject (`docs/authentication.md`); nothing on this page decides who may look, and
 * every request it issues is one the backend refuses to a caller without the role — which is why an
 * ordinary authenticated person reaching this path is shown a not-permitted state rather than an
 * empty screen dressed as a working one.
 *
 * The screen's approved design is `docs/design/screens/09-admin-model-ai-usage.png` (task 33.1,
 * approved 2026-09-09). The policy panel below the dashboard is not drawn in it — the artifact
 * composes usage, cost and a comparison lab, not an audited policy confirmation — and that
 * divergence is recorded in `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ModelPolicyPanel } from "@/components/admin/model-policy";
import { AdminOverview } from "@/components/admin/overview";
import { PrincipalPlans } from "@/components/admin/principals";
import { ModelRouting } from "@/components/admin/routing";

import styles from "@/components/admin/admin.module.css";

export const metadata: Metadata = { title: "Admin Model & AI Usage" };

export default function Page(): ReactNode {
  return (
    <div className={styles.screen}>
      <div className={styles.screenHead}>
        <h1>Admin Model & AI Usage</h1>
      </div>
      <p className={styles.intro}>
        Calls, tokens, estimated cost, latency and failures over a period, and the catalog behind
        them. Cost is an operational estimate priced from the catalog at the time of each call, not
        a billed amount.
      </p>
      <AdminOverview />
      <ModelRouting />
      <PrincipalPlans />
      <ModelPolicyPanel />
    </div>
  );
}
