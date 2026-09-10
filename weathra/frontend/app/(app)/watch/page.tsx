/**
 * `/watch` — Weather Watch.
 *
 * Conditions the person asked Weathra to check, stored in `weather_watches` under the same
 * owner-only policy every user-owned table carries, and evaluated when the screen is opened or a
 * watch is refreshed. Weathra runs nothing on a timer and sends no alerts, and both the API and the
 * screen say so.
 *
 * The approved composition is `docs/design/screens/14-weather-watch.png`. Its watch engine,
 * monitoring nodes, model recalibration and sensor telemetry do not exist; recorded in
 * `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherWatch } from "@/components/watch/watch";

export const metadata: Metadata = { title: "Weather Watch" };

export default function Page(): ReactNode {
  return <WeatherWatch />;
}
