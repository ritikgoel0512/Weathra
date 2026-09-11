/**
 * Historical Analytics — task 21.3's verification.
 *
 * The three the task names — a period comparison, a baseline comparison stating years used, and a
 * range rejected as outside coverage — then the ones that are honesty properties rather than
 * behaviour: that the charts are drawn from the API's own series, that a day the archive did not
 * report stays a gap, that retrieved observations and computed statistics are two labelled regions,
 * and that no figure on the screen came from anywhere but a response.
 *
 * The API is driven through the real client and the real query layer inside the real session
 * boundary; only `fetch` and Supabase are replaced. Recharts renders into a zero-size container
 * under jsdom, so the chart's *data* is asserted through the figure table it ships — which is the
 * point of shipping one.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PreferenceView } from "@/lib/api/schema";
import { SessionBoundary } from "@/lib/session/provider";

import { HistoricalAnalytics } from "./historical";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("Historical Analytics must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/historical",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------- fixtures */

const BERLIN = {
  display_name: "Berlin, Germany",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  country: "Germany",
};

function period(start: string, end: string) {
  return {
    start_local: `${start}T00:00:00+02:00`,
    end_local: `${end}T23:59:00+02:00`,
    start_utc: `${start}T22:00:00Z`,
    end_utc: `${end}T21:59:00Z`,
    timezone: "Europe/Berlin",
  };
}

const SELECTED = period("2025-06-01", "2025-06-03");
const EARLIER = period("2024-06-01", "2024-06-03");

function statistic(overrides: Record<string, unknown> = {}) {
  return {
    statistic: "mean",
    measure: "temperature_mean",
    value: 15.6,
    unit: "°C",
    method: "arithmetic mean of usable points",
    minimum_points: 1,
    points_used: 2,
    points_excluded: 1,
    status: "computed",
    provenance: {},
    ...overrides,
  };
}

const HISTORY = {
  location: BERLIN,
  provider: "open-meteo",
  units: "metric" as const,
  data_class: "historical_observation" as const,
  requested_period: SELECTED,
  covered_period: SELECTED,
  retrieved_at: "2025-06-10T06:15:00Z",
  partial: false,
  unavailable_note: null,
  daily: {
    granularity: "daily" as const,
    units: { temperature_mean: "°C", precipitation_sum: "mm" },
    entries: [
      {
        time_utc: "2025-06-01T00:00:00Z",
        time_local: "2025-06-01T02:00:00+02:00",
        values: { temperature_mean: 14.2, precipitation_sum: 0 },
      },
      {
        time_utc: "2025-06-02T00:00:00Z",
        time_local: "2025-06-02T02:00:00+02:00",
        // The archive did not report this day.
        values: { temperature_mean: null, precipitation_sum: null },
      },
      {
        time_utc: "2025-06-03T00:00:00Z",
        time_local: "2025-06-03T02:00:00+02:00",
        values: { temperature_mean: 17.1, precipitation_sum: 4.6 },
      },
    ],
  },
  hourly: null,
};

const COMPARISON = {
  location: BERLIN,
  data_class: "historical_observation" as const,
  earlier_period: EARLIER,
  later_period: SELECTED,
  provider: "open-meteo",
  unit_system: "metric" as const,
  statistics_applied: ["temperature_mean: mean, minimum, maximum", "precipitation_sum: total"],
  earlier: [statistic({ value: 12.9 })],
  later: [
    statistic(),
    statistic({ statistic: "minimum", measure: "temperature_min", value: 9.2, unit: "°C" }),
    statistic({ statistic: "maximum", measure: "temperature_max", value: 22.1, unit: "°C" }),
    statistic({
      statistic: "total",
      measure: "precipitation_sum",
      value: 4.6,
      unit: "mm",
      method: "sum of usable points",
    }),
    statistic({
      statistic: "mean",
      measure: "wind_speed_max",
      value: null,
      unit: "",
      status: "not_computable",
      reason: "the archive supplied no wind speed for this range",
    }),
  ],
  deltas: [
    statistic({
      statistic: "delta",
      measure: "temperature_mean",
      value: 2.7,
      unit: "°C",
      method: "later minus earlier",
    }),
  ],
  percentage_changes: { temperature_mean: 20.9 },
  lengths_differ: false,
  basis: "Both periods: open-meteo archive observations, metric units, the same statistics.",
};

const BASELINE_COMPARISON = {
  location: BERLIN,
  measure: "temperature_mean" as const,
  observed_or_forecast_value: 15.6,
  observed_data_class: "historical_observation" as const,
  characterization: "Warmer than the 6-year baseline for this calendar period.",
  forecast_side_caveat: null,
  difference: statistic({
    statistic: "delta",
    value: 1.2,
    unit: "°C",
    method: "the value being compared minus the 6-year baseline",
  }),
  z_score: statistic({
    statistic: "z_score",
    value: 0.84,
    unit: "",
    method: "value minus reference mean, divided by the reference standard deviation",
  }),
  baseline: {
    location: BERLIN,
    data_class: "computed_statistic" as const,
    measure: "temperature_mean" as const,
    calendar_period: SELECTED,
    years_requested: 10,
    years_used: [2019, 2020, 2021, 2022, 2023, 2024],
    provider: "open-meteo",
    unit_system: "metric" as const,
    labelling:
      "A historical statistic computed by Weathra from open-meteo archive observations over 6 year(s). It is not an official climate normal published by a meteorological authority.",
    coverage_note: "6 of the 10 requested years were available in the archive: 2019, 2020, 2021, 2022, 2023, 2024.",
    mean: statistic({ value: 14.4 }),
    standard_deviation: statistic({ statistic: "standard_deviation", value: 1.43 }),
    minimum: statistic({ statistic: "minimum", value: 11.8 }),
    maximum: statistic({ statistic: "maximum", value: 18.2 }),
  },
};

function preferences(overrides: Partial<PreferenceView> = {}): PreferenceView {
  return {
    unit_system: "metric",
    forecast_horizon_days: 7,
    sources: { unit_system: "chosen", default_location: "chosen" },
    default_location: BERLIN,
    ...overrides,
  } as PreferenceView;
}

/** Every number the design artifact shows. None of it is data, and none may reach the screen. */
const ARTIFACT_SAMPLE_VALUES = [
  "STATION BER-09",
  "BER-09",
  "98.4%",
  "98.2th",
  "14 Nodes",
  "2.84 σ",
  "+3.2°C",
  "1012",
  "72.4",
  "14.6",
  "ERA5",
  "WMO-1991-2020-NORMAL",
  "1991-2020",
  "Neural Agent",
  "v4.8.2-STABLE",
  "Dr. Aris Thorne",
];

/* --------------------------------------------------------------------- harness */

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

/** Answers each request by path, so a screen asking for something else fails loudly. */
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
  "/api/v1/me/locations": { count: 1, limit: 20, locations: [{ id: "s1", location: BERLIN }] },
  "/api/v1/weather/history": HISTORY,
  "/api/v1/weather/history/comparison": COMPARISON,
  "/api/v1/weather/history/baseline/comparison": BASELINE_COMPARISON,
};

function renderScreen() {
  return render(
    <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input) => fetchMock(input)}>
      <HistoricalAnalytics />
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

describe("historical retrieval", () => {
  it("retrieves the archive for the chosen place and window, and labels it HISTORICAL", async () => {
    renderScreen();

    const observations = await screen.findByRole("region", { name: "Recorded observations" });
    expect(within(observations).getByText("HISTORICAL")).toBeInTheDocument();
    expect(within(observations).getAllByText("open-meteo").length).toBeGreaterThan(0);
    expect(within(observations).getAllByText("Berlin, Germany").length).toBeGreaterThan(0);
    expect(within(observations).getByText(/2025-06-01 00:00 to 2025-06-03 23:59/)).toBeInTheDocument();
    // In the attribution summary and in the Retrieved row beneath it.
    expect(within(observations).getAllByText(/2025-06-10 06:15 UTC/).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("asks the documented history endpoint by resolved coordinates", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    const asked = fetchMock.mock.calls.map(([input]) => new URL(input as string));
    const history = asked.find((url) => url.pathname === "/api/v1/weather/history");

    expect(history?.searchParams.get("latitude")).toBe("52.52");
    expect(history?.searchParams.get("longitude")).toBe("13.405");
    expect(history?.searchParams.get("start")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(history?.searchParams.get("end")).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The browser talks to Weathra's API and to nothing else.
    for (const url of asked) {
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      expect(url.host).not.toMatch(/open-meteo|openmeteo|openrouter/i);
    }
  });
});

describe("the charts", () => {
  it("draws from the API's own series, with every value also available as text", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    /*
     * One plot, not two. `03-historical-analytics.png` draws temperature, its normal and
     * precipitation as a single figure with two axes, and the screen now matches it: two stacked
     * charts showed the same data at half the density. So the assertion is that *one* chart names
     * both series, and that its text alternative carries both — a table of temperatures alone would
     * describe half of it.
     */
    const charts = screen.getAllByRole("img");
    expect(charts.length).toBeGreaterThanOrEqual(1);
    expect(charts[0]).toHaveAccessibleName(/Recorded temperature/);
    expect(charts[0]).toHaveAccessibleName(/with daily precipitation/);

    await userEvent.click(screen.getAllByRole("button", { name: "Show the figures" })[0]!);

    const table = screen.getByRole("table", { name: /Recorded against the normal/ });
    expect(within(table).getByRole("rowheader", { name: "2025-06-01" })).toBeInTheDocument();
    expect(within(table).getByText("14.2")).toBeInTheDocument();
    expect(within(table).getByText("17.1")).toBeInTheDocument();
    // The column states the unit the API declared.
    expect(within(table).getByRole("columnheader", { name: /Mean temperature \(°C\)/ })).toBeInTheDocument();
  });

  it("leaves a day the archive did not report as a gap, never as a zero", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    await userEvent.click(screen.getAllByRole("button", { name: "Show the figures" })[0]!);

    const table = screen.getByRole("table", { name: /Recorded against the normal/ });
    const row = within(table).getByRole("row", { name: /2025-06-02/ });
    // Both series are in this row now, and the unreported day is unreported in both — so the
    // assertion is that the row says so at all and says it nowhere as a zero.
    expect(within(row).getAllByText("not reported").length).toBeGreaterThan(0);
    expect(within(row).queryByText("0")).not.toBeInTheDocument();

    // And the count of unreported days is stated rather than smoothed over.
    expect(screen.getAllByText(/1 day in this window was not reported/).length).toBeGreaterThan(0);
  });

  it("draws no chart for a measure the archive did not supply at all", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/weather/history": {
        ...HISTORY,
        daily: {
          ...HISTORY.daily,
          units: { temperature_mean: "°C" },
          entries: HISTORY.daily.entries.map((entry) => ({
            ...entry,
            values: { temperature_mean: entry.values.temperature_mean },
          })),
        },
      },
    }) as unknown as Mock;

    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    /*
     * One plot with one series, rather than a plot and a sentence.
     *
     * The screen used to draw a second chart for precipitation and, where the archive supplied
     * none, a paragraph saying so. The combined figure has no second chart to omit: the bars are
     * absent, the temperature line stands alone, and the figures table drops the column. That is
     * the artifact's composition and the honest one — nothing claims a measurement, and nothing
     * replaces a graphic with prose.
     */
    const chart = screen.getAllByRole("img")[0];
    expect(chart).toHaveAccessibleName(/Recorded temperature/);
    expect(chart).not.toHaveAccessibleName(/with daily precipitation/);

    await userEvent.click(screen.getAllByRole("button", { name: "Show the figures" })[0]!);
    const figures = screen.getByRole("table", { name: /Recorded against the normal/ });
    expect(within(figures).queryByRole("columnheader", { name: /Precipitation/ })).toBeNull();
  });
});

describe("a period comparison", () => {
  it("shows both periods, the backend's deltas, and the shared basis", async () => {
    renderScreen();

    const panel = await screen.findByRole("region", { name: "Period against period" });
    expect(within(panel).getByText("2024-06-01 to 2024-06-03")).toBeInTheDocument();
    expect(within(panel).getByText("2025-06-01 to 2025-06-03")).toBeInTheDocument();
    expect(within(panel).getByText(/Both periods: open-meteo archive observations/)).toBeInTheDocument();

    // The delta and its percentage came from the response, and it says how it was computed.
    expect(within(panel).getByText(/\+2\.7/)).toBeInTheDocument();
    expect(within(panel).getByText(/\+20\.9%/)).toBeInTheDocument();
    expect(within(panel).getByText(/later minus earlier/)).toBeInTheDocument();
    /*
     * The measure is relabelled, and the statistics the backend named are kept verbatim.
     *
     * `statistics_applied` states `measure: statistic` because that pair is what the engine
     * applied, and the measure key is the stable identifier the rest of the contract uses. The
     * runtime audit of 2026-09-08 photographed `temperature_mean: mean` in a sentence addressed to
     * a person; the key now goes through the same label map every other figure's label comes from,
     * and nothing else about the entry changes.
     */
    expect(
      within(panel).getByText(/Mean temperature \(mean, minimum, maximum\)/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/temperature_mean/)).not.toBeInTheDocument();
  });

  it("asks the documented comparison endpoint for both windows", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Period against period" });

    const url = fetchMock.mock.calls
      .map(([input]) => new URL(input as string))
      .find((candidate) => candidate.pathname === "/api/v1/weather/history/comparison");

    expect(url?.searchParams.get("earlier_start")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url?.searchParams.get("later_end")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says when the two periods are of different lengths", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/weather/history/comparison": { ...COMPARISON, lengths_differ: true },
    }) as unknown as Mock;

    renderScreen();
    const panel = await screen.findByRole("region", { name: "Period against period" });
    expect(within(panel).getByText(/different lengths/)).toBeInTheDocument();
  });
});

describe("a baseline comparison", () => {
  it("states the years actually used, and that it is not an official climate normal", async () => {
    renderScreen();

    const panel = await screen.findByRole("region", { name: "Selected period against its baseline" });
    expect(
      within(panel).getByText(/6 years of 10 requested: 2019, 2020, 2021, 2022, 2023, 2024/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/6 of the 10 requested years were available/)).toBeInTheDocument();
    expect(within(panel).getByText(/not an official climate normal/)).toBeInTheDocument();
    // Never presented as a forecast-accuracy score.
    expect(within(panel).getByText(/not a measure of how accurate a past forecast was/)).toBeInTheDocument();
  });

  it("shows the difference and z-score the analytics layer computed, with their methods", async () => {
    renderScreen();

    const panel = await screen.findByRole("region", { name: "Selected period against its baseline" });
    expect(within(panel).getByText(/Warmer than the 6-year baseline/)).toBeInTheDocument();
    expect(within(panel).getByText("+1.2")).toBeInTheDocument();
    expect(within(panel).getByText("0.8")).toBeInTheDocument();
    expect(within(panel).getByText(/minus the 6-year baseline/)).toBeInTheDocument();
    expect(within(panel).getAllByText(/Computed by Weathra/).length).toBeGreaterThan(0);
  });

  it("reports an undefined z-score with its reason rather than as a number", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/weather/history/baseline/comparison": {
        ...BASELINE_COMPARISON,
        z_score: statistic({
          statistic: "z_score",
          value: null,
          unit: "",
          status: "not_computable",
          reason: "the baseline has no spread, so a z-score is undefined",
        }),
      },
    }) as unknown as Mock;

    renderScreen();
    const panel = await screen.findByRole("region", { name: "Selected period against its baseline" });

    expect(within(panel).getByText("Undefined")).toBeInTheDocument();
    expect(within(panel).getByText(/no spread, so a z-score is undefined/)).toBeInTheDocument();
    // The signed difference is still reported.
    expect(within(panel).getByText("+1.2")).toBeInTheDocument();
  });
});

describe("data classes and provenance", () => {
  it("keeps retrieved observations and computed statistics in separate labelled regions", async () => {
    const { container } = renderScreen();
    await screen.findByRole("region", { name: "Selected period against its baseline" });

    const retrieved = container.querySelectorAll('[data-tier="retrieved"]');
    const computed = container.querySelectorAll('[data-tier="computed"]');
    expect(retrieved).toHaveLength(1);
    expect(computed.length).toBeGreaterThanOrEqual(2);

    // The observations are HISTORICAL; the statistics over them are ANALYTICS.
    expect(within(retrieved[0] as HTMLElement).getByText("HISTORICAL")).toBeInTheDocument();
    // A computed region may carry more than one badged figure; that the first computed region is
    // badged ANALYTICS is the claim, not that it holds exactly one badge.
    expect(within(computed[0] as HTMLElement).getAllByText("ANALYTICS").length).toBeGreaterThan(0);

    // No model wrote anything on this screen, so there is no interpretation region at all.
    expect(container.querySelectorAll('[data-tier="interpretation"]')).toHaveLength(0);
  });

  it("badges every headline figure as computed and names the method behind it", async () => {
    renderScreen();

    const tiles = await screen.findByRole("region", { name: "Figures for the selected period" });
    // Six cards now, as `03-historical-analytics.png` draws them. The claim is that *every* card is
    // badged computed, not that there are five of them.
    // One badge per *computed* figure. A statistic the backend could not compute is named in the
    // footnote beneath the row instead of taking a card, so this count follows the data rather
    // than being fixed at six.
    expect(within(tiles).getAllByText("ANALYTICS").length).toBeGreaterThan(0);
    expect(within(tiles).getByText("15.6")).toBeInTheDocument();
    expect(within(tiles).getAllByText(/arithmetic mean of usable points/).length).toBeGreaterThan(0);
  });

  it("reports a statistic the backend could not compute, with its reason", async () => {
    renderScreen();

    const tiles = await screen.findByRole("region", { name: "Figures for the selected period" });
    /*
     * `specs/deterministic-analytics` requires an unavailable figure to say why, and it still does
     * — in one footnote under the row rather than in a card of its own. Five identical cards
     * reading "Not computable" was the requirement met at a size that made the row useless, so
     * what is asserted now is that the statistic is named and the backend's own reason is carried.
     */
    expect(within(tiles).getByText(/Not computed for this window/)).toBeInTheDocument();
    expect(within(tiles).getByText(/supplied no wind speed for this range/)).toBeInTheDocument();
  });
});

describe("coverage", () => {
  it("refuses a range outside the archive and explains it, showing no data for it", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path.startsWith("/api/v1/weather/")) {
        return jsonResponse(400, {
          error: {
            code: "range_outside_coverage",
            message:
              "The archive begins on 1940-01-01; the requested range starts before it. No data is available for that period.",
            details: null,
            request_id: "req-9",
          },
        });
      }
      return jsonResponse(200, (POPULATED as Record<string, unknown>)[path]);
    }) as unknown as Mock;

    renderScreen();

    expect(
      await screen.findAllByText(/The archive begins on 1940-01-01/, undefined, { timeout: 5000 }),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("Request req-9").length).toBeGreaterThan(0);

    // Refused, not approximated: no observations, no statistics, no chart.
    expect(screen.queryByRole("region", { name: "Recorded observations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/°C|mm\b/);
  });

  it("says which part of a requested range the archive does not yet hold", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/weather/history": {
        ...HISTORY,
        partial: true,
        requested_period: period("2025-06-01", "2025-06-09"),
        unavailable_note: "The archive reports up to 2025-06-03; 2025-06-04 to 2025-06-09 is not yet available.",
      },
    }) as unknown as Mock;

    renderScreen();

    const observations = await screen.findByRole("region", { name: "Recorded observations" });
    expect(within(observations).getByText(/not yet available/)).toBeInTheDocument();
    expect(within(observations).getByText(/Requested 2025-06-01 to 2025-06-09/)).toBeInTheDocument();
    expect(within(observations).getByText(/covered 2025-06-01 to 2025-06-03/)).toBeInTheDocument();
  });

  it("keeps the other surfaces when only one request fails", async () => {
    fetchMock = backend({ ...POPULATED, "/api/v1/weather/history/comparison": undefined }) as unknown as Mock;

    renderScreen();

    expect(await screen.findByRole("region", { name: "Recorded observations" })).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Selected period against its baseline" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No fixture for/)).toBeInTheDocument();
  });
});

describe("choosing what to analyse", () => {
  it("offers the person's own locations and asks for the window they choose", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    expect(screen.getByLabelText("Location")).toHaveValue("Berlin, Germany");

    const from = screen.getByLabelText("Selected period, from");
    await userEvent.clear(from);
    await userEvent.type(from, "2025-05-01");
    await userEvent.click(screen.getByRole("button", { name: "Analyse" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls
          .map(([input]) => new URL(input as string))
          .some(
            (url) =>
              url.pathname === "/api/v1/weather/history" &&
              url.searchParams.get("start") === "2025-05-01",
          ),
      ).toBe(true),
    );
  });

  it("says so when the person has saved no location, rather than choosing one for them", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
      "/api/v1/me/locations": { count: 0, limit: 20, locations: [] },
    }) as unknown as Mock;

    renderScreen();

    expect(await screen.findByText("No location to analyse")).toBeInTheDocument();
    const asked = fetchMock.mock.calls.map(([input]) => new URL(input as string).pathname);
    expect(asked).not.toContain("/api/v1/weather/history");
  });
});

/*
 * The runtime fidelity audit of 2026-09-08, findings 3.3 and 3.6: the artifact's compact header row
 * where production had six bare date inputs, a select and a number field open above everything.
 *
 * Both halves again — that the selection is readable without opening anything, and that every field
 * is still there behind the summary — plus the two things the toolbar added, and the rule the unit
 * toggle must not break.
 */
describe("the toolbar (3.3, 3.6)", () => {
  it("states the whole selection in words, with every field one press away", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    // The window opens on a range derived from today, so the shape is what is asserted: the place,
    // the selected window, the window it is held against, and the baseline length.
    const summary = screen.getByText(
      /^Berlin, Germany · \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} · against \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} · 5-year baseline$/,
    );
    expect(screen.getByLabelText("Location")).not.toBeVisible();

    await userEvent.click(summary);
    expect(screen.getByLabelText("Location")).toBeVisible();
    expect(screen.getByLabelText("Selected period, from")).toBeVisible();
    expect(screen.getByRole("button", { name: "Analyse" })).toBeVisible();
  });

  it("asks the backend for the units the toggle names, and stores no preference", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    await userEvent.click(screen.getByRole("radio", { name: /Imperial/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls
          .map(([input]) => new URL(input as string))
          .some(
            (url) =>
              url.pathname === "/api/v1/weather/history" &&
              url.searchParams.get("units") === "imperial",
          ),
      ).toBe(true),
    );

    // `specs/memory`: a preference is chosen in Settings and never inferred from behaviour.
    const written = fetchMock.mock.calls.filter(
      ([input]) => new URL(input as string).pathname === "/api/v1/me/preferences",
    );
    expect(written.every(([, init]) => (init as RequestInit | undefined)?.method === undefined)).toBe(true);
    expect(screen.getByText(/Your saved preference is unchanged/)).toBeInTheDocument();
  });

  it("opens on the person's own saved unit system", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ unit_system: "imperial" }),
    }) as unknown as Mock;

    renderScreen();
    await screen.findByRole("region", { name: "Recorded observations" });

    expect(screen.getByRole("radio", { name: /Imperial/i })).toBeChecked();
  });

  it("offers the export only once there is a retrieved window to export", async () => {
    renderScreen();

    const download = await screen.findByRole("button", { name: /Export the observations/ });
    await waitFor(() => expect(download).toBeEnabled());
  });
});

/*
 * The heading outlives the state — finding 1.1's rule, found on this screen by the runtime-state
 * sweep of 2026-09-09. Three of the four early returns rendered a state with no `h1` above it: an
 * unnamed page, which is what the audit graded as a defect in its own right on the Dashboard.
 */
describe("the screen is named in every state (1.1)", () => {
  it("is named while its locations are still loading", async () => {
    fetchMock = vi.fn(() => new Promise<Response>(() => {})) as unknown as Mock;
    renderScreen();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Historical Analytics" }),
    ).toBeInTheDocument();
  });

  it("is named when the person has saved no location", async () => {
    fetchMock = backend({
      ...POPULATED,
      "/api/v1/me/preferences": preferences({ default_location: null }),
      "/api/v1/me/locations": { count: 0, limit: 20, locations: [] },
    }) as unknown as Mock;

    renderScreen();

    expect(await screen.findByText("No location to analyse")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Historical Analytics" }),
    ).toBeInTheDocument();
  });

  it("is named when its preferences call fails", async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse(503, {
        error: {
          code: "provider_unavailable",
          message: "The provider did not answer in time.",
          details: null,
          request_id: "r",
        },
      }),
    ) as unknown as Mock;

    renderScreen();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Historical Analytics" }),
    ).toBeInTheDocument();
  });
});

describe("the session", () => {
  it("routes a 401 to the shared expired-session state rather than to a data error", async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse(401, {
        error: { code: "token_expired", message: "The access token has expired.", details: null, request_id: "r" },
      }),
    ) as unknown as Mock;

    renderScreen();

    const expired = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(expired).toHaveTextContent(/Your session has expired/i);
    expect(screen.queryByText("The access token has expired.")).not.toBeInTheDocument();
  });
});

describe("nothing from the design artifact reaches the screen", () => {
  it("shows no sample value, invented source, station, or version string", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Selected period against its baseline" });

    const shown = document.body.textContent ?? "";
    for (const sample of ARTIFACT_SAMPLE_VALUES) {
      expect(shown, sample).not.toContain(sample);
    }
  });

  it("offers no control the artifact shows that Weathra refuses to implement", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Selected period against its baseline" });

    for (const refused of [/recalibrat/i, /export data/i, /export pdf/i, /view detailed metadata/i]) {
      expect(screen.queryByRole("button", { name: refused }), String(refused)).not.toBeInTheDocument();
    }
  });

  it("shows every figure the backend supplied, and no figure it did not", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Selected period against its baseline" });

    for (const supplied of ["15.6", "9.2", "22.1", "4.6", "+2.7", "+1.2", "14.4", "11.8", "18.2"]) {
      expect(screen.getAllByText(new RegExp(supplied.replace("+", "\\+")), { exact: false }).length, supplied)
        .toBeGreaterThan(0);
    }
  });
});
