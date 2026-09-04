/**
 * `/` — the Dashboard, task 21.1.
 *
 * The Weathra Intelligence briefing for the signed-in person's default location. The screen itself
 * is a client component: it reads preferences, conditions, forecast, analytics and historical
 * context through the shared query layer and the typed API client, inside the session boundary the
 * protected layout already established.
 *
 * Nothing is fetched here on the server. The briefing depends on the person's own preferences and
 * carries a retry per surface, which is the shared `loading | empty | error | ready` convention of
 * task 20.13 rather than a server render that can only be recovered by reloading the page.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Dashboard } from "@/components/dashboard/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page(): ReactNode {
  return <Dashboard />;
}
