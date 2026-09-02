/**
 * Task 20.14: ordered events, a terminal state, an interrupted stream that shows what arrived, and
 * a mid-stream authentication failure that routes to the expired-session state.
 *
 * The stream is built from real SSE bytes fed through a real `ReadableStream`, so the parser, the
 * body reader, the decoder and the hook are all exercised. A test that handed the hook pre-parsed
 * events would skip the half of this code where the interesting mistakes live.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SessionExpired, type ApiClient } from "@/lib/api/client";
import { createSseParser } from "@/lib/api/sse";

import { agentEventFrom, useAgentStream } from "./use-agent-stream";

/** One SSE block, framed exactly as `weathra/api/streaming.py` writes it. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A response whose body streams the given chunks, in order. */
function streaming(chunks: string[], { close = true }: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
      else controller.close(); // an interrupted stream is a closed body with no terminal event
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function clientStreaming(response: Response | (() => Promise<Response>)): ApiClient {
  const openAgentStream = vi.fn(
    typeof response === "function" ? response : async () => response,
  );
  return { openAgentStream } as unknown as ApiClient;
}

/** A screen-shaped consumer of the hook. */
function Analyst({
  client,
  onSessionExpired,
}: {
  client: ApiClient;
  onSessionExpired?: (error: SessionExpired) => void;
}) {
  const { state, ask, busy, cancel } = useAgentStream({ client, onSessionExpired });

  return (
    <div>
      <button disabled={busy} onClick={() => void ask({ question: "Will it rain in Berlin?" })}>
        Ask
      </button>
      <button onClick={cancel}>Cancel</button>
      <p data-testid="status">{state.status}</p>
      <p data-testid="terminal">{state.terminal?.kind ?? "none"}</p>
      <p data-testid="answer">{state.answerText}</p>
      <p data-testid="request-id">{state.requestId ?? "none"}</p>
      <p data-testid="gap">{String(state.gap)}</p>
      <ol>
        {state.events.map((event) => (
          <li key={event.sequence}>{`${event.sequence}:${event.type}`}</li>
        ))}
      </ol>
    </div>
  );
}

function progress(): string[] {
  return [
    frame("routing", {
      sequence: 1,
      request_id: "req-1",
      capabilities: ["forecast"],
      source: "model",
      reason: null,
    }),
    frame("agent_start", { sequence: 2, request_id: "req-1", agent: "forecast" }),
    frame("tool_start", { sequence: 3, request_id: "req-1", tool: "weather_forecast", agent: "forecast" }),
    frame("tool_end", { sequence: 4, request_id: "req-1", tool: "weather_forecast", ok: true, duration_ms: 42 }),
    frame("agent_end", { sequence: 5, request_id: "req-1", agent: "forecast", status: "completed", duration_ms: 51 }),
  ];
}

async function ask() {
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
}

function eventLog(): string[] {
  return screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("a complete run", () => {
  it("delivers the events in order and ends with the answer", async () => {
    const chunks = [
      ...progress(),
      frame("answer_delta", { sequence: 6, request_id: "req-1", text: "Rain is likely " }),
      frame("answer_delta", { sequence: 7, request_id: "req-1", text: "on Thursday." }),
      frame("final", {
        sequence: 8,
        request_id: "req-1",
        answer: { answer_prose: "Rain is likely on Thursday." },
        evidence_id: "ev-9",
      }),
    ];

    render(<Analyst client={clientStreaming(streaming(chunks))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("final"));
    expect(eventLog()).toEqual([
      "1:routing",
      "2:agent_start",
      "3:tool_start",
      "4:tool_end",
      "5:agent_end",
      "6:answer_delta",
      "7:answer_delta",
      "8:final",
    ]);
    expect(screen.getByTestId("answer")).toHaveTextContent("Rain is likely on Thursday.");
    expect(screen.getByTestId("request-id")).toHaveTextContent("req-1");
    expect(screen.getByTestId("gap")).toHaveTextContent("false");
    expect(screen.getByTestId("status")).toHaveTextContent("done");
  });

  it("orders by sequence rather than by arrival", async () => {
    // The sequence number exists so a client need not trust arrival order (`specs/http-api`).
    const chunks = [
      frame("agent_start", { sequence: 2, request_id: "req-2", agent: "forecast" }),
      frame("routing", { sequence: 1, request_id: "req-2", capabilities: [], source: "model", reason: null }),
      frame("final", { sequence: 3, request_id: "req-2", answer: {}, evidence_id: null }),
    ];

    render(<Analyst client={clientStreaming(streaming(chunks))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("final"));
    expect(eventLog()).toEqual(["1:routing", "2:agent_start", "3:final"]);
    expect(screen.getByTestId("gap")).toHaveTextContent("false");
  });

  it("reports a gap, so a progress list is not mistaken for the whole run", async () => {
    const chunks = [
      frame("routing", { sequence: 1, request_id: "req-3", capabilities: [], source: "model", reason: null }),
      // 2 never arrives.
      frame("final", { sequence: 3, request_id: "req-3", answer: {}, evidence_id: null }),
    ];

    render(<Analyst client={clientStreaming(streaming(chunks))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("gap")).toHaveTextContent("true"));
  });

  it("reads an event split across two chunks", async () => {
    // A read returns whatever arrived, which is regularly half an event.
    const whole = frame("final", { sequence: 1, request_id: "req-4", answer: {}, evidence_id: null });
    const split = [whole.slice(0, 20), whole.slice(20)];

    render(<Analyst client={clientStreaming(streaming(split))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("final"));
  });

  it("disables the submit control while the run is in flight", async () => {
    let release: (response: Response) => void = () => {};
    const client = clientStreaming(() => new Promise<Response>((resolve) => (release = resolve)));

    render(<Analyst client={client} />);
    await ask();

    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();

    await act(async () => {
      release(streaming([frame("final", { sequence: 1, request_id: "r", answer: {}, evidence_id: null })]));
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled());
  });
});

describe("a run the backend failed", () => {
  it("ends with the terminal error, carrying the backend's code and message", async () => {
    const chunks = [
      ...progress().slice(0, 2),
      frame("error", {
        sequence: 3,
        request_id: "req-5",
        code: "provider_unavailable",
        message: "Open-Meteo did not answer after two attempts.",
      }),
    ];

    render(<Analyst client={clientStreaming(streaming(chunks))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("error"));
    // What arrived before the failure stays on screen: the run did part of the work.
    expect(eventLog()).toEqual(["1:routing", "2:agent_start", "3:error"]);
  });
});

describe("an interrupted stream", () => {
  it("is distinguished from a reported failure, and keeps what was received", async () => {
    // The backend always ends with a terminal event, so its absence means the stream stopped
    // before the run finished — and the view must say so and offer a retry, not show an answer.
    render(<Analyst client={clientStreaming(streaming(progress(), { close: false }))} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("interrupted"));
    expect(eventLog()).toEqual([
      "1:routing",
      "2:agent_start",
      "3:tool_start",
      "4:tool_end",
      "5:agent_end",
    ]);
    expect(screen.getByTestId("answer")).toHaveTextContent("");
  });

  it("reports an unreachable backend as unreachable, not as an empty answer", async () => {
    const client = clientStreaming(async () => {
      throw new TypeError("Failed to fetch");
    });

    render(<Analyst client={client} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("unreachable"));
  });

  it("reports a cancellation as a cancellation", async () => {
    const client = clientStreaming(async () => {
      throw new DOMException("aborted", "AbortError");
    });

    render(<Analyst client={client} />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("cancelled"));
  });
});

describe("an authentication failure", () => {
  it("mid-stream routes to the expired-session state", async () => {
    // The token is validated before the run begins and the agent budget sits below its lifetime,
    // so this is rare by construction — and it must not look like a failed question.
    const onSessionExpired = vi.fn();
    const chunks = [
      ...progress().slice(0, 1),
      frame("error", {
        sequence: 2,
        request_id: "req-6",
        code: "token_expired",
        message: "The access token has expired.",
      }),
    ];

    render(
      <Analyst client={clientStreaming(streaming(chunks))} onSessionExpired={onSessionExpired} />,
    );
    await ask();

    await waitFor(() =>
      expect(screen.getByTestId("terminal")).toHaveTextContent("authentication"),
    );
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(onSessionExpired.mock.calls[0]?.[0]).toBeInstanceOf(SessionExpired);
  });

  it("when the stream is refused outright routes to the same state, once", async () => {
    const onSessionExpired = vi.fn();
    const client = clientStreaming(async () => {
      throw new SessionExpired({ code: "token_missing", message: "No token." });
    });

    render(<Analyst client={client} onSessionExpired={onSessionExpired} />);
    await ask();

    await waitFor(() =>
      expect(screen.getByTestId("terminal")).toHaveTextContent("authentication"),
    );
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("is not confused with a run-level failure", async () => {
    const onSessionExpired = vi.fn();
    const chunks = [
      frame("error", {
        sequence: 1,
        request_id: "req-7",
        code: "agent_budget_exceeded",
        message: "The run ran out of time.",
      }),
    ];

    render(
      <Analyst client={clientStreaming(streaming(chunks))} onSessionExpired={onSessionExpired} />,
    );
    await ask();

    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("error"));
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

describe("the event parser", () => {
  it("ignores a frame that is not one of Weathra's events", () => {
    expect(agentEventFrom("heartbeat", "{}")).toBeNull();
    expect(agentEventFrom(null, "data")).toBeNull();
  });

  it("ignores a truncated frame rather than rendering half an event", () => {
    expect(agentEventFrom("final", '{"sequence": 1, "request')).toBeNull();
  });

  it("requires the sequence and request id every event carries", () => {
    expect(agentEventFrom("routing", '{"request_id": "r"}')).toBeNull();
    expect(agentEventFrom("routing", '{"sequence": 1}')).toBeNull();
    expect(agentEventFrom("routing", '{"sequence": 1, "request_id": "r", "source": "model"}')).toEqual(
      { type: "routing", sequence: 1, requestId: "r", data: { source: "model" } },
    );
  });
});

describe("the SSE framing", () => {
  it("holds a partial block until it is complete", () => {
    const parser = createSseParser();

    expect(parser.push("event: routing\ndata: {")).toEqual([]);
    expect(parser.push('"sequence": 1}\n\n')).toEqual([
      { event: "routing", data: '{"sequence": 1}' },
    ]);
  });

  it("yields several blocks arriving together", () => {
    const parser = createSseParser();
    const frames = parser.push(`${frame("routing", { sequence: 1 })}${frame("final", { sequence: 2 })}`);

    expect(frames.map(({ event }) => event)).toEqual(["routing", "final"]);
  });

  it("ignores a comment heartbeat", () => {
    expect(createSseParser().push(":keep-alive\n\n")).toEqual([]);
  });

  it("joins multiple data lines as the specification requires", () => {
    expect(createSseParser().push("event: x\ndata: one\ndata: two\n\n")).toEqual([
      { event: "x", data: "one\ntwo" },
    ]);
  });

  it("handles carriage returns from an intermediary that rewrote the line endings", () => {
    expect(createSseParser().push("event: x\r\ndata: one\r\n\r\n")).toEqual([
      { event: "x", data: "one" },
    ]);
  });
});
