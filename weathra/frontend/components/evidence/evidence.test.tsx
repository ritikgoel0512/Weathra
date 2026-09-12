/**
 * Agent Evidence / Activity — task 21.5's verification.
 *
 * The three the task names — a populated record, an unknown run identifier, and another user's
 * identifier producing the same not-found treatment — then the properties that make an evidence
 * screen worth having at all: that every row on it came out of the stored record, that the agent
 * sequence, the tool calls with their results, the deterministic methods, the cited knowledge and
 * the timings are all present, that the four tiers stay four separated regions, and that nothing
 * the record does not contain appears anywhere on the page.
 *
 * The API is driven through the real client and the real query layer inside the real session
 * boundary; only `fetch` and Supabase are replaced. Those are the two architectural boundaries this
 * screen sits between — the network, and the browser's own session — and nothing between them is
 * stubbed, so what is asserted below is the screen reading a real response through the real client.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { SessionBoundary } from "@/lib/session/provider";

import { AgentEvidence } from "./evidence";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("Agent Evidence must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/evidence/run-1",
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

const WINDOW = {
  start_local: "2026-09-05T00:00:00+02:00",
  end_local: "2026-09-05T23:00:00+02:00",
  start_utc: "2026-09-04T22:00:00Z",
  end_utc: "2026-09-05T21:00:00Z",
  timezone: "Europe/Berlin",
};

const FORECAST_SOURCE = {
  provider: "open-meteo",
  location: BERLIN,
  data_class: "forecast",
  period: WINDOW,
  retrieved_at: "2026-09-04T09:04:56Z",
};

const ARCHIVE_SOURCE = {
  provider: "open-meteo",
  location: BERLIN,
  data_class: "historical_observation",
  period: {
    ...WINDOW,
    start_local: "2025-09-05T00:00:00+02:00",
    end_local: "2025-09-05T23:00:00+02:00",
  },
  retrieved_at: "2026-09-04T09:04:57Z",
};

const PROVENANCE = {
  location: BERLIN,
  period: WINDOW,
  provider: "open-meteo",
  retrieved_at: "2026-09-04T09:04:56Z",
  source_data_class: "forecast",
  unit_system: "metric",
};

const MEAN = {
  statistic: "mean",
  measure: "temperature",
  value: 15.6,
  unit: "°C",
  method: "arithmetic mean of usable points",
  minimum_points: 1,
  points_used: 24,
  points_excluded: 2,
  status: "computed",
  provenance: PROVENANCE,
};

const NOT_COMPUTABLE = {
  statistic: "maximum",
  measure: "wind_gust_max",
  value: null,
  unit: "",
  method: "maximum of usable points",
  minimum_points: 1,
  points_used: 0,
  status: "not_computable",
  reason: "the provider supplied no wind gust for this window",
  provenance: PROVENANCE,
};

const TREND = {
  measure: "temperature",
  direction: "rising",
  method: "least-squares slope over the window",
  slope_per_day: 0.8,
  magnitude: 2.4,
  unit: "°C",
  minimum_points: 3,
  points_used: 24,
  points_excluded: 0,
  insignificance_margin_per_day: 0.1,
  provenance: PROVENANCE,
};

const ANOMALIES = {
  measure: "precipitation",
  method: "median absolute deviation, threshold 3.5",
  median: 0.2,
  median_absolute_deviation: 0.1,
  threshold: 3.5,
  unit: "mm",
  points_used: 24,
  points_excluded: 0,
  anomalies: [
    { time_utc: "2026-09-05T14:00:00Z", time_local: "2026-09-05T16:00:00+02:00", value: 6.4, deviation: 6.2, deviation_score: 4.1 },
  ],
  minimum: { ...MEAN, statistic: "minimum", measure: "precipitation", value: 0, unit: "mm" },
  maximum: { ...MEAN, statistic: "maximum", measure: "precipitation", value: 6.4, unit: "mm" },
  provenance: PROVENANCE,
};

const CITATIONS = [
  {
    document_id: "forecast-uncertainty.md",
    title: "Why forecast confidence falls with horizon distance",
    topic: "uncertainty",
    chunk_position: 2,
    score: 0.83,
    text: "Forecast skill declines with lead time because small errors in the initial state grow.",
  },
  {
    document_id: "temperature-measures.md",
    title: "Mean, maximum and apparent temperature",
    topic: "measures",
    chunk_position: 0,
    score: 0.71,
    text: "A daily mean temperature is the arithmetic mean of the day's usable readings.",
  },
];

/**
 * The stored evidence record, as `weathra/agents/evidence.py` dumps it into the JSONB column.
 *
 * `deliberation` and `scratchpad` are not fields the backend writes. They are here as bait: the
 * screen must render named fields out of this dictionary rather than whatever it happens to hold,
 * and the assertion at the end of the file is what proves it.
 */
const STORED_EVIDENCE = {
  request_id: "req-77",
  thread_id: "thread-3",
  question: "How does tomorrow compare with the same day last year in Berlin?",
  routing_reason: "The question spans a forecast and an archive period, then a comparison.",
  routing_source: "model",
  agents: [
    {
      sequence: 1,
      agent: "supervisor",
      status: "succeeded",
      started_at: "2026-09-04T09:04:55Z",
      duration_ms: 120,
      reason: "Planned forecast retrieval, archive retrieval, then deterministic comparison.",
    },
    {
      sequence: 2,
      agent: "forecast",
      status: "succeeded",
      started_at: "2026-09-04T09:04:56Z",
      duration_ms: 850,
      reason: "Retrieved tomorrow's hourly and daily series for the resolved location.",
    },
    {
      sequence: 3,
      agent: "historical",
      status: "failed",
      started_at: "2026-09-04T09:04:57Z",
      duration_ms: 302,
      reason: "The archive did not answer in time.",
    },
    {
      sequence: 4,
      agent: "analytics",
      status: "succeeded",
      started_at: "2026-09-04T09:04:57Z",
      duration_ms: 610,
      reason: "Computed the mean and the trend over the retrieved forecast series.",
    },
    {
      sequence: 5,
      agent: "rag",
      status: "succeeded",
      started_at: "2026-09-04T09:04:58Z",
      duration_ms: 240,
      reason: "Retrieved knowledge explaining forecast uncertainty.",
    },
    {
      sequence: 6,
      agent: "synthesis",
      status: "succeeded",
      started_at: "2026-09-04T09:04:58Z",
      duration_ms: 1200,
    },
  ],
  tool_calls: [
    {
      sequence: 1,
      tool: "weather_forecast",
      agent: "forecast",
      arguments: { latitude: 52.52, longitude: 13.405, days: 2, units: "metric" },
      started_at: "2026-09-04T09:04:56Z",
      duration_ms: 850,
    },
    {
      sequence: 2,
      tool: "weather_history",
      agent: "historical",
      arguments: { latitude: 52.52, longitude: 13.405, start: "2025-09-05", end: "2025-09-05" },
      started_at: "2026-09-04T09:04:57Z",
      duration_ms: 302,
    },
    {
      sequence: 3,
      tool: "weather_statistics",
      agent: "analytics",
      arguments: { measure: "temperature", statistics: ["mean", "trend"], points: [1, 2, 3, 4] },
      started_at: "2026-09-04T09:04:57Z",
      duration_ms: 610,
    },
  ],
  tool_results: [
    {
      sequence: 1,
      tool: "weather_forecast",
      ok: true,
      data_class: "forecast",
      attribution: FORECAST_SOURCE,
      payload: { hourly: [1, 2, 3], daily: [1, 2], units: { temperature: "°C" } },
    },
    {
      sequence: 2,
      tool: "weather_history",
      ok: false,
      error_code: "provider_timeout",
      error_message: "The archive did not answer within the request budget.",
    },
    {
      sequence: 3,
      tool: "weather_statistics",
      ok: true,
      data_class: "computed_statistic",
      payload: { statistics: [1, 2], unit: "°C" },
    },
  ],
  analytics_results: [MEAN, NOT_COMPUTABLE],
  anomaly_reports: [ANOMALIES],
  trend_reports: [TREND],
  citations: CITATIONS,
  attributions: [FORECAST_SOURCE, ARCHIVE_SOURCE],
  data_classes: ["forecast", "computed_statistic", "ai_interpretation"],
  llm_provider: "openrouter",
  llm_model: "a-configured-model",
  started_at: "2026-09-04T09:04:55Z",
  completed_at: "2026-09-04T09:04:59Z",
  total_duration_ms: 4210,
  steps_used: 6,
  partial: false,
  partial_reason: null,
  deliberation: "INTERNAL SCRATCHPAD: first I assumed the user meant Berlin, then reconsidered.",
  scratchpad: "Chain of thought the reader must never see.",
};

const PROSE =
  "Tomorrow's forecast mean for Berlin is 15.6 °C and the provider's series is rising across the day. " +
  "The archive comparison could not be retrieved, so no figure is reported for last year.";

const STORED_ENVELOPE = {
  request_id: "req-77",
  thread_id: "thread-3",
  answer_prose: PROSE,
  prose_data_class: "ai_interpretation",
  findings: [],
  attribution: [FORECAST_SOURCE],
  resolved: {
    locations: [BERLIN],
    period: WINDOW,
    unit_system: "metric",
    location_source: "preferences",
    units_source: "preferences",
    statement: "Berlin, Germany, for tomorrow, from your saved default location.",
  },
  grounding: {
    verified: true,
    method: "figures extracted from the prose and matched to the evidence within 0.05",
    figures_checked: 2,
    ungrounded_figures: [],
    prose_discarded: false,
  },
  uncertainty: {
    provider: "open-meteo",
    reference_time_utc: "2026-09-04T09:04:56Z",
    spread_available: false,
    basis: "Confidence falls with horizon distance and derives from one provider's output.",
    horizon: [{ hours_ahead: 24, confidence: "high" }],
  },
  unanswered_parts: ["how last year's same day compared"],
  model_reasoning: "Hidden deliberation that belongs to no user-facing surface.",
};

const RECORD = {
  id: "run-1",
  request_id: "req-77",
  thread_id: "thread-3",
  question: STORED_EVIDENCE.question,
  answer_prose: PROSE,
  envelope: STORED_ENVELOPE,
  evidence: STORED_EVIDENCE,
  llm_provider: "openrouter",
  llm_model: "a-configured-model",
  weather_provider: "open-meteo",
  duration_ms: 4210,
  partial: false,
  created_at: "2026-09-04T09:05:00Z",
};

/** Every identifier and figure the design artifact shows. None of it is data. */
const ARTIFACT_SAMPLE_VALUES = [
  "WX-EVD-992-ALPHA",
  "WX-901-DELTA-AF89",
  "WX-CHUNK-882",
  "OBS-TELEMETRY-09",
  "ANLY-DRIFT-LOG",
  "STATION BER-09",
  "BER-09",
  "GlobalWeatherOS",
  "ECMWF Core",
  "WMO Historical",
  "Local Hydro-Met",
  "NASA POWER",
  "Internal PDF Lib",
  "LOGIC-ROUTER-V4",
  "v4.8.2-STABLE",
  "98.4%",
  "AUDIT_LOCK",
  "LINUX-MET-NODE-772",
  "ISO-MET-COMPLIANT",
  "Dr. Aris Thorne",
];

/** One element of a list, insisted on: an absent row is a failure, not an `undefined` assertion. */
function at<Item>(list: readonly Item[], index: number): Item {
  const item = list[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}.`);
  return item;
}

/* --------------------------------------------------------------------- harness */

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

function error(code: string, message: string, requestId = "req-err") {
  return { error: { code, message, details: null, request_id: requestId } };
}

/** The backend's own answer for an unknown identifier — and for another user's, byte for byte. */
const NOT_FOUND_BODY = error("evidence_not_found", "No evidence record with that identifier.");

function backend(status: number, body: unknown) {
  return vi.fn(async () => jsonResponse(status, body)) as unknown as Mock;
}

function renderScreen(evidenceId = "run-1") {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "t"}
      fetch={(input, init) => fetchMock(input, init)}
    >
      <AgentEvidence evidenceId={evidenceId} />
    </SessionBoundary>,
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  fetchMock = backend(200, RECORD);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

/**
 * The tool calls themselves, which are behind a disclosure.
 *
 * The panel summarises by default — what was used and how much — because six full cards ran the
 * left rail to twice the height of the evidence beside it. The complete trace is still the record,
 * and these tests still assert against it; they open it first, as an auditor would.
 */
function toolCalls(): HTMLElement[] {
  const panel = screen.getByRole("region", { name: "MCP evidence" });
  const trace = panel.querySelector("details");
  if (trace && !trace.open) trace.open = true;
  const list = panel.querySelector('[data-tool-calls="true"]');
  return list ? Array.from(list.querySelectorAll(":scope > li")) : [];
}

describe("a populated evidence record", () => {
  it("asks the documented evidence endpoint for exactly the identifier it was given", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(input);
    expect(url.origin).toBe("http://backend.test");
    expect(url.pathname).toBe("/api/v1/evidence/run-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("renders the run's question, status and identifiers", async () => {
    renderScreen();

    const heading = await screen.findByRole("heading", { name: "Agent evidence log", level: 1 });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(STORED_EVIDENCE.question)).toBeInTheDocument();
    /*
     * The header carries the record's own identifier; the request and conversation identifiers moved
     * to the audit panel that closes the page, where a person tracing a run looks for them. All
     * three are still on the screen, and all three are still the backend's own.
     */
    expect(screen.getByText("Evidence run-1")).toBeInTheDocument();

    const audit = screen.getByRole("region", { name: "Record and traceability" });
    expect(within(audit).getByText("req-77")).toBeInTheDocument();
    expect(within(audit).getByText("thread-3")).toBeInTheDocument();
  });

  it("names every agent the run involved", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const involved = document.querySelector('[data-agents-involved="true"]');
    expect(involved?.textContent).toBe(
      "Supervisor, Forecast agent, Historical agent, Analytics agent, Knowledge agent, Synthesis",
    );
  });
});

describe("the agent execution sequence", () => {
  it("lists the agents in the order the backend recorded, with each outcome and reason", async () => {
    renderScreen();
    const flow = await screen.findByRole("region", { name: "Execution flow" });

    const steps = within(flow).getAllByRole("listitem");
    expect(steps).toHaveLength(6);
    expect(steps.map((step) => step.getAttribute("data-agent"))).toEqual([
      "supervisor",
      "forecast",
      "historical",
      "analytics",
      "rag",
      "synthesis",
    ]);

    expect(at(steps, 0)).toHaveTextContent("1. Supervisor");
    expect(at(steps, 0)).toHaveTextContent("Succeeded");
    expect(at(steps, 0)).toHaveTextContent(
      "Planned forecast retrieval, archive retrieval, then deterministic comparison.",
    );

    // A failure is a failure, and the reason the backend recorded is shown as it was recorded.
    expect(at(steps, 2)).toHaveAttribute("data-status", "failed");
    expect(at(steps, 2)).toHaveTextContent("Failed");
    expect(at(steps, 2)).toHaveTextContent("The archive did not answer in time.");
  });

  it("shows why the supervisor routed as it did", async () => {
    renderScreen();
    const flow = await screen.findByRole("region", { name: "Execution flow" });

    expect(
      within(flow).getByText(/The question spans a forecast and an archive period/),
    ).toBeInTheDocument();
    expect(within(flow).getByText(/planned by the model/)).toBeInTheDocument();
  });
});

describe("the tool calls and their results", () => {
  it("lists each call with the agent that made it, its arguments and what came back", async () => {
    const person = userEvent.setup();
    renderScreen();
    await screen.findByRole("region", { name: "MCP evidence" });

    const calls = toolCalls();
    expect(calls).toHaveLength(3);

    const forecast = at(calls, 0);
    expect(forecast).toHaveAttribute("data-tool", "weather_forecast");
    expect(forecast).toHaveTextContent("1. weather_forecast");
    expect(forecast).toHaveTextContent("called by Forecast agent");
    expect(forecast).toHaveTextContent("850 ms");

    // Arguments are the ones recorded, read out of the stored call.
    await person.click(within(forecast).getByText(/^Arguments/));
    expect(within(forecast).getByText("latitude")).toBeInTheDocument();
    expect(within(forecast).getByText("52.52")).toBeInTheDocument();
    expect(within(forecast).getAllByText("units").length).toBeGreaterThan(0);
    expect(within(forecast).getByText("metric")).toBeInTheDocument();

    // The result: its data class, its attribution, and the shape of what it returned.
    const returned = forecast.querySelector('[data-tool-result="ok"]');
    expect(returned).not.toBeNull();
    expect(within(returned as HTMLElement).getByText("FORECAST")).toBeInTheDocument();
    expect(returned).toHaveTextContent("open-meteo");
    expect(returned).toHaveTextContent("Berlin, Germany");

    await person.click(within(forecast).getByText(/^Result values/));
    expect(within(forecast).getByText("hourly")).toBeInTheDocument();
    expect(within(forecast).getByText("3 entries")).toBeInTheDocument();
  });

  it("reports a failed tool call as a failure, with the backend's code and message", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "MCP evidence" });

    const failed = at(toolCalls(), 1);
    expect(failed).toHaveAttribute("data-tool", "weather_history");
    const outcome = failed.querySelector('[data-tool-result="failed"]');
    expect(outcome).toHaveTextContent("provider_timeout");
    expect(outcome).toHaveTextContent("The archive did not answer within the request budget.");
    // A failure carries no data class and no values: an error is never presented as data.
    expect(failed.querySelector('[data-tool-result="ok"]')).toBeNull();
  });
});

describe("the deterministic analytics", () => {
  it("shows each computed figure with the method that produced it", async () => {
    renderScreen();
    const analytics = await screen.findByRole("region", { name: "Deterministic analytics" });

    expect(analytics).toHaveAttribute("data-tier", "computed");
    expect(within(analytics).getByText("ANALYTICS")).toBeInTheDocument();

    expect(within(analytics).getByText("Mean · Temperature")).toBeInTheDocument();
    expect(within(analytics).getByText("15.6 °C")).toBeInTheDocument();
    expect(
      within(analytics).getAllByText(
        /Computed by Weathra, deterministically, from retrieved values\./,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(analytics).getByText(/Method: arithmetic mean of usable points\./),
    ).toBeInTheDocument();
    expect(within(analytics).getAllByText(/24 points used\./).length).toBeGreaterThan(0);
    expect(within(analytics).getByText(/2 excluded as absent\./)).toBeInTheDocument();
  });

  it("states why a statistic was not computable rather than showing a stand-in figure", async () => {
    renderScreen();
    const analytics = await screen.findByRole("region", { name: "Deterministic analytics" });

    expect(
      within(analytics).getByText(
        /Not computable: the provider supplied no wind gust for this window/,
      ),
    ).toBeInTheDocument();
  });

  it("shows the trend and the anomaly scan with their own methods", async () => {
    renderScreen();
    const analytics = await screen.findByRole("region", { name: "Deterministic analytics" });

    expect(within(analytics).getByText("Trend · Temperature")).toBeInTheDocument();
    expect(within(analytics).getByText("Rising")).toBeInTheDocument();
    expect(within(analytics).getByText(/Method: least-squares slope over the window\./)).toBeInTheDocument();

    expect(within(analytics).getByText("Anomalies · Precipitation")).toBeInTheDocument();
    expect(within(analytics).getByText("1 point")).toBeInTheDocument();
    expect(
      within(analytics).getByText(/Method: median absolute deviation, threshold 3\.5\./),
    ).toBeInTheDocument();
  });
});

describe("the retrieved knowledge", () => {
  it("shows each cited chunk with its document, position, score and text", async () => {
    renderScreen();
    const knowledge = await screen.findByRole("region", { name: "Retrieved knowledge" });

    const cited = within(knowledge).getAllByRole("listitem");
    expect(cited).toHaveLength(2);

    const first = at(cited, 0);
    expect(first).toHaveAttribute("data-document", "forecast-uncertainty.md");
    expect(first).toHaveTextContent("Why forecast confidence falls with horizon distance");
    // The reference now reads as one identifier chip — document and chunk together, the artifact's
    // own shape — rather than the words "chunk 2" in a sentence.
    expect(first).toHaveTextContent("forecast-uncertainty.md · 2");
    expect(first).toHaveTextContent("relevance 0.83");
    expect(first).toHaveTextContent(/Forecast skill declines with lead time/);
  });

  it("says plainly that a corpus passage is documentation and not a weather source", async () => {
    renderScreen();
    const knowledge = await screen.findByRole("region", { name: "Retrieved knowledge" });

    expect(
      within(knowledge).getByText(/Explanatory documentation, not measurement, and not a weather source/),
    ).toBeInTheDocument();
    // It is not badged as one of the five data classes, because it is not one of them.
    expect(knowledge.querySelector("[data-class]")).toBeNull();
  });
});

describe("the timings", () => {
  it("reports when the run started, when it finished, what it cost and how many steps it used", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    expect(document.querySelector('[data-run-duration="true"]')?.textContent).toBe("4.2 s");
    expect(document.querySelector('[data-run-steps="true"]')?.textContent).toBe("6");

    /*
     * One timestamp, not two. The header strip carries the run's start beside its duration — the
     * artifact's own pairing — and a second cell restating the same minute earned none of the width
     * it took. The completion instant is still in the record and still shown in the audit panel.
     */
    const started = screen.getByText("Timestamp").closest("div") as HTMLElement;
    expect(within(started).getByText("2026-09-04 09:04 UTC")).toHaveAttribute(
      "datetime",
      "2026-09-04T09:04:55Z",
    );
  });

  it("reports each agent's and each tool call's own duration", async () => {
    renderScreen();
    const flow = await screen.findByRole("region", { name: "Execution flow" });

    expect(at(within(flow).getAllByRole("listitem"), 0)).toHaveTextContent("120 ms");
    expect(at(within(flow).getAllByRole("listitem"), 5)).toHaveTextContent("1.2 s");
    expect(at(toolCalls(), 2)).toHaveTextContent("610 ms");
  });
});

describe("provenance and the data classes", () => {
  it("lists every source with its provider, resolved location, period, retrieval time and class", async () => {
    renderScreen();
    const sources = await screen.findByRole("region", { name: "Grounded data sources" });

    expect(sources).toHaveAttribute("data-tier", "retrieved");

    /*
     * Attribution rows only. The corpus row that follows them is derived from citations rather than
     * from a retrieval, and is asserted separately.
     */
    const rows = within(sources)
      .getAllByRole("row")
      .slice(1)
      .filter((row) => row.getAttribute("data-source-class") !== "knowledge");
    expect(rows).toHaveLength(2);

    const forecastRow = at(rows, 0);
    expect(forecastRow).toHaveAttribute("data-source-class", "forecast");
    expect(forecastRow).toHaveTextContent("open-meteo");
    expect(forecastRow).toHaveTextContent("Berlin, Germany");
    /*
     * The cell states the days; the exact bounds stay on its `title`. Two midnight timestamps and a
     * zone to say "one day" is how a window is *bounded*, not a fact about the data — and it was
     * the widest column in the table.
     */
    expect(forecastRow).toHaveTextContent("05 Sep 2026");
    expect(
      within(forecastRow).getByTitle("2026-09-05 00:00 to 2026-09-05 23:00 (Europe/Berlin)"),
    ).toBeInTheDocument();
    /*
     * The retrieval instant left this table and lives in the provenance timeline instead: five
     * columns cost the data class its width, and "when" is a question the audit panel answers.
     */
    expect(within(forecastRow).getByText("FORECAST")).toBeInTheDocument();

    const archiveRow = at(rows, 1);
    expect(archiveRow).toHaveAttribute("data-source-class", "historical_observation");
    expect(within(archiveRow).getByText("HISTORICAL")).toBeInTheDocument();
  });

  it("keeps retrieved data, deterministic analytics, knowledge and interpretation as separate regions", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Grounded data sources" });

    const tiers = [...document.querySelectorAll("[data-tier]")].map((node) =>
      node.getAttribute("data-tier"),
    );
    expect(tiers).toContain("retrieved");
    expect(tiers).toContain("computed");
    expect(tiers).toContain("knowledge");
    expect(tiers).toContain("interpretation");

    // No region carries two tiers, and no tier contains another.
    for (const node of document.querySelectorAll("[data-tier]")) {
      expect(node.querySelector("[data-tier]")).toBeNull();
    }
  });

  it("shows the location and period the run resolved to, and where each came from", async () => {
    renderScreen();
    const context = await screen.findByRole("region", { name: "Context used (agent memory)" });

    expect(context).toHaveTextContent("Berlin, Germany (from the preferences)");
    expect(context).toHaveTextContent("2026-09-05 00:00 to 2026-09-05 23:00 (Europe/Berlin)");
    expect(context).toHaveTextContent("metric (from the preferences)");
    expect(context).toHaveTextContent(
      "Berlin, Germany, for tomorrow, from your saved default location.",
    );
  });

  it("shows the uncertainty the backend stated, with its basis", async () => {
    renderScreen();
    const uncertainty = await screen.findByRole("region", { name: "Forecast uncertainty" });

    expect(within(uncertainty).getByText("HIGH CONFIDENCE")).toBeInTheDocument();
    expect(
      within(uncertainty).getByText(
        /Confidence falls with horizon distance and derives from one provider's output\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(uncertainty).getByText(/This provider supplies no forecast spread/),
    ).toBeInTheDocument();
    // No percentage: the artifact's "Confidence 98.4%" has nothing behind it.
    expect(uncertainty.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });
});

describe("the AI interpretation", () => {
  it("is its own region, badged, bounded, and separate from every figure", async () => {
    renderScreen();
    const synthesis = await screen.findByRole("region", { name: "Final grounded synthesis" });

    expect(synthesis).toHaveAttribute("data-interpretation", "true");
    expect(synthesis).toHaveAttribute("data-tier", "interpretation");
    expect(within(synthesis).getByText("AI INTERPRETATION")).toBeInTheDocument();
    expect(
      within(synthesis).getByText(
        "Written by a language model about the figures shown. It produced no measurement, forecast, or statistic.",
      ),
    ).toBeInTheDocument();
    expect(within(synthesis).getByText(PROSE)).toBeInTheDocument();
    expect(within(synthesis).getByText(/openrouter · a-configured-model/)).toBeInTheDocument();

    // The interpretation panel holds no analytics figure, no source row and no tool call.
    expect(synthesis.querySelector('[data-statistic]')).toBeNull();
    expect(synthesis.querySelector("table")).toBeNull();
    expect(synthesis.querySelector("[data-tool]")).toBeNull();
  });

  it("reports the grounding outcome and anything the run could not answer", async () => {
    renderScreen();
    const synthesis = await screen.findByRole("region", { name: "Final grounded synthesis" });

    expect(within(synthesis).getByText(/Grounding verified/)).toBeInTheDocument();
    /*
     * The verdict is the sentence; how it was reached is behind "Grounding details". Still in the
     * record — a reader checking the checker must be able to — but no longer printed under every
     * conclusion, which is what made the synthesis read as a diagnostic dump.
     */
    expect(within(synthesis).getByText(/2 figures checked by/)).toBeInTheDocument();
    expect(within(synthesis).getByText("how last year's same day compared")).toBeInTheDocument();
  });
});

describe("an identifier that resolves to nothing", () => {
  it("shows the not-found state for an unknown identifier, with no retry", async () => {
    fetchMock = backend(404, NOT_FOUND_BODY);
    renderScreen("no-such-run");

    const state = await screen.findByText("No evidence record with that identifier");
    expect(state).toBeInTheDocument();
    expect(screen.getByText("No evidence record with that identifier.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    // Nothing of a run is rendered beside it.
    expect(screen.queryByRole("region", { name: "Execution flow" })).toBeNull();
  });

  it("treats another user's identifier exactly as it treats an unknown one", async () => {
    fetchMock = backend(404, NOT_FOUND_BODY);
    const unknown = renderScreen("no-such-run");
    await screen.findByText("No evidence record with that identifier");
    const unknownMarkup = unknown.container.innerHTML;
    unknown.unmount();

    // The backend answers a foreign identifier with the same status, code and message, so the
    // rendering must be identical too: nothing on screen may hint that the record exists.
    fetchMock = backend(404, NOT_FOUND_BODY);
    const foreign = renderScreen("someone-elses-run");
    await screen.findByText("No evidence record with that identifier");

    expect(foreign.container.innerHTML).toBe(unknownMarkup);
    expect(foreign.container.textContent).not.toMatch(/someone-elses-run/);
  });

  it("says that a record which never existed and one belonging to somebody else read the same", async () => {
    fetchMock = backend(404, NOT_FOUND_BODY);
    renderScreen("no-such-run");
    await screen.findByText("No evidence record with that identifier");

    expect(
      screen.getByText(/An identifier Weathra has never stored and one stored for somebody else/),
    ).toBeInTheDocument();
  });
});

describe("the other states", () => {
  it("announces that it is loading before the record arrives", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    ) as unknown as Mock;

    renderScreen();

    expect(await screen.findByRole("status")).toHaveTextContent("Loading this run's evidence record");
    expect(screen.queryByRole("region", { name: "Execution flow" })).toBeNull();

    release(jsonResponse(200, RECORD));
    await screen.findByRole("region", { name: "Execution flow" });
  });

  it("shows a backend failure as a failure, distinct from not-found, and retries in place", async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, error("internal_error", "Weathra could not read that record.")))
      .mockResolvedValueOnce(jsonResponse(500, error("internal_error", "Weathra could not read that record.")))
      .mockResolvedValue(jsonResponse(200, RECORD)) as unknown as Mock;

    renderScreen();

    // The query layer retries a 5xx once with a delay before the view is told, so this waits
    // longer than the default: both attempts must fail before the error branch is the answer.
    const failure = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(failure).toHaveTextContent("That evidence record could not be loaded");
    expect(failure).toHaveTextContent("Weathra could not read that record.");
    expect(screen.queryByText("No evidence record with that identifier")).toBeNull();

    await userEvent.setup().click(within(failure).getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Execution flow" });
  });

  it("says the record could not be read rather than rendering a run that was not recovered", async () => {
    fetchMock = backend(200, { ...RECORD, evidence: { note: "not an evidence record" } });
    renderScreen();

    expect(await screen.findByText("This record could not be read")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Execution flow" })).toBeNull();
  });

  it("hands an expired session to the shared session boundary, not to its own error branch", async () => {
    fetchMock = backend(401, error("token_expired", "Your access token has expired."));
    renderScreen();

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    // Not shown as a data or server error, and not as a missing record.
    expect(screen.queryByText("That evidence record could not be loaded")).toBeNull();
    expect(screen.queryByText("No evidence record with that identifier")).toBeNull();
    expect(screen.queryByText("Your access token has expired.")).toBeNull();
  });
});

describe("nothing on the screen came from anywhere but the record", () => {
  it("renders exactly the agents, tool calls, sources and citations the record holds", async () => {
    renderScreen();
    const flow = await screen.findByRole("region", { name: "Execution flow" });

    expect(within(flow).getAllByRole("listitem")).toHaveLength(STORED_EVIDENCE.agents.length);
    expect(
      toolCalls(),
    ).toHaveLength(STORED_EVIDENCE.tool_calls.length);
    /*
     * A header row, one row per stored attribution, and — because this record cites knowledge — the
     * corpus row derived from those citations. Every row traces to something the record holds.
     */
    expect(
      within(screen.getByRole("region", { name: "Grounded data sources" })).getAllByRole("row"),
    ).toHaveLength(STORED_EVIDENCE.attributions.length + 2);
    expect(
      within(screen.getByRole("region", { name: "Retrieved knowledge" })).getAllByRole("listitem"),
    ).toHaveLength(CITATIONS.length);

    // One request, to the documented endpoint. The browser retrieved nothing else and computed
    // nothing: no provider, no inference gateway, no second evidence source.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [input] of fetchMock.mock.calls as [string][]) {
      const url = new URL(input);
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      expect(url.host).not.toMatch(/open-meteo|openmeteo|openrouter|supabase/i);
    }
  });

  it("shows no identifier, provider, version, node or confidence figure from the artifact", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const text = document.body.textContent ?? "";
    for (const sample of ARTIFACT_SAMPLE_VALUES) {
      expect(text).not.toContain(sample);
    }
    // And none of the audit-chain framing the design gate refused.
    for (const refused of [
      /validate conclusion/i,
      /export trace/i,
      /inspect payloads/i,
      /chain of custody/i,
      /cryptographically signed/i,
      /immutable/i,
      /audit stability/i,
      /audit id/i,
      /signature hash/i,
    ]) {
      expect(text).not.toMatch(refused);
    }
  });

  it("exposes no hidden chain of thought, only the operational record", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Final grounded synthesis" });

    const text = document.body.textContent ?? "";
    expect(text).not.toContain(STORED_EVIDENCE.deliberation);
    expect(text).not.toContain(STORED_EVIDENCE.scratchpad);
    expect(text).not.toContain(STORED_ENVELOPE.model_reasoning);
    expect(text).not.toMatch(/scratchpad|chain of thought|deliberation/i);

    // What is shown instead: safe operational metadata, tool activity, retrieved evidence,
    // deterministic method notes, and the citations.
    expect(text).toContain("weather_forecast");
    expect(text).toContain("arithmetic mean of usable points");
    expect(text).toContain("forecast-uncertainty.md");
  });
});

/**
 * Heading levels — found by the manual accessibility pass for task 21.8.
 *
 * The panels in this screen's columns are siblings of one another, so they carry the same heading
 * level. "Deterministic analytics" and "Final grounded synthesis" were third-level, which in a
 * heading list reads them as parts of whichever panel happened to precede them — a containment the
 * screen does not have. The `heading-order` audit never caught it, because descending from h2 to h3
 * is a legal order; only reading the heading list as a list shows it.
 *
 * "Deterministic analytics" also changed level with its own data: its no-statistics branch has
 * always rendered an `h2`.
 */
describe("the panel headings do not claim panels contain one another", () => {
  it("gives every panel on the screen the same heading level", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Deterministic analytics" });

    for (const name of [
      "Execution flow",
      "MCP evidence",
      "Grounded data sources",
      "Deterministic analytics",
      "Forecast uncertainty",
      "Retrieved knowledge",
      "Final grounded synthesis",
    ]) {
      expect(
        screen.getByRole("heading", { name, level: 2 }),
        `"${name}" is not a second-level heading, so it reads as part of the panel before it`,
      ).toBeInTheDocument();
    }
  });
});

describe("the record's own provenance line", () => {
  it("names the weather provider the run recorded, and nothing it did not", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const attribution = document.querySelector('[data-attribution="true"]');
    expect(attribution).toHaveTextContent("open-meteo");
    expect(attribution).toHaveTextContent("Berlin, Germany");
  });

  it("says a field is not reported rather than filling it in", async () => {
    fetchMock = backend(200, {
      ...RECORD,
      weather_provider: null,
      llm_provider: null,
      llm_model: null,
      evidence: { ...STORED_EVIDENCE, llm_provider: null, llm_model: null },
    });
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const attribution = document.querySelector('[data-attribution="true"]');
    expect(attribution).toHaveTextContent("not reported");

    const synthesis = screen.getByRole("region", { name: "Final grounded synthesis" });
    expect(synthesis.textContent).not.toMatch(/Model:/);
  });

  it("names the model, gateway and policy the stored attempt actually recorded", async () => {
    /*
     * Task 33.6. An evidence record is read to check claims, and "a language model wrote this
     * sentence" is one of them — which is why the record carries the attempts rather than only the
     * configured pair. `llm_provider` and `llm_model` name a client that was wired up; the attempt
     * names what ran, and the policy that resolved it.
     */
    fetchMock = backend(200, {
      ...RECORD,
      evidence: {
        ...STORED_EVIDENCE,
        inference_attempts: [
          {
            stage: "routing",
            status: "served",
            attempt_number: 1,
            provider: "openrouter",
            selected_model: "a-routing-model",
            served_model: "a-routing-model",
            policy_id: "free-routing",
            plan: "free",
            resolution_reason: "First enabled candidate of the plan's routing policy.",
          },
          {
            stage: "synthesis",
            status: "served",
            attempt_number: 2,
            provider: "openrouter",
            selected_model: "asked-for-this",
            served_model: "got-that-instead",
            catalog_key: "asked-for-this",
            policy_id: "free-synthesis",
            plan: "free",
            resolution_reason: "The first candidate was rate limited.",
          },
        ],
      },
    });
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const synthesis = screen.getByRole("region", { name: "Final grounded synthesis" });
    // The synthesis attempt, not the routing one, and the model the gateway reported serving.
    expect(within(synthesis).getByText("Model: openrouter · got-that-instead")).toBeInTheDocument();
    expect(
      within(synthesis).getByText("Requested: asked-for-this, substituted by the gateway"),
    ).toBeInTheDocument();
    expect(within(synthesis).getByText("Policy: free-synthesis")).toBeInTheDocument();
    expect(
      within(synthesis).getByText("Resolved: The first candidate was rate limited."),
    ).toBeInTheDocument();
    // Not the configured pair the record also holds.
    expect(within(synthesis).queryByText(/a-configured-model/)).toBeNull();
  });

  it("says the pair is configured when the record holds no served attempt", async () => {
    fetchMock = backend(200, {
      ...RECORD,
      evidence: {
        ...STORED_EVIDENCE,
        inference_attempts: [
          { stage: "synthesis", status: "timeout", provider: "openrouter", selected_model: "a-model" },
        ],
      },
    });
    renderScreen();
    await screen.findByRole("region", { name: "Execution flow" });

    const synthesis = screen.getByRole("region", { name: "Final grounded synthesis" });
    expect(
      within(synthesis).getByText(/Model: openrouter · a-configured-model \(configured/),
    ).toBeInTheDocument();
    expect(within(synthesis).queryByText(/^Policy:/)).toBeNull();
  });
});

describe("a partial run", () => {
  it("says which bound was reached and still shows everything that ran before it", async () => {
    fetchMock = backend(200, {
      ...RECORD,
      partial: true,
      evidence: {
        ...STORED_EVIDENCE,
        partial: true,
        partial_reason: "the step budget was exhausted",
      },
    });
    renderScreen();

    expect(await screen.findByText(/This run is partial: the step budget was exhausted/)).toBeInTheDocument();
    expect(document.querySelector('[data-run-status="partial"]')).not.toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Execution flow" })).getAllByRole("listitem"),
    ).toHaveLength(STORED_EVIDENCE.agents.length);
  });
});
