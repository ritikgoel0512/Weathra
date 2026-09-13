/**
 * Weather Intelligence Report — the artifact's composition, from real endpoints only.
 *
 * Two things these cases exist to hold shut, and both were defects the last pass left behind.
 *
 * **The report is complete when it is generated.** The synthesis was a button, so the artifact's
 * most conclusive block was the one obviously unfinished thing on the page. It runs with the
 * report now — once per window, not once per render, because it is a real model call against a real
 * allowance and a duplicate is a real cost.
 *
 * **A cap is a cap and not a deletion.** Each endpoint below returns more than the report shows,
 * and each case asserts both halves: what the page leads with, and that the remainder is one press
 * away rather than gone.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  temperature: 18.44,
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
    { local_date: "2026-09-11", measure: "temperature_max", change: 1.4, current: 21, previous: 19.6, material: true, statement: "The high for 11 September rose.", unit: "°C" },
    { local_date: "2026-09-13", measure: "temperature_max", change: -1.1, current: 21.7, previous: 22.8, material: true, statement: "The high for 13 September fell.", unit: "°C" },
    { local_date: "2026-09-14", measure: "precipitation_sum", change: 0.1, current: 3.5, previous: 3.4, material: false, statement: "Rainfall for 14 September barely moved.", unit: "mm" },
    { local_date: "2026-09-15", measure: "temperature_min", change: 0.9, current: 10.6, previous: 9.7, material: true, statement: "The low for 15 September rose.", unit: "°C" },
    { local_date: "2026-09-16", measure: "temperature_max", change: 0.2, current: 18, previous: 17.8, material: false, statement: "The high for 16 September barely moved.", unit: "°C" },
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

const ANSWER = {
  answer: {
    answer_prose: "A settled week, a little warmer than the record for this window.",
    llm_provider: "openrouter",
    llm_model: "a-model",
    grounding: { verified: true, figures_checked: 9, method: "m" },
  },
  evidence_id: "run-9b5849dd-1a2b",
  memory_available: true,
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
      statement: "Three days moved materially and two did not.",
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
          { time_local: "2026-09-12T06:00:00+02:00", time_utc: "h4", value: 9.1, deviation: -5.9, deviation_score: 7.250775664373425 },
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
      characterization:
        "16.4 °C is 1.7 °C above the 3-year baseline temperature mean of 14.7 °C (+0.67 standard deviations).",
      difference: statistic("temperature_mean", "delta", 1.7, "°C"),
      z_score: { ...statistic("temperature_mean", "z_score", 0.6706849412785952, ""), unit: "" },
    }),
    ask: vi.fn().mockResolvedValue(ANSWER),
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

describe("the report's composition", () => {
  it("opens on the artifact's regions, under the artifact's names", async () => {
    mount(client());
    expect(
      await screen.findByRole("heading", { name: "Weather Intelligence Report" }),
    ).toBeInTheDocument();

    for (const region of [
      "Forecast outlook",
      "What changed?",
      "Deterministic thermal analysis",
      "Historical context",
      "Anomaly attention",
      "Grounded synthesis",
      "Grounding evidence",
    ]) {
      expect(await screen.findByRole("heading", { name: region })).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "Current conditions" })).toBeInTheDocument();
  });

  it("leads with a decision-level headline rather than with the backend's arithmetic", async () => {
    mount(client());
    const headline = await screen.findByRole("heading", {
      name: /Slightly above the seasonal record/,
    });

    expect(headline).toHaveTextContent(
      "Slightly above the seasonal record, warming through the window, with rain on 4 of 7 days.",
    );
    // The exact sentence is still on the page, one level down, where being exact is the job.
    expect(screen.getByText(/is 1.7 °C above the 3-year baseline/)).toBeInTheDocument();
  });

  it("draws no photograph where the artifact puts its conclusion", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: /Slightly above the seasonal record/ });

    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("carries exactly three hero figures, none of them an invented count", async () => {
    mount(client());
    await screen.findByRole("heading", { name: /Slightly above the seasonal record/ });

    expect(screen.getByText("Outlook confidence")).toBeInTheDocument();
    expect(screen.getByText("Grounded sources")).toBeInTheDocument();
    // How unusual the *window* is. Which entry was worst belongs to the attention card, and
    // printing one figure in both places is the duplication this composition exists to remove.
    expect(screen.getByText("Distance from baseline")).toBeInTheDocument();
    expect(screen.getByText("0.67σ")).toBeInTheDocument();
    expect(screen.getAllByText("-5.9 °C")).toHaveLength(1);
  });
});

describe("the report's curation", () => {
  it("shows six observed measures with their glyphs, and keeps the rest one press away", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Current conditions" });

    const [grid] = within(panel).getAllByRole("list");
    expect(grid).toBeDefined();
    expect(within(grid!).getAllByRole("listitem")).toHaveLength(6);
    expect(within(grid!).getByText("UV index")).toBeInTheDocument();
    // Rounded at the tile, never at the precision the provider sent.
    expect(within(grid!).getByText("18.4")).toBeInTheDocument();

    expect(within(panel).getByText("Dew point")).not.toBeVisible();
    await userEvent.click(within(panel).getByText("More conditions (3)"));
    expect(within(panel).getByText("Dew point")).toBeVisible();
  });

  it("draws the artifact's week from a longer horizon, with the sky the provider reported", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Forecast outlook" });

    expect(within(panel).getAllByRole("listitem")).toHaveLength(7);
    // The day with no high keeps its card and names what it did report.
    expect(within(panel).getByText("No high reported")).toBeInTheDocument();
  });

  it("names each movement's subject, and states a first retrieval as its own state", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "What changed?" });

    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(within(panel).getAllByText("Temperature shift")).toHaveLength(3);
    expect(within(panel).getByText("+1.4 °C")).toBeInTheDocument();
    expect(within(panel).getByText(/2 further movements/)).toBeInTheDocument();
  });

  it("reports a window with no earlier retrieval in two lines, not a panel of prose", async () => {
    mount(
      client({
        changes: vi.fn().mockResolvedValue({
          statement: "No earlier snapshot of this window is on record.",
          comparison_available: false,
          current_retrieved_at: "f",
          location: BERLIN,
          period: PERIOD,
          provider: "open-meteo",
          unit_system: "metric",
        }),
      }),
    );
    const panel = await screen.findByRole("region", { name: "What changed?" });

    expect(
      await within(panel).findByText("No earlier retrieval of this window is stored yet."),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/baseline the next one is compared against/)).toBeInTheDocument();
  });

  it("puts one chart on the page, with four rounded figures under it", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Deterministic thermal analysis" });

    expect(
      within(panel).getByRole("img", { name: /Temperature through the forecast window/ }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/1 hour in this window was not reported/)).toBeInTheDocument();

    expect(await within(panel).findByText("Baseline mean")).toBeInTheDocument();
    for (const stat of ["Highest temperature", "Average temperature", "Against baseline"]) {
      expect(within(panel).getByText(stat)).toBeInTheDocument();
    }
    // The sigma is the hero's figure; this row states the difference in the measure's own unit.
    expect(within(panel).getByText("+1.7 °C")).toBeInTheDocument();
    expect(within(panel).queryByText("0.67σ")).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "Deterministic thermal analysis" });

    expect(
      screen.getByRole("img", { name: /reported no hourly series for this window/ }),
    ).toBeInTheDocument();
  });

  it("states the record as three figures and the archive's own labelling", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Historical context" });

    expect(await within(panel).findByText("14.7 °C")).toBeInTheDocument();
    expect(within(panel).getByText("17.4 °C")).toBeInTheDocument();
    expect(within(panel).getByText("Archive coverage")).toBeInTheDocument();
    // Not the hero's supporting sentence again, and no legalistic caveat in a context card.
    expect(within(panel).queryByText(/standard deviations/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/meteorological authority/)).not.toBeInTheDocument();
  });
});

describe("the attention card", () => {
  it("leads with one deviation and hides the method that found it", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Anomaly attention" });

    expect(within(panel).getByText("-5.9 °C")).toBeInTheDocument();
    expect(within(panel).getByText("Strongest deviation in this window")).toBeInTheDocument();
    expect(within(panel).getByText(/2 entries flagged/)).toBeInTheDocument();
    expect(within(panel).queryByText(/median absolute deviation/)).not.toBeInTheDocument();
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

    expect(screen.queryByRole("heading", { name: "Anomaly attention" })).not.toBeInTheDocument();
  });
});

describe("the grounded synthesis", () => {
  it("is part of generating the report, not a control on it", async () => {
    const ask = vi.fn().mockResolvedValue(ANSWER);
    mount(client({ ask }));

    expect(
      await screen.findByText("A settled week, a little warmer than the record for this window."),
    ).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
    // The control the artifact does not have, and the report no longer needs.
    expect(screen.queryByRole("button", { name: /model reading/i })).not.toBeInTheDocument();
  });

  it("names the classes it was grounded on and links the run that produced it", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Grounded synthesis" });

    for (const chip of ["Conditions now", "Forecast", "Archive record", "Analytics"]) {
      expect(await within(panel).findByText(chip)).toBeInTheDocument();
    }
    expect(within(panel).getByRole("link", { name: /Audit intelligence trace/ })).toHaveAttribute(
      "href",
      "/evidence/run-9b5849dd-1a2b",
    );
  });

  it("spends one run per window rather than one per render", async () => {
    const ask = vi.fn().mockResolvedValue(ANSWER);
    mount(client({ ask }));
    await screen.findByText("A settled week, a little warmer than the record for this window.");

    await userEvent.click(screen.getByRole("radio", { name: "3 days" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));

    // Settling, re-rendering and the other five reads resolving are not further runs.
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  });

  it("keeps the rest of the report when the model call fails", async () => {
    mount(client({ ask: vi.fn().mockRejectedValue(new Error("allowance exhausted")) }));
    await screen.findByRole("heading", { name: "Grounded synthesis" });

    expect(await screen.findByText(/That reading was not produced/)).toBeInTheDocument();
    expect(
      screen.getByText(/Everything above is retrieved or computed and is unaffected/),
    ).toBeInTheDocument();
    // The chart is still there.
    expect(
      screen.getByRole("img", { name: /Temperature through the forecast window/ }),
    ).toBeInTheDocument();
  });
});

describe("the header, the grounding panel and the status strip", () => {
  it("names the report by the run that can be audited", async () => {
    mount(client());
    expect(await screen.findByText("Report ref · 9B5849DD")).toBeInTheDocument();
  });

  it("re-reads the window when the horizon control is changed", async () => {
    const forecast = vi.fn();
    const api = client();
    mount(client({ forecast: forecast.mockImplementation(api.forecast as ReturnType<typeof vi.fn>) }));
    await screen.findByRole("heading", { name: "Forecast outlook" });

    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));
    await userEvent.click(screen.getByRole("radio", { name: "3 days" }));
    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ days: 3 }));
  });

  it("names one source per class of figure, the model included", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Grounding evidence" });

    for (const role of ["Conditions now", "Forecast", "Archive record", "Analytics"]) {
      expect(await within(panel).findByText(role)).toBeInTheDocument();
    }
    expect(within(panel).getByText("Weathra")).toBeInTheDocument();
    expect(await within(panel).findByText("Synthesis")).toBeInTheDocument();
  });

  it("reports the reads that returned and the grounding check that ran", async () => {
    mount(client());
    expect(await screen.findByText("Retrieval complete")).toBeInTheDocument();
    expect(await screen.findByText("Grounding verified")).toBeInTheDocument();
  });
});

describe("the deep dive", () => {
  it("holds the working the page used to lead with, closed", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Grounding evidence" });

    expect(screen.getByText("Computed for this window")).not.toBeVisible();

    await userEvent.click(screen.getByText("Deep dive"));

    expect(screen.getByRole("heading", { name: "Computed for this window" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Confidence by horizon" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "What was retrieved, and when" })).toBeVisible();
    // Every finding is still here, including the one the engine could not compute.
    expect(screen.getByText("Not computable")).toBeInTheDocument();
    // And the caveat the context card no longer carries.
    expect(screen.getByText(/not a climate normal published by a meteorological authority/)).toBeVisible();
  });
});

describe("the artifact's invented apparatus", () => {
  it("is claimed nowhere on the page, and no raw float reaches it", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Grounding evidence" });
    await screen.findByText("Grounding verified");
    const text = container.textContent ?? "";

    for (const invented of [
      "Neural Agent",
      "neural agent",
      "Evidence Nodes",
      "Export PDF",
      "Stability Index",
      "Model alignment",
      "Retrieval score",
      "sensor",
      "SYSTEM_LOCKED",
    ]) {
      expect(text, `the report mentions ${invented}`).not.toContain(invented);
    }

    // No figure is printed at the precision it was computed at.
    expect(text).not.toContain("0.6706849412785952");
    expect(text).not.toContain("7.250775664373425");
    // Every sigma figure on the page is at two places, which is where a z-score stops meaning
    // anything more.
    for (const sigma of text.match(/-?\d+(\.\d+)?σ/g) ?? []) {
      expect(sigma).toMatch(/^-?\d+(\.\d{1,2})?σ$/);
    }
  });
});
