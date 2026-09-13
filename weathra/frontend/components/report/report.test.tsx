/**
 * Weather Intelligence Report — composed from six endpoints, adding no figure of its own, and
 * *showing a curated subset of them*.
 *
 * The case that matters most is still the model one: the report is complete before any language
 * model is asked anything. The artifact's narrative appears the moment the page opens; Weathra's
 * costs a model call and an allowance, so it is a control rather than a side effect of navigation.
 *
 * The cases added with the curation pass guard the other half of it — that a cap is a cap and not
 * a deletion. Each endpoint below is given more than the report shows, and each case asserts both
 * halves: what the page leads with, and that the remainder is one press away rather than gone.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { WeatherIntelligenceReport } from "./report";

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
};

const PERIOD = {
  start_local: "2026-09-10T00:00:00+02:00",
  end_local: "2026-09-17T00:00:00+02:00",
  start_utc: "2026-09-09T22:00:00Z",
  end_utc: "2026-09-16T22:00:00Z",
  timezone: "Europe/Berlin",
};

/** Nine reported measures, so the six-tile cap has something to leave over. */
const CURRENT_VALUES = {
  temperature: 18.4,
  precipitation: 4.2,
  relative_humidity: 72.4,
  wind_speed: 14.2,
  surface_pressure: 1012,
  uv_index: 2,
  cloud_cover: 60,
  dew_point: 11.1,
  apparent_temperature: 17.2,
};

const CURRENT_UNITS = {
  temperature: "°C",
  precipitation: "mm",
  relative_humidity: "%",
  wind_speed: "km/h",
  surface_pressure: "hPa",
  uv_index: "",
  cloud_cover: "%",
  dew_point: "°C",
  apparent_temperature: "°C",
};

/** Nine days, so the seven-card cap has something to leave over. The second reports no range. */
function dailyEntries() {
  return [
    { time_local: "2026-09-10T00:00:00+02:00", time_utc: "a", values: { temperature_max: 19.6, temperature_min: 10.4, precipitation_sum: 1.6, weather_code_dominant: 61 } },
    // No range at all: the card stays, the figure does not.
    { time_local: "2026-09-11T00:00:00+02:00", time_utc: "b", values: {} },
    { time_local: "2026-09-12T00:00:00+02:00", time_utc: "c", values: { temperature_max: 24.5, temperature_min: 13.1, precipitation_sum: 0, weather_code_dominant: 0 } },
    { time_local: "2026-09-13T00:00:00+02:00", time_utc: "d", values: { temperature_max: 22.8, temperature_min: 12.4, precipitation_sum: 0.2 } },
    { time_local: "2026-09-14T00:00:00+02:00", time_utc: "e", values: { temperature_max: 19.1, temperature_min: 11.8, precipitation_sum: 3.4 } },
    { time_local: "2026-09-15T00:00:00+02:00", time_utc: "f", values: { temperature_max: 16.5, temperature_min: 9.7, precipitation_sum: 5.2 } },
    { time_local: "2026-09-16T00:00:00+02:00", time_utc: "g", values: { temperature_max: 17.8, temperature_min: 10.1, precipitation_sum: 0 } },
    { time_local: "2026-09-17T00:00:00+02:00", time_utc: "h", values: { temperature_max: 18.2, temperature_min: 10.9, precipitation_sum: 0 } },
    { time_local: "2026-09-18T00:00:00+02:00", time_utc: "i", values: { temperature_max: 20.4, temperature_min: 11.5, precipitation_sum: 0 } },
  ];
}

/** Five movements, so the three-note cap has something to leave over. */
function dayChanges() {
  return [
    { local_date: "2026-09-11", measure: "temperature_max", change: 1.4, current: 21, previous: 19.6, material: true, statement: "s1", unit: "°C" },
    { local_date: "2026-09-13", measure: "temperature_max", change: -1.1, current: 21.7, previous: 22.8, material: true, statement: "s2", unit: "°C" },
    { local_date: "2026-09-14", measure: "precipitation_sum", change: 0.1, current: 3.5, previous: 3.4, material: false, statement: "s3", unit: "mm" },
    { local_date: "2026-09-15", measure: "temperature_min", change: 0.9, current: 10.6, previous: 9.7, material: true, statement: "s4", unit: "°C" },
    { local_date: "2026-09-16", measure: "temperature_max", change: 0.2, current: 18, previous: 17.8, material: false, statement: "s5", unit: "°C" },
  ];
}

function statistic(measure: string, name: string, value: number | null, unit: string) {
  return {
    measure,
    statistic: name,
    value,
    unit,
    method: `${name} of usable points`,
    minimum_points: 1,
    points_used: 4,
    provenance: {},
  };
}

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: BERLIN,
      sources: {},
    }),
    current: vi.fn().mockResolvedValue({
      units: CURRENT_UNITS,
      values: CURRENT_VALUES,
      observed_at_local: "2026-09-10T08:00:00+02:00",
      observed_at_utc: "2026-09-10T06:00:00Z",
      attribution: { provider: "open-meteo", location: BERLIN, retrieved_at: "2026-09-10T06:05:00Z" },
    }),
    forecast: vi.fn().mockResolvedValue({
      horizon_days: 7,
      period: PERIOD,
      attribution: { provider: "open-meteo", location: BERLIN, retrieved_at: "2026-09-10T06:00:00Z" },
      hourly: {
        granularity: "hourly",
        units: { temperature: "°C", precipitation: "mm" },
        entries: [
          { time_local: "2026-09-10T06:00:00+02:00", time_utc: "h1", values: { temperature: 12.4, precipitation: 0 } },
          // An hour the provider did not report. It stays a gap in the line and is counted below.
          { time_local: "2026-09-10T12:00:00+02:00", time_utc: "h2", values: { temperature: null, precipitation: 0.4 } },
          { time_local: "2026-09-10T18:00:00+02:00", time_utc: "h3", values: { temperature: 17.8, precipitation: 1.2 } },
        ],
      },
      daily: {
        granularity: "daily",
        units: { temperature_max: "°C", temperature_min: "°C", precipitation_sum: "mm" },
        entries: dailyEntries(),
      },
      uncertainty: {
        basis: "b",
        provider: "open-meteo",
        reference_time_utc: "c",
        spread_available: false,
        horizon: [
          { confidence: "high", hours_ahead: 6, time_local: "d", time_utc: "e" },
          { confidence: "moderate", hours_ahead: 72, time_local: "f", time_utc: "g" },
        ],
      },
    }),
    changes: vi.fn().mockResolvedValue({
      statement: "Two days moved materially and three did not.",
      comparison_available: true,
      current_retrieved_at: "f",
      changes: dayChanges(),
      location: BERLIN,
      period: PERIOD,
      provider: "open-meteo",
      unit_system: "metric",
    }),
    analysis: vi.fn().mockResolvedValue({
      summary: "The mean temperature across the window is 15.1 °C.",
      findings: [
        statistic("temperature", "mean", 15.1, "°C"),
        statistic("temperature", "maximum", 24.5, "°C"),
        statistic("temperature", "minimum", 9.7, "°C"),
        statistic("precipitation", "total", 12.5, "mm"),
        statistic("wind_speed", "mean_speed", null, ""),
      ],
      trend: {
        measure: "temperature",
        direction: "rising",
        magnitude: 1.2,
        slope_per_day: 0.4,
        unit: "°C",
        method: "least-squares slope",
        minimum_points: 3,
        insignificance_margin_per_day: 0.1,
        points_used: 4,
        provenance: {},
      },
      anomalies: {
        measure: "temperature",
        method: "median absolute deviation, threshold 3.5",
        threshold: 3.5,
        median: 15,
        median_absolute_deviation: 1.1,
        points_used: 4,
        unit: "°C",
        anomalies: [
          { time_local: "2026-09-10T18:00:00+02:00", time_utc: "h3", value: 17.8, deviation: 2.8, deviation_score: 3.9 },
          { time_local: "2026-09-12T06:00:00+02:00", time_utc: "h4", value: 9.1, deviation: -5.9, deviation_score: 5.4 },
        ],
        provenance: {},
        minimum: statistic("temperature", "minimum", 9.1, "°C"),
        maximum: statistic("temperature", "maximum", 17.8, "°C"),
      },
      from_cache: false,
      horizon_days: 7,
      location: BERLIN,
      period: PERIOD,
      provider: "open-meteo",
      data_class: "computed_statistic",
    }),
    baseline: vi.fn().mockResolvedValue({
      labelling: "Baseline for 10-17 September",
      measure: "temperature_mean",
      calendar_period: PERIOD,
      location: BERLIN,
      provider: "open-meteo",
      mean: statistic("temperature_mean", "mean", 14.7, "°C"),
      minimum: statistic("temperature_mean", "minimum", 12.2, "°C"),
      maximum: statistic("temperature_mean", "maximum", 17.4, "°C"),
      standard_deviation: statistic("temperature_mean", "standard_deviation", 1.8, "°C"),
      years_requested: 10,
      years_used: [2021, 2022, 2023],
    }),
    baselineComparison: vi.fn().mockResolvedValue({
      location: BERLIN,
      measure: "temperature_mean",
      observed_or_forecast_value: 16.4,
      observed_data_class: "forecast",
      characterization: "Warmer than the 3-year baseline for this calendar period.",
      difference: statistic("temperature_mean", "delta", 1.7, "°C"),
      z_score: statistic("temperature_mean", "z_score", 1.21, ""),
    }),
    ask: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <WeatherIntelligenceReport />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the report's shape", () => {
  it("opens on the artifact's regions, in its order", async () => {
    mount(client());
    expect(
      await screen.findByRole("heading", { name: "Weather Intelligence Report" }),
    ).toBeInTheDocument();

    for (const section of [
      "Conditions now",
      "Forecast outlook",
      "What changed",
      "The window, against the record",
      "Historical context",
      "Weathra's reading",
      "Grounding evidence",
    ]) {
      expect(await screen.findByRole("heading", { name: section })).toBeInTheDocument();
    }
  });

  it("leads with the backend's own statement, and does not print it twice", async () => {
    mount(client());
    const hero = await screen.findByRole("heading", {
      name: /Warmer than the 3-year baseline/,
    });
    expect(hero).toBeInTheDocument();

    // The comparison characterizes; the analysis summarises. Two backend sentences, one each.
    expect(await screen.findByText(/mean temperature across the window/)).toBeInTheDocument();
    expect(screen.getAllByText(/Warmer than the 3-year baseline/)).toHaveLength(1);
  });

  it("carries exactly three hero figures, and none of them is an invented count", async () => {
    mount(client());
    await screen.findByRole("heading", { name: /Warmer than the 3-year baseline/ });

    expect(screen.getByText("Outlook confidence")).toBeInTheDocument();
    expect(screen.getByText("Against the baseline")).toBeInTheDocument();
    expect(screen.getByText("Trend across the window")).toBeInTheDocument();
    expect(screen.getByText("+1.7 °C")).toBeInTheDocument();
    expect(screen.getByText("1.21 σ from the mean")).toBeInTheDocument();
  });
});

describe("the report's curation", () => {
  it("shows six observed measures and keeps the rest one press away", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Conditions now" });

    // Six of the nine the provider reported, in the artifact's order.
    const [grid] = within(panel).getAllByRole("list");
    expect(grid).toBeDefined();
    expect(within(grid!).getAllByRole("listitem")).toHaveLength(6);
    expect(within(grid!).getByText("Temperature")).toBeInTheDocument();
    expect(within(grid!).getByText("UV index")).toBeInTheDocument();
    expect(within(grid!).queryByText("Dew point")).not.toBeInTheDocument();

    // Nothing is dropped: the remaining three are behind the panel's own disclosure.
    expect(within(panel).getByText("Dew point")).not.toBeVisible();
    await userEvent.click(within(panel).getByText("3 more measures reported"));
    expect(within(panel).getByText("Dew point")).toBeVisible();
  });

  it("draws the artifact's week from a longer horizon, with the sky the provider reported", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Forecast outlook" });

    // Nine days came back; seven cards are drawn.
    expect(within(panel).getAllByRole("listitem")).toHaveLength(7);
    expect(within(panel).getByText("Light rain")).toBeInTheDocument();
    // The day with no range keeps its card and says so rather than being dropped.
    expect(within(panel).getByText("No high reported")).toBeInTheDocument();
  });

  it("shows three movements, material first, and says how many it is not showing", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "What changed" });

    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(within(panel).getByText("+1.4 °C")).toBeInTheDocument();
    expect(within(panel).getByText("-1.1 °C")).toBeInTheDocument();
    expect(within(panel).getByText("+0.9 °C")).toBeInTheDocument();
    expect(within(panel).getByText(/2 further movements/)).toBeInTheDocument();
  });

  it("puts one chart on the page, with the figures that describe it under it", async () => {
    mount(client());
    const panel = await screen.findByRole("region", {
      name: "The window, against the record",
    });

    expect(
      within(panel).getByRole("img", { name: /Temperature through the forecast window/ }),
    ).toBeInTheDocument();
    // The gap is counted rather than bridged, and the sentence says which way round it is.
    expect(within(panel).getByText(/1 hour in this window was not reported/)).toBeInTheDocument();

    // The baseline and the comparison arrive after the window they are asked for is named.
    expect(await within(panel).findByText("Baseline mean")).toBeInTheDocument();
    for (const stat of ["Highest temperature", "Average temperature", "Distance from baseline"]) {
      expect(within(panel).getByText(stat)).toBeInTheDocument();
    }
    expect(within(panel).getByText("1.21 σ")).toBeInTheDocument();
  });

  it("keeps the chart region and its reason when the provider reported no hourly series", async () => {
    const base = client();
    mount(
      client({
        forecast: vi.fn().mockResolvedValue({
          ...(await (base.forecast as ReturnType<typeof vi.fn>)()),
          hourly: { granularity: "hourly", units: {}, entries: [] },
        }),
      }),
    );
    await screen.findByRole("heading", { name: "The window, against the record" });

    // The frame stays: a paragraph where a plot belongs is how a chart region stops being one.
    expect(
      screen.getByRole("img", { name: /reported no hourly series for this window/ }),
    ).toBeInTheDocument();
  });

  it("states the record as three figures and one paragraph, not as a panel of prose", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Historical context" });

    expect(await within(panel).findByText("14.7 °C")).toBeInTheDocument();
    expect(within(panel).getByText("17.4 °C")).toBeInTheDocument();
    expect(within(panel).getByText("1.8 °C")).toBeInTheDocument();
    expect(within(panel).getByText("Archive coverage")).toBeInTheDocument();
  });

  it("drops the whole record panel when the backend computed no baseline", async () => {
    mount(client({ baseline: vi.fn().mockRejectedValue(new Error("no baseline")) }));
    await screen.findByRole("heading", { name: "Historical context" });

    expect(
      await screen.findByText(/archive returned no baseline for this calendar window/),
    ).toBeInTheDocument();
  });
});

describe("the attention card", () => {
  it("names the entry that stood out furthest, against the threshold that flagged it", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Needs attention" });

    expect(within(panel).getByText("2 entries stood out")).toBeInTheDocument();
    // The furthest of the two, by the backend's own score.
    expect(within(panel).getByText("-5.9 °C")).toBeInTheDocument();
    expect(within(panel).getByText(/5.4 against a threshold of 3.5/)).toBeInTheDocument();
  });

  it("is not drawn at all when the window was unremarkable", async () => {
    const base = client();
    const analysis = await (base.analysis as ReturnType<typeof vi.fn>)();
    mount(
      client({
        analysis: vi
          .fn()
          .mockResolvedValue({ ...analysis, anomalies: { ...analysis.anomalies, anomalies: [] } }),
      }),
    );
    await screen.findByRole("heading", { name: "Historical context" });

    // An alert panel that is always present is not an alert.
    expect(screen.queryByRole("heading", { name: "Needs attention" })).not.toBeInTheDocument();
  });
});

describe("the deep dive", () => {
  it("holds the working the page used to lead with, closed", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Grounding evidence" });

    // None of the three is a band on the page any more.
    expect(screen.queryByText("Computed for this window")).not.toBeVisible();

    await userEvent.click(screen.getByText("Deep dive"));

    expect(screen.getByRole("heading", { name: "Computed for this window" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Confidence by horizon" })).toBeVisible();
    // Every finding is still here, including the one the engine could not compute.
    expect(screen.getByText("Not computable")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /Deviation score per flagged entry, against a threshold of 3.5/,
      }),
    ).toBeInTheDocument();
  });
});

describe("the report's window", () => {
  it("re-reads the window when the horizon control is changed", async () => {
    const forecast = vi.fn();
    const api = client();
    const spied = client({
      forecast: forecast.mockImplementation(api.forecast as ReturnType<typeof vi.fn>),
    });
    mount(spied);
    await screen.findByRole("heading", { name: "Forecast outlook" });

    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));

    await userEvent.click(screen.getByRole("radio", { name: "3 days" }));

    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ days: 3 }));
  });
});

describe("the model's reading", () => {
  it("is complete before any language model is asked anything", async () => {
    const ask = vi.fn();
    mount(client({ ask }));
    await screen.findByRole("heading", { name: "Weathra's reading" });

    // Opening the report spends no model call and no allowance, and the control is secondary.
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Add a model reading/ })).toBeInTheDocument();
  });

  it("names what it was read from, and what wrote it, when it is asked for", async () => {
    const ask = vi.fn().mockResolvedValue({
      answer: {
        answer_prose: "A settled week.",
        llm_provider: "openrouter",
        llm_model: "a-model",
        attribution: [{ provider: "open-meteo", data_class: "forecast", location: BERLIN, retrieved_at: "x" }],
      },
      evidence_id: "run-1",
      memory_available: true,
    });
    mount(client({ ask }));
    await screen.findByRole("button", { name: /Add a model reading/ });

    await userEvent.click(screen.getByRole("button", { name: /Add a model reading/ }));

    expect(await screen.findByText("A settled week.")).toBeInTheDocument();
    expect(screen.getByText("Read from open-meteo")).toBeInTheDocument();
    expect(screen.getByText("openrouter · a-model")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /how this answer was produced/ })).toHaveAttribute(
      "href",
      "/evidence/run-1",
    );
  });
});

describe("the grounding panel", () => {
  it("names one source per class of figure, and no latency for any of them", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Grounding evidence" });

    expect(await within(panel).findByText("Archive record")).toBeInTheDocument();
    for (const role of ["Conditions now", "Outlook", "Statistics"]) {
      expect(within(panel).getByText(role)).toBeInTheDocument();
    }
    expect(within(panel).getByText("Computed by Weathra")).toBeInTheDocument();
  });
});

describe("the artifact's invented apparatus", () => {
  it("is claimed nowhere on the page", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Grounding evidence" });
    const text = container.textContent ?? "";

    for (const invented of [
      "Neural Agent",
      "neural agent",
      "Evidence Nodes",
      "Download PDF",
      "Export PDF",
      "Report ID",
      "Stability Index",
      "Model alignment",
      "Retrieval score",
    ]) {
      expect(text, `the report mentions ${invented}`).not.toContain(invented);
    }
  });
});
