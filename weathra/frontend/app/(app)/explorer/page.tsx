/**
 * `/explorer` — Forecast Explorer.
 *
 * A screen now. Everything it shows comes from `/weather/current`, `/weather/forecast` and
 * `/weather/analysis`, which Weathra has served since group 8 — so the route that said "not yet
 * available" was a placeholder in front of working endpoints.
 *
 * The approved composition is `docs/design/screens/11-forecast-explorer.png`; what that artifact
 * draws and Weathra does not have is recorded in `docs/design/screens.md` §8 and absent here.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ForecastExplorer } from "@/components/explorer/explorer";

export const metadata: Metadata = { title: "Forecast Explorer" };

export default function Page(): ReactNode {
  return <ForecastExplorer />;
}
