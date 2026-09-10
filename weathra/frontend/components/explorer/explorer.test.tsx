/**
 * Forecast Explorer — the screen, and what it refuses to say.
 *
 * The second half matters as much as the first. `11-forecast-explorer.png` draws a named forecast
 * model, sensor nodes, convergence and alignment percentages and an encryption banner, and a screen
 * built from an artifact drifts toward the artifact. None of it exists, so none of it is here.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { ForecastExplorer } from "./explorer";

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
};

const ATTRIBUTION = {
  data_class: "forecast" as const,
  from_cache: false,
  location: BERLIN,
  provider: "open-meteo",
  retrieved_at: "2026-09-10T06:15:00Z",
  units: "metric" as const,
  units_source: "preferences" as const,
};

const FORECAST = {
  attribution: { ...ATTRIBUTION },
  horizon_days: 7,
  period: {
    start_local: "2026-09-10T00:00:00+02:00",
    end_local: "2026-09-17T00:00:00+02:00",
    start_utc: "2026-09-09T22:00:00Z",
    end_utc: "2026-09-16T22:00:00Z",
    timezone: "Europe/Berlin",
  },
  hourly: {
    granularity: "hourly" as const,
    units: { temperature: "°C", relative_humidity: "%" },
    entries: [
      {
        time_local: "2026-09-10T08:00:00+02:00",
        time_utc: "2026-09-10T06:00:00Z",
        values: { temperature: 14.8, relative_humidity: 82 },
      },
      {
        time_local: "2026-09-10T12:00:00+02:00",
        time_utc: "2026-09-10T10:00:00Z",
        values: { temperature: 19.5, relative_humidity: 65 },
      },
    ],
  },
  daily: { granularity: "daily" as const, units: {}, entries: [] },
  uncertainty: {
    basis: "Confidence decreases with horizon distance, from one provider's output.",
    provider: "open-meteo",
    reference_time_utc: "2026-09-10T06:15:00Z",
    spread_available: false,
    horizon: [
      { confidence: "high" as const, hours_ahead: 6, time_local: "x", time_utc: "y" },
    ],
  },
};

const CURRENT = {
  attribution: { ...ATTRIBUTION, data_class: "current" as const },
  observed_at_local: "2026-09-10T08:15:00+02:00",
  observed_at_utc: "2026-09-10T06:15:00Z",
  units: { temperature: "°C", relative_humidity: "%" },
  values: { temperature: 18.4, relative_humidity: 72 },
};

const ANALYSIS = {
  data_class: "computed_statistic" as const,
  findings: [
    {
      measure: "temperature",
      statistic: "mean",
      value: 15.1,
      unit: "°C",
      method: "arithmetic mean of usable points",
      minimum_points: 1,
      points_used: 48,
      provenance: { computed_by: "weathra" },
    },
  ],
  from_cache: false,
  horizon_days: 7,
  location: BERLIN,
  period: FORECAST.period,
  provider: "open-meteo",
  summary: "The mean temperature across the window is 15.1 °C.",
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: BERLIN,
      sources: {},
    }),
    current: vi.fn().mockResolvedValue(CURRENT),
    forecast: vi.fn().mockResolvedValue(FORECAST),
    analysis: vi.fn().mockResolvedValue(ANALYSIS),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <ForecastExplorer />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the explorer", () => {
  it("opens on the person's default location, named for a person", async () => {
    mount(client());
    expect(await screen.findByRole("heading", { name: "Forecast Explorer" })).toBeInTheDocument();
    expect(screen.getByText(/Berlin, Germany/)).toBeInTheDocument();
  });

  it("shows the current measurements the provider reported", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Forecast Explorer" });

    expect(screen.getByText("18.4 °C")).toBeInTheDocument();
    expect(screen.getByText("72 %")).toBeInTheDocument();
  });

  it("asks for a different horizon when one is chosen", async () => {
    const forecast = vi.fn().mockResolvedValue(FORECAST);
    mount(client({ forecast }));
    await screen.findByRole("heading", { name: "Forecast Explorer" });

    await userEvent.selectOptions(screen.getByLabelText("Horizon"), "3");
    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ days: 3 }));
  });

  it("tabulates every hourly entry, at the resolution the provider reported", async () => {
    mount(client());
    const table = await screen.findByRole("table");

    const rows = within(table).getAllByRole("row");
    // A header plus one row per entry — nothing interpolated to fill a grid.
    expect(rows).toHaveLength(FORECAST.hourly.entries.length + 1);
    expect(within(table).getByText("14.8 °C")).toBeInTheDocument();
  });

  it("states the forecast's own confidence, with the basis the backend gave", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Confidence" });

    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText(/Confidence decreases with horizon distance/)).toBeInTheDocument();
  });

  it("shows the deterministic findings and the summary code wrote", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Computed findings" });

    expect(screen.getByText(ANALYSIS.summary)).toBeInTheDocument();
    expect(screen.getByText("15.1 °C")).toBeInTheDocument();
  });

  it("says so when the provider reported no hourly series, rather than drawing one", async () => {
    mount(
      client({
        forecast: vi.fn().mockResolvedValue({
          ...FORECAST,
          hourly: { granularity: "hourly" as const, units: {}, entries: [] },
        }),
      }),
    );
    await screen.findByRole("heading", { name: "Forecast Explorer" });

    // Said in both places it matters — the empty chart and the empty matrix — and drawn in neither.
    expect(screen.getAllByText(/reported no hourly series/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("what the explorer never claims", () => {
  it("carries none of the artifact's invented infrastructure", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Forecast Explorer" });
    const text = container.textContent ?? "";

    for (const invented of [
      "ECMWF",
      "neural agent",
      "Neural Agent",
      "sensor node",
      "SENSOR NODES",
      "Nodes Integrated",
      "convergence",
      "Convergence",
      "Vector Alignment",
      "Grounding Precision",
      "Model Reliability",
      "AES-256",
      "COMPLIANCE",
    ]) {
      expect(text, `the explorer mentions ${invented}`).not.toContain(invented);
    }
  });

  it("names the provider that actually answered", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Forecast Explorer" });
    expect(screen.getByText(/open-meteo/)).toBeInTheDocument();
  });

  it("spends no model call to fill the intelligence column", async () => {
    const ask = vi.fn();
    mount(client({ ask }));
    await screen.findByRole("heading", { name: "Computed findings" });
    expect(ask).not.toHaveBeenCalled();
  });
});
