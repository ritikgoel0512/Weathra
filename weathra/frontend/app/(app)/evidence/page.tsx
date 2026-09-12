/**
 * `/evidence` — the Agent Evidence destination in the navigation, task 21.5.
 *
 * Evidence is *per run*: there is one stored record for each question somebody asked, reached at
 * `/evidence/{id}` from the answer that produced it. This page is what the navigation entry
 * resolves to, and it lists the runs the person actually has.
 *
 * It used to be deliberately static, for a reason that was true at the time: `specs/http-api`
 * exposed a record only by its identifier, and a screen listing runs would have had to invent the
 * listing. `GET /evidence` answers the question instead, owner-scoped, so the listing is the
 * backend's and this page shows it.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { EvidenceLog } from "@/components/evidence/evidence-log";
import { FixtureEvidence } from "@/components/evidence/fixture-evidence";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

export const metadata: Metadata = { title: "Agent Evidence" };

/**
 * With no run selected, the screen shows the runs there are.
 *
 * It collapsed to a paragraph once, then to an empty labelled workspace — two attempts at the same
 * impossible job, describing an evidence log to somebody who could not be shown one. Both left a
 * person with a dozen stored runs looking at what a person with none saw.
 *
 * **The privacy line stays.** A run record belongs to the person who produced it. That is a fact
 * about who can read their data, not decoration, so it is stated on the list as one muted line. It
 * claims exactly what the architecture provides: the route is behind sign-in, and the row is
 * readable only by the account that created it. Nothing about encryption, nothing about who
 * operates the database.
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

  return <EvidenceLog />;
}
