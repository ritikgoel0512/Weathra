"use client";

/**
 * Weather Watch — conditions you asked Weathra to check, and what it found when it last looked.
 *
 * Built against `docs/design/screens/14-weather-watch.png`: the summary row, the watch list with
 * each one's latest state, the create form, the disclaimer.
 *
 * **Evaluated on view, and the screen says so where somebody will read it.** Weathra runs nothing on
 * a timer, so every watch here carries the moment it was last checked rather than a live status. The
 * backend states the semantics in `evaluation_note` and this renders that sentence rather than one
 * of its own, so the two cannot drift apart.
 *
 * **A null is not a no.** Before the first check, and where the provider reported nothing for the
 * measure, there is no answer — which is different from the condition being unmet. The three states
 * are drawn as three states.
 *
 * **What the artifact draws and Weathra does not have:** a watch engine, monitoring nodes, model
 * recalibration, sensor telemetry, push alerts and a live status light. There is no scheduler and no
 * notification of any kind, and claiming otherwise about severe weather would be the most harmful
 * thing this product could do.
 */

import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from "@/components/ui";
import type { Measure, PreferenceView, WatchRecord, WatchesResponse } from "@/lib/api/schema";
import { briefingLocationFrom, measureLabel } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./watch.module.css";

const WATCHES_KEY = ["me", "watches"] as const;

function when(value: string | null | undefined): string {
  if (!value) return "not checked yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function WatchRow({
  watch,
  onRefresh,
  onRemove,
  busy,
}: {
  readonly watch: WatchRecord;
  readonly onRefresh: (watch: WatchRecord) => void;
  readonly onRemove: (watch: WatchRecord) => void;
  readonly busy: boolean;
}): ReactNode {
  return (
    <li className={styles.watch}>
      <div className={styles.watchHead}>
        <span className={styles.watchPlace}>{watch.label?.trim() || friendlyName(watch.location)}</span>
        {/* Three states, drawn as three. A watch never checked and a watch whose provider said
            nothing are both "no answer", and neither is "not met". */}
        {watch.last_met === true ? (
          <Badge tone="warning">Condition met</Badge>
        ) : watch.last_met === false ? (
          <Badge tone="ok">Not met</Badge>
        ) : (
          <Badge tone="neutral">No reading</Badge>
        )}
        {watch.enabled ? null : <Badge tone="neutral">Paused</Badge>}
      </div>

      <p className={styles.watchRule}>
        {measureLabel(watch.measure)} {watch.comparison} {watch.threshold}
      </p>

      <p className={styles.watchState}>
        {watch.last_evaluated_at
          ? `${
              watch.last_value === null || watch.last_value === undefined
                ? "No reading at the last check"
                : `Last reading ${watch.last_value}`
            }. Checked ${when(watch.last_evaluated_at)}.`
          : "Not checked yet. It will be, next time you open this screen."}
      </p>

      <div className={styles.watchActions}>
        <Button size="sm" busy={busy} onClick={() => onRefresh(watch)}>
          Check now
        </Button>
        <Button size="sm" variant="danger" onClick={() => onRemove(watch)}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function WatchList({ location }: { readonly location: ReturnType<typeof briefingLocationFrom> }): ReactNode {
  const [measure, setMeasure] = useState<string>("temperature");
  const [comparison, setComparison] = useState("above");
  const [threshold, setThreshold] = useState("25");
  const [acting, setActing] = useState<string | null>(null);

  const watches = useApiQuery<WatchesResponse>({
    key: WATCHES_KEY,
    // Evaluated as it is read: that is the product's semantics, and the response says so too.
    request: (client) => client.watches(true),
  });

  const create = useApiMutation<void, WatchRecord>({
    run: (client) =>
      client.createWatch({
        latitude: location!.latitude,
        longitude: location!.longitude,
        measure: measure as Measure,
        comparison,
        threshold: Number(threshold),
      }),
    invalidates: [WATCHES_KEY],
  });

  const refresh = useApiMutation<WatchRecord, WatchRecord>({
    run: (client, watch) => client.evaluateWatch(watch.id),
    invalidates: [WATCHES_KEY],
    onDone: () => setActing(null),
  });

  const remove = useApiMutation<WatchRecord, void>({
    run: (client, watch) => client.removeWatch(watch.id),
    invalidates: [WATCHES_KEY],
  });

  const data = watches.state.kind === "ready" ? watches.state.data : null;
  const met = data?.watches.filter((watch) => watch.last_met === true).length ?? 0;
  const unread = data?.watches.filter((watch) => watch.last_met === null || watch.last_met === undefined).length ?? 0;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1>Weather Watch</h1>
        <p className={styles.lede}>
          Conditions you asked Weathra to check, and what it found when it last looked.
        </p>
      </header>

      <div className={styles.summary}>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>Watches</p>
          <p className={styles.tileValue}>{data?.count ?? "—"}</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>Condition met</p>
          <p className={styles.tileValue}>{data ? met : "—"}</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>No reading</p>
          <p className={styles.tileValue}>{data ? unread : "—"}</p>
        </div>
      </div>

      {data ? <p className={styles.note}>{data.evaluation_note}</p> : null}

      <div className={styles.body}>
        <Card aria-labelledby="watch-list">
          <CardHeader
            title="Your watches"
            titleId="watch-list"
            badge={<DataClassBadge dataClass="forecast" />}
          />
          <CardBody>
            {watches.state.kind === "loading" ? (
              <LoadingState label="Checking your watches" lines={3} />
            ) : watches.state.kind === "error" ? (
              <ErrorState failure={watches.state.failure} onRetry={watches.retry} />
            ) : data && data.watches.length > 0 ? (
              <ul className={styles.watches}>
                {data.watches.map((watch) => (
                  <WatchRow
                    key={watch.id}
                    watch={watch}
                    busy={refresh.busy && acting === watch.id}
                    onRefresh={(entry) => {
                      setActing(entry.id);
                      refresh.submit(entry);
                    }}
                    onRemove={(entry) => remove.submit(entry)}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing watched yet">
                Add a condition and Weathra will check it each time you open this screen.
              </EmptyState>
            )}
          </CardBody>
        </Card>

        <div className={styles.side}>
          <Card aria-labelledby="watch-new">
            <CardHeader title="Watch a condition" titleId="watch-new" />
            <CardBody>
              <div className={styles.form}>
                <Input label="Place" value={location ? friendlyName(location) : ""} readOnly />
                <Select
                  label="Measure"
                  value={measure}
                  onChange={(event) => setMeasure(event.target.value)}
                  options={(data?.watchable ?? ["temperature"]).map((key) => ({
                    value: key,
                    label: measureLabel(key),
                  }))}
                />
                <Select
                  label="When it goes"
                  value={comparison}
                  onChange={(event) => setComparison(event.target.value)}
                  options={[
                    { value: "above", label: "above" },
                    { value: "below", label: "below" },
                  ]}
                />
                <Input
                  label="Threshold"
                  type="number"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                />
                <Button variant="primary" busy={create.busy} onClick={() => create.submit()}>
                  Add this watch
                </Button>
              </div>
              {create.state.kind === "error" ? (
                <ErrorState failure={create.state.failure} title="That watch was not added" />
              ) : null}
            </CardBody>
          </Card>

          <Card aria-labelledby="watch-safety">
            <CardHeader title="Before you rely on this" titleId="watch-safety" />
            <CardBody>
              <p className={styles.note}>{data?.disclaimer}</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function WeatherWatch(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }
  if (preferences.state.kind !== "ready") return null;

  const location = briefingLocationFrom(preferences.state.data);
  if (location === null) {
    return (
      <EmptyState title="Choose a place to watch">
        Weather Watch checks conditions at your default location. Set one in Settings, or save a
        place first.
      </EmptyState>
    );
  }

  return <WatchList location={location} />;
}
