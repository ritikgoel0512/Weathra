/**
 * `/evidence/{id}` — Agent Evidence / Activity, task 21.5.
 *
 * A client screen behind a server route. The identifier comes from the path and goes straight to
 * the protected backend endpoint, which is what decides whether this caller may see the record: the
 * route resolves for any identifier, and a record that is not the signed-in person's is refused by
 * the backend exactly as an identifier that does not exist is.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AgentEvidence } from "@/components/evidence/evidence";

export const metadata: Metadata = { title: "Agent Evidence" };

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly evidenceId: string }>;
}): Promise<ReactNode> {
  const { evidenceId } = await params;
  return <AgentEvidence evidenceId={evidenceId} />;
}
