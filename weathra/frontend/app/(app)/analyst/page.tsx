/**
 * `/analyst` — the AI Weather Analyst, task 21.2.
 *
 * A client screen, because the whole of it is a live stream: the question goes to
 * `POST /api/v1/agent/stream` with the caller's bearer token and the run reports itself back as
 * server-sent events. Nothing is fetched here on the server — a server render would have to either
 * hold the connection open or show a screen with no run in it.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Analyst } from "@/components/analyst/analyst";

export const metadata: Metadata = { title: "AI Weather Analyst" };

export default function Page(): ReactNode {
  return <Analyst />;
}
