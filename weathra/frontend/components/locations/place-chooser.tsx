"use client";

/**
 * The on-screen way to change the place an Intelligence screen is about.
 *
 * # Why every Intelligence screen needs one
 *
 * The five Intelligence screens — Forecast Explorer, Weather Intelligence Report, Weather Scenario
 * Lab, Weather Watch and Travel Intelligence — each opened on the default location from
 * `/me/preferences` and offered no way to look at anywhere else. With no default set, each one
 * rendered an empty state and a link to Settings: a customer who signed up and pressed *Forecast
 * Explorer* got a sentence and a link where the artifact has a screen. The feature was reachable
 * only by first configuring a preference on a different screen, which is a configuration step
 * standing in front of a product.
 *
 * The Dashboard already solved this — it can brief on a named place — and the machinery was already
 * general: `useLocationResolution` for the request, `CandidateChoice` for an ambiguous answer. What
 * was missing was one control wrapping them, so this is it, and the five screens use it rather than
 * each growing their own.
 *
 * # What it guarantees
 *
 * **A typed name never becomes a weather request.** The name goes to `/locations/resolve`, and what
 * comes back out of this component is always a canonical `Location` the backend produced — with an
 * ambiguous answer becoming a list of candidates to press rather than a guess. That is the same
 * rule the Dashboard and Compare Cities already hold, and the reason this wraps the resolver
 * instead of exposing a text field to each screen.
 *
 * **It folds away once there is something to read.** `01-dashboard.png` opens on the hero, not on
 * a form, and finding 1.7 of the 2026-09-08 audit was production opening onto a form above the
 * fold on every visit. So the disclosure is closed when the screen has a place, and open in the
 * three states where using it is the thing to do: no place at all, a name still settling, and a
 * place that was named rather than defaulted — because "back to my default" lives inside it, and a
 * way out that is hidden is not a way out.
 *
 * **It is not a search box for saved places.** It resolves names, which is a different action from
 * picking a saved location, and conflating them would put two lists of places on one screen with
 * no way to tell which one a press was about.
 */

import { useCallback, useState, type ReactNode } from "react";

import { CandidateChoice } from "@/components/locations/candidate-choice";
import { Button, Input } from "@/components/ui";
import type { Location } from "@/lib/api/schema";
import { friendlyName } from "@/lib/locations/place";
import { useLocationResolution } from "@/hooks/use-location-resolution";

import styles from "./place-chooser.module.css";

export interface PlaceChooserProps {
  /** The control's own wording — "Explore another place", "Report on another place". */
  readonly summary: string;
  /** The field's label. Names the action, because the summary is already the disclosure. */
  readonly label: string;
  /** One line under the field saying what pressing it does. */
  readonly description: string;
  /**
   * The place the screen is currently about, or null when it has none.
   *
   * Null forces the disclosure open: a screen with nothing to show must not hide the one control
   * that would give it something.
   */
  readonly current: Location | null;
  /** True when `current` came from the person's preferences rather than from this control. */
  readonly usingDefault: boolean;
  /** Whether a default exists at all, which is what decides if "back to my default" is offered. */
  readonly hasDefault: boolean;
  /** A canonical location to adopt, or null meaning "back to my default". */
  readonly onChoose: (location: Location | null) => void;
  /** The heading level for the candidate list, so the screen's headings still step by one. */
  readonly headingLevel?: 2 | 3;
}

export function PlaceChooser({
  summary,
  label,
  description,
  current,
  usingDefault,
  hasDefault,
  onChoose,
  headingLevel = 2,
}: PlaceChooserProps): ReactNode {
  const entry = useLocationResolution(null);
  const [query, setQuery] = useState("");

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const settled = await entry.resolve(query);
      // Only a settled, unambiguous answer adopts a place. Everything else — ambiguous, not found,
      // failed — stays on screen as itself, which is what `CandidateChoice` renders below.
      if (settled.kind === "resolved") onChoose(settled.location);
    },
    [entry, onChoose, query],
  );

  const choose = useCallback(
    (candidate: Location) => {
      entry.choose(candidate);
      onChoose(candidate);
    },
    [entry, onChoose],
  );

  const toDefault = useCallback(() => {
    entry.clear();
    setQuery("");
    onChoose(null);
  }, [entry, onChoose]);

  const settling = entry.resolution.kind !== "unresolved" && entry.resolution.kind !== "resolved";
  const open = current === null || settling || !usingDefault;

  /**
   * Whether this screen has no place at all — which makes the chooser the screen's subject rather
   * than an adjustment to it.
   *
   * A disclosure is the wrong shape twice over here. Its summary says "another place" to somebody
   * who has had none, and even held open it presents the only thing to do on the screen as an
   * aside. So with no place the frame is dropped and the form is a titled panel; with a place it
   * folds away exactly as before, which is finding 1.7's requirement and unchanged.
   */
  const introducing = current === null;

  const body = (
    <>
      <form className={styles.form} onSubmit={submit} aria-label={label}>
        <div className={styles.field}>
          <Input
            label={label}
            description={description}
            name="place"
            value={query}
            placeholder="A city, or a city and its region or country"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className={styles.actions}>
          <Button
            type="submit"
            variant="primary"
            busy={entry.busy}
            disabled={query.trim() === ""}
          >
            {entry.busy ? "Resolving…" : "Show this place"}
          </Button>
          {/*
            Offered only when there is a default to go back to and we are not already on it.
            Without the first condition it would be a control that does nothing, which on a screen
            with no default is the one press a person would definitely try.
          */}
          {hasDefault && !usingDefault ? (
            <Button size="sm" onClick={toDefault}>
              Back to my default location
            </Button>
          ) : null}
        </div>
      </form>

      {current !== null && !usingDefault ? (
        <p className={styles.showing}>Showing {friendlyName(current)}.</p>
      ) : null}

      <CandidateChoice
        headingLevel={headingLevel}
        resolution={entry.resolution}
        onChoose={choose}
        label="Places matching what you entered"
      />
    </>
  );

  if (introducing) {
    /*
     * No `aria-label` naming it, and no repeat of the field's own label above the field: the
     * heading here says what the panel is *for*, and the control inside it already says what it
     * does. Naming both "Explore a place" put the same name on two nested elements, which is one
     * name too many for anybody navigating by them.
     */
    return (
      <section className={styles.panel}>
        <p className={styles.panelTitle}>Choose a place to begin</p>
        {body}
      </section>
    );
  }

  return (
    <details className={styles.disclosure} open={open}>
      {/*
        One wording in every state. Each screen already says which place it is about, and a summary
        that repeated it would put the same sentence on the screen twice — finding 2.3's mistake on
        the Analyst.
      */}
      <summary className={styles.summary}>{summary}</summary>
      {body}
    </details>
  );
}
