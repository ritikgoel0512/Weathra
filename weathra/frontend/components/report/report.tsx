"use client";

/**
 * Weather Intelligence Report — one place, read across every surface Weathra has, and *curated*.
 *
 * Built against `docs/design/screens/12-weather-intelligence-report.png`. Composed from
 * `/weather/current`, `/weather/forecast`, `/weather/changes`, `/weather/analysis`,
 * `/weather/history/baseline` and `/weather/history/baseline/comparison` — the report is a
 * *reading* of those six, and adds no figure of its own.
 *
 * **The last rebuild made it a report with charts through it; this one makes it a report somebody
 * would read.** Every endpoint's whole payload was on the page: every computed finding as its own
 * tile, every horizon band as its own bar, every flagged entry plotted and then listed again
 * underneath, a paragraph of provenance under every source, and a full-width "Ask Weathra to read
 * this" call to action where the artifact puts its conclusion. Nine panels, about 2,800 pixels of
 * report, and the decisions a person actually came for scattered among the working.
 *
 * The artifact's answer is curation, and it is structural rather than cosmetic. Seven regions, in
 * this order, each answering exactly one question:
 *
 *     header          what is this, where, over what window
 *     hero            what is happening, in one statement and three figures
 *     conditions      what is it like right now                       (six tiles)
 *     outlook         what are the next few days                      (seven cards)
 *     what changed    what moved since the last retrieval             (three notes)
 *     the record      how unusual is this, against the archive        (one chart, one side card)
 *     the reading     what Weathra concludes, and what it rests on    (one paragraph, four rows)
 *
 * Every count above is a constant in `lib/report/view-model.ts`, which is also where the choosing
 * happens — so what the report shows is one module's decision rather than a rule re-litigated in
 * each panel. **Nothing is deleted.** What a cap dropped is behind that panel's own disclosure, and
 * the three regions this pass took off the page — every finding, the confidence scale, and the
 * flagged entries — are together behind *Deep dive* at the foot of the screen.
 *
 * **A region whose data did not arrive is not drawn.** No zero bars, no filled meters, no
 * placeholder tiles: `EmptyChart` keeps a chart region's geometry when a series is genuinely
 * expected and absent, and everything else is omitted with the backend's own reason.
 *
 * **The synthesis is asked for, not spent automatically, and it is no longer the loudest thing on
 * the page.** The artifact's is written by an agent it calls neural and appears the moment the page
 * opens. Weathra's is a real model call against a real allowance, so it stays a control — a
 * secondary one, in a card the report is complete without.
 *
 * **What the artifact draws and Weathra does not have:** an agent version string, an evidence-node
 * count, a report identifier, a PDF export, a confidence percentage attached to the narrative, a
 * decadal stability index, a model-alignment score, and named third-party feeds with millisecond
 * latencies. Recorded in `docs/design/screens.md` §5.
 */

import { ScreenPreview } from "@/components/locations/screen-preview";
import { useState, type ReactNode } from "react";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
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
import {
  briefingLocationFrom,
  calendarWindowFrom,
  formatFigure,
} from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import {
  anomalyAttentionFrom,
  changedFrom,
  chartStatsFrom,
  currentTilesFrom,
  evidenceChipsFrom,
  groundingFrom,
  heroFiguresFrom,
  historicalContextFrom,
  isReportHorizon,
  outlookFrom,
  synthesisFrom,
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
  GroundedSynthesis,
  GroundingPanel,
  HistoricalContextCard,
  OutlookStrip,
  ReportHeader,
  ReportHero,
  ReportPlaceChooser,
  WhatChangedNotes,
} from "./sections";
import styles from "./report.module.css";

/** One panel of the report. The badge names the class of everything inside it. */
function Panel({
  title,
  id,
  dataClass,
  badges,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly id: string;
  readonly dataClass:
    "observed" | "forecast" | "historical" | "analytics" | "interpretation";
  /** A second class, where a panel genuinely reads two — the record against the window. */
  readonly badges?: ReactNode;
  readonly subtitle?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Card aria-labelledby={id}>
      {/* Level two: these sit directly under the screen's own `h1`. */}
      <CardHeader
        headingLevel={2}
        title={title}
        titleId={id}
        subtitle={subtitle}
        badge={
          <>
            {badges}
            <DataClassBadge dataClass={dataClass} />
          </>
        }
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

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

function ReportFor({
  location,
  chooser,
  defaultHorizon,
}: {
  readonly location: Location;
  /** The screen's place control, folded into the header bar. */
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
    key: [
      "weather",
      "baseline",
      place.latitude,
      place.longitude,
      window?.start,
      window?.end,
    ],
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

  const forecastData = forecast.state.kind === "ready" ? forecast.state.data : null;
  const currentData = current.state.kind === "ready" ? current.state.data : null;
  const changesData = changes.state.kind === "ready" ? changes.state.data : null;
  const analysisData = analysis.state.kind === "ready" ? analysis.state.data : null;
  const baselineData = baseline.state.kind === "ready" ? baseline.state.data : null;
  const comparisonData = comparison.state.kind === "ready" ? comparison.state.data : null;

  /*
   * The shell outlives the report.
   *
   * Both branches below used to replace the whole screen with one sentence, so a provider hiccup
   * took the heading, the place chooser and the horizon control with it — and those are the two
   * controls that would let a person try somewhere else, or a shorter window.
   */
  const header = (
    <ReportHeader
      location={location}
      scope={scopeOf(forecastData?.horizon_days ?? days)}
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
        <LoadingState
          label={`Building the report for ${friendlyName(location)}`}
          lines={6}
        />
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

  const heroSynthesis = synthesisFrom({
    analysis: analysisData,
    comparison: comparisonData,
  });
  const heroFigures = heroFiguresFrom({
    forecast: forecastData,
    comparison: comparisonData,
    analysis: analysisData,
  });
  const tiles = currentTilesFrom(currentData);
  const outlook = outlookFrom(forecastData);
  const changed = changedFrom(changesData);
  const stats = chartStatsFrom({
    analysis: analysisData,
    baseline: baselineData,
    comparison: comparisonData,
  });
  const historical = historicalContextFrom({
    baseline: baselineData,
    comparison: comparisonData,
    headline: heroSynthesis.headline,
  });
  const attention = anomalyAttentionFrom(analysisData);
  const grounding = groundingFrom({
    current: currentData,
    forecast: forecastData,
    baseline: baselineData,
    analysis: analysisData,
    formatStamp: formatInstant,
  });

  const temperature = currentData?.values?.temperature;
  const reading =
    typeof temperature === "number"
      ? {
          figure: formatFigure({ value: temperature }),
          unit: currentData?.units?.temperature ?? null,
        }
      : null;

  const baselineMean =
    typeof baselineData?.mean?.value === "number" ? baselineData.mean.value : null;
  const temperatureUnit =
    forecastData?.hourly?.units?.temperature ?? currentData?.units?.temperature ?? null;
  const precipitationUnit = forecastData?.hourly?.units?.precipitation ?? null;

  const answer = synthesis.state.kind === "saved" ? synthesis.state.data.answer : null;

  return (
    <div className={styles.screen}>
      {header}

      {/* What is happening, and what it is like right now. */}
      <div className={styles.lead}>
        <ReportHero
          location={location}
          synthesis={heroSynthesis}
          figures={heroFigures}
          reading={reading}
          observedAt={currentData?.observed_at_utc ?? null}
        />

        {tiles.shown.length > 0 ? (
          <Panel id="report-now" title="Conditions now" dataClass="observed">
            <ConditionTiles tiles={tiles} />
          </Panel>
        ) : null}
      </div>

      {/* What the next few days look like, and what moved since the last retrieval. */}
      <div className={styles.band}>
        <Panel
          id="report-outlook"
          title="Forecast outlook"
          dataClass="forecast"
          subtitle={
            forecastData?.attribution?.provider
              ? `Day by day, from ${forecastData.attribution.provider}.`
              : undefined
          }
        >
          {outlook.length > 0 ? (
            <OutlookStrip days={outlook} />
          ) : (
            <p className={styles.quiet}>
              This provider reported no daily outlook for this window.
            </p>
          )}
        </Panel>

        <Panel id="report-moved" title="What changed" dataClass="forecast">
          {changed ? (
            <WhatChangedNotes changed={changed} />
          ) : (
            <p className={styles.quiet}>
              No earlier forecast is on record to compare this window against.
            </p>
          )}
        </Panel>
      </div>

      {/*
        The one analytical block. The window plotted against the archive record, with the figures
        that describe it under the plot — and beside it, the record itself and whatever the backend
        flagged. Everything else it computed is behind *Deep dive*.
      */}
      <div className={styles.band}>
        <Panel
          id="report-window"
          title="The window, against the record"
          dataClass="analytics"
          badges={<DataClassBadge dataClass="historical" />}
          subtitle="The forecast series, with the archive baseline drawn through it."
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
                baseline is built from is stated in full in the panel beside this chart, where it
                has room to be a sentence.
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
        </Panel>

        <div className={styles.sideColumn}>
          <Panel
            id="report-history"
            title="Historical context"
            dataClass="historical"
            subtitle={
              historical ? undefined : "No baseline is available for this window yet."
            }
          >
            {historical ? (
              <HistoricalContextCard context={historical} />
            ) : (
              <p className={styles.quiet}>
                The archive returned no baseline for this calendar window, so nothing is
                placed against it.
              </p>
            )}
          </Panel>

          {/* Drawn only when the backend flagged something. An always-present alert is not one. */}
          {attention ? (
            <Panel id="report-attention" title="Needs attention" dataClass="analytics">
              <AnomalyAttentionCard attention={attention} />
            </Panel>
          ) : null}
        </div>
      </div>

      {/* What Weathra concludes, and what the conclusion rests on. */}
      <div className={styles.band}>
        <Panel
          id="report-synthesis"
          title="Weathra's reading"
          dataClass="interpretation"
          subtitle="Written by a language model about the figures above. It produces no measurement."
        >
          {synthesis.state.kind === "error" ? (
            <ErrorState
              failure={synthesis.state.failure}
              title="That reading was not produced"
            />
          ) : (
            <GroundedSynthesis
              answer={answer}
              chips={evidenceChipsFrom({ answer, baseline: baselineData })}
              evidenceId={
                synthesis.state.kind === "saved"
                  ? (synthesis.state.data.evidence_id ?? null)
                  : null
              }
              busy={synthesis.busy}
              onAsk={() => synthesis.submit()}
            />
          )}
        </Panel>

        <Panel
          id="report-sources"
          title="Grounding evidence"
          dataClass="observed"
          subtitle="What each part of this report was read from."
        >
          {grounding.length > 0 ? (
            <GroundingPanel rows={grounding} />
          ) : (
            <p className={styles.quiet}>No provider reported an attribution for this report.</p>
          )}
        </Panel>
      </div>

      {/* The working, kept and moved off the page. */}
      <DeepDive
        analysis={analysisData}
        forecast={forecastData}
        deviations={deviations}
      />

      {analysisData?.from_cache ? (
        <p className={styles.quiet}>
          <Badge tone="neutral">Cached</Badge> The statistics above were served from Weathra&apos;s
          own cache of this window.
        </p>
      ) : null}
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
    return (
      <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />
    );
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
                title: "Conditions now",
                blurb:
                  "Temperature, wind, humidity and pressure as retrieved, with the moment they were observed.",
              },
              {
                title: "Forecast outlook",
                blurb: "The forecast horizon your preferences ask for, day by day.",
                chart: 150,
              },
              {
                title: "The window, against the record",
                blurb:
                  "How this period compares with the climate baseline for the same place and time of year.",
                chart: 150,
              },
              {
                title: "Weathra's reading",
                blurb:
                  "An interpretation of the figures above, clearly separated from them, asked for rather than spent on arrival.",
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
