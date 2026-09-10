/**
 * `/travel` — Travel Intelligence.
 *
 * Which days at a destination the weather favours, ranked by `POST /weather/comparison` against a
 * criterion the backend already scores — so the "viability index" is a figure Weathra computes,
 * with its components on screen, rather than arithmetic invented in a browser.
 *
 * The approved composition is `docs/design/screens/15-travel-intelligence.png`. Its flight
 * stability, airline operations, booking and sensor telemetry are not implemented, because Weathra
 * knows nothing about any of them; recorded in `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { TravelIntelligence } from "@/components/travel/travel";

export const metadata: Metadata = { title: "Travel Intelligence" };

export default function Page(): ReactNode {
  return <TravelIntelligence />;
}
