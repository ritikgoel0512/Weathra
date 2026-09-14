"use client";

/**
 * Weather Watch — `docs/design/screens/14-weather-watch.png`.
 *
 * A persistent multi-location monitoring workspace: state a condition at a place, and Weathra checks
 * it on a schedule, records what it found, and shows what changed between checks.
 *
 * **The artifact's macro composition, and it is the composition rather than a resemblance to it.**
 *
 *     1  header, with the engine's own status and CREATE WATCH        full width
 *     2  four counters                                                full width
 *     3  watched locations            ·  active watches               70 / 30
 *     4  temporal watch analysis      ·  what changed?                70 / 30
 *     5  watch evidence               ·  activity feed                70 / 30
 *     6  how monitoring works         ·  quick watch config           70 / 30
 *     7  analytical monitoring notice                                 full width
 *     8  status strip                                                 full width
 *
 * **One read feeds every panel.** `GET /me/watch-dashboard` returns the summary, the watched places,
 * every watch, the selected watch's series and evidence, and the recent activity together, and
 * `lib/watch/view-model.ts` reads all of it once. Five panels each fetching their own version of the
 * same data is how two panels come to disagree about whether a condition is met.
 *
 * **Reading the screen evaluates nothing.** The dashboard returns what the scheduled pass and the
 * explicit refreshes have already recorded. Opening a monitoring page must not cost a provider call
 * per watch, or looking at the monitoring would cost more than the monitoring.
 *
 * **It is scheduled and it says so, everywhere.** The word "live" appears nowhere on this screen and
 * neither does "real-time". A watch was checked at a moment, will be checked again at another, and
 * both are named. Weathra sends no alerts of any kind, which the notice at the bottom states in the
 * backend's own sentence rather than in one this file wrote.
 *
 * **What the artifact draws and Weathra does not have:** 96.4% inference confidence, 82 anomalies,
 * 98.4% grounding, model recalibration, a pressure-anomaly tier, 124 active nodes, a compliance
 * lock, and an emergency alert channel. Each has a real equivalent here or no tile at all.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { ErrorState, LoadingState } from "@/components/ui";
import { useLocationResolution } from "@/hooks/use-location-resolution";
import type { WatchDashboard, WatchRecord } from "@/lib/api/schema";
import { measureLabel } from "@/lib/dashboard/briefing";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import {
  activityFrom,
  changeCardsFrom,
  countersFrom,
  engineStatusFrom,
  placeCardsFrom,
  placeOf,
  plotFiguresFrom,
  ruleOf,
  statusStripFrom,
  thresholdPointsFrom,
  whenOf,
} from "@/lib/watch/view-model";

import { TemporalWatchChart } from "./chart";
import {
  ActiveWatches,
  ActivityFeed,
  CounterRow,
  MonitoringNotice,
  PlotFigures,
  QuickWatchConfig,
  Quiet,
  Region,
  StatusStrip,
  StateBadge,
  WatchEvidence,
  WatchHeader,
  WatchPlaceChooser,
  WatchedPlaces,
  type DraftWatch,
} from "./sections";
import styles from "./watch.module.css";

const DASHBOARD_KEY = ["me", "watch-dashboard"] as const;

const EMPTY_DRAFT: DraftWatch = {
  location: null,
  measure: "temperature",
  comparison: "above",
  threshold: "",
};

export function WeatherWatch(): ReactNode {
  /** Which watch the detail panels are about. Null means "let the backend choose". */
  const [selected, setSelected] = useState<string | null>(null);
  /** The watch whose removal is in flight, so only that row's confirm control reports busy. */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftWatch>(EMPTY_DRAFT);
  const [expanded, setExpanded] = useState(false);

  /*
   * A place named in the URL.
   *
   * `?place=London` has to work on a cold load — a bookmark, a shared link, a reload — so it is
   * resolved here rather than carried in React state from wherever it was typed. It goes through
   * the same resolver the chooser uses and adopts only a *canonical* answer: an ambiguous or
   * unfound name leaves the chooser exactly as it would be if nobody had typed anything, rather
   * than silently becoming some other city.
   *
   * Once only, keyed on the parameter. Re-resolving on every render would spend a request per
   * keystroke elsewhere on the screen, and re-resolving after somebody pressed *Change place* would
   * drag them back to the place in the URL.
   */
  const named = useSearchParams().get("place")?.trim() ?? "";
  const lookup = useLocationResolution(null);
  const hydrated = useRef<string | null>(null);
  const adopt = lookup.resolve;

  useEffect(() => {
    if (named === "" || hydrated.current === named) return;
    hydrated.current = named;
    void adopt(named).then((settled) => {
      if (settled.kind === "resolved") {
        setDraft((current) => ({ ...current, location: settled.location }));
      }
    });
  }, [named, adopt]);

  /*
   * One clock for the whole screen.
   *
   * Every "12 min ago" and every countdown is derived from this, so no two rows can be relative to
   * different instants — and it ticks rather than being read at render, because a monitoring screen
   * left open would otherwise keep saying "2 min ago" an hour later.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const dashboard = useApiQuery<WatchDashboard>({
    key: [...DASHBOARD_KEY, selected ?? ""],
    request: (client) => client.watchDashboard(selected ?? undefined),
  });

  const create = useApiMutation<DraftWatch, WatchRecord>({
    run: (client, input) =>
      client.createWatch({
        /*
         * The name *and* the coordinates, which together are what makes the stored place readable.
         *
         * Sending coordinates alone looked sufficient — they identify the point exactly — and it is
         * what produced a production watch labelled `51.5085, -0.1257` on every surface. Open-Meteo
         * has no reverse geocoding, so a save by coordinates names the point after itself, and that
         * coordinate string became the canonical `display_name` in the row every screen reads.
         *
         * `resolve_for_saving` is built for the pair: it resolves the *name* server-side and uses
         * the coordinates only to pick which of that name's candidates was meant. So the name
         * supplies the identity, the pair pins the choice, and a client still cannot assert a place
         * the provider does not know.
         */
        location: input.location?.display_name,
        latitude: input.location?.latitude,
        longitude: input.location?.longitude,
        measure: input.measure as WatchRecord["measure"],
        comparison: input.comparison,
        threshold: Number(input.threshold),
      }),
    invalidates: [[...DASHBOARD_KEY]],
    onDone: (record) => {
      // The new watch is already evaluated — creation checks it once — so selecting it puts real
      // evidence on screen immediately rather than an empty detail panel.
      setSelected(record.id);
      setDraft(EMPTY_DRAFT);
    },
  });

  const refresh = useApiMutation<void, unknown>({
    run: (client) => client.watches(true),
    invalidates: [[...DASHBOARD_KEY]],
  });

  const edit = useApiMutation<{ id: string; enabled: boolean }, WatchRecord>({
    run: (client, input) => client.updateWatch(input.id, { enabled: input.enabled }),
    invalidates: [[...DASHBOARD_KEY]],
  });

  const remove = useApiMutation<string, void>({
    run: (client, id) => client.removeWatch(id),
    invalidates: [[...DASHBOARD_KEY]],
    onDone: () => {
      setSelected(null);
      setRemovingId(null);
    },
  });

  if (dashboard.state.kind === "loading") {
    return <LoadingState label="Reading your watches" lines={6} />;
  }
  if (dashboard.state.kind === "error") {
    return <ErrorState failure={dashboard.state.failure} onRetry={dashboard.retry} />;
  }
  if (dashboard.state.kind !== "ready") return null;

  const data = dashboard.state.data;
  const watches = data.watches ?? [];
  const detail = data.selected ?? null;
  const engine = engineStatusFrom(data);
  const places = placeCardsFrom(data);
  const busy = refresh.busy || edit.busy || remove.busy;

  const chooser = (
    <WatchPlaceChooser
      location={draft.location}
      onChoose={(location) => setDraft((current) => ({ ...current, location }))}
    />
  );

  const config = (
    <QuickWatchConfig
      draft={draft}
      watchable={data.watchable ?? []}
      chooser={chooser}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onSubmit={() => create.submit(draft)}
      busy={create.busy}
      failure={create.state.kind === "error" ? create.state.failure.message : null}
    />
  );

  /* With no watch at all, the screen is the one thing there is to do. */
  if (watches.length === 0) {
    return (
      <div className={styles.screen}>
        <FirstWatch config={config} cadence={data.summary.cadence_minutes} />
        <MonitoringNotice text={data.disclaimer} />
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      {/* ROW 1 */}
      <WatchHeader
        engine={engine}
        lastEvaluation={data.summary.last_evaluation_at ?? null}
        nextEvaluation={data.summary.next_evaluation_at ?? null}
        onCreate={() => {
          document.getElementById("watch-config")?.scrollIntoView({ block: "center" });
        }}
        onRefresh={() => refresh.submit(undefined)}
        busy={refresh.busy}
      />

      {/* ROW 2 */}
      <CounterRow counters={countersFrom(data, now)} />

      <div className={styles.body}>
        <div className={styles.main}>
          {/* ROW 3 — the places */}
          <Region
            id="watch-places"
            title="Watched locations"
            icon="place"
            level="lead"
            subtitle="Each place, with what its own last retrieval reported. Select one to detail it."
            badges={<span className={styles.classBadge}>FORECAST</span>}
          >
            <WatchedPlaces
              places={places}
              selectedId={
                places.find((place) => place.watchId === detail?.watch.id)?.id ?? null
              }
              onSelect={(id) => {
                const chosen = places.find((place) => place.id === id)?.watchId;
                if (chosen) setSelected(chosen);
              }}
              now={now}
            />
          </Region>

          {/* ROW 4 — the plot */}
          <Region
            id="watch-analysis"
            title="Temporal watch analysis"
            icon="trend"
            subtitle={
              detail
                ? `${placeOf(detail.watch)} · ${ruleOf(detail.watch)}`
                : "Select a watch to plot it against its threshold."
            }
            badges={<span className={styles.classBadge}>FORECAST</span>}
          >
            {detail ? (
              <>
                <TemporalWatchChart
                  points={thresholdPointsFrom(detail)}
                  unit={detail.outcome?.unit ?? null}
                  comparison={detail.watch.comparison}
                  measureLabel={measureLabel(detail.watch.measure)}
                  crossingStamp={detail.outcome?.crossing?.at_local ?? null}
                />
                <PlotFigures figures={plotFiguresFrom(detail)} />
              </>
            ) : (
              <Quiet>Nothing is selected.</Quiet>
            )}
          </Region>

          {/* ROW 5 — why */}
          <Region
            id="watch-evidence"
            title="Watch evidence"
            icon="evidence"
            level="lead"
            subtitle="Computed by Weathra from the retrieval the check was made against. No language model is involved."
            badges={<span className={styles.classBadge}>ANALYTICS</span>}
          >
            <WatchEvidence
              sentence={detail?.evidence ?? null}
              chips={
                detail === null
                  ? []
                  : [
                      { key: "class", label: "Class", value: "Forecast" },
                      { key: "provider", label: "Provider", value: detail.provider ?? "Not reported" },
                      {
                        key: "retrieved",
                        label: "Retrieved",
                        value: whenOf(detail.retrieved_at ?? null),
                      },
                      {
                        key: "evaluated",
                        label: "Evaluated",
                        value: whenOf(detail.evaluated_at ?? null),
                      },
                    ]
              }
            />
          </Region>

              {/* ROW 6 — how. Last in the column, and it stretches: see `.main` in the stylesheet. */}
          <Region
            id="watch-method"
            title="How monitoring works"
            icon="schedule"
            subtitle="Stated plainly, because a monitoring product that overstates itself is dangerous."
          >
            <p className={styles.method}>{data.monitoring_note}</p>
            <ul className={styles.methodList}>
              <li>
                Each watch is one comparison against a retrieved forecast: no model, no inference,
                and no severity judgement.
              </li>
              <li>
                Watches at the same place share one retrieval, so monitoring costs one provider call
                per place rather than one per watch.
              </li>
              <li>
                A provider that reports nothing, and a retrieval that fails, are recorded as their
                own states — neither is the condition being unmet.
              </li>
            </ul>
          </Region>
        </div>

        {/* The right rail, beside all of it. */}
        <div className={styles.rail}>
          <Region
            id="watch-active"
            title="Active watches"
            icon="watch"
            badges={<span className={styles.classBadge}>{watches.length}</span>}
          >
            <ActiveWatches
              watches={watches}
              selectedId={detail?.watch.id ?? null}
              onSelect={setSelected}
              onToggle={(watch) => edit.submit({ id: watch.id, enabled: !watch.enabled })}
              onRemove={(watch) => {
                setRemovingId(watch.id);
                remove.submit(watch.id);
              }}
              removingId={removingId}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
              now={now}
            />
            {/*
              A removal that failed says so. Without this the row simply stayed — which reads as a
              confirmation that did nothing rather than as a backend that refused, and a person who
              believes the watch is gone when it is not will keep being evaluated against it.
            */}
            {remove.state.kind === "error" ? (
              <ErrorState failure={remove.state.failure} title="That watch was not removed" />
            ) : null}
          </Region>

          <Region id="watch-changed" title="What changed?" icon="activity">
            <WhatChangedPanel detail={detail} />
          </Region>

          <Region id="watch-activity" title="Activity feed" icon="activity">
            <ActivityFeed rows={activityFrom(data.activity)} now={now} />
          </Region>

          {/*
            Open, not folded. The artifact draws the configuration card with its fields showing, and
            it is right to: adding a watch is the screen's primary action rather than an aside, and a
            disclosure here would put the one thing a person came to do behind a click.
          */}
          <Region
            id="watch-config"
            title="Quick watch config"
            icon="plus"
            level="lead"
            subtitle="A place, a measure, a direction and a number."
          >
            {config}
          </Region>
        </div>
      </div>

      {/* ROW 7 */}
      <MonitoringNotice text={data.disclaimer} />

      {/* ROW 8 */}
      <StatusStrip items={statusStripFrom(data, engine)} />

      {busy ? (
        <p className={styles.busy} role="status">
          Working…
        </p>
      ) : null}
    </div>
  );
}

/** The right rail's change panel, kept out of the composition above so that stays readable. */
function WhatChangedPanel({
  detail,
}: {
  readonly detail: WatchDashboard["selected"] | null | undefined;
}): ReactNode {
  if (!detail) return <Quiet>Nothing is selected.</Quiet>;

  return (
    <>
      <p className={styles.changeSubject}>
        <StateBadge state={detail.watch.state ?? "pending"} /> {placeOf(detail.watch)}
      </p>
      <WhatChangedList detail={detail} />
    </>
  );
}

function WhatChangedList({
  detail,
}: {
  readonly detail: NonNullable<WatchDashboard["selected"]>;
}): ReactNode {
  const changes = changeCardsFrom(detail.changes);
  if (changes.length === 0) {
    return (
      <Quiet>
        No material change since the previous evaluation
        {detail.evaluation_count !== undefined && detail.evaluation_count < 2
          ? ". This watch has only been checked once so far"
          : ""}
        .
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

/**
 * What the screen is before there is anything to monitor.
 *
 * One statement of what a watch is and the form that makes one — not three placeholder panels with
 * nothing in them, and emphatically not a fabricated example watch, which on a monitoring screen
 * would be indistinguishable from a real one.
 */
function FirstWatch({
  config,
  cadence,
}: {
  readonly config: ReactNode;
  readonly cadence: number;
}): ReactNode {
  return (
    <section className={styles.first} aria-labelledby="watch-first-title">
      <div className={styles.firstText}>
        <h1 className={styles.title} id="watch-first-title">
          Weather Watch
        </h1>
        <p className={styles.lede}>Create your first watch</p>
        <p className={styles.firstBody}>
          Choose a place, a weather measure and a threshold. Weathra will evaluate it on the
          monitoring schedule — about every {cadence} minutes — and record what changes over time.
          It checks the new watch once straight away, so it has a state before you leave this screen.
        </p>
        <p className={styles.firstNote}>
          Weather Watch sends no alerts and monitors nothing continuously. It is a scheduled check
          against one provider&rsquo;s forecast, and every state it reports carries the moment it was
          found.
        </p>
      </div>
      <div className={styles.firstConfig}>{config}</div>
    </section>
  );
}
