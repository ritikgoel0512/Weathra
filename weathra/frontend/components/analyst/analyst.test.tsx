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
      await screen.findByText("Using Berlin, Germany, your saved default."),
    ).toBeInTheDocument();

    /*
     * And the composer's FOCUS says the same thing, as the control rather than as a caption — the
     * saved default is offered as what will apply, labelled as the default it is. Pressing it is
     * how a person points the conversation somewhere else, which the cases below exercise.
     */
    const composer = screen.getByRole("form", { name: "Ask Weathra a weather question" });
    expect(within(composer).getByRole("button", { name: /Berlin, Germany/ })).toBeInTheDocument();
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
      await screen.findByText(
        "Name a place in your question, or choose one below — Weathra never guesses.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your weather question")).toBeEnabled();

    /*
     * "Or choose one below" has to be true. Before task 34.33 this sentence was the whole of what
     * an account with no default was offered, and the only place to act on it was Settings.
     */
    const composer = screen.getByRole("form", { name: "Ask Weathra a weather question" });
    expect(within(composer).getByRole("button", { name: "Choose a place" })).toBeEnabled();
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
    /*
      The artifact's highlighted box is headed AGENT INTERPRETATION over a causal reading of an
      atmosphere Weathra does not model. What sits in that position here is the arithmetic, so the
      heading names the role — the analyst's own reading — and the badge beside it still names the
      class that produced it.
    */
    expect(
      within(computed).getByRole("heading", { name: "Analyst interpretation" }),
    ).toBeInTheDocument();
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

    /*
      **No percentage on a confidence, here or in the rail.**

      The artifact prints "94%" beside its forecast and "SYNTHESIS CONFIDENCE 98.2%" in its rail,
      and neither is a figure any endpoint produces. The assertion used to be that no percentage
      appeared anywhere in the document, which was the right guard while nothing on this screen
      could honestly be a proportion. One thing now can — the rail's data-coverage bar counts the
      run's own findings — so the guard says what it always meant: a *confidence* is a band, and
      nowhere on this screen is one expressed as a percentage.
    */
    const indicator = document.querySelector('[data-uncertainty="true"]') as HTMLElement;
    expect(indicator.textContent).not.toMatch(/\d+(\.\d+)?%/);
    const railConfidence = screen.getByRole("region", { name: "Confidence and grounding" });
    expect(within(railConfidence).getByText(/moderate at 48 h/)).toBeInTheDocument();
    expect(
      within(railConfidence).getByText(/moderate at 48 h/).textContent,
    ).not.toMatch(/\d+(\.\d+)?%/);
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
    expect(
      screen.getByText(/Weathra does not guess a place, and does not read one from your device/),
    ).toBeInTheDocument();
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

/* -------------------------------------- task 34.33: focus, and a resumable clarification */

/**
 * The customer-level defects the 2026-09-12 review reopened this screen for.
 *
 * All of them were one gap wearing several faces: the Analyst could refuse to guess a place, and
 * could not be told one. An account with no saved default asked "what should I expect over the next
 * few days?", got a correct refusal to invent a city, and had nowhere to go but Settings on another
 * screen — after which the question had to be retyped. The rail called that run COMPLETE.
 *
 * So these cases are about the *conversation*, not the layout: that a place can be chosen here,
 * that choosing one finishes the question that was already asked, that the choice travels with
 * every following question, that naming a place still overrides it, and that a run which retrieved
 * nothing is never dressed as one that finished.
 */

/**
 * The frames a clarification run emits: routing, and then the answer.
 *
 * No `agent_start`, no `tool_start`, no retrieval — which is the point. Resolution refuses before
 * any capability node runs, so a run that asked for a place names no agents and queried no
 * provider, and the rail has to be able to say that without inventing an explanation for it.
 */
function clarifyingFrames(answer: unknown): string[] {
  return [
    frame("routing", {
      sequence: 1,
      request_id: "req-1",
      capabilities: ["forecast"],
      source: "model",
      reason: "The question asks about the days ahead.",
    }),
    frame("final", { sequence: 2, request_id: "req-1", answer, evidence_id: "evidence-8" }),
  ];
}

/** A clarification run: the agent asked for a place, and nothing at all was retrieved. */
const NEEDS_LOCATION = {
  ...ANSWER,
  answer_prose: "",
  findings: [],
  attribution: [],
  uncertainty: null,
  resolved: {
    locations: [],
    period: null,
    unit_system: "metric",
    location_source: "none",
    units_source: "preferences",
    statement: null,
  },
  clarification_question:
    "Which place should Weathra look at? The question does not name one, there is no location established in this conversation, and no default location is saved.",
  grounding: {
    verified: false,
    method: "figure extraction with a 0.05 tolerance",
    figures_checked: 0,
    note: "Weathra asked for a clarification instead of answering.",
  },
};

const MUNICH = {
  display_name: "Munich, Germany",
  latitude: 48.1374,
  longitude: 11.5755,
  timezone: "Europe/Berlin",
  country: "Germany",
};

const SAVED = {
  count: 2,
  limit: 10,
  locations: [
    { id: "saved-1", label: null, location: BERLIN },
    { id: "saved-2", label: null, location: MUNICH },
  ],
};

/**
 * A fetch with no saved default, the saved places present, and the streams named in order.
 *
 * "No default" is the state every case here starts in, because it is the state the review was
 * written against and the one the old screen had no answer for.
 */
function withoutADefault(...handlers: readonly (() => Response)[]): Mock {
  let asked = 0;
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/me/preferences") {
      return json({ ...PREFERENCES, default_location: null });
    }
    if (url.pathname === "/api/v1/me/locations") return json(SAVED);
    if (url.pathname === "/api/v1/weather/current") return json(CURRENT);
    if (url.pathname === "/api/v1/locations/resolve") {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      if (query.includes("munich")) return json({ kind: "resolved", location: MUNICH });
      if (query.includes("berlin")) return json({ kind: "resolved", location: BERLIN });
      return new Response(
        JSON.stringify({
          error: { code: "location_not_found", message: `No location matched ${query}`, request_id: "req-1" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const handler = handlers[Math.min(asked, handlers.length - 1)];
    asked += 1;
    return handler?.() ?? streaming(runFrames());
  }) as unknown as Mock;
}

/** Open the composer's FOCUS chooser and press a saved place. */
async function chooseFocus(name: string | RegExp): Promise<void> {
  const composer = screen.getByRole("form", { name: "Ask Weathra a weather question" });
  await userEvent.click(within(composer).getByRole("button", { name: /Choose a place|Berlin|Munich/ }));
  await userEvent.click(await screen.findByRole("button", { name }));
}

describe("the conversation's focus", () => {
  it("sends the chosen place with the question, pinned by the coordinates it resolved to", async () => {
    fetchMock = withoutADefault();
    renderAnalyst();

    await chooseFocus("Munich, Germany");
    await ask("What should I expect over the next few days?");

    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    /*
      The name *and* the coordinates. The pair is what makes a client-chosen place safe for the
      backend to accept — the name carries the identity and the coordinates choose among the
      geocoder's candidates for it — and it is the same mechanism a saved default is pinned by.
      Sending the name alone would make "Springfield" ambiguous again at the far end.
    */
    expect(askedBodies()[0]).toMatchObject({
      question: "What should I expect over the next few days?",
      location: "Munich, Germany",
      latitude: MUNICH.latitude,
      longitude: MUNICH.longitude,
    });
  });

  it("carries the focus into every following question, so a follow-up stays on the same place", async () => {
    fetchMock = withoutADefault();
    renderAnalyst();

    await chooseFocus("Berlin, Germany");
    await ask("What should I expect over the next few days?");
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

    await ask("How does that compare with the same week last year?");
    await waitFor(() => expect(streamCalls()).toHaveLength(2));

    // The thread carries the conversation; the focus is sent again because the backend evaluates
    // precedence per run — a question naming Munich has to be able to beat it.
    expect(askedBodies()[1]).toMatchObject({
      question: "How does that compare with the same week last year?",
      thread_id: "thread-42",
      location: "Berlin, Germany",
    });
  });

  it("still lets a place named in the question override the focus", async () => {
    fetchMock = withoutADefault();
    renderAnalyst();

    await chooseFocus("Berlin, Germany");
    await ask("How about Munich?");
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

    /*
      Both facts travel, and the *backend* decides between them — `agents/context.py` puts a place
      named in the question above the focus. The screen deciding locally would be a second copy of
      that precedence, free to disagree with the one that matters.
    */
    const body = askedBodies()[0]!;
    expect(body.question).toBe("How about Munich?");
    expect(body.location).toBe("Berlin, Germany");
  });

  it("drops the focus when a new analysis starts, and leaves the saved default alone", async () => {
    // This account *has* a saved default of Berlin, and the conversation is pointed at Munich.
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/me/locations") return json(SAVED);
      return defaultFetch(input);
    }) as unknown as Mock;
    renderAnalyst();

    await chooseFocus("Munich, Germany");
    expect(
      await screen.findByText(/Focused on Munich, Germany/),
    ).toBeInTheDocument();

    await ask("What should I expect over the next few days?");
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "New analysis" }));

    /*
      Two lifetimes, kept apart. The focus is this conversation's and goes with it; the saved
      default is a durable preference this screen never writes, so it is still what the composer
      offers afterwards. Clearing somebody's configured default because they pressed "New analysis"
      would be this screen editing a Settings value nobody asked it to touch.
    */
    expect(
      await screen.findByText("Using Berlin, Germany, your saved default."),
    ).toBeInTheDocument();
  });
});

describe("a clarification that is waiting for a place", () => {
  it("offers the saved places, and pressing one runs the question that was already asked", async () => {
    fetchMock = withoutADefault(
      () => streaming(clarifyingFrames(NEEDS_LOCATION)),
      () => streaming(runFrames()),
    );
    renderAnalyst();

    await ask("What should I expect over the next few days?");
    expect(await screen.findByText(/Which place should Weathra look at\?/)).toBeInTheDocument();

    // The saved places are offered *here*, not as a link to another screen.
    await userEvent.click(await screen.findByRole("button", { name: "Munich, Germany" }));

    /*
      **The required behaviour.** The second call is the *original* question, for Munich — not
      "Munich" asked as a question, and not a question the person had to retype. Somebody who has
      said what they want does not say it again because the system needed an argument.
    */
    await waitFor(() => expect(streamCalls()).toHaveLength(2));
    expect(askedBodies()[1]).toMatchObject({
      question: "What should I expect over the next few days?",
      location: "Munich, Germany",
    });
  });

  it("resumes the pending question when a place is typed as the reply", async () => {
    fetchMock = withoutADefault(
      () => streaming(clarifyingFrames(NEEDS_LOCATION)),
      () => streaming(runFrames()),
    );
    renderAnalyst();

    await ask("What should I expect over the next few days?");
    expect(await screen.findByText(/Which place should Weathra look at\?/)).toBeInTheDocument();

    // Typed into the composer, the way a person answers a question in a conversation.
    await ask("Berlin");

    await waitFor(() => expect(streamCalls()).toHaveLength(2));
    expect(askedBodies()[1]).toMatchObject({
      question: "What should I expect over the next few days?",
      location: "Berlin, Germany",
    });
  });

  it("treats a real question as a question, even while it is waiting for a place", async () => {
    fetchMock = withoutADefault(
      () => streaming(clarifyingFrames(NEEDS_LOCATION)),
      () => streaming(runFrames()),
    );
    renderAnalyst();

    await ask("What should I expect over the next few days?");
    expect(await screen.findByText(/Which place should Weathra look at\?/)).toBeInTheDocument();

    // A question mark, and more than a short phrase: never sent to the location resolver.
    await ask("Why is the forecast uncertain further out?");

    await waitFor(() => expect(streamCalls()).toHaveLength(2));
    const body = askedBodies()[1]!;
    expect(body.question).toBe("Why is the forecast uncertain further out?");
    expect(body.location).toBeUndefined();
  });

  it("renders the conversation and none of the report apparatus", async () => {
    fetchMock = withoutADefault(() => streaming(clarifyingFrames(NEEDS_LOCATION)));
    renderAnalyst();

    await ask("What should I expect over the next few days?");
    expect(await screen.findByText(/Which place should Weathra look at\?/)).toBeInTheDocument();

    /*
      Every one of these was on the screen the review photographed, under a question that had
      retrieved nothing: an AI INTERPRETATION card containing the words "no interpretation", two
      empty figure panels, and the model and policy identifiers a customer never asked for.
    */
    expect(screen.queryByText("AI interpretation")).toBeNull();
    expect(screen.queryByText(/No interpretation was written/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Observed data" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Forecast" })).toBeNull();
    expect(screen.queryByText(/^Model:/)).toBeNull();
    expect(screen.queryByText(/^Policy:/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Run progress" })).toBeNull();
  });

  it("does not call the run complete, and says what it is actually waiting for", async () => {
    fetchMock = withoutADefault(() => streaming(clarifyingFrames(NEEDS_LOCATION)));
    renderAnalyst();

    await ask("What should I expect over the next few days?");
    expect(await screen.findByText(/Which place should Weathra look at\?/)).toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Run detail" });
    /*
      The review's sharpest finding: AGENT STATUS read COMPLETE over a run that had retrieved
      nothing and analysed nothing. A run waiting for context is not a finished one.
    */
    expect(within(rail).getByText("Needs location")).toBeInTheDocument();
    expect(within(rail).queryByText("Complete")).toBeNull();
    // And the debug line under it is gone: orchestration not running is a fact about the context.
    expect(within(rail).queryByText(/This run named no agents/)).toBeNull();
    expect(within(rail).getByText(/Waiting for a place/)).toBeInTheDocument();
    expect(within(rail).getByText("Not queried yet.")).toBeInTheDocument();
  });
});

describe("a successful answer", () => {
  it("leads with the interpretation and keeps the model and policy behind the disclosure", async () => {
    fetchMock = respondingWith();
    renderAnalyst();

    await ask("What should I expect over the next few days in Berlin?");

    // The answer itself, first.
    expect(
      await screen.findByText(
        "The days ahead stay close to the seasonal baseline, with one warmer day midweek.",
      ),
    ).toBeInTheDocument();

    /*
      And the technical record present but not on the face of the reply. `specs/web-ui` requires
      what served an answer to be reportable; the review requires a customer not to meet
      "Policy: free_default" before the weather. A disclosure satisfies both.
    */
    const details = screen.getByRole("group", { name: "Answer details" });
    expect(details).toBeInTheDocument();
    expect(within(details).getByText(/Model: openrouter/)).toBeInTheDocument();

    // And not on the face of the reply, which is where a customer meets the weather.
    const card = screen.getByRole("article", {
      name: "Question: What should I expect over the next few days in Berlin?",
    });
    const lead = within(card).getByText(
      "The days ahead stay close to the seasonal baseline, with one warmer day midweek.",
    );
    expect(lead.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says Complete only when an analysis actually completed", async () => {
    fetchMock = respondingWith();
    renderAnalyst();

    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByText(
      "The days ahead stay close to the seasonal baseline, with one warmer day midweek.",
    );

    const rail = screen.getByRole("complementary", { name: "Run detail" });
    expect(within(rail).getByText("Complete")).toBeInTheDocument();
    expect(within(rail).queryByText("Needs location")).toBeNull();
  });
});

/* ------------------------------------- task 34.34: the product-polish pass */

/**
 * The successful answer and the rail beside it, against `02-ai-weather-analyst.png` §2–§14.
 *
 * Every case below is about one of two things: that a region the artifact draws is *populated* —
 * it was the emptiness of these panels that the customer-level review of 2026-09-12 objected to —
 * and that what populates it is the run's own record rather than the artifact's telemetry.
 */
/**
 * A run that retrieved the present as well as the days ahead — task 34.33.
 *
 * The findings are what `weather_current` reports through `findings_from_current`: a value and a
 * unit per measure the provider supplied, labelled, all of data class `current`. The condition
 * arrives as the provider's published code with the unit the domain gives a code, because the
 * vocabulary that turns 3 into "Overcast" lives in `lib/weather/condition` and only there.
 */
const CURRENT_SOURCE = { ...FORECAST_SOURCE, data_class: "current", period: null };

function withCurrent() {
  return {
    ...ANSWER,
    findings: [
      { label: "Temperature", value: 15.3, unit: "°C", data_class: "current", attribution: CURRENT_SOURCE },
      { label: "Feels like", value: 14.1, unit: "°C", data_class: "current", attribution: CURRENT_SOURCE },
      { label: "Humidity", value: 68, unit: "%", data_class: "current", attribution: CURRENT_SOURCE },
      { label: "Wind speed", value: 12.4, unit: "km/h", data_class: "current", attribution: CURRENT_SOURCE },
      { label: "Precipitation", value: 0, unit: "mm", data_class: "current", attribution: CURRENT_SOURCE },
      { label: "Condition", value: 3, unit: "WMO code", data_class: "current", attribution: CURRENT_SOURCE },
      ...ANSWER.findings,
    ],
    attribution: [CURRENT_SOURCE, FORECAST_SOURCE],
    evidence: {
      ...EVIDENCE,
      agents: [
        { sequence: 1, agent: "current", status: "succeeded", started_at: "2026-09-04T06:15:00Z", duration_ms: 210 },
        ...EVIDENCE.agents,
      ],
    },
  };
}

describe("the answer, composed as a briefing", () => {
  it("opens on the badge, a grounding line, and then the answer itself", async () => {
    fetchMock = respondingWith();
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");

    const panel = await screen.findByRole("region", { name: "AI interpretation" });
    expect(within(panel).getByText("AI INTERPRETATION")).toBeInTheDocument();

    // The place and how the run came to use it — the artifact's short grounding line, which its own
    // fills with "Grounding analysis via Weathra MCP…".
    const grounding = within(panel).getByText("Berlin, Germany · your saved default");
    const prose = within(panel).getByText(/stay close to the seasonal baseline/);
    expect(
      grounding.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // And it states no figure: the window, the units and the retrieval time are the panels' own.
    expect(grounding.textContent).not.toMatch(/\d/);
  });

  it("leads each figure panel with its highest-value readings and keeps the rest in the panel", async () => {
    const many = {
      ...ANSWER,
      findings: [
        { label: "Average pressure", value: 1014, unit: "hPa", data_class: "forecast", attribution: FORECAST_SOURCE },
        { label: "Average relative humidity", value: 71, unit: "%", data_class: "forecast", attribution: FORECAST_SOURCE },
        { label: "Highest peak wind gust", value: 38, unit: "km/h", data_class: "forecast", attribution: FORECAST_SOURCE },
        { label: "Total precipitation", value: 6.4, unit: "mm", data_class: "forecast", attribution: FORECAST_SOURCE },
        { label: "Lowest daily low temperature", value: 11.2, unit: "°C", data_class: "forecast", attribution: FORECAST_SOURCE },
        { label: "Highest daily high temperature", value: 24.5, unit: "°C", data_class: "forecast", attribution: FORECAST_SOURCE },
      ],
    };
    fetchMock = respondingWith(() => streaming(runFrames(many)));
    const { container } = renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");

    const forecast = (await screen.findByRole("region", { name: "Forecast" })) as HTMLElement;
    // Four figures on the face of it, temperature first, pressure and humidity not among them.
    expect(within(forecast).getByText("24.5 °C")).toBeInTheDocument();
    expect(within(forecast).getByText("11.2 °C")).toBeInTheDocument();
    expect(within(forecast).getByText("6.4 mm")).toBeInTheDocument();
    expect(within(forecast).getByText("38 km/h")).toBeInTheDocument();

    // The other two are in the same panel, one press away, counted rather than dropped.
    const more = within(forecast).getByText("2 more figures");
    expect(more).toBeInTheDocument();
    await userEvent.click(more);
    expect(within(forecast).getByText("71 %")).toBeInTheDocument();
    expect(within(forecast).getByText("1014 hPa")).toBeInTheDocument();

    // And the panel is still one attributed provenance region, not six loose numbers.
    expect(container.querySelectorAll('[data-tier="retrieved"]')).toHaveLength(1);
  });

  it("draws the current-conditions panel from the run's own readings", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withCurrent())));
    renderAnalyst();
    await ask("What is it doing in Berlin right now?");

    const panel = (await screen.findByRole("region", { name: "Current conditions" })) as HTMLElement;
    // The design system's class name, which is what the badge says; the heading says what the
    // provider's contract supports, which is not that a measurement was taken at the place.
    expect(within(panel).getByText("OBSERVED")).toBeInTheDocument();

    // The four a person glancing at "right now" wants, in that order.
    const labels = [...panel.querySelectorAll("dt")].map((term) => term.textContent);
    expect(labels.slice(0, 4)).toEqual(["Temperature", "Condition", "Humidity", "Wind speed"]);
    expect(within(panel).getByText("15.3 °C")).toBeInTheDocument();
    expect(within(panel).getByText("68 %")).toBeInTheDocument();
  });

  it("renders a condition code as the condition, through the product's one vocabulary", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withCurrent())));
    const { container } = renderAnalyst();
    await ask("What is it doing in Berlin right now?");

    const panel = (await screen.findByRole("region", { name: "Current conditions" })) as HTMLElement;
    // WMO 3, as `lib/weather/condition` translates it for every other screen.
    expect(within(panel).getByText("Overcast")).toBeInTheDocument();
    // And never as the raw figure it arrives as.
    expect(panel.textContent).not.toContain("WMO code");
    expect(panel.textContent).not.toMatch(/\b3 code\b/);
    expect(container.querySelector('[data-condition="overcast"]')).toBeInTheDocument();
  });

  it("draws no current-conditions panel at all where the run retrieved none", async () => {
    fetchMock = respondingWith();
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    // Not an empty card saying it retrieved nothing: no card.
    expect(screen.queryByRole("region", { name: "Current conditions" })).toBeNull();
  });

  it("gives the computed reading the artifact's highlighted treatment, with its class intact", async () => {
    fetchMock = respondingWith();
    const { container } = renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const highlighted = container.querySelector('[data-tier="computed"]') as HTMLElement;
    expect(
      within(highlighted).getByRole("heading", { name: "Analyst interpretation" }),
    ).toBeInTheDocument();
    // Headed for its role, badged for its provenance, and carrying the figure it is about.
    expect(within(highlighted).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(highlighted).getByText("17.9 °C")).toBeInTheDocument();
    // And not the artifact's causal reading of an atmosphere Weathra does not model.
    expect(highlighted.textContent).not.toMatch(/convection|jet stream|pressure system/i);
  });
});

describe("the rail beside a successful answer", () => {
  async function railAfterAnswer(): Promise<HTMLElement> {
    fetchMock = respondingWith();
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });
    return screen.getByRole("complementary", { name: "Run detail" });
  }

  it("names Weathra's own analyst and the run's real state, and no agent version", async () => {
    const rail = await railAfterAnswer();
    const status = within(rail).getByRole("region", { name: "Agent status" });

    expect(within(status).getByText("Weathra Analyst")).toBeInTheDocument();
    expect(within(status).getByText("Complete")).toBeInTheDocument();
    expect(status.textContent).not.toMatch(/v4\.8|compute load|inference/i);
  });

  it("lists the agents the record names, each with the outcome the backend stamped on it", async () => {
    const rail = await railAfterAnswer();
    const status = within(rail).getByRole("region", { name: "Agent status" });

    expect(within(status).getByText("Forecast agent")).toBeInTheDocument();
    expect(within(status).getByText("Synthesis")).toBeInTheDocument();
    expect(within(status).getAllByText("Used")).toHaveLength(2);
    // The record names two; no row is invented for the four capabilities that did not run.
    expect(within(status).queryByText("Historical agent")).toBeNull();
    expect(within(status).queryByText("RAG agent")).toBeNull();
  });

  it("names each source the way its own documentation does, with what it supplied", async () => {
    const rail = await railAfterAnswer();
    const sources = within(rail).getByRole("region", { name: "Active data sources" });

    expect(within(sources).getByText("Open-Meteo")).toBeInTheDocument();
    expect(within(sources).getByText("Forecast")).toBeInTheDocument();
    // Weathra's own arithmetic is a source of this answer and is credited as itself, rather than
    // to the provider whose series it was computed over.
    expect(within(sources).getByText("Weathra Analytics")).toBeInTheDocument();
    expect(within(sources).getByText("Deterministic calculations")).toBeInTheDocument();
    // The run cited a passage, so the corpus it came from is listed too.
    expect(within(sources).getByText("Weather Knowledge")).toBeInTheDocument();

    // And none of the artifact's feeds, none of which Weathra reads.
    for (const invented of ["GLOBAL_SAT", "L_RADAR", "ECMWF", "Berlin-Mitte"]) {
      expect(sources.textContent, invented).not.toContain(invented);
    }
  });

  it("credits one provider twice when it genuinely played two roles", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withCurrent())));
    renderAnalyst();
    await ask("What is it doing in Berlin now, and what should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const sources = screen.getByRole("region", { name: "Active data sources" });
    // Two rows, same provider, because the present and the days ahead are two claims — and the
    // roles are what make the second row worth having.
    expect(within(sources).getAllByText("Open-Meteo")).toHaveLength(2);
    expect(within(sources).getByText("Current conditions")).toBeInTheDocument();
    expect(within(sources).getByText("Forecast")).toBeInTheDocument();
  });

  it("names the current-conditions agent from the record, with the outcome it was stamped with", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withCurrent())));
    renderAnalyst();
    await ask("What is it doing in Berlin now, and what should I expect?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const status = screen.getByRole("region", { name: "Agent status" });
    expect(within(status).getByText("Conditions agent")).toBeInTheDocument();
    expect(within(status).getAllByText("Used")).toHaveLength(3);
    // Named as an agent, beside the other agents; "Current conditions" is the source row's words.
    expect(within(status).queryByText("Current conditions")).toBeNull();
  });

  it("lists one row per source and role, not one per attribution entry", async () => {
    const twice = {
      ...ANSWER,
      attribution: [FORECAST_SOURCE, { ...FORECAST_SOURCE, retrieved_at: "2026-09-04T06:20:00Z" }],
    };
    fetchMock = respondingWith(() => streaming(runFrames(twice)));
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const sources = screen.getByRole("region", { name: "Active data sources" });
    expect(within(sources).getAllByText("Open-Meteo")).toHaveLength(1);
  });

  it("states the context the run resolved to, and where each part came from", async () => {
    const rail = await railAfterAnswer();
    const context = within(rail).getByRole("region", { name: "Analyst context" });

    expect(within(context).getByText(/Berlin, Germany — your saved default/)).toBeInTheDocument();
    expect(within(context).getByText(/metric — your saved default/)).toBeInTheDocument();
    expect(within(context).getByText(/2026-09-04 00:00 to 2026-09-07 00:00/)).toBeInTheDocument();
    // The internal name of a rung of the resolution ladder is never printed as provenance.
    expect(context.textContent).not.toMatch(/from the preferences|from the none/);
  });

  it("calls this conversation's turns a conversation, and never long-term memory", async () => {
    const rail = await railAfterAnswer();
    const context = within(rail).getByRole("region", { name: "Analyst context" });

    expect(within(context).getByText("Conversation")).toBeInTheDocument();
    expect(
      within(context).getByText(/Open — this conversation's turns resolve the next question/),
    ).toBeInTheDocument();
    expect(rail.textContent).not.toMatch(/long-term memory/i);
  });

  it("shows only the preferences this account actually chose", async () => {
    const rail = await railAfterAnswer();
    const memory = within(rail).getByRole("region", { name: "Preferences in use" });

    // Chosen, per the preferences endpoint's own per-field sources.
    expect(within(memory).getByText("Default location")).toBeInTheDocument();
    expect(within(memory).getByText(/^Berlin/)).toBeInTheDocument();
    expect(within(memory).getByText("Temperature units")).toBeInTheDocument();
    // Assumed, so not remembered, so not listed as though it had been.
    expect(within(memory).queryByText("Forecast horizon")).toBeNull();
  });

  it("says plainly when nothing has been saved, rather than standing empty or filling itself", async () => {
    const none = {
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: null,
      sources: { unit_system: "default", default_location: "default", forecast_horizon_days: "default" },
    };
    fetchMock = vi.fn(async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me/preferences") return json(none);
      if (path === "/api/v1/weather/current") return json(CURRENT);
      return streaming(runFrames());
    }) as unknown as Mock;

    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const memory = screen.getByRole("region", { name: "Preferences in use" });
    expect(within(memory).getByText(/No saved analyst preferences yet/)).toBeInTheDocument();
    expect(within(memory).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(within(memory).queryByText("Temperature units")).toBeNull();
  });

  it("measures the one proportion it can, and states the confidence as a band", async () => {
    const rail = await railAfterAnswer();
    const confidence = within(rail).getByRole("region", { name: "Confidence and grounding" });

    // Both findings carry a value, so coverage is two of two — counted, not scored.
    expect(within(confidence).getByText("Data coverage")).toBeInTheDocument();
    expect(within(confidence).getByText("100%")).toBeInTheDocument();
    expect(
      within(confidence).getByText("2 of 2 reported figures carry a value"),
    ).toBeInTheDocument();

    // The confidence itself stays a band with a horizon, and the grounding a count.
    expect(within(confidence).getByText(/moderate at 48 h/)).toBeInTheDocument();
    expect(within(confidence).getByText(/2 checked · verified/)).toBeInTheDocument();
    expect(confidence.textContent).not.toContain("98.2%");
  });

  it("keeps the evidence action, and keeps the technical record out of the rail", async () => {
    const rail = await railAfterAnswer();

    expect(
      within(rail).getByRole("link", { name: "View full agent evidence" }),
    ).toHaveAttribute("href", "/evidence/evidence-7");
    // What served the answer is on the answer's own disclosure, not beside it.
    expect(rail.textContent).not.toMatch(/a-configured-model|openrouter|Policy:/);
  });

  it("degrades to what is true when the run is waiting for a place", async () => {
    fetchMock = respondingWith(() =>
      streaming(
        runFrames({
          ...ANSWER,
          answer_prose: "",
          findings: [],
          attribution: [],
          resolved: { locations: [], period: null, unit_system: "metric", location_source: "none", units_source: "preferences", statement: null },
          uncertainty: null,
          grounding: { verified: false, method: "figure extraction with a 0.05 tolerance", figures_checked: 0 },
          clarification_question: "Which place should Weathra look at?",
        }),
      ),
    );
    renderAnalyst();
    await ask("What should I expect over the next few days?");

    const rail = await screen.findByRole("complementary", { name: "Run detail" });
    expect(within(rail).getByText("Needs location")).toBeInTheDocument();
    expect(within(rail).getByText("Not queried yet.")).toBeInTheDocument();
    expect(within(rail).getAllByText("Nothing retrieved yet").length).toBeGreaterThan(0);
    // No completed data of any kind: no agent rows, no coverage bar reading zero as a measurement.
    expect(within(rail).queryByText("Used")).toBeNull();
    expect(within(rail).queryByText("100%")).toBeNull();
  });
});

/* ------------------------------------- task 34.34: satellite observation */

/**
 * What the Analyst does with a run that retrieved satellite imagery.
 *
 * Minimal on purpose: this pass adds the capability, not the panel. What has to be true now is that
 * the existing surfaces consume the new evidence truthfully — the source is named and credited to
 * the provider that served it, the agent row is the record's, and nothing on the screen says
 * anything about what the picture shows.
 */
describe("a run that retrieved satellite imagery", () => {
  const SATELLITE_SOURCE = {
    provider: "nasa-gibs",
    location: BERLIN,
    data_class: "satellite_observation",
    period: null,
    retrieved_at: "2026-09-12T07:59:23Z",
  };

  function withSatellite() {
    return {
      ...ANSWER,
      satellite: [
        {
          data_class: "satellite_observation",
          location: BERLIN,
          coverage: { south: 50.52, west: 11.405, north: 54.52, east: 15.405 },
          provider: "nasa-gibs",
          product: "Corrected Reflectance (True Colour)",
          instrument: "VIIRS on NOAA-20",
          observed_date: "2026-09-11",
          retrieved_at: "2026-09-12T07:59:23Z",
          image_url: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?x=1",
          image_media_type: "image/jpeg",
          image_bytes: 91533,
          attribution: "We acknowledge the use of imagery provided by services from NASA's GIBS.",
          source_url: "https://nasa-gibs.github.io/gibs-api-docs/",
          coverage_note: "Covers roughly 4° of latitude around Berlin — the region, not the place.",
          freshness_note: "A daily composite for 2026-09-11 (UTC).",
          interpretation_note:
            "Weathra retrieves and displays this imagery. It does not interpret it.",
        },
      ],
      attribution: [FORECAST_SOURCE, SATELLITE_SOURCE],
      evidence: {
        ...EVIDENCE,
        agents: [
          { sequence: 1, agent: "satellite", status: "succeeded", started_at: "2026-09-04T06:15:00Z", duration_ms: 480 },
          ...EVIDENCE.agents,
        ],
      },
    };
  }

  it("names the provider and instrument that produced the imagery, and its role", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withSatellite())));
    renderAnalyst();
    await ask("Show me the latest satellite observation for Berlin.");
    await screen.findByRole("region", { name: "AI interpretation" });

    const sources = screen.getByRole("region", { name: "Active data sources" });
    // The provider and the instrument, read off the observation the run holds — "NASA GIBS" alone
    // says who served it without saying what was flown.
    expect(within(sources).getByText("NASA GIBS · VIIRS on NOAA-20")).toBeInTheDocument();
    expect(within(sources).getByText("Satellite observation")).toBeInTheDocument();
    // Beside the weather provider, not instead of it: two sources, two roles.
    expect(within(sources).getByText("Open-Meteo")).toBeInTheDocument();
  });

  it("draws the observation as its own evidence panel, with its provenance", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withSatellite())));
    const { container } = renderAnalyst();
    await ask("Show me the latest satellite observation for Berlin.");

    const panel = (await screen.findByRole("region", {
      name: "Satellite observation",
    })) as HTMLElement;

    expect(within(panel).getByText("2026-09-11")).toBeInTheDocument();
    expect(within(panel).getByText("Corrected Reflectance (True Colour)")).toBeInTheDocument();
    expect(within(panel).getByText("VIIRS on NOAA-20")).toBeInTheDocument();
    expect(within(panel).getByText("NASA GIBS")).toBeInTheDocument();
    // The region it covers, and the acknowledgement the source requires, beside the imagery.
    expect(within(panel).getByText(/the region, not the place/)).toBeInTheDocument();
    expect(within(panel).getByText(/We acknowledge the use of imagery/)).toBeInTheDocument();

    // The imagery itself, from the provider's own URL, described as what it is rather than as
    // what it shows.
    const image = panel.querySelector("img") as HTMLImageElement;
    expect(image.src).toBe("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?x=1");
    expect(image.alt).toContain("Not interpreted by Weathra");

    // And the boundary sentence on the face of the panel, not in a disclosure.
    expect(within(panel).getByText(/It does not interpret it/)).toBeInTheDocument();
    expect(container.querySelector('[data-satellite="true"]')).toBeInTheDocument();
  });

  it("draws no satellite panel on a run that retrieved no imagery", async () => {
    fetchMock = respondingWith();
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    // Weathra has the capability. This run did not use it, so there is no panel.
    expect(screen.queryByRole("region", { name: "Satellite observation" })).toBeNull();
  });

  it("names the satellite agent from the record, and only where it ran", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withSatellite())));
    renderAnalyst();
    await ask("Show me the latest satellite observation for Berlin.");
    await screen.findByRole("region", { name: "AI interpretation" });

    const status = screen.getByRole("region", { name: "Agent status" });
    expect(within(status).getByText("Satellite agent")).toBeInTheDocument();
  });

  it("says nothing about what the imagery shows, because nothing looked at it", async () => {
    fetchMock = respondingWith(() => streaming(runFrames(withSatellite())));
    renderAnalyst();
    await ask("Show me the latest satellite observation for Berlin.");
    await screen.findByRole("region", { name: "AI interpretation" });

    const shown = (document.body.textContent ?? "").toLowerCase();
    for (const claim of [
      "analysed the image",
      "analyzed the image",
      "the image shows",
      "detected",
      "cloud cover detected",
      "we can see",
    ]) {
      expect(shown, claim).not.toContain(claim);
    }
  });

  it("shows no satellite source on a run that retrieved none", async () => {
    fetchMock = respondingWith();
    renderAnalyst();
    await ask("What should I expect over the next few days in Berlin?");
    await screen.findByRole("region", { name: "AI interpretation" });

    const sources = screen.getByRole("region", { name: "Active data sources" });
    expect(within(sources).queryByText("Satellite observation")).toBeNull();
    expect(sources.textContent).not.toContain("NASA");
  });
});
