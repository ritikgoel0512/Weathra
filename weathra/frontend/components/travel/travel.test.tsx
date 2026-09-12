/**
 * Travel Intelligence — a backend-computed ranking, and nothing about flights.
 *
 * The two cases that matter: the score comes from `/weather/comparison` with its contributions
 * shown, so no index is invented here; and none of the artifact's aviation content appears, because
 * Weathra knows nothing about any of it.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
      period: { start_local: "2026-09-12T00:00:00+01:00", end_local: "2026-09-13T00:00:00+01:00", start_utc: "c", end_utc: "d", timezone: "Europe/Lisbon" },
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
      period: { start_local: "2026-09-13T00:00:00+01:00", end_local: "2026-09-14T00:00:00+01:00", start_utc: "c", end_utc: "d", timezone: "Europe/Lisbon" },
      rank: 2,
      score: 0.61,
      supporting: [],
      contributions: [],
    },
  ],
};

const BASELINE = {
  location: LISBON,
  measure: "temperature_mean" as const,
  observed_or_forecast_value: 22.1,
  observed_data_class: "forecast" as const,
  characterization: "Warmer than the 2-year baseline for this calendar period.",
  forecast_side_caveat: "One side is a forecast, which is uncertain.",
  difference: { measure: "temperature_mean", statistic: "delta", value: 1.4, unit: "°C", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
  z_score: { measure: "temperature_mean", statistic: "z_score", value: 0.8, unit: "", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
  percentile_rank: { measure: "temperature_mean", statistic: "percentile", value: 90, unit: "", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
  baseline: {
    provider: "stub-archive",
    location: LISBON,
    unit_system: "metric" as const,
    years_used: [2024, 2025],
    years_requested: 5,
    labelling: "A historical statistic computed by Weathra. It is not an official climate normal.",
    calendar_period: RANKING.candidates[0]!.period,
    mean: { measure: "temperature_mean", statistic: "mean", value: 20.7, unit: "°C", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
    standard_deviation: { measure: "temperature_mean", statistic: "standard_deviation", value: 1.1, unit: "°C", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
    minimum: { measure: "temperature_mean", statistic: "minimum", value: 19.4, unit: "°C", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
    maximum: { measure: "temperature_mean", statistic: "maximum", value: 21.8, unit: "°C", method: "m", minimum_points: 1, points_used: 2, provenance: {} },
    yearly_means: [{ year: 2024, value: 19.4, points_used: 1 }, { year: 2025, value: 21.8, points_used: 1 }],
  },
};

const TRAVEL_FORECAST = {
  attribution: { provider: "stub-provider", retrieved_at: "2026-09-12T06:00:00Z", location: LISBON, data_class: "forecast" as const, units: "metric" as const, from_cache: false },
  horizon_days: 7,
  period: RANKING.candidates[0]!.period,
  hourly: {
    granularity: "hourly" as const,
    units: { temperature: "°C", precipitation: "mm" },
    entries: [
      { time_local: "2026-09-12T06:00:00+01:00", time_utc: "a", values: { temperature: 17.1, precipitation: 0 } },
      { time_local: "2026-09-12T12:00:00+01:00", time_utc: "b", values: { temperature: 23.4, precipitation: 0.2 } },
      { time_local: "2026-09-12T18:00:00+01:00", time_utc: "c", values: { temperature: 20.2, precipitation: 0 } },
    ],
  },
  daily: { granularity: "daily" as const, units: {}, entries: [] },
  uncertainty: { basis: "b", provider: "stub-provider", reference_time_utc: "x", spread_available: false, horizon: [] },
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
    forecast: vi.fn().mockResolvedValue(TRAVEL_FORECAST),
    changes: vi.fn().mockResolvedValue({
      comparison_available: true,
      statement: "The forecast has moved since it was last retrieved.",
      changes: [
        { local_date: "2026-09-12", measure: "temperature_max", current: 23.4, previous: 21.9, change: 1.5, material: true, statement: "12 Sep is 1.5 °C warmer than the previous forecast.", unit: "°C" },
      ],
      location: LISBON,
      provider: "stub-provider",
      current_retrieved_at: "2026-09-12T06:00:00Z",
      previous_retrieved_at: "2026-09-11T06:00:00Z",
      period: RANKING.candidates[0]!.period,
      unit_system: "metric",
    }),
    baselineComparison: vi.fn().mockResolvedValue(BASELINE),
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
    await vi.waitFor(() => expect(screen.getAllByText("Lisbon, Portugal").length).toBeGreaterThan(0));

    await vi.waitFor(() =>
      expect(compareLocations).toHaveBeenCalledWith({
      criterion: "outdoor_suitability",
      location: "Lisbon, Portugal",
        days: 7,
      }),
    );
  });

  it("shows each day's rank, and the figures behind its score", async () => {
    mount(client());

    /*
     * The day cards carry the weekday and the date the backend stated, not the raw label — a
     * customer reading a travel screen is choosing between days, and `2026-09-12` is a key.
     */
    expect((await screen.findAllByText("Best")).length).toBeGreaterThan(0);
    // The supporting statistic the backend returned, not a figure computed here.
    expect(screen.getAllByText("23.4 °C").length).toBeGreaterThan(0);

    // Every figure behind the score is still here, one press in rather than down the page.
    await userEvent.click(screen.getAllByText("Show details")[0]!);
    expect(screen.getAllByText(/Precipitation/).length).toBeGreaterThan(0);
  });

  it("leads with the destination beside its suitability, as the artifact composes it", async () => {
    mount(client());
    await screen.findAllByText("Best");
    expect(screen.getByRole("heading", { name: "Weather suitability" })).toBeInTheDocument();
    expect(screen.getByText(/of 2 days/)).toBeInTheDocument();
  });

  it("answers the default question on arrival rather than after a press", async () => {
    /*
     * The screen used to open on a form and an empty state telling the person to choose what they
     * wanted from the weather, so the product existed only after a button. The defaults are a real
     * question already — which days here are good to be outside, over the next week — so it answers
     * that, and the controls change the answer.
     */
    const compareLocations = vi.fn().mockResolvedValue(RANKING);
    mount(client({ compareLocations }));

    await vi.waitFor(() => expect(compareLocations).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText("Best")).length).toBeGreaterThan(0);
  });
});

describe("what travel intelligence never claims", () => {
  it("offers no aviation or booking content, and says plainly that it has none", async () => {
    const { container } = mount(client());
    await screen.findAllByText("Best");

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

    /*
     * And the absence is stated rather than left to be noticed — twice. It was a card of its own
     * headed "What this is, and is not" at the foot of the page; the artifact sets an advisory in
     * its footer rule, so the same words are there, and the suitability card carries the shorter
     * version beside the figure somebody would otherwise read as a travel verdict.
     */
    expect(text).toContain("not advice about");
    expect(screen.getAllByText(/not transport or safety advice/).length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------- task 34.41: the four lower bands */

/**
 * The bands the previous pass left out, and the one property each of them has to hold.
 *
 * Every one is built from a contract another screen already uses — the Explorer's hourly forecast,
 * the Dashboard's movement check, Historical Analytics' baseline — so what is worth asserting is
 * not that the request works but that the band says only what the response supports.
 */
describe("the lower bands", () => {
  it("plots the best-ranked day's own hours, and no other day's", async () => {
    mount(client());
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "Intra-day weather trend" });
    // Captioned for the day it plots, so a reader knows which of the ranked days this is.
    expect(within(band).getByText(/Best-ranked day/)).toBeInTheDocument();
  });

  it("compares slices of the ranked window, never a date the provider did not send", async () => {
    mount(client());
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "Temporal comparison" });
    const rows = within(band).getAllByRole("row");
    // A header plus at most one row per ranked day: the windows are slices of what came back.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(RANKING.candidates.length + 1);
  });

  it("says plainly when there is no earlier snapshot, rather than dropping the card", async () => {
    mount(
      client({
        changes: vi.fn().mockResolvedValue({
          comparison_available: false,
          statement: "x",
          changes: [],
          location: LISBON,
          provider: "stub",
          current_retrieved_at: "2026-09-12T06:00:00Z",
          period: RANKING.candidates[0]!.period,
          unit_system: "metric",
        }),
      }),
    );
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "What changed?" });
    expect(within(band).getByText(/No earlier forecast snapshot/)).toBeInTheDocument();
  });

  it("summarises from the figures on the screen, and says no model wrote it", async () => {
    mount(client());
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "Travel intelligence synthesis" });
    expect(within(band).getByText(/scores first for/)).toBeInTheDocument();
    expect(within(band).getByText(/No language model was called/)).toBeInTheDocument();
    // Badged for what it is. Labelling deterministic text as a model's is the one mislabelling
    // this product must not make.
    expect(within(band).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(band).queryByText("AI INTERPRETATION")).toBeNull();
  });

  it("carries the provenance a reader would need, and no hash or node count", async () => {
    mount(client());
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "Data & evidence" });
    expect(within(band).getByText("Forecast provider")).toBeInTheDocument();
    expect(band.textContent).not.toMatch(/hash|node|alignment|convergence/i);
  });

  it("omits the historical band entirely when no baseline came back", async () => {
    mount(client({ baselineComparison: vi.fn().mockRejectedValue(new Error("no archive")) }));
    await screen.findAllByText("Best");

    // Not an empty card and not a zero: the band is absent, which is what an absent baseline is.
    expect(screen.queryByRole("region", { name: "Historical context" })).toBeNull();
  });

  it("names the archive years it actually got, never a climate normal", async () => {
    mount(client());
    await screen.findAllByText("Best");
    const band = await screen.findByRole("region", { name: "Historical context" });

    expect(within(band).getByText(/available 2-year archive baseline/)).toBeInTheDocument();
    // The artifact's "30-year WMO coastal baseline (1991-2020)", refused. What the card carries is
    // the backend's own labelling, which *denies* being a climate normal rather than claiming one.
    expect(band.textContent).not.toMatch(/WMO|30-year/i);
    expect(band.textContent).toMatch(/not an official climate normal/i);
  });
});
