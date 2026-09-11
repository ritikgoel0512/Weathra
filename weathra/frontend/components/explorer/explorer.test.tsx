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
    basis:
      "Confidence decreases with horizon distance, from one provider's output.",
    provider: "open-meteo",
    reference_time_utc: "2026-09-10T06:15:00Z",
    spread_available: false,
    horizon: [
      {
        confidence: "high" as const,
        hours_ahead: 6,
        time_local: "x",
        time_utc: "y",
      },
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
    expect(
      await screen.findByRole("heading", { name: "Forecast Explorer" }),
    ).toBeInTheDocument();
    // Named twice now — in the lede and over the location band the screen leads with — so what is
    // asserted is that the place is named for a person at all, not that it appears exactly once.
    expect(screen.getAllByText(/Berlin, Germany/).length).toBeGreaterThan(0);
  });

  it("shows the current measurements the provider reported", async () => {
    mount(client());
    /*
     * Awaited on the figure rather than on the heading. The heading now outlives the state — the
     * screen keeps its shell through loading and through a provider failure, so a person can still
     * change place when the forecast will not come — which means it appears before there is
     * anything to read. Finding 1.1's lesson on the Dashboard, arriving here.
     */
    expect(await screen.findByText("18.4 °C")).toBeInTheDocument();
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
    expect(
      screen.getByText(/Confidence decreases with horizon distance/),
    ).toBeInTheDocument();
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
    // The reason, not the heading: the heading is there while the request is still in flight.
    // `findAllByText` because it is said twice on purpose, which the assertion below is about.
    await screen.findAllByText(/reported no hourly series/);

    // Said in both places it matters — the empty chart and the empty matrix — and drawn in neither.
    expect(
      screen.getAllByText(/reported no hourly series/).length,
    ).toBeGreaterThan(0);
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
    expect(await screen.findByText(/open-meteo/)).toBeInTheDocument();
  });

  it("spends no model call to fill the intelligence column", async () => {
    const ask = vi.fn();
    mount(client({ ask }));
    await screen.findByRole("heading", { name: "Computed findings" });
    expect(ask).not.toHaveBeenCalled();
  });
});

/*
 * The screen a customer meets when they press *Forecast Explorer* before setting a default.
 *
 * This used to be the chooser folded into a disclosure headed "Explore another place" — another
 * than none — above a one-sentence empty state and an otherwise black screen. Both halves are
 * asserted here: that the way in is the screen's subject, and that what waits under it is the
 * screen's own regions rather than nothing. The third test is the one that keeps the fix honest.
 */
describe("before a place has been chosen", () => {
  const noDefault = () =>
    client({
      preferences: vi.fn().mockResolvedValue({
        unit_system: "metric",
        forecast_horizon_days: 7,
        default_location: null,
        sources: {},
      }),
    });

  it("puts the place entry on the screen rather than behind a disclosure", async () => {
    mount(noDefault());

    // By role: the form around it carries the same accessible name, so a label query matches both.
    const field = await screen.findByRole("textbox", { name: "Explore a place" });
    expect(field).toBeVisible();
    expect(screen.getByRole("button", { name: "Show this place" })).toBeVisible();
    // "Explore another place" is the folded wording, and it is wrong for somebody with none.
    expect(screen.queryByText("Explore another place")).toBeNull();
  });

  it("previews the screen's own regions instead of leaving the viewport empty", async () => {
    mount(noDefault());
    await screen.findByRole("textbox", { name: "Explore a place" });

    expect(
      screen.getByRole("heading", { name: "Forecast Explorer opens on one place" }),
    ).toBeInTheDocument();
    for (const region of ["Day by day", "Hour by hour", "Spread and confidence", "Provenance"]) {
      expect(screen.getByRole("heading", { name: region })).toBeInTheDocument();
    }
  });

  it("retrieves nothing, and invents no figure to fill the preview", async () => {
    const forecast = vi.fn();
    const current = vi.fn();
    mount(
      client({
        preferences: vi.fn().mockResolvedValue({
          unit_system: "metric",
          forecast_horizon_days: 7,
          default_location: null,
          sources: {},
        }),
        forecast,
        current,
      }),
    );
    await screen.findByRole("textbox", { name: "Explore a place" });

    // Nothing was asked for about a place Weathra does not have.
    expect(forecast).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    // And nothing that looks like a reading was drawn to fill the space.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/-?\d+(\.\d+)?\s*°/);
  });
});
