/**
 * The AI Weather Analyst — task 21.2's verification.
 *
 * The five the task names — a streamed answer, a follow-up resolving from thread context, a
 * duplicate submission prevented, an interrupted stream, and the unavailable case — then the ones
 * that are architectural properties rather than behaviour: that every progress row came from an
 * event the backend actually sent, that a 401 reaches the shared expired-session state rather than
 * this screen's error branch, that the conversation lives in the backend's thread rather than in
 * browser storage, and that the browser talks to Weathra's API and nothing else.
 *
 * Everything below the `fetch` boundary is real: the real session boundary, the real API client,
 * the real SSE parser and body reader, the real `useAgentStream`, and the real screen. The stream
 * is built from real SSE bytes through a real `ReadableStream`, so a test that passes here has
 * exercised the framing as well as the rendering.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { NOT_REPORTED } from "@/components/ui";
import { SessionBoundary } from "@/lib/session/provider";

import { Analyst } from "./analyst";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("the Analyst must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/analyst",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------- fixtures */

const BERLIN = {
  display_name: "Berlin, Germany",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  country: "Germany",
};

const PERIOD = {
  start_local: "2026-09-04T00:00:00+02:00",
  end_local: "2026-09-07T00:00:00+02:00",
  start_utc: "2026-09-03T22:00:00Z",
  end_utc: "2026-09-06T22:00:00Z",
  timezone: "Europe/Berlin",
};

const FORECAST_SOURCE = {
  provider: "open-meteo",
  location: BERLIN,
  data_class: "forecast",
  period: PERIOD,
  retrieved_at: "2026-09-04T06:15:00Z",
};

const ANALYTICS_SOURCE = { ...FORECAST_SOURCE, data_class: "computed_statistic" };

const EVIDENCE = {
  request_id: "req-1",
  thread_id: "thread-42",
  question: "What should I expect over the next few days in Berlin?",
  routing_reason: "The question asks about the days ahead and what stands out in them.",
  routing_source: "model",
  agents: [
    { sequence: 1, agent: "forecast", status: "succeeded", started_at: "2026-09-04T06:15:00Z", duration_ms: 412 },
    { sequence: 2, agent: "synthesis", status: "succeeded", started_at: "2026-09-04T06:15:01Z", duration_ms: 903 },
  ],
  tool_calls: [
    {
      sequence: 1,
      tool: "weather_forecast",
      agent: "forecast",
      arguments: {},
      started_at: "2026-09-04T06:15:00Z",
      duration_ms: 388,
    },
  ],
  tool_results: [],
  citations: [
    { document_id: "doc-1", title: "Reading a forecast horizon", topic: "forecasting", chunk_position: 0, score: 0.81, text: "…" },
  ],
  attributions: [FORECAST_SOURCE],
  data_classes: ["forecast", "computed_statistic"],
  llm_provider: "openrouter",
  llm_model: "a-configured-model",
  started_at: "2026-09-04T06:15:00Z",
  completed_at: "2026-09-04T06:15:02Z",
  total_duration_ms: 2100,
  steps_used: 2,
  partial: false,
};

const ANSWER = {
  request_id: "req-1",
  thread_id: "thread-42",
  answer_prose:
    "The days ahead stay close to the seasonal baseline, with one warmer day midweek.",
  prose_data_class: "ai_interpretation",
  findings: [
    {
      label: "Highest temperature",
      value: 21.4,
      unit: "°C",
      data_class: "forecast",
      attribution: FORECAST_SOURCE,
    },
    {
      label: "Mean temperature",
      value: 17.9,
      unit: "°C",
      data_class: "computed_statistic",
      method: "arithmetic mean of usable points",
      points_used: 72,
      attribution: ANALYTICS_SOURCE,
    },
  ],
  uncertainty: {
    basis:
      "Confidence decreases with horizon distance, from one provider's output and its supplied spread only.",
    provider: "open-meteo",
    reference_time_utc: "2026-09-04T06:15:00Z",
    spread_available: false,
    horizon: [
      { confidence: "moderate", hours_ahead: 48, time_utc: "2026-09-06T06:00:00Z", time_local: "2026-09-06T08:00:00+02:00" },
    ],
  },
  attribution: [FORECAST_SOURCE],
  resolved: {
    locations: [BERLIN],
    period: PERIOD,
    unit_system: "metric",
    location_source: "preferences",
    units_source: "preferences",
    statement: "Answered for Berlin, Germany over 4 to 7 September, from your saved default.",
  },
  grounding: { verified: true, method: "figure extraction with a 0.05 tolerance", figures_checked: 2 },
  evidence: EVIDENCE,
  llm_provider: "openrouter",
  llm_model: "a-configured-model",
};

/** One SSE block, framed exactly as `weathra/api/streaming.py` writes it. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The events a real run emits, in the order `agents/graph.py` emits them. */
function runFrames(answer: unknown = ANSWER): string[] {
  return [
    frame("routing", {
      sequence: 1,
      request_id: "req-1",
      capabilities: ["forecast", "analytics"],
      source: "model",
      reason: "The question asks about the days ahead.",
    }),
    frame("agent_start", { sequence: 2, request_id: "req-1", agent: "forecast", reason: "Retrieve the window." }),
    frame("agent_end", { sequence: 3, request_id: "req-1", agent: "forecast", status: "succeeded", duration_ms: 412 }),
    frame("tool_start", { sequence: 4, request_id: "req-1", tool: "weather_forecast", agent: "forecast" }),
    frame("tool_end", { sequence: 5, request_id: "req-1", tool: "weather_forecast", ok: true, duration_ms: 388 }),
    frame("agent_start", { sequence: 6, request_id: "req-1", agent: "synthesis" }),
    frame("agent_end", { sequence: 7, request_id: "req-1", agent: "synthesis", status: "succeeded", duration_ms: 903 }),
    frame("answer_delta", { sequence: 8, request_id: "req-1", text: "The days ahead stay close to the seasonal baseline." }),
    frame("final", { sequence: 9, request_id: "req-1", answer, evidence_id: "evidence-7" }),
  ];
}

/* --------------------------------------------------------------------- harness */

/** A response whose body streams the given chunks. `close: false` never terminates. */
function streaming(chunks: string[], { close = true }: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, details: null, request_id: "req-1" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: Mock;

function renderAnalyst() {
  return render(
    <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input, init) => fetchMock(input, init)}>
      <Analyst />
    </SessionBoundary>,
  );
}

async function ask(question: string): Promise<void> {
  const composer = screen.getByLabelText("Your weather question");
  await userEvent.clear(composer);
  await userEvent.type(composer, question);
  await userEvent.click(screen.getByRole("button", { name: "Ask Weathra" }));
}

/** The bodies of every stream request made, parsed. */
function askedBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  window.localStorage.clear();
  fetchMock = vi.fn(async () => streaming(runFrames())) as unknown as Mock;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("asking a question", () => {
  it("shows what to enter before anything has been asked", () => {
    renderAnalyst();

    expect(screen.getByText("Ask Weathra a weather question")).toBeInTheDocument();
    expect(screen.getByLabelText("Your weather question")).toBeInTheDocument();
  });

  it("sends the question to the agent stream and shows it in the transcript", async () => {
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(new URL(url).pathname).toBe("/api/v1/agent/stream");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(String(init.body)).question).toBe(
      "What should I expect over the next few days in Berlin?",
    );

    expect(
      await screen.findByText("What should I expect over the next few days in Berlin?"),
    ).toBeInTheDocument();
  });

  it("submits from the keyboard alone", async () => {
    renderAnalyst();

    const composer = screen.getByLabelText("Your weather question");
    await userEvent.type(composer, "Why is the forecast uncertain further out?{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(askedBodies()[0]?.question).toBe("Why is the forecast uncertain further out?");
  });

  it("does not send an empty or whitespace-only question", async () => {
    renderAnalyst();

    const composer = screen.getByLabelText("Your weather question");
    expect(screen.getByRole("button", { name: "Ask Weathra" })).toBeDisabled();

    await userEvent.type(composer, "   {Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills the composer from a starter question rather than asking on its behalf", async () => {
    renderAnalyst();

    await userEvent.click(screen.getByRole("button", { name: "What should I expect over the next few days?" }));

    expect(screen.getByLabelText("Your weather question")).toHaveValue(
      "What should I expect over the next few days?",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a streamed answer", () => {
  it("renders the run's own steps, and no step the backend did not send", async () => {
    renderAnalyst();
    await ask("What should I expect?");

    const progress = await screen.findByRole("region", { name: "Run progress" });

    // Exactly the events `agents/graph.py` emits, in order.
    const rows = within(progress).getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Routing");
    expect(rows[0]).toContain("Forecast agent, Analytics agent");
    expect(rows[0]).toContain("planned by the model");
    expect(rows[1]).toContain("Forecast agent");
    expect(rows[2]).toContain("weather_forecast");
    expect(rows[3]).toContain("Synthesis");
    expect(rows).toHaveLength(4);

    // Nothing the stream did not report: no invented retrieval, reasoning or grounding stage.
    const shown = progress.textContent ?? "";
    for (const invented of ["Thinking", "Reasoning", "Grounding", "Retrieving data", "Analysing"]) {
      expect(shown, invented).not.toContain(invented);
    }
  });

  it("renders the model's prose in its own interpretation region, with the model that wrote it", async () => {
    renderAnalyst();
    await ask("What should I expect?");

    const panel = await screen.findByRole("region", { name: "AI interpretation" });
    expect(within(panel).getByText(/stay close to the seasonal baseline/)).toBeInTheDocument();
    expect(within(panel).getByText(/produced no measurement, forecast, or statistic/i)).toBeInTheDocument();
    expect(within(panel).getByText(/Model: openrouter · a-configured-model/)).toBeInTheDocument();
  });

  it("separates retrieved figures, deterministic analytics, and the model's language", async () => {
    const { container } = renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    expect(container.querySelectorAll('[data-tier="retrieved"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tier="computed"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tier="interpretation"]')).toHaveLength(1);

    // The forecast figure is badged FORECAST; the computed one is badged ANALYTICS.
    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    expect(within(retrieved).getByText("FORECAST")).toBeInTheDocument();
    expect(within(retrieved).getByRole("heading", { name: "Forecast figures" })).toBeInTheDocument();
    expect(within(retrieved).getByText("21.4 °C")).toBeInTheDocument();

    const computed = container.querySelector('[data-tier="computed"]') as HTMLElement;
    expect(within(computed).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(computed).getByRole("heading", { name: "Computed figures" })).toBeInTheDocument();
    expect(within(computed).getByText("17.9 °C")).toBeInTheDocument();
    // The claim on the face of the provenance line; the full deterministic sentence and the point
    // count are inside its disclosure, so this matches the summary exactly.
    expect(within(computed).getByText("Computed by Weathra")).toBeInTheDocument();
    expect(within(computed).getByText(/arithmetic mean of usable points/)).toBeInTheDocument();

    // Nothing numeric sits inside the model's region.
    const interpretation = container.querySelector('[data-tier="interpretation"]') as HTMLElement;
    expect(within(interpretation).queryByText("21.4 °C")).not.toBeInTheDocument();
  });

  it("attributes each figure to the provider, location, period and retrieval time the backend named", async () => {
    const { container } = renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    expect(retrieved.querySelector('[data-attribution="true"]')).toBeInTheDocument();
    expect(within(retrieved).getByText("open-meteo")).toBeInTheDocument();
    expect(within(retrieved).getByText("Berlin, Germany")).toBeInTheDocument();
    expect(within(retrieved).getByText(/2026-09-04 00:00 to 2026-09-07 00:00/)).toBeInTheDocument();
    expect(within(retrieved).getByText(/2026-09-04 06:15 UTC/)).toBeInTheDocument();
  });

  it("attributes the run to what produced it, and to no place or period it never had (2.11)", async () => {
    const { container } = renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const run = container.querySelector('[data-attribution-scope="model-run"]') as HTMLElement;
    expect(run).toBeInTheDocument();

    // What applies to a language-model run: the gateway, the model, and when it finished.
    expect(within(run).getByText("openrouter · a-configured-model")).toBeInTheDocument();
    expect(within(run).getByText("Completed")).toBeInTheDocument();

    // What does not, and used to print "not reported" under every answer.
    expect(within(run).queryByText("Location")).not.toBeInTheDocument();
    expect(within(run).queryByText("Period")).not.toBeInTheDocument();
    expect(within(run).queryByText(NOT_REPORTED)).not.toBeInTheDocument();
  });

  it("keeps all four weather fields on the figures inside the answer (2.11)", async () => {
    // The narrowing is about the run's own footer. Each retrieved figure is its own region with
    // its own weather footer, and that is where `specs/web-ui`'s requirement lives — untouched.
    const { container } = renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    const footer = retrieved.querySelector('[data-attribution="true"]') as HTMLElement;
    expect(footer).not.toHaveAttribute("data-attribution-scope");
    for (const term of ["Source", "Location", "Period", "Retrieved"]) {
      expect(within(footer).getByText(term), term).toBeInTheDocument();
    }
  });

  it("carries the forecast's uncertainty with its stated basis, and no invented precision", async () => {
    renderAnalyst();
    await ask("What should I expect?");

    expect(await screen.findByText("MODERATE CONFIDENCE")).toBeInTheDocument();
    expect(screen.getAllByText(/Confidence decreases with horizon distance/)[0]!).toBeInTheDocument();
    expect(screen.getByText(/48 h into the forecast horizon/)).toBeInTheDocument();
    expect(screen.getByText(/supplies no forecast spread/i)).toBeInTheDocument();
    // No percentage anywhere: Weathra reads one provider and has none to state.
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("states what the answer resolved to, and where the default came from", async () => {
    const { container } = renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    /*
     * A disclosure rather than a landmark region.
     *
     * The rail beside this column states the resolved place, window and unit system plainly, and
     * the runtime audit of 2026-09-08 photographed the same three lines twice on one screen. The
     * copy that travels with an individual answer opens on request; what it says is unchanged, and
     * that is what this asserts.
     */
    const resolved = container.querySelector(
      '[aria-label="What this answer resolved to"]',
    ) as HTMLElement;
    expect(resolved).not.toBeNull();
    expect(resolved.tagName.toLowerCase()).toBe("details");
    expect(within(resolved).getByText(/from your saved default/)).toBeInTheDocument();
    expect(within(resolved).getByText(/Berlin, Germany \(from the preferences\)/)).toBeInTheDocument();
    expect(within(resolved).getByText(/metric \(from the preferences\)/)).toBeInTheDocument();
  });

  it("shows the run record behind the answer with its identifiers", async () => {
    renderAnalyst();
    await ask("What should I expect?");

    await screen.findByRole("region", { name: "AI interpretation" });
    expect(screen.getByText(/Agents: Forecast agent \(succeeded\), Synthesis \(succeeded\)/)).toBeInTheDocument();
    expect(screen.getByText(/Tools: weather_forecast/)).toBeInTheDocument();
    expect(screen.getByText(/Knowledge cited: Reading a forecast horizon/)).toBeInTheDocument();
    expect(screen.getByText(/Request req-1 · evidence evidence-7/)).toBeInTheDocument();
  });

  /*
   * Task 21.5 completes the artifact's "View Full Agent Evidence" affordance, which task 21.2
   * deferred until the Agent Evidence screen and its route existed.
   */
  it("links to the full agent evidence using the identifier the backend sent", async () => {
    renderAnalyst();
    await ask("What should I expect?");

    const link = (await screen.findAllByRole("link", { name: "View full agent evidence" }))[0]!;
    expect(link).toHaveAttribute("href", "/evidence/evidence-7");
  });

  it("offers no evidence link when the backend could not store the record", async () => {
    fetchMock = vi.fn(async () =>
      streaming([
        ...runFrames().slice(0, -1),
        frame("final", { sequence: 9, request_id: "req-1", answer: ANSWER, evidence_id: null }),
      ]),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    await screen.findByRole("region", { name: "AI interpretation" });
    expect(screen.queryByRole("link", { name: "View full agent evidence" })).toBeNull();
    expect(
      screen.getByText(/evidence record could not be stored, so there is no full record to open/),
    ).toBeInTheDocument();
  });
});

describe("one question at a time", () => {
  it("disables the submit control while a run is in flight", async () => {
    fetchMock = vi.fn(async () => streaming(runFrames().slice(0, 2), { close: false })) as unknown as Mock;
    renderAnalyst();

    await ask("What should I expect?");
    await screen.findByRole("region", { name: "Run progress" });

    // Even with a new question typed, the control stays disabled and announces itself busy.
    await userEvent.type(screen.getByLabelText("Your weather question"), "And after that?");
    const submit = screen.getByRole("button", { name: "Working…" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
  });

  it("prevents a duplicate submission of the same question", async () => {
    fetchMock = vi.fn(async () => streaming(runFrames().slice(0, 2), { close: false })) as unknown as Mock;
    renderAnalyst();

    const composer = screen.getByLabelText("Your weather question");
    await userEvent.type(composer, "What should I expect?");

    const submit = screen.getByRole("button", { name: "Ask Weathra" });
    await userEvent.click(submit);
    await userEvent.click(submit);
    await userEvent.type(composer, "{Enter}");

    // One run, one inference call against somebody's allowance.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("a follow-up", () => {
  it("carries the thread the backend opened, so it resolves from the earlier turn", async () => {
    renderAnalyst();

    await ask("Compare Berlin and Munich this week.");
    await screen.findByRole("region", { name: "AI interpretation" });

    await ask("Which day is warmer?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [first, second] = askedBodies();
    // The first question opens a thread; the second is asked inside it.
    expect(first?.create_thread).toBe(true);
    expect(first?.thread_id).toBeUndefined();
    expect(second?.thread_id).toBe("thread-42");
    expect(second?.create_thread).toBeUndefined();

    // Both turns stay readable.
    expect(screen.getByText("Compare Berlin and Munich this week.")).toBeInTheDocument();
    expect(screen.getByText("Which day is warmer?")).toBeInTheDocument();
  });

  it("keeps the conversation in the backend's thread and nothing in browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderAnalyst();
    await ask("Compare Berlin and Munich this week.");
    await screen.findByRole("region", { name: "AI interpretation" });

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("when a run does not complete", () => {
  it("keeps what arrived, says the run did not complete, and offers a retry", async () => {
    // A stream that closes with no terminal event: the connection dropped.
    fetchMock = vi.fn(async () => streaming(runFrames().slice(0, 3))) as unknown as Mock;
    renderAnalyst();

    await ask("What should I expect?");

    expect(await screen.findByText("The run did not complete")).toBeInTheDocument();
    expect(screen.getByText(/What arrived is shown above/)).toBeInTheDocument();
    // What was received is still on screen.
    const progress = screen.getByRole("region", { name: "Run progress" });
    const rows = within(progress).getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows[1]).toContain("Forecast agent");
    // And nothing is stuck reporting itself as running.
    expect(within(progress).queryByText("Running")).not.toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Try again" });
    fetchMock.mockImplementation(async () => streaming(runFrames()));
    await userEvent.click(retry);

    expect(await screen.findByRole("region", { name: "AI interpretation" })).toBeInTheDocument();
    expect(askedBodies()).toHaveLength(2);
    expect(askedBodies()[1]?.question).toBe("What should I expect?");
  });

  it("shows the backend's own message for a reported failure, and no weather figure", async () => {
    fetchMock = vi.fn(async () =>
      streaming([
        frame("routing", { sequence: 1, request_id: "req-1", capabilities: ["forecast"], source: "model", reason: null }),
        frame("error", {
          sequence: 2,
          request_id: "req-1",
          code: "provider_unavailable",
          message: "The weather provider is unavailable.",
        }),
      ]),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    expect(await screen.findByText("The weather provider is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Request req-1")).toBeInTheDocument();
    // A failure is never dressed as weather.
    expect(screen.queryByRole("region", { name: "AI interpretation" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/°C|°F/);
  });

  it("reports an unreachable backend as unreachable rather than as an empty answer", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    expect(await screen.findByText("Weathra could not be reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("when the agent surface is not configured", () => {
  it("says what is unavailable and what still works, without naming any configuration", async () => {
    // The backend's own words, as of 2026-09-08. This screen renders the message it is given, so
    // the assertion below is really about the pair: a backend that leaked a variable name would
    // leak it here, which is exactly what production did — a signed-in visitor was told to "Check
    // OPENROUTER_API_KEY", an instruction they could not act on about a thing they should not have
    // to know exists. The earlier version of this test *required* that string to be displayed.
    fetchMock = vi.fn(async () =>
      refusal(
        503,
        "agent_not_configured",
        "Weather intelligence is temporarily unavailable. Forecasts, history, analytics, comparison and your saved locations are all unaffected.",
      ),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The AI Weather Analyst is unavailable");
    expect(notice).toHaveTextContent(/temporarily unavailable/);
    expect(notice).toHaveTextContent(/Dashboard, Historical Analytics, Compare Cities and Saved Locations/);
    // Not offered as a retry: the configuration has to change first.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("renders no configuration identifier even when the backend sends one", async () => {
    // Defence in depth rather than duplication. The screen does not compose this sentence, so the
    // only way it can show a variable name is by being handed one — and a future backend, an older
    // deployment mid-rollout, or a provider echoing its own error can all hand it one.
    fetchMock = vi.fn(async () =>
      refusal(
        503,
        "agent_not_configured",
        "The inference provider rejected the configured credential. Check OPENROUTER_API_KEY.",
      ),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    await screen.findByRole("alert");
    const rendered = document.body.textContent ?? "";
    for (const identifier of [
      "OPENROUTER_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DATABASE_URL",
      "environment variable",
    ]) {
      expect(rendered).not.toContain(identifier);
    }
  });
});

describe("when the session ends", () => {
  it("routes a refused stream to the shared expired-session state, not to a question failure", async () => {
    fetchMock = vi.fn(async () =>
      refusal(401, "token_expired", "The access token has expired."),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    const expired = await screen.findByRole("alert");
    expect(expired).toHaveTextContent(/Your session has expired/i);
    // The screen is replaced, so the failure never appears as a data or agent error.
    expect(screen.queryByLabelText("Your weather question")).not.toBeInTheDocument();
    expect(screen.queryByText("The access token has expired.")).not.toBeInTheDocument();
  });

  it("routes a mid-stream authentication error to the same state", async () => {
    fetchMock = vi.fn(async () =>
      streaming([
        frame("routing", { sequence: 1, request_id: "req-1", capabilities: ["forecast"], source: "model", reason: null }),
        frame("error", {
          sequence: 2,
          request_id: "req-1",
          code: "token_expired",
          message: "The access token expired while the run was in progress.",
        }),
      ]),
    ) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect?");

    const expired = await screen.findByRole("alert");
    expect(expired).toHaveTextContent(/Your session has expired/i);
  });
});

describe("what the browser is allowed to talk to", () => {
  it("calls the configured Weathra API and no inference gateway", async () => {
    renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input as string);
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      // Never an inference gateway, and never a weather provider, from the browser.
      expect(url.host).not.toMatch(/openrouter|openai|anthropic|open-meteo/i);
    }
  });

  it("shows no value the design artifact invented", async () => {
    renderAnalyst();
    await ask("What should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const shown = document.body.textContent ?? "";
    for (const sample of [
      "BER-CENTRAL-09",
      "Station BER-09",
      "Neural Agent",
      "v4.8",
      "98.2%",
      "94%",
      "14.2%",
      "GlobalWeatherOS",
      "ECMWF",
      "Dr. Aris Thorne",
      "Sources: 124 Nodes",
      "AGENT INTERPRETATION",
    ]) {
      expect(shown, sample).not.toContain(sample);
    }
  });
});

/* ------------------------------------------------------- task 21.7: ambiguity */

/**
 * An ambiguous place named inside a question — task 21.7.
 *
 * The Analyst takes a location the way it takes everything else: inside natural language, resolved
 * by the orchestrator. `specs/agent-orchestration` requires it to *ask* rather than assume when a
 * name resolves ambiguously, and the answer envelope carries that as `clarification_question`
 * naming the candidates — so the surface has no separate chooser to build, and what matters is that
 * it asks and reports no figure.
 */
describe("an ambiguous place named in a question", () => {
  it("asks which place was meant, naming the candidates, and reports no weather figure", async () => {
    const clarifying = {
      ...ANSWER,
      answer_prose: "",
      findings: [],
      attribution: [],
      uncertainty: null,
      resolved: null,
      clarification_question:
        "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US. Which did you mean? Weathra does not pick one for you.",
      grounding: {
        verified: false,
        method: "figure extraction with a 0.05 tolerance",
        figures_checked: 0,
        note: "Weathra asked for a clarification instead of answering.",
      },
    };

    fetchMock = vi.fn(async () => streaming(runFrames(clarifying))) as unknown as Mock;
    renderAnalyst();
    await ask("How warm is Springfield tomorrow?");

    const asked = await screen.findByText(/Which did you mean\?/);
    expect(asked).toBeInTheDocument();
    expect(screen.getByText("Weathra needs to know")).toBeInTheDocument();
    expect(screen.getByText(/Springfield, Illinois, US or Springfield, Missouri, US/)).toBeInTheDocument();

    // No figure, no forecast, no attribution: nothing was answered for an unchosen place.
    expect(screen.queryByText("21.4 °C")).toBeNull();
    expect(screen.queryByText("17.9 °C")).toBeNull();
    expect(screen.queryByRole("region", { name: "Forecast figures" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Computed figures" })).toBeNull();
  });
});
