"use client";

/**
 * Travel Intelligence — is this a good weather window for this trip?
 *
 * Built against `docs/design/screens/15-travel-intelligence.png`: a trip header, a weather-window
 * hero beside a viability index, an analytical metric row, the destination's daily outlook, the
 * packing strategy, a temporal comparison, the synthesis, the evidence, and the historical band.
 *
 * **It asks once.** This screen used to be a criterion select, a rolling-window select, two place
 * forms, and four separate API calls stitched together in the browser — each resolving the same
 * place, each reaching for the same week of weather. That is what a provider sees as four requests
 * for one question, and it is what produced "the weather provider limited this request" on a screen
 * whose data was already in hand. `POST /travel/intelligence` answers the whole thing from one
 * forecast retrieval, and every region below reads that one response.
 *
 * **A trip is where from, where to, and when.** Not "what you want from the weather over the next
 * N days" — that is Forecast Explorer's question, and it is still Forecast Explorer's to ask. The
 * criterion and horizon selects are gone, and so is the second hidden location form.
 *
 * **Nothing here is invented.** The viability index is the composite score Weathra already computes,
 * with its weights disclosed; every metric names the method behind it; packing is deterministic
 * rules over the trip's own figures, each recommendation naming the figure that raised it; and a
 * section the backend could not produce says so rather than being filled in.
 */

import { useMemo, useState, type ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import { ScreenPreview } from "@/components/locations/screen-preview";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  ErrorState,
  Input,
  LoadingState,
  LocationImage,
  Meter,
  NOT_REPORTED,
  Skeleton,
  WeatherIcon,
  formatInstant,
} from "@/components/ui";
import type {
  ComparedWindow,
  DailyOutlookEntry,
  Location,
  PackingItem,
  PreferenceView,
  TravelIntelligence as TravelIntelligenceResult,
  TravelMetric,
} from "@/lib/api/schema";
import { briefingLocationFrom } from "@/lib/dashboard/briefing";
import { baselineYearsStatement, formatSigned } from "@/lib/historical/analysis";
import { friendlyName } from "@/lib/locations/place";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import type { ViewFailure } from "@/lib/query/state";
import { ForecastTrendChart, type TrendPoint } from "@/components/explorer/trend-chart";
import { conditionFor } from "@/lib/weather/condition";

import styles from "./travel.module.css";

/* ============================================================ the trip itself */

/** A trip as this screen holds it: two places and two dates, all four required to analyse. */
interface Trip {
  readonly origin: Location | null;
  readonly destination: Location | null;
  readonly start: string;
  readonly end: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date written the way a person says it: `14 Sep`. */
function spokenDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

function spokenRange(start: string, end: string): string {
  if (!start || !end) return "Not set";
  return start === end ? spokenDate(start) : `${spokenDate(start)} – ${spokenDate(end)}`;
}

/** Today, and a default trip a few days out, in the browser's own calendar. */
function isoOffsetFromToday(days: number): string {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return day.toISOString().slice(0, 10);
}

function nightsBetween(start: string, end: string): number | null {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/* ============================================================ the trip header */

/**
 * The artifact's trip strip: origin, destination, dates, and the two actions.
 *
 * One row, and one place to change any of it. What production carried instead was a destination
 * label, a criterion select, a window select, an "Adjust trip" disclosure holding a place form,
 * and a second place form below that — five controls for a question with three parts, two of them
 * asking something a traveller did not come here to answer.
 */
function TripHeader({
  trip,
  editing,
  onEdit,
  onExport,
  exportable,
}: {
  readonly trip: Trip;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onExport: () => void;
  readonly exportable: boolean;
}): ReactNode {
  const nights = nightsBetween(trip.start, trip.end);

  return (
    <div className={styles.tripStrip}>
      <div className={styles.tripField}>
        <span className={styles.tripLabel}>Origin</span>
        <span className={styles.tripValue}>
          {trip.origin ? friendlyName(trip.origin) : "Not set"}
        </span>
      </div>

      <span className={styles.tripArrow} aria-hidden="true">
        →
      </span>

      <div className={styles.tripField}>
        <span className={styles.tripLabel}>Destination</span>
        <span className={styles.tripValue}>
          {trip.destination ? friendlyName(trip.destination) : "Not set"}
        </span>
      </div>

      <div className={styles.tripField}>
        <span className={styles.tripLabel}>Dates</span>
        <span className={styles.tripValue}>
          {spokenRange(trip.start, trip.end)}
          {nights !== null && nights > 0 ? (
            <span className={styles.tripNights}> · {nights} nights</span>
          ) : null}
        </span>
      </div>

      <div className={styles.tripActions}>
        <Button variant="secondary" size="sm" onClick={onEdit} aria-expanded={editing}>
          Adjust trip
        </Button>
        <Button variant="primary" size="sm" onClick={onExport} disabled={!exportable}>
          Export itinerary
        </Button>
      </div>
    </div>
  );
}

/**
 * Where a trip is set or changed — the *only* place, which is the point.
 *
 * Both places go through `PlaceChooser`, so origin and destination resolve the same way every other
 * Weathra screen resolves a place: any city in the world by name, never a fixed list, and never a
 * coordinate pair as the label a person reads.
 */
function TripEditor({
  trip,
  onChange,
  onDone,
}: {
  readonly trip: Trip;
  readonly onChange: (next: Trip) => void;
  readonly onDone: () => void;
}): ReactNode {
  const nights = nightsBetween(trip.start, trip.end);
  const invalid = nights !== null && nights < 0;

  return (
    <Card aria-labelledby="travel-editor">
      <CardHeader title="Adjust trip" titleId="travel-editor" />
      <CardBody>
        <div className={styles.editor}>
          <div className={styles.editorPlace}>
            <PlaceChooser
              summary="Change origin"
              label="Travelling from"
              description="Where the trip sets out from. Carried as context — Weathra holds no transport data, so this does not change the destination's weather."
              current={trip.origin}
              usingDefault={false}
              hasDefault={false}
              onChoose={(place) => onChange({ ...trip, origin: place })}
            />
          </div>

          <div className={styles.editorPlace}>
            <PlaceChooser
              summary="Change destination"
              label="Travelling to"
              description="The place whose weather this screen analyses. Weathra resolves the name before it retrieves anything."
              current={trip.destination}
              usingDefault={false}
              hasDefault={false}
              onChoose={(place) => onChange({ ...trip, destination: place })}
            />
          </div>

          <div className={styles.editorDates}>
            <Input
              label="Departure"
              type="date"
              value={trip.start}
              onChange={(event) => {
                const start = event.target.value;
                // A departure moved past the return takes the return with it, rather than leaving
                // a trip that ends before it begins for the backend to refuse.
                onChange({ ...trip, start, end: trip.end < start ? start : trip.end });
              }}
            />
            <Input
              label="Return"
              type="date"
              min={trip.start}
              value={trip.end}
              onChange={(event) => onChange({ ...trip, end: event.target.value })}
              error={invalid ? "A trip ends on or after the day it begins." : undefined}
            />
          </div>
        </div>

        <Button variant="primary" size="sm" onClick={onDone} disabled={invalid}>
          Analyse this trip
        </Button>
      </CardBody>
    </Card>
  );
}

/* ============================================================ the dashboard */

/** A measure key as a person reads it: `temperature_mean` becomes `Temperature mean`. */
function measureName(measure: string): string {
  const spaced = measure.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function metricReading(metric: TravelMetric): string {
  if (metric.value === null || metric.value === undefined) return NOT_REPORTED;
  const unit = metric.unit ?? "";
  return unit === "%" ? `${metric.value}%` : `${metric.value} ${unit}`.trim();
}

/** The hero: the destination, the window, and what the window is. */
function WeatherWindowHero({
  result,
}: {
  readonly result: TravelIntelligenceResult;
}): ReactNode {
  const destination = result.trip.destination;
  // The figures under the lede describe the *best-ranked* day, which is not necessarily the
  // warmest one — so they are labelled for the day they belong to rather than for a superlative.
  const strongest = (result.daily_outlook ?? []).find((day) => day.rank === 1);
  const condition = conditionFor(strongest?.condition_code);

  return (
    <LocationImage
      displayName={friendlyName(destination)}
      latitude={destination.latitude}
      longitude={destination.longitude}
      variant="hero"
      scrim="strong"
    >
      <Badge tone="accent">Weather window identified</Badge>
      <span className={styles.heroPlace}>{friendlyName(destination)}</span>
      <span className={styles.heroZone}>
        {spokenRange(result.trip.start, result.trip.end)} · {result.hero_state}
      </span>
      <p className={styles.heroLede}>{result.hero_summary}</p>

      <span className={styles.heroFigures}>
        {strongest?.temperature_max !== null && strongest?.temperature_max !== undefined ? (
          <span className={styles.heroFigure}>
            <span className={styles.heroFigureLabel}>Best day high</span>
            <span className={styles.heroFigureValue}>
              {strongest.temperature_max} {strongest.units?.temperature_max ?? "°C"}
            </span>
          </span>
        ) : null}
        {condition ? (
          <span className={styles.heroFigure}>
            <span className={styles.heroFigureLabel}>Conditions</span>
            <span className={styles.heroFigureValue}>{condition.label}</span>
          </span>
        ) : null}
      </span>
    </LocationImage>
  );
}

/** The viability index — Weathra's own score, with the components that produced it. */
function ViabilityCard({ result }: { readonly result: TravelIntelligenceResult }): ReactNode {
  const viability = result.viability ?? null;

  return (
    <Card aria-labelledby="travel-viability">
      <CardHeader
        title="Travel viability index"
        titleId="travel-viability"
        badge={<DataClassBadge dataClass="analytics" />}
      />
      <CardBody>
        {viability === null ? (
          <p className={styles.quiet}>
            The provider did not report enough for these days to score the window. The figures it
            did report are on the cards below.
          </p>
        ) : (
          <>
            <div className={styles.ring} role="img" aria-label={`${viability.score} out of 100`}>
              <span className={styles.ringScore}>{viability.score}</span>
              <span className={styles.ringState}>{viability.state}</span>
            </div>

            {/*
              One row per weighted component, as the artifact draws them: the measure, its bar, and
              the figure behind it. The bar carries its own label, so naming the measure beside it
              printed everything twice and pushed each row onto three lines.
            */}
            <ul className={styles.components}>
              {viability.contributions.map((part) => (
                <li className={styles.component} key={part.measure}>
                  <Meter
                    label={measureName(part.measure)}
                    value={part.weight === 0 ? null : part.contribution / part.weight}
                    valueLabel={`${part.value} ${part.unit ?? ""}`.trim()}
                  />
                </li>
              ))}
            </ul>

            <details className={styles.why}>
              <summary>How this is scored</summary>
              <p className={styles.quiet}>{viability.basis}</p>
              <p className={styles.quiet}>{viability.disclosure}</p>
            </details>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** The analytical row. A metric with no figure states why, rather than showing a zero. */
function MetricRow({ metrics }: { readonly metrics: readonly TravelMetric[] }): ReactNode {
  if (metrics.length === 0) return null;

  return (
    <section className={styles.metrics} aria-label="Trip weather metrics">
      {metrics.map((metric) => (
        <div className={styles.metric} key={metric.key}>
          <DataClassBadge dataClass={metric.data_class === "forecast" ? "forecast" : "analytics"} />
          <p className={styles.metricLabel}>{metric.label}</p>
          <p className={styles.metricValue}>
            {metric.unavailable_reason ? NOT_REPORTED : metricReading(metric)}
          </p>
          <p className={styles.metricNote}>
            {metric.unavailable_reason ?? metric.detail ?? metric.method}
          </p>
        </div>
      ))}
    </section>
  );
}

/** One day of the trip, as the provider reported it. */
function OutlookCard({ day }: { readonly day: DailyOutlookEntry }): ReactNode {
  const condition = conditionFor(day.condition_code);
  const unit = day.units?.temperature_max ?? "°C";

  return (
    <li className={styles.day} data-best={day.rank === 1 ? "true" : undefined}>
      <p className={styles.dayWeekday}>{day.weekday}</p>
      <p className={styles.dayDate}>{spokenDate(day.local_date)}</p>

      {condition ? (
        <p className={styles.dayCondition}>
          <WeatherIcon condition={condition} size={26} />
          <span>{condition.label}</span>
        </p>
      ) : null}

      <p className={styles.dayFigure}>
        {day.temperature_max === null || day.temperature_max === undefined
          ? NOT_REPORTED
          : `${day.temperature_max} ${unit}`}
      </p>
      {day.temperature_min !== null && day.temperature_min !== undefined ? (
        <p className={styles.dayRange}>Low {day.temperature_min} {unit}</p>
      ) : null}

      <p className={styles.dayRain}>
        {day.precipitation_sum === null || day.precipitation_sum === undefined
          ? "No rain reported"
          : `${day.precipitation_sum} ${day.units?.precipitation_sum ?? "mm"}`}
        {day.precipitation_probability_max === null ||
        day.precipitation_probability_max === undefined
          ? ""
          : ` · ${Math.round(day.precipitation_probability_max)}% chance`}
      </p>

      {day.rank === 1 ? <Badge tone="ok">Best day</Badge> : null}

      {day.viability !== null && day.viability !== undefined ? (
        <Meter label="Viability" value={day.viability / 100} />
      ) : null}
    </li>
  );
}

/**
 * The trip's shape over its days — the artifact's trend band, from the outlook already on screen.
 *
 * No new request and no new component: the points are the same `daily_outlook` entries the cards
 * above draw, and the chart is Forecast Explorer's, imported unmodified. It reads the day's high
 * against its rain, which is what a traveller comparing days is actually looking at.
 */
function TripTrend({
  days,
}: {
  readonly days: readonly DailyOutlookEntry[];
}): ReactNode {
  const points: TrendPoint[] = days.map((day) => ({
    at: day.local_date,
    label: `${day.weekday} ${spokenDate(day.local_date)}`,
    temperature:
      typeof day.temperature_max === "number" ? day.temperature_max : null,
    precipitation:
      typeof day.precipitation_sum === "number" ? day.precipitation_sum : null,
  }));

  const drawable = points.some((point) => point.temperature !== null);
  if (!drawable) return null;

  const units = days[0]?.units ?? {};
  return (
    <div className={styles.trend}>
      <ForecastTrendChart
        points={points}
        temperatureUnit={units.temperature_max ?? null}
        precipitationUnit={units.precipitation_sum ?? null}
        hasPrecipitation={points.some((point) => point.precipitation !== null)}
        missing={points.filter((point) => point.temperature === null).length}
      />
    </div>
  );
}

/** Packing, from the trip's own figures — each recommendation naming the one that raised it. */
function PackingStrategy({
  items,
  insight,
}: {
  readonly items: readonly PackingItem[];
  readonly insight: string | null | undefined;
}): ReactNode {
  return (
    <Card aria-labelledby="travel-packing">
      <CardHeader
        title="Packing strategy"
        titleId="travel-packing"
        badge={<DataClassBadge dataClass="analytics" />}
        subtitle="Derived from this trip's forecast figures."
      />
      <CardBody>
        {items.length === 0 ? (
          <p className={styles.quiet}>
            Nothing in this trip&rsquo;s figures raises a specific packing consideration.
          </p>
        ) : (
          <ul className={styles.packing}>
            {items.map((item) => (
              <li className={styles.packItem} key={item.item}>
                <span className={styles.packText}>
                  <span className={styles.packName}>{item.item}</span>
                  <span className={styles.packBecause}>{item.because}</span>
                </span>
                <Badge tone={item.tier === "Essential" ? "accent" : "neutral"}>{item.tier}</Badge>
              </li>
            ))}
          </ul>
        )}

        {insight ? (
          <div className={styles.insight}>
            <span className={styles.insightLabel}>Planning insight</span>
            <p className={styles.insightText}>{insight}</p>
          </div>
        ) : null}

        <p className={styles.disclaimer}>
          Rules over the figures on this screen. Weathra runs no packing model, recommends no
          products, and no language model wrote this.
        </p>
      </CardBody>
    </Card>
  );
}

/** The trip window against the other windows the forecast horizon actually covers. */
function TemporalComparison({
  windows,
}: {
  readonly windows: readonly ComparedWindow[];
}): ReactNode {
  return (
    <Card aria-labelledby="travel-windows">
      <CardHeader
        title="Temporal comparison"
        titleId="travel-windows"
        badge={<DataClassBadge dataClass="analytics" />}
        subtitle="Your dates against the other windows of the same length within the forecast horizon."
      />
      <CardBody>
        {windows.length <= 1 ? (
          <p className={styles.quiet}>
            The forecast horizon does not reach far enough past these dates to compare another
            window of the same length. Weathra compares only windows the provider actually sent.
          </p>
        ) : (
          <table className={styles.windows}>
            <thead>
              <tr>
                <th scope="col">Travel window</th>
                <th scope="col">Viability</th>
                <th scope="col">Temperature</th>
                <th scope="col">Rain</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => (
                <tr
                  key={`${window.start}-${window.end}`}
                  data-best={window.selected ? "true" : undefined}
                >
                  <th scope="row">
                    {window.label}
                    {window.selected ? <Badge tone="accent">Your trip</Badge> : null}
                  </th>
                  <td className={styles.windowMeter}>
                    {window.viability === null || window.viability === undefined ? (
                      <span className={styles.quiet}>{window.unavailable_reason ?? NOT_REPORTED}</span>
                    ) : (
                      <Meter
                        label={window.state ?? "Viability"}
                        value={window.viability / 100}
                        valueLabel={String(window.viability)}
                      />
                    )}
                  </td>
                  <td>
                    {window.temperature_mean === null || window.temperature_mean === undefined
                      ? NOT_REPORTED
                      : `${window.temperature_mean} °C`}
                  </td>
                  <td>
                    {window.precipitation_sum === null || window.precipitation_sum === undefined
                      ? NOT_REPORTED
                      : `${window.precipitation_sum} mm`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

/** What moved since the last snapshot — and, with no snapshot, plainly that. */
function WhatChangedCard({
  result,
}: {
  readonly result: TravelIntelligenceResult;
}): ReactNode {
  const changed = result.forecast_changes ?? null;
  const unavailable = (result.partial_failures ?? []).find(
    (failure) => failure.section === "forecast_changes",
  );
  const material = (changed?.changes ?? []).filter((change) => change.material);

  return (
    <Card aria-labelledby="travel-changed">
      <CardHeader
        title="What changed?"
        titleId="travel-changed"
        badge={<DataClassBadge dataClass="forecast" />}
      />
      <CardBody>
        {changed === null ? (
          <p className={styles.quiet}>
            {unavailable?.reason ??
              "Forecast change analysis becomes available once Weathra has recorded another forecast snapshot for this trip."}
          </p>
        ) : !changed.comparison_available ? (
          <p className={styles.quiet}>
            No earlier forecast snapshot exists for this trip yet. Weathra can compare how the
            outlook moved once another forecast has been recorded.
          </p>
        ) : (
          <>
            <p className={styles.railNote}>{changed.statement}</p>
            {material.length === 0 ? (
              <p className={styles.quiet}>
                Nothing moved beyond the margin Weathra treats as material for these measures.
              </p>
            ) : (
              <ul className={styles.changes}>
                {material.slice(0, 3).map((change) => (
                  <li className={styles.change} key={`${change.local_date}-${change.measure}`}>
                    <span className={styles.changeMark} aria-hidden="true" />
                    <span>{change.statement}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** The closing read, and what a reader would need to check it. */
function SynthesisBand({ result }: { readonly result: TravelIntelligenceResult }): ReactNode {
  const evidence = result.evidence;

  return (
    <div className={styles.synthesis}>
      <Card aria-labelledby="travel-synthesis">
        <CardHeader
          title="Travel intelligence synthesis"
          titleId="travel-synthesis"
          badge={<DataClassBadge dataClass="analytics" />}
        />
        <CardBody>
          <p className={styles.synthesisProse}>{result.synthesis}</p>
          <p className={styles.disclaimer}>
            Written by code from the figures in this response. No language model was called, and
            nothing here is inferred beyond them.
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="travel-evidence">
        <CardHeader title="Grounding evidence" titleId="travel-evidence" />
        <CardBody>
          <dl className={styles.sourceFacts}>
            <div className={styles.sourceFact}>
              <dt>Forecast provider</dt>
              <dd>{evidence.forecast_provider}</dd>
            </div>
            <div className={styles.sourceFact}>
              <dt>Destination resolved as</dt>
              <dd>{evidence.destination_resolved_as}</dd>
            </div>
            {evidence.origin_resolved_as ? (
              <div className={styles.sourceFact}>
                <dt>Origin resolved as</dt>
                <dd>{evidence.origin_resolved_as}</dd>
              </div>
            ) : null}
            <div className={styles.sourceFact}>
              <dt>Forecast horizon</dt>
              <dd>{evidence.horizon_days} days</dd>
            </div>
            <div className={styles.sourceFact}>
              <dt>Retrieved</dt>
              <dd>
                {formatInstant(evidence.forecast_retrieved_at)}
                {evidence.forecast_from_cache ? " · from cache" : ""}
              </dd>
            </div>
            {evidence.archive_provider ? (
              <div className={styles.sourceFact}>
                <dt>Archive provider</dt>
                <dd>
                  {evidence.archive_provider} ({(evidence.archive_years_used ?? []).length} years)
                </dd>
              </div>
            ) : null}
            <div className={styles.sourceFact}>
              <dt>Analysed</dt>
              <dd>{formatInstant(result.generated_at)}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

/** The trip window against the archive — present in every state, truthful in each. */
function HistoricalBaseline({
  result,
}: {
  readonly result: TravelIntelligenceResult;
}): ReactNode {
  const baseline = result.historical_baseline ?? null;
  const unavailable = (result.partial_failures ?? []).find(
    (failure) => failure.section === "historical_baseline",
  );
  const destination = result.trip.destination;

  return (
    <div className={styles.historical}>
      <Card aria-labelledby="travel-historical">
        <CardHeader
          title="Historical baseline"
          titleId="travel-historical"
          badge={<DataClassBadge dataClass="analytics" />}
          subtitle={
            baseline
              ? `Against Weathra's available ${baseline.baseline.years_used.length}-year archive baseline for this calendar period.`
              : "Against the archive years Weathra can retrieve for this calendar period."
          }
        />
        <CardBody>
          {baseline === null ? (
            <p className={styles.quiet}>
              {unavailable?.reason ??
                `Weathra could not retrieve archive observations for this calendar period at ${friendlyName(destination)}.`}{" "}
              The forecast figures above are unaffected.
            </p>
          ) : (
            <>
              <p className={styles.railNote}>{baseline.characterization}</p>

              <div className={styles.historicalFigures}>
                <div className={styles.historicalFigure}>
                  <span className={styles.historicalLabel}>Difference from baseline</span>
                  <span className={styles.historicalValue}>
                    {formatSigned(baseline.difference) === null
                      ? NOT_REPORTED
                      : `${formatSigned(baseline.difference)} ${baseline.difference.unit ?? ""}`.trim()}
                  </span>
                </div>
                <div className={styles.historicalFigure}>
                  <span className={styles.historicalLabel}>Baseline mean</span>
                  <span className={styles.historicalValue}>
                    {typeof baseline.baseline.mean.value === "number"
                      ? `${Math.round(baseline.baseline.mean.value * 10) / 10} ${baseline.baseline.mean.unit ?? ""}`.trim()
                      : NOT_REPORTED}
                  </span>
                </div>
                <div className={styles.historicalFigure}>
                  <span className={styles.historicalLabel}>Percentile</span>
                  <span className={styles.historicalValue}>
                    {typeof baseline.percentile_rank?.value === "number"
                      ? `${Math.round(baseline.percentile_rank.value)}th`
                      : NOT_REPORTED}
                  </span>
                </div>
              </div>

              <details className={styles.why}>
                <summary>View historical details</summary>
                <p className={styles.quiet}>
                  Baseline years: {baselineYearsStatement(baseline.baseline)}
                </p>
                <p className={styles.quiet}>{baseline.baseline.labelling}</p>
                {baseline.forecast_side_caveat ? (
                  <p className={styles.quiet}>{baseline.forecast_side_caveat}</p>
                ) : null}
              </details>
            </>
          )}
        </CardBody>
      </Card>

      <LocationImage
        displayName={friendlyName(destination)}
        latitude={destination.latitude}
        longitude={destination.longitude}
        variant="banner"
        scrim="strong"
      >
        <span className={styles.heroZone}>{friendlyName(destination)}</span>
      </LocationImage>
    </div>
  );
}

/** The compact surface a failed core retrieval gets — and nothing else. */
function TripUnavailable({
  failure,
  onRetry,
}: {
  readonly failure: ViewFailure;
  readonly onRetry: () => void;
}): ReactNode {
  const limited = failure.code === "provider_rate_limited";

  return (
    <Card aria-labelledby="travel-unavailable">
      <CardHeader
        title={
          limited ? "Travel weather data is temporarily unavailable" : "This trip was not analysed"
        }
        titleId="travel-unavailable"
      />
      <CardBody>
        <p className={styles.railNote} role="alert">
          {limited
            ? "The weather provider limited this request. Your trip is unchanged above — try again shortly."
            : failure.message}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        {limited || failure.requestId ? (
          <details className={styles.why}>
            <summary>Technical detail</summary>
            {limited ? <p className={styles.quiet}>{failure.message}</p> : null}
            {failure.requestId ? <p className={styles.quiet}>Request {failure.requestId}</p> : null}
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The dashboard skeleton, shaped like what replaces it, so nothing jumps when it does. */
function DashboardSkeleton(): ReactNode {
  return (
    <div className={styles.loading} aria-hidden="true">
      <div className={styles.lead}>
        <Skeleton height="var(--space-13)" />
        <Skeleton height="var(--space-13)" />
      </div>
      <div className={styles.metrics}>
        {[0, 1, 2, 3].map((slot) => (
          <Skeleton key={slot} height="var(--space-11)" />
        ))}
      </div>
      <Skeleton height="var(--space-13)" />
    </div>
  );
}

/* ============================================================ the screen */

function TripWorkspace({ initial }: { readonly initial: Location | null }): ReactNode {
  const [trip, setTrip] = useState<Trip>({
    origin: null,
    destination: initial,
    start: isoOffsetFromToday(2),
    end: isoOffsetFromToday(6),
  });
  const [editing, setEditing] = useState(initial === null);

  const ready =
    trip.destination !== null && trip.start !== "" && trip.end !== "" && trip.end >= trip.start;

  const analysis = useApiQuery<TravelIntelligenceResult>({
    key: [
      "travel",
      "intelligence",
      trip.destination ? friendlyName(trip.destination) : "",
      trip.origin ? friendlyName(trip.origin) : "",
      trip.start,
      trip.end,
    ],
    enabled: ready,
    request: (client) =>
      client.travelIntelligence({
        destination: friendlyName(trip.destination as Location),
        origin: trip.origin ? friendlyName(trip.origin) : null,
        start: trip.start,
        end: trip.end,
      }),
  });

  const result = analysis.state.kind === "ready" ? analysis.state.data : null;

  /** A printable itinerary, from the response already on screen. No new request, no new endpoint. */
  const exportItinerary = useMemo(
    () => () => {
      if (typeof window !== "undefined") window.print();
    },
    [],
  );

  return (
    <div className={styles.screen}>
      <h1 className="weathra-visually-hidden">Travel Intelligence</h1>

      <TripHeader
        trip={trip}
        editing={editing}
        onEdit={() => setEditing((open) => !open)}
        onExport={exportItinerary}
        exportable={result !== null}
      />

      {editing ? (
        <TripEditor trip={trip} onChange={setTrip} onDone={() => setEditing(false)} />
      ) : null}

      {!ready ? (
        <ScreenPreview
          title="Travel Intelligence analyses one trip's weather"
          lead="Set a destination and your dates above. Nothing below is filled in yet because no trip has been set."
          regions={[
            {
              title: "The weather window",
              blurb:
                "Whether your dates are a good weather window at the destination, scored and explained from the forecast.",
            },
            {
              title: "The days you are there",
              blurb:
                "Each day of the trip with its condition, its range and its own suitability score.",
              chart: 150,
            },
            {
              title: "What to pack, and why",
              blurb:
                "Considerations the weather itself raises, each naming the figure behind it.",
            },
          ]}
        />
      ) : analysis.state.kind === "error" ? (
        <TripUnavailable failure={analysis.state.failure} onRetry={analysis.retry} />
      ) : result === null ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className={styles.lead}>
            <div className={styles.leadHero}>
              <WeatherWindowHero result={result} />
            </div>
            <ViabilityCard result={result} />
          </div>

          <MetricRow metrics={result.metrics ?? []} />

          <div className={styles.outlook}>
            <Card aria-labelledby="travel-outlook">
              <CardHeader
                title="Destination daily outlook"
                titleId="travel-outlook"
                badge={<DataClassBadge dataClass="forecast" />}
                subtitle={`Each day at ${friendlyName(result.trip.destination)}, from ${result.evidence.forecast_provider}.`}
              />
              <CardBody>
                <ul className={styles.days}>
                  {(result.daily_outlook ?? []).map((day) => (
                    <OutlookCard key={day.local_date} day={day} />
                  ))}
                </ul>
                <TripTrend days={result.daily_outlook ?? []} />
              </CardBody>
            </Card>

            <PackingStrategy
              items={result.packing_strategy ?? []}
              insight={result.packing_insight}
            />
          </div>

          <div className={styles.comparison}>
            <TemporalComparison windows={result.temporal_comparison ?? []} />
            <WhatChangedCard result={result} />
          </div>

          <SynthesisBand result={result} />

          <HistoricalBaseline result={result} />

          <p className={styles.advisory}>
            Travel Intelligence is weather decision support for a destination. It is not advice
            about flights, airlines, transport or bookings — Weathra holds no information about any
            of them — and a forecast further out is less certain than one nearby.
          </p>
        </>
      )}
    </div>
  );
}

export function TravelIntelligence(): ReactNode {
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

  // The saved default seeds the destination, so the screen opens on a real trip rather than on an
  // empty form. It is a starting point and not a constraint: the header changes all three parts.
  const saved = briefingLocationFrom(preferences.state.data);
  return <TripWorkspace initial={saved} />;
}
