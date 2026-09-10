"use client";

/**
 * Weather Intelligence Report — one place, read across every surface Weathra has.
 *
 * Built against `docs/design/screens/12-weather-intelligence-report.png`: a report header, the
 * current metrics, the outlook, what moved, the historical context, and a synthesis at the end.
 * Composed from `/weather/current`, `/weather/forecast`, `/weather/changes`,
 * `/weather/history/baseline` and `/weather/analysis` — the report is a *reading* of those five,
 * and adds no figure of its own.
 *
 * **The synthesis is asked for, not spent automatically.** The artifact's version is written by a
 * "neural agent" and appears the moment the page opens. Weathra's is a real language-model call
 * against the real agent, which costs a model call and an allowance — so it is a control a person
 * presses, and the report is complete and readable without ever pressing it. Everything above it is
 * retrieved or deterministically computed.
 *
 * **What the artifact draws and Weathra does not have:** an agent version string, an evidence-node
 * count, a PDF export, and a confidence percentage attached to the narrative. No version is
 * printed, nothing is counted, no export is offered, and the confidence shown is the forecast's own
 * banded statement with its basis.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/ui";
import type {
  AnalysisResponse,
  AskResponse,
  Baseline,
  CurrentResponse,
  ForecastResponse,
  Location,
  PreferenceView,
  WhatChanged,
} from "@/lib/api/schema";
import {
  briefingLocationFrom,
  calendarWindowFrom,
  formatReading,
  measureLabel,
  readingsFrom,
} from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./report.module.css";

function Section({
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
      <CardHeader
        title={title}
        titleId={id}
        subtitle={subtitle}
        badge={<DataClassBadge dataClass={dataClass} />}
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
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
  const nearest = forecastData?.uncertainty?.horizon?.[0] ?? null;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div>
          <h1>Weather Intelligence Report</h1>
          <p className={styles.lede}>
            {friendlyName(location)} · {forecastData?.horizon_days ?? 7} days · {location.timezone}
          </p>
        </div>
        {nearest ? (
          <Badge tone={nearest.confidence === "high" ? "ok" : "warning"}>
            {nearest.confidence} confidence at {nearest.hours_ahead} h
          </Badge>
        ) : null}
      </header>

      {current.state.kind === "ready" ? (
        <Section id="report-now" title="Conditions now" dataClass="observed">
          <dl className={styles.metrics}>
            {readingsFrom(current.state.data.values, current.state.data.units).map((reading) => (
              <div className={styles.metric} key={reading.key}>
                <dt>{measureLabel(reading.key)}</dt>
                <dd>{formatReading(reading)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      <Section
        id="report-outlook"
        title="The outlook"
        dataClass="forecast"
        subtitle={
          forecastData
            ? `From ${forecastData.attribution?.provider ?? "the provider"}.`
            : undefined
        }
      >
        {forecastData && (forecastData.daily?.entries?.length ?? 0) > 0 ? (
          <ul className={styles.days}>
            {(forecastData.daily?.entries ?? []).map((entry) => (
              <li className={styles.day} key={entry.time_utc}>
                <span className={styles.dayName}>{entry.time_local.slice(0, 10)}</span>
                {readingsFrom(entry.values ?? {}, forecastData.daily?.units ?? {}).map((reading) => (
                  <span className={styles.dayValue} key={reading.key}>
                    {formatReading(reading)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>This provider reported no daily outlook for this window.</p>
        )}
      </Section>

      <Section id="report-moved" title="What changed" dataClass="forecast">
        {changes.state.kind === "ready" ? (
          <p>{changes.state.data.statement}</p>
        ) : (
          <p className={styles.quiet}>No earlier forecast is on record to compare against.</p>
        )}
      </Section>

      <Section id="report-computed" title="Computed for this window" dataClass="analytics">
        {analysis.state.kind === "ready" ? (
          <>
            <p>{analysis.state.data.summary}</p>
            <dl className={styles.metrics}>
              {analysis.state.data.findings.map((finding) => (
                <div className={styles.metric} key={`${finding.measure}-${finding.statistic}`}>
                  <dt>
                    {measureLabel(finding.measure)} · {finding.statistic}
                  </dt>
                  <dd>
                    {finding.value === null || finding.value === undefined
                      ? "Not computable"
                      : formatReading({ value: finding.value, unit: finding.unit ?? null })}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className={styles.quiet}>Nothing was computed for this window.</p>
        )}
      </Section>

      <Section
        id="report-history"
        title="Against the record"
        dataClass="historical"
        subtitle={baseline.state.kind === "ready" ? baseline.state.data.labelling : undefined}
      >
        {baseline.state.kind === "ready" ? (
          <dl className={styles.metrics}>
            {(["mean", "minimum", "maximum"] as const).map((key) => {
              const statistic = baseline.state.kind === "ready" ? baseline.state.data[key] : null;
              if (!statistic) return null;
              return (
                <div className={styles.metric} key={key}>
                  <dt>{key}</dt>
                  <dd>
                    {statistic.value === null || statistic.value === undefined
                      ? "Not computable"
                      : formatReading({ value: statistic.value, unit: statistic.unit ?? null })}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className={styles.quiet}>No baseline is available for this window yet.</p>
        )}
      </Section>

      <Section
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
                {synthesis.state.data.answer.llm_provider} · {synthesis.state.data.answer.llm_model}
              </p>
            ) : null}
            {synthesis.state.data.evidence_id ? (
              <Link className={styles.evidence} href={`/evidence/${synthesis.state.data.evidence_id}`}>
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
      </Section>
    </div>
  );
}

export function WeatherIntelligenceReport(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }
  if (preferences.state.kind !== "ready") return null;

  const location = briefingLocationFrom(preferences.state.data);
  if (location === null) {
    return (
      <EmptyState title="Choose a place to report on" action={<Link href="/settings">Open Settings</Link>}>
        The report covers your default location. Set one in Settings, or save a place first.
      </EmptyState>
    );
  }

  return <ReportFor location={location} />;
}
