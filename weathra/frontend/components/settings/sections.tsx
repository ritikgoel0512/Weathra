"use client";

/**
 * Settings' surfaces — task 21.6, against `docs/design/screens/07-settings.png`.
 *
 * The artifact's General tab establishes the shape each preference row takes: a titled group on the
 * left, its controls on the right, each control named and described, and one action bar for the
 * whole form. That shape is reproduced. What sits *in* it is only what the durable preference store
 * actually holds — `specs/memory` names the unit system, the forecast horizon and the default
 * location, and the backend's `PreferenceUpdate` has a field for each and for nothing else.
 *
 * Three rules the components below exist to enforce:
 *
 * **A default is labelled a default.** The backend reports, per field, whether the person chose the
 * value or Weathra assumed it, and every row says which. A value shown identically either way tells
 * somebody they made a decision they never made.
 *
 * **Nothing reads as saved until the backend has said so.** The action bar's state comes from the
 * mutation, and its `saved` branch is reachable only from a resolved response carrying the new
 * preferences. A failed save says so and leaves the person's edits in the form.
 *
 * **The three account operations stay three operations.** Signing out ends a session. Deleting a
 * conversation removes that conversation's memory. Deleting your Weathra data removes your records.
 * They are separate controls with separate wording, because a person who wanted one of them would
 * be badly served by getting another.
 */

import Link from "next/link";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, EmptyState, ErrorState, LoadingState, Select, formatInstant } from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type {
  DeletionResponse,
  MeResponse,
  PreferenceSource,
  PreferenceUpdate,
  PreferenceView,
  SavedLocationsResponse,
  ThreadSummary,
  ThreadsResponse,
  UnitSystem,
} from "@/lib/api/schema";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY, THREADS_KEY } from "@/lib/query/keys";
import { placeKey } from "@/lib/locations/place";
import {
  UNIT_OPTIONS,
  choiceFor,
  defaultLocationChoices,
  draftFrom,
  horizonChoicesFor,
  horizonError,
  horizonLabel,
  PREFERENCE_SOURCE_RULE,
  sourceNote,
  sourceOf,
  updateFrom,
  type PreferenceDraft,
} from "@/lib/settings/preferences";

import { ConfirmAction } from "./confirm";
import styles from "./settings.module.css";

/* ---------------------------------------------------------------------- layout */

/**
 * A field's source, printed only when there is something to say.
 *
 * `sourceNote` returns `null` for a value the person chose — the form's opening line already says
 * that is the ordinary case — so this renders nothing rather than an empty paragraph.
 */
export function SourceNote({ source }: { readonly source: PreferenceSource | null }): ReactNode {
  const note = sourceNote(source);
  return note === null ? null : <p className={styles.note}>{note}</p>;
}

/** One titled group of settings: the artifact's two-column row. */
export function SettingGroup({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={styles.group} aria-label={title}>
      <div className={styles.groupHeading}>
        <h2 className={styles.groupTitle}>{title}</h2>
        <p className={styles.note}>{description}</p>
      </div>
      <div className={styles.groupBody}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ the units */

/** The artifact's METRIC / IMPERIAL pair, as one radio group. */
function UnitChoice({
  value,
  onChange,
  disabled,
}: {
  readonly value: UnitSystem;
  readonly onChange: (units: UnitSystem) => void;
  readonly disabled: boolean;
}): ReactNode {
  const chosen = UNIT_OPTIONS.find((option) => option.value === value);

  return (
    <fieldset className={styles.choices}>
      <legend className={styles.legend}>Measurement units</legend>
      {/*
        `07-settings.png` draws this as one segmented control, not as a row of separate chips, and
        that is what the wrapper below produces. The controls underneath are still two real radio
        inputs in a real fieldset: a segmented control built from buttons would lose the group
        semantics, the arrow-key selection the browser gives a radio group for free, and the
        `checked` state assistive technology reads. The inputs are positioned out of sight rather
        than `display: none`, so they keep taking focus and the ring is drawn on the segment.
      */}
      <div className={styles.segmented}>
        {UNIT_OPTIONS.map((option) => (
          <label className={styles.segment} key={option.value}>
            <input
              type="radio"
              name="unit_system"
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span className={styles.segmentLabel}>{option.label}</span>
          </label>
        ))}
      </div>
      {/*
        The detail the chips used to carry inline. It stays on the screen — which units a system
        means is the only thing that makes the choice meaningful — but under the control, where the
        artifact puts its own description, rather than inside a segment.
      */}
      {chosen ? <p className={styles.choiceDetail}>{chosen.detail}</p> : null}
    </fieldset>
  );
}

/* --------------------------------------------------------------- the form */

export interface PreferenceFormProps {
  readonly view: PreferenceView;
  readonly saved: SavedLocationsResponse | null;
}

/**
 * The General tab: the three durable preferences, and one action bar over them.
 *
 * The default location is chosen from the person's saved locations rather than typed. A saved
 * location is already canonical — the backend resolved it when it was saved — so choosing one can
 * never be ambiguous, where re-typing a name could be. The value sent is that location's canonical
 * name, which the backend resolves back to the same place before storing it.
 */
export function PreferenceForm({ view, saved }: PreferenceFormProps): ReactNode {
  const [draft, setDraft] = useState<PreferenceDraft>(() => draftFrom(view));

  const save = useApiMutation<PreferenceUpdate, PreferenceView>({
    run: (client, update) => client.updatePreferences(update),
    // Every screen reading the same preferences: the Dashboard's briefing, Historical Analytics and
    // Compare Cities all key their read here, so imperial units reach them without a reload.
    invalidates: [PREFERENCES_KEY],
    onDone: (next) => setDraft(draftFrom(next)),
  });

  const reset = useApiMutation<void, PreferenceView>({
    run: (client) => client.resetPreferences(),
    invalidates: [PREFERENCES_KEY],
    onDone: (next) => setDraft(draftFrom(next)),
  });

  const busy = save.busy || reset.busy;
  const update = updateFrom(draft, view);
  const invalidHorizon = horizonError(draft.horizonDays);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Nothing changed is not a save: no request, and nothing reported as recorded.
      if (update === null || invalidHorizon !== null || busy) return;
      save.submit(update);
    },
    [busy, invalidHorizon, save, update],
  );

  const locationChoices = defaultLocationChoices(
    (saved?.locations ?? []).map((record) => record.location),
    view.default_location,
  );

  return (
    <form onSubmit={onSubmit} aria-label="Your Weathra preferences">
      {/*
        Stated once, at the top, rather than repeated under every control. See
        `PREFERENCE_SOURCE_RULE`: it is what makes an unmarked control readable as the person's own
        choice, and it is the half of finding 7.3's fix that keeps the guarantee intact.
      */}
      <p className={styles.note}>{PREFERENCE_SOURCE_RULE}</p>

      <SettingGroup
        title="Weather preferences"
        description="How Weathra presents meteorological data across every screen."
      >
        <div className={styles.setting}>
          <UnitChoice
            value={draft.unitSystem}
            disabled={busy}
            onChange={(unitSystem) => setDraft((current) => ({ ...current, unitSystem }))}
          />
          <p className={styles.note}>
            Applied to every figure Weathra shows, by asking the backend for that unit system — the
            browser converts nothing. {sourceNote(sourceOf(view, "unit_system")) ?? ""}
          </p>
        </div>

        <div className={styles.setting}>
          <div className={styles.field}>
            <Select
              label="Default forecast horizon"
              description="The number of days the Dashboard and the forecast surfaces open on."
              name="forecast_horizon_days"
              value={String(draft.horizonDays)}
              disabled={busy}
              error={invalidHorizon ?? undefined}
              options={horizonChoicesFor(view.forecast_horizon_days).map((days) => ({
                value: String(days),
                label: horizonLabel(days),
              }))}
              onChange={(event) =>
                setDraft((current) => ({ ...current, horizonDays: Number(event.target.value) }))
              }
            />
          </div>
          <SourceNote source={sourceOf(view, "forecast_horizon_days")} />
        </div>
      </SettingGroup>

      <SettingGroup
        title="Location preferences"
        description="The place Weathra opens on when you have not chosen another."
      >
        <div className={styles.setting}>
          <div className={styles.field}>
            <Select
              label="Default location"
              description="Chosen from the places you have saved, so it is never ambiguous."
              name="default_location"
              value={draft.defaultLocation ? placeKey(draft.defaultLocation) : ""}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  // The option's value is a place key, so the location itself comes back out of
                  // the choices rather than being reconstructed from the label a person read.
                  defaultLocation: choiceFor(locationChoices, event.target.value),
                }))
              }
            >
              <option value="">No default location</option>
              {locationChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </div>
          <SourceNote source={sourceOf(view, "default_location")} />
          {locationChoices.length === 0 ? (
            <p className={styles.note}>
              You have saved no locations yet.{" "}
              <Link href="/locations">Save one in Saved Locations</Link> and it can become your
              default.
            </p>
          ) : null}
        </div>
      </SettingGroup>

      <div className={styles.actionBar}>
        <p className={styles.noteStrong} role="status" data-preferences-state="true">
          {save.state.kind === "saving" || reset.state.kind === "saving"
            ? "Saving your preferences…"
            : save.state.kind === "saved"
              ? "Your preferences are saved."
              : reset.state.kind === "saved"
                ? "Your preferences are cleared. Weathra's documented defaults now apply."
                : update === null
                  ? "No unsaved changes."
                  : "You have unsaved changes."}
        </p>

        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={update === null || busy}
            onClick={() => setDraft(draftFrom(view))}
          >
            Discard changes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            busy={reset.busy}
            disabled={save.busy}
            onClick={() => reset.submit()}
          >
            Reset to defaults
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={save.busy}
            disabled={update === null || invalidHorizon !== null || reset.busy}
          >
            Save preferences
          </Button>
        </div>
      </div>

      {save.state.kind === "error" ? (
        <ErrorState failure={save.state.failure} title="Your preferences were not saved" />
      ) : null}
      {reset.state.kind === "error" ? (
        <ErrorState failure={reset.state.failure} title="Your preferences were not cleared" />
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------- account */

/**
 * Who is signed in, and the sign-out control.
 *
 * The email is echoed from the validated token by `/api/v1/me` — Weathra stores no contact detail
 * of its own — and the Supabase Auth subject is deliberately not shown: it identifies the account
 * to the system, not to the person, and putting it on screen would be disclosure with no use.
 *
 * The sign-out control is the existing one from task 20.9, passed in already rendered because it is
 * a server action and this is a client component. There is exactly one sign-out in Weathra.
 */
export function AccountIdentity({
  signOutControl,
}: {
  readonly signOutControl?: ReactNode;
}): ReactNode {
  const { state, retry } = useApiQuery<MeResponse>({
    key: ["me"],
    request: (client) => client.me(),
  });

  return (
    <section className={styles.panel} aria-label="Your account">
      <h2 className={styles.panelTitle}>Your account</h2>

      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => <LoadingState label="Loading your account" lines={2} />}
        empty={() => <p className={styles.note}>Weathra could not read your account.</p>}
        error={(failure, again) => (
          <ErrorState failure={failure} title="Your account could not be loaded" onRetry={again} />
        )}
        ready={(me) => (
          <dl className={styles.facts}>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Signed in as</dt>
              <dd className={styles.factValue}>{me.email ?? "not reported by your session"}</dd>
            </div>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Weathra profile created</dt>
              <dd className={styles.factValue}>
                {formatInstant(me.profile_created_at) ?? "not reported"}
              </dd>
            </div>
          </dl>
        )}
      />

      <p className={styles.note}>
        Your sign-in itself is managed by Supabase Auth. Signing out ends your session on every
        device; it removes nothing.
      </p>

      {signOutControl}
    </section>
  );
}

/* -------------------------------------------------------- conversation memory */

function ThreadRow({
  thread,
  onDelete,
  deleting,
  disabled,
}: {
  readonly thread: ThreadSummary;
  readonly onDelete: (thread: ThreadSummary) => void;
  readonly deleting: boolean;
  readonly disabled: boolean;
}): ReactNode {
  const name = thread.title?.trim() || "Untitled conversation";

  return (
    <li className={styles.thread} data-thread={thread.id}>
      <span className={styles.threadTitle}>{name}</span>
      <p className={styles.note}>
        Last active {formatInstant(thread.last_activity_at) ?? "not reported"} · removed
        automatically after {formatInstant(thread.expires_at) ?? "not reported"}
      </p>
      {(thread.locations ?? []).length > 0 ? (
        <p className={styles.note}>Places established: {(thread.locations ?? []).join(", ")}</p>
      ) : null}

      <ConfirmAction
        trigger="Delete this conversation"
        title={`Delete the memory of “${name}”?`}
        confirmLabel="Delete this conversation's memory"
        busy={deleting}
        onConfirm={() => {
          if (disabled) return;
          onDelete(thread);
        }}
      >
        <p>
          Its turns, the places it established and its stored context are removed, so follow-up
          questions can no longer resolve against it. Your saved locations and preferences are
          untouched, and this does not sign you out.
        </p>
      </ConfirmAction>
    </li>
  );
}

/**
 * Conversation memory, and deleting it — with a confirmation step.
 *
 * This is short-term memory: the LangGraph thread a follow-up question resolves against. Deleting
 * one removes that conversation's turns and its checkpoints, and touches nothing durable. The
 * distinction matters enough that the confirmation panel states it.
 */
export function ConversationMemory(): ReactNode {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { state, retry } = useApiQuery<ThreadsResponse>({
    key: THREADS_KEY,
    request: (client) => client.threads(),
    isEmpty: (data) => data.threads.length === 0,
  });

  const remove = useApiMutation<string, void>({
    run: (client, threadId) => client.deleteThread(threadId),
    invalidates: [THREADS_KEY],
    onDone: () => setDeletingId(null),
  });

  const onDelete = useCallback(
    (thread: ThreadSummary) => {
      if (remove.busy) return;
      setDeletingId(thread.id);
      remove.submit(thread.id);
    },
    [remove],
  );

  return (
    <section className={styles.panel} aria-label="Conversation memory">
      <h2 className={styles.panelTitle}>Conversation memory</h2>
      <p className={styles.body}>
        Each conversation with the AI Weather Analyst keeps its turns so a follow-up question can
        resolve against them. Weathra removes them on its own after a bounded period; you can remove
        one now. This is not the same as signing out, and it deletes nothing durable.
      </p>

      {remove.state.kind === "saved" ? (
        <p className={styles.noteStrong} role="status">
          That conversation&rsquo;s memory has been deleted.
        </p>
      ) : null}
      {remove.state.kind === "error" ? (
        <ErrorState failure={remove.state.failure} title="That conversation was not deleted" />
      ) : null}

      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => <LoadingState label="Loading your conversations" lines={2} />}
        empty={() => (
          <EmptyState title="You have no stored conversations">
            Ask the AI Weather Analyst a question and its thread will appear here.
          </EmptyState>
        )}
        error={(failure, again) => (
          <ErrorState
            failure={failure}
            title="Your conversations could not be loaded"
            onRetry={again}
          />
        )}
        ready={(data) => (
          <ul className={styles.threads}>
            {data.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onDelete={onDelete}
                deleting={remove.busy && deletingId === thread.id}
                disabled={remove.busy}
              />
            ))}
          </ul>
        )}
      />
    </section>
  );
}

/* ------------------------------------------------------------ account deletion */

/** The word somebody types to confirm the one action that cannot be undone. */
export const DELETE_CONFIRMATION = "DELETE";

/**
 * Deleting the person's Weathra data — with an explicit confirmation step.
 *
 * The backend removes their saved locations, preferences, threads and memory, and stored agent
 * runs, and returns a count per table. Those counts are what is shown afterwards, because "your
 * data was deleted" is not checkable and "3 saved locations, 2 threads, 5 runs" is.
 *
 * Nothing is simulated here. The panel reports the state of one request and then the backend's own
 * report, and every cached read of the removed data is invalidated so no screen keeps showing it.
 */
export function DeleteAccountData({
  signOutControl,
}: {
  readonly signOutControl?: ReactNode;
}): ReactNode {
  const remove = useApiMutation<void, DeletionResponse>({
    run: (client) => client.deleteMyData(),
    invalidates: [PREFERENCES_KEY, SAVED_LOCATIONS_KEY, THREADS_KEY, ["me"]],
  });

  const report = remove.state.kind === "saved" ? remove.state.data : null;

  return (
    <section
      className={`${styles.panel} ${styles.panelDanger}`}
      aria-label="Delete your Weathra data"
    >
      <div className={styles.actions}>
        <h2 className={styles.panelTitle}>Delete your Weathra data</h2>
        <Badge tone="error">Cannot be undone</Badge>
      </div>

      <p className={styles.body}>
        This removes every Weathra record belonging to you: your saved locations, your preferences,
        your conversations and their memory, and your stored agent runs. Weathra&rsquo;s shared
        knowledge base and its location-keyed forecast snapshots are not personal data and are
        unaffected.
      </p>

      {report === null ? (
        <ConfirmAction
          trigger="Delete my Weathra data"
          title="Delete every Weathra record belonging to you?"
          confirmLabel="Delete my Weathra data permanently"
          typedConfirmation={DELETE_CONFIRMATION}
          busy={remove.busy}
          onConfirm={() => remove.submit()}
        >
          <p>
            Your saved locations, preferences, conversations and their memory, and your stored agent
            runs are removed permanently. This cannot be undone and Weathra keeps no copy.
          </p>
          <p>
            Your sign-in is not deleted: Supabase Auth owns your account, and you will still be able
            to sign in to an empty Weathra.
          </p>
        </ConfirmAction>
      ) : (
        <div role="status" data-deletion-report="true">
          <p className={styles.noteStrong}>Your Weathra data has been deleted.</p>
          <dl className={styles.facts}>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Saved locations</dt>
              <dd className={styles.factValue}>{report.removed.saved_locations}</dd>
            </div>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Preferences</dt>
              <dd className={styles.factValue}>{report.removed.preferences}</dd>
            </div>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Conversations</dt>
              <dd className={styles.factValue}>{report.removed.threads}</dd>
            </div>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Stored agent runs</dt>
              <dd className={styles.factValue}>{report.removed.agent_runs}</dd>
            </div>
            <div className={styles.factRow}>
              <dt className={styles.factTerm}>Records removed in total</dt>
              <dd className={styles.factValue}>{report.total}</dd>
            </div>
          </dl>
          {/* The backend's own sentence about what it deliberately did not remove. */}
          <p className={styles.note}>{report.note}</p>
          {signOutControl}
        </div>
      )}

      {remove.state.kind === "error" ? (
        <ErrorState failure={remove.state.failure} title="Your data was not deleted" />
      ) : null}
    </section>
  );
}
