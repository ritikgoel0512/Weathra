"use client";

/**
 * The shared candidate chooser — task 21.7.
 *
 * One component for every location-entry surface, rather than one interaction per screen. That is
 * not only economy: `specs/web-ui` requires the *same* behaviour wherever a location is entered, and
 * three separate implementations of "present the candidates and show nothing until one is chosen"
 * is three places for it to drift.
 *
 * **It renders the four answers as four different things.** Several places is a question with the
 * candidates as its answers. No place is a validation state — and never a nearest match, which
 * `specs/location-resolution` forbids. A failed request is a failure with the backend's own message
 * and a retry, because "Weathra could not ask" is not "that city does not exist". A pending request
 * says so. `data-location-state` carries the kind, so which of the four a screen is in is a
 * property a test asserts rather than a sentence it matches.
 *
 * **Every candidate is a real button.** Not a listbox, not a div with a click handler: a button is
 * reachable with Tab and activated with Enter or Space on every platform, which is what
 * `specs/web-ui` means by operable by keyboard alone. Choosing is one press — there is no separate
 * confirm, because a second press to apply a choice already made is a second thing to forget.
 *
 * **Nothing is preselected.** No candidate is marked default, focused, or otherwise nudged. The
 * first result is the one a geocoder ranks highest and it is exactly the one Weathra must not pick
 * on somebody's behalf.
 *
 * **Every field shown came out of the response.** `candidateDetail` lists only what the backend
 * supplied; a candidate with no region and no country shows its coordinates and its timezone and no
 * placeholder where the rest would go.
 */

import type { ReactNode } from "react";

import { Button, ErrorState } from "@/components/ui";
import type { Location } from "@/lib/api/schema";
import { candidateDetail, candidateKey, type LocationResolution } from "@/lib/locations/resolution";

import styles from "./candidate-choice.module.css";

/**
 * The heading the ambiguous state always carries, so the requirement to choose is stated.
 *
 * A real heading, at the level the calling screen passes — see `headingLevel`. It was a styled
 * paragraph until task 21.8's manual pass: it looked like a heading, was named
 * `CHOICE_REQUIRED_TITLE`, carried `styles.title`, and this comment already called it one, while
 * the markup said otherwise. Somebody navigating by heading therefore could not reach the question
 * asking them to choose — the one thing this panel exists to ask.
 */
export const CHOICE_REQUIRED_TITLE = "Which place did you mean?";

/** Said in the ambiguous state, so it is clear why nothing is shown yet. */
export const CHOICE_REQUIRED_NOTE =
  "Weathra will not choose for you, and shows no data until you pick one.";

/** Names the group of candidates when a screen does not name it more specifically. */
export const CANDIDATE_GROUP_LABEL = "Matching places";

export interface CandidateChoiceProps {
  /**
   * The level for "Which place did you mean?", so the heading list of the screen *around* this
   * panel still descends one level at a time.
   *
   * Two by default, which is right for the two screens that place the chooser directly under their
   * `h1` — the Dashboard and Compare Cities. Saved Locations passes three, because there the chooser
   * sits inside the "Add a location" panel, which is itself an `h2`.
   *
   * The same shape as `ProvenanceSection`'s `headingLevel`, and for the same reason: correction 2 of
   * `docs/design/accessibility.md` was a primitive that hard-coded `h3` and so skipped a level on
   * every screen that used it unnested. A fixed level here would have reintroduced exactly that —
   * `h1` straight to `h3` on the Dashboard and on Compare Cities.
   */
  readonly headingLevel?: 2 | 3;
  readonly resolution: LocationResolution;
  /** Called with the candidate the person pressed — the backend's own object, unchanged. */
  readonly onChoose: (location: Location) => void;
  /** Re-runs the resolution. Offered only where a retry could plausibly help. */
  readonly onRetry?: () => void;
  /** Disables the candidates while something the choice would start is already in flight. */
  readonly busy?: boolean;
  /** Names the group for a screen reader, so several on one screen are told apart. */
  readonly label?: string;
}

export function CandidateChoice({
  resolution,
  onChoose,
  onRetry,
  busy = false,
  label,
  headingLevel = 2,
}: CandidateChoiceProps): ReactNode {
  if (resolution.kind === "unresolved" || resolution.kind === "resolved") return null;

  if (resolution.kind === "resolving") {
    return (
      <div
        className={`${styles.panel} ${styles.panelPlain}`}
        data-location-state="resolving"
        role="status"
      >
        <p className={styles.note}>Resolving &ldquo;{resolution.query}&rdquo;…</p>
      </div>
    );
  }

  if (resolution.kind === "not-found") {
    return (
      <div className={styles.panel} data-location-state="not-found" role="alert">
        <p className={styles.title}>No place matches that name</p>
        {/* The backend's own message. Weathra substitutes no nearest or partial match. */}
        <p className={styles.message}>{resolution.message}</p>
        <p className={styles.note}>
          Try a different spelling, or add a region or country — for example
          &ldquo;Springfield, Illinois&rdquo;.
        </p>
      </div>
    );
  }

  if (resolution.kind === "failed") {
    return (
      <div data-location-state="failed">
        <ErrorState
          failure={resolution.failure}
          title="That location could not be looked up"
          onRetry={onRetry}
        />
      </div>
    );
  }

  const groupLabel = label ?? CANDIDATE_GROUP_LABEL;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <div className={styles.panel} data-location-state="ambiguous">
      {/*
        `styles.title` keeps the appearance the approved artifact specifies, and keeps it identical
        at either level: it declares the family, size, line height, weight and colour itself, and a
        class outranks the element selectors in `globals.css` that would otherwise size an `h3`
        differently from an `h2`. Both headings and paragraphs are `margin: 0` there, and this panel
        spaces its children with `gap`, so nothing moves either.
      */}
      <Heading className={styles.title}>{CHOICE_REQUIRED_TITLE}</Heading>
      {/* The backend's own sentence, which names the query and the places it matched. */}
      <p className={styles.message} role="status">
        {resolution.message}
      </p>
      <p className={styles.note}>{CHOICE_REQUIRED_NOTE}</p>

      <fieldset className={styles.candidates}>
        <legend className={styles.legend}>{groupLabel}</legend>
        {resolution.candidates.map((candidate) => (
          <button
            key={candidateKey(candidate)}
            className={styles.candidate}
            type="button"
            disabled={busy}
            data-candidate={candidateKey(candidate)}
            onClick={() => onChoose(candidate)}
          >
            <span className={styles.candidateName}>{candidate.display_name}</span>
            {candidateDetail(candidate).map((detail) => (
              <span className={styles.candidateDetail} key={detail}>
                {detail}
              </span>
            ))}
          </button>
        ))}
      </fieldset>

      {onRetry ? (
        <div>
          <Button size="sm" variant="ghost" onClick={onRetry} disabled={busy}>
            Look up a different name
          </Button>
        </div>
      ) : null}
    </div>
  );
}
