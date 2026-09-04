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

import type { ReactNode } from "react";

import {
  Badge,
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
  StatisticResult,
} from "@/lib/api/schema";
import { confidenceLevelFor } from "@/lib/design/data-class";
import {
  formatReading,
  forecastDaysFrom,
  readingFor,
  readingsFrom,
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
 * The band across the top: what the provider measured, badged OBSERVED.
 *
 * The temperature leads because the artifact leads with it; everything else the provider reported
 * follows in the strip beside it. Neither is a fixed set — what is shown is what came back.
 */
export function CurrentConditions({ current, location }: CurrentConditionsProps): ReactNode {
  const readings = readingsFrom(current.values, current.units);
  const temperature = readingFor("temperature", current.values, current.units);
  const rest = readings.filter((reading) => reading.key !== "temperature");

  return (
    <ProvenanceSection
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
      <div className={styles.conditions}>
        <div className={styles.conditionsPrimary}>
          <p className={styles.place}>{location.display_name}</p>
          <p className={styles.placeMeta}>
            <span>{location.timezone}</span>
            <span>Observed {current.observed_at_local}</span>
          </p>
        </div>

        {temperature ? (
          <p className={styles.readout}>{formatReading(temperature)}</p>
        ) : (
          <p className={styles.note}>No temperature reported for this location just now.</p>
        )}
      </div>

      {rest.length > 0 ? (
        <Measures readings={rest} />
      ) : (
        <p className={styles.note}>The provider reported no other measures for this instant.</p>
      )}
    </ProvenanceSection>
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
