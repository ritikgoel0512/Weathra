/**
 * `/report` — Weather Intelligence Report.
 *
 * One place read across every surface Weathra has: conditions, outlook, what moved, what was
 * computed, and the record behind it. Composed from five endpoints that already existed; the
 * screen adds no figure of its own.
 *
 * The approved composition is `docs/design/screens/12-weather-intelligence-report.png`. Its agent
 * version string, evidence-node count and PDF export are not implemented, and are recorded in
 * `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherIntelligenceReport } from "@/components/report/report";

export const metadata: Metadata = { title: "Weather Intelligence Report" };

export default function Page(): ReactNode {
  return <WeatherIntelligenceReport />;
}
