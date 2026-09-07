"use client";

/**
 * Historical Analytics — task 21.3.
 *
 * Three questions about the past, asked of the documented API and nothing else: what the archive
 * recorded over a window, how that window compares with an earlier one, and how it sits against the
 * baseline of the years before it. Every figure on the screen was computed by
 * `deterministic-analytics` behind FastAPI and arrived with its method and its point count; the
 * browser retrieves nothing, averages nothing and subtracts nothing.
 *
 * **The location is chosen, never guessed.** The person's saved locations and their default come
 * from `/me/preferences` and `/me/locations`, and requests go by the resolved coordinates — so a
 * name that could mean two places never reaches a weather endpoint from here. Somebody with no
 * saved location gets a state that says so and the way to set one.
 *
 * **A range the archive cannot serve is refused, not approximated.** The backend validates the
 * range against the provider's declared coverage before any upstream call and answers with
 * `range_outside_coverage` and the earliest date it holds. That message is what this screen shows.
 * It does not clamp the dates, retry a shorter window, or fill the gap with an estimate.
 *
 * **The three surfaces fail independently.** The observations, the period comparison and the
 * baseline are three requests; one failing leaves the other two on screen with their own retry,
 * because a comparison that could not be built is not a reason to withhold the observations.
 */

import Link from "next/link";
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button, EmptyState, ErrorState, Input, LoadingState, Select } from "@/components/ui";
import type { Location, PreferenceView, SavedLocationsResponse } from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import {
  hasValues,
  missingCount,
  pointsFrom,
  unitFor,
  yearsBefore,
} from "@/lib/historical/analysis";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import { PrecipitationChart, RecordedAgainstBaselineChart } from "./charts";
import {
  AnomalyIntelligence,
  DeviationAnalysis,
  BaselinePanel,
  ClassKey,
  HeadlineFigures,
  Observations,
  PeriodComparisonPanel,
} from "./sections";
import styles from "./historical.module.css";

import { FixtureHistorical } from "./fixture-historical";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

/** What the window is asked for, before it is asked for. */
interface Range {
  readonly start: string;
  readonly end: string;
}

interface Enquiry {
  readonly location: Location;
  readonly selected: Range;
  readonly earlier: Range;
  readonly years: number;
}

/** The measures the two charts draw, named from the API's own keys. */
const TEMPERATURE = "temperature_mean";
const PRECIPITATION = "precipitation_sum";

/**
 * A starting window: the seven days ending a week ago.
 *
 * Behind the archive's reporting lag on purpose, so the first request a person makes is one the
 * provider can serve. It is a starting point in a form they can change, not a claim about anything.
 */
function defaultRange(today: Date): Range {
  const iso = (shift: number): string =>
    new Date(today.getTime() - shift * 86_400_000).toISOString().slice(0, 10);
  return { start: iso(14), end: iso(8) };
}

function everyLocation(
  preferences: PreferenceView | undefined,
  saved: SavedLocationsResponse | undefined,
): Location[] {
  const places: Location[] = [];
  const seen = new Set<string>();

  for (const place of [
    ...(preferences?.default_location ? [preferences.default_location] : []),
    ...(saved?.locations ?? []).map((record) => record.location),
  ]) {
    const key = `${place.latitude},${place.longitude}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }
  return places;
}

/** The form: which place, which window, which window to compare it with, and how many years. */
function Controls({
  places,
  enquiry,
  onSubmit,
  busy,
}: {
  readonly places: readonly Location[];
  readonly enquiry: Enquiry;
  readonly onSubmit: (next: Enquiry) => void;
  readonly busy: boolean;
}): ReactNode {
  const [place, setPlace] = useState(enquiry.location.display_name);
  const [selected, setSelected] = useState<Range>(enquiry.selected);
  const [earlier, setEarlier] = useState<Range>(enquiry.earlier);
  const [years, setYears] = useState(String(enquiry.years));

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const chosen = places.find((candidate) => candidate.display_name === place);
      if (chosen === undefined) return;
      onSubmit({ location: chosen, selected, earlier, years: Number(years) });
    },
    [earlier, onSubmit, place, places, selected, years],
  );

  return (
    <form className={styles.controls} onSubmit={submit} aria-label="Choose what to analyse">
      <Select
        label="Location"
        value={place}
        onChange={(event) => setPlace(event.target.value)}
        options={places.map((candidate) => ({
          value: candidate.display_name,
          label: candidate.display_name,
        }))}
      />
      <Input
        label="Selected period, from"
        type="date"
        value={selected.start}
        onChange={(event) => setSelected((range) => ({ ...range, start: event.target.value }))}
      />
      <Input
        label="Selected period, to"
        type="date"
        value={selected.end}
        onChange={(event) => setSelected((range) => ({ ...range, end: event.target.value }))}
      />
      <Input
        label="Compare with, from"
        type="date"
        value={earlier.start}
        onChange={(event) => setEarlier((range) => ({ ...range, start: event.target.value }))}
      />
      <Input
        label="Compare with, to"
        type="date"
        value={earlier.end}
        onChange={(event) => setEarlier((range) => ({ ...range, end: event.target.value }))}
      />
      <Input
        label="Baseline years"
        type="number"
        min={2}
        max={50}
        value={years}
        description="How many years before the selected period to build the baseline from."
        onChange={(event) => setYears(event.target.value)}
      />
      <div className={styles.controlsAction}>
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? "Retrieving…" : "Analyse"}
        </Button>
      </div>
    </form>
  );
}

/** The three requests, and the surfaces they produce. */
function Analysis({ enquiry }: { readonly enquiry: Enquiry }): ReactNode {
  const place = {
    latitude: enquiry.location.latitude,
    longitude: enquiry.location.longitude,
  };

  const history = useApiQuery({
    key: ["historical", "history", place, enquiry.selected],
    request: (client) => client.history({ ...place, ...enquiry.selected }),
  });

  const comparison = useApiQuery({
    key: ["historical", "comparison", place, enquiry.selected, enquiry.earlier],
    request: (client) =>
      client.periodComparison({
        ...place,
        earlier_start: enquiry.earlier.start,
        earlier_end: enquiry.earlier.end,
        later_start: enquiry.selected.start,
        later_end: enquiry.selected.end,
      }),
  });

  const baseline = useApiQuery({
    key: ["historical", "baseline", place, enquiry.selected, enquiry.years],
    request: (client) =>
      client.baselineComparison({
        ...place,
        start: enquiry.selected.start,
        end: enquiry.selected.end,
        years: enquiry.years,
        measure: TEMPERATURE,
      }),
  });

  const observed = history.state.kind === "ready" ? history.state.data : null;
  const points = useMemo(() => pointsFrom(observed?.daily), [observed]);
  const baselineMean =
    baseline.state.kind === "ready" ? (baseline.state.data.baseline.mean.value ?? null) : null;
  const baselineYears =
    baseline.state.kind === "ready"
      ? `Baseline, ${baseline.state.data.baseline.years_used.length} years`
      : null;

  return (
    <div className={styles.analysis}>
      {comparison.state.kind === "ready" ? (
        <HeadlineFigures comparison={comparison.state.data} />
      ) : null}

      <ClassKey />

      {/*
        The artifact's main row: the archive chart occupying the wide left column, and the
        baseline comparison — its "Anomaly Intelligence" slot — beside it rather than beneath. The
        panel there is deterministic: a z-score and the baseline it is against, which is what
        Weathra actually computes. The artifact's own panel is a model narrative about the same
        figures, and this screen consults no model (`docs/design/screens.md` §8).
      */}
      <div className={styles.mainRow}>
        <div className={styles.column}>
      {history.state.kind === "loading" ? (
        <LoadingState label="Retrieving the archive" lines={6} />
      ) : history.state.kind === "error" ? (
        <ErrorState failure={history.state.failure} onRetry={history.retry} />
      ) : observed ? (
        <Observations history={observed}>
          {hasValues(points, TEMPERATURE) ? (
            <RecordedAgainstBaselineChart
              points={points}
              measure={TEMPERATURE}
              unit={unitFor(observed.daily, TEMPERATURE)}
              seriesLabel={measureLabel(TEMPERATURE)}
              title={`${measureLabel(TEMPERATURE)} recorded, against the baseline`}
              missing={missingCount(points, TEMPERATURE)}
              baselineValue={baselineMean}
              baselineLabel={baselineYears}
            />
          ) : (
            <p className={styles.note}>
              The archive reported no {measureLabel(TEMPERATURE).toLowerCase()} for this window, so
              no chart is drawn for it.
            </p>
          )}

          {hasValues(points, PRECIPITATION) ? (
            <PrecipitationChart
              points={points}
              measure={PRECIPITATION}
              unit={unitFor(observed.daily, PRECIPITATION)}
              seriesLabel={measureLabel(PRECIPITATION)}
              title={`${measureLabel(PRECIPITATION)} recorded`}
              missing={missingCount(points, PRECIPITATION)}
            />
          ) : (
            <p className={styles.note}>
              The archive reported no {measureLabel(PRECIPITATION).toLowerCase()} for this window,
              so no chart is drawn for it.
            </p>
          )}
        </Observations>
      ) : null}
        </div>

        <div className={styles.column}>
          {baseline.state.kind === "loading" ? (
            <LoadingState label="Building the baseline" lines={4} />
          ) : baseline.state.kind === "error" ? (
            <ErrorState failure={baseline.state.failure} onRetry={baseline.retry} />
          ) : baseline.state.kind === "ready" ? (
            <BaselinePanel comparison={baseline.state.data} />
          ) : null}
        </div>
      </div>

      {/* The artifact's lower row: deviation bars on the left, the anomaly panel on the right. */}
      <div className={styles.mainRow}>
        <div className={styles.column}>
          <DeviationAnalysis
            comparison={baseline.state.kind === "ready" ? baseline.state.data : null}
          />
        </div>
        <div className={styles.column}>
          <AnomalyIntelligence
            comparison={baseline.state.kind === "ready" ? baseline.state.data : null}
          />
        </div>
      </div>

      {comparison.state.kind === "loading" ? (
        <LoadingState label="Comparing the two periods" lines={4} />
      ) : comparison.state.kind === "error" ? (
        <ErrorState failure={comparison.state.failure} onRetry={comparison.retry} />
      ) : comparison.state.kind === "ready" ? (
        <PeriodComparisonPanel comparison={comparison.state.data} />
      ) : null}
    </div>
  );
}

export function HistoricalAnalytics(): ReactNode {
  /*
   * Visual-fidelity review only.
   *
   * The flag's value is baked into the bundle at build time, so in a deployed build this comparison
   * is always false and nothing below it is reachable — but it is a *runtime* comparison against a
   * baked object rather than a folded constant, so the branch and the fixture screen do ship. See
   * `lib/fixtures/visily.ts` for what that does and does not guarantee. Nothing below changes.
   */
  if (usingVisilyFixtures()) return <FixtureHistorical />;
  const preferences = useApiQuery({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });
  const saved = useApiQuery({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
  });

  const [enquiry, setEnquiry] = useState<Enquiry | null>(null);

  const places = everyLocation(
    preferences.state.kind === "ready" ? preferences.state.data : undefined,
    saved.state.kind === "ready" ? saved.state.data : undefined,
  );

  if (preferences.state.kind === "loading" || saved.state.kind === "loading") {
    return <LoadingState label="Loading your locations" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }

  if (places.length === 0) {
    return (
      <EmptyState
        title="No location to analyse"
        action={
          <Link className={styles.controlsAction} href="/settings">
            <Button variant="primary" size="sm">
              Choose a default location
            </Button>
          </Link>
        }
      >
        Historical Analytics works on one place at a time. Choose a default location in Settings, or
        save one from Saved Locations, and it will be selectable here.
      </EmptyState>
    );
  }

  const first = places[0] as Location;
  const initial: Enquiry = enquiry ?? {
    location: first,
    selected: defaultRange(new Date()),
    earlier: {
      start: yearsBefore(defaultRange(new Date()).start, 1),
      end: yearsBefore(defaultRange(new Date()).end, 1),
    },
    years: 10,
  };

  return (
    <section className={styles.screen} aria-label="Historical Analytics">
      <header className={styles.heading}>
        <h1 className={styles.title}>Historical Analytics</h1>
        <p className={styles.subtitle}>
          The archive, an earlier window, and the years behind them. Nothing estimated.
        </p>
      </header>

      <Controls places={places} enquiry={initial} onSubmit={setEnquiry} busy={false} />

      <Analysis enquiry={initial} />
    </section>
  );
}
