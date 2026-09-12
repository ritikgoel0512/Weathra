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

import { ApiError, type ApiClient } from "@/lib/api/client";
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
  /*
   * The provider's own daily entries, which the outlook cards, the metric row and the guidance all
   * read. This was an empty series, so every region that draws the *sky* over a day — the glyph,
   * the high and low, the chance of rain — was untested here while the capture drew them from a
   * fixture that had them. Same measures the real provider sends.
   */
  daily: {
    granularity: "daily" as const,
    units: { temperature_max: "°C", temperature_min: "°C", precipitation_sum: "mm", precipitation_probability_max: "%", uv_index_max: "index", weather_code_dominant: "WMO code" },
    entries: [
      { time_local: "2026-09-12T00:00:00+01:00", time_utc: "a", values: { temperature_max: 26.1, temperature_min: 17.3, precipitation_sum: 0, precipitation_probability_max: 8, uv_index_max: 7.2, weather_code_dominant: 0 } },
      { time_local: "2026-09-13T00:00:00+01:00", time_utc: "b", values: { temperature_max: 21.4, temperature_min: 15.9, precipitation_sum: 3.1, precipitation_probability_max: 74, uv_index_max: 2.6, weather_code_dominant: 63 } },
    ],
  },
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

describe("empty and populated", () => {
  it("offers a compact setup, not a dead end, when no place is chosen", async () => {
    mount(
      client({
        preferences: vi.fn().mockResolvedValue({
          unit_system: "metric",
          forecast_horizon_days: 7,
          default_location: null,
          sources: {},
        }),
      }),
    );

    // The empty state names what the screen would show and gives the control that fills it, rather
    // than sending the reader to Settings to configure a preference somewhere else first.
    expect(await screen.findByText(/Travel Intelligence ranks the days at one destination/)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Travel to a place" })).toBeInTheDocument();
    // Nothing is ranked, so nothing is claimed.
    expect(screen.queryByRole("region", { name: "Destination daily outlook" })).toBeNull();
  });

  it("re-ranks and stays populated when the window changes", async () => {
    const compareLocations = vi.fn().mockResolvedValue(RANKING);
    mount(client({ compareLocations }));
    await screen.findAllByText("Best");

    await userEvent.selectOptions(screen.getByLabelText("Trip window"), "3");

    /*
     * The populated experience must survive its own controls. A screen that fell back to the setup
     * view whenever a select changed would be the empty state the reader already left.
     */
    await vi.waitFor(() =>
      expect(compareLocations).toHaveBeenLastCalledWith({
        criterion: "outdoor_suitability",
        location: "Lisbon, Portugal",
        days: 3,
      }),
    );
    expect((await screen.findAllByText("Best")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Destination daily outlook" })).toBeInTheDocument();
  });
});

describe("when the provider rate-limits the ranking", () => {
  function limited() {
    return client({
      compareLocations: vi.fn().mockRejectedValue(
        new ApiError(429, {
          code: "provider_rate_limited",
          message: "open-meteo rate-limited the request.",
          request_id: "req_5450abc",
          details: null,
        }),
      ),
    });
  }

  it("says so plainly, and offers the retry", async () => {
    mount(limited());
    expect(
      await screen.findByText(/Travel weather data is temporarily unavailable/i, undefined, {
        timeout: 5_000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("draws no hero and no empty suitability card", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    /*
     * Production drew the destination photograph over a Weather suitability card with an empty ring
     * and skeletons below it — a screen implying an analysis was on its way that was never coming.
     * Nothing downstream of the ranking has anything to render, so nothing downstream is rendered.
     */
    expect(screen.queryByRole("region", { name: "Weather suitability" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Destination daily outlook" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Intra-day weather trend" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Historical context" })).toBeNull();
    expect(screen.queryByText("Ranking the days in your window")).toBeNull();
  });

  it("keeps the trip settings, so a retry costs no re-entry", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    expect(screen.getAllByText("Lisbon, Portugal").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("What you want from the weather")).toHaveValue("outdoor_suitability");
    expect(screen.getByLabelText("Trip window")).toHaveValue("7");
  });

  it("keeps the request id out of the customer's way", async () => {
    mount(limited());
    await screen.findByText(/temporarily unavailable/i, undefined, { timeout: 5_000 });

    const card = screen.getByRole("region", {
      name: "Travel weather data is temporarily unavailable",
    });
    // Present for anyone reporting the failure, but behind a disclosure rather than in the message.
    const disclosure = card.querySelector("details");
    expect(disclosure?.textContent).toContain("req_5450abc");
    expect(disclosure?.open).toBe(false);
    // The statement a customer reads names no identifier and no provider internals.
    expect(screen.getByRole("alert").textContent).not.toMatch(/req_|rate-limited the request/i);
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

  it("speaks the days, and never prints the identifier the backend ranks them by", async () => {
    mount(client());
    await screen.findAllByText("Best");

    /*
     * `compare_days` labels a candidate with its ISO date, because a label in a ranking is an
     * identifier. The screen rendered it verbatim into "Score for 2026-09-12", which is a timestamp
     * in front of a customer — and it was invisible to the capture, whose fixture answered with
     * place names instead of dates.
     */
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(document.body.innerHTML).not.toMatch(/Score for \d{4}-\d{2}-\d{2}/);
  });

  it("draws the sky over each day, not only the statistic the score came from", async () => {
    mount(client());
    await screen.findAllByText("Best");
    const outlook = await screen.findByRole("region", { name: "Destination daily outlook" });

    // The provider's own dominant code, translated — and its reported high and low. None of this is
    // in the ranking's `supporting` list, which holds only what the score was computed from. Awaited
    // rather than read: the forecast is a second call, issued once the ranking has settled.
    expect(await within(outlook).findByText("Clear")).toBeInTheDocument();
    expect(await within(outlook).findByText("Rain")).toBeInTheDocument();
    expect(await within(outlook).findByText("26.1 °C")).toBeInTheDocument();
    expect(await within(outlook).findByText(/Low 17.3 °C/)).toBeInTheDocument();
  });

  it("fills the fourth metric card from the day's own forecast entry", async () => {
    mount(client());
    await screen.findAllByText("Best");
    const row = await screen.findByRole("region", { name: "Figures for the best-ranked day" });

    // A day-level ranking supports its score with temperature, precipitation and wind and nothing
    // else, so a row reading only `supporting` drew three cards and a gap.
    expect(await within(row).findByText("Chance of rain")).toBeInTheDocument();
    expect(await within(row).findByText("8%")).toBeInTheDocument();
  });

  it("raises sun protection from the day's own UV index, and nothing from a catalogue", async () => {
    mount(client());
    await screen.findAllByText("Best");
    const band = await screen.findByRole("region", { name: "Weather-aware trip guidance" });

    expect(await within(band).findByText("Sun protection")).toBeInTheDocument();
    expect(await within(band).findByText(/peak UV index of 7.2/)).toBeInTheDocument();
    // The artifact's own recommends "Light Breathable Linen" as ESSENTIAL. Weathra sells nothing.
    expect(band.textContent).not.toMatch(/linen|essential|recommended gear/i);
  });

  it("reports a snapshot that does exist, from the backend's own statement", async () => {
    mount(client());
    await screen.findAllByText("Best");
    const band = await screen.findByRole("region", { name: "What changed?" });

    expect(await within(band).findByText(/The forecast has moved since it was last retrieved/)).toBeInTheDocument();
    expect(await within(band).findByText(/12 Sep is 1.5 °C warmer than the previous forecast/)).toBeInTheDocument();
    // Nothing is compared in the browser, and nothing about model convergence is claimed.
    expect(band.textContent).not.toMatch(/convergence|vector|realignment/i);
  });

  it("carries the provenance a reader would need, and no hash or node count", async () => {
    mount(client());
    await screen.findAllByText("Best");

    const band = await screen.findByRole("region", { name: "Data & evidence" });
    expect(within(band).getByText("Forecast provider")).toBeInTheDocument();
    expect(band.textContent).not.toMatch(/hash|node|alignment|convergence/i);
  });

  it("keeps the historical band, and says so, when no baseline came back", async () => {
    mount(client({ baselineComparison: vi.fn().mockRejectedValue(new Error("no archive")) }));
    await screen.findAllByText("Best");

    /*
     * The band used to be removed when the archive did not answer, which is the composition
     * changing shape because of an absence — the screen's closing region simply disappeared. An
     * archive that cannot reach a calendar period is a real state, and it is stated rather than
     * hidden. Not a zero and not an invented baseline: a sentence saying what is missing.
     */
    const band = await screen.findByRole("region", { name: "Historical context" });
    expect(await within(band).findByText(/could not retrieve archive observations/i)).toBeInTheDocument();
    expect(band.textContent).not.toMatch(/\bWMO\b|climate normal/i);
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
