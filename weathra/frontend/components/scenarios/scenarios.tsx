"use client";

/**
 * Weather Scenario Lab — `docs/design/screens/13-weather-scenario-lab.png`.
 *
 * An atmospheric what-if workspace: state an assumption, apply it to a real retrieved forecast, and
 * read what it does — hour by hour, as four deltas, as two derived signals, and against the archive
 * for the same calendar window.
 *
 * **The artifact's macro composition, and it is the composition rather than a resemblance to it.**
 *
 *     1  lab header, with RESET TO BASELINE and RUN SCENARIO          full width
 *     2  assumptions rail  ·  baseline weather data + calculated analytical impact
 *     3  …the same rail    ·  temporal impact projection
 *     4  …the same rail    ·  four delta tiles
 *     5  …the same rail    ·  interpretation, its key deltas and two signals
 *     6  historical correlation model, with its evidence context     full width
 *     7  analytical disclaimer                                        full width
 *
 * The rail is one column down the left; everything else is the analysis area beside it.
 *
 * **One run feeds every panel.** `POST /weather/scenario` returns the baseline series, the adjusted
 * series, the per-measure arithmetic, the counted effects and the archive comparison in one
 * response, and `lib/scenarios/view-model.ts` reads all of it once. No panel re-fetches, and no two
 * panels can disagree about what the run said.
 *
 * **The lab opens loaded.** It used to open on an empty state that asked for a place and then, once
 * given one, on three more empty cards asking for a button press. A place resolves to a run with
 * every assumption at zero — which is the retrieved forecast, and a legitimate thing to draw — so
 * the baseline card, the plot and the archive block are populated before anything is supposed.
 * Before a place resolves the screen is an introduction and a chooser, not a frame of blank panels.
 *
 * **A baseline run says it is a baseline, in every panel at once.** `changed` is read off the
 * *displayed response* rather than off the sliders, and everything below branches on it: the
 * calculated card reads UNCHANGED over "Matches retrieved baseline", the four tiles read Unchanged,
 * the plot says the two series overlap, the reading is one sentence with `Baseline` and `Not
 * evaluated` beside it, and the archive block is titled BASELINE HISTORICAL CONTEXT because what it
 * is placing against the archive is the retrieved forecast. An unchanged figure under a SIMULATED
 * badge claims an adjustment nobody made, which is the same class of falsehood as an invented tile.
 *
 * **It is arithmetic and it says so.** No language model is called: the endpoint's own contract
 * refuses to spend an allowance on a slider movement, so the interpretation carries ANALYTICS
 * rather than AI INTERPRETATION, and the disclaimer is the backend's own sentence.
 *
 * **What the artifact draws and Weathra does not have:** a lab session id, `MODEL:
 * DELTA-INFERENCE-V4`, a station id, an atmospheric stability index, an inference-confidence bar, a
 * neural simulation engine, evaporation-rate and thermal-inertia what-ifs, a simulation report
 * export, 94.2% model matching against an institutional normal, infrastructure sensitivity tiers,
 * 124 active nodes and a scenario lock. Each has a real equivalent here or no tile at all.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Badge, DataClassBadge, ErrorState, LoadingState } from "@/components/ui";
import type {
  Location,
  PreferenceView,
  ScenarioResponse,
} from "@/lib/api/schema";
import { briefingLocationFrom } from "@/lib/dashboard/briefing";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import {
  ASSUMPTION_CONTROLS,
  BASELINE_ASSUMPTIONS,
  assumptionsFor,
  baselineCardFrom,
  baselineReferencesFrom,
  basisFrom,
  deltaTilesFrom,
  historicalFrom,
  impactCardFrom,
  interpretationFrom,
  isChangedRun,
  keyDeltasFrom,
  signalsFrom,
  type AssumptionKey,
  type AssumptionValues,
} from "@/lib/scenarios/view-model";

import { TemporalImpactChart, pointsFor } from "./chart";
import {
  AnalyticalDisclaimer,
  AssumptionRail,
  BaselineNotice,
  DeltaStrip,
  HistoricalCorrelation,
  HowThisWorks,
  Interpretation,
  LabHeader,
  LabIntroduction,
  LabPlaceChooser,
  Region,
  ResultCard,
  ScenarioBasis,
} from "./sections";
import styles from "./scenarios.module.css";

/** The window the lab runs over. Two days of hours is what the plot can carry legibly. */
const LAB_DAYS = 2;

function LabFor({
  location,
  chooser,
}: {
  readonly location: Location;
  readonly chooser: ReactNode;
}): ReactNode {
  /** What the sliders hold. Not what was run — that is whatever the last response came back with. */
  const [values, setValues] = useState<AssumptionValues>(BASELINE_ASSUMPTIONS);
  /** The assumptions the displayed run was made with, so the header can say when they diverge. */
  const [ran, setRan] = useState<AssumptionValues>(BASELINE_ASSUMPTIONS);

  const run = useApiMutation<AssumptionValues, ScenarioResponse>({
    run: (client, input) =>
      client.scenario({
        latitude: location.latitude,
        longitude: location.longitude,
        days: LAB_DAYS,
        assumptions: assumptionsFor(input),
      }),
  });

  /*
   * The lab opens loaded.
   *
   * A run with every assumption at zero *is* the retrieved forecast — the endpoint says so — so
   * this is not a wasted call or a placeholder: it is the baseline every panel is drawn from and
   * the thing the next run will be compared against. Held by a ref and keyed on the place, so a
   * re-render is not a second retrieval.
   */
  const submitRef = useRef(run.submit);
  useEffect(() => {
    submitRef.current = run.submit;
  }, [run.submit]);

  const loaded = useRef<string | null>(null);
  const placeKey = `${location.latitude},${location.longitude}`;
  useEffect(() => {
    if (loaded.current === placeKey) return;
    loaded.current = placeKey;
    submitRef.current(BASELINE_ASSUMPTIONS);
  }, [placeKey]);

  const result = run.state.kind === "saved" ? run.state.data : null;
  const dirty = useMemo(
    () => ASSUMPTION_CONTROLS.some((control) => values[control.key] !== ran[control.key]),
    [values, ran],
  );

  const submit = (next: AssumptionValues) => {
    setRan(next);
    run.submit(next);
  };

  const header = (
    <LabHeader
      location={location}
      chooser={chooser}
      busy={run.busy}
      dirty={dirty}
      onRun={() => submit(values)}
      onReset={() => {
        setValues(BASELINE_ASSUMPTIONS);
        submit(BASELINE_ASSUMPTIONS);
      }}
    />
  );

  if (run.state.kind === "error") {
    return (
      <div className={styles.screen}>
        {header}
        <ErrorState
          failure={run.state.failure}
          title="That scenario was not calculated"
          onRetry={() => submit(values)}
        />
      </div>
    );
  }

  if (result === null) {
    return (
      <div className={styles.screen}>
        {header}
        <LoadingState label={`Retrieving the baseline forecast for ${location.display_name}`} lines={6} />
      </div>
    );
  }

  const baselineCard = baselineCardFrom(result);
  const impactCard = impactCardFrom(result);
  const historical = historicalFrom(result);
  /*
   * Read off the *displayed run*, not off the sliders.
   *
   * The controls can hold a figure nobody has pressed Run on yet, and a panel branching on them
   * would describe a scenario that was never calculated. Every panel below branches on this one
   * value, so the badge, the plot, the tiles, the reading and the archive title cannot disagree
   * about which state the screen is in.
   */
  const changed = isChangedRun(result);
  const points = pointsFor(result.baseline, result.scenario);
  const units = result.baseline?.units ?? {};
  const references = baselineReferencesFrom(result);

  return (
    <div className={styles.screen}>
      {header}

      {/* With nothing supposed, say so once, at the top, rather than leaving it to be inferred. */}
      {changed ? null : <BaselineNotice location={location} />}

      <div className={styles.body}>
        {/* The rail, down the left of everything. */}
        <div className={styles.rail}>
          <Region
            id="lab-assumptions"
            title="User-defined assumptions"
            icon="sliders"
            level="lead"
            subtitle="Adjust atmospheric variables to simulate edge cases."
            badges={<Badge tone="quota">Simulated</Badge>}
          >
            <AssumptionRail values={values} onChange={change(setValues)} baseline={references} />
            <ScenarioBasis rows={basisFrom(result)} />
          </Region>
        </div>

        <div className={styles.analysis}>
          {/* ROW 2 — what it starts from, and what the assumptions make of it. */}
          <div className={styles.pair}>
            {baselineCard ? (
              <Region
                id="lab-baseline"
                title="Baseline weather data"
                icon="baseline"
                badges={<DataClassBadge dataClass="forecast" />}
              >
                <ResultCard
                  card={baselineCard}
                  variant="baseline"
                  retrievedAt={result.attribution?.retrieved_at ?? null}
                />
              </Region>
            ) : null}

            {impactCard ? (
              <Region
                id="lab-impact"
                title="Calculated analytical impact"
                icon="impact"
                badges={
                  changed ? <Badge tone="quota">Simulated</Badge> : <Badge>Unchanged</Badge>
                }
              >
                <ResultCard card={impactCard} variant="scenario" />
              </Region>
            ) : null}
          </div>

          {/* ROW 3 — the plot. */}
          <Region
            id="lab-projection"
            title="Temporal impact projection"
            icon="projection"
            subtitle={
              changed
                ? "The retrieved forecast against the user-defined scenario, over the same hours."
                : "Baseline and scenario over the same hours. With nothing supposed they are the same series."
            }
            badges={changed ? <Badge tone="quota">Simulated</Badge> : <Badge>Baseline</Badge>}
          >
            <TemporalImpactChart
              points={points}
              unit={units.temperature ?? null}
              precipitationUnit={units.precipitation ?? null}
              changed={changed}
            />
          </Region>

          {/* ROW 4 — four deltas. */}
          <DeltaStrip tiles={deltaTilesFrom(result)} />

          {/* ROW 5 — the reading, its key movements, and the two derived signals. */}
          <Region
            id="lab-interpretation"
            title="Interpretation & insights"
            icon="insight"
            level="lead"
            subtitle="Computed by Weathra from the figures above. No language model is involved."
            badges={<DataClassBadge dataClass="analytics" />}
          >
            <Interpretation
              reading={interpretationFrom(result, location)}
              keyDeltas={keyDeltasFrom(result)}
              signals={signalsFrom(result)}
            />
          </Region>
        </div>
      </div>

      {/* ROW 6 — the archive, full width. Absent when it could not serve the window. */}
      {historical ? (
        <Region
          id="lab-historical"
          title={historical.title}
          icon="archive"
          subtitle={historical.subtitle}
          badges={<DataClassBadge dataClass="historical" />}
        >
          <HistoricalCorrelation view={historical} />
        </Region>
      ) : null}

      <HowThisWorks methods={(result.measures ?? []).map((measure) => measure.method)} />

      {/* ROW 7 — what this is and is not, in the backend's own sentence. */}
      <AnalyticalDisclaimer text={result.disclaimer} />
    </div>
  );
}

/** One slider's change, applied to the rail's state. */
function change(
  set: (update: (current: AssumptionValues) => AssumptionValues) => void,
): (key: AssumptionKey, value: number) => void {
  return (key, value) => set((current) => ({ ...current, [key]: value }));
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

  const chooser = (
    <LabPlaceChooser
      location={location}
      usingDefault={chosen === null}
      hasDefault={saved !== null}
      onChoose={setChosen}
    />
  );

  return (
    <>
      {/*
        With no place there is nothing to retrieve and nothing to adjust, so the screen is a short
        statement of what the lab does and the one control that resolves that. It used to draw three
        full-size empty panels underneath — an assumptions card, a plot frame and an archive frame,
        all blank — which is a screen pretending to be loaded rather than a screen that is waiting.
        Everything fills in the moment a place resolves.
      */}
      {location === null ? (
        <LabIntroduction chooser={chooser} />
      ) : (
        <LabFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
          chooser={chooser}
        />
      )}
    </>
  );
}
