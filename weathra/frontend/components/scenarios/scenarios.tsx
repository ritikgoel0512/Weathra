"use client";

/**
 * Weather Scenario Lab — what the forecast would read if your assumptions held.
 *
 * Built against `docs/design/screens/13-weather-scenario-lab.png`: the assumptions panel, the
 * baseline card, the calculated card, the baseline-against-scenario chart, the delta cards, the
 * interpretation area, the disclaimer.
 *
 * **Nothing here calculates anything.** The arithmetic is `POST /weather/scenario`, which applies
 * the stated assumptions to a real forecast in `analytics/scenario.py` and returns both series with
 * the method used per measure. A browser computing the scenario would put a figure on screen that
 * no test in the analytics suite covers.
 *
 * **It is a hypothetical and says so first.** The artifact's own header carries a SIMULATED chip and
 * so does this, because the one misunderstanding worth designing against is somebody reading a
 * scenario as a forecast.
 *
 * **What the artifact draws and Weathra does not have:** a session id, `MODEL: DELTA-INFERENCE-V4`,
 * a station id, an atmospheric stability index, an inference-confidence bar, a "neural simulation
 * engine v8.2", evaporation-rate and thermal-inertia what-ifs, a simulation report export, a
 * historical correlation model with a 94.2% match and a 2.84σ figure, "14 validated meteorological
 * nodes", a "Weathra Analysis Kernel", 124 active nodes and a scenario lock. None of it exists.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";

import { RecordedAgainstBaselineChart } from "@/components/historical/charts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyChart,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
} from "@/components/ui";
import type {
  Location,
  PreferenceView,
  ScenarioMeasure,
  ScenarioResponse,
} from "@/lib/api/schema";
import { briefingLocationFrom, measureLabel } from "@/lib/dashboard/briefing";
import { hasValues, missingCount, pointsFrom } from "@/lib/historical/analysis";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./scenarios.module.css";

/** The four assumptions the backend accepts. Nothing else is offered, because nothing else is applied. */
const ASSUMPTIONS = [
  { key: "temperature_delta", label: "Temperature shift", unit: "degrees", step: 0.5, min: -30, max: 30 },
  { key: "precipitation_percent", label: "Precipitation change", unit: "%", step: 5, min: -100, max: 500 },
  { key: "relative_humidity_delta", label: "Humidity shift", unit: "points", step: 1, min: -100, max: 100 },
  { key: "wind_speed_delta", label: "Wind shift", unit: "speed", step: 1, min: -200, max: 200 },
] as const;

type AssumptionKey = (typeof ASSUMPTIONS)[number]["key"];

function DeltaCard({ measure }: { readonly measure: ScenarioMeasure }): ReactNode {
  const difference = measure.difference;

  return (
    <div className={styles.delta}>
      <p className={styles.deltaLabel}>{measureLabel(measure.measure)}</p>
      <p className={styles.deltaValue}>
        {difference === null || difference === undefined
          ? "Not computable"
          : `${difference > 0 ? "+" : ""}${difference.toFixed(2)}${measure.unit ? ` ${measure.unit}` : ""}`}
      </p>
      <p className={styles.deltaMethod}>{measure.method}</p>
      {(measure.clipped ?? 0) > 0 ? (
        <p className={styles.deltaNote}>
          {measure.clipped} hour{measure.clipped === 1 ? "" : "s"} reached a physical limit and was
          held there.
        </p>
      ) : null}
      {(measure.points_excluded ?? 0) > 0 ? (
        <p className={styles.deltaNote}>
          {measure.points_excluded} hour{measure.points_excluded === 1 ? "" : "s"} had no reading to
          adjust.
        </p>
      ) : null}
    </div>
  );
}

function ScenarioFor({ location }: { readonly location: Location }): ReactNode {
  const [assumptions, setAssumptions] = useState<Record<AssumptionKey, string>>({
    temperature_delta: "2.5",
    precipitation_percent: "15",
    relative_humidity_delta: "0",
    wind_speed_delta: "0",
  });

  const run = useApiMutation<void, ScenarioResponse>({
    run: (client) =>
      client.scenario({
        latitude: location.latitude,
        longitude: location.longitude,
        days: 2,
        assumptions: Object.fromEntries(
          ASSUMPTIONS.map((entry) => [entry.key, Number(assumptions[entry.key])]).filter(
            ([, value]) => Number.isFinite(value) && value !== 0,
          ),
        ),
      }),
  });

  const result = run.state.kind === "saved" ? run.state.data : null;
  const scenarioPoints = result ? pointsFrom(result.scenario) : [];
  const drawable = result !== null && hasValues(scenarioPoints, "temperature");

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.title}>
          <Badge tone="quota">Simulated</Badge>
          <h1>Weather Scenario Lab</h1>
        </div>
        <p className={styles.lede}>
          Suppose something about the weather at {friendlyName(location)}, and Weathra applies it to
          the real forecast. A hypothetical — never a forecast of what will happen.
        </p>
      </header>

      <div className={styles.body}>
        <Card aria-labelledby="scenario-assumptions">
          <CardHeader
            title="Your assumptions"
            titleId="scenario-assumptions"
            badge={<Badge tone="quota">Simulated</Badge>}
          />
          <CardBody>
            <div className={styles.controls}>
              {ASSUMPTIONS.map((entry) => (
                <Input
                  key={entry.key}
                  label={entry.label}
                  description={`In ${entry.unit}. Zero leaves it alone.`}
                  type="number"
                  step={entry.step}
                  min={entry.min}
                  max={entry.max}
                  value={assumptions[entry.key]}
                  onChange={(event) =>
                    setAssumptions((current) => ({ ...current, [entry.key]: event.target.value }))
                  }
                />
              ))}
            </div>
            <div className={styles.actions}>
              <Button variant="primary" busy={run.busy} onClick={() => run.submit()}>
                Run this scenario
              </Button>
              <Button
                onClick={() =>
                  setAssumptions({
                    temperature_delta: "0",
                    precipitation_percent: "0",
                    relative_humidity_delta: "0",
                    wind_speed_delta: "0",
                  })
                }
              >
                Reset to the forecast
              </Button>
            </div>
          </CardBody>
        </Card>

        <div className={styles.results}>
          {run.state.kind === "error" ? (
            <ErrorState failure={run.state.failure} title="That scenario was not calculated" />
          ) : null}

          {result ? (
            <>
              <Card aria-labelledby="scenario-chart">
                <CardHeader
                  title="The forecast, and your scenario"
                  titleId="scenario-chart"
                  badge={<Badge tone="quota">Simulated</Badge>}
                  subtitle={`Baseline from ${result.attribution?.provider ?? "the provider"}, in ${location.timezone}.`}
                />
                <CardBody>
                  {drawable ? (
                    <RecordedAgainstBaselineChart
                      points={scenarioPoints}
                      measure="temperature"
                      unit={result.scenario?.units?.temperature ?? null}
                      seriesLabel="Scenario"
                      title="Temperature: your scenario against the forecast"
                      missing={missingCount(scenarioPoints, "temperature")}
                      baselineValue={
                        result.measures.find((measure) => measure.measure === "temperature")
                          ?.baseline_mean ?? null
                      }
                      baselineLabel="Forecast mean"
                    />
                  ) : (
                    <EmptyChart
                      title="Temperature: your scenario against the forecast"
                      reason="This provider reported no hourly temperatures to adjust."
                    />
                  )}
                </CardBody>
              </Card>

              <Card aria-labelledby="scenario-deltas">
                <CardHeader
                  title="What your assumptions did"
                  titleId="scenario-deltas"
                  badge={<DataClassBadge dataClass="analytics" />}
                  subtitle="Computed by Weathra from the figures above. No model was involved."
                />
                <CardBody>
                  {result.measures.length === 0 ? (
                    <p className={styles.quiet}>
                      You supposed nothing, so this is the forecast unchanged — a fair baseline to
                      start from.
                    </p>
                  ) : (
                    <div className={styles.deltas}>
                      {result.measures.map((measure) => (
                        <DeltaCard key={measure.measure} measure={measure} />
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>

              <Card aria-labelledby="scenario-caveat">
                <CardHeader title="What this is" titleId="scenario-caveat" />
                <CardBody>
                  <p className={styles.quiet}>{result.disclaimer}</p>
                  <p className={styles.quiet}>
                    Weathra applied your figures to a real forecast. It did not model the
                    atmosphere: a forecast two degrees warmer is not the weather that a warmer
                    atmosphere would produce.
                  </p>
                </CardBody>
              </Card>
            </>
          ) : run.busy ? (
            <LoadingState label="Applying your assumptions to the forecast" lines={4} />
          ) : (
            <EmptyState title="Suppose something">
              Set your assumptions and run them against the real forecast for this place. Nothing is
              sent anywhere until you do.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

export function WeatherScenarioLab(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });
  /** A place named on this screen. Outranks the default while it is set. */
  const [chosen, setChosen] = useState<Location | null>(null);

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }
  if (preferences.state.kind !== "ready") return null;

  const saved = briefingLocationFrom(preferences.state.data);
  const location = chosen ?? saved;

  return (
    <>
      {/*
        The screen's own place control. With no default this used to be an empty state and a link
        to Settings, which made the feature reachable only by configuring a preference somewhere
        else first — see `PlaceChooser` for why that is not a substitute for a product.
      */}
      <PlaceChooser
        summary="Experiment on another place"
        label="Experiment on a place"
        description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
        current={location}
        usingDefault={chosen === null}
        hasDefault={saved !== null}
        onChoose={setChosen}
      />

      {location === null ? (
        <EmptyState title="Name a place to experiment on">
          The lab applies your assumptions to the forecast for your default location. Name one
          above, or set a default in <Link href="/settings">Settings</Link>.
        </EmptyState>
      ) : (
        <ScenarioFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
        />
      )}
    </>
  );
}
