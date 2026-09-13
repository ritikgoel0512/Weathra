"use client";

/**
 * The Weather Watch screen's panels, against `docs/design/screens/14-weather-watch.png`.
 *
 * The artifact is a monitoring workspace: a header carrying the engine's own status and the control
 * that adds a watch, four counters, the watched places against an active-watch rail, a threshold
 * plot against what changed, the evidence against the activity feed, a quick configuration card, a
 * disclaimer and a status strip. What was here before was a create form, a flat list, and a chart of
 * something else.
 *
 * Three rules hold across everything below.
 *
 * **Scheduled is not live.** No panel says real-time, continuous, or monitoring *now*. Every state
 * is a statement about the moment it was checked, and every one of those moments is on screen beside
 * it. A green light implying a live feed would be this screen's single most misleading pixel.
 *
 * **A null is not a no.** "The provider reported nothing" and "the retrieval failed" are drawn as
 * their own states, distinct from each other and from the condition simply not holding. Collapsing
 * them would make a silent provider look like calm weather on a screen somebody is relying on.
 *
 * **Nothing is padded.** A panel with no content says so in one line rather than filling with
 * plausible figures — and none of the artifact's invented ones appear anywhere: no confidence
 * percentage, no anomaly count, no grounding score, no recalibration, no node count.
 */

import type { ChangeEvent, FormEvent, ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import { Badge, Button, DataClassBadge, Input, Select } from "@/components/ui";
import type { Location, WatchRecord, WatchState } from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import {
  MEASURE_UNITS,
  agoOf,
  lookOf,
  placeOf,
  ruleOf,
  whenOf,
  type ActivityRow,
  type ChangeCard,
  type Counter,
  type EngineStatus,
  type PlaceCard,
  type PlotFigure,
  type StatusItem,
} from "@/lib/watch/view-model";

import { WatchIcon, type WatchIconName } from "./icons";
import styles from "./watch.module.css";

/* ------------------------------------------------------------------- region */

/** One panel of the screen, at one of the two card weights the artifact uses. */
export function Region({
  id,
  title,
  icon,
  subtitle,
  badges,
  actions,
  level = "panel",
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly icon?: WatchIconName;
  readonly subtitle?: ReactNode;
  readonly badges?: ReactNode;
  readonly actions?: ReactNode;
  readonly level?: "lead" | "panel";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={styles.region} data-level={level} aria-labelledby={id}>
      <div className={styles.regionHead}>
        <div className={styles.regionHeadings}>
          <h2 className={styles.regionTitle} id={id}>
            {icon ? (
              <span className={styles.regionIcon}>
                <WatchIcon name={icon} size={15} />
              </span>
            ) : null}
            {title}
          </h2>
          {subtitle ? <p className={styles.regionSubtitle}>{subtitle}</p> : null}
        </div>
        {badges || actions ? (
          <div className={styles.regionAside}>
            {badges}
            {actions}
          </div>
        ) : null}
      </div>
      <div className={styles.regionBody}>{children}</div>
    </section>
  );
}

/** A panel with nothing in it yet, said in one line rather than with a placeholder card. */
export function Quiet({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className={styles.quiet}>{children}</p>;
}

/* ------------------------------------------------------------------- header */

/**
 * The screen's header band, with the engine's own status and the control that adds a watch.
 *
 * The artifact puts a live status light here. What sits in that slot is the scheduled engine's
 * actual state — checking, degraded, or idle — because "scheduled" is what this is and a light
 * saying "live" would be the one claim on this screen that could get somebody hurt.
 */
export function WatchHeader({
  engine,
  lastEvaluation,
  nextEvaluation,
  onCreate,
  onRefresh,
  busy,
}: {
  readonly engine: EngineStatus;
  readonly lastEvaluation: string | null;
  readonly nextEvaluation: string | null;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly busy: boolean;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.headerKicker}>
          <DataClassBadge dataClass="analytics" />
          <span className={styles.engine} data-tone={engine.tone}>
            <span className={styles.engineDot} aria-hidden="true" />
            Watch engine: {engine.label}
          </span>
        </div>
        <h1 className={styles.title}>Weather Watch</h1>
        <p className={styles.lede}>
          Monitor important weather changes across your watched locations using scheduled evaluation
          and grounded evidence.
        </p>
        <p className={styles.headerMeta}>
          {engine.detail}
          {lastEvaluation ? ` Last checked ${whenOf(lastEvaluation)}.` : ""}
          {nextEvaluation ? ` Next ${whenOf(nextEvaluation)}.` : ""}
        </p>
      </div>

      <div className={styles.headerActions}>
        <Button variant="secondary" busy={busy} onClick={onRefresh}>
          {busy ? "Checking…" : "Check now"}
        </Button>
        <Button variant="primary" onClick={onCreate}>
          Create watch
        </Button>
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------- counters */

/** The four figures across the top. Exactly four, and every one of them counted. */
export function CounterRow({ counters }: { readonly counters: readonly Counter[] }): ReactNode {
  return (
    <ul className={styles.counters}>
      {counters.map((counter) => (
        <li className={styles.counter} key={counter.key}>
          <span className={styles.counterLabel}>{counter.label}</span>
          <span className={styles.counterValue}>{counter.value}</span>
          <span className={styles.counterNote}>{counter.note}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- watched places */

/** The state badge, with the meaning of the state behind it as a title. */
export function StateBadge({ state }: { readonly state: WatchState }): ReactNode {
  const look = lookOf(state);
  return (
    <span className={styles.state} data-tone={look.tone} title={look.meaning}>
      {look.label}
    </span>
  );
}

/** One card per watched place, carrying what that place's own last retrieval reported. */
export function WatchedPlaces({
  places,
  selectedId,
  onSelect,
  now,
}: {
  readonly places: readonly PlaceCard[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly now: Date;
}): ReactNode {
  if (places.length === 0) {
    return <Quiet>No place is being watched yet. Create a watch and its place appears here.</Quiet>;
  }

  return (
    <ul className={styles.places}>
      {places.map((place) => (
        <li key={place.id}>
          <button
            type="button"
            className={styles.place}
            data-selected={place.id === selectedId}
            aria-pressed={place.id === selectedId}
            onClick={() => onSelect(place.id)}
          >
            <span className={styles.placeHead}>
              <span className={styles.placeName}>
                <WatchIcon name="place" size={14} />
                {place.name}
              </span>
              <StateBadge state={place.state} />
            </span>

            {place.conditions.length > 0 ? (
              <span className={styles.placeConditions}>
                {place.conditions.map((condition) => (
                  <span className={styles.placeCondition} key={condition.key}>
                    <span className={styles.placeConditionLabel}>{condition.label}</span>
                    <span className={styles.placeConditionValue}>{condition.value}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className={styles.placeQuiet}>
                No reading from the last check at this place.
              </span>
            )}

            <span className={styles.placeFoot}>
              <span>
                {place.watchCount} watch{place.watchCount === 1 ? "" : "es"}
                {place.metCount > 0 ? ` · ${place.metCount} met` : ""}
              </span>
              <span>Checked {agoOf(place.checked, now)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- active watches */

/** The right-hand rail: every watch, compactly, with what it is asking and where it stands. */
export function ActiveWatches({
  watches,
  selectedId,
  onSelect,
  onToggle,
  onRemove,
  expanded,
  onExpand,
  now,
}: {
  readonly watches: readonly WatchRecord[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (watch: WatchRecord) => void;
  readonly onRemove: (watch: WatchRecord) => void;
  /** Whether all of them are shown, or only the first few. */
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly now: Date;
}): ReactNode {
  if (watches.length === 0) {
    return <Quiet>Nothing is being watched yet.</Quiet>;
  }

  const shown = expanded ? watches : watches.slice(0, 5);

  return (
    <>
      <ul className={styles.watches}>
        {shown.map((watch) => (
          <li className={styles.watch} key={watch.id} data-selected={watch.id === selectedId}>
            <button
              type="button"
              className={styles.watchMain}
              aria-pressed={watch.id === selectedId}
              onClick={() => onSelect(watch.id)}
            >
              <span className={styles.watchHead}>
                <span className={styles.watchPlace}>{placeOf(watch)}</span>
                <StateBadge state={watch.state ?? "pending"} />
              </span>
              <span className={styles.watchRule}>{ruleOf(watch)}</span>
              <span className={styles.watchMeta}>
                {watch.last_value === null || watch.last_value === undefined
                  ? "No reading"
                  : `Last ${watch.last_value}${watch.last_unit ? ` ${watch.last_unit}` : ""}`}
                {" · "}
                {agoOf(watch.last_evaluated_at, now)}
              </span>
            </button>
            <span className={styles.watchActions}>
              <Button size="sm" onClick={() => onToggle(watch)}>
                {watch.enabled ? "Pause" : "Resume"}
              </Button>
              <Button size="sm" onClick={() => onRemove(watch)}>
                Remove
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {expanded || watches.length <= 5 ? null : (
        <Button size="sm" onClick={onExpand}>
          Show all watches ({watches.length})
        </Button>
      )}
    </>
  );
}

/* ------------------------------------------------------------ plot figures */

/** Three or four real figures under the plot. No confidence among them, because there is none. */
export function PlotFigures({ figures }: { readonly figures: readonly PlotFigure[] }): ReactNode {
  if (figures.length === 0) return null;

  return (
    <dl className={styles.plotFigures}>
      {figures.map((figure) => (
        <div className={styles.plotFigure} key={figure.key}>
          <dt>{figure.label}</dt>
          <dd>
            {figure.value}
            {figure.note ? <span className={styles.plotFigureNote}>{figure.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------ what changed */

/** Up to three real differences from the previous check, or one line saying there were none. */
export function WhatChanged({
  changes,
  checked,
}: {
  readonly changes: readonly ChangeCard[];
  readonly checked: string | null;
}): ReactNode {
  if (changes.length === 0) {
    return (
      <Quiet>
        No material change since the previous evaluation
        {checked ? ` on ${whenOf(checked)}` : ""}.
      </Quiet>
    );
  }

  return (
    <ul className={styles.changes}>
      {changes.map((change) => (
        <li className={styles.change} key={change.key} data-tone={change.tone}>
          <span className={styles.changeHeading}>{change.heading}</span>
          <span className={styles.changeSummary}>{change.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ the evidence */

/**
 * Why the selected watch is where it is, in the backend's own deterministic sentence.
 *
 * The artifact puts a model-confidence percentage here. There is no model and no inference: a
 * threshold check is one comparison, so what sits in that slot is the retrieval the comparison was
 * made against — the provider, the instant in the series, and when it was fetched — which is the
 * thing a person actually needs in order to judge it.
 */
export function WatchEvidence({
  sentence,
  chips,
  onOpenEvidence,
}: {
  readonly sentence: string | null;
  readonly chips: readonly { key: string; label: string; value: string }[];
  readonly onOpenEvidence?: () => void;
}): ReactNode {
  if (sentence === null) {
    return (
      <Quiet>
        This watch has not been checked yet. Its evidence appears after the first evaluation.
      </Quiet>
    );
  }

  return (
    <div className={styles.evidence}>
      <p className={styles.evidenceSentence}>{sentence}</p>
      <ul className={styles.chips}>
        {chips.map((chip) => (
          <li className={styles.chip} key={chip.key}>
            <span className={styles.chipLabel}>{chip.label}</span>
            <span className={styles.chipValue}>{chip.value}</span>
          </li>
        ))}
      </ul>
      {onOpenEvidence ? (
        <Button size="sm" onClick={onOpenEvidence}>
          View full evidence
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the activity */

/** The recorded transitions, newest first, exactly as they were written. */
export function ActivityFeed({
  rows,
  now,
}: {
  readonly rows: readonly ActivityRow[];
  readonly now: Date;
}): ReactNode {
  if (rows.length === 0) {
    return <Quiet>Nothing has happened yet. Checks and changes are recorded here as they occur.</Quiet>;
  }

  const icons: Record<ActivityRow["icon"], WatchIconName> = {
    created: "plus",
    met: "alert",
    cleared: "stable",
    lost: "silent",
    recovered: "stable",
    moved: "trend",
    checked: "schedule",
  };

  return (
    <ul className={styles.activity}>
      {rows.map((row) => (
        <li className={styles.activityRow} key={row.id}>
          <span className={styles.activityIcon} data-kind={row.icon}>
            <WatchIcon name={icons[row.icon]} size={14} />
          </span>
          <span className={styles.activityBody}>
            <span className={styles.activityTitle}>{row.title}</span>
            <span className={styles.activityDetail}>{row.detail}</span>
          </span>
          <span className={styles.activityWhen} title={whenOf(row.at)}>
            {agoOf(row.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------- quick watch config */

export interface DraftWatch {
  readonly location: Location | null;
  readonly measure: string;
  readonly comparison: string;
  readonly threshold: string;
}

/**
 * The compact card that adds a watch: a place, a measure, a direction and a number.
 *
 * **The place control is a sibling of the form, never inside it, and that is load-bearing.** It was
 * inside once: `QuickWatchConfig` wrapped the chooser in its own `<form>`, and the chooser renders
 * one of its own. HTML has no nested form — the parser drops the inner element, the field inside it
 * ends up owned by no form at all (`input.form === null`), and pressing *Show this place* performed
 * a **native GET submit** instead of running the resolver. The browser navigated to
 * `/watch?place=London`, the page remounted, and the typed name was gone. Everything about the
 * defect was invisible to a jsdom test, because React builds that DOM with `createElement` rather
 * than through the parser, so both forms exist there and the association is fine.
 *
 * So: once a place is resolved the chooser is replaced by a summary of it, and until then the
 * chooser stands beside the form as its own element. Two sibling forms are valid; one inside
 * another is not.
 *
 * The measures offered are the ones the *backend* says it can evaluate — `watchable` comes down
 * with the dashboard rather than being listed here — so a measure this build cannot check can never
 * be offered. A watch that could only ever stay null is worse than one that cannot be created.
 */
export function QuickWatchConfig({
  draft,
  watchable,
  chooser,
  onChange,
  onSubmit,
  busy,
  failure,
}: {
  readonly draft: DraftWatch;
  readonly watchable: readonly string[];
  readonly chooser: ReactNode;
  readonly onChange: (patch: Partial<DraftWatch>) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
  readonly failure: string | null;
}): ReactNode {
  const unit = MEASURE_UNITS[draft.measure] ?? "";
  const ready = draft.location !== null && draft.threshold.trim() !== "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !busy) onSubmit();
  };

  const set =
    (key: keyof DraftWatch) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      onChange({ [key]: event.target.value } as Partial<DraftWatch>);

  return (
    <div className={styles.config}>
      {/* Outside the form below. See the note above — this is not a style choice. */}
      {draft.location === null ? (
        <div className={styles.configPlace}>{chooser}</div>
      ) : (
        <div className={styles.chosen}>
          <span className={styles.chosenLabel}>Place</span>
          <span className={styles.chosenName}>
            <WatchIcon name="place" size={14} />
            {friendlyName(draft.location)}
          </span>
          <Button size="sm" onClick={() => onChange({ location: null })}>
            Change place
          </Button>
        </div>
      )}

      <form className={styles.configForm} onSubmit={submit} aria-label="Quick watch configuration">
        <Select
          label="Measure"
          name="measure"
          value={draft.measure}
          onChange={set("measure")}
          options={watchable.map((measure) => ({
            value: measure,
            label: measureLabel(measure),
          }))}
        />

        <Select
          label="Direction"
          name="comparison"
          value={draft.comparison}
          onChange={set("comparison")}
          options={[
            { value: "above", label: "Above" },
            { value: "below", label: "Below" },
          ]}
        />

        <Input
          label={unit ? `Threshold (${unit})` : "Threshold"}
          name="threshold"
          type="number"
          step="0.1"
          inputMode="decimal"
          value={draft.threshold}
          onChange={set("threshold")}
          description="Weathra checks whether the retrieved forecast is past this number."
        />

        {failure ? (
          <p className={styles.configFailure} role="alert">
            {failure}
          </p>
        ) : null}

        <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
          {busy ? "Creating…" : "Create watch"}
        </Button>
        <p className={styles.configNote}>
          {draft.location === null
            ? "Name a place above, then Weathra checks it once straight away and afterwards on the monitoring schedule."
            : "This watch is evaluated once straight away, then on the monitoring schedule."}
        </p>
      </form>
    </div>
  );
}

/** The screen's place control, so both the header and the empty state use the same one. */
export function WatchPlaceChooser({
  location,
  onChoose,
}: {
  readonly location: Location | null;
  readonly onChoose: (location: Location | null) => void;
}): ReactNode {
  return (
    <PlaceChooser
      summary="Watch another place"
      label="Watch a place"
      description="Weathra resolves the name before it retrieves anything."
      current={location}
      usingDefault={false}
      hasDefault={false}
      onChoose={onChoose}
    />
  );
}

/* ------------------------------------------------------------- the footer */

/** What this is and, far more importantly, what it is not. */
export function MonitoringNotice({ text }: { readonly text: string }): ReactNode {
  return (
    <footer className={styles.notice}>
      <WatchIcon name="alert" size={16} />
      <div>
        <p className={styles.noticeTitle}>Analytical monitoring notice</p>
        <p className={styles.noticeText}>{text}</p>
      </div>
    </footer>
  );
}

/** The status strip: four real system facts, and no node counts. */
export function StatusStrip({ items }: { readonly items: readonly StatusItem[] }): ReactNode {
  return (
    <ul className={styles.status}>
      {items.map((item) => (
        <li className={styles.statusItem} key={item.key}>
          <span className={styles.statusLabel}>{item.label}</span>
          <span className={styles.statusValue}>{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The badge that says where a figure came from, used on the panels that carry retrieved values. */
export function ForecastBadge(): ReactNode {
  return <Badge tone="neutral">Forecast</Badge>;
}
