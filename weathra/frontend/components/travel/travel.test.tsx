/**
 * Travel Intelligence — one trip, one request, and nothing invented.
 *
 * The cases that matter: the screen asks the backend once for a whole trip rather than fanning out
 * to four endpoints in the browser; it asks about a *trip* rather than about a criterion and a
 * rolling window; a section the backend could not produce says so instead of being filled in; and
 * a failed core retrieval ends the screen rather than drawing a hero over empty skeletons.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { TravelIntelligence } from "./travel";

const BARCELONA = {
  display_name: "Barcelona",
  latitude: 41.3874,
  longitude: 2.1686,
  timezone: "Europe/Madrid",
  region: "Catalonia",
  country: "Spain",
  country_code: "ES",
};

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "State of Berlin",
  country: "Germany",
  country_code: "DE",
};

function statistic(measure: string, value: number, unit: string) {
  return {
    measure,
    statistic: "mean",
    value,
    unit,
    method: "m",
    minimum_points: 1,
    points_used: 5,
    provenance: {},
  };
}

const RESULT = {
  trip: { origin: BERLIN, destination: BARCELONA, start: "2026-09-14", end: "2026-09-18", nights: 4 },
  generated_at: "2026-09-12T10:00:00Z",
  hero_state: "Good",
  hero_summary:
    "Across 5 days at Barcelona, 14 Sep–18 Sep scores 71.4 of 100 for outdoor suitability — good.",
  viability: {
    score: 71.4,
    state: "Good",
    contributions: [
      { measure: "temperature_mean", value: 23.4, unit: "°C", direction: "above", weight: 0.5, contribution: 0.38, supporting: statistic("temperature_mean", 23.4, "°C") },
      { measure: "precipitation_sum", value: 9.3, unit: "mm", direction: "below", weight: 0.3, contribution: 0.21, supporting: statistic("precipitation_sum", 9.3, "mm") },
    ],
    basis: "Computed over the trip's own days.",
    disclosure: "The outdoor-suitability score is Weathra's own heuristic, not an authoritative index.",
  },
  metrics: [
    { key: "temperature_variance", label: "Temperature variance", value: 12.6, unit: "°C", detail: "18.1–30.7°C across the trip", method: "highest maximum minus lowest minimum", data_class: "computed_statistic" },
    { key: "transit_stability", label: "Transit weather stability", value: 100, unit: "%", detail: "No disruptive weather reported", method: "share of settled days", data_class: "computed_statistic" },
    { key: "sun_exposure", label: "Strongest sun", value: null, unit: null, method: "highest daily peak UV index", data_class: "forecast", unavailable_reason: "The provider reported no UV index for these days." },
  ],
  daily_outlook: [
    { local_date: "2026-09-14", weekday: "Mon", condition_code: 1, temperature_max: 30.7, temperature_min: 20.7, precipitation_sum: 0, precipitation_probability_max: 5, viability: 77.4, rank: 3, units: { temperature_max: "°C", precipitation_sum: "mm" } },
    { local_date: "2026-09-15", weekday: "Tue", condition_code: 61, temperature_max: 28.7, temperature_min: 21.6, precipitation_sum: 4.2, precipitation_probability_max: 62, viability: 91.5, rank: 1, units: { temperature_max: "°C", precipitation_sum: "mm" } },
  ],
  packing_strategy: [
    { item: "Waterproof outer layer", tier: "Essential", because: "2 of 5 days carry rain, 9.3 mm over the trip" },
    { item: "Sun protection", tier: "Recommended", because: "the peak UV index reaches 6.1" },
  ],
  packing_insight: "Daytime highs reach 30.7 °C but nights fall to 18.1 °C, so one layer covers the difference.",
  temporal_comparison: [
    { start: "2026-09-14", end: "2026-09-18", label: "14–18 Sep", selected: true, viability: 71.4, state: "Good", temperature_mean: 23.4, precipitation_sum: 9.3 },
    { start: "2026-09-19", end: "2026-09-23", label: "19–23 Sep", selected: false, viability: 80.1, state: "Excellent", temperature_mean: 22.1, precipitation_sum: 0.4 },
  ],
  forecast_changes: null,
  historical_baseline: null,
  synthesis: "The weather over 14 Sep–18 Sep at Barcelona rates 71.4 of 100, which Weathra calls good.",
  synthesis_data_class: "computed_statistic",
  evidence: {
    forecast_provider: "open-meteo",
    forecast_retrieved_at: "2026-09-12T09:55:00Z",
    forecast_from_cache: false,
    horizon_days: 16,
    unit_system: "metric",
    destination_resolved_as: "Barcelona",
    origin_resolved_as: "Berlin",
    archive_provider: null,
    archive_years_used: [],
    data_classes: ["forecast", "computed_statistic"],
  },
  partial_failures: [
    { section: "historical_baseline", reason: "The archive holds no observations for this calendar period.", code: "no_data_for_range" },
  ],
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: BARCELONA,
      sources: {},
    }),
    travelIntelligence: vi.fn().mockResolvedValue(RESULT),
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

describe("the trip, not a weather filter", () => {
  it("asks the backend once, for a trip", async () => {
    const travelIntelligence = vi.fn().mockResolvedValue(RESULT);
    mount(client({ travelIntelligence }));
    await screen.findByText(/Weather window identified/i);

    /*
     * One call, carrying a destination and two dates. The screen used to issue four — a ranking, a
     * forecast, a snapshot check and a baseline comparison — each resolving the same place, which
     * is what exhausted the provider's quota.
     */
    expect(travelIntelligence).toHaveBeenCalledTimes(1);
    const [sent] = travelIntelligence.mock.calls[0] as [Record<string, unknown>];
    expect(sent).toHaveProperty("destination");
    expect(sent).toHaveProperty("start");
    expect(sent).toHaveProperty("end");
  });

  it("offers no criterion or rolling-window control", async () => {
    const { container } = mount(client());
    await screen.findByText(/Weather window identified/i);

    // These asked Forecast Explorer's question on a travel screen, and they are Forecast Explorer's
    // to ask. A trip is where from, where to and when.
    expect(screen.queryByLabelText(/What you want/i)).toBeNull();
    expect(screen.queryByLabelText(/Trip window/i)).toBeNull();
    // No select at all in the header: the trip is two places and two dates.
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Next 7 days|Next 3 days|Next 14 days/i);
  });

  it("carries origin, destination and dates in one header", async () => {
    mount(client());
    await screen.findByText(/Weather window identified/i);

    expect(screen.getByText("Origin")).toBeInTheDocument();
    expect(screen.getByText("Destination")).toBeInTheDocument();
    expect(screen.getByText("Dates")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust trip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export itinerary" })).toBeInTheDocument();
  });

  it("keeps one place editor, opened from the header", async () => {
    mount(client());
    await screen.findByText(/Weather window identified/i);

    // Closed until asked for: production carried an always-present "Travel to another place"
    // disclosure *and* a second place form below it.
    expect(screen.queryByRole("region", { name: "Adjust trip" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Adjust trip" }));
    const editor = await screen.findByRole("region", { name: "Adjust trip" });
    expect(within(editor).getByText("Change destination")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Departure")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Return")).toBeInTheDocument();
  });
});

describe("the dashboard", () => {
  it("leads with the weather window beside the viability index", async () => {
    mount(client());
    await screen.findByText(/Weather window identified/i);

    const band = await screen.findByRole("region", { name: "Travel viability index" });
    expect(within(band).getByText("71.4")).toBeInTheDocument();
    expect(within(band).getByText("Good")).toBeInTheDocument();
    // The score is the backend's, and it says whose heuristic the weights are.
    await userEvent.click(within(band).getByText("How this is scored"));
    expect(within(band).getByText(/Weathra's own heuristic/)).toBeInTheDocument();
  });

  it("states why a metric is missing rather than showing a zero", async () => {
    mount(client());
    const row = await screen.findByRole("region", { name: "Trip weather metrics" });

    expect(within(row).getByText("Temperature variance")).toBeInTheDocument();
    expect(within(row).getByText("12.6 °C")).toBeInTheDocument();
    expect(within(row).getByText(/no UV index for these days/)).toBeInTheDocument();
  });

  it("names transit stability for what it measures, never flight operations", async () => {
    mount(client());
    const row = await screen.findByRole("region", { name: "Trip weather metrics" });

    /*
     * The artifact's card reads "Flight Stability 96% — Low Turbulence Risk". Weathra holds no
     * aviation data of any kind, so the card is named for the thing it actually measures: how
     * settled the weather is. The page's closing advisory still *disclaims* flights by name, which
     * is why this is asserted against the metric row rather than the whole document.
     */
    expect(within(row).getByText("Transit weather stability")).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/flight|airline|aviation|airport|turbulence/i);
  });

  it("draws each day of the trip with its condition and range", async () => {
    mount(client());
    const outlook = await screen.findByRole("region", { name: "Destination daily outlook" });

    expect(within(outlook).getByText("Mostly clear")).toBeInTheDocument();
    expect(within(outlook).getByText("Light rain")).toBeInTheDocument();
    expect(within(outlook).getByText("30.7 °C")).toBeInTheDocument();
    expect(within(outlook).getByText(/Low 20.7 °C/)).toBeInTheDocument();
    expect(within(outlook).getByText("Best day")).toBeInTheDocument();
  });

  it("packs from the trip's figures, and names the figure behind each", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "Packing strategy" });

    expect(within(band).getByText("Waterproof outer layer")).toBeInTheDocument();
    expect(within(band).getByText(/2 of 5 days carry rain/)).toBeInTheDocument();
    expect(within(band).getByText(/Planning insight/i)).toBeInTheDocument();
    // The artifact's own recommends branded gear as ESSENTIAL. Weathra sells nothing.
    expect(band.textContent).not.toMatch(/linen|performance protection|recommended gear/i);
    // The guard that matters is unchanged: nothing here may be sold, and nothing may be claimed
    // as a model's work. The wording is now the customer's rather than the engineer's.
    expect(band.textContent).toMatch(/recommends no products/i);
    expect(band.textContent).not.toMatch(/\bAI\b|language model|generated by/i);
  });

  it("compares the trip against other windows, and says when one is stronger", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "Temporal comparison" });

    expect(within(band).getByText("14–18 Sep")).toBeInTheDocument();
    expect(within(band).getByText("19–23 Sep")).toBeInTheDocument();
    expect(within(band).getByText("Your trip")).toBeInTheDocument();
  });

  it("never invents a forecast change when no snapshot exists", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "What changed?" });

    expect(within(band).getByText(/another forecast snapshot/i)).toBeInTheDocument();
    // The artifact's own claims model convergence and vector realignment from nothing.
    expect(band.textContent).not.toMatch(/convergence|vector|realignment|sync delta/i);
  });

  it("badges the synthesis as analytics, never as a model's work", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "Travel intelligence synthesis" });

    expect(within(band).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(band).queryByText("AI INTERPRETATION")).toBeNull();
    // Named as what it is — deterministic — without the implementation note a customer never
    // needed. Labelling this as a model's work is the one mislabelling the product must not make.
    expect(band.textContent).toMatch(/Deterministic analysis/i);
    expect(band.textContent).not.toMatch(/\bAI\b|language model|generated by/i);
  });

  it("grounds the result in what a reader would need to check it", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "Grounding evidence" });

    expect(within(band).getByText("open-meteo")).toBeInTheDocument();
    expect(within(band).getByText("Barcelona")).toBeInTheDocument();
    // No hashes, no node counts, no fabricated confidence.
    expect(band.textContent).not.toMatch(/hash|node|alignment|convergence/i);
  });

  it("keeps the historical band and states why it is empty", async () => {
    mount(client());
    const band = await screen.findByRole("region", { name: "Historical baseline" });

    expect(within(band).getByText(/archive holds no observations/i)).toBeInTheDocument();
    expect(within(band).getByText(/forecast figures above are unaffected/i)).toBeInTheDocument();
    // Never a climate normal Weathra does not have.
    expect(band.textContent).not.toMatch(/\bWMO\b|climate normal/i);
  });

  it("renders the whole dashboard even though a section failed", async () => {
    mount(client());
    await screen.findByText(/Weather window identified/i);

    // One failed secondary source must not destroy the experience.
    for (const region of [
      "Travel viability index",
      "Destination daily outlook",
      "Packing strategy",
      "Temporal comparison",
      "Travel intelligence synthesis",
      "Grounding evidence",
    ]) {
      expect(screen.getByRole("region", { name: region })).toBeInTheDocument();
    }
  });
});

describe("when the core retrieval fails", () => {
  function limited() {
    return client({
      travelIntelligence: vi.fn().mockRejectedValue(
        new ApiError(429, {
          code: "provider_rate_limited",
          message: "open-meteo rate-limited the request.",
          request_id: "req_5450abc",
          details: null,
        }),
      ),
    });
  }

  it("shows one compact surface and no empty dashboard", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Travel viability index" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Destination daily outlook" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Historical baseline" })).toBeNull();
  });

  it("keeps the trip so a retry costs no re-entry", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    expect(screen.getByText("Destination")).toBeInTheDocument();
    expect(screen.getAllByText(/Barcelona/).length).toBeGreaterThan(0);
    expect(screen.getByText("Dates")).toBeInTheDocument();
  });

  it("keeps the request id out of the customer's way", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    const card = screen.getByRole("region", {
      name: "Travel weather data is temporarily unavailable",
    });
    const disclosure = card.querySelector("details");
    expect(disclosure?.textContent).toContain("req_5450abc");
    expect(disclosure?.open).toBe(false);
    expect(screen.getByRole("alert").textContent).not.toMatch(/req_|rate-limited the request/i);
  });
});
