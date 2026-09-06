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

import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, EmptyState, ErrorState, Input, LoadingState } from "@/components/ui";
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
    <form className={styles.panel} onSubmit={onSubmit} aria-label="Add a saved location">
      <h2 className={styles.panelTitle}>Add a location</h2>
      <p className={styles.note}>
        Weathra resolves the name and saves the place it resolves to — its coordinates and time zone
        — so a saved location never changes meaning later. Add a region or country if a name could
        mean more than one place.
      </p>

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

export function SavedLocations(): ReactNode {
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
          The places you have saved. They follow you across sessions and devices, and every screen
          that asks for a location offers them.
        </p>
      </header>

      {/* The add form is available whatever state the list is in: a failed read is not a reason to
          stop somebody saving a place. */}
      <AddLocation
        atLimit={response !== null && response.count >= response.limit}
        limit={response?.limit ?? 0}
      />

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
        ready={(data) => <SavedList response={data} />}
      />
    </section>
  );
}
