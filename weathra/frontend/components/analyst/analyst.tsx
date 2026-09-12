"use client";

/**
 * The AI Weather Analyst — task 21.2.
 *
 * A question goes to `POST /api/v1/agent/stream` with the caller's bearer token; the run comes back
 * as Weathra's own event vocabulary, and this renders it. Nothing here talks to an inference
 * gateway, and nothing here decides anything about the weather: the browser opens one authenticated
 * stream and displays what the orchestrator, its agents, the MCP weather server and the providers
 * produced.
 *
 * **The stream is the existing one.** `useAgentStream` (task 20.14) already owns the hard parts —
 * ordering by sequence, the terminal guarantee, an interrupted stream, a mid-stream authentication
 * failure — and this screen adds none of its own. A second streaming client would be a second set
 * of those decisions.
 *
 * **The thread is the backend's.** A first question is asked with `create_thread`, and the id the
 * answer comes back with is sent on every following question, so "which day is warmer?" resolves
 * against what the earlier turns established. The id lives in this component's state for the life of
 * the screen and nowhere else: `specs/memory` puts conversation memory in the backend, and a copy in
 * `localStorage` would be a second memory tier holding somebody's questions on a shared machine.
 *
 * **One question at a time.** The submit control is disabled while a run is in flight, the handler
 * refuses an empty question, and `useAgentStream.ask` ignores a second call while running — three
 * layers, because a duplicate submission costs somebody an inference call against their allowance.
 *
 * **A failure is never dressed as weather.** An unconfigured agent surface, an exhausted
 * allowance, a backend error, an interrupted stream and an expired session are five distinct
 * states, none of which renders a figure. The last one does not belong to this screen at all: it
 * goes to the session boundary through the same interceptor every other call uses. The allowance
 * is not a failure at all, and `TerminalState` sorts it out before the error state — see there.
 *
 * Built against `docs/design/screens/02-ai-weather-analyst.png`. The artifact's fabricated
 * telemetry, station identifiers, agent version strings and synthesis percentages are recorded as
 * mockup filler in `docs/design/screens.md` §5 and are not implemented; the divergences this screen
 * decides beyond them are in §8.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button, ErrorState, Field, IntelligenceMark, QuotaState } from "@/components/ui";
import type { Location, PreferenceView } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import { isAgentUnavailableCode, presentableMessage } from "@/lib/api/errors";
import { quotaRefusalFrom } from "@/lib/api/quota";
import type { AskRequest } from "@/lib/api/schema";
import { runStepsFrom } from "@/lib/analyst/run";
import { useSession } from "@/lib/session/provider";
import { useAgentStream, type AgentStreamState } from "@/hooks/use-agent-stream";

import { runIntentOf } from "@/lib/analyst/intent";
import { useLocationResolution } from "@/hooks/use-location-resolution";

import { FocusControl } from "./focus-control";
import { AnalystRail } from "./rail";
import { AnalystIntroduction, AnswerSkeleton, AnswerView, QuestionTurn, RunProgress } from "./sections";
import styles from "./analyst.module.css";

import { FixtureAnalyst } from "./fixture-analyst";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";
import { friendlyName, sendableName } from "@/lib/locations/place";

/**
 * Starter questions, as the artifact's chip row.
 *
 * Prompt text and nothing else — no location, no figure, no claim. The artifact's own suggestions
 * name places and one of them asks the model to predict a value, which
 * `docs/design/screens.md` §5 records as overridden.
 */
const STARTERS: readonly string[] = [
  "What should I expect over the next few days?",
  "How does this week compare with the same week last year?",
  "Why is the forecast uncertain further out?",
  /*
   * The fourth names the capability the graph grew in task 34.34. It is a valid request whatever
   * the current context is — the planner decides whether imagery helps, and a chip that offered it
   * only where it would succeed would be this screen guessing at the plan.
   */
  "Show me the latest satellite observation for this location",
];

/** One exchange: what was asked, and the run that answered it. */
interface Turn {
  readonly id: number;
  readonly question: string;
  /** The finished run. Null while this turn is the one streaming. */
  readonly run: AgentStreamState | null;
}

/** What a terminal state means for the person reading it. */
function TerminalState({
  run,
  onRetry,
}: {
  readonly run: AgentStreamState;
  readonly onRetry: () => void;
}): ReactNode {
  const terminal = run.terminal;
  if (terminal === null) return null;

  if (terminal.kind === "error" && isAgentUnavailableCode(terminal.code)) {
    return (
      <div className={styles.unavailable} role="alert">
        <p className={styles.unavailableTitle}>The AI Weather Analyst is unavailable</p>
        {/* Through `presentableMessage`: this screen does not compose the sentence, so the one
            guarantee it can make is about what it will refuse to render. See its docstring. */}
        <p>{presentableMessage(terminal.message)}</p>
        <p className={styles.note}>
          Every other screen is unaffected: the Dashboard, Historical Analytics, Compare Cities and
          Saved Locations retrieve and compute without an inference provider.
        </p>
      </div>
    );
  }

  if (terminal.kind === "error") {
    /*
     * The allowance, before the generic failure — task 33.5.
     *
     * This branch has to come first, and the ordering is the whole of the requirement: a quota
     * refusal reaching the error state below would be shown as "that question did not complete",
     * which is true of a gateway outage, a schema failure and a timeout, and tells a person who
     * has simply used up their plan's questions nothing they can act on. It is a 429 the stream
     * never opened for, not a run that broke.
     *
     * Only `quota_exceeded`. A `provider_rate_limited` 429 is the gateway saying not yet and stays
     * an error, and `quota_unavailable` — accounting unreachable — stays one too, because it knows
     * no limit to name.
     */
    const refusal = quotaRefusalFrom({
      code: terminal.code,
      message: terminal.message,
      details: terminal.details,
      requestId: run.requestId,
    });
    if (refusal !== null) return <QuotaState refusal={refusal} onRetry={onRetry} />;

    return (
      <ErrorState
        failure={{ message: terminal.message, requestId: run.requestId }}
        title="That question did not complete"
        onRetry={onRetry}
      />
    );
  }

  if (terminal.kind === "unreachable") {
    return (
      <ErrorState
        failure={{ message: terminal.message, requestId: run.requestId }}
        title="Weathra could not be reached"
        onRetry={onRetry}
      />
    );
  }

  if (terminal.kind === "interrupted") {
    // What arrived stays on screen: the spec asks for what was received, the fact that the run did
    // not finish, and a retry — not a cleared panel.
    return (
      <ErrorState
        failure={{
          message:
            "The stream ended before the run finished, so this answer is incomplete. What arrived is shown above.",
          requestId: run.requestId,
        }}
        title="The run did not complete"
        onRetry={onRetry}
      />
    );
  }

  if (terminal.kind === "cancelled") {
    return (
      <ErrorState
        failure={{ message: "You stopped this run. What arrived is shown above.", requestId: run.requestId }}
        title="Run stopped"
        onRetry={onRetry}
      />
    );
  }

  // `authentication` is handled by the session boundary, which replaces this screen entirely.
  return null;
}

/** One turn of the transcript: the question, the run's progress, and its outcome. */
function TurnView({
  turn,
  live,
  onRetry,
  locationOptions = null,
}: {
  readonly turn: Turn;
  readonly live: AgentStreamState | null;
  readonly onRetry: () => void;
  /** The place chooser, for a turn whose answer is waiting for one. Null for every other turn. */
  readonly locationOptions?: ReactNode;
}): ReactNode {
  const run = turn.run ?? live;

  return (
    <article className={styles.turn} aria-label={`Question: ${turn.question}`}>
      <QuestionTurn question={turn.question} />

      {run === null ? null : (
        <div className={styles.response}>
          {/*
            The answer comes first, and the machinery follows it.
            *
            The runtime audit of 2026-09-08 photographed this screen with a "Run progress" strip
            above every answer and above every failure — including a failed run, where it read "no
            steps". `02-ai-weather-analyst.png` leads with the reply; the execution belongs after
            it, or on `05-agent-evidence.png`. So the progress list renders above only while it is
            the only thing there is to see, and moves below the answer once one exists.
          */}
          {/*
            **While it runs, and not after.** `RunProgress` rendered below every settled answer as a
            titled region reading "RUN PROGRESS · 8 steps" — a customer-facing execution trace under
            a reply, on a screen that already links to the whole trace. The steps are not lost: they
            are the Agent Evidence record the answer's own details and the rail both point at.
          */}
          {run.status === "streaming" ? (
            <>
              <RunProgress steps={runStepsFrom(run.events)} streaming gap={run.gap} />
              {/* The shape the answer will take, so the region is never blank mid-run. */}
              <AnswerSkeleton />
            </>
          ) : null}

          {run.terminal?.kind === "final" ? (
            <AnswerView
              answer={run.terminal.answer}
              evidenceId={run.terminal.evidenceId}
              locationOptions={locationOptions}
            />
          ) : null}

          <TerminalState run={run} onRetry={onRetry} />

          {/*
            A run that produced no answer keeps its steps on screen: they are the only account of
            what happened, and a failure with nothing under it says less than the stream recorded.
          */}
          {run.status !== "streaming" && run.terminal?.kind !== "final" ? (
            <RunProgress steps={runStepsFrom(run.events)} streaming={false} gap={run.gap} />
          ) : null}
        </div>
      )}
    </article>
  );
}

export function Analyst(): ReactNode {
  /*
   * Visual-fidelity review only.
   *
   * The flag's value is baked into the bundle at build time, so in a deployed build this comparison
   * is always false and nothing below it is reachable — but it is a *runtime* comparison against a
   * baked object rather than a folded constant, so the branch and the fixture screen do ship. See
   * `lib/fixtures/visily.ts` for what that does and does not guarantee. Nothing below changes.
   */
  if (usingVisilyFixtures()) return <FixtureAnalyst />;
  // The shared 401 mechanism. A stream that ends with an authentication code reaches exactly the
  // same expired-session state a refused REST call does.
  const { markExpired } = useSession();
  const { state, ask, busy } = useAgentStream({ onSessionExpired: markExpired });

  /*
   * The context the question will be answered in — task 21.2's focus band.
   *
   * Read here rather than in the composer so the FOCUS row and the context pill above it cannot
   * above it cannot disagree about the same three facts. Cached under the shared preferences key,
   * so arriving from any other screen spends no request. A failure is not handled: without
   * preferences the band degrades to its no-default state and the composer to its "from your
   * preferences" wording, and neither blocks asking a question.
   */
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });
  const preferred = preferences.state.kind === "ready" ? preferences.state.data : null;

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  /** The backend's thread, so a follow-up resolves against the earlier turns. Never persisted. */
  const [threadId, setThreadId] = useState<string | null>(null);
  /**
   * The place this conversation is pointed at — the FOCUS control's value.
   *
   * Transient by design, and this is the whole of its lifetime: it lives for this conversation and
   * is dropped by `New analysis`. `specs/memory` puts durable location preference in one place —
   * the saved default, which a person sets in Settings and which this does not touch — and a focus
   * that outlived the conversation would be a second, invisible default nobody configured.
   *
   * It is sent on every question of the conversation rather than recorded once, because the
   * backend's precedence is evaluated per run: a question that names Munich must beat it, and the
   * only way that decision can be made correctly is with both facts in the same request.
   */
  const [focus, setFocus] = useState<Location | null>(null);
  const nextTurnId = useRef(1);
  const composer = useRef<HTMLTextAreaElement>(null);

  // The live run belongs to the last turn until it finishes; then its state is kept with the turn
  // so earlier answers stay readable while the next question runs.
  useEffect(() => {
    if (state.status !== "done") return;
    setTurns((previous) => {
      const last = previous.at(-1);
      if (last === undefined || last.run !== null) return previous;
      return [...previous.slice(0, -1), { ...last, run: state }];
    });
  }, [state]);

  // The thread the backend opened for this conversation. Read from the answer, never invented.
  useEffect(() => {
    if (state.terminal?.kind !== "final") return;
    const opened = state.terminal.answer.thread_id;
    if (typeof opened === "string" && opened !== "") setThreadId(opened);
  }, [state.terminal]);


  const run = useCallback(
    (asked: string, pointedAt: Location | null) => {
      const thread: Pick<AskRequest, "create_thread" | "thread_id"> =
        threadId === null ? { create_thread: true } : { thread_id: threadId };
      /*
       * The focus travels as a name *and* the coordinates it already resolved to. The pair is what
       * makes a client-chosen place safe for the backend to accept: the name carries the identity
       * and the coordinates choose among the candidates the geocoder returns for it, so nothing
       * here can name a place something it is not. See `AskRequest.location` and
       * `resolve_for_saving` — a saved default is pinned by exactly the same mechanism.
       */
      const pointing: Pick<AskRequest, "location" | "latitude" | "longitude"> =
        pointedAt === null
          ? {}
          : {
              // `sendableName`, not `qualifiedName`, and the difference is load-bearing: the
              // backend resolves this through its geocoder's *search*, which indexes the plain
              // name, and it returns null for a place whose only name is its own coordinates. This
              // is the same pair Settings sends for a saved default, through the same helper.
              ...(sendableName(pointedAt) !== null ? { location: sendableName(pointedAt)! } : {}),
              latitude: pointedAt.latitude,
              longitude: pointedAt.longitude,
            };
      void ask({ question: asked, ...thread, ...pointing });
    },
    [ask, threadId],
  );

  /**
   * The question that was asked but could not be answered for want of a place.
   *
   * Derived from the transcript rather than kept in state, which is not a style choice: the fact
   * "the last thing that happened was a request for a place" is already recorded on the last turn,
   * and a second copy of it could disagree with the first. Asking another question, resuming this
   * one, or starting over each change the transcript, so each clears this by construction.
   *
   * The review's required exchange rests on it. "What should I expect over the next few days?" →
   * "which place should I analyse?" → *Berlin* must run the original question for Berlin, because a
   * person who has said what they want does not say it twice because the system needed an argument.
   */
  const lastTurn = turns.at(-1);
  const lastSettled =
    lastTurn?.run?.terminal?.kind === "final" ? lastTurn.run.terminal.answer : null;
  const pending =
    lastSettled !== null && runIntentOf(lastSettled).kind === "needs-location"
      ? lastTurn!.question
      : null;

  const submit = useCallback(
    (asked: string, pointedAt: Location | null = focus) => {
      const trimmed = asked.trim();
      // An empty question is not a request. Nothing is sent and nothing is added to the transcript.
      if (trimmed === "" || busy) return;

      setTurns((previous) => [
        ...previous,
        { id: nextTurnId.current++, question: trimmed, run: null },
      ]);
      setQuestion("");
      run(trimmed, pointedAt);
    },
    [busy, focus, run],
  );

  /**
   * Point the conversation somewhere, and finish what it was in the middle of.
   *
   * The two halves are one action deliberately. A person pressing *Berlin* under "which place
   * should I analyse?" has not set a preference and then separately re-asked a question — they
   * have answered the question they were asked, and the only useful next thing is the forecast
   * they wanted in the first place.
   *
   * Choosing a place with nothing pending just points the conversation, which is the composer
   * control's ordinary behaviour: the next question, whatever it turns out to be, uses it.
   */
  const point = useCallback(
    (location: Location | null) => {
      setFocus(location);
      if (location === null || pending === null || busy) return;
      submit(pending, location);
    },
    [busy, pending, submit],
  );

  /*
   * Resolving what somebody types *while the Analyst is waiting for a place*.
   *
   * The same resolver every other screen uses, held here for one job: the review's required
   * exchange, where "Berlin" typed in reply to "which place should I analyse?" has to become the
   * forecast that was already asked for. Without this the reply is a new question — and "Berlin"
   * as a question is answered with another clarification, which is the dead end the review named.
   */
  const reply = useLocationResolution(null);

  /**
   * Whether a typed line is plausibly the *answer* to "which place", rather than a new question.
   *
   * Only consulted while something is pending, and only to decide whether to spend a geocoder call
   * before treating the text as a question. It is deliberately narrow: a question mark, or more
   * than a short phrase, is a new question and is never sent to the resolver. Getting this wrong in
   * the cautious direction costs nothing — the text is asked as a question, which is what would
   * have happened anyway.
   */
  const looksLikeAPlace = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.includes("?")) return false;
    if (trimmed.length > 60) return false;
    return trimmed.split(/\s+/).length <= 6;
  }, []);

  const sendTyped = useCallback(
    async () => {
      const typed = question.trim();
      if (typed === "" || busy) return;

      if (pending !== null && looksLikeAPlace(typed)) {
        const settled = await reply.resolve(typed);
        if (settled.kind === "resolved") {
          // The place answers the question that was waiting, and points the conversation at it for
          // everything that follows. One press, one run, and the original intent intact.
          setQuestion("");
          point(settled.location);
          return;
        }
        // Anything else — ambiguous, unknown, the resolver itself failing — is not a place this
        // screen may assume. It falls through and is asked as a question, and the run says what it
        // could not resolve.
      }

      submit(typed);
    },
    [busy, looksLikeAPlace, pending, point, question, reply, submit],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void sendTyped();
    },
    [sendTyped],
  );

  /** Re-ask the last question in place, for a run that failed or was cut off. */
  const retry = useCallback(() => {
    if (busy) return;
    const last = turns.at(-1);
    if (last === undefined) return;
    setTurns((previous) => [...previous.slice(0, -1), { ...last, run: null }]);
    run(last.question, focus);
  }, [busy, focus, run, turns]);

  const empty = question.trim() === "";
  const live = turns.at(-1)?.run === null ? state : null;


  /**
   * The run the rail describes: the one in flight, or the last one that finished.
   *
   * `live` is null the moment a run settles — its state moves onto the turn — so a rail reading
   * only `live` reported "complete" beside "no agents have run yet". The rail is about the most
   * recent run either way, so it is given whichever that is.
   */
  const railRun = turns.at(-1)?.run ?? live;

  /** The most recent completed answer, for the rail. Never a run still in flight. */
  const settled = [...turns].reverse().find((turn) => turn.run?.terminal?.kind === "final")?.run
    ?.terminal;
  const answer = settled?.kind === "final" ? settled.answer : null;
  const evidenceId = settled?.kind === "final" ? settled.evidenceId : null;

  /**
   * Start a fresh conversation — the artifact's "New Analysis".
   *
   * It drops the thread as well as the transcript, so the next question opens a new one on the
   * backend rather than resolving against turns nobody can see any more.
   */
  const startOver = useCallback(() => {
    if (busy) return;
    setTurns([]);
    setThreadId(null);
    setQuestion("");
    /*
     * The focus goes with the conversation, and the saved default does not.
     *
     * Those are two different lifetimes and the control has to keep them apart. A focus is what
     * *this* conversation was pointed at, so a new conversation is pointed nowhere again. The saved
     * default is a durable preference this screen never writes, so it survives — and with the focus
     * cleared it is once again what the composer offers and what the backend applies. Clearing a
     * person's configured default because they pressed "New analysis" would be this screen editing
     * a Settings value nobody asked it to touch.
     */
    setFocus(null);
    composer.current?.focus();
  }, [busy]);

  return (
    <section className={styles.analyst} aria-label="AI Weather Analyst">
      {/*
        The workspace header of `02-ai-weather-analyst.png`: what this screen is, whether a
        conversation is open, and the one action that exists for it. The artifact also carries a
        "History" control; the threads endpoint exists but no screen lists them, and a control with
        nowhere to go is worse than none — recorded in `docs/design/screens.md` §8.
      */}
      {/*
        **The workspace header** — `02-ai-weather-analyst.png` opens on one compact row: a mark, the
        workspace's name, a line of session state, and the actions. Production opened on a display
        title, a subtitle, a thread sentence, and then a full photographic focus band carrying the
        place, its units, its horizon and a strip of current readings — roughly 340 pixels before
        the conversation, on a screen whose subject is the conversation.

        The place has not gone anywhere: it is the composer's FOCUS on every question and the rail's
        Analyst context on every answer, which is where the artifact keeps it. The current readings
        are the Dashboard's, and the Dashboard is one press away.

        The artifact's "History" control is not here: the threads endpoint exists, no screen lists
        them, and a control with nowhere to go is worse than none — `docs/design/screens.md` §8.
      */}
      <div className={styles.workspace}>
        <div className={styles.main}>
      {/*
        **One surface from the header to the send button** — the artifact's own silhouette.

        `02-ai-weather-analyst.png` draws the conversation as a single bordered canvas: the
        workspace head, a rule, the exchange, a rule, the suggestions, the composer. Production had
        the head above the page and the transcript, the chips and the composer floating separately
        on the page ground, which is why the two screens did not read as the same composition even
        where every region inside them matched. The rail sits beside this card and starts level with
        its head, as it does in the artifact.
      */}
      <header className={styles.heading}>
        <span className={styles.headingMark} aria-hidden="true">
          <IntelligenceMark size={30} />
        </span>
        <div className={styles.headingText}>
          <h1 className={styles.title}>AI Weather Analyst</h1>
          {/*
            Truthful session state, and no invented identifier. The artifact prints "Thread ID:
            WXA-7729-ALPHA" beside a green dot; the backend does open a thread, and its id is a key
            for a log rather than something a customer reads. What is said instead is what the state
            means for the next question.
          */}
          <p className={styles.thread} data-thread={threadId ? "true" : undefined}>
            {threadId
              ? `Active conversation · ${turns.length} ${turns.length === 1 ? "question" : "questions"}`
              : turns.length === 0
                ? "No conversation open yet"
                : "No conversation open — the next question starts one"}
          </p>
        </div>
        <div className={styles.headingActions}>
          <Button size="sm" disabled={busy || turns.length === 0} onClick={startOver}>
            New analysis
          </Button>
        </div>
      </header>

      {/*
        The artifact's small centred context pill. It states only what is true: a conversation is
        open, or a saved default will be used, or neither — and it names no memory key and no
        implementation.
      */}
      {/*
        The artifact's small centred pill, saying what the *next* question will be answered with —
        in the backend's own order of precedence, so what it says and what the run does cannot
        disagree. It names the focus first because the focus wins first.
      */}
      {/*
        Suppressed while the conversation is waiting for a place. A thread *is* open in that state,
        so "using this conversation's context" was literally true and still read as a contradiction
        of the message directly beneath it, which was asking for the context it implied it had.
      */}
      {pending !== null ? null : (
      <p className={styles.contextPill}>
        {focus !== null
          ? `Focused on ${friendlyName(focus)}. Name another place in a question to look there instead.`
          : threadId
            ? "Using this conversation's context."
            : preferred?.default_location
              ? `Using ${friendlyName(preferred.default_location)}, your saved default.`
              : "Name a place in your question, or choose one below — Weathra never guesses."}
      </p>
      )}

      <div className={styles.transcript}>
        {turns.length === 0 ? (
          <AnalystIntroduction />
        ) : (
          turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              turn={turn}
              live={index === turns.length - 1 ? live : null}
              onRetry={retry}
              /*
                Only the turn that is actually waiting gets the chooser — the last one, and only
                while it is pending. An earlier clarification that has since been answered is a
                transcript entry, and putting a live control in it would offer to resume a question
                the conversation has already moved past.
              */
              locationOptions={
                pending !== null && index === turns.length - 1 ? (
                  <FocusControl
                    focus={focus}
                    fallback={preferred?.default_location ?? null}
                    onChoose={point}
                    disabled={busy}
                    variant="panel"
                    headingLevel={3}
                  />
                ) : null
              }
            />
          ))
        )}
      </div>

      {/*
        The artifact's suggestion chips. They were full-width bordered buttons two to a row, at the
        weight of a primary action; the artifact sets them as quiet chips a person scans on the way
        to the composer.
      */}
      <div className={styles.starters} aria-label={
        focus !== null ? `Suggested questions about ${friendlyName(focus)}` : "Suggested questions"
      }>
        {STARTERS.map((starter) => (
          <button
            type="button"
            className={styles.starter}
            key={starter}
            disabled={busy}
            onClick={() => {
              setQuestion(starter);
              composer.current?.focus();
            }}
          >
            {starter}
          </button>
        ))}
      </div>

      <form
        className={styles.composer}
        onSubmit={onSubmit}
        aria-label="Ask Weathra a weather question"
      >
        {/*
          `02-ai-weather-analyst.png` puts a FOCUS / DEPTH row above the composer. Both are shown
          read-only rather than as controls: the focus is whatever the last run resolved to, which
          the person changes by asking about somewhere else, and there is no depth setting to
          change — `specs/model-policy` keeps model behaviour out of the caller's hands. A pair of
          dropdowns that altered nothing would be the fabrication this pass exists to remove.
        */}
        <div className={styles.composerContext}>
          {/*
            **The artifact's FOCUS, as the control it is drawn as.**

            This was the place *last resolved*, rendered as text — which is a report about the
            previous run wearing the label of a setting for the next one, and on an account with no
            saved default it read "Named in your question" and offered nothing to press. The value
            is now what the conversation is pointed at, and pressing it is how that changes; what a
            run resolved is reported where reports belong, in the rail's Analyst context.
          */}
          <FocusControl
            focus={focus}
            fallback={preferred?.default_location ?? null}
            onChoose={point}
            disabled={busy}
          />
          <span className={styles.composerContextItem}>
            <span className={styles.composerContextTerm}>Units</span>
            <span className={styles.composerContextValue}>
              {answer?.resolved?.unit_system ?? preferred?.unit_system ?? "From your preferences"}
            </span>
          </span>
          <span className={styles.composerContextItem}>
            <span className={styles.composerContextTerm}>Depth</span>
            <span className={styles.composerContextValue}>Full synthesis</span>
          </span>
        </div>

        {/*
          The field keeps its label and its description for everyone who navigates by them; both are
          visually hidden, because the artifact's composer is a box with a placeholder in it and the
          Enter/Shift+Enter sentence under production's was a line of instructions on a text area
          everybody already knows how to use.
        */}
        <Field
          label="Your weather question"
          description="Enter to send, Shift+Enter for a new line. Follow-ups use this conversation's context."
        >
          {(control) => (
            <textarea
              {...control}
              ref={composer}
              className={styles.composerInput}
              name="question"
              rows={3}
              value={question}
              placeholder="Ask about current conditions, the days ahead, historical trends, comparisons, satellite observations, or weather concepts…"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void sendTyped();
              }}
            />
          )}
        </Field>

        {/*
          The artifact's send control: inside the composer's own box, on the same row as nothing
          else, at the weight of the screen's one primary action. It was a button sitting under an
          unframed text area, which read as a form's submit rather than as a chat's send.
        */}
        <div className={styles.composerActions}>
          <button
            type="submit"
            className={styles.send}
            disabled={empty || busy}
            /* What the shared Button announces while a run is in flight, kept: a control that is
               working and a control that is merely disabled are two different things to hear. */
            aria-busy={busy || undefined}
          >
            {/*
              The label stays in the document at every width — visually hidden on a phone, never
              removed — so the button's accessible name is the same words a sighted reader sees and
              there is no second copy of it to drift.
            */}
            <span className={styles.sendLabel}>{busy ? "Working…" : "Ask Weathra"}</span>
            {/*
              The artifact's send glyph, drawn here rather than fetched: a paper plane is four
              points, and a weather product should not load an icon font for it. Decorative — the
              label beside it carries the meaning.
            */}
            <svg
              className={styles.sendGlyph}
              viewBox="0 0 24 24"
              width="18"
              height="18"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12 3.5 13.9z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </form>
        </div>

        <AnalystRail
          live={railRun}
          answer={answer}
          evidenceId={evidenceId}
          /*
            The stream's `final` event carries an `AnswerEnvelope`, and conversation-memory
            availability is on `AskResponse` — the REST shape — not on the envelope. So the rail is
            told nothing about memory here rather than being told a guess, and it omits the line.
          */
          memory={null}
          /*
            **The durable half of `specs/memory`, read from the one place that stores it.**

            The rail's "Preferences in use" card lists what this account actually saved, and this is
            the same `PreferenceView` the composer's FOCUS and units already read — one request, one
            answer, no second opinion about what somebody's default location is. The card shows only
            the fields the response stamps `chosen`; the assumption/choice distinction is the
            backend's and is not re-decided here.
          */
          preferences={preferred ?? null}
          /*
            Whether earlier turns are available to the next run — the *thread*, which is not memory
            and is not labelled as memory. The backend opened it or it did not.
          */
          threadOpen={threadId !== null}
        />
      </div>
    </section>
  );
}
