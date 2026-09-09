"use client";

/**
 * The AI Weather Analyst's stream (task 20.14).
 *
 * Consumes `/api/v1/agent/stream` with the bearer token, through a `fetch` body reader rather than
 * `EventSource` — which cannot set a header, and with token authentication on the stream that
 * stops being a preference and becomes the only workable option (design.md decision 18).
 *
 * **Ordered, not merely arrived.** Every event carries a monotonic sequence number precisely so a
 * client does not have to trust arrival order (`specs/http-api`). Events are held in sequence
 * order and a gap is recorded, because a progress list that silently dropped an event would
 * misreport what the run did.
 *
 * **Always terminal.** The backend guarantees exactly one `final` or `error` event, so a stream
 * that ends without one did not complete — the connection dropped, the tab slept, a proxy gave up.
 * That is `interrupted`, and it is distinct from an error the backend reported: the spec requires
 * the view to show what was received, say the run did not complete, and offer a retry. A hook that
 * reported "no answer" would make those three indistinguishable.
 *
 * **A mid-stream authentication failure is an authentication event.** The token is validated once,
 * before the run begins, and the agent's wall-clock budget is set below the token's lifetime — so
 * this is rare by construction. When it happens it arrives as a terminal error carrying an
 * authentication code, and it must route to the expired-session state rather than appear as a
 * failed question.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { SessionExpired, type ApiClient } from "@/lib/api/client";
import { useOptionalApiClient } from "@/lib/api/context";
import { isAuthenticationCode } from "@/lib/api/errors";
import { readSseFrames } from "@/lib/api/sse";
import type { AnswerEnvelope, AskRequest } from "@/lib/api/schema";

/** The event vocabulary of design.md decision 17. */
export type AgentEventType =
  | "routing"
  | "agent_start"
  | "agent_end"
  | "tool_start"
  | "tool_end"
  | "answer_delta"
  | "final"
  | "error";

const TERMINAL: readonly AgentEventType[] = ["final", "error"];

/** One event, as the stream sent it. */
export interface AgentEvent {
  readonly type: AgentEventType;
  readonly sequence: number;
  readonly requestId: string;
  /** The event's own fields, minus the sequence and request id every event carries. */
  readonly data: Record<string, unknown>;
}

/** How a run ended. Exactly one of these, once `status` is `"done"`. */
export type AgentTerminal =
  | { readonly kind: "final"; readonly answer: AnswerEnvelope; readonly evidenceId: string | null }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      /**
       * The field-level specifics behind the refusal, or null when it carried none.
       *
       * Task 33.5 needs them: an exhausted allowance is refused *before* the stream opens — a 429
       * rather than a 200 whose first event apologises (`weathra/api/routers/agent.py`) — and the
       * limit and reset time it names live here. Without this the Analyst would know a run was
       * refused and not what bound it, and would have to show a plan limit as a generic failure.
       */
      readonly details: Record<string, unknown> | null;
    }
  | { readonly kind: "authentication"; readonly code: string; readonly message: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "cancelled" };

export type AgentStreamStatus = "idle" | "streaming" | "done";

export interface AgentStreamState {
  readonly status: AgentStreamStatus;
  /** Every event received, in sequence order. */
  readonly events: readonly AgentEvent[];
  /** The answer assembled from the `answer_delta` events, as it arrives. */
  readonly answerText: string;
  /** How the run ended, or null while it is still running. */
  readonly terminal: AgentTerminal | null;
  /** The request id, for a report that can be traced. Known from the first event. */
  readonly requestId: string | null;
  /** Whether a sequence number was missing — the events shown are not the whole run. */
  readonly gap: boolean;
}

export interface UseAgentStreamOptions {
  /** Called when the run ends because there is no valid session. */
  readonly onSessionExpired?: (error: SessionExpired) => void;
  /** Injected in tests. The context's client otherwise. */
  readonly client?: ApiClient;
}

export interface UseAgentStream {
  readonly state: AgentStreamState;
  /** Start a run. Ignored while one is already streaming, so one question is asked once. */
  ask(request: AskRequest): Promise<void>;
  /** Abandon the run. The events already received stay on screen. */
  cancel(): void;
  /** Return to the idle state, discarding the previous run. */
  reset(): void;
  /** Whether a run is in flight, so the submit control can be disabled. */
  readonly busy: boolean;
}

const IDLE: AgentStreamState = {
  status: "idle",
  events: [],
  answerText: "",
  terminal: null,
  requestId: null,
  gap: false,
};

interface RawEvent {
  readonly sequence?: unknown;
  readonly request_id?: unknown;
  readonly [field: string]: unknown;
}

function isAgentEventType(value: string | null): value is AgentEventType {
  return (
    value !== null &&
    [
      "routing",
      "agent_start",
      "agent_end",
      "tool_start",
      "tool_end",
      "answer_delta",
      "final",
      "error",
    ].includes(value)
  );
}

/** One SSE frame as an event, or null when it is not one Weathra sent. */
export function agentEventFrom(event: string | null, data: string): AgentEvent | null {
  if (!isAgentEventType(event)) return null;

  let parsed: RawEvent;
  try {
    parsed = JSON.parse(data) as RawEvent;
  } catch {
    // A frame Weathra did not write, or a truncated one. Dropping it is right: the stream's
    // terminal guarantee means a lost frame shows up as a gap or an interruption, both of which
    // the view reports.
    return null;
  }

  const { sequence, request_id: requestId, ...rest } = parsed;
  if (typeof sequence !== "number" || typeof requestId !== "string") return null;

  return { type: event, sequence, requestId, data: rest };
}

/** Insert an event in sequence order, replacing a duplicate of the same sequence. */
function ordered(events: readonly AgentEvent[], event: AgentEvent): AgentEvent[] {
  const without = events.filter((held) => held.sequence !== event.sequence);
  return [...without, event].sort((left, right) => left.sequence - right.sequence);
}

function hasGap(events: readonly AgentEvent[]): boolean {
  return events.some((event, index) => event.sequence !== index + 1);
}

function terminalFrom(event: AgentEvent): AgentTerminal {
  if (event.type === "final") {
    const evidenceId = event.data.evidence_id;
    return {
      kind: "final",
      answer: event.data.answer as AnswerEnvelope,
      evidenceId: typeof evidenceId === "string" ? evidenceId : null,
    };
  }

  const code = typeof event.data.code === "string" ? event.data.code : "internal_error";
  const message =
    typeof event.data.message === "string" ? event.data.message : "The run did not complete.";

  const details =
    typeof event.data.details === "object" && event.data.details !== null
      ? (event.data.details as Record<string, unknown>)
      : null;

  return isAuthenticationCode(code)
    ? { kind: "authentication", code, message }
    : { kind: "error", code, message, details };
}

export function useAgentStream(options: UseAgentStreamOptions = {}): UseAgentStream {
  const contextClient = useOptionalApiClient();
  const client = options.client ?? contextClient;
  if (client === null) {
    throw new Error("useAgentStream needs an <ApiProvider> or a client of its own.");
  }
  const { onSessionExpired } = options;

  const [state, setState] = useState<AgentStreamState>(IDLE);
  const abort = useRef<AbortController | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  /** State updates are dropped after unmount rather than warning about a stray render. */
  const update = useCallback((change: (previous: AgentStreamState) => AgentStreamState) => {
    if (!mounted.current) return;
    setState(change);
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    running.current = false;
    update(() => IDLE);
  }, [update]);

  const cancel = useCallback(() => {
    abort.current?.abort();
  }, []);

  const ask = useCallback(
    async (request: AskRequest): Promise<void> => {
      // One question, asked once: the spec requires an in-flight request to disable its submit,
      // and this makes a second call harmless even if a control slips through.
      if (running.current) return;
      running.current = true;

      const controller = new AbortController();
      abort.current = controller;
      update(() => ({ ...IDLE, status: "streaming" }));

      let terminal: AgentTerminal | null = null;
      let notified = false;

      try {
        const response = await client.openAgentStream(request, controller.signal);

        for await (const frame of readSseFrames(response)) {
          const event = agentEventFrom(frame.event, frame.data);
          if (event === null) continue;

          update((previous) => {
            const events = ordered(previous.events, event);
            const delta = event.type === "answer_delta" ? String(event.data.text ?? "") : "";
            return {
              ...previous,
              events,
              gap: hasGap(events),
              requestId: previous.requestId ?? event.requestId,
              answerText: previous.answerText + delta,
            };
          });

          if (TERMINAL.includes(event.type)) {
            terminal = terminalFrom(event);
            break;
          }
        }

        // The backend always ends with a terminal event, so its absence means the stream stopped
        // before the run finished.
        terminal ??= { kind: "interrupted" };
      } catch (failure) {
        if (failure instanceof SessionExpired) {
          onSessionExpired?.(failure);
          notified = true;
          terminal = { kind: "authentication", code: failure.code, message: failure.message };
        } else if (failure instanceof DOMException && failure.name === "AbortError") {
          terminal = { kind: "cancelled" };
        } else if (failure instanceof Error && "code" in failure) {
          const described = failure as Error & {
            code: string;
            details?: Record<string, unknown> | null;
          };
          terminal = isAuthenticationCode(described.code)
            ? { kind: "authentication", code: described.code, message: described.message }
            : {
                kind: "error",
                code: described.code,
                message: described.message,
                // The refusal's own specifics, kept rather than dropped: this is the branch a
                // pre-stream 429 arrives through, and the quota state is written from them.
                details: described.details ?? null,
              };
        } else {
          terminal = {
            kind: "unreachable",
            message:
              failure instanceof Error ? failure.message : "The stream ended unexpectedly.",
          };
        }
      } finally {
        running.current = false;
        abort.current = null;
      }

      // A terminal authentication error reaches the session layer the same way a 401 on a REST
      // call does. Without this, the one place the session can expire mid-question would be the
      // one place the expired-session state was not entered.
      if (terminal !== null && terminal.kind === "authentication" && !notified) {
        onSessionExpired?.(new SessionExpired({ code: terminal.code, message: terminal.message }));
      }

      const ended = terminal;
      update((previous) => ({ ...previous, status: "done", terminal: ended }));
    },
    [client, onSessionExpired, update],
  );

  return { state, ask, cancel, reset, busy: state.status === "streaming" };
}
