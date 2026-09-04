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

import Link from "next/link";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

import { CandidateChoice } from "@/components/locations/candidate-choice";
import {
  Button,
  ErrorState,
  EmptyState,
  Input,
  InterpretationPanel,
  LoadingState,
} from "@/components/ui";
import { AGENT_NOT_CONFIGURED_CODE } from "@/lib/api/errors";
import type { AskResponse, Location, PreferenceView, UnitSystem } from "@/lib/api/schema";
import { briefingLocationFrom, calendarWindowFrom } from "@/lib/dashboard/briefing";
import { qualifiedName } from "@/lib/locations/place";
import { useLocationResolution } from "@/hooks/use-location-resolution";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import { describeFailure } from "@/lib/query/state";
import { useApiClient } from "@/lib/api/context";

import {
  CurrentConditions,
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
    { kind: "idle" } | { kind: "asking" } | { kind: "answered"; answer: AskResponse } | { kind: "failed"; message: string; unavailable: boolean }
  >({ kind: "idle" });

  const ask = useCallback(async () => {
    setState({ kind: "asking" });
    try {
      const answer = await client.ask({ question: BRIEFING_QUESTION, units });
      setState({ kind: "answered", answer });
    } catch (error) {
      const failure = describeFailure(error);
      setState({
        kind: "failed",
        message: failure.message,
        unavailable: failure.code === AGENT_NOT_CONFIGURED_CODE,
      });
    }
  }, [client, units]);

  if (state.kind === "answered") {
    const envelope = state.answer.answer;
    return (
      <InterpretationPanel
        title="Weathra Intelligence"
        provider={envelope.llm_provider ?? null}
        model={envelope.llm_model ?? null}
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

  // The two retrieved surfaces are what the briefing rests on: while either is in flight there is
  // nothing honest to show, and if either fails the screen says so and offers a retry.
  if (current.state.kind === "loading" || forecast.state.kind === "loading") {
    return <LoadingState label={`Loading the briefing for ${location.display_name}`} lines={6} />;
  }

  if (current.state.kind === "error") {
    return <ErrorState failure={current.state.failure} onRetry={current.retry} />;
  }
  if (forecast.state.kind === "error") {
    return <ErrorState failure={forecast.state.failure} onRetry={forecast.retry} />;
  }

  return (
    <div className={styles.dashboard}>
      {current.state.kind === "ready" ? (
        <CurrentConditions current={current.state.data} location={location} />
      ) : null}

      <div className={styles.columns}>
        <div className={styles.column}>
          {forecast.state.kind === "ready" ? (
            <ForecastMovement forecast={forecast.state.data} location={location} />
          ) : null}

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

          <WeathraIntelligence units={units} />
        </div>

        <div className={styles.column}>
          {analysis.state.kind === "loading" ? (
            <LoadingState label="Computing analytics" lines={3} />
          ) : analysis.state.kind === "error" ? (
            <ErrorState failure={analysis.state.failure} onRetry={analysis.retry} />
          ) : analysis.state.kind === "ready" ? (
            <DeterministicAnalytics analysis={analysis.state.data} location={location} />
          ) : null}

          {baseline.state.kind === "loading" ? (
            <LoadingState label="Loading historical context" lines={3} />
          ) : baseline.state.kind === "error" ? (
            <ErrorState failure={baseline.state.failure} onRetry={baseline.retry} />
          ) : baseline.state.kind === "ready" ? (
            <HistoricalContext baseline={baseline.state.data} />
          ) : null}
        </div>
      </div>
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
  const [query, setQuery] = useState("");
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

  const settling = entry.resolution.kind !== "unresolved" && entry.resolution.kind !== "resolved";
  const location = chosen ?? saved;

  return (
    <div className={styles.dashboard}>
      {/*
        The screen's own heading — task 21.8. Every other MVP screen carried one and this did not,
        so a heading-list navigation of the Dashboard showed its sections with nothing naming the
        page they belong to, and the screen had no accessible name at all in that structure.
      */}
      <header className={styles.heading}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>
          Your Weathra Intelligence briefing: what the conditions are now, how the forecast has
          moved, what stands out, and how it sits against the years before it.
        </p>
      </header>

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

      {/* Nothing location-dependent while the entry has not settled on one place. */}
      {settling ? null : location === null ? (
        <EmptyState
          title="No default location saved"
          action={
            <Link className={styles.actions} href="/settings">
              <Button variant="primary" size="sm">
                Choose a default location
              </Button>
            </Link>
          }
        >
          The Dashboard briefs you on one place. Choose a default location in Settings, save one from
          Saved Locations, or name a place above.
        </EmptyState>
      ) : (
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
    </div>
  );
}

export function Dashboard(): ReactNode {
  const preferences = useApiQuery({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Loading your briefing" lines={6} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }
  if (preferences.state.kind === "empty") {
    return <EmptyState title="No preferences available">Weathra could not read your preferences.</EmptyState>;
  }

  return <LocationChoice preferences={preferences.state.data} />;
}
