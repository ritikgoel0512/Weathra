"use client";

/**
 * Compare Cities — task 21.4.
 *
 * "Which of these places?" asked of `POST /api/v1/weather/comparison` and answered by the
 * comparison service: every candidate ranked, every score built from deterministic analytics
 * results, and every place that could not be scored named with its reason. The browser ranks
 * nothing and scores nothing.
 *
 * **Two locations is a client-side rule as well as a server-side one.** The backend refuses a
 * comparison of one — `specs/location-comparison` requires it to — but making somebody wait for a
 * round trip to be told that comparing one place against nothing is not a comparison is a worse
 * way to learn it. So the control is disabled with the reason stated, and no request is issued.
 * The backend's refusal remains the authority; this is the courtesy in front of it.
 *
 * **Every row that enters the comparison is a resolved place, not a name.** Task 21.7 made that
 * structural. Pressing Compare first resolves every row that has not settled on a place, through the
 * one geocoder Weathra has — `GET /api/v1/locations/resolve`, behind the backend. A row that comes
 * back ambiguous presents its candidates and **stops the comparison**: no ranking is requested,
 * whatever was previously on screen is withdrawn, and the row cannot enter a ranking until somebody
 * presses one of them. Rows seeded from the person's saved locations are already canonical and are
 * not re-resolved, because they were resolved when they were saved.
 *
 * What is sent for a resolved row is that location's canonical qualified name — the backend's own
 * `Location.qualified_name` shape, which is exactly what its ambiguity message tells a caller to
 * resolve with. No coordinate is assembled here and no candidate is picked here.
 *
 * **Nothing on this screen is model-written.** The artifact's "Comparison Intelligence" panel and
 * its synthesis-confidence bars have no counterpart in a deterministic comparison, so there is no
 * interpretation region here at all rather than an empty one. Recorded in
 * `docs/design/screens.md` §8.
 */

import Link from "next/link";
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { CandidateChoice } from "@/components/locations/candidate-choice";
import { Button, EmptyState, ErrorState, Input, LoadingState, Select } from "@/components/ui";
import { useApiClient } from "@/lib/api/context";
import type {
  ComparisonCandidate,
  ComparisonRequest,
  ComparisonResult,
  Criterion,
  Location,
  UnitSystem,
} from "@/lib/api/schema";
import { blockingReason, byRank, CRITERIA, criterionLabel, tiedRanks } from "@/lib/comparison/ranking";
import {
  baselineStanding,
  differencesBetween,
  windowMeanOf,
} from "@/lib/comparison/differences";
import { qualifiedName } from "@/lib/locations/place";
import {
  alreadyResolved,
  chosenResolution,
  resolveLocationEntry,
  resolvedLocation,
  UNRESOLVED,
  type LocationResolution,
} from "@/lib/locations/resolution";
import { calendarWindowFrom, formatReading, forecastDaysFrom } from "@/lib/dashboard/briefing";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import { ComparisonChart } from "./chart";
import { buildBaselineEntries, DecadalClimateBaseline } from "./baseline";
import { CityHero } from "./city-hero";
import { ForecastDeltaExplorer } from "./delta-explorer";
import { ComparisonIntelligence } from "./intelligence";
import { DeterministicMetrics } from "./metrics";
import {
  ClimatePulseCard,
  ComparisonSummary,
  DifferentialMatrix,
  Excluded, Ranking, SharedBasis,
} from "./sections";
import styles from "./compare.module.css";

import { FixtureCompare } from "./fixture-compare";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

/** The per-request bound the backend enforces. Shown here so the limit is not learnt by rejection. */
const MAXIMUM_LOCATIONS = 8;

/** What was asked, once it has been asked. Held apart from the form so editing does not refetch. */
interface Enquiry {
  readonly locations: readonly string[];
  readonly criterion: Criterion;
  readonly days: number;
}

/**
 * One entry in the form: what is typed, and where resolving it has got to.
 *
 * The resolution is what gates the comparison. A row is only allowed into a ranking once it holds a
 * backend-supplied `Location`, so an ambiguous or unknown name has nothing to contribute and
 * contributes nothing.
 */
interface Row {
  readonly query: string;
  readonly resolution: LocationResolution;
}

/**
 * Two rows, seeded from whatever places the person already has.
 *
 * A seeded row arrives *already resolved*: a saved location and a stored default were resolved by
 * the backend when they were saved, so asking again would be asking a question already answered —
 * and could turn a place somebody has into an ambiguity they must re-choose.
 */
function seedRows(places: readonly Location[]): Row[] {
  const rows: Row[] = places
    .slice(0, 2)
    .map((place) => ({ query: place.display_name, resolution: alreadyResolved(place) }));
  while (rows.length < 2) rows.push({ query: "", resolution: UNRESOLVED });
  return rows;
}

/**
 * One place's forecast over the shared horizon, for the delta matrix.
 *
 * A hook per place rather than one call: `POST /weather/comparison` answers with statistics over
 * the window, not a per-day series per place, so the day-by-day grid the artifact draws needs the
 * forecast endpoint the Dashboard already uses. Every cell is therefore a figure that place's own
 * provider returned.
 */
function useForecastRow(place: Location | null, days: number, units: string) {
  const query = useApiQuery({
    key: ["compare", "forecast", place?.latitude, place?.longitude, days, units],
    request: (client) =>
      client.forecast({
        latitude: place!.latitude,
        longitude: place!.longitude,
        units: units as UnitSystem,
        days,
      }),
    enabled: place !== null,
  });
  return query.state.kind === "ready" ? query.state.data : null;
}

/** One place's current conditions, for its hero card. Disabled until there is a place. */
function useCurrentRow(place: Location | null, units: string) {
  const query = useApiQuery({
    key: ["compare", "current", place?.latitude, place?.longitude, units],
    request: (client) =>
      client.current({
        latitude: place!.latitude,
        longitude: place!.longitude,
        units: units as UnitSystem,
      }),
    enabled: place !== null,
  });
  return query.state.kind === "ready" ? query.state.data : null;
}

/**
 * One place's archive baseline over the comparison's own calendar window.
 *
 * This is what turned "Decadal Climate Baseline" from an empty frame into a band with two real
 * deltas and a plot in it. The endpoint is the one Historical Analytics and the Dashboard already
 * use; the window is the comparison's own period reduced to calendar dates, so both places are
 * measured against the same days of the years behind them.
 */
function useBaselineRow(place: Location | null, window: { start: string; end: string } | null, units: string) {
  const query = useApiQuery({
    key: ["compare", "baseline", place?.latitude, place?.longitude, window, units],
    request: (client) =>
      client.baseline({
        latitude: place!.latitude,
        longitude: place!.longitude,
        units: units as UnitSystem,
        start: window!.start,
        end: window!.end,
        measure: "temperature_mean",
      }),
    enabled: place !== null && window !== null,
  });
  return query.state.kind === "ready" ? query.state.data : null;
}

/**
 * Everything the reconstructed screen draws below the ranking, from each candidate's own place.
 *
 * **Why the retrievals live here.** `POST /weather/comparison` ranks; it does not carry a current
 * reading, a per-day series or an archive baseline. The artifact's screen is built out of all
 * three, so each is fetched per compared place through the documented endpoint for it — the same
 * calls the Dashboard makes for one place, made for two. Nothing is computed in a component: the
 * differences come from `lib/comparison/differences`, which subtracts figures the backend returned.
 *
 * **Four fixed slots, because React requires the same hooks on every render.** The comparison
 * accepts up to eight places; the first four get the full treatment and the ranking above always
 * lists every one of them. The artifact is a two-city screen and two is what this is tuned for.
 */
function ComparisonBody({
  result,
  days,
}: {
  readonly result: ComparisonResult;
  readonly days: number;
}): ReactNode {
  const candidates: readonly ComparisonCandidate[] = byRank(result).slice(0, 4);
  const units = result.unit_system ?? "metric";
  const window = calendarWindowFrom(result.period);

  const forecasts = [
    useForecastRow(candidates[0]?.location ?? null, days, units),
    useForecastRow(candidates[1]?.location ?? null, days, units),
    useForecastRow(candidates[2]?.location ?? null, days, units),
    useForecastRow(candidates[3]?.location ?? null, days, units),
  ];
  const currents = [
    useCurrentRow(candidates[0]?.location ?? null, units),
    useCurrentRow(candidates[1]?.location ?? null, units),
    useCurrentRow(candidates[2]?.location ?? null, units),
    useCurrentRow(candidates[3]?.location ?? null, units),
  ];
  const baselines = [
    useBaselineRow(candidates[0]?.location ?? null, window, units),
    useBaselineRow(candidates[1]?.location ?? null, window, units),
    useBaselineRow(candidates[2]?.location ?? null, window, units),
    useBaselineRow(candidates[3]?.location ?? null, window, units),
  ];

  const shared = tiedRanks(result);

  // The day matrix: a cell per place per day, carrying the provider's own code and high.
  const rows = candidates.map((candidate, index) => {
    const daily = forecastDaysFrom(forecasts[index]?.daily);
    return {
      label: candidate.label,
      days: daily.map((day) => ({
        date: day.date,
        conditionCode: day.conditionCode,
        high: day.high ? formatReading(day.high) : null,
      })),
    };
  });
  const dates: string[] = [
    ...new Set<string>(rows.flatMap((row) => row.days.map((day) => day.date))),
  ].sort();

  // The intra-day plot, from the same forecasts. No extra retrieval.
  const pulse = candidates.map((candidate, index) => ({
    label: candidate.label,
    points: (forecasts[index]?.hourly?.entries ?? []).map((entry) => ({
      at: entry.time_utc,
      value: entry.values?.temperature ?? null,
    })),
  }));
  const pulseUnit =
    forecasts.find((forecast) => forecast?.hourly?.units?.temperature)?.hourly?.units
      ?.temperature ?? null;

  const differences = differencesBetween(candidates[0], candidates[1]);
  const standings = candidates.map((candidate, index) => ({
    label: candidate.label,
    standing: baselineStanding(windowMeanOf(candidate), baselines[index] ?? null),
  }));
  const baselineEntries = buildBaselineEntries(
    candidates.map((candidate, index) => ({
      label: candidate.label,
      baseline: baselines[index] ?? null,
      windowMean: windowMeanOf(candidate),
    })),
  );

  return (
    <>
      {/* **B — the two city hero cards**, which is what `04-compare-cities.png` opens on. */}
      <div className={styles.cityHeroes}>
        {candidates.map((candidate, index) => (
          <CityHero
            key={`${candidate.label}-${candidate.rank}`}
            candidate={candidate}
            current={currents[index] ?? null}
            sharesRank={shared.has(candidate.rank)}
          />
        ))}
      </div>

      {/*
        Named directly under the cards rather than above them: a reader who asked about three places
        and is shown two has to be told which one is missing and why, and the place to tell them is
        beside the two they did get rather than in front of them.
      */}
      <Excluded result={result} />

      {/* **C — Comparison Intelligence**, carrying the two association meters the artifact puts
          in it rather than leaving them in a band of their own. */}
      <ComparisonIntelligence result={result} />

      {/* **D — the seven-row differential matrix**, with a glyph and a temperature per cell. */}
      <ForecastDeltaExplorer rows={rows} dates={dates} />

      {/* **E — the intra-day plot, and the deterministic metrics rail beside it.** */}
      <ClimatePulseCard pulse={pulse} pulseUnit={pulseUnit}>
        <DeterministicMetrics
          differences={differences}
          leading={candidates[0]?.label ?? null}
          trailing={candidates[1]?.label ?? null}
          standings={standings}
        />
      </ClimatePulseCard>

      {/* **F — the archive baseline per place**, which used to be an empty frame. */}
      <DecadalClimateBaseline entries={baselineEntries} />

      {/*
        **G — the customer-facing close**, holding every technical surface the screen used to end
        on: the ranking with its chart and its shared basis, and the per-statistic matrix.
      */}
      <ComparisonSummary result={result}>
        <details className={styles.rankingDisclosure}>
          <summary className={styles.rankingSummary}>
            Ranking details and every figure behind it
          </summary>
          <Ranking result={result}>
            <ComparisonChart result={result} />
            <SharedBasis result={result} />
          </Ranking>
          <DifferentialMatrix result={result} />
        </details>
      </ComparisonSummary>
    </>
  );
}

function Results({ enquiry }: { readonly enquiry: Enquiry }): ReactNode {
  const request: ComparisonRequest = useMemo(
    () => ({
      criterion: enquiry.criterion,
      locations: [...enquiry.locations],
      days: enquiry.days,
    }),
    [enquiry],
  );

  const comparison = useApiQuery({
    key: ["compare", request],
    request: (client) => client.compareLocations(request),
  });

  if (comparison.state.kind === "loading") {
    return <LoadingState label="Comparing the places you named" lines={6} />;
  }
  if (comparison.state.kind === "error") {
    return <ErrorState failure={comparison.state.failure} onRetry={comparison.retry} />;
  }
  if (comparison.state.kind !== "ready") return null;

  const result = comparison.state.data;

  return (
    <div className={styles.results}>
      <ComparisonBody result={result} days={enquiry.days} />
    </div>
  );
}

export function CompareCities(): ReactNode {
  /*
   * Visual-fidelity review only.
   *
   * The flag's value is baked into the bundle at build time, so in a deployed build this comparison
   * is always false and nothing below it is reachable — but it is a *runtime* comparison against a
   * baked object rather than a folded constant, so the branch and the fixture screen do ship. See
   * `lib/fixtures/visily.ts` for what that does and does not guarantee. Nothing below changes.
   */
  if (usingVisilyFixtures()) return <FixtureCompare />;
  const preferences = useApiQuery({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });
  const saved = useApiQuery({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
  });

  const places = useMemo(() => {
    const found: Location[] = [];
    const seen = new Set<string>();
    const candidates = [
      ...(preferences.state.kind === "ready" && preferences.state.data.default_location
        ? [preferences.state.data.default_location]
        : []),
      ...(saved.state.kind === "ready"
        ? saved.state.data.locations.map((record) => record.location)
        : []),
    ];
    for (const place of candidates) {
      const key = `${place.latitude},${place.longitude}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(place);
    }
    return found;
  }, [preferences.state, saved.state]);

  const client = useApiClient();
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [criterion, setCriterion] = useState<Criterion>("warmest");
  const [days, setDays] = useState("5");
  const [enquiry, setEnquiry] = useState<Enquiry | null>(null);
  const [resolving, setResolving] = useState(false);

  const entries = rows ?? seedRows(places);
  // The client-side two-location rule, on the text — so it reads the moment a row is emptied,
  // without waiting for anything to be resolved.
  const blocked = blockingReason(entries.map((row) => row.query));
  /** Rows that have been asked about and did not settle on one place. */
  const unsettled = entries.filter(
    (row) => row.query.trim() !== "" && row.resolution.kind !== "resolved",
  );
  const awaiting = unsettled.some((row) => row.resolution.kind === "ambiguous");

  const setRow = useCallback(
    (index: number, value: string) => {
      setRows((current) => {
        const next = [...(current ?? entries)];
        const held = next[index];
        // Editing the text invalidates whatever the old text resolved to. Sending a place for a
        // name that no longer matches it is exactly the stale answer this task exists to prevent.
        const unchanged = held !== undefined && held.query === value;
        next[index] = unchanged ? held : { query: value, resolution: UNRESOLVED };
        return next;
      });
      // Any edit withdraws the results: they answered the previous set of places.
      setEnquiry(null);
    },
    [entries],
  );

  const addRow = useCallback(() => {
    setRows((current) => [...(current ?? entries), { query: "", resolution: UNRESOLVED }]);
  }, [entries]);

  const removeRow = useCallback(
    (index: number) => {
      setRows((current) => (current ?? entries).filter((_, position) => position !== index));
      setEnquiry(null);
    },
    [entries],
  );

  /** Record a candidate somebody pressed for one row. The backend's object, unchanged. */
  const chooseFor = useCallback(
    (index: number, candidate: Location) => {
      setRows((current) => {
        const next = [...(current ?? entries)];
        const held = next[index];
        if (held === undefined) return next;
        next[index] = { ...held, resolution: chosenResolution(held.query, candidate) };
        return next;
      });
    },
    [entries],
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // The client-side block. Nothing is sent, so a comparison of one never reaches the backend.
      if (blocked !== null || resolving) return;

      const current = entries;
      setResolving(true);
      // Resolve every named row that has not settled on a place. A row already holding one — seeded
      // from a saved location, or chosen from candidates — is not asked about again.
      const settled = await Promise.all(
        current.map(async (row) => {
          if (row.query.trim() === "" || row.resolution.kind === "resolved") return row;
          return { ...row, resolution: await resolveLocationEntry(client, row.query) };
        }),
      );
      setRows(settled);
      setResolving(false);

      const named = settled.filter((row) => row.query.trim() !== "");
      const places = named.map((row) => resolvedLocation(row.resolution));

      // One unsettled row stops the whole comparison, and withdraws any ranking already on screen:
      // a ranking that quietly left out the ambiguous place would be a different question's answer.
      if (places.some((place) => place === null)) {
        setEnquiry(null);
        return;
      }

      setEnquiry({
        // The canonical name of each resolved place, never the raw text.
        locations: (places as Location[]).map((place) => qualifiedName(place)),
        criterion,
        days: Number(days),
      });
    },
    [blocked, client, criterion, days, entries, resolving],
  );

  /*
   * The heading outlives the state — finding 1.1's rule, applied here on 2026-09-09 after
   * `tests/e2e/fidelity.spec.ts` photographed this screen mid-flight and found four grey lines
   * under no title at all. The frame is inline rather than extracted because this screen has
   * exactly one early return; Historical Analytics has three, which is why that one has a
   * component.
   */
  /**
   * The compact control strip `04-compare-cities.png` puts in its heading row.
   *
   * The artifact's is a single pill — a pin and a city, a swap control, a pin and a city, a rule,
   * and the window. Production's was a full-height form with a fieldset of rows, a criterion select
   * and a number field, sitting above every result on every visit; the customer-level review of
   * 2026-09-11 recorded it as one of the reasons the first viewport looked nothing like the
   * artifact's.
   *
   * So the strip states what is being compared and the form is behind it. Swap is a real action
   * here — it reorders the two entries and re-asks, which changes which place the differences are
   * subtracted *from* and therefore the sign of every figure in the metrics rail.
   */
  const swap = useCallback(() => {
    setRows((current) => {
      const next = [...(current ?? entries)];
      if (next.length < 2) return next;
      const [first, second] = [next[0]!, next[1]!];
      next[0] = second;
      next[1] = first;
      return next;
    });
    setEnquiry((current) =>
      current === null || current.locations.length < 2
        ? current
        : {
            ...current,
            locations: [current.locations[1]!, current.locations[0]!, ...current.locations.slice(2)],
          },
    );
  }, [entries]);

  const strip =
    enquiry === null ? null : (
      <div className={styles.strip}>
        <span className={styles.stripPlace}>{enquiry.locations[0]?.split(",")[0]}</span>
        {enquiry.locations.length === 2 ? (
          <button
            type="button"
            className={styles.stripSwap}
            onClick={swap}
            aria-label="Swap the two places"
            title="Swap the two places"
          >
            <span aria-hidden="true">⇄</span>
          </button>
        ) : (
          <span className={styles.stripDivider} aria-hidden="true" />
        )}
        <span className={styles.stripPlace}>
          {enquiry.locations.length === 2
            ? enquiry.locations[1]?.split(",")[0]
            : `${enquiry.locations.length - 1} more`}
        </span>
        <span className={styles.stripRule} aria-hidden="true" />
        <span className={styles.stripWindow}>
          {enquiry.days} {enquiry.days === 1 ? "day" : "days"}
        </span>
      </div>
    );

  /*
   * The heading outlives the state — finding 1.1's rule, applied here on 2026-09-09 after
   * `tests/e2e/fidelity.spec.ts` photographed this screen mid-flight and found four grey lines
   * under no title at all. The frame is inline rather than extracted because this screen has
   * exactly one early return; Historical Analytics has three, which is why that one has a
   * component.
   *
   * One row, as the artifact has it: the screen's name on the left, what is being compared on the
   * right. The subtitle is the one the accessibility suite measures for contrast, so it stays —
   * on the same baseline rather than on a line of its own.
   */
  const heading = (
    <header className={styles.heading}>
      <div className={styles.headingText}>
        <h1 className={styles.title}>Compare Cities</h1>
        <p className={styles.subtitle}>
          Two places, one window, each in its own local time.
        </p>
      </div>
      {strip}
    </header>
  );

  if (preferences.state.kind === "loading" || saved.state.kind === "loading") {
    return (
      <section className={styles.screen} aria-label="Compare Cities">
        {heading}
        <LoadingState label="Loading your locations" lines={4} />
      </section>
    );
  }

  return (
    <section className={styles.screen} aria-label="Compare Cities">
      {heading}

      {/*
        The query, folded away once there is a ranking to read — finding 4.5 of the runtime
        fidelity audit of 2026-09-08. `04-compare-cities.png` opens onto the ranking with a compact
        toolbar over it; production opened onto a full-height form with a fieldset of place rows, a
        criterion select and a number field, above every result, on every visit.

        It is the same form with the same rows, the same resolver and the same refusals, one press
        away — and it stays open in every state where it is the thing to do: before anything has
        been compared, while a row is blocking the comparison, and while an ambiguous name is
        waiting on a candidate. Collapsing over an unanswered question is finding 6.5's mistake on
        another screen and is not repeated here.
      */}
      <details
        className={styles.queryDisclosure}
        open={enquiry === null || blocked !== null || awaiting}
        data-configured={enquiry === null ? undefined : "true"}
      >
        <summary className={styles.querySummary}>
          {enquiry === null ? "Choose what to compare" : "Change comparison"}
        </summary>
        <form className={styles.controls} onSubmit={submit} aria-label="Choose what to compare">
        <fieldset className={styles.locations}>
          <legend className={styles.legend}>Locations</legend>
          {entries.map((entry, index) => (
            <div className={styles.locationEntry} key={index}>
              <div className={styles.locationRow}>
                <Input
                  label={`Location ${index + 1}`}
                  value={entry.query}
                  placeholder="A place name, for example Berlin"
                  onChange={(event) => setRow(index, event.target.value)}
                />
                {entries.length > 2 ? (
                  <Button size="sm" onClick={() => removeRow(index)}>
                    Remove location {index + 1}
                  </Button>
                ) : null}
              </div>

              {/*
                One chooser per row, so several ambiguous entries are each resolved on their own.
                Until this row holds a place, it contributes nothing to a ranking.
              */}
              <CandidateChoice
                resolution={entry.resolution}
                onChoose={(candidate) => chooseFor(index, candidate)}
                label={`Places matching location ${index + 1}`}
                busy={resolving}
              />
            </div>
          ))}
          <div className={styles.locationsAction}>
            <Button size="sm" onClick={addRow} disabled={entries.length >= MAXIMUM_LOCATIONS}>
              Add another location
            </Button>
            {places.length > 0 ? (
              <span className={styles.note}>
                Seeded from your saved locations. <Link href="/locations">Saved Locations</Link>
              </span>
            ) : null}
          </div>
        </fieldset>

        <div className={styles.criteria}>
          <Select
            label="Criterion"
            value={criterion}
            onChange={(event) => setCriterion(event.target.value as Criterion)}
            options={CRITERIA.map((value) => ({ value, label: criterionLabel(value) }))}
          />
          <Input
            label="Days ahead"
            type="number"
            min={1}
            max={16}
            value={days}
            description="The window every place is measured over."
            onChange={(event) => setDays(event.target.value)}
          />
          <div className={styles.submit}>
            <Button
              type="submit"
              variant="primary"
              busy={resolving}
              disabled={blocked !== null}
            >
              {resolving ? "Resolving…" : "Compare"}
            </Button>
          </div>
        </div>

        {blocked !== null ? (
          <p className={styles.blocked} role="status" data-blocked="true">
            {blocked}
          </p>
        ) : null}

        {/* Stated once for the form, so it is clear why no ranking appeared. */}
        {awaiting ? (
          <p className={styles.blocked} role="status" data-awaiting-choice="true">
            {unsettled.length === 1
              ? "One location matches more than one place. Choose which you meant, then compare again."
              : `${unsettled.length} locations match more than one place each. Choose which you meant, then compare again.`}
          </p>
        ) : null}
        </form>
      </details>

      {enquiry === null ? (
        <EmptyState title="Nothing compared yet">
          Name the places you want to weigh against each other, choose what &ldquo;best&rdquo; means,
          and Weathra will rank them with the figures behind each position.
        </EmptyState>
      ) : (
        <Results enquiry={enquiry} />
      )}
    </section>
  );
}
