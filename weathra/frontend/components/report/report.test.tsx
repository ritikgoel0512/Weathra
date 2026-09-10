/**
 * Weather Intelligence Report — composed from five endpoints, and adding no figure of its own.
 *
 * The case that matters most is the last one: the report is complete before any language model is
 * asked anything. The artifact's narrative appears the moment the page opens; Weathra's costs a
 * model call and an allowance, so it is a control rather than a side effect of navigation.
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
      attribution: { provider: "open-meteo", location: BERLIN },
      hourly: { granularity: "hourly", units: {}, entries: [] },
      daily: {
        granularity: "daily",
        units: { temperature_max: "°C" },
        entries: [
          { time_local: "2026-09-10T00:00:00+02:00", time_utc: "a", values: { temperature_max: 19.6 } },
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
        { measure: "temperature", statistic: "mean", value: 15.1, unit: "°C", method: "m", minimum_points: 1, points_used: 4, provenance: {} },
      ],
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
      "Computed for this window",
      "Against the record",
    ]) {
      expect(await screen.findByRole("heading", { name: section })).toBeInTheDocument();
    }
  });

  it("shows the figures the endpoints returned, and adds none of its own", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Conditions now" });

    expect(screen.getByText("18.4 °C")).toBeInTheDocument();
    expect(await screen.findByText(/mean temperature across the window/)).toBeInTheDocument();
    expect(await screen.findByText("14.7 °C")).toBeInTheDocument();
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

    for (const invented of ["Neural Agent", "neural agent", "Evidence Nodes", "Download PDF", "Export PDF"]) {
      expect(text, `the report mentions ${invented}`).not.toContain(invented);
    }
  });
});
