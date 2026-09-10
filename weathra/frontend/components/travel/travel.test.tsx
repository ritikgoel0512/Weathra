/**
 * Travel Intelligence — a backend-computed ranking, and nothing about flights.
 *
 * The two cases that matter: the score comes from `/weather/comparison` with its contributions
 * shown, so no index is invented here; and none of the artifact's aviation content appears, because
 * Weathra knows nothing about any of it.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { TravelIntelligence } from "./travel";

const LISBON = {
  display_name: "Lisbon",
  latitude: 38.72,
  longitude: -9.14,
  timezone: "Europe/Lisbon",
  region: "Lisbon",
  country: "Portugal",
  country_code: "PT",
};

const RANKING = {
  criterion: "outdoor_suitability" as const,
  mode: "days" as const,
  data_class: "forecast" as const,
  provider: "open-meteo",
  period: {
    start_local: "a",
    end_local: "b",
    start_utc: "c",
    end_utc: "d",
    timezone: "Europe/Lisbon",
  },
  candidates: [
    {
      label: "2026-09-12",
      location: LISBON,
      period: { start_local: "a", end_local: "b", start_utc: "c", end_utc: "d", timezone: "Europe/Lisbon" },
      rank: 1,
      score: 0.92,
      supporting: [
        { measure: "temperature", statistic: "mean", value: 23.4, unit: "°C", method: "m", minimum_points: 1, points_used: 24, provenance: {} },
      ],
      contributions: [{ measure: "precipitation", contribution: 0.4 }],
    },
    {
      label: "2026-09-13",
      location: LISBON,
      period: { start_local: "a", end_local: "b", start_utc: "c", end_utc: "d", timezone: "Europe/Lisbon" },
      rank: 2,
      score: 0.61,
      supporting: [],
      contributions: [],
    },
  ],
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: LISBON,
      sources: {},
    }),
    compareLocations: vi.fn().mockResolvedValue(RANKING),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <TravelIntelligence />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("ranking a weather window", () => {
  it("asks the backend to rank the days, against the criterion chosen", async () => {
    const compareLocations = vi.fn().mockResolvedValue(RANKING);
    mount(client({ compareLocations }));
    await screen.findByRole("heading", { name: "Travel Intelligence" });

    await userEvent.click(screen.getByRole("button", { name: "Rank these days" }));

    expect(compareLocations).toHaveBeenCalledWith({
      criterion: "outdoor_suitability",
      location: "Lisbon, Portugal",
      days: 7,
    });
  });

  it("shows each day's rank, and the figures behind its score", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Travel Intelligence" });
    await userEvent.click(screen.getByRole("button", { name: "Rank these days" }));

    expect(await screen.findByText("2026-09-12")).toBeInTheDocument();
    expect(screen.getByText("Best in this window")).toBeInTheDocument();
    // The supporting statistic the backend returned, not a figure computed here.
    expect(screen.getByText("23.4 °C")).toBeInTheDocument();
    expect(screen.getByText("What made this score")).toBeInTheDocument();
  });

  it("ranks nothing until asked", async () => {
    const compareLocations = vi.fn();
    mount(client({ compareLocations }));
    await screen.findByRole("heading", { name: "Travel Intelligence" });

    expect(compareLocations).not.toHaveBeenCalled();
  });
});

describe("what travel intelligence never claims", () => {
  it("offers no aviation or booking content, and says plainly that it has none", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Travel Intelligence" });
    await userEvent.click(screen.getByRole("button", { name: "Rank these days" }));
    await screen.findByText("2026-09-12");

    const text = container.textContent ?? "";
    // The artifact's aviation apparatus, none of which Weathra knows anything about.
    for (const invented of [
      "Flight Stability",
      "Airline Operations",
      "Departure",
      "Book now",
      "sensor",
      "Sensor",
      "convergence",
    ]) {
      expect(text, `travel claims ${invented}`).not.toContain(invented);
    }

    // And the absence is stated rather than left to be noticed.
    expect(text).toContain("not advice about");
    expect(screen.getByRole("heading", { name: "What this is, and is not" })).toBeInTheDocument();
  });
});
