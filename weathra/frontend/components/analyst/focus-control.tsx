"use client";

/**
 * FOCUS — the place this conversation is pointed at, as a control rather than a caption.
 *
 * `02-ai-weather-analyst.png` puts `FOCUS: BERLIN, DE` on the composer's own row, and production
 * reproduced it as text. The customer-level review of 2026-09-12 rejected the screen for what that
 * meant in practice: an account with no saved default asked "what should I expect over the next few
 * days?", the run correctly refused to guess a city, the reply said Weathra needs to know which
 * place — and the screen offered no way to tell it. The one affordance the artifact draws for
 * choosing a place was a label. The only exit was Settings, on another screen, to configure a
 * *durable default* the person may not want, in order to ask one question.
 *
 * So the caption becomes the control, and it is the same control in both places it is needed: on
 * the composer row, and inside the clarification where the missing place is the subject.
 *
 * # What it offers, and what each one is
 *
 * **Saved places, as chips.** The quickest path, and the one the review asked for by name. Pressing
 * one points the conversation at it. This is emphatically *not* the same as making it a default:
 * `agents/context.py` reads no saved-locations list precisely because saving three places expresses
 * no preference between them, and the backend picking the first would be the guess the whole
 * resolution ladder exists to refuse. Offering them as a *question* is the opposite of inferring
 * one — the person presses, so the person chose.
 *
 * **A name, resolved.** Through `useLocationResolution`, which is the same path the Dashboard, the
 * five Intelligence screens and Compare Cities take, and it is why this component holds a resolver
 * rather than a text box: what leaves here is always a canonical `Location` the backend produced.
 * An ambiguous name becomes `CandidateChoice`'s list of candidates to press, never a guess.
 *
 * **The saved default, named.** When one exists it is shown as what would apply anyway, so a person
 * can see that the conversation will use Berlin without having to set Berlin. Pressing it makes the
 * implicit explicit; not pressing it changes nothing, because the backend applies it regardless.
 *
 * **Clearing it.** Back to "wherever the question says", which is the state a new conversation
 * starts in — see the note on `New analysis` in `analyst.tsx`.
 *
 * # What it does not do
 *
 * It does not read a browser location, an IP, or an account's country, and it does not quietly
 * adopt the first saved place. Every place that leaves this component was pressed or typed.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { CandidateChoice } from "@/components/locations/candidate-choice";
import { Button, Input } from "@/components/ui";
import type { Location, SavedLocationsResponse } from "@/lib/api/schema";
import { friendlyName } from "@/lib/locations/place";
import { useApiQuery } from "@/lib/query/hooks";
import { SAVED_LOCATIONS_KEY } from "@/lib/query/keys";
import { useLocationResolution } from "@/hooks/use-location-resolution";

import styles from "./analyst.module.css";

export interface FocusControlProps {
  /** The place the conversation is pointed at, or null when it is pointed nowhere. */
  readonly focus: Location | null;
  /** The saved default, which applies when no focus is set. Null when none is configured. */
  readonly fallback: Location | null;
  /** A place to point at, or null to stop pointing anywhere. */
  readonly onChoose: (location: Location | null) => void;
  /** Disabled while a run is in flight — a focus change mid-run would describe the wrong run. */
  readonly disabled?: boolean;
  /**
   * `row` is the composer's FOCUS cell: a term, its value, and a press to change it.
   * `panel` is the clarification's, where choosing a place is the subject and the options are open
   * on arrival rather than behind a press.
   */
  readonly variant?: "row" | "panel";
  /** The heading level `CandidateChoice` should use, so the screen's headings still step by one. */
  readonly headingLevel?: 2 | 3;
}

export function FocusControl({
  focus,
  fallback,
  onChoose,
  disabled = false,
  variant = "row",
  headingLevel = 3,
}: FocusControlProps): ReactNode {
  const entry = useLocationResolution(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);

  /*
   * The saved places, read only when the chooser is actually open.
   *
   * `useApiQuery` is cached under the shared key, so a person arriving from Saved Locations spends
   * no request — but a person who never opens this spends none either, which matters on a screen
   * whose subject is the conversation. Its failure is not handled: without the list the chips are
   * absent and the name field still resolves anything, so nothing here is a dead end.
   */
  const saved = useApiQuery<SavedLocationsResponse>({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
    enabled: open || variant === "panel",
  });
  const places = saved.state.kind === "ready" ? (saved.state.data.locations ?? []) : [];

  const expanded = variant === "panel" || open;

  // Escape and an outside press close the composer's popover. The panel variant has nothing to
  // close — it is the clarification's own body — so neither applies to it.
  useEffect(() => {
    if (variant === "panel" || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPress = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPress);
    };
  }, [open, variant]);

  const adopt = useCallback(
    (location: Location | null) => {
      entry.clear();
      setQuery("");
      if (variant !== "panel") setOpen(false);
      onChoose(location);
    },
    [entry, onChoose, variant],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const settled = await entry.resolve(query);
      // Only a settled, unambiguous answer points the conversation anywhere. Ambiguous, not found
      // and failed all stay on screen as themselves, under `CandidateChoice`.
      if (settled.kind === "resolved") adopt(settled.location);
    },
    [adopt, entry, query],
  );

  const options = (
    <div className={styles.focusOptions} id={panelId}>
      {places.length > 0 ? (
        <div className={styles.focusGroup}>
          <p className={styles.focusGroupTitle} id={`${panelId}-saved`}>
            Your saved places
          </p>
          <div className={styles.focusChips} aria-labelledby={`${panelId}-saved`}>
            {places.map((record) => (
              <button
                type="button"
                key={record.id}
                className={styles.focusChip}
                disabled={disabled}
                data-current={
                  focus && record.location.display_name === focus.display_name ? "true" : undefined
                }
                onClick={() => adopt(record.location)}
              >
                {record.label?.trim() || friendlyName(record.location)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/*
        Named as what it *is* rather than as "your default": pressing it points this conversation
        at that place explicitly, which is a different fact from the preference that named it, and
        the two are told apart everywhere else on this screen.
      */}
      {fallback !== null ? (
        <div className={styles.focusGroup}>
          <button
            type="button"
            className={styles.focusChip}
            disabled={disabled}
            onClick={() => adopt(fallback)}
          >
            {friendlyName(fallback)}
            <span className={styles.focusChipNote}>your saved default</span>
          </button>
        </div>
      ) : null}

      <form className={styles.focusForm} onSubmit={submit} aria-label="Point this conversation at a place">
        <Input
          label="Another place"
          description="Resolved by Weathra. A city, or a city with its region or country."
          name="focus"
          value={query}
          placeholder="Berlin, or Springfield, Illinois"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" size="sm" busy={entry.busy} disabled={disabled || query.trim() === ""}>
          Use this place
        </Button>
      </form>

      <CandidateChoice
        headingLevel={headingLevel}
        resolution={entry.resolution}
        onChoose={adopt}
        busy={disabled}
        label="Which place did you mean?"
      />

      {focus !== null ? (
        <button
          type="button"
          className={styles.focusClear}
          disabled={disabled}
          onClick={() => adopt(null)}
        >
          Clear the focus
        </button>
      ) : null}
    </div>
  );

  if (variant === "panel") return options;

  /*
   * The composer's cell. The value doubles as the control, which is the artifact's own geometry —
   * `FOCUS  Berlin, DE` on one line — and means the thing a person reads is the thing they press.
   */
  return (
    <div className={styles.focusCell} ref={container}>
      <span className={styles.composerContextTerm}>Focus</span>
      <button
        type="button"
        className={styles.focusButton}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        data-set={focus !== null ? "true" : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {focus !== null ? (
          friendlyName(focus)
        ) : fallback !== null ? (
          <>
            {friendlyName(fallback)}
            <span className={styles.focusButtonNote}>your saved default</span>
          </>
        ) : (
          "Choose a place"
        )}
      </button>
      {expanded ? <div className={styles.focusPopover}>{options}</div> : null}
    </div>
  );
}
