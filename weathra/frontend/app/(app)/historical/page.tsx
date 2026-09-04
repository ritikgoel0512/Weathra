/**
 * `/historical` — Historical Analytics, task 21.3.
 *
 * A client screen: the window, the period it is compared with and the number of baseline years are
 * all chosen on the page, and each choice is a fresh request through the shared query layer with
 * its own loading, error and retry. A server render would fix one window and could only be changed
 * by reloading.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { HistoricalAnalytics } from "@/components/historical/historical";

export const metadata: Metadata = { title: "Historical Analytics" };

export default function Page(): ReactNode {
  return <HistoricalAnalytics />;
}
