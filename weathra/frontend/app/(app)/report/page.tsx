/**
 * `/report` — Weather Intelligence Report.
 *
 * One place read across every surface Weathra has, composed as the artifact composes it: a report
 * header, a conclusion with three figures, six observed tiles, a week of day cards, what moved, one
 * chart against the archive record with the record and the flagged entries beside it, a grounded
 * synthesis, the grounding behind it, and a status strip. Six weather endpoints and one agent run;
 * the screen adds no figure of its own, and it shows a chosen subset of what they return — see
 * `components/report/report.tsx` for the composition and `lib/report/view-model.ts` for what
 * decides which figures reach it.
 *
 * The approved composition is `docs/design/screens/12-weather-intelligence-report.png`. Its agent
 * version string, evidence-node count, retrieval score, PDF export, stability index, alignment
 * score and sensor-network footer are not implemented, and are recorded with the rest of its
 * refusals in `docs/design/screens.md` §5.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherIntelligenceReport } from "@/components/report/report";

export const metadata: Metadata = { title: "Weather Intelligence Report" };

export default function Page(): ReactNode {
  return <WeatherIntelligenceReport />;
}
