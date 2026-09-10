/**
 * `/scenarios` — Weather Scenario Lab.
 *
 * Stated assumptions applied to a real forecast by `POST /weather/scenario`, which does the
 * arithmetic in `analytics/scenario.py` and returns both series with the method used per measure.
 * A hypothetical, labelled as one before any number appears.
 *
 * The approved composition is `docs/design/screens/13-weather-scenario-lab.png`. Its simulation
 * engine, inference model, station id, stability index, correlation model and node counts do not
 * exist and are not drawn; recorded in `docs/design/screens.md` §8.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WeatherScenarioLab } from "@/components/scenarios/scenarios";

export const metadata: Metadata = { title: "Weather Scenario Lab" };

export default function Page(): ReactNode {
  return <WeatherScenarioLab />;
}
