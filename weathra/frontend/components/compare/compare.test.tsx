/**
 * Compare Cities — task 21.4's verification.
 *
 * The three the task names — a three-city ranking, an excluded candidate, and a single-location
 * attempt blocked — then the ones that are honesty properties rather than behaviour: that every
 * position is backed by the analytics results behind it, that a composite score explains its own
 * weighting and says whose heuristic it is, that a tie is reported as a tie, and that no figure on
 * the screen came from anywhere but a response.
 *
 * The API is driven through the real client and the real query layer inside the real session
 * boundary; only `fetch` and Supabase are replaced.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PreferenceView } from "@/lib/api/schema";
import { SessionBoundary } from "@/lib/session/provider";

import { CompareCities } from "./compare";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("Compare Cities must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/compare",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------- fixtures */

function place(display_name: string, latitude: number, longitude: number, timezone: string) {
  return { display_name, latitude, longitude, timezone };
}

const BERLIN = place("Berlin, Germany", 52.52, 13.405, "Europe/Berlin");
const MUNICH = place("Munich, Germany", 48.14, 11.58, "Europe/Berlin");
const LISBON = place("Lisbon, Portugal", 38.72, -9.14, "Europe/Lisbon");

function period(timezone: string) {
  return {
    start_local: "2026-09-04T00:00:00+02:00",
    end_local: "2026-09-09T00:00:00+02:00",
    start_utc: "2026-09-03T22:00:00Z",
    end_utc: "2026-09-08T22:00:00Z",
    timezone,
  };
}

function statistic(overrides: Record<string, unknown> = {}) {
  return {
    statistic: "mean",
    measure: "temperature_mean",
    value: 18.4,
    unit: "°C",
    method: "arithmetic mean of usable points",
    minimum_points: 1,
    points_used: 5,
    points_excluded: 0,
    status: "computed",
    provenance: {},
    ...overrides,
  };
}

const THREE_CITY = {
  mode: "locations" as const,
  criterion: "warmest" as const,
  data_class: "forecast" as const,
  period: period("Europe/Berlin"),
  unit_system: "metric" as const,
  provider: "open-meteo",
  statistics_applied: ["temperature_mean: mean"],
  tie_tolerance: 0.1,
  local_time_basis: true,
  candidates: [
    {
      label: "Lisbon, Portugal",
      location: LISBON,
      period: period("Europe/Lisbon"),
      rank: 1,
      score: 23.7,
      supporting: [statistic({ value: 23.7 })],
    },
    {
      label: "Berlin, Germany",
      location: BERLIN,
      period: period("Europe/Berlin"),
      rank: 2,
      score: 18.4,
      supporting: [statistic({ value: 18.4 })],
    },
    {
      label: "Munich, Germany",
      location: MUNICH,
      period: period("Europe/Berlin"),
      rank: 3,
      score: 16.1,
      supporting: [statistic({ value: 16.1 })],
    },
  ],
  excluded: [],
};

const WITH_EXCLUSION = {
  ...THREE_CITY,
  candidates: THREE_CITY.candidates.slice(0, 2),
  excluded: [
    {
      label: "Reykjavik, Iceland",
      location: null,
      reason: "The provider did not return a forecast for this location within the timeout.",
      code: "provider_timeout",
    },
  ],
};

const COMPOSITE = {
  ...THREE_CITY,
  criterion: "outdoor_suitability" as const,
  weighting_disclosure:
    "The outdoor-suitability score is Weathra's own heuristic, not an authoritative index.",
  candidates: [
    {
      label: "Lisbon, Portugal",
      location: LISBON,
      period: period("Europe/Lisbon"),
      rank: 1,
      score: 0.82,
      supporting: [statistic({ value: 23.7 })],
      contributions: [
        {
          measure: "temperature_mean",
          value: 23.7,
          unit: "°C",
          direction: "above" as const,
          weight: 0.5,
          contribution: 0.45,
          supporting: statistic({ value: 23.7 }),
        },
        {
          measure: "precipitation_sum",
          value: 1.2,
          unit: "mm",
          direction: "below" as const,
          weight: 0.3,
          contribution: 0.27,
          supporting: statistic({ statistic: "total", measure: "precipitation_sum", value: 1.2, unit: "mm" }),
        },
      ],
    },
    {
      label: "Berlin, Germany",
      location: BERLIN,
      period: period("Europe/Berlin"),
      rank: 2,
      score: 0.61,
      supporting: [statistic()],
      contributions: [
        {
          measure: "temperature_mean",
          value: 18.4,
          unit: "°C",
          direction: "above" as const,
          weight: 0.5,
          contribution: 0.31,
          supporting: statistic(),
        },
      ],
    },
  ],
};

const TIED = {
  ...THREE_CITY,
  candidates: [
    { ...THREE_CITY.candidates[0]!, label: "Berlin, Germany", location: BERLIN, rank: 1, score: 18.4, tied: true },
    { ...THREE_CITY.candidates[1]!, label: "Munich, Germany", location: MUNICH, rank: 1, score: 18.45, tied: true },
  ],
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

/** Every value the design artifact shows. None of it is data, and none may reach the screen. */
const ARTIFACT_SAMPLE_VALUES = [
  "WX-CMP-9021",
  "BER-CENTRAL-09",
  "MUC-SOUTH-21",
  "96.4%",
  "88.1%",
  "2.84σ",
  "+14.2mm",
  "+1.2°C/decade",
  "WMO-NORMAL-2023",
  "WX-901-DELTA",
  "Neural Agent",
  "Dr. Aris Thorne",
  "1991-2020",
  "Forecast Delta Explorer",
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

function routes(comparison: unknown) {
  return {
    "/api/v1/me/preferences": preferences(),
    "/api/v1/me/locations": {
      count: 2,
      limit: 20,
      locations: [
        { id: "s1", location: BERLIN },
        { id: "s2", location: MUNICH },
      ],
    },
    // Task 21.7: a row is resolved through the one geocoder before it may enter a ranking. The
    // seeded rows arrive already canonical, so only a row somebody types reaches this.
    "/api/v1/locations/resolve": { kind: "resolved", query: "Lisbon", location: LISBON },
    "/api/v1/weather/comparison": comparison,
  };
}

function renderScreen() {
  return render(
    <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input, init) => fetchMock(input, init)}>
      <CompareCities />
    </SessionBoundary>,
  );
}

/** The bodies of every comparison request made, parsed. */
function comparisonBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(input as string).pathname === "/api/v1/weather/comparison")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function compare(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Compare" }));
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  fetchMock = backend(routes(THREE_CITY)) as unknown as Mock;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("entering locations", () => {
  it("seeds two rows from the person's own places and can add more", async () => {
    renderScreen();

    expect(await screen.findByLabelText("Location 1")).toHaveValue("Berlin, Germany");
    expect(screen.getByLabelText("Location 2")).toHaveValue("Munich, Germany");

    await userEvent.click(screen.getByRole("button", { name: "Add another location" }));
    expect(screen.getByLabelText("Location 3")).toHaveValue("");
  });

  it("removes a row once there are more than the two a comparison needs", async () => {
    renderScreen();
    await screen.findByLabelText("Location 1");

    // With exactly two rows there is nothing to remove: removing one would block the comparison.
    expect(screen.queryByRole("button", { name: /Remove location/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add another location" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove location 3" }));
    expect(screen.queryByLabelText("Location 3")).not.toBeInTheDocument();
  });

  it("offers every criterion the backend supports", async () => {
    renderScreen();
    const criterion = await screen.findByLabelText("Criterion");

    for (const label of ["Warmest", "Coolest", "Driest", "Wettest", "Least windy", "Best for being outdoors"]) {
      expect(within(criterion).getByRole("option", { name: label })).toBeInTheDocument();
    }
  });
});

describe("a single-location attempt", () => {
  it("is blocked in the browser, with the reason, and never reaches the backend", async () => {
    renderScreen();

    const second = await screen.findByLabelText("Location 2");
    await userEvent.clear(second);

    const blocked = screen.getByText(/A comparison needs at least two locations/);
    expect(blocked).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();

    await compare();
    expect(comparisonBodies()).toHaveLength(0);
  });

  it("is blocked when the same place is named twice", async () => {
    renderScreen();

    const second = await screen.findByLabelText("Location 2");
    await userEvent.clear(second);
    await userEvent.type(second, "berlin, germany");

    expect(screen.getByText(/listed twice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    await compare();
    expect(comparisonBodies()).toHaveLength(0);
  });

  it("unblocks as soon as a second distinct place is named", async () => {
    renderScreen();

    const second = await screen.findByLabelText("Location 2");
    await userEvent.clear(second);
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();

    await userEvent.type(second, "Lisbon");
    expect(screen.getByRole("button", { name: "Compare" })).toBeEnabled();
    expect(screen.queryByText(/at least two locations/)).not.toBeInTheDocument();
  });
});

describe("a three-city ranking", () => {
  it("posts the named places, the criterion and the window to the documented endpoint", async () => {
    renderScreen();

    await userEvent.click(await screen.findByRole("button", { name: "Add another location" }));
    await userEvent.type(screen.getByLabelText("Location 3"), "Lisbon");
    await compare();

    await waitFor(() => expect(comparisonBodies()).toHaveLength(1));
    const body = comparisonBodies()[0]!;
    // Task 21.7: the canonical name of each *resolved* place, not the text that was typed —
    // "Lisbon" was resolved to "Lisbon, Portugal" before the comparison was requested.
    expect(body.locations).toEqual(["Berlin, Germany", "Munich, Germany", "Lisbon, Portugal"]);
    expect(body.criterion).toBe("warmest");
    expect(body.days).toBe(5);

    const [url, init] = fetchMock.mock.calls.find(
      ([input]) => new URL(input as string).pathname === "/api/v1/weather/comparison",
    ) as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new URL(url).origin).toBe("http://backend.test");
  });

  it("ranks all three with their positions, figures, and the analytics behind each", async () => {
    renderScreen();
    await compare();

    const ranking = await screen.findByRole("region", { name: "Ranked by warmest" });
    const cards = within(ranking).getAllByRole("article");
    expect(cards).toHaveLength(3);

    // In the backend's rank order, each with its own measured figure.
    expect(cards[0]).toHaveTextContent("#1");
    expect(cards[0]).toHaveTextContent("Lisbon, Portugal");
    expect(cards[0]).toHaveTextContent("23.7");
    expect(cards[1]).toHaveTextContent("Berlin, Germany");
    expect(cards[2]).toHaveTextContent("Munich, Germany");

    // The values behind the score, with the method that produced them.
    expect(within(ranking).getAllByText(/arithmetic mean of usable points/).length).toBe(3);
    expect(within(ranking).getAllByText(/Computed by Weathra/).length).toBe(3);
  });

  it("states the basis every candidate shares", async () => {
    renderScreen();
    await compare();

    const basis = await screen.findByRole("region", { name: "The basis every candidate shares" });
    expect(within(basis).getByText("open-meteo")).toBeInTheDocument();
    expect(within(basis).getByText("metric")).toBeInTheDocument();
    expect(within(basis).getByText(/temperature_mean: mean/)).toBeInTheDocument();
    expect(within(basis).getByText(/each candidate's own local time/)).toBeInTheDocument();
    expect(within(basis).getByText(/Scores within 0.1 share a rank/)).toBeInTheDocument();
    // The class the figures were computed from is badged, distinct from the ranking's own.
    expect(within(basis).getByText("FORECAST")).toBeInTheDocument();
  });

  it("plots one bar per place, with every figure also available as text", async () => {
    renderScreen();
    await compare();

    const chart = await screen.findByRole("img", { name: /temperature mean by place/i });
    expect(chart).toHaveAccessibleName(/in °C, for 3 places/);

    await userEvent.click(screen.getByRole("button", { name: "Show the figures" }));
    const table = screen.getByRole("table", { name: /Temperature mean by place/i });
    expect(within(table).getByRole("rowheader", { name: "Lisbon, Portugal" })).toBeInTheDocument();
    expect(within(table).getByText("23.7")).toBeInTheDocument();
    expect(within(table).getByText("16.1")).toBeInTheDocument();
  });
});

describe("an excluded candidate", () => {
  it("is named with its reason and its code, and is not in the ranking", async () => {
    fetchMock = backend(routes(WITH_EXCLUSION)) as unknown as Mock;
    renderScreen();
    await compare();

    const excluded = await screen.findByRole("region", { name: "Locations left out of the ranking" });
    expect(within(excluded).getByText("Reykjavik, Iceland")).toBeInTheDocument();
    expect(within(excluded).getByText(/did not return a forecast for this location within the timeout/)).toBeInTheDocument();
    expect(within(excluded).getByText("provider_timeout")).toBeInTheDocument();
    expect(within(excluded).getByText(/Nothing has been estimated in their place/)).toBeInTheDocument();

    // The survivors are ranked, and the excluded place is not among them.
    const ranking = screen.getByRole("region", { name: "Ranked by warmest" });
    expect(within(ranking).getAllByRole("article")).toHaveLength(2);
    expect(within(ranking).queryByText("Reykjavik, Iceland")).not.toBeInTheDocument();
  });

  it("shows no exclusion notice when every place was scored", async () => {
    renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    expect(
      screen.queryByRole("region", { name: "Locations left out of the ranking" }),
    ).not.toBeInTheDocument();
  });
});

describe("a composite criterion", () => {
  it("explains each contributing measure, its direction and its weight", async () => {
    fetchMock = backend(routes(COMPOSITE)) as unknown as Mock;
    renderScreen();

    await userEvent.selectOptions(await screen.findByLabelText("Criterion"), "outdoor_suitability");
    await compare();

    const ranking = await screen.findByRole("region", { name: "Ranked by best for being outdoors" });
    const winner = within(ranking).getAllByRole("article")[0]!;

    expect(winner).toHaveTextContent("0.8");
    expect(within(winner).getByText(/Higher scores better · 50% of the score · added 0.45/)).toBeInTheDocument();
    expect(within(winner).getByText(/Lower scores better · 30% of the score · added 0.27/)).toBeInTheDocument();
  });

  it("says the weighting is Weathra's own heuristic", async () => {
    fetchMock = backend(routes(COMPOSITE)) as unknown as Mock;
    renderScreen();

    await userEvent.selectOptions(await screen.findByLabelText("Criterion"), "outdoor_suitability");
    await compare();

    // Stated on the ranking and again in the account of how the comparison was made — the
    // disclosure follows the score wherever the score is shown.
    expect(
      (await screen.findAllByText(/Weathra's own heuristic, not an authoritative index/)).length,
    ).toBeGreaterThan(0);
  });
});

describe("ties", () => {
  it("reports candidates that share a rank as tied rather than ordering them arbitrarily", async () => {
    fetchMock = backend(routes(TIED)) as unknown as Mock;
    renderScreen();
    await compare();

    const ranking = await screen.findByRole("region", { name: "Ranked by warmest" });
    const cards = within(ranking).getAllByRole("article");

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveTextContent("#1");
      expect(within(card).getByText("Tied")).toBeInTheDocument();
    }
  });
});

describe("data classes and failures", () => {
  it("keeps the ranking in a computed region, with no model-written region at all", async () => {
    const { container } = renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    // The screen carries several computed regions — the ranking, the figures matrix, the account of
    // how the comparison was made — and, since the delta explorer was added, retrieved ones too:
    // each place's own forecast is retrieved data and is badged as such. The claim that matters is
    // the last line, and it is the one that has never changed: **nothing here is model-written.**
    expect(container.querySelectorAll('[data-tier="computed"]').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('[data-tier="interpretation"]')).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Ranked by warmest" })).getByText("ANALYTICS")).toBeInTheDocument();
  });

  it("shows the backend's own message when a comparison is refused, and no ranking", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/weather/comparison") {
        return jsonResponse(400, {
          error: {
            code: "validation_failed",
            message:
              "'Springfield' matches more than one place: Springfield, Illinois or Springfield, Missouri. Ask again with a region or country.",
            details: null,
            request_id: "req-4",
          },
        });
      }
      return jsonResponse(200, (routes(THREE_CITY) as Record<string, unknown>)[path]);
    }) as unknown as Mock;

    renderScreen();
    await compare();

    expect(await screen.findByText(/matches more than one place/)).toBeInTheDocument();
    expect(screen.getByText("Request req-4")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Ranked by/ })).not.toBeInTheDocument();
    // A refusal is never dressed as a ranking of one.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

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

  it("says nothing has been compared before anything is asked", async () => {
    renderScreen();

    expect(await screen.findByText("Nothing compared yet")).toBeInTheDocument();
    expect(comparisonBodies()).toHaveLength(0);
  });
});

describe("nothing from the design artifact reaches the screen", () => {
  it("shows no sample value, invented station, workspace or version string", async () => {
    renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    const shown = document.body.textContent ?? "";
    for (const sample of ARTIFACT_SAMPLE_VALUES) {
      expect(shown, sample).not.toContain(sample);
    }
  });

  it("offers no control the artifact shows that Weathra refuses to implement", async () => {
    renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    for (const refused of [/recalibrate/i, /export pdf/i, /export data/i, /view agent evidence/i]) {
      expect(screen.queryByRole("button", { name: refused }), String(refused)).not.toBeInTheDocument();
    }
  });

  it("calls the documented backend API and nothing else", async () => {
    renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input as string);
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      expect(url.host).not.toMatch(/open-meteo|openmeteo|openrouter/i);
    }
  });
});

/* ------------------------------------------------------- task 21.7: ambiguity */

/**
 * An ambiguous entry on Compare Cities — task 21.7.
 *
 * The rule this asserts is stricter than "show the candidates": one unresolved row stops the whole
 * comparison. A ranking that quietly dropped the ambiguous place would answer a different question
 * from the one that was asked, and `specs/location-comparison` already forbids a ranking shorter
 * than its question without saying why.
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

/** The 21.4 harness, with the third row's lookup answering ambiguously. */
function ambiguousRoutes(comparison: unknown = THREE_CITY) {
  return { ...routes(comparison), "/api/v1/locations/resolve": AMBIGUOUS_SPRINGFIELD };
}

async function nameThirdLocation(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Add another location" }));
  await userEvent.type(screen.getByLabelText("Location 3"), name);
}

describe("an ambiguous location on Compare Cities", () => {
  it("presents that row's candidates, with the region and country the backend supplied", async () => {
    fetchMock = backend(ambiguousRoutes()) as unknown as Mock;
    renderScreen();

    await nameThirdLocation("Springfield");
    await compare();

    const chooser = await screen.findByRole("group", { name: "Places matching location 3" });
    const candidates = within(chooser).getAllByRole("button");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent("Illinois, United States");
    expect(candidates[0]).toHaveTextContent("39.8017, -89.6437");
    expect(candidates[1]).toHaveTextContent("Missouri, United States");
    expect(screen.getByText(/Weathra does not pick one for you/)).toBeInTheDocument();
  });

  it("does not compare at all while a row has not settled on one place", async () => {
    fetchMock = backend(ambiguousRoutes()) as unknown as Mock;
    renderScreen();

    await nameThirdLocation("Springfield");
    await compare();
    await screen.findByRole("group", { name: "Places matching location 3" });

    // Not a ranking of the two rows that did resolve: no comparison was requested at all.
    expect(comparisonBodies()).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Ranked by warmest" })).toBeNull();
    expect(
      screen.getByText(/One location matches more than one place. Choose which you meant/),
    ).toBeInTheDocument();
  });

  it("compares with the candidate that was pressed, by its canonical name", async () => {
    fetchMock = backend(ambiguousRoutes()) as unknown as Mock;
    renderScreen();

    await nameThirdLocation("Springfield");
    await compare();

    const chooser = await screen.findByRole("group", { name: "Places matching location 3" });
    await userEvent.click(within(chooser).getAllByRole("button")[1]!);

    // Choosing alone requests nothing: the comparison is still the person's deliberate act.
    expect(comparisonBodies()).toHaveLength(0);

    await compare();
    await waitFor(() => expect(comparisonBodies()).toHaveLength(1));
    expect(comparisonBodies()[0]!.locations).toEqual([
      "Berlin, Germany",
      "Munich, Germany",
      "Springfield, Missouri, US",
    ]);
    // Never the other candidate, and never the geocoder's first result by default.
    expect(String(comparisonBodies()[0]!.locations)).not.toContain("Illinois");
  });

  it("withdraws a ranking already on screen when a row turns ambiguous", async () => {
    // First comparison resolves; the third row is then added and comes back ambiguous.
    let resolution: unknown = { kind: "resolved", query: "Lisbon", location: LISBON };
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/locations/resolve") return jsonResponse(200, resolution);
      const body = (routes(THREE_CITY) as Record<string, unknown>)[path];
      if (body === undefined) {
        return jsonResponse(404, {
          error: { code: "not_found", message: `No fixture for ${path}`, details: null, request_id: "r" },
        });
      }
      void init;
      return jsonResponse(200, body);
    }) as unknown as Mock;

    renderScreen();
    await compare();
    await screen.findByRole("region", { name: "Ranked by warmest" });

    resolution = AMBIGUOUS_SPRINGFIELD;
    await nameThirdLocation("Springfield");
    // Editing a row already withdraws the results: they answered a different set of places.
    expect(screen.queryByRole("region", { name: "Ranked by warmest" })).toBeNull();

    await compare();
    await screen.findByRole("group", { name: "Places matching location 3" });
    expect(screen.queryByRole("region", { name: "Ranked by warmest" })).toBeNull();
  });

  it("invalidates a chosen place when its row is edited afterwards", async () => {
    fetchMock = backend(ambiguousRoutes()) as unknown as Mock;
    renderScreen();

    await nameThirdLocation("Springfield");
    await compare();
    const chooser = await screen.findByRole("group", { name: "Places matching location 3" });
    await userEvent.click(within(chooser).getAllByRole("button")[1]!);

    // The row now holds Missouri. Typing over it must not send Missouri for the new text.
    await userEvent.clear(screen.getByLabelText("Location 3"));
    await userEvent.type(screen.getByLabelText("Location 3"), "Springfield");
    await compare();

    await screen.findByRole("group", { name: "Places matching location 3" });
    expect(comparisonBodies()).toHaveLength(0);
  });

  it("resolves the two seeded rows without asking, because they are already canonical", async () => {
    fetchMock = backend(ambiguousRoutes()) as unknown as Mock;
    renderScreen();
    await screen.findByLabelText("Location 1");
    await compare();

    await waitFor(() => expect(comparisonBodies()).toHaveLength(1));
    // A saved location was resolved when it was saved; asking again could turn a place somebody
    // has into an ambiguity they must re-choose.
    const lookups = fetchMock.mock.calls.filter(
      ([input]) => new URL(input as string).pathname === "/api/v1/locations/resolve",
    );
    expect(lookups).toHaveLength(0);
  });

  it("keeps no-match and a failed lookup distinct from ambiguity, and compares neither", async () => {
    for (const [status, body, expected, unexpected] of [
      [
        404,
        { error: { code: "location_not_found", message: "No location matches 'Zzzzz'.", details: null, request_id: "r" } },
        "No place matches that name",
        "Which place did you mean?",
      ],
      [
        500,
        { error: { code: "internal_error", message: "Weathra could not reach its geocoder.", details: null, request_id: "r" } },
        "That location could not be looked up",
        "No place matches that name",
      ],
    ] as const) {
      fetchMock = vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        if (path === "/api/v1/locations/resolve") return jsonResponse(status, body);
        const found = (routes(THREE_CITY) as Record<string, unknown>)[path];
        return found === undefined
          ? jsonResponse(404, { error: { code: "not_found", message: "x", details: null, request_id: "r" } })
          : jsonResponse(200, found);
      }) as unknown as Mock;

      const view = renderScreen();
      await nameThirdLocation("Zzzzz");
      await compare();

      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(unexpected)).toBeNull();
      expect(comparisonBodies()).toHaveLength(0);
      view.unmount();
    }
  });

  it("routes a 401 on the lookup to the shared expired-session state", async () => {
    fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/locations/resolve") {
        return jsonResponse(401, {
          error: { code: "token_expired", message: "Your access token has expired.", details: null, request_id: "r" },
        });
      }
      const found = (routes(THREE_CITY) as Record<string, unknown>)[path];
      return found === undefined
        ? jsonResponse(404, { error: { code: "not_found", message: "x", details: null, request_id: "r" } })
        : jsonResponse(200, found);
    }) as unknown as Mock;

    renderScreen();
    await nameThirdLocation("Springfield");
    await compare();

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(comparisonBodies()).toHaveLength(0);
  });
});
