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
 * **A failure is never dressed as weather.** An unconfigured agent surface, a backend error, an
 * interrupted stream and an expired session are four distinct states, none of which renders a
 * figure. The last one does not belong to this screen at all: it goes to the session boundary
 * through the same interceptor every other call uses.
 *
 * Built against `docs/design/screens/02-ai-weather-analyst.png`. The artifact's fabricated
 * telemetry, station identifiers, agent version strings and synthesis percentages are recorded as
 * mockup filler in `docs/design/screens.md` §5 and are not implemented; the divergences this screen
 * decides beyond them are in §8.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button, ErrorState, Field } from "@/components/ui";
import { AGENT_NOT_CONFIGURED_CODE } from "@/lib/api/errors";
import type { AskRequest } from "@/lib/api/schema";
import { runStepsFrom } from "@/lib/analyst/run";
import { useSession } from "@/lib/session/provider";
import { useAgentStream, type AgentStreamState } from "@/hooks/use-agent-stream";

import { AnalystIntroduction, AnswerView, QuestionTurn, RunProgress } from "./sections";
import styles from "./analyst.module.css";

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
        {/* The backend's own message names the missing configuration. */}
        <p>{terminal.message}</p>
        <p className={styles.note}>
          Every other screen is unaffected: the Dashboard, Historical Analytics, Compare Cities and
          Saved Locations retrieve and compute without an inference provider.
        </p>
      </div>
    );
  }

  if (terminal.kind === "error") {
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
          <RunProgress
            steps={runStepsFrom(run.events)}
            streaming={run.status === "streaming"}
            gap={run.gap}
          />

          {run.terminal?.kind === "final" ? (
            <AnswerView answer={run.terminal.answer} evidenceId={run.terminal.evidenceId} />
          ) : null}

          <TerminalState run={run} onRetry={onRetry} />
        </div>
      )}
    </article>
  );
}

export function Analyst(): ReactNode {
  // The shared 401 mechanism. A stream that ends with an authentication code reaches exactly the
  // same expired-session state a refused REST call does.
  const { markExpired } = useSession();
  const { state, ask, busy } = useAgentStream({ onSessionExpired: markExpired });

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

  return (
    <section className={styles.analyst} aria-label="AI Weather Analyst">
      <header className={styles.heading}>
        <h1 className={styles.title}>AI Weather Analyst</h1>
        <p className={styles.subtitle}>
          Ask a weather question. Weathra routes it to its agents, retrieves and computes what it
          needs, and answers with every figure labelled and attributed.
        </p>
        {threadId ? (
          <p className={styles.thread} data-thread="true">
            Follow-up questions use this conversation&rsquo;s context.
          </p>
        ) : null}
      </header>

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
    </section>
  );
}
