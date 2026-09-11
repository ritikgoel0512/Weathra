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

import { Button, ErrorState, Field, QuotaState } from "@/components/ui";
import type { PreferenceView } from "@/lib/api/schema";
import { briefingLocationFrom } from "@/lib/dashboard/briefing";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";
import { AGENT_NOT_CONFIGURED_CODE, presentableMessage } from "@/lib/api/errors";
import { quotaRefusalFrom } from "@/lib/api/quota";
import type { AskRequest } from "@/lib/api/schema";
import { runStepsFrom } from "@/lib/analyst/run";
import { useSession } from "@/lib/session/provider";
import { useAgentStream, type AgentStreamState } from "@/hooks/use-agent-stream";

import { AnalystFocus } from "./focus";
import { AnalystRail } from "./rail";
import { AnalystIntroduction, AnswerSkeleton, AnswerView, QuestionTurn, RunProgress } from "./sections";
import styles from "./analyst.module.css";

import { FixtureAnalyst } from "./fixture-analyst";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";
import { placeLabel } from "@/lib/locations/place";

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
  // The fourth is the artifact's 2×2 grid rather than a short row, and it names a capability
  // Weathra genuinely has: `/weather/changes` is what a run answering it would read.
  "Has the forecast for this week moved since it was last retrieved?",
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

  if (terminal.kind === "error" && terminal.code === AGENT_NOT_CONFIGURED_CODE) {
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
}: {
  readonly turn: Turn;
  readonly live: AgentStreamState | null;
  readonly onRetry: () => void;
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
          {run.status === "streaming" ? (
            <>
              <RunProgress steps={runStepsFrom(run.events)} streaming gap={run.gap} />
              {/* The shape the answer will take, so the region is never blank mid-run. */}
              <AnswerSkeleton />
            </>
          ) : null}

          {run.terminal?.kind === "final" ? (
            <AnswerView answer={run.terminal.answer} evidenceId={run.terminal.evidenceId} />
          ) : null}

          <TerminalState run={run} onRetry={onRetry} />

          {run.status === "streaming" ? null : (
            <RunProgress steps={runStepsFrom(run.events)} streaming={false} gap={run.gap} />
          )}
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
   * Read here rather than inside `AnalystFocus` so the composer's own FOCUS/UNITS row and the band
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
  const focusLocation = briefingLocationFrom(preferred ?? undefined);

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  /** The backend's thread, so a follow-up resolves against the earlier turns. Never persisted. */
  const [threadId, setThreadId] = useState<string | null>(null);
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
    (asked: string) => {
      const request: AskRequest =
        threadId === null
          ? { question: asked, create_thread: true }
          : { question: asked, thread_id: threadId };
      void ask(request);
    },
    [ask, threadId],
  );

  const submit = useCallback(
    (asked: string) => {
      const trimmed = asked.trim();
      // An empty question is not a request. Nothing is sent and nothing is added to the transcript.
      if (trimmed === "" || busy) return;

      setTurns((previous) => [
        ...previous,
        { id: nextTurnId.current++, question: trimmed, run: null },
      ]);
      setQuestion("");
      run(trimmed);
    },
    [busy, run],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit(question);
    },
    [question, submit],
  );

  /** Re-ask the last question in place, for a run that failed or was cut off. */
  const retry = useCallback(() => {
    if (busy) return;
    const last = turns.at(-1);
    if (last === undefined) return;
    setTurns((previous) => [...previous.slice(0, -1), { ...last, run: null }]);
    run(last.question);
  }, [busy, run, turns]);

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
      <header className={styles.heading}>
        <div className={styles.headingRow}>
          <div className={styles.headingText}>
            <h1 className={styles.title}>AI Weather Analyst</h1>
            <p className={styles.subtitle}>
              Every figure labelled, attributed, and traceable to its run.
            </p>
          </div>
          <div className={styles.headingActions}>
            <Button size="sm" disabled={busy || turns.length === 0} onClick={startOver}>
              New analysis
            </Button>
          </div>
        </div>
        {/*
          Three states, because a failed first question is not the same as not having asked.
          *
          The thread id arrives with an answer, so a run that never produced one leaves it null \u2014
          and the line read "No conversation open yet. The first question starts one." underneath a
          question the person had just asked and watched fail, which the runtime audit of 2026-09-08
          photographed. The middle state says what is true: the question is on screen, the backend
          opened nothing to follow up against.
        */}
        <p className={styles.thread} data-thread={threadId ? "true" : undefined}>
          {threadId
            ? "Active conversation \u2014 follow-up questions use its context."
            : turns.length === 0
              ? "No conversation open yet. The first question starts one."
              : "No conversation is open \u2014 the next question starts one."}
        </p>
      </header>

      <div className={styles.workspace}>
        <div className={styles.main}>
      {/*
        The location context, before and after a run alike.

        `02-ai-weather-analyst.png` anchors its workspace on the place under discussion; without
        this the screen opened on a composer over an empty ground, which is what the 2026-09-10
        review graded. It stays once a conversation exists, updated to whatever the last answer
        actually resolved to rather than continuing to assert the default.
      */}
      <AnalystFocus
        location={focusLocation}
        preferences={preferred}
        resolved={placeLabel(answer?.resolved?.locations?.[0])}
      />

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
            />
          ))
        )}
      </div>

      <div className={styles.starters}>
        {STARTERS.map((starter) => (
          <Button
            key={starter}
            size="sm"
            disabled={busy}
            onClick={() => {
              setQuestion(starter);
              composer.current?.focus();
            }}
          >
            {starter}
          </Button>
        ))}
      </div>

      <form className={styles.composer} onSubmit={onSubmit}>
        {/*
          `02-ai-weather-analyst.png` puts a FOCUS / DEPTH row above the composer. Both are shown
          read-only rather than as controls: the focus is whatever the last run resolved to, which
          the person changes by asking about somewhere else, and there is no depth setting to
          change — `specs/model-policy` keeps model behaviour out of the caller's hands. A pair of
          dropdowns that altered nothing would be the fabrication this pass exists to remove.
        */}
        <div className={styles.composerContext}>
          <span className={styles.composerContextItem}>
            <span className={styles.composerContextTerm}>Focus</span>
            <span className={styles.composerContextValue}>
              {placeLabel(answer?.resolved?.locations?.[0]) ?? "Your default location"}
            </span>
          </span>
          <span className={styles.composerContextItem}>
            <span className={styles.composerContextTerm}>Units</span>
            <span className={styles.composerContextValue}>
              {answer?.resolved?.unit_system ?? "From your preferences"}
            </span>
          </span>
          <span className={styles.composerContextItem}>
            <span className={styles.composerContextTerm}>Depth</span>
            <span className={styles.composerContextValue}>Full synthesis</span>
          </span>
        </div>

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
              placeholder="Ask about conditions, the days ahead, historical context, or how a forecast has moved."
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                submit(question);
              }}
            />
          )}
        </Field>

        <div className={styles.composerActions}>
          <Button type="submit" variant="primary" busy={busy} disabled={empty}>
            {busy ? "Working…" : "Ask Weathra"}
          </Button>
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
        />
      </div>
    </section>
  );
}
