"use client";

/**
 * The Dashboard's surfaces — task 21.1.
 *
 * Each is one region of one data class, rendered through the shared provenance primitives of task
 * 20.15 rather than through anything invented here: `ProvenanceSection` carries the badge and the
 * tier, `AttributionFooter` carries the provider, location, period and retrieval time,
 * `UncertaintyIndicator` carries a forecast's confidence with its basis, `MethodNote` carries what
 * computed a figure, and `InterpretationPanel` carries the model's language behind its boundary
 * sentence.
 *
 * The separation is the point, and it is structural: retrieved provider figures, deterministic
 * analytics and model-written prose are three regions with three tiers, so nothing on this screen
 * can suggest the language model produced a measurement.
 *
 * Every number rendered here arrives from the API. There is no fallback value, no placeholder
 * figure, and no sample datum carried over from the design artifact.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { RecordedAgainstBaselineChart } from "@/components/historical/charts";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyChart,
  LocationImage,
  Meter,
  EmptyState,
  MethodNote,
  ProvenanceSection,
  UncertaintyIndicator,
  type Attribution,
} from "@/components/ui";
import type {
  AnalysisResponse,
  Baseline,
  CurrentResponse,
  ForecastResponse,
  Location,
  SavedLocationsResponse,
  StatisticResult,
} from "@/lib/api/schema";
import { hasValues, missingCount, pointsFrom } from "@/lib/historical/analysis";
import type { ViewState } from "@/lib/query/state";
import { confidenceLevelFor } from "@/lib/design/data-class";
import {
  dayPrecipitationFrom,
  formatReading,
  forecastDaysFrom,
  readingFor,
  readingsFrom,
  type DayPrecipitation,
  type Reading,
  type WhatChangedReport,
} from "@/lib/dashboard/briefing";

import styles from "./dashboard.module.css";

/** A location as the attribution line names it. Never a station, never a coordinate pair alone. */
function placeOf(location: Location | null | undefined): string | null {
  return location?.display_name ?? null;
}

function attributionOf(
  parts: {
    provider?: string | null;
    location?: Location | null;
    retrievedAt?: string | null;
    period?: { start_local: string; end_local: string; timezone?: string | null } | null;
    units?: string | null;
    fromCache?: boolean;
  },
): Attribution {
  return {
    provider: parts.provider ?? null,
    location: placeOf(parts.location),
    retrievedAt: parts.retrievedAt ?? null,
    period: parts.period
      ? {
          start: parts.period.start_local,
          end: parts.period.end_local,
          timezone: parts.period.timezone ?? null,
        }
      : null,
    units: parts.units ?? null,
    fromCache: parts.fromCache,
  };
}

/** A labelled list of reported measures. An unreported measure is not in it. */
function Measures({ readings }: { readonly readings: readonly Reading[] }): ReactNode {
  if (readings.length === 0) return null;
  return (
    <dl className={styles.measures}>
      {readings.map((reading) => (
        <div className={styles.measure} key={reading.key}>
          <dt className={styles.measureTerm}>{reading.label}</dt>
          <dd className={styles.measureValue}>{formatReading(reading)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------- current conditions */

export interface CurrentConditionsProps {
  readonly current: CurrentResponse;
  readonly location: Location;
}

/**
 * The canonical four the Dashboard artifact's hero reads out beside the temperature.
 *
 * The artifact prints HUMIDITY, UV INDEX, WIND and PRESSURE. Weathra's provider reports whichever
 * of them it reports, and the stub reports one. The slots are kept anyway and an absent one says
 * "Not reported" — which is the difference between a composition and a claim. Dropping a slot
 * because a value is missing loses the artifact's hero; inventing the value loses the point of the
 * product. Naming the measure and saying it was not reported does neither, and it is the same
 * sentence the attribution footer already uses for a period nobody supplied.
 *
 * `key` is the provider's own measure name, so a provider that *does* report wind fills the slot
 * with no change here.
 */
const HERO_MEASURES: readonly { key: string; label: string }[] = [
  { key: "relative_humidity", label: "Humidity" },
  { key: "uv_index", label: "UV index" },
  { key: "wind_speed", label: "Wind" },
  { key: "surface_pressure", label: "Pressure" },
];

/**
 * The leading band: what the provider measured, badged OBSERVED.
 *
 * `01-dashboard.png` opens with a wide hero — the place and its status on the left, a dominant
 * temperature on the right, and a row of secondary measures beside it. That geometry is reproduced
 * here. What is *not* reproduced is the artifact's photograph of a city at dusk, its invented
 * station identifier, and its "Agent Ready" telemetry: `docs/design/screens.md` §5 refuses
 * generated decorative imagery set-wide, and the other two are figures no endpoint produces. The
 * band keeps its height and its atmospheric ground through the surface tokens instead, which is the
 * treatment the correction pass agreed for a hero with no approved asset behind it.
 */
export function CurrentConditions({ current, location }: CurrentConditionsProps): ReactNode {
  const temperature = readingFor("temperature", current.values, current.units);
  // Anything the provider reported that the hero's four slots do not already name. The slots are
  // the artifact's composition; this is the guarantee that the composition never hides a reading.
  const named = new Set<string>(["temperature", ...HERO_MEASURES.map((measure) => measure.key)]);
  const extras = readingsFrom(current.values, current.units).filter(
    (reading) => !named.has(reading.key),
  );

  return (
    <ProvenanceSection
      variant="hero"
      dataClass="observed"
      title="Current conditions"
      attribution={attributionOf({
        provider: current.attribution?.provider,
        location: current.attribution?.location ?? location,
        retrievedAt: current.attribution?.retrieved_at,
        units: current.attribution?.units,
        fromCache: current.attribution?.from_cache,
      })}
    >
      {/*
        The artifact's photographic band. `LocationImage` carries the frame whether a photograph is
        present or not, so the readout sits in the same place either way — see
        `public/locations/README.md` for what turns the field into a photograph.
      */}
      <LocationImage
        displayName={location.display_name}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="hero"
      >
        <div className={styles.hero}>
          <div className={styles.heroPlace}>
            <p className={styles.place}>{location.display_name}</p>
            <p className={styles.placeMeta}>
              <span>{location.timezone}</span>
              <span>Observed {current.observed_at_local}</span>
            </p>
          </div>

          <div className={styles.heroReadout}>
            {temperature ? (
              <p className={styles.readout}>{formatReading(temperature)}</p>
            ) : (
              <p className={styles.note}>No temperature reported</p>
            )}
          </div>

          <dl className={styles.heroMeasures}>
            {HERO_MEASURES.map(({ key, label }) => {
              const reading = readingFor(key, current.values, current.units);
              return (
                <div className={styles.heroMeasure} key={key}>
                  <dt className={styles.heroMeasureTerm}>{label}</dt>
                  <dd
                    className={styles.heroMeasureValue}
                    data-reported={reading ? "true" : "false"}
                  >
                    {reading ? formatReading(reading) : "Unavailable"}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </LocationImage>

      {extras.length > 0 ? <Measures readings={extras} /> : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------- forecast strip */

/**
 * The day card's glyph: a drawing of the precipitation figures, with those figures as its caption.
 *
 * Three shapes, one per level `dayPrecipitationFrom` distinguishes, and no fourth for "clear" —
 * there is no clear-sky figure in the response and inventing one is the whole thing this avoids.
 * The `<svg>` is `aria-hidden` and the caption carries the words, so a screen reader is read the
 * figures rather than a shape; `title` gives the same sentence to a pointer.
 */
function DayPrecipitationGlyph({
  outlook,
}: {
  readonly outlook: DayPrecipitation | null;
}): ReactNode {
  if (outlook === null) return null;
  return (
    <p className={styles.stripGlyph} data-level={outlook.level} title={outlook.description}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7.5 16.5a4.5 4.5 0 0 1 .3-9 5.5 5.5 0 0 1 10.3 1.4 3.8 3.8 0 0 1-.6 7.6z" />
        {outlook.level === "wet" ? (
          <path d="M9 19l-1 2.5M13 19l-1 2.5M17 19l-1 2.5" />
        ) : outlook.level === "possible" ? (
          <path d="M12 19l-1 2.5" />
        ) : null}
      </svg>
      <span className={styles.stripGlyphCaption}>{outlook.caption}</span>
      {/* The figures the glyph was drawn from, for a reader that never sees the drawing. */}
      <span className="weathra-visually-hidden">{outlook.description}</span>
    </p>
  );
}

export interface ForecastStripProps {
  readonly forecast: ForecastResponse;
}

/**
 * The day-by-day strip `01-dashboard.png` calls "Forecast Explorer".
 *
 * Three things about it are deliberate.
 *
 * **The name is not the artifact's.** *Forecast Explorer* is a post-MVP screen
 * (`docs/design/roadmap.md`), and `screens.md` §5 records that a Dashboard section may not carry it
 * or the navigation would advertise as built something that is not.
 *
 * **The number of cards is the number of days the backend returned**, not the artifact's seven. The
 * horizon is the person's saved preference and the provider answers with what it has; rendering
 * seven would mean drawing days nobody forecast. Fewer cards in the same card language is the
 * honest form of the same strip.
 *
 * **A precipitation glyph, not a condition glyph.** The artifact labels each day "LIGHT RAIN",
 * "SUNNY", and so on, and this strip carried nothing at all — finding 1.8 of the runtime fidelity
 * audit of 2026-09-08. Weathra's provider reports no condition, so what the card draws is the day's
 * own precipitation: the total, the maximum probability, and a glyph that is a picture of those two
 * figures. See `dayPrecipitationFrom`. A dry day is never drawn as a sunny one.
 */
export function ForecastStrip({ forecast }: ForecastStripProps): ReactNode {
  const days = forecastDaysFrom(forecast.daily);

  /*
   * Seven cards, because `01-dashboard.png` is a seven-card strip and the strip is the composition.
   * The backend answers with the days it has — the horizon is the person's preference and the
   * provider supplies what it supplies — so the cards beyond that carry an unavailable state rather
   * than a guessed forecast. A strip that shrank to two cards read as a different component; a
   * strip that invented five days would be the fabrication this product exists to avoid.
   */
  const slots = Array.from({ length: 7 }, (_, index) => days[index] ?? null);

  return (
    <div className={styles.strip}>
      {slots.map((day, index) => (
        <article
          className={styles.stripDay}
          key={day?.timeLocal ?? `empty-${index}`}
          data-reported={day ? "true" : "false"}
        >
          {day ? (
            <>
              <p className={styles.stripDayName}>{day.date}</p>
              <DayPrecipitationGlyph outlook={dayPrecipitationFrom(day)} />
              <dl className={styles.stripFigures}>
                <div className={styles.stripFigure}>
                  <dt className={styles.stripFigureTerm}>High</dt>
                  <dd className={styles.stripFigureValue}>
                    {day.high ? formatReading(day.high) : "—"}
                  </dd>
                </div>
                <div className={styles.stripFigure}>
                  <dt className={styles.stripFigureTerm}>Low</dt>
                  <dd className={styles.stripFigureValue}>
                    {day.low ? formatReading(day.low) : "—"}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <>
              <p className={styles.stripDayName}>Day {index + 1}</p>
              <p className={styles.stripEmpty}>Not forecast</p>
            </>
          )}
        </article>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- forecast movement */

export interface ForecastMovementProps {
  readonly forecast: ForecastResponse;
  readonly location: Location;
}

/**
 * The days ahead, badged FORECAST, each carrying the window's uncertainty.
 *
 * Deliberately *not* called "Forecast Explorer": `docs/design/screens.md` §5 records that the
 * artifact's label collides with the name of a post-MVP screen, and a Dashboard section carrying it
 * would advertise as built something that is not.
 */
export function ForecastMovement({ forecast, location }: ForecastMovementProps): ReactNode {
  const days = forecastDaysFrom(forecast.daily);
  const confidence = confidenceLevelFor(forecast.uncertainty?.horizon?.[0]?.confidence);

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Forecast movement"
      attribution={attributionOf({
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location ?? location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
    >
      {days.length === 0 ? (
        <EmptyState title="No forecast days returned">
          The provider returned no daily entries for this window.
        </EmptyState>
      ) : (
        <ul className={styles.days}>
          {days.map((day) => (
            <li className={styles.day} key={day.timeLocal}>
              <span className={styles.dayDate}>{day.date}</span>
              <span className={styles.dayRange}>
                {day.high ? (
                  <span>
                    <span className={styles.dayRangeLabel}>High </span>
                    {formatReading(day.high)}
                  </span>
                ) : null}
                {day.low ? (
                  <span>
                    <span className={styles.dayRangeLabel}>Low </span>
                    {formatReading(day.low)}
                  </span>
                ) : null}
              </span>
              {day.other.length > 0 ? (
                <span className={styles.dayOther}>
                  {day.other.map((reading) => (
                    <span key={reading.key}>
                      {reading.label}: {formatReading(reading)}
                    </span>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Required on every forecast: the band, and the basis it rests on. */}
      {confidence && forecast.uncertainty?.basis ? (
        <UncertaintyIndicator
          confidence={confidence}
          basis={forecast.uncertainty.basis}
          hoursAhead={forecast.uncertainty.horizon?.[0]?.hours_ahead ?? null}
          spreadAvailable={forecast.uncertainty.spread_available ?? null}
        />
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------- deterministic analytics */

/** One computed figure with the method that produced it. */
function Finding({ result }: { readonly result: StatisticResult }): ReactNode {
  const value = typeof result.value === "number" ? result.value : null;
  return (
    <li className={styles.finding}>
      <span className={styles.findingLabel}>
        {result.statistic.replace(/_/g, " ")} · {result.measure.replace(/_/g, " ")}
      </span>
      {value === null ? (
        <span className={styles.note}>Not computable.</span>
      ) : (
        <span className={styles.findingValue}>
          {formatReading({ value, unit: result.unit ?? null })}
        </span>
      )}
      <MethodNote
        method={result.method}
        pointsUsed={result.points_used}
        pointsExcluded={result.points_excluded}
        unit={result.unit ?? null}
        reason={result.status === "not_computable" ? (result.reason ?? null) : null}
      />
    </li>
  );
}

export interface DeterministicAnalyticsProps {
  readonly analysis: AnalysisResponse;
  readonly location: Location;
}

/**
 * The figures Weathra computed, badged ANALYTICS — anomalies, trend, and the findings.
 *
 * `analysis.summary` is the backend's own sentence about its own findings, written by code with no
 * model involved, which is why it sits in this region rather than in the interpretation panel.
 */
export function DeterministicAnalytics({
  analysis,
  location,
}: DeterministicAnalyticsProps): ReactNode {
  const anomalies = analysis.anomalies?.anomalies ?? [];
  const trend = analysis.trend;

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Anomalies and computed figures"
      attribution={attributionOf({
        provider: analysis.provider,
        location: analysis.location ?? location,
        period: analysis.period,
        units: analysis.units,
        fromCache: analysis.from_cache,
      })}
    >
      {analysis.summary ? <p className={styles.summary}>{analysis.summary}</p> : null}

      {analysis.anomalies ? (
        <div className={styles.finding}>
          <span className={styles.findingLabel}>
            Anomalies · {analysis.anomalies.measure.replace(/_/g, " ")}
          </span>
          {anomalies.length === 0 ? (
            <span className={styles.statement}>
              {analysis.anomalies.note ?? "No entry stood out from the window by this method."}
            </span>
          ) : (
            <span className={styles.findingValue}>
              {anomalies.length} {anomalies.length === 1 ? "entry" : "entries"} stood out
            </span>
          )}
          <MethodNote
            method={analysis.anomalies.method}
            pointsUsed={analysis.anomalies.points_used}
            pointsExcluded={analysis.anomalies.points_excluded}
          />
        </div>
      ) : null}

      {trend ? (
        <div className={styles.finding}>
          <span className={styles.findingLabel}>Trend · {trend.measure.replace(/_/g, " ")}</span>
          <span className={styles.findingValue}>
            <Badge tone="neutral">{trend.direction}</Badge>{" "}
            {formatReading({ value: trend.magnitude, unit: trend.unit })} across the window
          </span>
          <MethodNote
            method={trend.method}
            pointsUsed={trend.points_used}
            pointsExcluded={trend.points_excluded}
            unit={trend.unit}
          />
        </div>
      ) : null}

      {analysis.findings.length > 0 ? (
        <ul className={styles.findings}>
          {analysis.findings.map((result, index) => (
            <Finding key={`${result.statistic}-${result.measure}-${index}`} result={result} />
          ))}
        </ul>
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------ historical context */

export interface HistoricalContextProps {
  readonly baseline: Baseline;
}

/**
 * The multi-year baseline the current window sits against, badged HISTORICAL.
 *
 * It states the years actually used rather than citing a published climate normal, and says so when
 * fewer were available than were asked for — both are `specs/historical` requirements, and both are
 * the reason no figure here is described as a "30-year norm" unless thirty years were used.
 */
export function HistoricalContext({ baseline }: HistoricalContextProps): ReactNode {
  const years = baseline.years_used ?? [];

  return (
    <ProvenanceSection
      dataClass="historical"
      title="Historical context"
      attribution={attributionOf({
        provider: baseline.provider,
        location: baseline.location,
        period: baseline.calendar_period,
        units: baseline.unit_system,
      })}
    >
      <p className={styles.statement}>{baseline.labelling}</p>

      <ul className={styles.findings}>
        {([["Mean", baseline.mean], ["Minimum", baseline.minimum], ["Maximum", baseline.maximum]] as const).map(
          ([label, result]) =>
            result ? (
              <li className={styles.finding} key={label}>
                <span className={styles.findingLabel}>
                  {label} · {baseline.measure.replace(/_/g, " ")}
                </span>
                {typeof result.value === "number" ? (
                  <span className={styles.findingValue}>
                    {formatReading({ value: result.value, unit: result.unit ?? null })}
                  </span>
                ) : (
                  <span className={styles.note}>Not computable.</span>
                )}
                <MethodNote method={result.method} pointsUsed={result.points_used} />
              </li>
            ) : null,
        )}
      </ul>

      <p className={styles.note}>
        {years.length > 0
          ? `Computed from ${years.length} ${years.length === 1 ? "year" : "years"}: ${years.join(", ")}.`
          : "The archive reported no years for this window."}
      </p>
      {baseline.coverage_note ? <p className={styles.note}>{baseline.coverage_note}</p> : null}
    </ProvenanceSection>
  );
}

/* ---------------------------------------------------------------- what changed */

export interface WhatChangedProps {
  /**
   * The comparison `GET /api/v1/weather/changes` returned, or null when none could be obtained.
   *
   * Null is the *unavailable* state — the request failed — and is not the same as a report whose
   * `comparison_available` is false, which is the backend saying there is nothing earlier on record.
   */
  readonly report?: WhatChangedReport | null;
}

/**
 * *What Changed?* — how the forecast moved since the last captured snapshot.
 *
 * Three states, and the distinction between the last two is the whole requirement:
 *
 * - **A comparison**, listing the days that moved materially.
 * - **No prior snapshot**: nothing earlier exists for this location and window, said plainly. It is
 *   never rendered as a zero delta, which would claim the forecast had not moved.
 * - **Not available**: no comparison could be obtained at all. Distinct from the above, because
 *   "nothing to compare against" and "we could not ask" are different facts.
 *
 * The section is badged FORECAST: a delta between two provider forecasts is a statement about
 * provider figures, and the backend labels it that way too.
 */
export function WhatChanged({ report }: WhatChangedProps): ReactNode {
  if (!report) {
    return (
      <ProvenanceSection dataClass="forecast" title="What Changed?">
        <EmptyState title="Forecast movement is not available yet">
          Weathra compares a forecast against the last snapshot captured for the same location and
          window. No comparison could be retrieved for this briefing.
        </EmptyState>
      </ProvenanceSection>
    );
  }

  const material = (report.changes ?? []).filter((change) => change.material);

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="What Changed?"
      attribution={attributionOf({
        provider: report.provider,
        location: report.location,
        period: report.period,
        retrievedAt: report.current_retrieved_at,
        units: report.unit_system,
      })}
    >
      <p className={styles.statement}>{report.statement}</p>

      {!report.comparison_available ? (
        // Never a zero delta: no earlier snapshot is not the same as no movement.
        <EmptyState title="No earlier snapshot for this location and window">
          There is nothing yet to compare this forecast against.
        </EmptyState>
      ) : material.length === 0 ? (
        <p className={styles.note}>
          Nothing moved beyond the materiality margin for its measure since the previous snapshot.
        </p>
      ) : (
        <ul className={styles.findings}>
          {material.map((change) => (
            <li className={styles.finding} key={`${change.local_date}-${change.measure}`}>
              <span className={styles.findingLabel}>
                {change.local_date} · {change.measure.replace(/_/g, " ")}
              </span>
              <span className={styles.findingValue}>
                {typeof change.change === "number"
                  ? `${change.change > 0 ? "+" : ""}${formatReading({ value: change.change, unit: change.unit })}`
                  : "Not comparable"}
              </span>
              <span className={styles.note}>{change.statement}</span>
            </li>
          ))}
        </ul>
      )}

      {report.previous_retrieved_at ? (
        <p className={styles.note}>Previous snapshot retrieved {report.previous_retrieved_at}.</p>
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------- the right-hand rail panels */

/**
 * "Saved Snapshots" — the panel `01-dashboard.png` puts under the anomaly panel.
 *
 * The artifact lists four places with a temperature and a trend arrow beside each. The places are
 * real here; the temperatures are not rendered, and that is a deliberate refusal rather than an
 * omission. There is no endpoint that returns conditions for a *set* of locations: a temperature
 * per row means one weather request per saved place, on every load of the Dashboard, each with its
 * own loading and failure state — for figures the briefing already presents properly for the place
 * the person actually chose. `docs/design/screens.md` §8 records the same decision for the Saved
 * Locations cards, and this is the same trade in a smaller frame.
 *
 * What the rows do carry is what the artifact's arrow implies: following one briefs the Dashboard
 * on that place, through `?place=` and the backend's resolver.
 */
export function SavedSnapshots({
  state,
}: {
  readonly state: ViewState<SavedLocationsResponse>;
}): ReactNode {
  const records = state.kind === "ready" ? state.data.locations : [];

  return (
    <Card aria-labelledby="dashboard-snapshots">
      <CardHeader headingLevel={2}
        title="Saved snapshots"
        titleId="dashboard-snapshots"
        actions={
          <Link className={styles.panelLink} href="/locations">
            View all
          </Link>
        }
      />
      <CardBody>
        {state.kind === "loading" ? (
          <p className={styles.note}>Loading your saved places…</p>
        ) : state.kind === "error" ? (
          <p className={styles.note}>Your saved places could not be loaded.</p>
        ) : records.length === 0 ? (
          <p className={styles.note}>
            No places saved yet. <Link href="/locations">Save one</Link> and it appears here.
          </p>
        ) : (
          <ul className={styles.snapshots}>
            {records.map((record) => {
              const name = record.label?.trim() || record.location.display_name;
              return (
                <li key={record.id}>
                  <Link
                    className={styles.snapshot}
                    href={`/?place=${encodeURIComponent(name)}`}
                  >
                    <span className={styles.snapshotName}>{name}</span>
                    <span className={styles.snapshotMeta}>{record.location.timezone}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * "Climate Pulse Analytics" — the artifact's wide intra-day chart.
 *
 * It is drawn from the forecast's **hourly** series, which is the only intra-day data Weathra has;
 * the artifact's own version pairs a temperature curve with precipitation bars on a second axis,
 * and this draws the curve alone for the reason `screens.md` §8 already records for Historical
 * Analytics: a second y-axis makes any relationship between two series an artifact of where the
 * axes were put.
 *
 * **When the provider supplies no hourly series the panel stays and says so.** That is the state
 * the stub is in, and it is a real state — not every provider returns hourly data for every place.
 * A panel that vanished would make the Dashboard a different shape depending on the provider.
 */
export function ClimatePulse({ forecast }: { readonly forecast: ForecastResponse }): ReactNode {
  const points = pointsFrom(forecast.hourly);
  const measure = "temperature";
  const drawable = hasValues(points, measure);

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Climate pulse"
      attribution={attributionOf({
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
    >
      {drawable ? (
        <RecordedAgainstBaselineChart
          points={points}
          measure={measure}
          unit={forecast.hourly?.units?.[measure] ?? null}
          seriesLabel="Temperature"
          title="Temperature through the forecast window"
          missing={missingCount(points, measure)}
          baselineValue={null}
          baselineLabel={null}
        />
      ) : (
        <EmptyChart
          title="Temperature through the forecast window"
          reason="No hourly series reported for this window."
        />
      )}
    </ProvenanceSection>
  );
}

/**
 * "Precipitation Logic" — the artifact's narrow risk panel beside the pulse chart.
 *
 * The artifact states "42% Integrated Risk", a convective type and a millimetre-per-hour load. None
 * of the three is a figure Weathra's backend produces, and an "integrated risk" percentage in
 * particular is precisely the kind of invented confidence `screens.md` §5 refuses across the set.
 *
 * So the panel keeps its position and its shape and carries the two things that *are* true about
 * precipitation in this window: whatever the forecast reported for it, and the uncertainty
 * statement the backend supplies with every forecast — its basis, its provider, and whether that
 * provider gave a spread at all. Where the provider reported no precipitation, the panel says that
 * rather than showing a zero, because no reading and a reading of zero are different facts.
 */
export function PrecipitationOutlook({
  forecast,
}: {
  readonly forecast: ForecastResponse;
}): ReactNode {
  const days = forecastDaysFrom(forecast.daily);
  const wet = days
    .map((day) => ({
      date: day.date,
      reading: day.other.find((entry) => entry.key.startsWith("precipitation")) ?? null,
    }))
    .filter((entry): entry is { date: string; reading: Reading } => entry.reading !== null);

  const uncertainty = forecast.uncertainty;

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Precipitation outlook"
      attribution={attributionOf({
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
    >
      {wet.length > 0 ? (
        <dl className={styles.measures}>
          {wet.map((entry) => (
            <div className={styles.measure} key={entry.date}>
              <dt className={styles.measureTerm}>{entry.date}</dt>
              <dd className={styles.measureValue}>{formatReading(entry.reading)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.note}>
          This provider reported no precipitation for the days in this window. That is an absent
          reading, not a reading of zero.
        </p>
      )}

      {uncertainty ? (
        <div className={styles.outlookBasis}>
          <p className={styles.note}>{uncertainty.basis}</p>
          <p className={styles.note}>
            {uncertainty.spread_available
              ? `${uncertainty.provider} supplied a spread for this forecast.`
              : `${uncertainty.provider} supplied no forecast spread, so none is shown.`}
          </p>
        </div>
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------ confidence matrix */

export interface ConfidenceMatrixProps {
  readonly forecast: ForecastResponse | null;
  readonly analysis: AnalysisResponse | null;
}

/**
 * "Confidence Matrix" — the bars beside Weathra Intelligence in `01-dashboard.png`.
 *
 * The artifact fills them with MODEL CONVERGENCE 94% and DATA RELIABILITY 82%. Weathra computes
 * neither: there is one provider, so there is nothing to converge, and no endpoint scores a
 * provider's reliability. Both bars are therefore drawn unfilled with the reason stated.
 *
 * The two rows that *can* carry something do. Forecast confidence comes from the backend's own
 * `UncertaintyStatement` — a level per horizon distance, which is a real graded figure — and
 * coverage is the share of points the deterministic analytics actually used, which the statistics
 * report themselves.
 */
export function ConfidenceMatrix({ forecast, analysis }: ConfidenceMatrixProps): ReactNode {
  const horizon = forecast?.uncertainty?.horizon?.[0] ?? null;
  /*
   * The backend grades a horizon point as high/moderate/low. The bar shows that grade at a fixed
   * position rather than inventing a percentage between them — the figure being drawn is the
   * backend's own three-step grade, not a continuous score somebody computed.
   */
  const level = confidenceLevelFor(horizon?.confidence);
  const confidence =
    level === "high" ? 0.9 : level === "moderate" ? 0.6 : level === "low" ? 0.3 : null;

  const results: readonly StatisticResult[] = analysis?.findings ?? [];
  const used = results.reduce((total, result) => total + (result.points_used ?? 0), 0);
  const excluded = results.reduce((total, result) => total + (result.points_excluded ?? 0), 0);
  const coverage = used + excluded > 0 ? used / (used + excluded) : null;

  return (
    <section className={styles.matrix} aria-label="Confidence matrix">
      <h3 className={styles.matrixTitle}>Confidence matrix</h3>
      <Meter
        label="Forecast confidence"
        value={confidence}
        unavailable="No horizon reported"
        note={
          horizon
            ? `Graded from horizon distance — ${horizon.hours_ahead} h ahead.`
            : "The provider reported no horizon points."
        }
      />
      <Meter
        label="Analytics coverage"
        value={coverage}
        unavailable="No statistics yet"
        note={
          coverage === null
            ? "Nothing computed for this window."
            : `${used} of ${used + excluded} points usable.`
        }
      />
      <Meter
        label="Model convergence"
        value={null}
        unavailable="Single provider"
        note="Weathra reads one provider, so there is nothing to converge."
      />
      <Meter
        label="Provider reliability"
        value={null}
        unavailable="Not scored"
        note="No endpoint scores a provider's reliability."
      />
    </section>
  );
}
