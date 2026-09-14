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


import { PLACE_PARAM } from "@/components/shell/top-bar";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
} from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type {
  Location,
  SavedLocationRecord,
  SavedLocationsOverview,
} from "@/lib/api/schema";
import {
  attentionFrom,
  cardsFrom,
  comparisonFrom,
  filterCards,
  overviewFactsFrom,
  overviewSummaryFrom,
  usageFrom,
  usageShare,
  type WorkspaceCard,
} from "@/lib/locations/workspace";

import {
  AttentionStrip,
  LocationComparison,
  MultiLocationOverview,
  Panel,
  PlaceCard,
  UsageStrip,
  WorkspaceHeader,
} from "./workspace";
import {
  friendlyName,
  sendableName,
} from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import {
  PREFERENCES_KEY,
  SAVED_LOCATIONS_KEY,
  SAVED_LOCATIONS_OVERVIEW_KEY,
} from "@/lib/query/keys";
import { useLocationResolution } from "@/hooks/use-location-resolution";

import { CandidateChoice } from "./candidate-choice";
import styles from "./locations.module.css";
import workspace from "./workspace.module.css";

import { FixtureLocations } from "./fixture-locations";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

function AddLocation({
  atLimit,
  limit,
  startOpen = false,
}: {
  readonly atLimit: boolean;
  readonly limit: number;
  /** True when the list is empty, so adding is the only thing this screen offers. */
  readonly startOpen?: boolean;
}): ReactNode {
  const [place, setPlace] = useState("");
  const [label, setLabel] = useState("");
  const entry = useLocationResolution(null);

  const add = useApiMutation<{ location: Location; label: string | null }, SavedLocationRecord>({
    // The resolved name *and* its coordinates. The coordinates were always sent, so an ambiguity
    // cannot reappear — they say which candidate this is. The name was not, and without it the
    // backend had nothing to store but the point: Open-Meteo does no reverse geocoding, so a
    // coordinates-only save was written as "48.1374, 11.5755" where `specs/memory` requires the
    // canonical name. The backend re-resolves the name and uses the pair only to choose among what
    // the provider returned, so nothing here asserts what a place is called.
    run: (client, input) =>
      client.saveLocation({
        // The name only when the place has one that is not its own coordinates — sending that as a
        // name asks the backend to geocode a city that does not exist, which is a bug this line
        // has already had once.
        ...(sendableName(input.location) === null
          ? {}
          : { location: sendableName(input.location) as string }),
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        label: input.label,
      }),
    // The saved list, and the default-location choices Settings offers from it.
    invalidates: [SAVED_LOCATIONS_KEY, SAVED_LOCATIONS_OVERVIEW_KEY, PREFERENCES_KEY],
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
  const savedPlaceName = saved?.location ? friendlyName(saved.location) : null;

  return (
    /*
      A disclosure rather than a permanent form. `06-saved-locations.png` puts a single "Add New
      Node" control in the header and gives the page to the saved places; a full form open at the
      top made adding — the rarer action — the subject of the screen.
    */
    <form className={styles.panel} onSubmit={onSubmit} aria-label="Add a saved location">
      {/*
        Open when there is nothing else on the screen.
        *
        The disclosure is right for a list of saved places: adding is the rarer action, and
        `06-saved-locations.png` gives the page to the places. It is wrong for an account with none,
        where the runtime audit of 2026-09-08 photographed an empty state whose instruction — "save
        a place above" — pointed at a collapsed control. The only thing to do on that screen should
        not be folded shut.
      */}
      <details open={startOpen}>
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
  return <SavedLocationsWorkspace />;
}

/**
 * The workspace — `docs/design/screens/06-saved-locations.png`.
 *
 *     1  header, with search and Add location                       full width
 *     2  attention, only where something is actually wrong          full width
 *     3  the saved places, as weather cards                         responsive grid
 *     4  multi-location overview      ·  location comparison        70 / 30
 *     5  saved location usage                                       full width
 *
 * **One read feeds every panel.** `GET /me/locations/overview` returns the saved places, the
 * current conditions at each, the comparison across them and which want attention — together. The
 * screen before this issued one `GET /weather/current` *per card* from inside the card component,
 * so opening it cost a provider call per saved place per render, and the comparison panel had no
 * way to see any of those answers.
 *
 * **The allowance is a strip, not the subject.** It used to be the largest panel on the page — a
 * quota readout above the weather, on a screen whose question is what the weather is doing.
 */
function SavedLocationsWorkspace(): ReactNode {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const router = useRouter();

  /*
   * One clock for the whole screen, so no two cards date their readings from different instants,
   * and a page left open stops claiming a reading was taken "just now" an hour later.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { state, retry } = useApiQuery<SavedLocationsOverview>({
    key: SAVED_LOCATIONS_OVERVIEW_KEY,
    request: (client) => client.savedLocationsOverview(),
    // An empty list is a normal first day, not a failure.
    isEmpty: (data) => (data.places ?? []).length === 0,
  });

  /** The place whose removal is in flight, so only that card's confirm control reports busy. */
  const [removingId, setRemovingId] = useState<string | null>(null);

  const remove = useApiMutation<string, void>({
    run: (client, savedId) => client.removeSavedLocation(savedId),
    invalidates: [SAVED_LOCATIONS_OVERVIEW_KEY, SAVED_LOCATIONS_KEY, PREFERENCES_KEY],
    onDone: () => setRemovingId(null),
  });

  const overview = state.kind === "ready" ? state.data : null;
  const cards = overview ? cardsFrom(overview) : [];
  const shown = filterCards(cards, query);
  const comparison = overview?.comparison ?? null;
  const sideBySide = overview ? comparisonFrom(cards, overview) : null;

  const open = (card: WorkspaceCard) => {
    const place = (overview?.places ?? []).find((entry) => entry.saved_id === card.savedId);
    const name = place ? sendableName(place.location) : null;
    router.push(name ? `/?${PLACE_PARAM}=${encodeURIComponent(name)}` : "/");
  };

  return (
    <section className={styles.screen} aria-label="Saved Locations">
      <WorkspaceHeader
        query={query}
        onQuery={setQuery}
        onAdd={() => setAdding(true)}
        saved={overview?.summary.saved_count ?? 0}
        limit={overview?.summary.limit ?? 0}
        atLimit={overview !== null && overview.summary.remaining === 0}
      />

      <AttentionStrip items={overview ? attentionFrom(overview) : []} />

      {/* The add form is available whatever state the read is in: a failed list is not a reason to
          stop somebody saving a place. */}
      {adding || state.kind === "empty" ? (
        <AddLocation
          atLimit={overview !== null && overview.summary.remaining === 0}
          limit={overview?.summary.limit ?? 0}
          startOpen
        />
      ) : null}

      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => (
          /* Skeletons at the card's own size, so nothing jumps when the readings arrive. */
          <ul className={workspace.cards} aria-busy="true">
            {[0, 1, 2].map((index) => (
              <li className={workspace.cardSkeleton} key={index}>
                <Skeleton height="var(--space-7)" />
              </li>
            ))}
          </ul>
        )}
        empty={() => (
          <EmptyState title="Save your first location">
            Keep the places you care about available across Weathra — on the Dashboard, in Compare
            Cities, in Historical Analytics and as a place to watch.
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
            {/*
              A removal that failed says so. Without this the card simply stayed, which reads as a
              confirmation that did nothing rather than as a backend that refused.
            */}
            {remove.state.kind === "error" ? (
              <ErrorState failure={remove.state.failure} title="That location was not removed" />
            ) : null}
            {shown.length === 0 ? (
              <p className={styles.note}>
                No saved location matches &ldquo;{query}&rdquo;. This searches the places you have
                saved; use Add location to save somewhere new.
              </p>
            ) : (
              <ul className={workspace.cards} data-count={shown.length}>
                {shown.map((card) => (
                  <PlaceCard
                    card={card}
                    key={card.savedId}
                    now={now}
                    onOpen={() => open(card)}
                    onCompare={() => router.push("/compare")}
                    onRemove={() => {
                      setRemovingId(card.savedId);
                      remove.submit(card.savedId);
                    }}
                    removing={remove.busy && removingId === card.savedId}
                  />
                ))}
              </ul>
            )}

            <div className={workspace.body}>
              <Panel
                id="locations-overview"
                title="Multi-location overview"
                icon="grid"
                level="lead"
                subtitle="Computed by Weathra from the readings above. No language model is involved."
              >
                <MultiLocationOverview
                  facts={overviewFactsFrom(comparison)}
                  summary={overviewSummaryFrom(comparison)}
                  single={cards[0] ?? null}
                />
              </Panel>

              <Panel id="locations-comparison" title="Location comparison" icon="compare">
                <LocationComparison
                  view={sideBySide}
                  onCompare={() => router.push("/compare")}
                  onAdd={() => setAdding(true)}
                />
              </Panel>
            </div>

            <UsageStrip figures={usageFrom(data)} share={usageShare(data)} />
          </>
        )}
      />
    </section>
  );
}
