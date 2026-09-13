/**
 * `/report` — Weather Intelligence Report.
 *
 * One place read across every surface Weathra has, and *curated*: what is happening, what it is
 * like now, what the next few days hold, what moved, how unusual the window is against the
 * archive, what Weathra concludes, and what that conclusion rests on. Composed from six endpoints
 * that already existed; the screen adds no figure of its own, and it shows a chosen subset of what
 * they return rather than all of it — see `components/report/report.tsx` for the regions and
 * `lib/report/view-model.ts` for what decides which figures reach them.
 *
 * The approved composition is `docs/design/screens/12-weather-intelligence-report.png`. Its agent
 * version string, evidence-node count, report identifier and PDF export are not implemented, and
 * are recorded in `docs/design/screens.md` §5.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherIntelligenceReport } from "@/components/report/report";

export const metadata: Metadata = { title: "Weather Intelligence Report" };

export default function Page(): ReactNode {
  return <WeatherIntelligenceReport />;
}
