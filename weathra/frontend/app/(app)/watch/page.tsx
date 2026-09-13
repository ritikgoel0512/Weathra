/**
 * `/watch` — Weather Watch.
 *
 * A persistent multi-location monitoring workspace. Conditions the person asked Weathra to check are
 * stored in `weather_watches` under the same owner-only policy every user-owned table carries, and
 * are evaluated on a schedule — `.github/workflows/weather-watch.yml`, hourly, under the privileged
 * connection, because checking watches that belong to other people is work the request-serving role
 * must not be able to do. Each check is recorded in `weather_watch_evaluations` and each transition
 * in `weather_watch_events`, which is what makes "the condition changed at 14:00" a thing a person
 * can check rather than a claim the interface makes about itself.
 *
 * **Scheduled is not live, and Weathra still sends no alerts.** The API says so in
 * `monitoring_note`, the screen renders that sentence rather than one of its own, and every state on
 * screen carries the moment it was found.
 *
 * The approved composition is `docs/design/screens/14-weather-watch.png`. Its inference confidence,
 * anomaly counts, grounding score, model recalibration, node count and compliance lock do not
 * exist; recorded in `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherWatch } from "@/components/watch/watch";

export const metadata: Metadata = { title: "Weather Watch" };

export default function Page(): ReactNode {
  return <WeatherWatch />;
}
