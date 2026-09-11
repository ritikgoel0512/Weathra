"use client";

/**
 * The Analyst's location context — the band `02-ai-weather-analyst.png` anchors its workspace on.
 *
 * # Why this exists
 *
 * The production fidelity review of 2026-09-10 graded this screen NOT CLOSE, and the reason was
 * not that a region was styled wrongly. The artifact is a *populated* analytical workspace; the
 * implementation was a heading, one paragraph, three chips and a composer, with two thirds of the
 * viewport empty beneath them and a single sentence in the rail. Nothing was incorrect and there
 * was nothing to look at.
 *
 * A conversation cannot be populated before somebody asks something, and inventing one is out of
 * the question. What *can* be populated before then — and is on the artifact, as its FOCUS chip and
 * its data-source panel — is the context the question will be answered in: which place, in which
 * units, over what horizon, and what the weather there is right now. All of that is real, retrieved
 * from `/me/preferences` and `/weather/current`, and it is on screen before a single token is
 * spent.
 *
 * So this band is not decoration filling a gap. It is the answer to "what is this question about?",
 * which is a question the screen should have been answering all along.
 *
 * # What it refuses
 *
 * The artifact's version of this region is a generated telemetry field with `GLOBAL_SAT` and
 * `L_RADAR` chips over it, a "Neural Agent v4.8" with a compute-load percentage, and three named
 * third-party feeds. `docs/design/screens.md` §5 refuses all of it. What is drawn instead is the
 * place — photographed through the shared `LocationImage`, whose credential-free tier renders
 * immediately so the frame is never blank — with the readings the provider actually reported, each
 * carrying the observed class.
 *
 * # Cost
 *
 * One `/weather/current` read, cached under the same key the Dashboard and the Report use, so
 * arriving here from either spends nothing. It is a retrieval, not an inference: opening the
 * Analyst still costs no model call and no allowance.
 */

import type { ReactNode } from "react";

import { DataClassBadge, LocationImage, Skeleton } from "@/components/ui";
import type { CurrentResponse, Location, PreferenceView } from "@/lib/api/schema";
import { formatReading, measureLabel, readingsFrom } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiQuery } from "@/lib/query/hooks";

import styles from "./analyst.module.css";

export interface AnalystFocusProps {
  /** The place the question will resolve against, from preferences. Null when none is set. */
  readonly location: Location | null;
  readonly preferences: PreferenceView | null;
  /**
   * The place the *last answer* resolved to, when there is one.
   *
   * A run can resolve somewhere other than the default — somebody asked about Tokyo — and the band
   * says so rather than continuing to show the default as though it were the subject.
   */
  readonly resolved?: string | null;
}

/** The three facts the artifact's FOCUS / UNITS / DEPTH row claims, where Weathra has them. */
function ContextFacts({
  location,
  preferences,
  resolved,
}: {
  readonly location: Location | null;
  readonly preferences: PreferenceView | null;
  readonly resolved: string | null;
}): ReactNode {
  return (
    <dl className={styles.focusFacts}>
      <div className={styles.focusFact}>
        <dt>Focus</dt>
        <dd>{resolved ?? (location ? friendlyName(location) : "No default location set")}</dd>
      </div>
      <div className={styles.focusFact}>
        <dt>Units</dt>
        <dd>{preferences?.unit_system ?? "From your preferences"}</dd>
      </div>
      <div className={styles.focusFact}>
        <dt>Horizon</dt>
        <dd>
          {typeof preferences?.forecast_horizon_days === "number"
            ? `${preferences.forecast_horizon_days} days`
            : "From your preferences"}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The band itself.
 *
 * Rendered whether or not a conversation is open, so the workspace has the same shape before and
 * after a run — which is the whole of what the review asked for. Without a default location it
 * degrades to the facts row alone rather than to a blank frame: there is no place to photograph,
 * and a photograph of nowhere is worse than none.
 */
export function AnalystFocus({ location, preferences, resolved = null }: AnalystFocusProps): ReactNode {
  const current = useApiQuery<CurrentResponse>({
    key: ["weather", "current", location?.latitude, location?.longitude],
    request: (client) =>
      client.current({ latitude: location!.latitude, longitude: location!.longitude }),
    enabled: location !== null,
  });

  const reading = current.state.kind === "ready" ? current.state.data : null;
  const reported = reading ? readingsFrom(reading.values, reading.units) : [];
  /*
   * Temperature is the readout over the photograph, so it is not repeated in the row beneath it.
   * The row is the measures that have nowhere else to be — and a place reporting temperature only
   * gets the readout and no row, rather than the same figure printed twice.
   */
  const temperature = reported.find((entry) => entry.key === "temperature") ?? null;
  const readings = reported.filter((entry) => entry.key !== "temperature").slice(0, 4);

  if (location === null) {
    return (
      <section className={styles.focus} aria-label="Question context">
        <div className={styles.focusBody}>
          <ContextFacts location={null} preferences={preferences} resolved={resolved} />
          <p className={styles.note}>
            Questions resolve against the place you name in them until a default is set.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.focus} aria-label="Question context">
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="banner"
        scrim="strong"
      >
        <div className={styles.focusOverlay}>
          <p className={styles.focusPlace}>{friendlyName(location)}</p>
          {temperature ? (
            <p className={styles.focusReadout}>{formatReading(temperature)}</p>
          ) : null}
        </div>
      </LocationImage>

      <div className={styles.focusBody}>
        <ContextFacts location={location} preferences={preferences} resolved={resolved} />

        {/*
          The readings, or the reason there are none.

          A skeleton while the read is in flight rather than an empty row that fills and reflows;
          a failed read says so in one line and takes nothing else down with it — the question can
          still be asked, and the agent does its own retrieval anyway.
        */}
        {current.state.kind === "loading" ? (
          <div className={styles.focusReadings} aria-hidden="true">
            <Skeleton width="88px" height="var(--space-6)" />
            <Skeleton width="88px" height="var(--space-6)" />
            <Skeleton width="88px" height="var(--space-6)" />
          </div>
        ) : readings.length > 0 ? (
          <div className={styles.focusReadings}>
            <DataClassBadge dataClass="observed" />
            {readings.map((entry) => (
              <span className={styles.focusReading} key={entry.key}>
                <span className={styles.focusReadingLabel}>{measureLabel(entry.key)}</span>
                <span className={styles.focusReadingValue}>{formatReading(entry)}</span>
              </span>
            ))}
            {reading?.attribution?.provider ? (
              <span className={styles.focusProvider}>via {reading.attribution.provider}</span>
            ) : null}
          </div>
        ) : (
          <p className={styles.note}>
            No current reading is available for this place right now. Asking a question still works:
            the agent retrieves its own.
          </p>
        )}
      </div>
    </section>
  );
}
