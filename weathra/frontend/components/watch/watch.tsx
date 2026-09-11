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

import { RecordedAgainstBaselineChart } from "@/components/historical/charts";
import { PlaceChooser } from "@/components/locations/place-chooser";
import { ScreenPreview } from "@/components/locations/screen-preview";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyChart,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from "@/components/ui";
import type {
  ForecastResponse,
  Location,
  Measure,
  PreferenceView,
  WatchRecord,
  WatchesResponse,
} from "@/lib/api/schema";
import { briefingLocationFrom, measureLabel } from "@/lib/dashboard/briefing";
import { hasValues, missingCount, pointsFrom } from "@/lib/historical/analysis";
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
    : parsed.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
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
        <span className={styles.watchPlace}>
          {watch.label?.trim() || friendlyName(watch.location)}
        </span>
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

/**
 * The forecast the watches are checked against, with their thresholds drawn through it.
 *
 * `14-weather-watch.png`'s largest panel is "Temporal Watch Vector Analysis" — an intra-day plot
 * with a dashed threshold line across it — and the production fidelity review recorded its absence
 * as this screen's remaining gap: "no graphical weather context beside the list". A list of
 * thresholds with a number beside each says whether a condition is met. It does not say how close
 * the rest of the window comes to it, which is the thing a plot answers and a list cannot.
 *
 * # Where the figures come from
 *
 * * **The series** — `GET /weather/forecast` for this screen's location, hourly, the same read the
 *   Forecast Explorer draws. Not a second source and not a cached copy of the watch's own reading.
 * * **The reference line** — the watch's own `threshold`, as stored. Nothing is recomputed here.
 * * **The measure** — whichever measure the watches at this location are actually about, so the
 *   plot is of the quantity being watched rather than of temperature by default.
 *
 * # What it deliberately is not
 *
 * **Not a history.** The artifact's panel has "ANOMALIES LOGGED 02 Detected" and an activity feed
 * of past breaches, and Weathra has no scheduler — nothing evaluates a watch except a person
 * opening this screen or pressing refresh. A history table would therefore record *when somebody
 * pressed a button*, and a chart of that would look like a record of the weather while being a
 * record of visits. That is worse than an absent panel, so it stays absent until there is a
 * scheduler to fill it, and `screens.md` §5 records why.
 *
 * **Not a claim of monitoring.** The plot is the forecast now, drawn when the screen is opened.
 * The note above it already says Weathra does not watch continuously, and this changes nothing
 * about that.
 */
function WatchContext({
  location,
  watches,
}: {
  readonly location: Location;
  readonly watches: readonly WatchRecord[];
}): ReactNode {
  /*
   * The measure to plot: the one the watches here are about. An enabled watch outranks a disabled
   * one, because a disabled watch's threshold is not currently being checked against anything.
   * With no watch at all the plot is temperature, which is the measure a person is most likely to
   * be about to watch and gives the panel something to show before the first watch exists.
   */
  const relevant = watches.filter(
    (watch) =>
      watch.location.latitude === location.latitude &&
      watch.location.longitude === location.longitude,
  );
  const leading =
    relevant.find((watch) => watch.enabled) ?? relevant[0] ?? null;
  const measure = leading?.measure ?? "temperature";

  const forecast = useApiQuery<ForecastResponse>({
    key: ["watch", "forecast", location.latitude, location.longitude],
    request: (client) =>
      client.forecast({
        latitude: location.latitude,
        longitude: location.longitude,
        days: 3,
      }),
  });

  const data = forecast.state.kind === "ready" ? forecast.state.data : null;
  const points = data ? pointsFrom(data.hourly) : [];
  const drawable = hasValues(points, measure);
  const unit = data?.hourly?.units?.[measure] ?? null;
  const label = measureLabel(measure as Measure);
  const title = `${label} through the forecast window`;

  return (
    <Card aria-labelledby="watch-context">
      <CardHeader
        title="What the watches are checked against"
        titleId="watch-context"
        badge={<DataClassBadge dataClass="forecast" />}
        subtitle={
          leading === null
            ? `The forecast for ${friendlyName(location)}. Create a watch and its threshold is drawn through it.`
            : `${label} for ${friendlyName(location)}, with the ${leading.comparison} ${leading.threshold}${unit ? ` ${unit}` : ""} threshold drawn through it.`
        }
      />
      <CardBody>
        {forecast.state.kind === "loading" ? (
          <LoadingState label="Reading the forecast" lines={4} />
        ) : forecast.state.kind === "error" ? (
          // Component-level, so a provider failure costs this panel and not the watch list beside
          // it: the list's own readings came from a different request and are still true.
          <ErrorState
            failure={forecast.state.failure}
            onRetry={forecast.retry}
          />
        ) : drawable ? (
          <RecordedAgainstBaselineChart
            points={points}
            measure={measure}
            unit={unit}
            seriesLabel={label}
            title={title}
            missing={missingCount(points, measure)}
            baselineValue={leading?.threshold ?? null}
            baselineLabel={
              leading === null ? null : `threshold, ${leading.comparison}`
            }
            referenceLabel="Threshold"
            sourceLabel="the provider"
          />
        ) : (
          <EmptyChart
            title={title}
            reason={`This provider reported no hourly ${label.toLowerCase()} for this window.`}
          />
        )}
      </CardBody>
    </Card>
  );
}

function WatchList({
  location,
  chooser,
}: {
  readonly location: ReturnType<typeof briefingLocationFrom>;
  /** The screen's place control, rendered under its own heading. */
  readonly chooser: ReactNode;
}): ReactNode {
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
  const met =
    data?.watches.filter((watch) => watch.last_met === true).length ?? 0;
  const unread =
    data?.watches.filter(
      (watch) => watch.last_met === null || watch.last_met === undefined,
    ).length ?? 0;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1>Weather Watch</h1>
        <p className={styles.lede}>
          Conditions you asked Weathra to check, and what it found when it last
          looked.
        </p>
      </header>

      {/* Under the heading, where the artifacts put a screen's own controls. */}
      {chooser}

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

      {/* The artifact's largest panel. See `WatchContext` for every figure's source. */}
      {location ? (
        <WatchContext location={location} watches={data?.watches ?? []} />
      ) : null}

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
              <ErrorState
                failure={watches.state.failure}
                onRetry={watches.retry}
              />
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
                Add a condition and Weathra will check it each time you open
                this screen.
              </EmptyState>
            )}
          </CardBody>
        </Card>

        <div className={styles.side}>
          <Card aria-labelledby="watch-new">
            <CardHeader title="Watch a condition" titleId="watch-new" />
            <CardBody>
              <div className={styles.form}>
                <Input
                  label="Place"
                  value={location ? friendlyName(location) : ""}
                  readOnly
                />
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
                <Button
                  variant="primary"
                  busy={create.busy}
                  onClick={() => create.submit()}
                >
                  Add this watch
                </Button>
              </div>
              {create.state.kind === "error" ? (
                <ErrorState
                  failure={create.state.failure}
                  title="That watch was not added"
                />
              ) : null}
            </CardBody>
          </Card>

          <Card aria-labelledby="watch-safety">
            <CardHeader
              title="Before you rely on this"
              titleId="watch-safety"
            />
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
  /** A place named on this screen. Outranks the default while it is set. */
  const [chosen, setChosen] = useState<Location | null>(null);

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return (
      <ErrorState
        failure={preferences.state.failure}
        onRetry={preferences.retry}
      />
    );
  }
  if (preferences.state.kind !== "ready") return null;

  const saved = briefingLocationFrom(preferences.state.data);
  const location = chosen ?? saved;

  /*
   * Declared once and used in both branches. The empty branch needs it most: its own text
   * says "name one above", and an empty state saying that with nothing above it is the
   * dead end this control exists to remove.
   */
  const chooser = (
    <PlaceChooser
      summary="Watch another place"
      label="Watch a place"
      description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
      current={location}
      usingDefault={chosen === null}
      hasDefault={saved !== null}
      onChoose={setChosen}
    />
  );

  return (
    <>
      {/*
        The screen's own place control. With no default this used to be an empty state and a link
        to Settings, which made the feature reachable only by configuring a preference somewhere
        else first — see `PlaceChooser` for why that is not a substitute for a product.
      */}

      {location === null ? (
        <>
          {chooser}
          <ScreenPreview
            title="A watch is about one place"
            lead="Name a place above, or set a default in Settings and every screen opens on it. Nothing below is filled in yet because no place has been chosen."
            regions={[
              {
                title: "The condition you are watching for",
                blurb:
                  "A measure, a threshold and a direction — above 30 °C, below freezing, more than 10 mm of rain.",
              },
              {
                title: "Whether it is met",
                blurb:
                  "Checked against the retrieved forecast for the place, with the day and the figure that met it.",
              },
              {
                title: "Your watches",
                blurb:
                  "Every watch you have saved, with what each one is looking for and where it stands now.",
              },
            ]}
          />
        </>
      ) : (
        <WatchList
          key={`${location.latitude},${location.longitude}`}
          location={location}
          chooser={chooser}
        />
      )}
    </>
  );
}
