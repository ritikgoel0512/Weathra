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

import { useState, type ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import { ScreenPreview } from "@/components/locations/screen-preview";
import { ForecastTrendChart, type TrendPoint } from "./trend-chart";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyChart,
  ErrorState,
  LoadingState,
  Meter,
  ScrollRegion,
  WeatherIcon,
  formatInstant,
} from "@/components/ui";
import type {
  AnalysisResponse,
  CurrentResponse,
  ForecastResponse,
  Location,
  PreferenceView,
  SeriesEntry,
} from "@/lib/api/schema";
import {
  briefingLocationFrom,
  formatReading,
  measureLabel,
  readingFor,
  readingsFrom,
} from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { conditionFor, WEATHER_CODE } from "@/lib/weather/condition";
import { coverageOf, localLabel, matrixRows, trendSignals } from "@/lib/explorer/reading";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./explorer.module.css";

/** The horizons the artifact offers, in the days the forecast endpoint takes. */
const HORIZONS = [
  { value: "1", label: "24H", name: "24 hours" },
  { value: "3", label: "3D", name: "3 days" },
  { value: "7", label: "7D", name: "7 days" },
  { value: "14", label: "14D", name: "14 days" },
] as const;

/**
 * The artifact's control row: the place, the horizon, and what answered.
 *
 * `11-forecast-explorer.png` gives the screen one compact bar — a search field, four horizon
 * buttons, a unit pair, and a line naming the source and when it was read. Production had a display
 * title, a subtitle repeating the place and the timezone, a labelled `Select` in the top corner, a
 * full-width "Explore another place" disclosure, and then a 290-pixel photograph of the city before
 * the first figure. That is five bands and about half the first viewport spent before any weather.
 *
 * Nothing is dropped: the place control is the same `PlaceChooser`, opened from the bar rather than
 * sitting open beneath it, and the horizon is the same four values the forecast endpoint takes —
 * rendered as the segmented control the artifact draws rather than as a dropdown.
 */
function ControlBar({
  location,
  chooser,
  days,
  onDays,
  provider,
  retrievedAt,
}: {
  readonly location: Location;
  readonly chooser: ReactNode;
  readonly days: string;
  readonly onDays: (value: string) => void;
  readonly provider: string | null;
  readonly retrievedAt: string | null;
}): ReactNode {
  return (
    <div className={styles.controlBar}>
      <details className={styles.placeControl}>
        <summary className={styles.placeSummary}>
          <span className={styles.placeName}>{friendlyName(location)}</span>
          <span className={styles.placeHint}>Change place</span>
        </summary>
        {chooser}
      </details>

      {/*
        A radio group rather than four buttons: the four are one choice, and a keyboard reaches the
        group once and then moves inside it with the arrow keys, which is what a segmented control
        is supposed to do.
      */}
      <fieldset className={styles.horizon}>
        <legend className="weathra-visually-hidden">Forecast horizon</legend>
        {HORIZONS.map((entry) => (
          <label className={styles.horizonOption} key={entry.value}>
            <input
              type="radio"
              name="explorer-horizon"
              value={entry.value}
              checked={days === entry.value}
              onChange={() => onDays(entry.value)}
            />
            <span aria-hidden="true">{entry.label}</span>
            <span className="weathra-visually-hidden">{entry.name}</span>
          </label>
        ))}
      </fieldset>

      <p className={styles.sourceLine}>
        {provider ? <span className={styles.sourceProvider}>{provider}</span> : null}
        {retrievedAt ? <span>{formatInstant(retrievedAt)}</span> : null}
      </p>
    </div>
  );
}

/**
 * The seven cards the artifact's strip carries, in its order, with the substitutions Weathra's
 * data actually supports.
 *
 * `11-forecast-explorer.png` ends on UV INDEX. Open-Meteo's current block does not carry one, and
 * a seventh card reading "not reported" in the strip's most prominent position would be the
 * artifact's composition with a hole where its last figure is. So the seventh slot takes the
 * strongest reading the provider *does* send, in preference order, and is labelled for whichever
 * one it got. Everything the provider reported and this strip does not name is one press away
 * under *More current conditions* — nothing is hidden, and the strip stays seven.
 */
const PRIMARY_METRICS: readonly string[] = [
  "temperature",
  "apparent_temperature",
  "precipitation",
  "relative_humidity",
  "wind_speed",
  "surface_pressure",
];

/**
 * Tried in order for the seventh card. The first the provider reported is the one shown.
 *
 * The sky state leads it. `11-forecast-explorer.png` ends on UV INDEX; Open-Meteo's current block
 * carries no UV, and the condition code it does carry is the reading a person looks for first —
 * translated through the product's one condition vocabulary, never shown as the raw code.
 */
const SEVENTH_METRIC: readonly string[] = ["uv_index", "wind_gust", "dew_point", "cloud_cover"];

function MetricRow({
  current,
  forecast,
}: {
  readonly current: CurrentResponse;
  readonly forecast: ForecastResponse | null;
}): ReactNode {
  const reading = (key: string) => readingFor(key, current.values, current.units);

  const condition = conditionFor(
    typeof current.values?.[WEATHER_CODE] === "number"
      ? (current.values[WEATHER_CODE] as number)
      : null,
  );
  const seventh = condition === null
    ? (SEVENTH_METRIC.find((key) => reading(key) !== null) ?? null)
    : null;
  const keys = [...PRIMARY_METRICS, ...(seventh === null ? [] : [seventh])];
  const shown = keys
    .map((key) => ({ key, reading: reading(key) }))
    .filter((metric) => metric.reading !== null);

  // Everything the provider reported that the strip does not name. Never dropped — see above.
  // The condition code counts as named wherever the seventh card is showing it.
  const named = new Set([...keys, ...(condition === null ? [] : [WEATHER_CODE])]);
  const extras = readingsFrom(current.values, current.units).filter(
    (entry) => !named.has(entry.key),
  );

  if (shown.length === 0 && extras.length === 0) {
    return <p className={styles.quiet}>This provider reported no current measurements here.</p>;
  }

  return (
    <>
      <div className={styles.metrics}>
        {condition === null ? null : (
          /*
            The artifact's seventh card is UV INDEX, which this provider does not report. The sky
            state is what it does report and what a person looks for first, so it takes the slot —
            translated by `lib/weather/condition`, which is the one place in the product that turns
            a published code into words, and never rendered as the code itself.
          */
          <div className={styles.metric} key="conditions">
            <div className={styles.metricHead}>
              <DataClassBadge dataClass="observed" />
            </div>
            <p className={styles.metricLabel}>Conditions</p>
            <p className={styles.metricValue}>
              <span className={styles.condition}>
                <WeatherIcon condition={condition} size={22} />
                {condition.label}
              </span>
            </p>
          </div>
        )}
        {shown.map((metric) => (
          <div className={styles.metric} key={metric.key}>
            <div className={styles.metricHead}>
              <DataClassBadge dataClass="observed" />
            </div>
            <p className={styles.metricLabel}>{measureLabel(metric.key)}</p>
            <p className={styles.metricValue}>{formatReading(metric.reading!)}</p>
            {/*
              One supporting fact, and only where the forecast genuinely carries one for this
              measure: what the days ahead do with it. The artifact captions every card; a caption
              invented to fill the slot would be the thing this screen refuses.
            */}
            {supportingFact(metric.key, forecast) ? (
              <p className={styles.metricFact}>{supportingFact(metric.key, forecast)}</p>
            ) : null}
          </div>
        ))}
      </div>

      {extras.length === 0 ? null : (
        <details className={styles.moreConditions}>
          <summary className={styles.moreSummary}>
            More current conditions ({extras.length})
          </summary>
          <dl className={styles.extras}>
            {extras.map((entry) => (
              <div className={styles.extra} key={entry.key}>
                <dt>{measureLabel(entry.key)}</dt>
                <dd>{formatReading(entry)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}

/**
 * The one line under a metric card: what the forecast window does with that measure.
 *
 * Read off the forecast's own daily series rather than computed here — the range is the first and
 * last of what the provider sent for the window, which is a fact about the response. Null wherever
 * the provider sent nothing, because a card with no second fact is better than a made-up one.
 */
function supportingFact(key: string, forecast: ForecastResponse | null): string | null {
  const entries = forecast?.daily?.entries ?? [];
  if (entries.length === 0) return null;

  const values = (measure: string): number[] =>
    entries
      .map((entry) => entry.values?.[measure])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const round = (value: number) => Math.round(value * 10) / 10;
  const unit = (measure: string) => forecast?.daily?.units?.[measure] ?? "";

  if (key === "temperature" || key === "apparent_temperature") {
    const highs = values("temperature_max");
    const lows = values("temperature_min");
    if (highs.length === 0 || lows.length === 0) return null;
    return `${round(Math.min(...lows))} to ${round(Math.max(...highs))} ${unit("temperature_max")} ahead`;
  }
  if (key === "precipitation") {
    const totals = values("precipitation_sum");
    if (totals.length === 0) return null;
    const sum = round(totals.reduce((carry, value) => carry + value, 0));
    return `${sum} ${unit("precipitation_sum")} over ${totals.length} days`;
  }
  if (key === "wind_speed" || key === "wind_gust") {
    const peaks = values("wind_gust_max");
    if (peaks.length === 0) return null;
    return `Peak gust ${round(Math.max(...peaks))} ${unit("wind_gust_max")}`;
  }
  return null;
}

/**
 * The high-resolution matrix: representative rows on the page, every entry one press in.
 *
 * `11-forecast-explorer.png` shows five rows and calls the table high-resolution, which is the
 * right instinct — a forecast matrix is something a person scans, and production rendered the whole
 * hourly dataset instead: 28 rows at three days and well past a hundred at fourteen, with ISO
 * instants down the first column and a horizontal scrollbar under it. The data has not gone
 * anywhere; `matrixRows` picks the entries nearest the day's readable hours by a rule stated in its
 * own file, and *View all hourly data* renders the rest.
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

  const rows = matrixRows(entries);

  return (
    <>
      <MatrixTable entries={rows} units={units} label="Forecast matrix" />

      <details className={styles.allHours}>
        <summary className={styles.moreSummary}>
          View all hourly data ({entries.length} {entries.length === 1 ? "entry" : "entries"})
        </summary>
        {/*
          The full dataset, with the scroll container it genuinely needs: every column the provider
          filled, which is wider than a page at some horizons. That container belongs here rather
          than under the matrix above, which is sized to fit.
        */}
        <ScrollRegion label="All hourly forecast entries" className={styles.tableScroll}>
          <MatrixTable entries={entries} units={units} label="All hourly entries" every />
        </ScrollRegion>
      </details>
    </>
  );
}

/** The columns the matrix leads with, in the artifact's order. */
const MATRIX_COLUMNS: readonly string[] = [
  "temperature",
  "precipitation",
  "relative_humidity",
  "wind_speed",
];

function MatrixTable({
  entries,
  units,
  label,
  every = false,
}: {
  readonly entries: readonly SeriesEntry[];
  readonly units: Readonly<Record<string, string>>;
  readonly label: string;
  /** True for the full dataset, which shows every column the provider filled. */
  readonly every?: boolean;
}): ReactNode {
  const filled = (key: string) =>
    entries.some((entry) => {
      const value = entry.values?.[key];
      return value !== null && value !== undefined;
    });

  const columns = every
    ? Object.keys(units).filter(filled)
    : MATRIX_COLUMNS.filter((key) => Object.keys(units).includes(key) && filled(key));

  // The provider's condition code, translated by the product's one condition vocabulary. The raw
  // code is never a column: "0 WMO code" is a true cell nobody can read.
  const conditions = !every && filled(WEATHER_CODE);

  return (
    <table className={styles.matrix} aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Time</th>
          {conditions ? <th scope="col">Conditions</th> : null}
          {columns.map((key) => (
            <th scope="col" key={key}>
              {measureLabel(key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const condition = conditionFor(
            typeof entry.values?.[WEATHER_CODE] === "number"
              ? (entry.values[WEATHER_CODE] as number)
              : null,
          );
          return (
            <tr key={entry.time_utc}>
              {/* The instant the provider stated, as a person reads it — never the ISO string. */}
              <th scope="row">{localLabel(entry.time_local) ?? entry.time_local}</th>
              {conditions ? (
                <td>
                  {condition ? (
                    <span className={styles.condition}>
                      <WeatherIcon condition={condition} size={18} />
                      {condition.label}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              ) : null}
              {columns.map((key) => {
                const reading = readingFor(key, entry.values ?? {}, units);
                return <td key={key}>{reading ? formatReading(reading) : "—"}</td>;
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The column beside the chart — the artifact's Intelligence Layer, filled with what is real.
 *
 * Its own version is a "neural agent v4.8" writing three anomalies, two of which are causal claims
 * about an atmosphere Weathra does not model and one of which names a station it does not read,
 * over confidence scores labelled vector alignment and grounding precision. None of that exists.
 *
 * What occupies the slot instead is the same shape from `/weather/analysis` and the forecast's own
 * uncertainty statement: three signals, each one computed statistic phrased; the provider's own
 * sentence about why a horizon's confidence falls; a band and a coverage ratio; and the way to the
 * whole record. The heading keeps the artifact's name because the slot is the same slot — what
 * changes is that everything in it can be checked.
 */
function IntelligenceLayer({
  analysis,
  forecast,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly forecast: ForecastResponse;
}): ReactNode {
  const horizon = forecast.uncertainty?.horizon ?? [];
  const nearest = horizon[0] ?? null;
  const signals = trendSignals(analysis);
  const coverage = coverageOf(forecast.hourly?.entries ?? [], "temperature");

  return (
    <div className={styles.findings}>
      <Card aria-labelledby="explorer-intelligence">
        <CardHeader
          title="Intelligence layer"
          titleId="explorer-intelligence"
          badge={<DataClassBadge dataClass="analytics" />}
        />
        <CardBody>
          <h3 className={styles.railHeading}>Key trend signals</h3>
          {signals.length === 0 ? (
            <p className={styles.quiet}>
              Nothing in this window met the minimum points Weathra needs to compute a statistic.
            </p>
          ) : (
            <ul className={styles.signals}>
              {signals.map((signal) => (
                <li className={styles.signal} key={signal.key}>
                  <span className={styles.signalMark} aria-hidden="true" />
                  <span>
                    {signal.text}
                    {signal.when ? <span className={styles.signalWhen}> · {signal.when}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            "Why it matters", in the provider's own words rather than in a sentence written here.
            The artifact's is a paragraph about convective cells; this is the statement the backend
            attaches to every forecast about what its confidence rests on.
          */}
          {forecast.uncertainty?.basis ? (
            <>
              <h3 className={styles.railHeading}>Why it matters</h3>
              <p className={styles.railNote}>{forecast.uncertainty.basis}</p>
            </>
          ) : null}

          <h3 className={styles.railHeading}>Confidence and grounding</h3>
          {nearest ? (
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
          ) : (
            <p className={styles.quiet}>This forecast carries no confidence statement.</p>
          )}

          {/*
            The one meter on this screen, over the one proportion that is a ratio of things the
            provider returned. Never a confidence band turned into a percentage.
          */}
          {coverage.total > 0 ? (
            <Meter
              label="Data coverage"
              value={coverage.reported / coverage.total}
              note={
                <span className={styles.quiet}>
                  {coverage.reported} of {coverage.total} returned entries carry a temperature
                </span>
              }
            />
          ) : null}

          <details className={styles.allFindings}>
            <summary className={styles.moreSummary}>All computed findings</summary>
            {analysis === null ? (
              <p className={styles.quiet}>No analysis was computed for this window.</p>
            ) : (
              <>
                {/* Written by code from the findings only — no model is involved. */}
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
          </details>
        </CardBody>
      </Card>

      {/*
        **Forecast source, not model reliability.** The artifact's card cites "ECMWF Core v4.2" with
        "92.4% historical accuracy". Weathra scores nobody's reliability and runs no model of its
        own; what it can say is which provider answered, over what horizon, and when.
      */}
      <Card aria-labelledby="explorer-source">
        <CardHeader
          title="Forecast source"
          titleId="explorer-source"
          badge={<DataClassBadge dataClass="forecast" />}
        />
        <CardBody>
          <dl className={styles.sourceFacts}>
            <div className={styles.sourceFact}>
              <dt>Provider</dt>
              <dd>{forecast.attribution?.provider ?? "Not reported"}</dd>
            </div>
            <div className={styles.sourceFact}>
              <dt>Horizon</dt>
              <dd>
                {forecast.horizon_days} {forecast.horizon_days === 1 ? "day" : "days"}
              </dd>
            </div>
            <div className={styles.sourceFact}>
              <dt>Retrieved</dt>
              <dd>{formatInstant(forecast.attribution?.retrieved_at) ?? "Not reported"}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

export interface ExplorerForProps {
  readonly location: Location;
  /** The screen's place control, rendered under its own heading. */
  readonly chooser: ReactNode;
}

function ExplorerFor({ location, chooser }: ExplorerForProps): ReactNode {
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

  /*
   * The shell outlives the forecast.
   *
   * This used to early-return a bare `LoadingState` or `ErrorState` in place of the whole screen,
   * so a provider hiccup replaced the heading, the horizon control and the place chooser with one
   * sentence — and the one control that would let a person try somewhere else was the first thing
   * to disappear. `specs/web-ui` wants a degraded panel, not a degraded screen, and this is the
   * shape every other screen here already had.
   *
   * The horizon is stated from the control rather than from the response, because the control is
   * what the person set and it is true before anything answers.
   */
  const shell = (body: ReactNode): ReactNode => (
    <div className={styles.screen}>
      <h1 className="weathra-visually-hidden">Forecast Explorer</h1>
      <ControlBar
        location={location}
        chooser={chooser}
        days={days}
        onDays={setDays}
        provider={null}
        retrievedAt={null}
      />
      {body}
    </div>
  );

  if (forecast.state.kind === "loading") {
    return shell(
      <LoadingState
        label={`Reading the forecast for ${friendlyName(location)}`}
        lines={6}
      />,
    );
  }
  if (forecast.state.kind === "error") {
    return shell(
      <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />,
    );
  }
  if (forecast.state.kind !== "ready") return shell(null);

  const data = forecast.state.data;
  const hourly = data.hourly?.entries ?? [];
  /*
   * The chart's own points, labelled the way a person reads a clock. `pointsFrom` exists for the
   * historical charts and keys on the ISO instant, which is what put `2026-09-04T00:00:00+02:00`
   * across the axis; this reads the same entries and carries a label beside each.
   */
  const trend: TrendPoint[] = hourly.map((entry) => ({
    at: entry.time_local,
    label: localLabel(entry.time_local) ?? entry.time_local,
    temperature:
      typeof entry.values?.temperature === "number" ? entry.values.temperature : null,
    precipitation:
      typeof entry.values?.precipitation === "number" ? entry.values.precipitation : null,
  }));
  const drawable = trend.some((point) => point.temperature !== null);
  const wet = trend.some((point) => point.precipitation !== null);
  const missing = trend.filter((point) => point.temperature === null).length;

  return (
    <div className={styles.screen}>
      <h1 className="weathra-visually-hidden">Forecast Explorer</h1>

      <ControlBar
        location={location}
        chooser={chooser}
        days={days}
        onDays={setDays}
        provider={data.attribution?.provider ?? null}
        retrievedAt={data.attribution?.retrieved_at ?? null}
      />

      {/*
        **No photograph here.** `11-forecast-explorer.png` opens on the control bar and the metric
        strip; production put a 290-pixel city banner between them, which is most of a first
        viewport spent on a picture on a screen whose subject is a forecast. The imagery resolver is
        untouched and the Dashboard still opens on it — this screen's hierarchy is the artifact's.
      */}
      {current.state.kind === "ready" ? (
        <MetricRow current={current.state.data} forecast={data} />
      ) : null}

      <div className={styles.body}>
        <Card aria-labelledby="explorer-chart">
          <CardHeader
            title="Temporal forecast trend analysis"
            titleId="explorer-chart"
            badge={<DataClassBadge dataClass="forecast" />}
            subtitle={`Temperature${wet ? " and precipitation" : ""} across the ${data.horizon_days}-day horizon, in ${location.timezone}.`}
          />
          <CardBody>
            {drawable ? (
              <ForecastTrendChart
                points={trend}
                temperatureUnit={data.hourly?.units?.temperature ?? null}
                precipitationUnit={data.hourly?.units?.precipitation ?? null}
                hasPrecipitation={wet}
                missing={missing}
              />
            ) : (
              <EmptyChart
                title="Temporal forecast trend analysis"
                reason="This provider reported no hourly series for this window."
              />
            )}
          </CardBody>
        </Card>

        <IntelligenceLayer
          analysis={analysis.state.kind === "ready" ? analysis.state.data : null}
          forecast={data}
        />
      </div>

      <Card aria-labelledby="explorer-matrix">
        <CardHeader
          title="High-resolution forecast matrix"
          titleId="explorer-matrix"
          badge={<DataClassBadge dataClass="forecast" />}
          subtitle="Representative periods across the horizon. Every entry the provider reported is one press away."
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
    return (
      <ErrorState
        failure={preferences.state.failure}
        onRetry={preferences.retry}
      />
    );
  }
  if (preferences.state.kind !== "ready") return null;

  const saved = briefingLocationFrom(preferences.state.data);
  const location = chosen ?? saved;

  /*
   * Declared once and used in both branches. The empty branch needs it most: its own text
   * says "name one above", and an empty state saying that with nothing above it is the
   * dead end this control exists to remove.
   */
  const chooser = (
    <PlaceChooser
      summary="Explore another place"
      label="Explore a place"
      description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
      current={location}
      usingDefault={chosen === null}
      hasDefault={saved !== null}
      onChoose={setChosen}
    />
  );

  return (
    <>
      {location === null ? (
        <>
          {chooser}
          <ScreenPreview
            title="Forecast Explorer opens on one place"
            lead="Name a place above, or set a default in Settings and every screen opens on it. Nothing below is filled in yet because no place has been chosen."
            regions={[
              {
                title: "Day by day",
                blurb:
                  "Each day ahead with its range and its expected conditions, as the provider reported them.",
                chart: 150,
              },
              {
                title: "Hour by hour",
                blurb:
                  "The intra-day movement behind each day, so a mild average with a cold morning in it is visible as one.",
                chart: 150,
              },
              {
                title: "Spread and confidence",
                blurb:
                  "How far the models disagree about each day, and how that disagreement narrows as the day approaches.",
              },
              {
                title: "Provenance",
                blurb:
                  "Which provider supplied the figures, when they were retrieved, and what Weathra computed from them rather than received.",
              },
            ]}
          />
        </>
      ) : (
        <ExplorerFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
          chooser={chooser}
        />
      )}
    </>
  );
}
