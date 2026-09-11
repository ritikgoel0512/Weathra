"use client";

/**
 * The Dashboard — task 21.1.
 *
 * The Weathra Intelligence briefing for the signed-in person's default location, in their preferred
 * units: current conditions, forecast movement, anomalies and computed figures, historical context,
 * *What Changed?*, and the model's reading of all of it.
 *
 * **Everything comes through the documented API.** `useApiQuery` → the typed client → FastAPI, and
 * from there the orchestrator, the agents, the MCP weather server and the providers. The browser
 * calls no weather provider, computes no statistic, and holds no fallback value: a figure that is
 * not in a response is not on the screen.
 *
 * **The person's preferences decide what is asked for.** The default location and the unit system
 * come from `/me/preferences`, so the briefing is theirs rather than a generic feed — which is the
 * carried-forward design decision `specs/web-ui` records as *location-focused Dashboard*. Somebody
 * who has saved no default gets a state that says so and offers the way to set one, not an empty
 * screen and not a location Weathra picked for them.
 *
 * **The four surfaces are four data classes.** Retrieved provider figures, deterministic analytics
 * and model-written prose are separate regions with separate tiers (task 20.15), so nothing here
 * can suggest the language model produced a measurement. The interpretation is asked for
 * explicitly rather than on every load: it costs an inference call, `specs/usage-limits` counts
 * them, and a briefing that silently spends one on arrival would be spending somebody's allowance
 * without being asked.
 */

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { CandidateChoice } from "@/components/locations/candidate-choice";
import {
  Button,
  ErrorState,
  EmptyState,
  Input,
  InterpretationPanel,
  LoadingState,
  QuotaState,
} from "@/components/ui";
import { AGENT_NOT_CONFIGURED_CODE } from "@/lib/api/errors";
import { quotaRefusalFrom, type QuotaRefusal } from "@/lib/api/quota";
import { inferenceMetadataFrom } from "@/lib/inference/served";
import type {
  AskResponse,
  Location,
  PreferenceView,
  SavedLocationsResponse,
  UnitSystem,
} from "@/lib/api/schema";
import { FixtureDashboard } from "@/components/dashboard/fixture-dashboard";
import { GettingStarted } from "./getting-started";
import { PLACE_PARAM } from "@/components/shell/top-bar";
import { briefingLocationFrom, calendarWindowFrom } from "@/lib/dashboard/briefing";
import { placeLabel, qualifiedName } from "@/lib/locations/place";
import { useLocationResolution } from "@/hooks/use-location-resolution";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";
import { describeFailure } from "@/lib/query/state";
import { useApiClient } from "@/lib/api/context";

import {
  ClimatePulse,
  ConfidenceMatrix,
  CurrentConditions,
  ForecastStrip,
  PrecipitationOutlook,
  SavedSnapshots,
  ComputedFigures,
  DeterministicAnalytics,
  ForecastMovement,
  HistoricalContext,
  WhatChanged,
} from "./sections";
import styles from "./dashboard.module.css";

/** The question the briefing asks the agent about the figures already on screen. */
const BRIEFING_QUESTION =
  "Summarise the current conditions, the forecast for the days ahead, and any anomalies for my default location.";

/**
 * The model's reading of the figures above it.
 *
 * Asked for on request, and always inside `InterpretationPanel`, which carries the badge and the
 * sentence saying the model produced no measurement. When no inference credential is configured the
 * backend answers with a stable code and this says so plainly — every other surface on the screen
 * stays exactly as useful, which is the degradation `specs/web-ui` requires.
 */
function WeathraIntelligence({ units }: { readonly units: PreferenceView["unit_system"] }): ReactNode {
  const client = useApiClient();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "asking" }
    | { kind: "answered"; answer: AskResponse }
    | { kind: "refused"; refusal: QuotaRefusal }
    | { kind: "failed"; message: string; unavailable: boolean }
  >({ kind: "idle" });

  const ask = useCallback(async () => {
    setState({ kind: "asking" });
    try {
      const answer = await client.ask({ question: BRIEFING_QUESTION, units });
      setState({ kind: "answered", answer });
    } catch (error) {
      const failure = describeFailure(error);
      // The allowance is its own outcome, sorted out before the failure — task 33.5. The briefing
      // is the Dashboard's one agent-backed surface, so it is the one place on this screen a plan
      // limit can be reached, and showing it as a failed request would blame the product for a
      // limit the plan set. Everything else here is retrieved or computed and is untouched.
      const refusal = quotaRefusalFrom(failure);
      setState(
        refusal !== null
          ? { kind: "refused", refusal }
          : {
              kind: "failed",
              message: failure.message,
              unavailable: failure.code === AGENT_NOT_CONFIGURED_CODE,
            },
      );
    }
  }, [client, units]);

  if (state.kind === "answered") {
    const envelope = state.answer.answer;
    // Task 33.6: the run's own inference attempts, not the configured pair, wherever it recorded
    // one. The briefing and the Analyst read the same metadata through the same function, so the
    // two screens cannot disagree about what answered.
    const inference = inferenceMetadataFrom(envelope.evidence?.inference_attempts, {
      provider: envelope.llm_provider,
      model: envelope.llm_model,
    });
    return (
      <InterpretationPanel
        title="Weathra Intelligence"
        provider={inference?.provider ?? null}
        model={inference?.model ?? null}
        requestedModel={inference?.requestedModel ?? null}
        policy={inference?.policyId ?? null}
        resolution={inference?.resolutionReason ?? null}
        served={inference?.served ?? true}
        footer={
          state.answer.memory_available === false && state.answer.memory_note ? (
            <span>{state.answer.memory_note}</span>
          ) : null
        }
      >
        {envelope.answer_prose ? (
          <p>{envelope.answer_prose}</p>
        ) : (
          // The grounding guard withheld the prose. Say that, rather than showing nothing.
          <p>
            The interpretation was withheld because it could not be grounded in the figures above.
            The retrieved and computed figures on this screen are unaffected.
          </p>
        )}
        {envelope.clarification_question ? <p>{envelope.clarification_question}</p> : null}
      </InterpretationPanel>
    );
  }

  if (state.kind === "refused") {
    /*
     * Outside `InterpretationPanel` deliberately: that panel is the AI-interpretation region, and
     * an allowance refusal is not an interpretation. Putting it inside would give a plan limit the
     * badge and the boundary sentence that exist to mark model-written language.
     */
    return <QuotaState refusal={state.refusal} onRetry={ask} />;
  }

  return (
    <InterpretationPanel title="Weathra Intelligence">
      {state.kind === "failed" ? (
        <p>
          {state.unavailable
            ? "The AI Weather Analyst is unavailable because no inference provider is configured. Every figure on this screen is retrieved or computed and is unaffected."
            : state.message}
        </p>
      ) : (
        <p>
          Ask Weathra to read the figures above — the conditions, the days ahead, and anything that
          stood out.
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={ask} busy={state.kind === "asking"}>
          {state.kind === "asking" ? "Reading the figures…" : "Generate interpretation"}
        </Button>
      </div>
    </InterpretationPanel>
  );
}

/**
 * The briefing for one *resolved* location.
 *
 * The location is a parameter rather than something read from preferences here, because task 21.7
 * gave the screen a second way to choose one: the person can brief on another place. Either way it
 * is a canonical `Location` the backend produced — a name a person typed never reaches this
 * component, and there is therefore no path by which an ambiguous entry could become a weather
 * request.
 */
function Briefing({
  location,
  units,
  days,
}: {
  readonly location: Location;
  readonly units: UnitSystem;
  readonly days: number;
}): ReactNode {
  const place = { latitude: location.latitude, longitude: location.longitude, units };

  const current = useApiQuery({
    key: ["dashboard", "current", place],
    request: (client) => client.current(place),
  });

  const forecast = useApiQuery({
    key: ["dashboard", "forecast", place, days],
    request: (client) => client.forecast({ ...place, days }),
  });

  const analysis = useApiQuery({
    key: ["dashboard", "analysis", place, days],
    request: (client) => client.analysis({ ...place, days }),
  });

  // *What Changed?* over the same place and horizon the forecast strip shows, so the two describe
  // one window. The comparison itself is the backend's: this asks for it and renders what came
  // back. A failure here is the section's *unavailable* state and nothing more — the rest of the
  // briefing is unaffected — and a 401 never reaches this branch at all, because the client turns
  // one into `SessionExpired` and the session boundary replaces the screen.
  const changes = useApiQuery({
    key: ["dashboard", "changes", place, days],
    request: (client) => client.changes({ ...place, days }),
  });

  // The baseline's calendar window is the forecast's own period, so the historical context is the
  // same days of previous years rather than an arbitrary range.
  const window =
    forecast.state.kind === "ready" ? calendarWindowFrom(forecast.state.data.period) : null;

  const baseline = useApiQuery({
    key: ["dashboard", "baseline", place, window],
    request: (client) =>
      client.baseline({ ...place, start: window!.start, end: window!.end, measure: "temperature_mean" }),
    enabled: window !== null,
  });

  /*
   * The saved places, for the "Saved Snapshots" panel. Deliberately *not* joined to the gate below:
   * whether somebody has saved a place has nothing to do with whether the briefing can be shown, so
   * a slow or failed list must not hold up or take down the conditions. The panel carries its own
   * state.
   */
  const snapshots = useApiQuery<SavedLocationsResponse>({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
    isEmpty: (data) => data.locations.length === 0,
  });

  // The two retrieved surfaces are what the briefing rests on: while either is in flight there is
  // nothing honest to show, and if either fails the screen says so and offers a retry.
  if (current.state.kind === "loading" || forecast.state.kind === "loading") {
    return <LoadingState label={`Loading the briefing for ${placeLabel(location)}`} lines={6} />;
  }

  if (current.state.kind === "error") {
    return <ErrorState failure={current.state.failure} onRetry={current.retry} />;
  }
  if (forecast.state.kind === "error") {
    return <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />;
  }

  /*
   * The Dashboard's composition, in the order `01-dashboard.png` sets it out:
   *
   *   1. the hero band — the place, the temperature, the secondary measures;
   *   2. the intelligence row — Weathra's reading on the left, the computed figures on the right;
   *   3. the forecast strip — a card per day the backend returned;
   *   4. the movement row — how the forecast has moved, and what it is against;
   *   5. the status rule.
   *
   * The previous arrangement stacked every card in two long columns, which is why the screen and
   * its artifact did not read as the same page even once the palette matched: the artifact is a
   * sequence of full-width bands with two-column rows between them, and the hierarchy is carried by
   * the band widths rather than by the order alone.
   */
  return (
    <div className={styles.dashboard}>
      {current.state.kind === "ready" ? (
        <CurrentConditions current={current.state.data} location={location} />
      ) : null}

      <div className={styles.columns}>
        <div className={styles.column}>
          <div className={styles.intelligenceRow}>
            <WeathraIntelligence units={units} />
            <ConfidenceMatrix
              forecast={forecast.state.kind === "ready" ? forecast.state.data : null}
              analysis={analysis.state.kind === "ready" ? analysis.state.data : null}
            />
          </div>

          {changes.state.kind === "loading" ? (
            <LoadingState label="Comparing against the last snapshot" lines={2} />
          ) : (
            // Ready renders the comparison the backend produced — populated or no-prior-snapshot,
            // which the report itself distinguishes. Anything else is "no comparison could be
            // obtained", which is `null` and a different sentence.
            <WhatChanged
              report={changes.state.kind === "ready" ? changes.state.data : null}
            />
          )}

          {/*
            The computed statistics, in the column with room for them. They were in the narrow
            column with the anomaly alert, which is not how `01-dashboard.png` divides this band —
            see `ComputedFigures` for what that cost.
          */}
          {analysis.state.kind === "ready" ? (
            <ComputedFigures analysis={analysis.state.data} location={location} />
          ) : null}
        </div>

        <div className={styles.column}>
          {analysis.state.kind === "loading" ? (
            <LoadingState label="Computing analytics" lines={3} />
          ) : analysis.state.kind === "error" ? (
            <ErrorState failure={analysis.state.failure} onRetry={analysis.retry} />
          ) : analysis.state.kind === "ready" ? (
            <DeterministicAnalytics
              analysis={analysis.state.data}
              location={location}
              baseline={baseline.state.kind === "ready" ? baseline.state.data : null}
            />
          ) : null}

          {/* The artifact's panel beneath the anomaly panel, in the same column. */}
          <SavedSnapshots state={snapshots.state} />
        </div>
      </div>

      {forecast.state.kind === "ready" ? (
        <section aria-label="The days ahead">
          <div className={styles.bandHeading}>
            <h2 className={styles.bandTitle}>The days ahead</h2>
            <p className={styles.bandMeta}>
              {forecast.state.data.horizon_days}-day horizon from your preferences, in{" "}
              {location.timezone}.
            </p>
          </div>
          <ForecastStrip forecast={forecast.state.data} />
        </section>
      ) : null}

      {/*
        The artifact's analytics row: the wide intra-day chart on the left, the precipitation panel
        beside it. Both are drawn from the forecast the screen already holds.
      */}
      {forecast.state.kind === "ready" ? (
        <div className={styles.columns}>
          <div className={styles.column}>
            <ClimatePulse forecast={forecast.state.data} />
          </div>
          <div className={styles.column}>
            <PrecipitationOutlook forecast={forecast.state.data} />
          </div>
        </div>
      ) : null}

      {/*
        Full width, because it is one band and not two. It sat in the two-column grid above with
        nothing beside it, which left a third of the row empty at every desk width — the artifact
        has no void there, and the emptiness read as a panel that had failed to load rather than as
        a panel that was never there.
      */}
      {forecast.state.kind === "ready" ? (
        <ForecastMovement forecast={forecast.state.data} location={location} />
      ) : null}

      {/*
        The wide baseline band `01-dashboard.png` closes on: the account on the left, the figures
        beside it. It used to be a card in the right rail, which is a different composition.
      */}
      <div className={styles.baselineRow}>
        {/*
          The heading introduces the band from above rather than from a column beside it. As a
          column it was a two-line title holding 38% of a 1440-pixel row open for the height of the
          panel next to it, which the 2026-09-10 production capture photographed as the screen's
          largest void. "The days ahead" already introduces its band this way.
        */}
        <div className={styles.bandHeading}>
          <h2 className={styles.bandTitle}>Climate baseline</h2>
          <p className={styles.bandMeta}>This window against the years behind it.</p>
        </div>
        <div className={styles.column}>
          {baseline.state.kind === "loading" ? (
            <LoadingState label="Loading the baseline" lines={3} />
          ) : baseline.state.kind === "error" ? (
            <ErrorState failure={baseline.state.failure} onRetry={baseline.retry} />
          ) : baseline.state.kind === "ready" ? (
            <HistoricalContext baseline={baseline.state.data} />
          ) : null}
        </div>
      </div>

      {/*
        The rule the artifact closes on. Its own version reads "DATA FLOW: ACTIVE · SYSTEM HASH:
        B882-X90A-BERL · v4.8.2-STABLE" — a status word, an invented hash and an invented version.
        What is put in its place is the same rule carrying facts this screen already holds: who
        provided the figures, the place they are for, and the units they are in.
      */}
      {current.state.kind === "ready" ? (
        <p className={styles.statusStrip}>
          <span className={styles.statusStripItem}>
            Provider: {current.state.data.attribution?.provider ?? "not reported"}
          </span>
          <span className={styles.statusStripItem}>{placeLabel(location)}</span>
          <span className={styles.statusStripItem}>Units: {units}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The place the briefing is about: the person's default, or another they asked for — task 21.7.
 *
 * `specs/web-ui` describes the Dashboard as briefing on "a chosen or default location", and this is
 * the choosing half. It is deliberately the *only* way a typed name gets in, and it goes through
 * the one geocoder Weathra has: `GET /api/v1/locations/resolve`, behind the backend.
 *
 * **A name never becomes a weather request.** `Briefing` takes a resolved `Location`, so the only
 * value that can reach a weather endpoint is one the backend returned. An ambiguous name produces
 * candidates and no location, and there is therefore nothing to brief with until one is pressed —
 * the gate is structural rather than a check somebody has to remember.
 *
 * **The briefing is withdrawn while an entry is unsettled.** Not only for the ambiguous case: while
 * a name is being resolved, or came back unknown, or the lookup failed, the previous briefing is
 * taken off screen. It was a correct briefing for a different place, and leaving it under a
 * candidate list would let it read as the answer to what was just typed.
 */
function LocationChoice({ preferences }: { readonly preferences: PreferenceView }): ReactNode {
  const saved = briefingLocationFrom(preferences);
  const entry = useLocationResolution(null);
  /**
   * The shell's search field hands a name over as `?place=`, and it lands here — the one place that
   * turns a name into a location, through the backend's resolver. The field in the header does no
   * resolving of its own, so an ambiguous name asked for up there gets the same candidate chooser
   * as one typed below, rather than a second, weaker answer.
   */
  const asked = useSearchParams().get(PLACE_PARAM)?.trim() ?? "";
  const [query, setQuery] = useState(asked);
  /** The resolved place being briefed on, when it is not the person's default. */
  const [chosen, setChosen] = useState<Location | null>(null);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const asked = query.trim();
      // An empty entry is not a request, and a second press while one is in flight is not a second.
      if (asked === "" || entry.busy) return;
      const settled = await entry.resolve(asked);
      // Only ever the backend's own location object.
      if (settled.kind === "resolved") setChosen(settled.location);
    },
    [entry, query],
  );

  const choose = useCallback(
    (candidate: Location) => {
      entry.choose(candidate);
      setChosen(candidate);
    },
    [entry],
  );

  const toDefault = useCallback(() => {
    entry.clear();
    setChosen(null);
    setQuery("");
  }, [entry]);

  /**
   * Resolve a name that arrived in the URL, once per name. The ref is what makes it once: without
   * it, resolving would set state, re-render, and ask again. Clearing the entry is deliberately not
   * done here — a person who then presses "use my default" should not be pulled back to the URL's
   * place on the next render.
   */
  const resolvedParam = useRef<string | null>(null);
  useEffect(() => {
    if (asked === "" || resolvedParam.current === asked) return;
    resolvedParam.current = asked;
    setQuery(asked);
    void entry.resolve(asked).then((settled) => {
      if (settled.kind === "resolved") setChosen(settled.location);
    });
  }, [asked, entry]);

  const settling = entry.resolution.kind !== "unresolved" && entry.resolution.kind !== "resolved";
  const location = chosen ?? saved;

  /*
   * The entry is folded away once there is a briefing to read — finding 1.7 of the runtime fidelity
   * audit of 2026-09-08. `01-dashboard.png` opens straight onto the hero; production opened onto a
   * form, above the fold, on every visit. It is the same form with the same single field and the
   * same resolver behind it, one press away.
   *
   * It stays open in the three states where it is the thing to do: when there is no default
   * location to brief on, while an entry is unsettled — a name being resolved, an ambiguous one
   * waiting on a candidate, or a lookup that failed — and while the briefing is about a place that
   * was named rather than the default, because "back to my default location" lives inside it and a
   * way out that is hidden is not a way out. Collapsing under an empty state that says "name a
   * place above" is finding 6.5's mistake on another screen, and it is not repeated here.
   */
  const entryOpen = location === null || settling || chosen !== null;

  /**
   * Whether this is the Dashboard of somebody who has not chosen a place yet.
   *
   * It is a different screen, not a smaller one — `GettingStarted` below. The disclosure is wrong
   * for it in both directions: a collapsed form hides the only thing to do, and an open one headed
   * "Brief on another place" asks somebody to brief on *another* place when they have had none.
   */
  const onboarding = location === null;

  /*
   * The form itself, built once and placed in whichever frame the state calls for. The populated
   * Dashboard folds it into a disclosure; the new-account Dashboard puts it in the hero. Same
   * field, same resolver, same candidate chooser — the alternative was a second form to keep right.
   */
  const entryForm = (
    <>
      <form className={styles.entry} onSubmit={submit} aria-label="Choose a place to brief on">
        <div className={styles.entryField}>
          <Input
            label="Brief me on a place"
            description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
            name="location"
            value={query}
            placeholder="A city, or a city and its region or country"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className={styles.entryActions}>
          <Button type="submit" variant="primary" busy={entry.busy} disabled={query.trim() === ""}>
            {entry.busy ? "Resolving…" : "Show briefing"}
          </Button>
          {chosen !== null || settling ? (
            <Button size="sm" onClick={toDefault}>
              Back to my default location
            </Button>
          ) : null}
        </div>
      </form>

      <CandidateChoice
        resolution={entry.resolution}
        onChoose={choose}
        label="Places matching what you entered"
      />
    </>
  );

  return (
    <DashboardFrame>
      {onboarding ? (
        <GettingStarted>{entryForm}</GettingStarted>
      ) : (
        <details className={styles.entryDisclosure} open={entryOpen}>
          {/*
            One wording in every state. The note under the briefing already says which place is
            being briefed on and whether it is the default, and a summary that repeated it would put
            the same sentence on the screen twice — finding 2.3's mistake on the Analyst.
          */}
          <summary className={styles.entrySummary}>Brief on another place</summary>
          {entryForm}
        </details>
      )}

      {/* Nothing location-dependent while the entry has not settled on one place. */}
      {settling || location === null ? null : (
        <>
          {chosen === null ? null : (
            <p className={styles.note} data-briefing-place="chosen">
              Briefing on {qualifiedName(chosen)}, which you named. Your default location is
              unchanged.
            </p>
          )}
          <Briefing
            location={location}
            units={preferences.unit_system}
            days={preferences.forecast_horizon_days}
          />
        </>
      )}
    </DashboardFrame>
  );
}

/**
 * The screen's frame: its heading, and whatever state it is in.
 *
 * The heading is task 21.8's — every other MVP screen carried one and this did not, so a
 * heading-list navigation of the Dashboard showed its sections with nothing naming the page they
 * belong to. It lives here rather than inside the ready branch so a loading, failed or empty
 * Dashboard is still recognisably the Dashboard.
 */
function DashboardFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className={styles.dashboard}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>
          Conditions now, the days ahead, and how they sit against the record.
        </p>
      </header>

      {children}
    </div>
  );
}

export function Dashboard(): ReactNode {
  /*
   * Visual-fidelity review only. `usingVisilyFixtures()` reads a `NEXT_PUBLIC_` flag whose value
   * is fixed when the bundle is built, so in a deployed build this is always false and nothing
   * below it is reachable. It is not folded away, so the branch and `FixtureDashboard` do ship —
   * see `lib/fixtures/visily.ts`. Nothing below it changes.
   */
  if (usingVisilyFixtures()) return <FixtureDashboard />;

  const preferences = useApiQuery({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  /*
   * The heading outlives the state.
   *
   * These three branches used to return a bare notice, so a Dashboard that was still loading — or
   * whose preferences call failed — had no `h1`, no subtitle, and no indication of which screen the
   * notice belonged to. The runtime audit of 2026-09-08 photographed both: an unnamed page with six
   * grey lines on it, and an unnamed page with one red box on it. The heading is static text that
   * needs no request, so it renders on every branch, and the state renders under it.
   */
  if (preferences.state.kind === "loading") {
    return (
      <DashboardFrame>
        <LoadingState label="Loading your briefing" shape="band" />
      </DashboardFrame>
    );
  }
  if (preferences.state.kind === "error") {
    return (
      <DashboardFrame>
        <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />
      </DashboardFrame>
    );
  }
  if (preferences.state.kind === "empty") {
    return (
      <DashboardFrame>
        <EmptyState title="No preferences available">
          Weathra could not read your preferences.
        </EmptyState>
      </DashboardFrame>
    );
  }

  return <LocationChoice preferences={preferences.state.data} />;
}
