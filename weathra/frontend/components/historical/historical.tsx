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

import {
  Button,
  EmptyChart,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from "@/components/ui";
import type {
  HistoryResponse,
  Location,
  PreferenceView,
  SavedLocationsResponse,
  UnitSystem,
} from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import { csvFilenameFor, csvFromHistory } from "@/lib/historical/export";
import { UNIT_OPTIONS } from "@/lib/settings/preferences";
import {
  hasValues,
  missingCount,
  pointsFrom,
  unitFor,
  yearsBefore,
} from "@/lib/historical/analysis";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import { ArchiveOverviewChart, PrecipitationChart } from "./charts";
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
import { placeLabel } from "@/lib/locations/place";

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
  /**
   * The unit system every figure on the screen is asked for in.
   *
   * It opens on the person's saved preference and the toggle changes it *for this reading only* —
   * `specs/memory` is explicit that a preference is never inferred from behaviour, and switching a
   * screen to Fahrenheit to look at one window is not a decision to store. Settings is still the
   * one place a preference is chosen.
   */
  readonly units: UnitSystem;
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
      // The unit system is the toolbar's, not this form's: it carries through unchanged.
      onSubmit({ location: chosen, selected, earlier, years: Number(years), units: enquiry.units });
    },
    [earlier, enquiry.units, onSubmit, place, places, selected, years],
  );

  return (
    <form className={styles.controls} onSubmit={submit} aria-label="Choose what to analyse">
      <Select
        label="Location"
        value={place}
        onChange={(event) => setPlace(event.target.value)}
        options={places.map((candidate) => ({
          // The value stays the geocoder's own name because it is what `places.find` matches on
          // below; only what a person reads changes.
          value: candidate.display_name,
          label: placeLabel(candidate) ?? candidate.display_name,
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

/**
 * The screen's header row: what is being analysed, in what units, and the way to take it away.
 *
 * `03-historical-analytics.png` opens with a compact toolbar — one date-range control, a °C/°F
 * toggle and EXPORT DATA — over the tiles. Production opened with six bare date inputs, a select
 * and a number field, all of them expanded, which the runtime fidelity audit of 2026-09-08 called
 * the largest single remaining source of the screen's console character (findings 3.3 and 3.6).
 *
 * **Nothing is removed.** Every field is the same field, behind a disclosure whose summary states
 * the current selection in words, so what is being analysed is readable without opening anything.
 * The disclosure opens on demand and stays open while it is being used.
 */
function Toolbar({
  enquiry,
  controls,
  onUnits,
  observed,
}: {
  readonly enquiry: Enquiry;
  readonly controls: ReactNode;
  readonly onUnits: (units: UnitSystem) => void;
  /** The retrieved window, for the export. Absent until it has arrived. */
  readonly observed: HistoryResponse | null;
}): ReactNode {
  const download = useCallback(() => {
    if (observed === null) return;
    /*
     * A Blob and an object URL rather than a `data:` link: a window of daily observations runs to
     * tens of kilobytes and a `data:` URL of that size is refused by more than one browser. The URL
     * is revoked immediately after the click, so nothing is held.
     */
    const blob = new Blob([csvFromHistory(observed)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilenameFor(observed);
    link.click();
    URL.revokeObjectURL(url);
  }, [observed]);

  return (
    <div className={styles.toolbar}>
      <details className={styles.enquiryDisclosure}>
        <summary className={styles.enquirySummary}>
          {placeLabel(enquiry.location)} · {enquiry.selected.start} to {enquiry.selected.end} ·
          against {enquiry.earlier.start} to {enquiry.earlier.end} · {enquiry.years}-year baseline
        </summary>
        {controls}
      </details>

      <div className={styles.toolbarActions}>
        <fieldset className={styles.unitToggle}>
          <legend className={styles.unitLegend}>Units</legend>
          {UNIT_OPTIONS.map((option) => (
            <label className={styles.unitOption} key={option.value}>
              <input
                type="radio"
                name="historical-units"
                value={option.value}
                checked={enquiry.units === option.value}
                onChange={() => onUnits(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        <Button size="sm" onClick={download} disabled={observed === null}>
          Export the observations (CSV)
        </Button>
      </div>

      {/*
        Stated, because a toggle that looks like a preference control and is not would be the more
        confusing of the two. `specs/memory`: a preference is chosen in Settings, never inferred.
      */}
      <p className={styles.note}>
        The unit toggle changes this reading only. Your saved preference is unchanged.
      </p>
    </div>
  );
}

/** The three requests, and the surfaces they produce. */
function Analysis({
  enquiry,
  controls,
  onUnits,
}: {
  readonly enquiry: Enquiry;
  readonly controls: ReactNode;
  readonly onUnits: (units: UnitSystem) => void;
}): ReactNode {
  const place = {
    latitude: enquiry.location.latitude,
    longitude: enquiry.location.longitude,
    units: enquiry.units,
  };

  /*
   * The three reads run in sequence, not at once, and that is a fix rather than a preference.
   *
   * Each is a separate archive request upstream, and two of them fan out further: the comparison
   * fetches two periods and the baseline fetches one per year. Fired together at the default ten
   * years, a single page load asked Open-Meteo for the same place twelve times inside a second and
   * was rate-limited, which is what put two red panels on this screen in production.
   *
   * Waiting for the first read has three effects. The archive sees a paced sequence rather than a
   * burst. The selected period is fetched once and served from the provider cache to the two reads
   * that also need it, instead of three simultaneous misses racing each other. And when the first
   * read is refused, the other two are never sent — the screen reports one limit instead of three.
   */
  const history = useApiQuery({
    key: ["historical", "history", place, enquiry.selected],
    request: (client) => client.history({ ...place, ...enquiry.selected }),
  });

  const observedReady = history.state.kind === "ready";

  const comparison = useApiQuery({
    key: ["historical", "comparison", place, enquiry.selected, enquiry.earlier],
    enabled: observedReady,
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
    // Last, because it is the widest: one upstream request per year of baseline.
    enabled: comparison.state.kind === "ready" || comparison.state.kind === "error",
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
      {/*
        The artifact's header row, above the tiles: the selection, the units, and the export. It is
        rendered here rather than by the screen because the export is of the window this component
        retrieved, and handing the response back up to be exported would mean two owners for it.
      */}
      <Toolbar enquiry={enquiry} controls={controls} onUnits={onUnits} observed={observed} />

      {/*
        The artifact's metric row: `HeadlineFigures`, which is the backend's own statistics for the
        selected period — mean temperature, the extremes, precipitation, wind and humidity, each
        with the method that produced it.
        *
        A second row folded from the daily series was briefly added above this one and then removed:
        it drew a `MEAN TEMPERATURE` card reading 16 °C directly above this row's `MEAN TEMPERATURE`
        reading 17.9 °C, because one averaged the daily means and the other is the backend's
        statistic over every hourly point. Both were correct and the pair was indefensible. One row,
        one arithmetic, one authority for a figure.
      */}
      {comparison.state.kind === "ready" ? (
        <HeadlineFigures comparison={comparison.state.data} />
      ) : null}

      <ClassKey />

      {/*
        The chart, at the full width the artifact gives it.

        It used to sit in the wide column of a two-column row with the baseline panel beside it,
        and that was a misreading of `03-historical-analytics.png`: the artifact's plot spans the
        whole content width, with the metric row above it and the comparison band below. The
        misreading cost more than fidelity — the baseline panel is naturally about twice the plot's
        height, so the row left roughly 390 pixels of empty page beneath the chart at desk width,
        which is the void two previous passes tried to close by adjusting alignment. There was
        never a column to balance; there was a row that should not have been one.
      */}
      <div className={styles.chartRow}>
      {history.state.kind === "loading" ? (
        <LoadingState label="Retrieving the archive" lines={6} />
      ) : history.state.kind === "error" ? (
        <ErrorState failure={history.state.failure} onRetry={history.retry} />
      ) : observed ? (
        <Observations history={observed}>
          {/*
            One plot, not two. The artifact draws temperature, its normal and precipitation as a
            single figure with two axes, and that is the composition worth having: two stacked
            charts show the same data at half the density and lose the thing a combined plot is for
            — seeing that the wet days were the cold ones. Where the archive reported temperature
            but no precipitation the bars are simply absent and the line stands alone.
          */}
          {hasValues(points, TEMPERATURE) ? (
            <ArchiveOverviewChart
              points={points}
              temperature={TEMPERATURE}
              precipitation={hasValues(points, PRECIPITATION) ? PRECIPITATION : null}
              temperatureUnit={unitFor(observed.daily, TEMPERATURE)}
              precipitationUnit={unitFor(observed.daily, PRECIPITATION)}
              baselineValue={baselineMean}
              baselineLabel={baselineYears}
              title="Recorded against the normal, with precipitation"
              missing={missingCount(points, TEMPERATURE)}
            />
          ) : hasValues(points, PRECIPITATION) ? (
            <PrecipitationChart
              points={points}
              measure={PRECIPITATION}
              unit={unitFor(observed.daily, PRECIPITATION)}
              seriesLabel={measureLabel(PRECIPITATION)}
              title={`${measureLabel(PRECIPITATION)} recorded`}
              missing={missingCount(points, PRECIPITATION)}
            />
          ) : (
            <EmptyChart
              title="Recorded against the normal"
              reason="The archive reported neither temperature nor precipitation for this window."
              height={340}
            />
          )}
        </Observations>
      ) : null}
      </div>

      {/*
        The artifact's comparison band: "Selected Period vs Historical Normal" on the left with its
        deviation bars inside it, and the anomaly panel on the right. The two were separate rows
        here — the baseline beside the chart, the deviation bars beside the anomaly panel — which
        put the baseline's figures a full screen away from the deviation computed from them.
      */}
      <div className={styles.mainRow}>
        <div className={styles.column}>
          {baseline.state.kind === "loading" ? (
            <LoadingState label="Building the baseline" lines={4} />
          ) : baseline.state.kind === "error" ? (
            <ErrorState failure={baseline.state.failure} onRetry={baseline.retry} />
          ) : baseline.state.kind === "ready" ? (
            <BaselinePanel comparison={baseline.state.data} />
          ) : null}
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

/**
 * The screen's frame: its landmark, its heading, and whatever state it is in.
 *
 * **The heading outlives the state**, which is finding 1.1 of the runtime fidelity audit of
 * 2026-09-08 — recorded there against the Dashboard, fixed there for the Dashboard, and still true
 * of this screen on 2026-09-09, where three of the four early returns rendered a state with no
 * `h1` above it. An unnamed page is a page a person cannot tell apart from a different unnamed
 * page, and it is the heading list most screen-reader users navigate by.
 *
 * Found by `tests/e2e/fidelity.spec.ts`, which sweeps every screen in every runtime state rather
 * than in the one the fixtures produce — the whole reason that sweep exists.
 */
function HistoricalFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <section className={styles.screen} aria-label="Historical Analytics">
      <header className={styles.heading}>
        <h1 className={styles.title}>Historical Analytics</h1>
        <p className={styles.subtitle}>
          The archive, an earlier window, and the years behind them. Nothing estimated.
        </p>
      </header>

      {children}
    </section>
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
    return (
      <HistoricalFrame>
        <LoadingState label="Loading your locations" lines={4} />
      </HistoricalFrame>
    );
  }
  if (preferences.state.kind === "error") {
    return (
      <HistoricalFrame>
        <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />
      </HistoricalFrame>
    );
  }

  if (places.length === 0) {
    return (
      <HistoricalFrame>
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
          Historical Analytics works on one place at a time. Choose a default location in Settings,
          or save one from Saved Locations, and it will be selectable here.
        </EmptyState>
      </HistoricalFrame>
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
    // Five, not ten. Each year of baseline is one archive request, so the number a page *opens*
    // with is a decision about how much upstream traffic a visit costs — ten made a first view of
    // this screen the most expensive page in the product. Five is still a baseline anybody would
    // recognise, and the control above raises it for somebody who wants more.
    years: 5,
    // The person's saved preference is where the screen opens. The toggle moves this reading only.
    units:
      preferences.state.kind === "ready" ? preferences.state.data.unit_system : "metric",
  };

  return (
    <HistoricalFrame>
      <Analysis
        enquiry={initial}
        controls={
          <Controls places={places} enquiry={initial} onSubmit={setEnquiry} busy={false} />
        }
        onUnits={(units) => setEnquiry({ ...initial, units })}
      />
    </HistoricalFrame>
  );
}
