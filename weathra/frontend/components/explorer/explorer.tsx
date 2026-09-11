"use client";

/**
 * Forecast Explorer — the forecast at the resolution the provider actually reports it.
 *
 * Built against `docs/design/screens/11-forecast-explorer.png`: the horizon control, the metric
 * row, the wide temporal chart, the intelligence column beside it, the high-resolution matrix
 * beneath. Every figure comes from `/weather/current`, `/weather/forecast` and `/weather/analysis`
 * — the same three endpoints the Dashboard reads, so the two screens cannot disagree.
 *
 * **What the artifact draws and Weathra does not have.** Its source line reads `ECMWF-HRES-09`; ours
 * is whichever provider answered, and today that is Open-Meteo. Its right-hand column is a "neural
 * agent v4.8" writing anomalies, under confidence scores labelled vector alignment and grounding
 * precision, above a model-reliability card citing "ECMWF Core v4.2 · 92.4% historical accuracy",
 * over a footer reporting 124 sensor nodes, AES-256-GCM and a compliance lock. None of that exists.
 * Weathra reads one provider, runs no model of its own, operates no sensors, and scores nobody's
 * reliability.
 *
 * So the column is filled with what Weathra *does* know, which occupies the same slot honestly: the
 * deterministic findings `/weather/analysis` computed over this window, and the confidence the
 * forecast itself carries — which the backend states as a band per horizon distance, with its basis,
 * rather than as a percentage nobody can source.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import { RecordedAgainstBaselineChart } from "@/components/historical/charts";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyChart,
  EmptyState,
  ErrorState,
  LoadingState,
  LocationImage,
  ScrollRegion,
  Select,
} from "@/components/ui";
import type {
  AnalysisResponse,
  CurrentResponse,
  ForecastResponse,
  Location,
  PreferenceView,
} from "@/lib/api/schema";
import {
  briefingLocationFrom,
  formatReading,
  measureLabel,
  readingFor,
  readingsFrom,
} from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { hasValues, missingCount, pointsFrom } from "@/lib/historical/analysis";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./explorer.module.css";

/** The horizons the artifact offers, in the days the forecast endpoint takes. */
const HORIZONS = [
  { value: "1", label: "24 hours" },
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
] as const;

/** The metric row, in the artifact's order. Each is shown only where the provider reported it. */
const METRICS: readonly { key: string; dataClass: "observed" | "forecast" }[] = [
  { key: "temperature", dataClass: "observed" },
  { key: "apparent_temperature", dataClass: "observed" },
  { key: "precipitation", dataClass: "observed" },
  { key: "relative_humidity", dataClass: "observed" },
  { key: "wind_speed", dataClass: "observed" },
  { key: "pressure", dataClass: "observed" },
  { key: "uv_index", dataClass: "observed" },
];

function MetricRow({ current }: { readonly current: CurrentResponse }): ReactNode {
  const shown = METRICS.map((metric) => ({
    ...metric,
    reading: readingFor(metric.key, current.values, current.units),
  })).filter((metric) => metric.reading !== null);

  // Anything the provider reported that the row above does not already name, so the composition
  // never hides a reading.
  const named = new Set(METRICS.map((metric) => metric.key));
  const extras = readingsFrom(current.values, current.units).filter(
    (reading) => !named.has(reading.key),
  );

  if (shown.length === 0 && extras.length === 0) {
    return <p className={styles.quiet}>This provider reported no current measurements here.</p>;
  }

  return (
    <div className={styles.metrics}>
      {shown.map((metric) => (
        <div className={styles.metric} key={metric.key}>
          <DataClassBadge dataClass={metric.dataClass} />
          <p className={styles.metricLabel}>{measureLabel(metric.key)}</p>
          <p className={styles.metricValue}>{formatReading(metric.reading!)}</p>
        </div>
      ))}
      {extras.map((reading) => (
        <div className={styles.metric} key={reading.key}>
          <DataClassBadge dataClass="observed" />
          <p className={styles.metricLabel}>{measureLabel(reading.key)}</p>
          <p className={styles.metricValue}>{formatReading(reading)}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The matrix: every hourly entry the provider returned, as a table.
 *
 * The artifact calls it high-resolution and shows four-hourly rows. The resolution here is whatever
 * the provider reported — nothing is interpolated to fill a grid, and nothing is dropped to fit one.
 */
function ForecastMatrix({ forecast }: { readonly forecast: ForecastResponse }): ReactNode {
  const entries = forecast.hourly?.entries ?? [];
  const units = forecast.hourly?.units ?? {};

  if (entries.length === 0) {
    return (
      <p className={styles.quiet}>
        This provider reported no hourly series for this window, so there is no matrix to show. The
        daily outlook above is what it did report.
      </p>
    );
  }

  // The columns the provider actually filled, so a column of dashes never appears.
  const columns = Object.keys(units).filter((key) =>
    entries.some((entry) => entry.values?.[key] !== null && entry.values?.[key] !== undefined),
  );

  return (
    <ScrollRegion label="Hourly forecast matrix">
      <table className={styles.matrix}>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {columns.map((key) => (
              <th scope="col" key={key}>
                {measureLabel(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.time_utc}>
              <th scope="row">{entry.time_local}</th>
              {columns.map((key) => {
                const reading = readingFor(key, entry.values ?? {}, units);
                return <td key={key}>{reading ? formatReading(reading) : "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/**
 * The column beside the chart: what Weathra computed, and how confident the forecast is.
 *
 * This is the artifact's "Intelligence Layer" slot, filled with the two things that are real. No
 * language model is called — an explorer that spent a model call on every horizon change would be
 * an expensive way to restate figures already on screen.
 */
function FindingsColumn({
  analysis,
  forecast,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly forecast: ForecastResponse;
}): ReactNode {
  const horizon = forecast.uncertainty?.horizon ?? [];
  const nearest = horizon[0] ?? null;

  return (
    <div className={styles.findings}>
      <Card aria-labelledby="explorer-confidence">
        <CardHeader
          title="Confidence"
          titleId="explorer-confidence"
          badge={<DataClassBadge dataClass="forecast" />}
        />
        <CardBody>
          {nearest ? (
            <>
              <p className={styles.confidenceBand}>
                <Badge
                  tone={
                    nearest.confidence === "high"
                      ? "ok"
                      : nearest.confidence === "moderate"
                        ? "warning"
                        : "error"
                  }
                >
                  {nearest.confidence}
                </Badge>
                <span>{nearest.hours_ahead} h into the horizon</span>
              </p>
              <p className={styles.quiet}>{forecast.uncertainty?.basis}</p>
            </>
          ) : (
            <p className={styles.quiet}>This forecast carries no confidence statement.</p>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="explorer-findings">
        <CardHeader
          title="Computed findings"
          titleId="explorer-findings"
          badge={<DataClassBadge dataClass="analytics" />}
        />
        <CardBody>
          {analysis === null ? (
            <p className={styles.quiet}>No analysis was computed for this window.</p>
          ) : analysis.findings.length === 0 ? (
            <p className={styles.quiet}>
              Nothing in this window met the minimum points Weathra needs to compute a statistic.
            </p>
          ) : (
            <>
              {/* Written by code from the findings only — no model is involved, and the backend
                  says so in the field's own contract. */}
              <p className={styles.summary}>{analysis.summary}</p>
              <ul className={styles.findingList}>
                {analysis.findings.map((finding) => (
                  <li key={`${finding.measure}-${finding.statistic}`}>
                    <span className={styles.findingDay}>
                      {measureLabel(finding.measure)} · {finding.statistic}
                    </span>
                    <span>
                      {finding.value === null || finding.value === undefined
                        ? "Not computable"
                        : formatReading({ value: finding.value, unit: finding.unit ?? null })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

export interface ExplorerForProps {
  readonly location: Location;
}

function ExplorerFor({ location }: ExplorerForProps): ReactNode {
  const [days, setDays] = useState<string>("7");
  const place = { latitude: location.latitude, longitude: location.longitude };
  const horizon = Number(days);

  const current = useApiQuery<CurrentResponse>({
    key: ["weather", "current", place.latitude, place.longitude],
    request: (client) => client.current(place),
  });
  const forecast = useApiQuery<ForecastResponse>({
    key: ["weather", "forecast", place.latitude, place.longitude, horizon],
    request: (client) => client.forecast({ ...place, days: horizon }),
  });
  const analysis = useApiQuery<AnalysisResponse>({
    key: ["weather", "analysis", place.latitude, place.longitude, horizon],
    request: (client) => client.analysis({ ...place, days: horizon }),
  });

  if (forecast.state.kind === "loading") {
    return <LoadingState label={`Reading the forecast for ${friendlyName(location)}`} lines={6} />;
  }
  if (forecast.state.kind === "error") {
    return <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />;
  }
  if (forecast.state.kind !== "ready") return null;

  const data = forecast.state.data;
  const points = pointsFrom(data.hourly);
  const drawable = hasValues(points, "temperature");

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div>
          <h1>Forecast Explorer</h1>
          <p className={styles.lede}>
            {friendlyName(location)} · {data.horizon_days}-day horizon · {location.timezone}
          </p>
        </div>
        <div className={styles.horizon}>
          <Select
            label="Horizon"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            options={HORIZONS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
        </div>
      </header>

      {/*
        The place, photographed. `11-forecast-explorer.png` opens on imagery of the location; the
        frame holds whether a photograph is found or not, so the band never has a hole in it.
      */}
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="banner"
        scrim="strong"
      >
        <span className={styles.heroPlace}>{friendlyName(location)}</span>
      </LocationImage>

      {current.state.kind === "ready" ? <MetricRow current={current.state.data} /> : null}

      <div className={styles.body}>
        <Card aria-labelledby="explorer-chart">
          <CardHeader
            title="Through the forecast window"
            titleId="explorer-chart"
            badge={<DataClassBadge dataClass="forecast" />}
            subtitle={`From ${data.attribution?.provider ?? "the provider"}, in ${location.timezone}.`}
          />
          <CardBody>
            {drawable ? (
              <RecordedAgainstBaselineChart
                points={points}
                measure="temperature"
                unit={data.hourly?.units?.temperature ?? null}
                seriesLabel="Temperature"
                title="Temperature through the forecast window"
                missing={missingCount(points, "temperature")}
                baselineValue={null}
                baselineLabel={null}
              />
            ) : (
              <EmptyChart
                title="Temperature through the forecast window"
                reason="This provider reported no hourly series for this window."
              />
            )}
          </CardBody>
        </Card>

        <FindingsColumn
          analysis={analysis.state.kind === "ready" ? analysis.state.data : null}
          forecast={data}
        />
      </div>

      <Card aria-labelledby="explorer-matrix">
        <CardHeader
          title="Hour by hour"
          titleId="explorer-matrix"
          badge={<DataClassBadge dataClass="forecast" />}
          subtitle="Every entry the provider reported, at the resolution it reported them."
        />
        <CardBody>
          <ForecastMatrix forecast={data} />
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The screen, on the place the person opens Weathra on — or on any place they name.
 *
 * It opens on the same default location the Dashboard uses, read from `/me/preferences`, so the two
 * screens agree. **With no default it is still the explorer**, with its chooser open: this used to
 * be an empty state and a link to Settings, which made the feature reachable only by configuring a
 * preference on a different screen first. A configuration step is not a substitute for a product.
 */
export function ForecastExplorer(): ReactNode {
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
      <PlaceChooser
        summary="Explore another place"
        label="Explore a place"
        description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
        current={location}
        usingDefault={chosen === null}
        hasDefault={saved !== null}
        onChoose={setChosen}
      />

      {location === null ? (
        <EmptyState title="Name a place to explore">
          Forecast Explorer opens on your default location. Name one above, or set a default in{" "}
          <Link href="/settings">Settings</Link>.
        </EmptyState>
      ) : (
        <ExplorerFor key={`${location.latitude},${location.longitude}`} location={location} />
      )}
    </>
  );
}
