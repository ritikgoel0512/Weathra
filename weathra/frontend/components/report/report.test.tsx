/**
 * Weather Intelligence Report — composed from five endpoints, and adding no figure of its own.
 *
 * The case that matters most is still the model one: the report is complete before any language
 * model is asked anything. The artifact's narrative appears the moment the page opens; Weathra's
 * costs a model call and an allowance, so it is a control rather than a side effect of navigation.
 *
 * The cases added with the graphical rebuild guard the other half of that bargain — that the
 * graphics are drawn from what came back and from nothing else. A window with no hourly series
 * gets the chart frame and the reason rather than a plotted line; a baseline the backend could not
 * compute takes its panel with it; and a day the provider reported no range for keeps its card and
 * says so instead of being given a bar.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: BERLIN,
      sources: {},
    }),
    current: vi.fn().mockResolvedValue({
      units: { temperature: "°C" },
      values: { temperature: 18.4 },
      observed_at_local: "x",
      observed_at_utc: "y",
      attribution: { provider: "open-meteo", location: BERLIN },
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
        units: { temperature_max: "°C", temperature_min: "°C" },
        entries: [
          { time_local: "2026-09-10T00:00:00+02:00", time_utc: "a", values: { temperature_max: 19.6, temperature_min: 10.4 } },
          // No range at all: the card stays, the bar does not.
          { time_local: "2026-09-11T00:00:00+02:00", time_utc: "b", values: {} },
        ],
      },
      uncertainty: { basis: "b", provider: "open-meteo", reference_time_utc: "c", spread_available: false, horizon: [{ confidence: "high", hours_ahead: 6, time_local: "d", time_utc: "e" }] },
    }),
    changes: vi.fn().mockResolvedValue({
      statement: "The forecast has not moved since the last snapshot.",
      comparison_available: true,
      current_retrieved_at: "f",
      location: BERLIN,
      period: PERIOD,
      provider: "open-meteo",
      unit_system: "metric",
    }),
    analysis: vi.fn().mockResolvedValue({
      summary: "The mean temperature across the window is 15.1 °C.",
      findings: [
        { measure: "temperature", statistic: "mean", value: 15.1, unit: "°C", method: "arithmetic mean of usable points", minimum_points: 1, points_used: 4, provenance: {} },
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
        ],
        provenance: {},
        minimum: { value: 12.4, unit: "°C", measure: "temperature", statistic: "minimum", method: "m", minimum_points: 1, points_used: 4, provenance: {} },
        maximum: { value: 17.8, unit: "°C", measure: "temperature", statistic: "maximum", method: "m", minimum_points: 1, points_used: 4, provenance: {} },
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
      mean: { value: 14.7, unit: "°C", measure: "temperature_mean", statistic: "mean", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
      minimum: { value: 12.2, unit: "°C", measure: "temperature_mean", statistic: "minimum", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
      maximum: { value: 17.4, unit: "°C", measure: "temperature_mean", statistic: "maximum", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
      standard_deviation: { value: 1.8, unit: "°C", measure: "temperature_mean", statistic: "standard_deviation", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
      years_requested: 10,
      years_used: [2021, 2022, 2023],
    }),
    baselineComparison: vi.fn().mockResolvedValue({
      location: BERLIN,
      measure: "temperature_mean",
      observed_or_forecast_value: 16.4,
      observed_data_class: "forecast",
      characterization: "Warmer than the 3-year baseline for this calendar period.",
      difference: { value: 1.7, unit: "°C", measure: "temperature_mean", statistic: "delta", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
      z_score: { value: 1.21, unit: "", measure: "temperature_mean", statistic: "z_score", method: "m", minimum_points: 1, points_used: 3, provenance: {} },
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

describe("the report", () => {
  it("reads one place across every surface Weathra has", async () => {
    mount(client());
    expect(
      await screen.findByRole("heading", { name: "Weather Intelligence Report" }),
    ).toBeInTheDocument();

    for (const section of [
      "Conditions now",
      "The outlook",
      "What changed",
      "The window, against the record",
      "Computed for this window",
      "Against the record",
      "Confidence by horizon",
      "Weathra's reading",
      "What this was read from",
    ]) {
      expect(await screen.findByRole("heading", { name: section })).toBeInTheDocument();
    }
  });

  it("shows the figures the endpoints returned, and adds none of its own", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Conditions now" });

    // The hero readout and the observed tile are the same reading shown twice, by design.
    expect(screen.getAllByText("18.4 °C").length).toBeGreaterThan(0);
    expect(await screen.findByText(/mean temperature across the window/)).toBeInTheDocument();
    expect(await screen.findByText("14.7 °C")).toBeInTheDocument();
  });

  it("draws the window as a plot, and states the hours the provider did not report", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "The window, against the record" });

    expect(
      screen.getByRole("img", { name: /Temperature through the forecast window/ }),
    ).toBeInTheDocument();
    // The gap is counted rather than bridged, and the sentence says which way round it is.
    expect(screen.getByText(/1 hour in this window was not reported/)).toBeInTheDocument();
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

  it("gives a day no range bar when the provider reported neither end of it", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "The outlook" });

    expect(screen.getByRole("img", { name: "10.4 °C to 19.6 °C" })).toBeInTheDocument();
    // The second day has no minimum and no maximum. It keeps its card and says so.
    expect(screen.getByText("Not reported")).toBeInTheDocument();
  });

  it("plots the entries the backend flagged against the threshold that flagged them", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Computed for this window" });

    expect(
      await screen.findByRole("img", { name: /Deviation score per flagged entry, against a threshold of 3.5/ }),
    ).toBeInTheDocument();
  });

  it("places the window against the record with the backend's own figures", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Against the record" });

    // The artifact's "+1.4°C DRIFT DETECTED / 2.84σ" pair, as the two figures Weathra computes.
    expect(await screen.findByText("+1.7 °C")).toBeInTheDocument();
    expect(screen.getByText("1.21 standard deviations")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Warmer than the 3-year baseline/).length,
    ).toBeGreaterThan(0);
  });

  it("drops the whole record panel when the backend computed no baseline", async () => {
    mount(client({ baseline: vi.fn().mockRejectedValue(new Error("no baseline")) }));
    await screen.findByRole("heading", { name: "Against the record" });

    expect(
      await screen.findByText(/archive returned no baseline for this calendar window/),
    ).toBeInTheDocument();
  });

  it("is complete before any language model is asked anything", async () => {
    const ask = vi.fn();
    mount(client({ ask }));
    await screen.findByRole("heading", { name: "Against the record" });

    // Opening the report spends no model call and no allowance.
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Ask Weathra to read this/ })).toBeInTheDocument();
  });

  it("asks for the synthesis only when the control is pressed", async () => {
    const ask = vi.fn().mockResolvedValue({
      answer: { answer_prose: "A settled week.", llm_provider: "openrouter", llm_model: "a-model" },
      evidence_id: "run-1",
      memory_available: true,
    });
    mount(client({ ask }));
    await screen.findByRole("button", { name: /Ask Weathra to read this/ });

    await userEvent.click(screen.getByRole("button", { name: /Ask Weathra to read this/ }));

    expect(await screen.findByText("A settled week.")).toBeInTheDocument();
    // Named as a model's reading, with the model that wrote it and a way to see how.
    expect(screen.getByText(/openrouter · a-model/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /how this answer was produced/ })).toHaveAttribute(
      "href",
      "/evidence/run-1",
    );
  });

  it("claims none of the artifact's invented apparatus", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Against the record" });
    const text = container.textContent ?? "";

    for (const invented of [
      "Neural Agent",
      "neural agent",
      "Evidence Nodes",
      "Download PDF",
      "Export PDF",
      "Stability Index",
      "Model alignment",
      "Retrieval score",
    ]) {
      expect(text, `the report mentions ${invented}`).not.toContain(invented);
    }
  });
});
