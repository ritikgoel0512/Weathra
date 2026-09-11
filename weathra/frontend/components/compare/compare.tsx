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
import { blockingReason, CRITERIA, criterionLabel } from "@/lib/comparison/ranking";
import { qualifiedName } from "@/lib/locations/place";
import {
  alreadyResolved,
  chosenResolution,
  resolveLocationEntry,
  resolvedLocation,
  UNRESOLVED,
  type LocationResolution,
} from "@/lib/locations/resolution";
import { formatReading, forecastDaysFrom } from "@/lib/dashboard/briefing";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import { ComparisonChart } from "./chart";
import {
  ComparisonCharts,
  ComparisonSummary,
  DeterministicAssociation,
  DifferentialMatrix,
  ForecastDeltaExplorer,
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

/**
 * The matrix rows, built from each candidate's own forecast.
 *
 * Capped at the first four places so the grid stays a grid; the ranking above always lists them
 * all, and the artifact's matrix is two columns wide.
 */
function ForecastDeltaGrid({
  result,
  days,
}: {
  readonly result: ComparisonResult;
  readonly days: number;
}): ReactNode {
  const candidates: readonly ComparisonCandidate[] = (result.candidates ?? []).slice(0, 4);
  const units = result.unit_system ?? "metric";

  // Fixed number of hooks: React requires the same calls on every render, so four slots are asked
  // for and the unused ones are disabled rather than conditionally skipped.
  const a = useForecastRow(candidates[0]?.location ?? null, days, units);
  const b = useForecastRow(candidates[1]?.location ?? null, days, units);
  const c = useForecastRow(candidates[2]?.location ?? null, days, units);
  const d = useForecastRow(candidates[3]?.location ?? null, days, units);

  const rows: { label: string; days: { date: string; high: string | null }[] }[] = candidates.map(
    (candidate: ComparisonCandidate, index: number) => {
      const forecast = [a, b, c, d][index] ?? null;
      const daily = forecastDaysFrom(forecast?.daily);
      return {
        label: candidate.label,
        days: daily.map((day) => ({
          date: day.date,
          high: day.high ? formatReading(day.high) : null,
        })),
      };
    },
  );

  // Seven rows, as the artifact draws them, labelled by the dates any place actually reported.
  const dates: string[] = [
    ...new Set<string>(rows.flatMap((row) => row.days.map((day) => day.date))),
  ].sort();

  /*
   * The same four forecasts, as the artifact's intra-day plot.
   *
   * Built here rather than in `ComparisonCharts` because this is where the forecasts already are —
   * the matrix needs them, so drawing the plot from them costs no extra request. A place whose
   * provider returned no hourly series contributes an empty line and is filtered out by the chart.
   */
  const pulse = candidates.map((candidate: ComparisonCandidate, index: number) => {
    const forecast = [a, b, c, d][index] ?? null;
    return {
      label: candidate.label,
      points: (forecast?.hourly?.entries ?? []).map((entry) => ({
        at: entry.time_utc,
        value: entry.values?.temperature ?? null,
      })),
    };
  });
  const pulseUnit =
    [a, b, c, d].find((forecast) => forecast?.hourly?.units?.temperature)?.hourly?.units
      ?.temperature ?? null;

  return (
    <>
      <ForecastDeltaExplorer rows={rows} dates={dates} />
      <ComparisonCharts pulse={pulse} pulseUnit={pulseUnit} />
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
      {/* Named before the ranking, so a shorter answer than the question is never a surprise. */}
      <Excluded result={result} />

      <Ranking result={result}>
        <SharedBasis result={result} />
        <ComparisonChart result={result} />
      </Ranking>

      {/*
        The artifact's two bars, where the artifact puts them — directly under the comparison's own
        account of itself, above the day matrix. See `DeterministicAssociation`.
      */}
      <DeterministicAssociation result={result} />

      {/* The artifact's day-by-day matrix, from each place's own retrieved forecast. */}
      <ForecastDeltaGrid result={result} days={enquiry.days} />

      {/* The account of how the ranking was made. The two lower charts are rendered by
          `ForecastDeltaGrid` above, which is where the forecasts they are drawn from already are. */}
      <DifferentialMatrix result={result} />
      <ComparisonSummary result={result} />
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
  const heading = (
    <header className={styles.heading}>
      <h1 className={styles.title}>Compare Cities</h1>
      <p className={styles.subtitle}>
        Ranked against one criterion, over one window, in each place&rsquo;s own local time.
      </p>
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
      >
        <summary className={styles.querySummary}>
          {enquiry === null
            ? "Choose what to compare"
            : `${enquiry.locations.length} places · ranked by ${criterionLabel(
                enquiry.criterion,
              ).toLowerCase()} · ${enquiry.days} ${enquiry.days === 1 ? "day" : "days"} ahead`}
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
