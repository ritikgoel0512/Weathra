/**
 * `/evidence` — the Agent Evidence destination in the navigation, task 21.5.
 *
 * Evidence is *per run*: there is one stored record for each question somebody asked, and it is
 * reached at `/evidence/{id}` from the answer that produced it. This page is what the navigation
 * entry resolves to, and it says so.
 *
 * Deliberately static, and deliberately not a list. `specs/http-api` exposes one evidence endpoint
 * — a record by its identifier — and no endpoint enumerating a person's runs. A screen listing
 * them would have to invent the listing, which is the one thing an evidence surface must not do.
 */

import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { EvidenceWorkspaceSkeleton } from "@/components/evidence/sections";
import { FixtureEvidence } from "@/components/evidence/fixture-evidence";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

import styles from "@/components/evidence/evidence.module.css";

export const metadata: Metadata = { title: "Agent Evidence" };

/**
 * With no run selected, the screen keeps the workspace it would show with one.
 *
 * It used to collapse to a paragraph, which meant `/evidence` and `/evidence/{id}` were two
 * differently shaped pages — `05-agent-evidence.png` is a workspace, and a person arriving from the
 * navigation should see the shape of what they will get rather than an explanation of it. Every
 * region the populated screen has is drawn here, empty and labelled.
 *
 * **The privacy line stays.** Replacing the old empty state dropped its second paragraph, which
 * told the reader that a run record belongs to the person who produced it. That is a fact about
 * who can read their data, not decoration, and the artifact having no room for it is not a reason
 * for the product to stop saying it — so it is back, as one muted line rather than a paragraph of
 * prose. It claims exactly what the architecture provides: the route is behind sign-in, and the
 * row is readable only by the account that created it. Nothing about encryption, nothing about
 * who operates the database.
 */
export default function Page(): ReactNode {
  /*
   * Visual-fidelity review only. `05-agent-evidence.png` is a *populated* trace, and this route
   * without a run id is deliberately the empty workspace — so a side-by-side needs the populated
   * state. The flag's value is baked in at build time, so in a deployed build this is always false
   * and nothing below it is reachable; it is not folded away, so the branch ships. See
   * `lib/fixtures/visily.ts`. Nothing below changes.
   */
  if (usingVisilyFixtures()) return <FixtureEvidence />;

  return (
    <section aria-label="Agent Evidence">
      <h1>Agent evidence log</h1>
      <p>
        A record per run. Open one from the answer that produced it —{" "}
        <Link href="/analyst">ask the AI Weather Analyst</Link>.
      </p>
      <p className={styles.note}>
        Run records are private to the person whose question produced them: this page is behind
        sign-in, and a run is readable only by the account that created it.
      </p>
      <EvidenceWorkspaceSkeleton />
    </section>
  );
}
