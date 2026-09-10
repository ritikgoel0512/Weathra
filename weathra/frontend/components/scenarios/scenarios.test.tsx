/**
 * Weather Scenario Lab — the browser supposes, the backend calculates.
 *
 * The cases that matter: nothing is computed here, the request carries only assumptions the backend
 * accepts, the result is labelled simulated wherever it appears, and none of the artifact's
 * invented apparatus is present.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { WeatherScenarioLab } from "./scenarios";

const OSLO = {
  display_name: "Oslo",
  latitude: 59.91,
  longitude: 10.75,
  timezone: "Europe/Oslo",
  region: "Oslo",
  country: "Norway",
  country_code: "NO",
};

const SERIES = {
  granularity: "hourly" as const,
  units: { temperature: "°C" },
  entries: [
    { time_local: "2026-09-10T08:00:00+02:00", time_utc: "2026-09-10T06:00:00Z", values: { temperature: 12.0 } },
    { time_local: "2026-09-10T09:00:00+02:00", time_utc: "2026-09-10T07:00:00Z", values: { temperature: 13.0 } },
  ],
};

const RESULT = {
  simulated: true as const,
  disclaimer: "A hypothetical: your stated assumptions applied to a real forecast.",
  attribution: { provider: "open-meteo", location: OSLO },
  period: { start_local: "a", end_local: "b", start_utc: "c", end_utc: "d", timezone: "Europe/Oslo" },
  horizon_days: 2,
  assumptions: { temperature_delta: 2.5 },
  baseline: SERIES,
  scenario: {
    ...SERIES,
    entries: SERIES.entries.map((entry) => ({
      ...entry,
      values: { temperature: (entry.values.temperature ?? 0) + 2.5 },
    })),
  },
  measures: [
    {
      measure: "temperature",
      unit: "°C",
      assumption: 2.5,
      method: "+2.50 added to each reported value",
      baseline_mean: 12.5,
      scenario_mean: 15.0,
      difference: 2.5,
      points_used: 2,
      points_excluded: 0,
      clipped: 0,
    },
  ],
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: OSLO,
      sources: {},
    }),
    scenario: vi.fn().mockResolvedValue(RESULT),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <WeatherScenarioLab />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("running a scenario", () => {
  it("sends only assumptions the backend accepts, and calculates nothing itself", async () => {
    const scenario = vi.fn().mockResolvedValue(RESULT);
    mount(client({ scenario }));
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });

    await userEvent.click(screen.getByRole("button", { name: "Run this scenario" }));

    expect(scenario).toHaveBeenCalledTimes(1);
    const [request] = scenario.mock.calls[0] as [Record<string, unknown>];
    expect(request.latitude).toBe(OSLO.latitude);
    // Only the non-zero assumptions, and only the four fields the endpoint declares.
    expect(Object.keys(request.assumptions as object).sort()).toEqual([
      "precipitation_percent",
      "temperature_delta",
    ]);
  });

  it("shows the backend's own arithmetic rather than a figure computed here", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });
    await userEvent.click(screen.getByRole("button", { name: "Run this scenario" }));

    expect(await screen.findByText("+2.50 °C")).toBeInTheDocument();
    expect(screen.getByText("+2.50 added to each reported value")).toBeInTheDocument();
  });

  it("says it is simulated before it says anything else", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });

    // On the header before a scenario is even run.
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
  });

  it("carries the backend's disclaimer, and says it did not model the atmosphere", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });
    await userEvent.click(screen.getByRole("button", { name: "Run this scenario" }));

    expect(await screen.findByText(RESULT.disclaimer)).toBeInTheDocument();
    expect(screen.getByText(/did not model the\s+atmosphere/)).toBeInTheDocument();
  });

  it("runs nothing until asked", async () => {
    const scenario = vi.fn();
    mount(client({ scenario }));
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });

    expect(scenario).not.toHaveBeenCalled();
  });
});

describe("what the lab never claims", () => {
  it("carries none of the artifact's invented apparatus", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });
    await userEvent.click(screen.getByRole("button", { name: "Run this scenario" }));
    await screen.findByText("+2.50 °C");

    const text = container.textContent ?? "";
    for (const invented of [
      "DELTA-INFERENCE",
      "Simulation Engine",
      "simulation engine",
      "Stability Index",
      "Inference Confidence",
      "Correlation Model",
      "Analysis Kernel",
      "Thermal Inertia",
      "Evaporation Rate",
      "Export Simulation",
      "nodes",
      "Session",
    ]) {
      expect(text, `the lab mentions ${invented}`).not.toContain(invented);
    }
  });
});
