"use client";

/**
 * Weather Intelligence Report — `docs/design/screens/12-weather-intelligence-report.png`.
 *
 * Composed from `/weather/current`, `/weather/forecast`, `/weather/changes`, `/weather/analysis`,
 * `/weather/history/baseline`, `/weather/history/baseline/comparison` and one `/agent/ask` run.
 * Every figure on it is retrieved or deterministically computed; the screen adds none of its own.
 *
 * **The artifact's macro composition, and it is the composition rather than a resemblance to it.**
 * Seven rows, each one a wide analytical column beside a narrow context column:
 *
 *     1  report header                                              full width
 *     2  the conclusion, three figures         ·  six observed tiles
 *     3  forecast outlook, seven days          ·  what changed
 *     4  deterministic thermal analysis        ·  historical context
 *     5  …the same chart's summary figures     ·  anomaly attention
 *     6  grounded synthesis                    ·  grounding evidence
 *     7  status strip                                               full width
 *
 * Rows four and five are one chart card on the left against two stacked cards on the right, which
 * is how the artifact draws them.
 *
 * **Three things this pass changed, and each was a defect rather than a preference.**
 *
 * *The photograph is gone.* A 220-pixel picture of the city sat where the artifact puts its
 * conclusion, with the current temperature over it — the first thing a reader scanned spent on the
 * one fact they already had. The reading it carried is the first of the six tiles beside the hero.
 *
 * *The synthesis is part of generating the report.* It was a button. The artifact's most
 * conclusive block was, in production, the one obviously unfinished thing on the page, and asking
 * somebody to press a control to finish a report they had already asked for is not a bargain worth
 * keeping. The run starts with the report; the card draws a skeleton while it is in flight and the
 * backend's own failure with a retry when it does not land, because it is a real model call against
 * a real allowance and pretending otherwise would be the opposite mistake.
 *
 * *No figure is printed at the precision it was computed at.* `0.6706849412785952 σ` was on the
 * page. Rounding lives in `lib/report/view-model.ts` with everything else that decides what the
 * report says.
 *
 * **What the artifact draws and Weathra does not have:** an agent version string, an evidence-node
 * count, a retrieval score, a PDF export, a confidence percentage attached to the narrative, a
 * decadal stability index, a model-alignment score, named third-party feeds with millisecond
 * latencies, and a sensor network in the footer. The report reference is the one exception that
 * became real: it is the evidence id of the synthesis run, which is a record somebody can open.
 * Recorded in `docs/design/screens.md` §5.
 */

import { ScreenPreview } from "@/components/locations/screen-preview";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DataClassBadge,
  EmptyChart,
  ErrorState,
  LoadingState,
  formatInstant,
} from "@/components/ui";
import type {
  AnalysisResponse,
  AskResponse,
  Baseline,
  BaselineComparison,
  CurrentResponse,
  ForecastResponse,
  Location,
  PreferenceView,
  WhatChanged,
} from "@/lib/api/schema";
import { briefingLocationFrom, calendarWindowFrom } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import {
  anomalyAttentionFrom,
  changedFrom,
  chartStatsFrom,
  currentTilesFrom,
  footerFrom,
  groundingFrom,
  headlineFrom,
  heroFiguresFrom,
  historicalContextFrom,
  isReportHorizon,
  outlookFrom,
  reportReferenceFrom,
} from "@/lib/report/view-model";

import {
  ForecastTimelineChart,
  hourLabelOf,
  type DeviationPoint,
  type TimelinePoint,
} from "./charts";
import {
  AnomalyAttentionCard,
  ChartStats,
  ConditionTiles,
  DeepDive,
  FooterStrip,
  GroundedSynthesis,
  GroundingPanel,
  HistoricalContextCard,
  HourlyTraceLink,
  IntelligenceHero,
  OutlookStrip,
  Region,
  ReportHeader,
  ReportPlaceChooser,
  WhatChangedPanel,
} from "./sections";
import styles from "./report.module.css";

/** The hourly window as plottable points. An hour with no temperature stays null, never zero. */
function timelineFrom(forecast: ForecastResponse | null): TimelinePoint[] {
  return (forecast?.hourly?.entries ?? []).map((entry) => ({
    label: hourLabelOf(entry.time_local),
    stamp: entry.time_local,
    temperature:
      typeof entry.values?.temperature === "number" ? entry.values.temperature : null,
    precipitation:
      typeof entry.values?.precipitation === "number" ? entry.values.precipitation : null,
  }));
}

/** The entries the backend flagged, as the deviation plot's rows. */
function deviationsFrom(analysis: AnalysisResponse | null): DeviationPoint[] {
  return (analysis?.anomalies?.anomalies ?? []).map((point) => ({
    label: hourLabelOf(point.time_local),
    stamp: point.time_local,
    deviation: point.deviation,
    score: point.deviation_score,
  }));
}

/** What the report covers, in one line. About the report, never about the weather. */
function scopeOf(days: number): string {
  return `Current conditions, a ${days}-day outlook and the archive record for the same window.`;
}

/**
 * The analytical block's title.
 *
 * The artifact's is "Deterministic Thermal Drift Analysis", and thermal is only the right word
 * while temperature is genuinely what is plotted and compared. It is — the chart draws the hourly
 * temperature series and the baseline is asked for on `temperature_mean` — so the title says so;
 * a measure change would take the general title rather than keep a word the plot no longer earns.
 */
function analysisTitleFor(measure: string | null | undefined): string {
  return measure?.startsWith("temperature")
    ? "Deterministic thermal analysis"
    : "Deterministic weather analysis";
}

function ReportFor({
  location,
  chooser,
  defaultHorizon,
}: {
  readonly location: Location;
  /** The screen's place control, folded into the header band. */
  readonly chooser: ReactNode;
  /** The horizon the person's preferences ask for, as the control's starting value. */
  readonly defaultHorizon: string;
}): ReactNode {
  const place = { latitude: location.latitude, longitude: location.longitude };

  /*
   * The artifact's TODAY / 3D / 7D / 14D control, and it is a real one: `days` is a parameter of
   * `GET /weather/forecast`, `/weather/changes` and `/weather/analysis`, so changing it re-reads
   * all three against the new window rather than re-slicing a window already fetched. The baseline
   * follows, because it is asked for over whatever calendar period the forecast came back naming.
   */
  const [horizon, setHorizon] = useState(defaultHorizon);
  const days = Number(horizon);

  const current = useApiQuery<CurrentResponse>({
    key: ["weather", "current", place.latitude, place.longitude],
    request: (client) => client.current(place),
  });
  const forecast = useApiQuery<ForecastResponse>({
    key: ["weather", "forecast", place.latitude, place.longitude, days],
    request: (client) => client.forecast({ ...place, days }),
  });
  const changes = useApiQuery<WhatChanged>({
    key: ["weather", "changes", place.latitude, place.longitude, days],
    request: (client) => client.changes({ ...place, days }),
  });
  const analysis = useApiQuery<AnalysisResponse>({
    key: ["weather", "analysis", place.latitude, place.longitude, days],
    request: (client) => client.analysis({ ...place, days }),
  });

  const window = calendarWindowFrom(
    forecast.state.kind === "ready" ? forecast.state.data.period : undefined,
  );
  const baseline = useApiQuery<Baseline>({
    key: ["weather", "baseline", place.latitude, place.longitude, window?.start, window?.end],
    request: (client) =>
      client.baseline({
        ...place,
        start: window!.start,
        end: window!.end,
        measure: "temperature_mean",
      }),
    enabled: window !== null,
  });
  /*
   * The window placed against the record — the artifact's "+1.4°C DRIFT DETECTED / 2.84σ" pair.
   *
   * Held until the forecast has named the window, like the baseline above, so the two describe the
   * same calendar period rather than two that happen to be near each other. A backend that cannot
   * compute it answers with a failure this screen omits the figure for; it is never approximated
   * here from the baseline mean and a current reading, which would be this screen inventing a
   * statistic and attributing it to the analytics engine.
   */
  const comparison = useApiQuery<BaselineComparison>({
    key: [
      "weather",
      "baseline-comparison",
      place.latitude,
      place.longitude,
      window?.start,
      window?.end,
    ],
    request: (client) =>
      client.baselineComparison({
        ...place,
        start: window!.start,
        end: window!.end,
        measure: "temperature_mean",
      }),
    enabled: window !== null,
  });

  const synthesis = useApiMutation<void, AskResponse>({
    run: (client) =>
      client.ask({
        question: `Summarise the weather outlook for ${friendlyName(location)} over the next ${days} days, using the retrieved figures only.`,
      }),
  });

  /*
   * The synthesis runs once per window, as part of generating the report.
   *
   * The window is the guard, not the callback: `submit` is recreated whenever the mutation's
   * pending flag flips, so an effect that depended on it would fire a second run the moment the
   * first one settled — a model call and an allowance spent on a duplicate. It is held in a ref
   * instead and the effect keys on the window alone. Changing the horizon is a person asking for a
   * different report, which is a run; re-rendering is not.
   */
  const submitRef = useRef(synthesis.submit);
  useEffect(() => {
    submitRef.current = synthesis.submit;
  }, [synthesis.submit]);

  const asked = useRef<string | null>(null);
  const windowKey = `${place.latitude},${place.longitude},${days}`;
  useEffect(() => {
    if (asked.current === windowKey) return;
    asked.current = windowKey;
    submitRef.current();
  }, [windowKey]);

  const forecastData = forecast.state.kind === "ready" ? forecast.state.data : null;
  const currentData = current.state.kind === "ready" ? current.state.data : null;
  const changesData = changes.state.kind === "ready" ? changes.state.data : null;
  const analysisData = analysis.state.kind === "ready" ? analysis.state.data : null;
  const baselineData = baseline.state.kind === "ready" ? baseline.state.data : null;
  const comparisonData = comparison.state.kind === "ready" ? comparison.state.data : null;
  const answer = synthesis.state.kind === "saved" ? synthesis.state.data.answer : null;
  const evidenceId =
    synthesis.state.kind === "saved" ? (synthesis.state.data.evidence_id ?? null) : null;

  /*
   * The header outlives the report.
   *
   * Both branches below used to replace the whole screen with one sentence, so a provider hiccup
   * took the heading, the place chooser and the window control with it — and those are the two
   * controls that would let a person try somewhere else, or a shorter window.
   */
  const header = (
    <ReportHeader
      location={location}
      scope={scopeOf(forecastData?.horizon_days ?? days)}
      reference={reportReferenceFrom(evidenceId)}
      horizon={horizon}
      onHorizon={setHorizon}
      retrievedAt={forecastData?.attribution?.retrieved_at ?? null}
      chooser={chooser}
    />
  );

  if (forecast.state.kind === "loading" || current.state.kind === "loading") {
    return (
      <div className={styles.screen}>
        {header}
        <LoadingState label={`Building the report for ${friendlyName(location)}`} lines={6} />
      </div>
    );
  }
  if (forecast.state.kind === "error") {
    return (
      <div className={styles.screen}>
        {header}
        <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />
      </div>
    );
  }

  const timeline = timelineFrom(forecastData);
  const missingHours = timeline.filter((point) => point.temperature === null).length;
  const plottable = timeline.some((point) => point.temperature !== null);
  const deviations = deviationsFrom(analysisData);

  const outlook = outlookFrom(forecastData);
  const grounding = groundingFrom({
    current: currentData,
    forecast: forecastData,
    baseline: baselineData,
    analysis: analysisData,
    answer,
  });
  const headline = headlineFrom({
    comparison: comparisonData,
    analysis: analysisData,
    outlook,
  });
  const heroFigures = heroFiguresFrom({
    forecast: forecastData,
    comparison: comparisonData,
    analysis: analysisData,
    groundingRows: grounding.length,
    answer,
  });
  const tiles = currentTilesFrom(currentData);
  const changed = changedFrom(changesData);
  const stats = chartStatsFrom({
    analysis: analysisData,
    baseline: baselineData,
    comparison: comparisonData,
  });
  const historical = historicalContextFrom({ baseline: baselineData });
  const attention = anomalyAttentionFrom(analysisData);

  const reads = [currentData, forecastData, changesData, analysisData, baselineData, comparisonData];
  const footer = footerFrom({
    reads: reads.length,
    returned: reads.filter((read) => read !== null).length,
    answer,
  });

  const baselineMean =
    typeof baselineData?.mean?.value === "number" ? baselineData.mean.value : null;
  const temperatureUnit =
    forecastData?.hourly?.units?.temperature ?? currentData?.units?.temperature ?? null;
  const precipitationUnit = forecastData?.hourly?.units?.precipitation ?? null;

  const retrievals = [
    currentData?.attribution?.retrieved_at
      ? {
          label: `Conditions · ${currentData.attribution.provider}`,
          detail: formatInstant(currentData.attribution.retrieved_at) ?? "not reported",
        }
      : null,
    forecastData?.attribution?.retrieved_at
      ? {
          label: `Forecast · ${forecastData.attribution.provider}`,
          detail: formatInstant(forecastData.attribution.retrieved_at) ?? "not reported",
        }
      : null,
    baselineData ? { label: "Archive record", detail: baselineData.labelling } : null,
  ].filter((entry): entry is { label: string; detail: string } => entry !== null);

  return (
    <div className={styles.screen}>
      {header}

      {/* ROW 2 — the conclusion, and what it is like right now. */}
      <div className={styles.band}>
        <IntelligenceHero headline={headline} figures={heroFigures} />
        <ConditionTiles tiles={tiles} observedAt={currentData?.observed_at_utc ?? null} />
      </div>

      {/* ROW 3 — the days ahead, and what moved since the last retrieval. */}
      <div className={styles.band}>
        <Region
          id="report-outlook"
          title="Forecast outlook"
          icon="outlook"
          subtitle={
            forecastData?.attribution?.provider
              ? `Daily steps · ${forecastData.attribution.provider}`
              : undefined
          }
          action={plottable ? <HourlyTraceLink /> : undefined}
        >
          {outlook.length > 0 ? (
            <OutlookStrip days={outlook} />
          ) : (
            <p className={styles.quiet}>
              This provider reported no daily outlook for this window.
            </p>
          )}
        </Region>

        <Region id="report-moved" title="What changed?" icon="changed">
          <WhatChangedPanel changed={changed} />
        </Region>
      </div>

      {/* ROWS 4 and 5 — one chart against the record, with the record and the flags beside it. */}
      <div className={styles.band}>
        <div className={styles.analysisColumn} id="report-analysis">
          <Region
            id="report-analysis-title"
            title={analysisTitleFor(baselineData?.measure ?? "temperature_mean")}
            icon="analytics"
            subtitle="Forecast values against the archive baseline for the same calendar window."
          >
            {plottable ? (
              <ForecastTimelineChart
                points={timeline}
                temperatureUnit={temperatureUnit}
                precipitationUnit={precipitationUnit}
                baselineValue={baselineMean}
                /*
                  One word. The label sits inside the plot at the reference line, and
                  "Baseline 3-year mean" was long enough to run over the series beneath it. What the
                  baseline is built from is stated in the card beside this chart, where it has room.
                */
                baselineLabel={baselineData ? "Baseline" : null}
                missing={missingHours}
                title="Temperature through the forecast window"
              />
            ) : (
              <EmptyChart
                title="Temperature through the forecast window"
                reason="This provider reported no hourly series for this window."
              />
            )}

            <ChartStats stats={stats} />
          </Region>
        </div>

        <div className={styles.sideColumn}>
          <Region
            id="report-history"
            title="Historical context"
            icon="history"
            subtitle={historical ? undefined : "No baseline is available for this window yet."}
          >
            {historical ? (
              <HistoricalContextCard context={historical} />
            ) : (
              <p className={styles.quiet}>
                The archive returned no baseline for this calendar window, so nothing is placed
                against it.
              </p>
            )}
          </Region>

          {/* Drawn only when the backend flagged something. An always-present alert is not one. */}
          {attention ? (
            <Region id="report-attention" title="Anomaly attention" icon="alert" tone="alert">
              <AnomalyAttentionCard attention={attention} />
            </Region>
          ) : null}
        </div>
      </div>

      {/* ROW 6 — what Weathra concludes, and what the conclusion rests on. */}
      <div className={styles.band}>
        <Region
          id="report-synthesis"
          title="Grounded synthesis"
          icon="interpretation"
          level="lead"
          subtitle="Written by a language model about the figures above. It produces no measurement."
          badges={<DataClassBadge dataClass="interpretation" />}
        >
          <GroundedSynthesis
            answer={answer}
            chips={grounding.map((row) => ({ label: row.role, dataClass: row.dataClass }))}
            evidenceId={evidenceId}
            busy={synthesis.busy}
            failure={synthesis.state.kind === "error" ? synthesis.state.failure : null}
            onRetry={() => synthesis.submit()}
          />
        </Region>

        <Region
          id="report-sources"
          title="Grounding evidence"
          icon="grounding"
          subtitle="What each part of this report was read from."
        >
          {grounding.length > 0 ? (
            <GroundingPanel rows={grounding} />
          ) : (
            <p className={styles.quiet}>No provider reported an attribution for this report.</p>
          )}
        </Region>
      </div>

      {/* ROW 7 — the working, and the status strip. */}
      <DeepDive
        analysis={analysisData}
        forecast={forecastData}
        deviations={deviations}
        baselineNote={
          baselineData
            ? `The baseline is computed by Weathra from ${baselineData.years_used?.length ?? 0} year${
                (baselineData.years_used?.length ?? 0) === 1 ? "" : "s"
              } of retrieved archive observations for this calendar window. It is not a climate normal published by a meteorological authority.`
            : null
        }
        retrievals={retrievals}
      />

      <FooterStrip
        states={footer}
        retrievedAt={forecastData?.attribution?.retrieved_at ?? null}
      />
    </div>
  );
}

export function WeatherIntelligenceReport(): ReactNode {
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

  /*
   * The saved horizon is the control's starting value, so the report opens on the window the
   * person's preferences ask for rather than on a number written here. A preference outside the
   * four the control offers falls back to the middle one instead of adding a fifth button.
   */
  const preferred = String(preferences.state.data.forecast_horizon_days ?? 7);
  const defaultHorizon = isReportHorizon(preferred) ? preferred : "7";

  const chooser = (
    <ReportPlaceChooser
      location={location}
      usingDefault={chosen === null}
      hasDefault={saved !== null}
      onChoose={setChosen}
    />
  );

  return (
    <>
      {/*
        The screen's own place control. With no default this used to be an empty state and a link
        to Settings, which made the feature reachable only by configuring a preference somewhere
        else first — see `PlaceChooser` for why that is not a substitute for a product.
      */}
      {location === null ? (
        <>
          {chooser}
          <ScreenPreview
            title="The report covers one place"
            lead="Name a place above, or set a default in Settings and every screen opens on it. Nothing below is filled in yet because no place has been chosen."
            regions={[
              {
                title: "Current conditions",
                blurb:
                  "Temperature, wind, humidity and pressure as retrieved, with the moment they were observed.",
              },
              {
                title: "Forecast outlook",
                blurb: "The forecast horizon your preferences ask for, day by day.",
                chart: 150,
              },
              {
                title: "Deterministic thermal analysis",
                blurb:
                  "How this period compares with the climate baseline for the same place and time of year.",
                chart: 150,
              },
              {
                title: "Grounded synthesis",
                blurb:
                  "An interpretation of the figures above, clearly separated from them, with the sources it was grounded on.",
              },
            ]}
          />
        </>
      ) : (
        <ReportFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
          chooser={chooser}
          defaultHorizon={defaultHorizon}
        />
      )}
    </>
  );
}
