/**
 * The Dashboard — task 21.1's verification.
 *
 * The five the task names — a populated briefing, a location with no prior snapshot, a person with
 * no saved default, and the loading and error states — then the ones that are honesty properties
 * rather than behaviour: that the person's own units and location decide what is requested, that
 * every surface carries its data class and its attribution, that the model's language is a separate
 * region from the figures, and that **no number appears on this screen that did not come out of a
 * response** — asserted by sweeping the rendered output for the sample values in the design
 * artifact.
 *
 * The API is driven through the real client and the real query layer inside the real session
 * boundary; only `fetch` and Supabase are replaced.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PreferenceView } from "@/lib/api/schema";
import type { WhatChangedReport } from "@/lib/dashboard/briefing";
import { SessionBoundary } from "@/lib/session/provider";

import { Dashboard } from "./dashboard";
import { WhatChanged } from "./sections";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("the Dashboard must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------- fixtures */

/*
 * `display_name` is the city alone, which is what the geocoder actually returns — the region and
 * the country arrive as their own fields. This fixture used to carry `"Berlin, Germany"` in the
 * name, which is a shape the backend never sends, and it hid what the screen does with the real
 * one: `placeLabel` composes `Berlin, Germany` for reading from the three fields.
 */
const LOCATION = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  country: "Germany",
};

const PERIOD = {
  start_local: "2026-09-04T00:00:00+02:00",
  end_local: "2026-09-11T00:00:00+02:00",
  start_utc: "2026-09-03T22:00:00Z",
  end_utc: "2026-09-10T22:00:00Z",
  timezone: "Europe/Berlin",
};

const ATTRIBUTION = {
  data_class: "current" as const,
  from_cache: false,
  location: LOCATION,
  provider: "open-meteo",
  retrieved_at: "2026-09-04T06:15:00Z",
  units: "metric" as const,
  units_source: "preferences",
};

function preferences(overrides: Partial<PreferenceView> = {}): PreferenceView {
  return {
    unit_system: "metric",
    forecast_horizon_days: 7,
    sources: { unit_system: "chosen", default_location: "chosen" },
    default_location: LOCATION,
    ...overrides,
  } as PreferenceView;
}

const CURRENT = {
  attribution: ATTRIBUTION,
  observed_at_local: "2026-09-04T08:15:00+02:00",
  observed_at_utc: "2026-09-04T06:15:00Z",
  units: { temperature: "°C", relative_humidity: "%", precipitation: "mm" },
  values: { temperature: 18.2, relative_humidity: 72, precipitation: null },
};

const FORECAST = {
  attribution: { ...ATTRIBUTION, data_class: "forecast" as const },
  horizon_days: 7,
  period: PERIOD,
  hourly: { granularity: "hourly" as const, units: {}, entries: [] },
  daily: {
    granularity: "daily" as const,
    units: { temperature_max: "°C", temperature_min: "°C" },
    entries: [
      {
        time_local: "2026-09-04T00:00:00+02:00",
        time_utc: "2026-09-03T22:00:00Z",
        values: { temperature_max: 21.4, temperature_min: 12.1 },
      },
      {
        time_local: "2026-09-05T00:00:00+02:00",
        time_utc: "2026-09-04T22:00:00Z",
        values: { temperature_max: 23.6, temperature_min: 13.3 },
      },
    ],
  },
  uncertainty: {
    basis: "Confidence decreases with horizon distance, from one provider's output and its supplied spread only.",
    provider: "open-meteo",
    reference_time_utc: "2026-09-04T06:15:00Z",
    spread_available: false,
    horizon: [
      { confidence: "high" as const, hours_ahead: 6, time_local: "x", time_utc: "y" },
    ],
  },
};

const ANALYSIS = {
  data_class: "computed_statistic" as const,
  findings: [
    {
      measure: "temperature" as const,
      method: "arithmetic mean of usable points",
      minimum_points: 3,
      points_used: 168,
      points_excluded: 2,
      provenance: {} as never,
      statistic: "mean" as const,
      status: "computed" as const,
      unit: "°C",
      value: 17.9,
    },
  ],
  from_cache: false,
  horizon_days: 7,
  location: LOCATION,
  period: PERIOD,
  provider: "open-meteo",
  summary: "Across the window the mean temperature is 17.9 °C.",
  units: "metric" as const,
  uncertainty: FORECAST.uncertainty,
  anomalies: {
    measure: "temperature" as const,
    method: "median absolute deviation, threshold 3.5",
    median: 17.4,
    median_absolute_deviation: 1.2,
    points_used: 168,
    points_excluded: 0,
    anomalies: [{ deviation: 4.6, modified_z: 3.9 } as never],
    maximum: {} as never,
    minimum: {} as never,
  },
  trend: {
    direction: "rising" as const,
    insignificance_margin_per_day: 0.1,
    magnitude: 2.3,
    measure: "temperature" as const,
    method: "least-squares slope",
    minimum_points: 3,
    points_used: 168,
    provenance: {} as never,
    slope_per_day: 0.33,
    unit: "°C",
  },
};

/**
 * `GET /api/v1/weather/changes` — the backend's own `WhatChanged`, field for field.
 *
 * Typed as the generated contract rather than as a shape retyped here, so a backend change to the
 * comparison model fails this file rather than being papered over by a fixture that still matches
 * what the screen expects.
 */
const CHANGES: WhatChangedReport = {
  location: LOCATION,
  period: PERIOD,
  provider: "open-meteo",
  unit_system: "metric",
  data_class: "forecast",
  comparison_available: true,
  previous_retrieved_at: "2026-09-03T06:15:00Z",
  current_retrieved_at: "2026-09-04T06:15:00Z",
  changes: [
    {
      local_date: "2026-09-06",
      measure: "temperature_max",
      unit: "°C",
      previous: 21.4,
      current: 24.1,
      change: 2.7,
      material: true,
      statement: "2026-09-06 temperature_max +2.7 °C (21.4 to 24.1)",
    },
    {
      local_date: "2026-09-07",
      measure: "temperature_max",
      unit: "°C",
      previous: 20,
      current: 20.1,
      change: 0.1,
      material: false,
      statement: "2026-09-07 temperature_max unchanged (moved +0.1 °C, inside the 0.5 °C margin)",
    },
  ],
  statement:
    "Since 2026-09-03 06:15 UTC, the forecast for Berlin, Germany has moved: 2026-09-06 temperature_max +2.7 °C (21.4 to 24.1).",
};

const NO_PRIOR_SNAPSHOT: WhatChangedReport = {
  location: LOCATION,
  period: PERIOD,
  provider: "open-meteo",
  unit_system: "metric",
  data_class: "forecast",
  comparison_available: false,
  previous_retrieved_at: null,
  current_retrieved_at: "2026-09-04T06:15:00Z",
  changes: [],
  statement:
    "No earlier forecast is on record for Berlin, Germany over this window, so there is nothing to compare against yet. This is the current forecast, not a change.",
};

const BASELINE = {
  calendar_period: PERIOD,
  labelling: "Baseline for 4–11 September, computed from the years listed below.",
  location: LOCATION,
  measure: "temperature_mean" as const,
  provider: "open-meteo",
  unit_system: "metric" as const,
  years_requested: 10,
  years_used: [2017, 2018, 2019, 2020, 2021],
  coverage_note: "Fewer years were available than requested.",
  mean: { method: "arithmetic mean of usable points", points_used: 5, unit: "°C", value: 16.4 } as never,
  minimum: { method: "minimum of usable points", points_used: 5, unit: "°C", value: 13.1 } as never,
  maximum: { method: "maximum of usable points", points_used: 5, unit: "°C", value: 19.8 } as never,
  standard_deviation: {} as never,
};

/** Every number the design artifact shows. None of it is data, and none may reach the screen. */
const ARTIFACT_SAMPLE_VALUES = [
  "BER-CENTRAL-09",
  "Neural Agent",
  "v4.2",
  "v4.8.2",
  "94%",
  "82%",
  "98.2%",
  "42% Integrated Risk",
  "14.2°C",
  "+3.8°C",
  "+3.2°C vs 1995",
  "22.1°C",
  "1012 hPa",
  "GlobalWeatherOS",
  "ECMWF",
  "WMO",
  "Dr. Aris Thorne",
];

/* --------------------------------------------------------------------- harness */

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body } as unknown as Response;
}

/** Answers each Dashboard request by path, so a screen asking for something else fails loudly. */
function backend(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    const body = routes[path];
    if (body === undefined) {
      return jsonResponse(404, {
        error: { code: "not_found", message: `No fixture for ${path}`, details: null, request_id: "r" },
      });
    }
    return jsonResponse(status, body);
  });
}

const POPULATED = {
  "/api/v1/me/preferences": preferences(),
  "/api/v1/weather/current": CURRENT,
  "/api/v1/weather/forecast": FORECAST,
  "/api/v1/weather/analysis": ANALYSIS,
  "/api/v1/weather/changes": CHANGES,
  "/api/v1/weather/history/baseline": BASELINE,
};

function renderDashboard() {
  return render(
    <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input) => fetchMock(input)}>
      <Dashboard />
    </SessionBoundary>,
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  fetchMock = backend(POPULATED) as unknown as Mock;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("a populated briefing", () => {
  it("renders every surface the briefing is made of", async () => {
    renderDashboard();

    for (const title of [
      "Current conditions",
      "Forecast movement",
      "What Changed?",
      // Two panels since the 2026-09-11 parity pass, split the way `01-dashboard.png` splits
      // this band: the alert in the rail, the statistics in the wide column beside it.
      "Anomaly detection",
      "Computed figures",
      "Historical context",
      "Weathra Intelligence",
    ]) {
      expect(await screen.findByRole("region", { name: title }), title).toBeInTheDocument();
    }
  });

  it("shows the retrieved conditions for the person's own location", async () => {
    renderDashboard();

    const conditions = await screen.findByRole("region", { name: "Current conditions" });
    // The place names the readout and the attribution line beneath it.
    expect(within(conditions).getAllByText("Berlin, Germany").length).toBeGreaterThan(0);
    expect(within(conditions).getByText("18.2 °C")).toBeInTheDocument();
    expect(within(conditions).getByText("72 %")).toBeInTheDocument();
  });

  it("does not show a measure the provider did not report", async () => {
    renderDashboard();
    const conditions = await screen.findByRole("region", { name: "Current conditions" });

    // `precipitation` came back null. A zero here would be a fabricated measurement.
    expect(within(conditions).queryByText("Precipitation")).not.toBeInTheDocument();
    expect(within(conditions).queryByText("0 mm")).not.toBeInTheDocument();
  });

  it("renders the days ahead with their highs and lows", async () => {
    renderDashboard();
    const forecast = await screen.findByRole("region", { name: "Forecast movement" });

    expect(within(forecast).getByText("2026-09-04")).toBeInTheDocument();
    expect(within(forecast).getByText("21.4 °C")).toBeInTheDocument();
    expect(within(forecast).getByText("12.1 °C")).toBeInTheDocument();
    expect(within(forecast).getAllByText(/High|Low/).length).toBeGreaterThan(0);
  });

  it("carries the forecast's uncertainty with its stated basis", async () => {
    renderDashboard();
    const forecast = await screen.findByRole("region", { name: "Forecast movement" });

    expect(within(forecast).getByText("HIGH CONFIDENCE")).toBeInTheDocument();
    expect(within(forecast).getByText(/Confidence decreases with horizon distance/)).toBeInTheDocument();
    // The provider supplies no spread, so none is shown rather than derived.
    expect(within(forecast).getByText(/supplies no forecast spread/i)).toBeInTheDocument();
  });

  it("renders the anomalies, the trend, and the computed figures with their methods", async () => {
    renderDashboard();

    /*
     * Two regions, one band. The anomaly and the trend are the alert half and stay in the rail;
     * the statistics are the substance half and moved to the wide column. Both still carry their
     * method, which is the assertion that matters — `specs/deterministic-analytics` requires the
     * arithmetic to be named wherever the figure is shown, and the split created a second place
     * for it to be forgotten.
     */
    const alert = await screen.findByRole("region", { name: "Anomaly detection" });
    expect(within(alert).getByText(/1 entry stood out/)).toBeInTheDocument();
    expect(within(alert).getByText(/median absolute deviation/)).toBeInTheDocument();
    expect(within(alert).getByText("rising")).toBeInTheDocument();
    expect(within(alert).getByText(/least-squares slope/)).toBeInTheDocument();

    const figures = await screen.findByRole("region", { name: "Computed figures" });
    expect(within(figures).getByText("17.9 °C")).toBeInTheDocument();
    expect(within(figures).getAllByText(/Computed by Weathra/).length).toBeGreaterThan(0);
  });

  it("renders the historical baseline stating the years it actually used", async () => {
    renderDashboard();
    const historical = await screen.findByRole("region", { name: "Historical context" });

    expect(within(historical).getByText(/Computed from 5 years: 2017, 2018/)).toBeInTheDocument();
    expect(within(historical).getByText(/Fewer years were available than requested/)).toBeInTheDocument();
    // No claim of a published climate normal Weathra did not compute.
    expect(within(historical).queryByText(/1991-2020|climate norm/i)).not.toBeInTheDocument();
  });
});

describe("the person's own preferences decide the briefing", () => {
  it("asks for their default location, in their unit system, over their horizon", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Forecast movement" });

    const asked = fetchMock.mock.calls.map(([input]) => new URL(input as string));
    const forecast = asked.find((url) => url.pathname === "/api/v1/weather/forecast");

    expect(forecast?.searchParams.get("latitude")).toBe("52.52");
    expect(forecast?.searchParams.get("longitude")).toBe("13.405");
    expect(forecast?.searchParams.get("units")).toBe("metric");
    expect(forecast?.searchParams.get("days")).toBe("7");
  });

  it("asks in imperial when that is what they chose", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ unit_system: "imperial", forecast_horizon_days: 3 }),
      "/api/v1/weather/current": {
        ...CURRENT,
        units: { temperature: "°F" },
        values: { temperature: 64.8 },
        attribution: { ...ATTRIBUTION, units: "imperial" },
      },
    }) as unknown as Mock;

    renderDashboard();

    const conditions = await screen.findByRole("region", { name: "Current conditions" });
    // The unit rendered is the one the response declared, not one the screen chose.
    expect(within(conditions).getByText("64.8 °F")).toBeInTheDocument();

    const current = fetchMock.mock.calls
      .map(([input]) => new URL(input as string))
      .find((url) => url.pathname === "/api/v1/weather/current");
    expect(current?.searchParams.get("units")).toBe("imperial");
  });

  it("calls the documented backend API and nothing else", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input as string);
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      // Never a weather provider, and never a geocoder, from the browser.
      expect(url.host).not.toMatch(/open-meteo|openmeteo/i);
    }
  });
});

/*
 * The Dashboard of a brand-new account, which is the first screen Weathra ever shows anybody.
 *
 * It used to be a title, one sentence, a link to Settings and most of a black viewport. It is now
 * `GettingStarted` — the same visual system as the populated screen, with the product in each
 * region instead of measurements. What these assert is that it is *full and honest*: the thing to
 * do is on screen, the regions describe themselves, and not one weather figure was invented to fill
 * them.
 */
describe("a person with no saved default location", () => {
  it("offers the way to choose a place rather than choosing one for them", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
    }) as unknown as Mock;

    renderDashboard();

    // The thing to do, in the hero, not behind a disclosure.
    expect(
      await screen.findByRole("heading", { name: "Name a place, and the briefing fills in" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Brief me on a place")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show briefing" })).toBeVisible();

    // Nothing was requested for a location Weathra does not have.
    const asked = fetchMock.mock.calls.map(([input]) => new URL(input as string).pathname);
    expect(asked).not.toContain("/api/v1/weather/current");
    expect(asked).not.toContain("/api/v1/weather/forecast");
  });

  it("previews every region of a briefing instead of leaving the viewport empty", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("heading", { name: "Name a place, and the briefing fills in" });

    // The five regions the populated Dashboard holds, each named and each explained.
    for (const region of [
      "Current conditions",
      "Forecast",
      "What changed?",
      "Historical context",
      "Weathra Intelligence",
    ]) {
      expect(screen.getByRole("heading", { name: region })).toBeInTheDocument();
    }

    // The two onward steps, and somewhere to start for somebody with no city in mind.
    expect(screen.getByRole("link", { name: "London, United Kingdom" }).getAttribute("href")).toBe(
      "/?place=London%2C%20United%20Kingdom",
    );
    expect(screen.getByRole("button", { name: "Saved locations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI Weather Analyst" })).toBeInTheDocument();
  });

  it("invents no measurement to fill the regions it is previewing", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("heading", { name: "Name a place, and the briefing fills in" });

    /*
     * The failure this guards against is a prettier one than the blank screen: filling the hero
     * with 18° and the strip with a week of conditions. `screens.md` §5 forbids it, and a new
     * account is precisely the audience with no way to tell a placeholder from a reading.
     */
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/-?\d+(\.\d+)?\s*°/);
    expect(text).not.toMatch(/\d+\s*(km\/h|mph|hPa|mm)\b/);
  });
});

/*
 * The runtime fidelity audit of 2026-09-08, finding 1.7: `01-dashboard.png` opens onto the hero,
 * and production opened onto a form. Both halves are asserted — that the entry is folded once
 * there is a briefing, and that it is the same form with the same field one press away — plus the
 * three states where folding it would hide the thing to do.
 */
describe("the place entry, folded (1.7)", () => {
  it("is closed once there is a briefing, and holds the same field one press away", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });

    const entry = screen.getByLabelText("Brief me on a place");
    expect(entry).not.toBeVisible();

    await userEvent.click(screen.getByText("Brief on another place"));
    expect(entry).toBeVisible();
    expect(screen.getByRole("button", { name: "Show briefing" })).toBeVisible();
  });

  it("is open when there is no default location to brief on", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
    }) as unknown as Mock;

    renderDashboard();

    // With no default there is no disclosure at all: the onboarding screen puts the field in its
    // hero. A form folded away behind a summary would be finding 6.5's mistake on Saved Locations,
    // and one headed "Brief on another place" would be asking for *another* than none.
    expect(
      await screen.findByRole("heading", { name: "Name a place, and the briefing fills in" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Brief on another place")).toBeNull();
    expect(screen.getByLabelText("Brief me on a place")).toBeVisible();
  });
});

describe("What Changed?, through the endpoint that returns it", () => {
  it("renders the comparison the backend produced, and computes no part of it", async () => {
    renderDashboard();

    const section = await screen.findByRole("region", { name: "What Changed?" });
    // The backend's own statement, and the delta it reported. Neither is derived here.
    expect(within(section).getByText(/the forecast for Berlin, Germany has moved/i)).toBeInTheDocument();
    expect(within(section).getByText("+2.7 °C")).toBeInTheDocument();
    expect(within(section).getByText(/Previous snapshot retrieved/)).toBeInTheDocument();
    // Movement inside the materiality margin is not presented as a change.
    expect(within(section).queryByText("+0.1 °C")).not.toBeInTheDocument();
    // And the section is attributed like every other data-bearing surface.
    expect(within(section).getAllByText("open-meteo").length).toBeGreaterThan(0);
    expect(within(section).getByText("FORECAST")).toBeInTheDocument();
  });

  it("asks for the same place, units, and horizon as the forecast beside it", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "What Changed?" });

    const asked = fetchMock.mock.calls.map(([input]) => new URL(input as string));
    const changes = asked.find((url) => url.pathname === "/api/v1/weather/changes");

    expect(changes, "the Dashboard must call the changes endpoint").toBeDefined();
    expect(changes?.searchParams.get("latitude")).toBe("52.52");
    expect(changes?.searchParams.get("longitude")).toBe("13.405");
    expect(changes?.searchParams.get("units")).toBe("metric");
    expect(changes?.searchParams.get("days")).toBe("7");
  });

  it("says there is nothing to compare against when the backend reports no earlier snapshot", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/weather/changes": NO_PRIOR_SNAPSHOT,
    }) as unknown as Mock;

    renderDashboard();

    const section = await screen.findByRole("region", { name: "What Changed?" });
    expect(
      within(section).getByText(/No earlier snapshot for this location and window/),
    ).toBeInTheDocument();
    expect(within(section).getByText(/nothing to compare against yet/)).toBeInTheDocument();
    // A zero would claim the forecast had not moved, which is a different statement.
    expect(within(section).queryByText(/^\+?0(\.0)? /)).not.toBeInTheDocument();
    expect(within(section).queryByText(/unchanged/i)).not.toBeInTheDocument();
  });

  it("says the comparison could not be obtained when the request fails, and briefs on regardless", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/weather/changes") {
        return jsonResponse(502, {
          error: {
            code: "provider_unavailable",
            message: "The weather provider is unavailable.",
            details: null,
            request_id: "r",
          },
        });
      }
      return jsonResponse(200, (POPULATED as Record<string, unknown>)[path]);
    }) as unknown as Mock;

    renderDashboard();

    const section = await screen.findByRole("region", { name: "What Changed?" }, { timeout: 5000 });
    expect(within(section).getByText(/not available yet/i)).toBeInTheDocument();
    // Distinct from the backend saying there is nothing earlier on record.
    expect(
      within(section).queryByText(/No earlier snapshot for this location and window/),
    ).not.toBeInTheDocument();
    // And every other surface is untouched.
    expect(screen.getByRole("region", { name: "Current conditions" })).toBeInTheDocument();
    expect(screen.getByText("18.2 °C")).toBeInTheDocument();
  });

  it("routes a 401 to the expired session rather than showing it as a weather failure", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/weather/changes") {
        return jsonResponse(401, {
          error: {
            code: "token_expired",
            message: "The access token has expired.",
            details: null,
            request_id: "r",
          },
        });
      }
      return jsonResponse(200, (POPULATED as Record<string, unknown>)[path]);
    }) as unknown as Mock;

    renderDashboard();

    const expired = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(expired).toHaveTextContent(/your session has expired/i);
    // Not the section's unavailable state, and not an error card with the backend's message.
    expect(screen.queryByRole("region", { name: "What Changed?" })).not.toBeInTheDocument();
    expect(screen.queryByText("The access token has expired.")).not.toBeInTheDocument();
  });
});

describe("a location with no prior snapshot", () => {
  it("says there is nothing to compare against, never a zero delta", () => {
    render(
      <WhatChanged
        report={{
          location: LOCATION,
          period: PERIOD,
          provider: "open-meteo",
          unit_system: "metric",
          comparison_available: false,
          previous_retrieved_at: null,
          current_retrieved_at: "2026-09-04T06:15:00Z",
          changes: [],
          statement: "No earlier snapshot of this window exists for this location.",
        }}
      />,
    );

    const section = screen.getByRole("region", { name: "What Changed?" });
    expect(within(section).getByText(/No earlier snapshot for this location and window/)).toBeInTheDocument();
    expect(within(section).getByText(/No earlier snapshot of this window exists/)).toBeInTheDocument();
    // A zero would claim the forecast had not moved.
    expect(within(section).queryByText(/^0(\.0)? /)).not.toBeInTheDocument();
    expect(within(section).queryByText(/unchanged/i)).not.toBeInTheDocument();
  });

  it("lists what moved materially when there is a snapshot to compare against", () => {
    render(
      <WhatChanged
        report={{
          location: LOCATION,
          period: PERIOD,
          provider: "open-meteo",
          unit_system: "metric",
          comparison_available: true,
          previous_retrieved_at: "2026-09-03T06:15:00Z",
          current_retrieved_at: "2026-09-04T06:15:00Z",
          changes: [
            {
              local_date: "2026-09-06",
              measure: "temperature_max",
              unit: "°C",
              previous: 21.4,
              current: 24.1,
              change: 2.7,
              material: true,
              statement: "The high for 6 September is 2.7 °C warmer than the previous snapshot.",
            },
            {
              local_date: "2026-09-07",
              measure: "temperature_max",
              unit: "°C",
              previous: 20,
              current: 20.1,
              change: 0.1,
              material: false,
              statement: "Immaterial movement.",
            },
          ],
          statement: "Two days moved since the previous snapshot; one materially.",
        }}
      />,
    );

    const section = screen.getByRole("region", { name: "What Changed?" });
    expect(within(section).getByText("+2.7 °C")).toBeInTheDocument();
    // Movement inside the materiality margin is not presented as a change.
    expect(within(section).queryByText("+0.1 °C")).not.toBeInTheDocument();
    expect(within(section).getByText(/Previous snapshot retrieved/)).toBeInTheDocument();
  });

  it("distinguishes 'no comparison could be obtained' from 'nothing to compare against'", () => {
    render(<WhatChanged report={null} />);

    const section = screen.getByRole("region", { name: "What Changed?" });
    expect(within(section).getByText(/not available yet/i)).toBeInTheDocument();
    expect(within(section).queryByText(/No earlier snapshot for this location/)).not.toBeInTheDocument();
  });
});

describe("the loading state", () => {
  it("announces that the briefing is loading, and shows no figure meanwhile", () => {
    fetchMock = vi.fn(() => new Promise<Response>(() => {})) as unknown as Mock;

    renderDashboard();

    expect(screen.getByRole("status")).toHaveTextContent("Loading your briefing");
    expect(screen.queryByRole("region", { name: "Current conditions" })).not.toBeInTheDocument();
  });

  it("waits for the retrieved surfaces before briefing anybody", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/me/preferences") return jsonResponse(200, preferences());
      return new Promise<Response>(() => {});
    }) as unknown as Mock;

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Loading the briefing for Berlin, Germany/),
    );
    expect(screen.queryByText(/°C/)).not.toBeInTheDocument();
  });
});

describe("the error state", () => {
  it("shows the backend's own message and offers a retry that needs no reload", async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse(503, {
        error: {
          code: "provider_unavailable",
          message: "The weather provider is unavailable.",
          details: null,
          request_id: "req-42",
        },
      }),
    ) as unknown as Mock;

    renderDashboard();

    expect(
      await screen.findByText("The weather provider is unavailable.", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Request req-42")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Try again" });
    const before = fetchMock.mock.calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("keeps the rest of the briefing when only one surface fails", async () => {
    fetchMock = backend({ ...POPULATED, "/api/v1/weather/history/baseline": undefined }) as unknown as Mock;

    renderDashboard();

    // The historical surface reports its own failure; conditions and forecast are unaffected.
    expect(await screen.findByRole("region", { name: "Current conditions" })).toBeInTheDocument();
    expect(await screen.findByText(/No fixture for/, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Forecast movement" })).toBeInTheDocument();
  });
});

describe("data classes, provenance, and the line the model does not cross", () => {
  it("badges each surface with its own data class", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    expect(within(screen.getByRole("region", { name: "Current conditions" })).getByText("OBSERVED")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Forecast movement" })).getByText("FORECAST")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "What Changed?" })).getByText("FORECAST"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Computed figures" })).getByText("ANALYTICS"),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Historical context" })).getByText("HISTORICAL")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Weathra Intelligence" })).getByText("AI INTERPRETATION"),
    ).toBeInTheDocument();
  });

  it("separates retrieved figures, deterministic analytics, and model language into three tiers", async () => {
    const { container } = renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    expect(container.querySelectorAll('[data-tier="retrieved"]').length).toBeGreaterThanOrEqual(3);
    /*
     * Two computed regions, and the count stays exact rather than becoming a floor: the analytics
     * band was split in two on 2026-09-11 — the anomaly alert in the rail, the statistics in the
     * wide column — and an exact count is what would catch a third appearing by accident. One
     * interpretation region, which is the tier that must never multiply: every model-written
     * sentence on this screen belongs to the one panel that says a model wrote it.
     */
    expect(container.querySelectorAll('[data-tier="computed"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-tier="interpretation"]')).toHaveLength(1);

    // The model's region contains none of the figures, and none of the figure regions contains it.
    const interpretation = container.querySelector('[data-tier="interpretation"]') as HTMLElement;
    expect(within(interpretation).queryByText("18.2 °C")).not.toBeInTheDocument();
    expect(interpretation.querySelector('[data-tier="retrieved"]')).toBeNull();
    expect(interpretation.querySelector('[data-tier="computed"]')).toBeNull();
  });

  it("attributes every data-bearing surface to the provider the backend named", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    for (const title of [
      "Current conditions",
      "Forecast movement",
      "What Changed?",
      "Anomaly detection",
      "Computed figures",
      "Historical context",
    ]) {
      const region = screen.getByRole("region", { name: title });
      expect(region.querySelector('[data-attribution="true"]'), title).toBeInTheDocument();
      expect(within(region).getAllByText("open-meteo").length, title).toBeGreaterThan(0);
      expect(within(region).getAllByText("Berlin, Germany").length, title).toBeGreaterThan(0);
    }
  });

  it("says the model produced no measurement, before it has said anything at all", async () => {
    renderDashboard();

    const panel = await screen.findByRole("region", { name: "Weathra Intelligence" });
    expect(within(panel).getByText(/produced no measurement, forecast, or statistic/i)).toBeInTheDocument();
  });

  it("asks the agent only when asked to, and shows its answer inside the interpretation panel", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/agent/ask": {
        answer: {
          answer_prose: "The week ahead sits close to the baseline, with one warmer day midweek.",
          evidence: {},
          grounding: {},
          llm_provider: "openrouter",
          llm_model: "nvidia/nemotron-nano-9b-v2:free",
          request_id: "req-9",
        },
        memory_available: true,
      },
    }) as unknown as Mock;

    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Weathra Intelligence" });

    // Nothing was spent on inference on arrival.
    expect(fetchMock.mock.calls.map(([i]) => new URL(i as string).pathname)).not.toContain("/api/v1/agent/ask");

    await userEvent.click(within(panel).getByRole("button", { name: "Generate interpretation" }));

    expect(await screen.findByText(/sits close to the baseline/)).toBeInTheDocument();
    expect(screen.getByText(/Model: openrouter · nvidia/)).toBeInTheDocument();
  });

  it("shows an exhausted allowance as its own state, not as a failed briefing", async () => {
    /*
     * Task 33.5. The briefing is the Dashboard's one agent-backed surface, so it is the one place
     * on this screen a plan limit can be reached — and the requirement is that a 429 produces the
     * quota state rather than a data error or a session error, naming the limit and its reset,
     * with everything the person had still on screen.
     */
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/agent/ask") {
        return jsonResponse(429, {
          error: {
            code: "quota_exceeded",
            message:
              "You have used today's allowance of agent questions. It resets at the start of the " +
              "next day. Forecasts, history, comparisons and analysis are unaffected.",
            details: {
              dimension: "requests_per_day",
              window: "day",
              allowance: 20,
              consumed: 20,
              resets_at: "2026-09-10T00:00:00Z",
              retry_after_seconds: 16_200,
            },
            request_id: "req-quota",
          },
        });
      }
      return jsonResponse(200, (POPULATED as Record<string, unknown>)[path]);
    }) as unknown as Mock;

    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Weathra Intelligence" });
    await userEvent.click(within(panel).getByRole("button", { name: "Generate interpretation" }));

    const state = await waitFor(() => {
      const found = document.querySelector('[data-quota="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // The limit and the reset, from the refusal's own figures.
    expect(within(state).getByText("20 of 20 questions today")).toBeInTheDocument();
    expect(within(state).getByText("2026-09-10 00:00 UTC")).toBeInTheDocument();
    // Not a weather error, not an unconfigured agent, not an expired session.
    expect(screen.queryByText(/no inference provider is configured/i)).toBeNull();
    expect(within(state).queryByRole("alert")).toBeNull();

    // The person's saved locations and preferences are still there, and every retrieved and
    // computed figure is untouched: a refusal of one request removed nothing.
    expect(screen.getByRole("region", { name: "Current conditions" })).toBeInTheDocument();
    expect(screen.getByText("18.2 °C")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Saved snapshots" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Anomaly detection" })).toBeInTheDocument();
  });

  it("shows the provider, model and policy that actually served the briefing", async () => {
    // Task 33.6, through the same function the Analyst uses: the run's own inference attempt wins
    // over the configured pair the envelope also carries.
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/agent/ask": {
        answer: {
          answer_prose: "The week ahead sits close to the baseline.",
          evidence: {
            inference_attempts: [
              {
                stage: "synthesis",
                status: "served",
                attempt_number: 1,
                provider: "openrouter",
                selected_model: "a-synthesis-model",
                served_model: "a-synthesis-model",
                catalog_key: "a-synthesis-model",
                policy_id: "free-synthesis",
                plan: "free",
                resolution_reason: "First enabled candidate of the plan's synthesis policy.",
              },
            ],
          },
          grounding: {},
          llm_provider: "the-configured-gateway",
          llm_model: "the-configured-model",
          request_id: "req-9",
        },
        memory_available: true,
      },
    }) as unknown as Mock;

    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Weathra Intelligence" });
    await userEvent.click(within(panel).getByRole("button", { name: "Generate interpretation" }));

    expect(await screen.findByText("Model: openrouter · a-synthesis-model")).toBeInTheDocument();
    expect(screen.getByText("Policy: free-synthesis")).toBeInTheDocument();
    expect(screen.queryByText(/the-configured-model/)).toBeNull();
  });

  it("stays fully useful when no inference provider is configured", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/agent/ask") {
        return jsonResponse(503, {
          error: {
            code: "agent_not_configured",
            message: "No inference provider is configured.",
            details: null,
            request_id: "r",
          },
        });
      }
      const body = (POPULATED as Record<string, unknown>)[path];
      return jsonResponse(200, body);
    }) as unknown as Mock;

    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Weathra Intelligence" });
    await userEvent.click(within(panel).getByRole("button", { name: "Generate interpretation" }));

    expect(await screen.findByText(/no inference provider is configured/i)).toBeInTheDocument();
    // Every retrieved and computed surface is untouched.
    expect(screen.getByRole("region", { name: "Current conditions" })).toBeInTheDocument();
    expect(screen.getByText("18.2 °C")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Anomaly detection" })).toBeInTheDocument();
  });
});

describe("nothing from the design artifact reaches the screen", () => {
  it("shows no sample value, invented source, station, or version string", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    const shown = document.body.textContent ?? "";
    for (const sample of ARTIFACT_SAMPLE_VALUES) {
      expect(shown, sample).not.toContain(sample);
    }
  });

  it("offers no control the artifact shows that Weathra refuses to implement", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    for (const refused of [/compare models/i, /recalibrat/i, /export data/i, /export pdf/i, /chain of custody/i]) {
      expect(screen.queryByRole("button", { name: refused }), String(refused)).not.toBeInTheDocument();
    }
    // And not the post-MVP screen's name on a Dashboard section.
    expect(screen.queryByText("Forecast Explorer")).not.toBeInTheDocument();
  });

  it("shows every figure the backend supplied, and no figure it did not", async () => {
    renderDashboard();
    await screen.findByRole("region", { name: "Historical context" });

    // Each figure on screen traced back to the fixture that produced it.
    for (const supplied of [
      "18.2 °C", "72 %", "21.4 °C", "12.1 °C", "23.6 °C", "13.3 °C",
      "17.9 °C", "16.4 °C", "13.1 °C", "19.8 °C",
    ]) {
      expect(screen.getAllByText(supplied).length, supplied).toBeGreaterThan(0);
    }

    // And the artifact's own figures, which are mockup filler, appear nowhere.
    const shown = document.body.textContent ?? "";
    for (const invented of ["1012", "14.2", "42%", "94%", "82%", "98.2", "4.2mm", "22.1"]) {
      expect(shown, invented).not.toContain(invented);
    }
  });
});

/* ------------------------------------------------------- task 21.7: ambiguity */

/**
 * Naming a place to brief on, and the ambiguity gate over it — task 21.7.
 *
 * The property under test is not that a list appears: it is that **no weather request is made and
 * no figure is shown** for a name that matched several places, and that the briefing which then
 * appears is for the candidate that was pressed. `specs/web-ui` asks for exactly that, and it is the
 * one behaviour a geocoder-backed screen gets wrong by default.
 */
const SPRINGFIELD_IL = {
  display_name: "Springfield",
  latitude: 39.8017,
  longitude: -89.6437,
  timezone: "America/Chicago",
  region: "Illinois",
  country: "United States",
  country_code: "US",
};

const SPRINGFIELD_MO = {
  ...SPRINGFIELD_IL,
  latitude: 37.2153,
  longitude: -93.2982,
  region: "Missouri",
};

const AMBIGUOUS_SPRINGFIELD = {
  kind: "ambiguous",
  query: "Springfield",
  candidates: [SPRINGFIELD_IL, SPRINGFIELD_MO],
  message:
    "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US. Weathra does not pick one for you.",
};

/** Answers by path *and* records the query, so which place was asked about is assertable. */
function askedFor(pathname: string): URL[] {
  return (fetchMock.mock.calls as [string][])
    .map(([input]) => new URL(input))
    .filter((url) => url.pathname === pathname);
}

async function nameAPlace(person: ReturnType<typeof userEvent.setup>, name: string) {
  await person.clear(screen.getByLabelText("Brief me on a place"));
  await person.type(screen.getByLabelText("Brief me on a place"), name);
  await person.click(screen.getByRole("button", { name: "Show briefing" }));
}

describe("an ambiguous place named on the Dashboard", () => {
  it("presents the candidates the backend returned, with their own region and country", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/locations/resolve": AMBIGUOUS_SPRINGFIELD,
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Springfield");

    const chooser = await screen.findByRole("group", { name: "Places matching what you entered" });
    const candidates = within(chooser).getAllByRole("button");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent("Illinois, United States");
    expect(candidates[0]).toHaveTextContent("39.8017, -89.6437");
    expect(candidates[1]).toHaveTextContent("Missouri, United States");

    // The backend's own sentence, and the statement that a choice is required.
    expect(screen.getByText(/Weathra does not pick one for you/)).toBeInTheDocument();
    expect(screen.getByText("Which place did you mean?")).toBeInTheDocument();
  });

  it("requests and shows nothing location-dependent until a candidate is pressed", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/locations/resolve": AMBIGUOUS_SPRINGFIELD,
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    const before = askedFor("/api/v1/weather/current").length;

    await nameAPlace(person, "Springfield");
    await screen.findByRole("group", { name: "Places matching what you entered" });

    // No new weather request went out for the ambiguous name.
    expect(askedFor("/api/v1/weather/current")).toHaveLength(before);
    for (const pathname of [
      "/api/v1/weather/current",
      "/api/v1/weather/forecast",
      "/api/v1/weather/analysis",
      "/api/v1/weather/changes",
      "/api/v1/weather/history/baseline",
    ]) {
      for (const url of askedFor(pathname)) {
        // Every weather request Weathra ever made was for the default location's coordinates.
        expect(url.searchParams.get("latitude")).toBe("52.52");
      }
    }

    // And the briefing that was on screen for the default place is withdrawn: it is not the
    // answer to what was just typed, and leaving it under the candidates would let it read as one.
    expect(screen.queryByRole("region", { name: "Current conditions" })).toBeNull();
    expect(screen.queryByText("18.2 °C")).toBeNull();
  });

  it("briefs on the candidate that was pressed, by that candidate's own coordinates", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/locations/resolve": AMBIGUOUS_SPRINGFIELD,
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Springfield");

    const chooser = await screen.findByRole("group", { name: "Places matching what you entered" });
    await person.click(within(chooser).getAllByRole("button")[1]!);

    // The briefing returns, and every request it makes is for the *chosen* candidate.
    await screen.findByRole("region", { name: "Current conditions" });
    expect(screen.getByText(/Briefing on Springfield, Missouri, US/)).toBeInTheDocument();

    const forCandidate = askedFor("/api/v1/weather/current").filter(
      (url) => url.searchParams.get("latitude") === "37.2153",
    );
    expect(forCandidate.length).toBeGreaterThan(0);
    expect(forCandidate[0]?.searchParams.get("longitude")).toBe("-93.2982");
    // Never the other candidate, and never the geocoder's first result by default.
    expect(
      askedFor("/api/v1/weather/current").some(
        (url) => url.searchParams.get("latitude") === "39.8017",
      ),
    ).toBe(false);
  });

  it("returns to the default location when asked, and re-briefs on it", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/locations/resolve": AMBIGUOUS_SPRINGFIELD,
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Springfield");
    await screen.findByRole("group", { name: "Places matching what you entered" });

    await person.click(screen.getByRole("button", { name: "Back to my default location" }));

    await screen.findByRole("region", { name: "Current conditions" });
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
    expect(screen.queryByText(/Briefing on/)).toBeNull();
  });

  it("keeps a name that matched nothing distinct from one that matched several", async () => {
    const person = userEvent.setup();
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/locations/resolve") {
        return {
          ok: false,
          status: 404,
          statusText: "",
          json: async () => ({
            error: {
              code: "location_not_found",
              message: "No location matches 'Zzzzz'.",
              details: null,
              request_id: "r",
            },
          }),
        } as unknown as Response;
      }
      return (backend(POPULATED) as unknown as Mock)(input);
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Zzzzz");

    const panel = await screen.findByText("No place matches that name");
    expect(panel.closest("[data-location-state]")).toHaveAttribute(
      "data-location-state",
      "not-found",
    );
    expect(screen.getByText("No location matches 'Zzzzz'.")).toBeInTheDocument();
    // Not ambiguity: there is nothing to choose between, and no candidate is offered.
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
    expect(screen.queryByRole("group", { name: "Places matching what you entered" })).toBeNull();
  });

  it("keeps a failed lookup distinct from both, and offers a retry", async () => {
    const person = userEvent.setup();
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/locations/resolve") {
        return {
          ok: false,
          status: 500,
          statusText: "",
          json: async () => ({
            error: {
              code: "internal_error",
              message: "Weathra could not reach its geocoder.",
              details: null,
              request_id: "r",
            },
          }),
        } as unknown as Response;
      }
      return (backend(POPULATED) as unknown as Mock)(input);
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Berlin");

    const failure = await screen.findByText("That location could not be looked up");
    expect(failure.closest("[data-location-state]")).toHaveAttribute(
      "data-location-state",
      "failed",
    );
    expect(screen.getByText("Weathra could not reach its geocoder.")).toBeInTheDocument();
    expect(screen.queryByText("No place matches that name")).toBeNull();
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
  });

  it("briefs straight away on a name that matched exactly one place", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/locations/resolve": {
        kind: "resolved",
        query: "Springfield, Missouri",
        location: SPRINGFIELD_MO,
      },
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Springfield, Missouri");

    await waitFor(() =>
      expect(
        askedFor("/api/v1/weather/current").some(
          (url) => url.searchParams.get("latitude") === "37.2153",
        ),
      ).toBe(true),
    );
    // No choice was asked for, because there was nothing to choose between.
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
  });

  it("routes a 401 on the lookup to the shared expired-session state", async () => {
    const person = userEvent.setup();
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/locations/resolve") {
        return {
          ok: false,
          status: 401,
          statusText: "",
          json: async () => ({
            error: {
              code: "token_expired",
              message: "Your access token has expired.",
              details: null,
              request_id: "r",
            },
          }),
        } as unknown as Response;
      }
      return (backend(POPULATED) as unknown as Mock)(input);
    }) as unknown as Mock;

    renderDashboard();
    await screen.findByRole("region", { name: "Current conditions" });
    await nameAPlace(person, "Berlin");

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(screen.queryByText("That location could not be looked up")).toBeNull();
    expect(screen.queryByText("Your access token has expired.")).toBeNull();
  });
});
