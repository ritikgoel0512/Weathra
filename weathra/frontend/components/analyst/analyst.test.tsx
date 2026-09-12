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

function refusal(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): Response {
  return new Response(JSON.stringify({ error: { code, message, details, request_id: "req-1" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: Mock;

/**
 * The two reads the focus band makes, answered as themselves.
 *
 * The screen now shows the context a question will be answered in — the default location, the unit
 * system, the horizon, and the current reading there — before anything is asked. Those are ordinary
 * authenticated GETs, so the harness answers them rather than handing them the SSE body every call
 * used to get. Everything else still goes to the stream.
 *
 * Returning JSON here is what keeps the assertions below about *the stream*: `streamCalls()` is the
 * count that matters to every case that counts calls, and a context read is not one.
 */
const PREFERENCES = {
  unit_system: "metric",
  forecast_horizon_days: 3,
  default_location: BERLIN,
  sources: { unit_system: "chosen", default_location: "chosen", forecast_horizon_days: "default" },
};

const CURRENT = {
  attribution: { ...FORECAST_SOURCE, data_class: "current" },
  observed_at_utc: "2026-09-04T06:15:00Z",
  observed_at_local: "2026-09-04T08:15:00+02:00",
  units: { temperature: "°C", relative_humidity: "%" },
  values: { temperature: 15.3, relative_humidity: 68 },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The default handler: context reads answered, the question streamed. */
function defaultFetch(input: unknown): Response {
  const path = new URL(String(input)).pathname;
  if (path === "/api/v1/me/preferences") return json(PREFERENCES);
  if (path === "/api/v1/weather/current") return json(CURRENT);
  return streaming(runFrames());
}

/**
 * A fetch that answers the context reads and gives the stream to the handlers, in order.
 *
 * Cases that need a particular stream outcome used to replace `fetchMock` outright, which worked
 * while every call this screen made *was* the stream. It no longer is — a blanket handler would
 * hand the preferences read an SSE body, and a `mockImplementationOnce` chain would be consumed by
 * it before the question was ever asked. So the routing lives here, and a case names only the
 * stream responses it cares about; the last one repeats for any further question.
 */
function respondingWith(...handlers: readonly (() => Response)[]): Mock {
  let asked = 0;
  return vi.fn(async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/me/preferences") return json(PREFERENCES);
    if (path === "/api/v1/weather/current") return json(CURRENT);
    const handler = handlers[Math.min(asked, handlers.length - 1)];
    asked += 1;
    return handler?.() ?? streaming(runFrames());
  }) as unknown as Mock;
}

/** Every call to the agent stream. What "did it ask?" means, now that context is read too. */
function streamCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([url]) => new URL(String(url)).pathname === "/api/v1/agent/stream",
  );
}

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
  return streamCalls().map(
    ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  window.localStorage.clear();
  fetchMock = vi.fn(async (input: unknown) => defaultFetch(input)) as unknown as Mock;
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

  it("says what the next question will be answered with, before anything is asked", async () => {
    renderAnalyst();

    /*
     * **The band became a line.** This used to be a photographic focus card carrying the place, its
     * units, its horizon and a strip of its current readings — about 340 pixels above the
     * conversation, on a screen whose subject is the conversation, and nothing
     * `02-ai-weather-analyst.png` draws. Task 34.32 replaced it with the artifact's own centred
     * context pill.
     *
     * Nothing the band asserted is lost. The place and the units are the composer's FOCUS row on
     * every question and the rail's Analyst context on every answer; the current reading is the
     * Dashboard's, which is one press away. What this case still holds is the part that matters:
     * the screen says what the next question resolves against, and it says it without a request to
     * a language model.
     */
    expect(
      await screen.findByText("Using your saved location and units."),
    ).toBeInTheDocument();

    const composer = screen.getByRole("form", { name: "Ask Weathra a weather question" });
    expect(within(composer).getByText("Berlin, Germany")).toBeInTheDocument();
    expect(within(composer).getByText("metric")).toBeInTheDocument();

    // And opening the screen has still asked nothing of a language model.
    expect(streamCalls()).toHaveLength(0);
  });

  it("says so plainly when there is no default location, and still takes a question", async () => {
    fetchMock = vi.fn(async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me/preferences") {
        return json({ ...PREFERENCES, default_location: null });
      }
      return defaultFetch(input);
    }) as unknown as Mock;

    renderAnalyst();

    /*
     * The state that matters most on this screen: Weathra never guesses a place, so somebody with
     * no saved default has to be told that in a sentence rather than by an answer that refuses.
     */
    expect(
      await screen.findByText("Name a place in your question — Weathra never guesses one."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your weather question")).toBeEnabled();
  });



  it("sends the question to the agent stream and shows it in the transcript", async () => {
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");

    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const [url, init] = streamCalls()[0] as [string, RequestInit];

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

    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    expect(askedBodies()[0]?.question).toBe("Why is the forecast uncertain further out?");
  });

  it("does not send an empty or whitespace-only question", async () => {
    renderAnalyst();

    const composer = screen.getByLabelText("Your weather question");
    expect(screen.getByRole("button", { name: "Ask Weathra" })).toBeDisabled();

    await userEvent.type(composer, "   {Enter}");
    expect(streamCalls()).toHaveLength(0);
  });

  it("fills the composer from a starter question rather than asking on its behalf", async () => {
    renderAnalyst();

    await userEvent.click(screen.getByRole("button", { name: "What should I expect over the next few days?" }));

    expect(screen.getByLabelText("Your weather question")).toHaveValue(
      "What should I expect over the next few days?",
    );
    // Filling the composer is not asking: no model call, no allowance spent.
    expect(streamCalls()).toHaveLength(0);
  });
});

describe("a streamed answer", () => {
  it("renders the run's own steps, and no step the backend did not send", async () => {
    /*
     * **On a run that produced no answer**, which is the only state that still shows this list.
     *
     * Task 34.32 took the progress region out from under completed replies: it rendered as a titled
     * "RUN PROGRESS · 8 steps" block below every answer, on a screen that already links to the
     * whole trace, and the customer-level review of 2026-09-11 named it. A run that produced
     * nothing keeps it, because then the steps are the only account of what happened — and that is
     * the case this exercises. What the list may contain is unchanged and is what this asserts.
     */
    // Every frame but the `final`, so the stream ends with the steps and no answer.
    fetchMock = vi.fn(async () => streaming(runFrames().slice(0, -1))) as unknown as Mock;

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

    /*
      **The panel, and the answer around it.** Task 34.32 moved the model attribution off the face
      of the reply and into its "Answer details" disclosure: `02-ai-weather-analyst.png` opens on
      the answer, and a customer reading one should not meet "Policy: free_default" before the
      weather. It is still on this screen, still the backend's own strings, and still asserted —
      one disclosure deeper.
    */
    const panel = await screen.findByRole("region", { name: "AI interpretation" });
    const answer = panel.closest("article")!;
    expect(within(panel).getByText(/stay close to the seasonal baseline/)).toBeInTheDocument();
    expect(within(panel).getByText(/produced no measurement, forecast, or statistic/i)).toBeInTheDocument();
    expect(within(answer).getByText(/Model: openrouter · a-configured-model/)).toBeInTheDocument();
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
    /*
      The artifact titles this panel FORECAST VECTOR and its neighbour OBSERVED DATA; task 34.32
      uses "Forecast" and "Observed data", which is the same role said the way Weathra says it. The
      badge, the tier and the attribution are what this case is actually about and are unchanged.
    */
    expect(within(retrieved).getByRole("heading", { name: "Forecast" })).toBeInTheDocument();
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
    // Named in the attribution summary and again in the row it opens to; both are inside this
    // region, which is what this asserts.
    expect(within(retrieved).getAllByText("open-meteo").length).toBeGreaterThanOrEqual(1);
    expect(within(retrieved).getByText("Berlin, Germany")).toBeInTheDocument();
    expect(within(retrieved).getByText(/2026-09-04 00:00 to 2026-09-07 00:00/)).toBeInTheDocument();
    expect(within(retrieved).getAllByText(/2026-09-04 06:15 UTC/).length).toBeGreaterThanOrEqual(1);
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

    /*
      The compact treatment the frozen Dashboard settled: the band and how far out it is graded on
      the face of it, the basis and the no-spread note behind the control on the same line. Both are
      still rendered — `UncertaintyIndicator` keeps `basis` required — and both are still asserted.
    */
    expect(await screen.findByText("MODERATE CONFIDENCE")).toBeInTheDocument();
    expect(screen.getByText(/48 h ahead/)).toBeInTheDocument();
    expect(screen.getAllByText(/Confidence decreases with horizon distance/)[0]!).toBeInTheDocument();
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
      '[aria-label="Answer details"]',
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
    fetchMock = respondingWith(() => streaming(runFrames().slice(0, 2), { close: false }));
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
    fetchMock = respondingWith(() => streaming(runFrames().slice(0, 2), { close: false }));
    renderAnalyst();

    const composer = screen.getByLabelText("Your weather question");
    await userEvent.type(composer, "What should I expect?");

    const submit = screen.getByRole("button", { name: "Ask Weathra" });
    await userEvent.click(submit);
    await userEvent.click(submit);
    await userEvent.type(composer, "{Enter}");

    // One run, one inference call against somebody's allowance.
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
  });
});

describe("a follow-up", () => {
  it("carries the thread the backend opened, so it resolves from the earlier turn", async () => {
    renderAnalyst();

    await ask("Compare Berlin and Munich this week.");
    await screen.findByRole("region", { name: "AI interpretation" });

    await ask("Which day is warmer?");
    await waitFor(() => expect(streamCalls()).toHaveLength(2));

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
    fetchMock.mockImplementation(async (input: unknown) => defaultFetch(input));
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
    // Only the stream refuses. The context reads succeed, so what reaches the boundary is
    // unambiguously the question's own 401 rather than any read the screen happens to make.
    fetchMock = respondingWith(() => refusal(401, "token_expired", "The access token has expired."));

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
    /*
      **The clarification is a turn in the conversation, not a heading over a report.** Production
      titled it "Weathra needs to know" and then rendered the whole apparatus underneath — an empty
      observed card, an empty forecast card, "0 figure(s) checked", the model and policy
      identifiers and a run-progress strip. Task 34.32 shows the agent's own question, why Weathra
      will not guess a place, and the two ways to answer it.
    */
    expect(screen.getByText(/Weathra does not guess a location/)).toBeInTheDocument();
    expect(screen.getByText(/Springfield, Illinois, US or Springfield, Missouri, US/)).toBeInTheDocument();

    // No figure, no forecast, no attribution: nothing was answered for an unchosen place.
    expect(screen.queryByText("21.4 °C")).toBeNull();
    expect(screen.queryByText("17.9 °C")).toBeNull();
    expect(screen.queryByRole("region", { name: "Forecast figures" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Computed figures" })).toBeNull();
  });
});

/* ------------------------------------------------ the exhausted allowance (33.5) */

/**
 * The refusal `weathra/entitlements/quotas.py` sends, and the route sends it *before* the stream
 * opens: `specs/usage-limits` requires an exhausted caller's stream to be refused rather than
 * opened and terminated mid-answer, so this arrives as a 429 on the POST rather than as an error
 * event.
 */
const QUOTA_DETAILS = {
  dimension: "requests_per_day",
  window: "day",
  allowance: 20,
  consumed: 20,
  resets_at: "2026-09-10T00:00:00Z",
  retry_after_seconds: 16_200,
};

const QUOTA_MESSAGE =
  "You have used today's allowance of agent questions. It resets at the start of the next day. " +
  "Forecasts, history, comparisons and analysis are unaffected.";

function quotaRefusal(): Response {
  return refusal(429, "quota_exceeded", QUOTA_MESSAGE, QUOTA_DETAILS);
}

describe("an exhausted allowance", () => {
  it("is its own state, naming the limit and when it resets", async () => {
    fetchMock = respondingWith(() => quotaRefusal());
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const state = await waitFor(() => {
      const found = document.querySelector('[data-quota="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(state).getByText("Allowance used")).toBeInTheDocument();
    expect(within(state).getByText(/used your plan.s allowance/i)).toBeInTheDocument();
    // The backend's own sentence, which names the window and what stays available.
    expect(within(state).getByText(QUOTA_MESSAGE)).toBeInTheDocument();
    // The limit, from the refusal's figures.
    expect(within(state).getByText("20 of 20 questions today")).toBeInTheDocument();
    // The reset, from the refusal's instant.
    expect(within(state).getByText("2026-09-10 00:00 UTC")).toBeInTheDocument();
  });

  it("is not a weather error and not a failed run", async () => {
    fetchMock = respondingWith(() => quotaRefusal());
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    await waitFor(() => expect(document.querySelector('[data-quota="true"]')).not.toBeNull());

    // The generic error state's own title, which a 429 must never reach.
    expect(screen.queryByText("That question did not complete")).toBeNull();
    expect(screen.queryByText("Weathra could not be reached")).toBeNull();
    expect(screen.queryByText("The run did not complete")).toBeNull();
    // Structurally distinct too: the error state is an alert, the allowance is not a failure.
    expect(screen.queryByRole("alert")).toBeNull();
    // And it does not claim the provider failed. The state says the opposite in as many words —
    // "nothing went wrong with Weathra or with the inference provider" — so what is asserted here
    // is the absence of a failure claim, not the absence of the word.
    const state = document.querySelector('[data-quota="true"]') as HTMLElement;
    expect(state.textContent).not.toMatch(/provider (failed|is unavailable|error)/i);
    expect(state.textContent).not.toMatch(/unavailable/i);
    expect(screen.queryByText("The AI Weather Analyst is unavailable")).toBeNull();
  });

  it("is not an expired session: the person stays signed in", async () => {
    fetchMock = respondingWith(() => quotaRefusal());
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    await waitFor(() => expect(document.querySelector('[data-quota="true"]')).not.toBeNull());

    // The expired-session state replaces the screen; a quota refusal must not.
    expect(screen.queryByText(/session/i)).toBeNull();
    expect(screen.getByLabelText("Your weather question")).toBeEnabled();
  });

  it("names no configuration and offers no retry that would be refused again", async () => {
    fetchMock = respondingWith(() => quotaRefusal());
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const state = await waitFor(() => {
      const found = document.querySelector('[data-quota="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // No environment variable, no secret, no internal identifier.
    expect(state.textContent).not.toMatch(/[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/);
    // A day's allowance does not lift by pressing a button, so none is offered.
    expect(within(state).queryByRole("button")).toBeNull();
  });

  it("offers to ask again only where waiting can change the answer", async () => {
    fetchMock = vi.fn(async () =>
      refusal(429, "quota_exceeded", "You already have as many questions in flight as your plan allows.", {
        dimension: "concurrent_runs",
        window: "concurrent",
        allowance: 2,
        consumed: 2,
        resets_at: null,
      }),
    ) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const state = await waitFor(() => {
      const found = document.querySelector('[data-quota="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(state).getByRole("button", { name: "Ask again" })).toBeInTheDocument();
    expect(within(state).getByText("As soon as one of your questions finishes.")).toBeInTheDocument();
  });

  it("leaves the thread and the answer already on screen intact", async () => {
    // One answered question, then a refusal. The spec requires the person's thread to survive.
    fetchMock = respondingWith(
      () => streaming(runFrames()),
      () => quotaRefusal(),
    );

    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByText(ANSWER.answer_prose);

    await ask("And the week after?");
    await waitFor(() => expect(document.querySelector('[data-quota="true"]')).not.toBeNull());

    // The earlier answer is still there, and so is its evidence link.
    expect(screen.getByText(ANSWER.answer_prose)).toBeInTheDocument();
    // The thread the backend opened was still sent with the refused question, so the conversation
    // was not discarded — the refusal ends one request, not the thread.
    expect(askedBodies()[1]?.thread_id).toBe("thread-42");
  });

  it("still distinguishes a gateway rate limit from a plan limit", async () => {
    // Same 429. Different code, different meaning, different state.
    fetchMock = respondingWith(() =>
      refusal(429, "provider_rate_limited", "The inference gateway is rate limiting requests."),
    );
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    await screen.findByText("That question did not complete");
    expect(document.querySelector('[data-quota="true"]')).toBeNull();
  });
});

/* --------------------------------------------- what actually served it (33.6) */

/** A run whose policy layer reported everything it can report. */
const SERVED_ATTEMPTS = [
  {
    stage: "routing",
    status: "served",
    attempt_number: 1,
    provider: "openrouter",
    selected_model: "a-routing-model",
    served_model: "a-routing-model",
    catalog_key: "a-routing-model",
    policy_id: "free-routing",
    plan: "free",
    resolution_reason: "First enabled candidate of the plan's routing policy.",
    latency_ms: 210,
  },
  {
    stage: "synthesis",
    status: "served",
    attempt_number: 1,
    provider: "openrouter",
    selected_model: "a-synthesis-model",
    served_model: "a-synthesis-model",
    catalog_key: "a-synthesis-model",
    policy_id: "free-synthesis",
    plan: "free",
    resolution_reason: "First enabled candidate of the plan's synthesis policy.",
    latency_ms: 903,
  },
];

function answerServedBy(attempts: unknown[], envelope: Record<string, unknown> = {}) {
  return {
    ...ANSWER,
    ...envelope,
    evidence: { ...EVIDENCE, inference_attempts: attempts },
  };
}

describe("what actually served the answer", () => {
  it("shows the provider, model and policy the backend reported", async () => {
    fetchMock = vi.fn(async () =>
      streaming(runFrames(answerServedBy(SERVED_ATTEMPTS))),
    ) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // The synthesis attempt's values — the call that wrote the prose being read.
    expect(within(answer).getByText("Model: openrouter · a-synthesis-model")).toBeInTheDocument();
    expect(within(answer).getByText("Policy: free-synthesis")).toBeInTheDocument();
    expect(
      within(answer).getByText("Resolved: First enabled candidate of the plan's synthesis policy."),
    ).toBeInTheDocument();
  });

  it("renders whatever the response says, rather than a value written into the screen", async () => {
    // The same run with different reported values renders differently. Nothing here is a constant:
    // a hardcoded model name would pass the assertion above and fail this one.
    const relabelled = SERVED_ATTEMPTS.map((attempt) => ({
      ...attempt,
      provider: "another-gateway",
      selected_model: "another-model",
      served_model: "another-model",
      policy_id: "premium-synthesis",
    }));

    fetchMock = vi.fn(async () => streaming(runFrames(answerServedBy(relabelled)))) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(answer).getByText("Model: another-gateway · another-model")).toBeInTheDocument();
    expect(within(answer).getByText("Policy: premium-synthesis")).toBeInTheDocument();
    // Not the configured pair the envelope also carries.
    /*
      Not the configured pair, on the line that names what *served* it. The run record's own
      "Produced by" footer inside the evidence summary reports the configured client and is a
      different statement about a different thing — which is why this pins the `Model:` line rather
      than the string anywhere in the reply.
    */
    expect(within(answer).queryByText(/^Model:.*a-configured-model/)).toBeNull();
  });

  it("prefers what the record says over what was configured", async () => {
    // `llm_provider` and `llm_model` name the *configured* client and are not evidence that it
    // answered. When the record holds an attempt, the attempt wins.
    fetchMock = vi.fn(async () =>
      streaming(
        runFrames(
          answerServedBy(SERVED_ATTEMPTS, {
            llm_provider: "the-configured-gateway",
            llm_model: "the-configured-model",
          }),
        ),
      ),
    ) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(answer).getByText("Model: openrouter · a-synthesis-model")).toBeInTheDocument();
    expect(within(answer).queryByText(/^Model:.*the-configured-model/)).toBeNull();
    expect(answer.querySelector('[data-served="true"]')).not.toBeNull();
  });

  it("says a substituted model was substituted", async () => {
    const substituted = [
      { ...SERVED_ATTEMPTS[1], selected_model: "asked-for-this", served_model: "got-that-instead" },
    ];

    fetchMock = vi.fn(async () => streaming(runFrames(answerServedBy(substituted)))) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(answer).getByText("Model: openrouter · got-that-instead")).toBeInTheDocument();
    expect(
      within(answer).getByText("Requested: asked-for-this, substituted by the gateway"),
    ).toBeInTheDocument();
  });

  it("labels the configured pair as configured when no attempt served", async () => {
    fetchMock = vi.fn(async () =>
      streaming(runFrames(answerServedBy([{ ...SERVED_ATTEMPTS[1], status: "timeout", served_model: null }]))),
    ) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(
      within(answer).getByText(/Model: openrouter · a-configured-model \(configured/),
    ).toBeInTheDocument();
    expect(within(answer).queryByText(/^Policy:/)).toBeNull();
  });

  it("reports no policy where the backend reported none", async () => {
    // The policy fields are nullable on the backend on purpose. A run from before the policy layer
    // filled them has no policy, and the screen must not derive one from the plan or the model.
    const unpolicied = [
      { ...SERVED_ATTEMPTS[1], policy_id: null, catalog_key: null, plan: null, resolution_reason: null },
    ];

    fetchMock = vi.fn(async () => streaming(runFrames(answerServedBy(unpolicied)))) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");

    const answer = await waitFor(() => {
      // The reply around the interpretation region: task 34.32 keeps the model attribution on this
      // screen and puts it in the answer's own details rather than under the prose.
      const found = document.querySelector('[data-interpretation="true"]')?.closest("article");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(answer).getByText("Model: openrouter · a-synthesis-model")).toBeInTheDocument();
    expect(within(answer).queryByText(/^Policy:/)).toBeNull();
    expect(within(answer).queryByText(/^Resolved:/)).toBeNull();
    expect(answer.querySelector("[data-policy]")).toBeNull();
  });

  it("never asks for a model, a plan, a policy or an entitlement", async () => {
    /*
     * "The UI never decides which model serves a request" — and the strongest form of that is that
     * it has nothing to decide it *with*. There is no premium control on this screen, hidden or
     * otherwise, because there is no client-held plan or model value anywhere in the request: the
     * body carries the question, the units and the thread, and `AskRequest` on the backend forbids
     * extra fields, so a client that invented one would be refused rather than obeyed.
     *
     * This is what "a hidden control is not the gate" reduces to while no such control exists. When
     * one is added, this assertion is the one that fails if it is wired to a client-held plan.
     */
    fetchMock = vi.fn(async () => streaming(runFrames(answerServedBy(SERVED_ATTEMPTS)))) as unknown as Mock;
    renderAnalyst();
    await ask("What should I expect tomorrow?");
    await screen.findByText(ANSWER.answer_prose);

    const permitted = ["create_thread", "question", "thread_id", "units"];
    expect(askedBodies().length).toBeGreaterThan(0);
    for (const body of askedBodies()) {
      for (const field of Object.keys(body)) {
        expect(permitted, `the request carried ${field}`).toContain(field);
      }
      for (const forbidden of ["model", "plan", "policy", "policy_id", "catalog_key", "premium", "tier"]) {
        expect(body, forbidden).not.toHaveProperty(forbidden);
      }
    }
  });
});
