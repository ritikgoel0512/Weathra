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

import { EmptyState } from "@/components/ui";

export const metadata: Metadata = { title: "Agent Evidence" };

export default function Page(): ReactNode {
  return (
    <section aria-label="Agent Evidence">
      <h1>Agent evidence</h1>
      <EmptyState
        title="Open the evidence for a run"
        action={<Link href="/analyst">Go to the AI Weather Analyst</Link>}
      >
        <p>
          Every question you ask the AI Weather Analyst is stored as a run record: the agents that
          ran, every tool call and what it returned, the deterministic analytics and their methods,
          the knowledge cited, and the timings. Open one from the answer it belongs to.
        </p>
        <p>Records are private to the person whose question produced them.</p>
      </EmptyState>
    </section>
  );
}
