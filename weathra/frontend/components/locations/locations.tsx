"use client";

/**
 * Saved Locations — task 21.6.
 *
 * The places a person has saved, and adding or removing one. Three protected endpoints and nothing
 * else: `GET`, `POST` and `DELETE` on `/api/v1/me/locations`, each scoped by the backend to the
 * token's subject with Row Level Security behind it. There is no second store, no local list, and
 * nothing in `localStorage` — a saved location that lived in a browser would not follow the person
 * to another device, which is precisely what `specs/web-ui` requires of it.
 *
 * **A name is resolved before anything is saved.** Task 21.7 made that a step of its own: pressing
 * Save asks `GET /api/v1/locations/resolve` — the one geocoder Weathra has, behind the backend — and
 * only a place that came back resolved is saved, by its coordinates. A name matching several places
 * presents those candidates and saves nothing until one is pressed; a name matching none says so
 * and saves nothing. Free text is never stored, and this screen picks no candidate on anybody's
 * behalf.
 *
 * **Nothing is reported as saved until the backend says so.** The add and remove controls report
 * `saving` while a request is in flight and `saved` only from a resolved response, and the list is
 * re-read from the server rather than patched locally. A duplicate save and a save at the limit both
 * come back from the backend as what they are.
 *
 * **The filter is a filter.** It narrows what is already on screen. It issues no request, resolves
 * nothing, and never hides the fact that the list itself is longer.
 *
 * Built against `docs/design/screens/06-saved-locations.png`; the divergences are in
 * `docs/design/screens.md` §5 and §8.
 */

import Link from "next/link";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Meter } from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type { Location, SavedLocationRecord, SavedLocationsResponse } from "@/lib/api/schema";
import {
  coordinatesOf,
  matchesFilter,
  qualifiedName,
  savedLocationLabel,
} from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";
import { useLocationResolution } from "@/hooks/use-location-resolution";

import { CandidateChoice } from "./candidate-choice";
import styles from "./locations.module.css";

import { FixtureLocations } from "./fixture-locations";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

/** One saved place: what it is called, where it is, and how to remove it. */
function LocationCard({
  record,
  onRemove,
  removing,
  disabled,
}: {
  readonly record: SavedLocationRecord;
  readonly onRemove: (record: SavedLocationRecord) => void;
  readonly removing: boolean;
  readonly disabled: boolean;
}): ReactNode {
  const canonical = qualifiedName(record.location);
  const name = savedLocationLabel(record);

  return (
    <li className={styles.card} data-saved-location={record.id}>
      <span className={styles.cardName}>{name}</span>
      {/* The person's label never replaces the canonical name — it sits above it. */}
      {name === canonical ? null : <span className={styles.cardCanonical}>{canonical}</span>}

      <dl className={styles.cardFacts}>
        <div className={styles.cardRow}>
          <dt className={styles.cardTerm}>Coordinates</dt>
          <dd className={styles.cardValue}>{coordinatesOf(record.location)}</dd>
        </div>
        <div className={styles.cardRow}>
          <dt className={styles.cardTerm}>Time zone</dt>
          <dd className={styles.cardValue}>{record.location.timezone}</dd>
        </div>
      </dl>

      <div className={styles.cardActions}>
        <Button
          variant="danger"
          size="sm"
          busy={removing}
          disabled={disabled && !removing}
          onClick={() => onRemove(record)}
        >
          {removing ? "Removing…" : `Remove ${name}`}
        </Button>
      </div>
    </li>
  );
}

/**
 * The add form: a place name, an optional label of the person's own, and two steps.
 *
 * Resolve, then save. The two are separate because they answer different questions and because
 * `specs/web-ui` requires the first to be *presented* when it has several answers. Nothing is
 * saved from an ambiguous or unknown name, and what is saved is the candidate's coordinates — the
 * canonical point the backend returned — rather than any string.
 */
function AddLocation({ atLimit, limit }: { readonly atLimit: boolean; readonly limit: number }): ReactNode {
  const [place, setPlace] = useState("");
  const [label, setLabel] = useState("");
  const entry = useLocationResolution(null);

  const add = useApiMutation<{ location: Location; label: string | null }, SavedLocationRecord>({
    // By coordinates, so the backend stores the place it already resolved rather than resolving a
    // name a second time — which is the step where an ambiguity could reappear.
    run: (client, input) =>
      client.saveLocation({
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        label: input.label,
      }),
    // The saved list, and the default-location choices Settings offers from it.
    invalidates: [SAVED_LOCATIONS_KEY, PREFERENCES_KEY],
    onDone: () => {
      setPlace("");
      setLabel("");
      entry.clear();
    },
  });

  const save = useCallback(
    (location: Location) => {
      if (add.busy) return;
      add.submit({ location, label: label.trim() || null });
    },
    [add, label],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const wanted = place.trim();
      // An empty name is not a request. Nothing is resolved and nothing is saved.
      if (wanted === "" || entry.busy || add.busy) return;

      void (async () => {
        const settled = await entry.resolve(wanted);
        // One match: saved straight away. Several: the candidates are presented and this returns
        // without saving anything. None, or a failure: likewise.
        if (settled.kind === "resolved") save(settled.location);
      })();
    },
    [add.busy, entry, place, save],
  );

  const saved = add.state.kind === "saved" ? add.state.data : null;
  const savedPlaceName = saved?.location ? qualifiedName(saved.location) : null;

  return (
    /*
      A disclosure rather than a permanent form. `06-saved-locations.png` puts a single "Add New
      Node" control in the header and gives the page to the saved places; a full form open at the
      top made adding — the rarer action — the subject of the screen.
    */
    <form className={styles.panel} onSubmit={onSubmit} aria-label="Add a saved location">
      <details>
      {/*
        The heading lives inside the summary rather than being replaced by it. The disclosure moved
        the form out of the page's flow, and for a moment took the panel's `h2` with it — which left
        the candidate chooser's `h3` following the screen's `h1` directly, a heading-order break that
        `tests/accessibility.test.tsx` caught. The control is the summary; the heading is still a
        heading.
      */}
      <summary className={styles.addSummary}>
        <h2 className={styles.panelTitle}>Add a location</h2>
      </summary>
      <div className={styles.addBody}>
      <p className={styles.note}>Resolved before saving. Add a region if a name is ambiguous.</p>

      <div className={styles.toolbar}>
        <div className={styles.toolbarField}>
          <Input
            label="Place"
            name="place"
            value={place}
            placeholder="A city, or a city and its country"
            autoComplete="off"
            onChange={(event) => setPlace(event.target.value)}
          />
        </div>
        <div className={styles.toolbarField}>
          <Input
            label="Your name for it (optional)"
            name="label"
            value={label}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          busy={entry.busy || add.busy}
          disabled={place.trim() === ""}
        >
          {entry.busy ? "Resolving…" : add.busy ? "Saving…" : "Save location"}
        </Button>
      </div>

      {/*
        Several places, none, or a lookup that failed — three different answers, three different
        states, and nothing saved by any of them. Choosing a candidate saves that candidate.
      */}
      <CandidateChoice
        resolution={entry.resolution}
        onChoose={save}
        busy={add.busy}
        label="Places matching what you entered"
        // Inside this screen's own "Add a location" panel, which is an h2, so the question is a
        // third-level heading here. The Dashboard and Compare Cities place it under their h1 and
        // take the default of two.
        headingLevel={3}
      />

      </div>
      </details>
      {atLimit ? (
        <p className={styles.noteStrong}>
          You have reached Weathra&rsquo;s limit of {limit} saved locations. Remove one to save
          another.
        </p>
      ) : null}

      {/*
        Only ever after the backend confirmed the write, and only naming the place when the
        response actually carried one — the confirmation reads the record back rather than
        restating what was sent, so it must survive a response that is not shaped as expected
        instead of taking the screen down with it.
      */}
      {saved ? (
        <p className={styles.noteStrong} role="status">
          {savedPlaceName === null
            ? "Saved."
            : saved.created_now === false
              ? `${savedPlaceName} was already saved; its label is updated.`
              : `Saved ${savedPlaceName}.`}
        </p>
      ) : null}

      {add.state.kind === "error" ? (
        // The backend's own message: an unresolvable name, a name matching several places with
        // those places listed, or the saved-location limit with its number.
        <ErrorState failure={add.state.failure} title="That location was not saved" />
      ) : null}
    </form>
  );
}

/** The list, its filter, and the remove control on each card. */
function SavedList({ response }: { readonly response: SavedLocationsResponse }): ReactNode {
  const [filter, setFilter] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  const remove = useApiMutation<string, void>({
    run: (client, savedId) => client.removeSavedLocation(savedId),
    invalidates: [SAVED_LOCATIONS_KEY, PREFERENCES_KEY],
    onDone: () => setRemovingId(null),
  });

  const onRemove = useCallback(
    (record: SavedLocationRecord) => {
      if (remove.busy) return;
      setRemovingId(record.id);
      remove.submit(record.id);
    },
    [remove],
  );

  const shown = response.locations.filter((record) => matchesFilter(record, filter));

  return (
    <section className={styles.panel} aria-label="Your saved locations">
      <div className={styles.toolbar}>
        <h2 className={styles.panelTitle}>Your saved locations</h2>
        <div className={styles.badgeRow}>
          <Badge tone="neutral">
            {response.count} of {response.limit}
          </Badge>
        </div>
      </div>

      <div className={styles.filterField}>
        <Input
          label="Filter these locations"
          description="Narrows the list below. It searches nothing new."
          name="filter"
          type="search"
          value={filter}
          autoComplete="off"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {remove.state.kind === "error" ? (
        <ErrorState failure={remove.state.failure} title="That location was not removed" />
      ) : null}

      {shown.length === 0 ? (
        <p className={styles.note} role="status">
          {response.count === 0
            ? "You have saved no locations yet."
            : `None of your ${response.count} saved locations match “${filter.trim()}”.`}
        </p>
      ) : (
        <ul className={styles.grid}>
          {shown.map((record) => (
            <LocationCard
              key={record.id}
              record={record}
              onRemove={onRemove}
              removing={remove.busy && removingId === record.id}
              disabled={remove.busy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}


/* ------------------------------------------------------- the workspace panels */

/**
 * The lower panels of `06-saved-locations.png`: a synthesis panel, a comparison panel, and a live
 * metadata block, over a status rule.
 *
 * The artifact fills them with "Global Vector Analysis", grounding-health percentages and a node
 * count. None of those is a figure any endpoint produces, and inventing a health score for a list
 * of place names would be a claim about nothing. What the panels carry instead is arithmetic over
 * the records themselves — how many places, how many distinct time zones, how many countries —
 * which is deterministic, checkable, and genuinely what a "workspace synthesis" of a saved list is.
 *
 * The comparison panel is a real route rather than a summary: Compare Cities is the screen that
 * weighs saved places against each other, and it already seeds itself from this list.
 */
function WorkspacePanels({ response }: { readonly response: SavedLocationsResponse }): ReactNode {
  const records = response.locations;
  const resolved = records.filter(
    (record) => record.location.timezone && Number.isFinite(record.location.latitude),
  ).length;
  const zones = new Set(records.map((record) => record.location.timezone).filter(Boolean));
  const countries = new Set(
    records.map((record) => record.location.country).filter((value): value is string => !!value),
  );
  const remaining = Math.max(0, response.limit - response.count);

  return (
    <>
      <section className={styles.panel} aria-label="Node health index">
        <h2 className={styles.panelTitle}>Node health index</h2>
        <p className={styles.note}>Counted from the records above, not measured.</p>
        <div className={styles.summary}>
          <Meter
            label="Nodes resolved"
            value={records.length > 0 ? resolved / records.length : null}
            unavailable="Nothing saved"
            note={`${resolved} of ${records.length} carry coordinates and a time zone.`}
          />
          <Meter
            label="Allowance used"
            value={response.limit > 0 ? response.count / response.limit : null}
            unavailable="No limit reported"
            note={`${response.count} of ${response.limit} places.`}
          />
          <Meter
            label="Telemetry sync"
            value={null}
            unavailable="Not measured"
            note="Weathra reports no per-node telemetry."
          />
        </div>
      </section>

      <div className={styles.panelRow}>
        <section className={styles.panel} aria-label="Workspace summary">
          <h2 className={styles.panelTitle}>Workspace summary</h2>
          <p className={styles.note}>
            Counted from the places above, not from any measurement.
          </p>
          <dl className={styles.summary}>
            <div className={styles.summaryFact}>
              <dt>Places saved</dt>
              <dd>{response.count}</dd>
            </div>
            <div className={styles.summaryFact}>
              <dt>Time zones</dt>
              <dd>{zones.size}</dd>
            </div>
            <div className={styles.summaryFact}>
              <dt>Countries</dt>
              <dd>{countries.size > 0 ? countries.size : "Not reported"}</dd>
            </div>
            <div className={styles.summaryFact}>
              <dt>Remaining</dt>
              <dd>{remaining}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.panel} aria-label="Compare these cities">
          <h2 className={styles.panelTitle}>Compare these cities</h2>
          <p className={styles.note}>
            Compare Cities weighs saved places against one criterion over the same window, in each
            place&rsquo;s own local time, and seeds itself from this list.
          </p>
          <p className={styles.note}>
            {records.length >= 2
              ? "You have enough places saved to compare."
              : "Save at least two places to compare them."}
          </p>
          <div className={styles.actions}>
            <Link className={styles.panelAction} href="/compare">
              Open Compare Cities
            </Link>
          </div>
        </section>
      </div>

      <section className={styles.panel} aria-label="Live metadata">
        <h2 className={styles.panelTitle}>Live metadata</h2>
        <dl className={styles.summary}>
          <div className={styles.summaryFact}>
            <dt>Places</dt>
            <dd>{response.count}</dd>
          </div>
          <div className={styles.summaryFact}>
            <dt>Allowance</dt>
            <dd>{response.limit}</dd>
          </div>
          <div className={styles.summaryFact}>
            <dt>Source</dt>
            <dd>Your account</dd>
          </div>
          <div className={styles.summaryFact}>
            <dt>Latency</dt>
            {/* No endpoint reports one, and the artifact's "42ms" is mockup content. */}
            <dd>Not reported</dd>
          </div>
        </dl>
      </section>

      <p className={styles.statusStrip}>
        <span>Saved list from your account</span>
        <span>
          {response.count} of {response.limit} places
        </span>
        <span>Follows you across sessions and devices</span>
      </p>
    </>
  );
}

export function SavedLocations(): ReactNode {
  /*
   * Visual-fidelity review only.
   *
   * The flag's value is baked into the bundle at build time, so in a deployed build this comparison
   * is always false and nothing below it is reachable — but it is a *runtime* comparison against a
   * baked object rather than a folded constant, so the branch and the fixture screen do ship. See
   * `lib/fixtures/visily.ts` for what that does and does not guarantee. Nothing below changes.
   */
  if (usingVisilyFixtures()) return <FixtureLocations />;
  const { state, retry } = useApiQuery<SavedLocationsResponse>({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
    // An empty list is a normal first day, not a failure — and never rendered as though it were a
    // populated answer.
    isEmpty: (data) => data.locations.length === 0,
  });

  const response = state.kind === "ready" ? state.data : null;

  return (
    <section className={styles.screen} aria-label="Saved Locations">
      <header className={styles.heading}>
        <h1 className={styles.title}>Saved Locations</h1>
        <p className={styles.subtitle}>
          Offered by every screen that asks for a location. Follows you across devices.
        </p>
      </header>

      {/* The add form is available whatever state the list is in: a failed read is not a reason to
          stop somebody saving a place. */}
      <AddLocation
        atLimit={response !== null && response.count >= response.limit}
        limit={response?.limit ?? 0}
      />

      {/*
        The artifact's attention strip. It carries a real condition when there is one — the saved
        allowance running out is the only one this screen can know about — and says so plainly when
        there is not, rather than inventing an atmospheric alert to fill the row.
      */}
      {response ? (
        <p
          className={styles.attention}
          data-tone={response.count >= response.limit ? "warning" : "ok"}
          role="status"
        >
          <span className={styles.attentionTitle}>
            {response.count >= response.limit ? "Allowance reached" : "All nodes nominal"}
          </span>
          <span>
            {response.count >= response.limit
              ? `You have ${response.count} of ${response.limit} places saved. Remove one to save another.`
              : `${response.count} of ${response.limit} places saved. No attention required.`}
          </span>
        </p>
      ) : null}

      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => <LoadingState label="Loading your saved locations" lines={4} />}
        empty={() => (
          <EmptyState title="You have not saved any locations yet">
            Save a place above and it will appear here, and as a choice on the Dashboard, Historical
            Analytics and Compare Cities.
          </EmptyState>
        )}
        error={(failure, again) => (
          <ErrorState
            failure={failure}
            title="Your saved locations could not be loaded"
            onRetry={again}
          />
        )}
        ready={(data) => (
          <>
            <SavedList response={data} />
            <WorkspacePanels response={data} />
          </>
        )}
      />
    </section>
  );
}
