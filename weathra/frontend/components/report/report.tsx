"use client";

/**
 * Weather Intelligence Report — one place, read across every surface Weathra has.
 *
 * Built against `docs/design/screens/12-weather-intelligence-report.png`. Composed from
 * `/weather/current`, `/weather/forecast`, `/weather/changes`, `/weather/analysis`,
 * `/weather/history/baseline` and `/weather/history/baseline/comparison` — the report is a
 * *reading* of those six, and adds no figure of its own.
 *
 * **This is a report with charts through it, not a document with figures in it.** The first build
 * had the artifact's sections as six stacked description lists, and the production fidelity review
 * of 2026-09-10 graded it NOT CLOSE for exactly that: "the artifact is a report with charts through
 * it; ours is mostly figures and prose in cards. The sections are right and the graphical weight is
 * not." The composition below is the artifact's own — a photographic hero with its figure tiles, an
 * observed column beside it, the outlook as day cards over a plotted window, the record drawn as a
 * reference line through that window rather than described beside it, deviation as a plot when the
 * backend flagged any, and the sources as a footer.
 *
 * Every region follows one hierarchy: **the visualisation or the figure, a short label, and one
 * short line of interpretation** — where that line is a figure, a phrase the backend wrote, or the
 * method a statistic states. None of it is composed here.
 *
 * **A region whose data did not arrive is not drawn.** No zero bars, no filled meters, no
 * placeholder tiles: `EmptyChart` keeps a chart region's geometry when a series is genuinely
 * expected and absent, and everything else is omitted with the backend's own reason. That is what
 * makes the thin-data case — two observed measures rather than six, two forecast days rather than
 * seven — read as a shorter report rather than as a broken one.
 *
 * **The synthesis is asked for, not spent automatically.** The artifact's version is written by a
 * "neural agent" and appears the moment the page opens. Weathra's is a real language-model call
 * against the real agent, which costs a model call and an allowance — so it is a control a person
 * presses, and the report is complete and readable without ever pressing it. Everything above it is
 * retrieved or deterministically computed.
 *
 * **What the artifact draws and Weathra does not have:** an agent version string, an evidence-node
 * count, a PDF export, a confidence percentage attached to the narrative, a decadal stability
 * index, a model-alignment score, and named third-party feeds with millisecond latencies. No
 * version is printed, nothing is counted, no export is offered, and every confidence shown is the
 * forecast's own banded statement with its basis. Recorded in `docs/design/screens.md` §5.
 */

import { PlaceChooser } from "@/components/locations/place-chooser";
import Link from "next/link";
import { useState, type ReactNode } from "react";

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
  DeviationChart,
  ForecastTimelineChart,
  hourLabelOf,
  type DeviationPoint,
  type TimelinePoint,
} from "./charts";
import {
  HistoricalContext,
  HorizonConfidence,
  ObservedNow,
  OutlookStrip,
  ReportHero,
  SourceFooter,
  StatisticTiles,
  WhatMoved,
  outlookDaysFrom,
  type SourceRow,
} from "./sections";
import styles from "./report.module.css";

/** One panel of the report. The badge names the class of everything inside it. */
function Panel({
  title,
  id,
  dataClass,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly id: string;
  readonly dataClass: "observed" | "forecast" | "historical" | "analytics" | "interpretation";
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
        badge={<DataClassBadge dataClass={dataClass} />}
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

/** Every provider the six reads reported, once each, with what it supplied. */
function sourcesFrom({
  current,
  forecast,
  analysis,
  baseline,
}: {
  readonly current: CurrentResponse | null;
  readonly forecast: ForecastResponse | null;
  readonly analysis: AnalysisResponse | null;
  readonly baseline: Baseline | null;
}): SourceRow[] {
  const rows: SourceRow[] = [];
  const add = (
    name: string | null | undefined,
    detail: string,
    dataClass: SourceRow["dataClass"],
  ) => {
    if (!name) return;
    if (rows.some((row) => row.name === name && row.dataClass === dataClass)) return;
    rows.push({ name, detail, dataClass });
  };

  if (current) {
    add(
      current.attribution?.provider,
      `Observed ${formatInstant(current.attribution?.retrieved_at) ?? "at an unreported time"}`,
      "observed",
    );
  }
  if (forecast) {
    add(
      forecast.attribution?.provider,
      `Forecast retrieved ${formatInstant(forecast.attribution?.retrieved_at) ?? "at an unreported time"}`,
      "forecast",
    );
  }
  if (baseline) add(baseline.provider, baseline.labelling, "historical");
  if (analysis) add(analysis.provider, "Computed by Weathra from the retrieved series", "analytics");

  return rows;
}

function ReportFor({ location }: { readonly location: Location }): ReactNode {
  const place = { latitude: location.latitude, longitude: location.longitude };

  const current = useApiQuery<CurrentResponse>({
    key: ["weather", "current", place.latitude, place.longitude],
    request: (client) => client.current(place),
  });
  const forecast = useApiQuery<ForecastResponse>({
    key: ["weather", "forecast", place.latitude, place.longitude, 7],
    request: (client) => client.forecast({ ...place, days: 7 }),
  });
  const changes = useApiQuery<WhatChanged>({
    key: ["weather", "changes", place.latitude, place.longitude, 7],
    request: (client) => client.changes({ ...place, days: 7 }),
  });
  const analysis = useApiQuery<AnalysisResponse>({
    key: ["weather", "analysis", place.latitude, place.longitude, 7],
    request: (client) => client.analysis({ ...place, days: 7 }),
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
   * compute it answers with a failure this screen omits the tile for; it is never approximated
   * here from the baseline mean and a current reading, which would be this screen inventing a
   * statistic and attributing it to the analytics engine.
   */
  const comparison = useApiQuery<BaselineComparison>({
    key: ["weather", "baseline-comparison", place.latitude, place.longitude, window?.start, window?.end],
    request: (client) =>
      client.baselineComparison({
        ...place,
        start: window!.start,
        end: window!.end,
        measure: "temperature_mean",
      }),
    enabled: window !== null,
  });

  const [asked, setAsked] = useState(false);
  const synthesis = useApiMutation<void, AskResponse>({
    run: (client) =>
      client.ask({
        question: `Summarise the weather outlook for ${friendlyName(location)} over the next week, using the retrieved figures only.`,
      }),
  });

  if (forecast.state.kind === "loading" || current.state.kind === "loading") {
    return <LoadingState label={`Building the report for ${friendlyName(location)}`} lines={6} />;
  }
  if (forecast.state.kind === "error") {
    return <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />;
  }

  const forecastData = forecast.state.kind === "ready" ? forecast.state.data : null;
  const currentData = current.state.kind === "ready" ? current.state.data : null;
  const analysisData = analysis.state.kind === "ready" ? analysis.state.data : null;
  const baselineData = baseline.state.kind === "ready" ? baseline.state.data : null;
  const comparisonData = comparison.state.kind === "ready" ? comparison.state.data : null;

  const nearest = forecastData?.uncertainty?.horizon?.[0] ?? null;
  const timeline = timelineFrom(forecastData);
  const missingHours = timeline.filter((point) => point.temperature === null).length;
  const plottable = timeline.some((point) => point.temperature !== null);
  const days = outlookDaysFrom(forecastData);
  const deviations = deviationsFrom(analysisData);
  const anomalies = analysisData?.anomalies ?? null;
  const baselineMean =
    typeof baselineData?.mean?.value === "number" ? baselineData.mean.value : null;

  const temperatureUnit =
    forecastData?.hourly?.units?.temperature ?? currentData?.units?.temperature ?? null;
  const precipitationUnit = forecastData?.hourly?.units?.precipitation ?? null;
  const dailyUnit =
    forecastData?.daily?.units?.temperature_max ?? forecastData?.daily?.units?.temperature ?? null;
  const dailyPrecipitationUnit =
    forecastData?.daily?.units?.precipitation_sum ??
    forecastData?.daily?.units?.precipitation_probability_max ??
    null;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.headerBadges}>
            <DataClassBadge dataClass="analytics" />
            <span className={styles.headerPeriod}>
              {forecastData?.horizon_days ?? 7} days · {location.timezone}
            </span>
          </div>
          <h1 className={styles.title}>Weather Intelligence Report</h1>
          <p className={styles.lede}>
            {friendlyName(location)} — read across current conditions, the forecast window, what has
            moved, the computed statistics and the archive record.
          </p>
        </div>
        <div className={styles.headerMeta}>
          {nearest ? (
            <Badge tone={nearest.confidence === "high" ? "ok" : "warning"}>
              {nearest.confidence} confidence at {nearest.hours_ahead} h
            </Badge>
          ) : null}
          {forecastData?.attribution?.retrieved_at ? (
            <span className={styles.headerStamp}>
              Retrieved {formatInstant(forecastData.attribution.retrieved_at)}
            </span>
          ) : null}
        </div>
      </header>

      {/* Lead band: the place and its computed reading, with everything observed beside it. */}
      <div className={styles.lead}>
        <ReportHero
          location={location}
          current={currentData}
          summary={analysisData?.summary ?? null}
          comparison={comparisonData}
          trend={analysisData?.trend ?? null}
          forecast={forecastData}
        />

        {currentData ? (
          <Panel id="report-now" title="Conditions now" dataClass="observed">
            <ObservedNow current={currentData} />
          </Panel>
        ) : null}
      </div>

      {/* The outlook, and what has moved under it. */}
      <div className={styles.band}>
        <Panel
          id="report-outlook"
          title="The outlook"
          dataClass="forecast"
          subtitle={
            forecastData?.attribution?.provider
              ? `From ${forecastData.attribution.provider}.`
              : undefined
          }
        >
          {days.length > 0 ? (
            <OutlookStrip
              days={days}
              unit={dailyUnit}
              precipitationUnit={dailyPrecipitationUnit}
            />
          ) : (
            <p className={styles.quiet}>This provider reported no daily outlook for this window.</p>
          )}
        </Panel>

        <Panel id="report-moved" title="What changed" dataClass="forecast">
          {changes.state.kind === "ready" ? (
            <WhatMoved changes={changes.state.data} />
          ) : (
            <p className={styles.quiet}>No earlier forecast is on record to compare against.</p>
          )}
        </Panel>
      </div>

      {/* The plotted window against the record — the artifact's central chart. */}
      <div className={styles.band}>
        <Panel
          id="report-window"
          title="The window, against the record"
          dataClass="forecast"
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
        </Panel>

        <Panel
          id="report-history"
          title="Against the record"
          dataClass="historical"
          subtitle={baselineData ? undefined : "No baseline is available for this window yet."}
        >
          {baselineData ? (
            <HistoricalContext baseline={baselineData} comparison={comparisonData} />
          ) : (
            <p className={styles.quiet}>
              The archive returned no baseline for this calendar window, so nothing is placed
              against it.
            </p>
          )}
        </Panel>
      </div>

      {/* What Weathra computed, and how far into the horizon it is willing to be confident. */}
      <div className={styles.band}>
        <Panel
          id="report-computed"
          title="Computed for this window"
          dataClass="analytics"
          /*
            Not the summary. The hero already carries `AnalysisResponse.summary` as the window's
            computed reading, and repeating it here put the same sentence on the screen twice —
            the prose redundancy this pass exists to remove. The provider is the fact this panel
            adds.
          */
          subtitle={
            analysisData?.provider ? `Computed by Weathra from ${analysisData.provider}.` : undefined
          }
        >
          {analysisData ? (
            <>
              <StatisticTiles results={analysisData.findings ?? []} />

              {deviations.length > 0 || !anomalies ? null : (
                <p className={styles.quiet}>
                  {anomalies.note ?? `No entry stood out from this window by ${anomalies.method}.`}
                </p>
              )}
            </>
          ) : (
            <p className={styles.quiet}>Nothing was computed for this window.</p>
          )}
        </Panel>

        <Panel
          id="report-confidence"
          title="Confidence by horizon"
          dataClass="forecast"
          subtitle="Banded by distance into the horizon, with the basis the provider stated."
        >
          {forecastData ? (
            <HorizonConfidence forecast={forecastData} />
          ) : (
            <p className={styles.quiet}>This forecast stated no uncertainty.</p>
          )}
        </Panel>
      </div>

      {/*
        The deviation plot, on its own row.
        *
        It sat under the statistics tiles, which made the analytics panel about twice the height of
        the confidence panel beside it and left a card-width void at the foot of that row — the
        thin-data defect this pass exists to remove, reintroduced by a chart rather than by thin
        data. On its own band it is also closer to the artifact, whose anomaly figure is a panel of
        its own rather than a footnote to the statistics.
      */}
      {deviations.length > 0 && anomalies ? (
        <Panel
          id="report-deviation"
          title="Entries that stood out"
          dataClass="analytics"
          subtitle={`Flagged by ${anomalies.method}, against the window's own median.`}
        >
          <DeviationChart
            points={deviations}
            threshold={anomalies.threshold}
            unit={anomalies.unit || null}
            title="Entries that stood out"
            method={anomalies.method}
          />
        </Panel>
      ) : null}

      {/* The model's reading, and everything the report was read from. */}
      <div className={styles.band}>
        <Panel
          id="report-synthesis"
          title="Weathra's reading"
          dataClass="interpretation"
          subtitle="Written by a language model about the figures above. It produces no measurement."
        >
          {synthesis.state.kind === "saved" ? (
            <>
              <p className={styles.synthesis}>{synthesis.state.data.answer.answer_prose}</p>
              {synthesis.state.data.answer.llm_model ? (
                <p className={styles.quiet}>
                  {synthesis.state.data.answer.llm_provider} ·{" "}
                  {synthesis.state.data.answer.llm_model}
                </p>
              ) : null}
              {synthesis.state.data.evidence_id ? (
                <Link
                  className={styles.evidence}
                  href={`/evidence/${synthesis.state.data.evidence_id}`}
                >
                  See how this answer was produced
                </Link>
              ) : null}
            </>
          ) : synthesis.state.kind === "error" ? (
            <ErrorState failure={synthesis.state.failure} title="That reading was not produced" />
          ) : (
            <>
              <p className={styles.quiet}>
                The report above is complete without this. Ask Weathra to read it and it will
                summarise the figures, citing what it used.
              </p>
              <Button
                variant="primary"
                busy={synthesis.busy}
                onClick={() => {
                  setAsked(true);
                  synthesis.submit();
                }}
              >
                {asked && synthesis.busy ? "Reading…" : "Ask Weathra to read this"}
              </Button>
            </>
          )}
        </Panel>

        <Panel
          id="report-sources"
          title="What this was read from"
          dataClass="observed"
          subtitle="Every surface behind the figures above."
        >
          <SourceFooter
            rows={sourcesFrom({
              current: currentData,
              forecast: forecastData,
              analysis: analysisData,
              baseline: baselineData,
            })}
          />
        </Panel>
      </div>
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

  return (
    <>
      {/*
        The screen's own place control. With no default this used to be an empty state and a link
        to Settings, which made the feature reachable only by configuring a preference somewhere
        else first — see `PlaceChooser` for why that is not a substitute for a product.
      */}
      <PlaceChooser
        summary="Report on another place"
        label="Report on a place"
        description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
        current={location}
        usingDefault={chosen === null}
        hasDefault={saved !== null}
        onChoose={setChosen}
      />

      {location === null ? (
        <EmptyState title="Name a place to report on">
          The report covers your default location. Name one above, or set a default in{" "}
          <Link href="/settings">Settings</Link>.
        </EmptyState>
      ) : (
        <ReportFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
        />
      )}
    </>
  );
}
