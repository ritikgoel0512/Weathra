/**
 * Saved Locations — the multi-location weather workspace.
 *
 * Task 21.6's two named criteria still live here — saving a location and removing one — along with
 * the properties that make them trustworthy: that the list is the backend's, that nothing is
 * reported as saved before the backend confirmed it, that the canonical resolved place is what is
 * stored and shown, and that a refusal is shown as the backend worded it.
 *
 * What the rebuild adds is the screen's own shape. The cases that matter most:
 *
 * **One read, not one per card.** The screen before this issued a `GET /weather/current` from
 * inside each card component, so opening it cost a provider call per saved place and the comparison
 * panel could not see any of those answers. The fixture harness fails any request it has no route
 * for, which is what turns "asks for exactly one thing" into an assertion rather than a hope.
 *
 * **A place is named, never plotted.** Coordinates are internal metadata; a coordinate pair must
 * never be a card's identity.
 *
 * **A provider failure costs a card its weather, never the card.** A place vanishing from this
 * screen would read as a saved location having been lost.
 *
 * The API is driven through the real client and the real query layer inside the real session
 * boundary; only `fetch` and Supabase are replaced. Those are the two architectural boundaries this
 * screen sits between.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { SavedLocationsResponse } from "@/lib/api/schema";
import { SessionBoundary } from "@/lib/session/provider";

import { SavedLocations } from "./locations";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("Saved Locations must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/locations",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------- fixtures */

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
};


const LONDON = {
  display_name: "London",
  latitude: 51.5072,
  longitude: -0.1276,
  timezone: "Europe/London",
  region: "England",
  country: "United Kingdom",
  country_code: "GB",
};

const UNITS = {
  temperature: "°C",
  precipitation: "mm",
  relative_humidity: "%",
  wind_speed: "km/h",
};

/** One saved place's card, as the overview returns it. */
function place(
  savedId: string,
  location: unknown,
  values: Record<string, number> | null,
  extra: Record<string, unknown> = {},
) {
  return {
    saved_id: savedId,
    location,
    label: null,
    is_default: false,
    watch_count: 0,
    met_watch_count: 0,
    conditions:
      values === null
        ? null
        : {
            values,
            units: UNITS,
            observed_at: "2026-09-13T12:00:00+02:00",
            provider: "open-meteo",
            retrieved_at: "2026-09-13T12:00:00Z",
          },
    unavailable: values === null ? "open-meteo did not respond in time." : null,
    ...extra,
  };
}

function overview(places: unknown[], extra: Record<string, unknown> = {}) {
  return {
    summary: {
      saved_count: places.length,
      limit: 20,
      remaining: 20 - places.length,
      country_count: places.length,
      timezone_count: places.length,
    },
    places,
    comparison: null,
    attention: [],
    unit_system: "metric",
    ...extra,
  };
}

const BERLIN_READING = {
  temperature: 21.1,
  precipitation: 0,
  relative_humidity: 64,
  wind_speed: 22.5,
  weather_code: 3,
};
const LONDON_READING = {
  temperature: 18.4,
  precipitation: 0.2,
  relative_humidity: 81,
  wind_speed: 13,
  weather_code: 3,
};

const ONE = overview([place("s-london", LONDON, LONDON_READING)]);

const TWO = overview([place("s-london", LONDON, LONDON_READING), place("s-berlin", BERLIN, BERLIN_READING)], {
  comparison: {
    compared: 2,
    warmest: { saved_id: "s-berlin", name: "Berlin", value: 21.1, unit: "°C" },
    coolest: { saved_id: "s-london", name: "London", value: 18.4, unit: "°C" },
    temperature_spread: 2.7,
    temperature_unit: "°C",
    wettest: { saved_id: "s-london", name: "London", value: 0.2, unit: "mm" },
    windiest: { saved_id: "s-berlin", name: "Berlin", value: 22.5, unit: "km/h" },
    reporting_precipitation: 1,
  },
});

const EMPTY = overview([]);

/** The plain listing, still served because the add flow re-reads it. */
const SAVED_TWO: SavedLocationsResponse = {
  count: 2,
  limit: 20,
  locations: [
    { id: "s-london", location: LONDON, label: null },
    { id: "s-berlin", location: BERLIN, label: null },
  ],
};

/** Task 21.7: a name is resolved through the one geocoder before anything is saved. */
function resolved(query: string, location: unknown) {
  return { kind: "resolved", query, location };
}

/** Values the design artifact shows. None of it is data, and none may reach the screen. */
const ARTIFACT_SAMPLE_VALUES = [
  "WX-LOC-772",
  "NODE-WX-ALPHA-09",
  "Add New Node",
  "Node Comparison",
  "Atmospheric Attention",
  "Grounding Precision",
  "Dr. Aris Thorne",
  "STABLE_REL_4.8",
  "COMPLIANCE_LOCK",
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

function error(code: string, message: string) {
  return { error: { code, message, details: null, request_id: "req-1" } };
}

/** One request handler per method-and-path, so a screen asking for anything else fails loudly. */
function backend(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(input).pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return jsonResponse(404, error("not_found", `No fixture for ${method} ${path}`));
    }
    return handler();
  }) as unknown as Mock;
}

function renderScreen() {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "t"}
      fetch={(input, init) => fetchMock(input, init)}
    >
      <SavedLocations />
    </SessionBoundary>,
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  fetchMock = backend({
    "GET /api/v1/me/locations/overview": () => jsonResponse(200, TWO),
    "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_TWO),
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

/**
 * The rendered place cards, once they exist.
 *
 * Not `findAllByRole("listitem")`: the loading state is a list of skeletons at the card's own size,
 * so that query resolves against the skeletons and finds no weather. Waiting for the card's own
 * primary action is waiting for the readings to have arrived.
 */
async function placeCards(): Promise<HTMLElement[]> {
  const actions = await screen.findAllByRole("button", { name: "View analytics" });
  return actions.map((action) => {
    const card = action.closest("li");
    if (card === null) throw new Error("a place card's action is not inside its card");
    return card;
  });
}

describe("the workspace", () => {
  it("draws one weather card per saved place, named rather than plotted", async () => {
    renderScreen();

    const named = await placeCards();
    expect(named).toHaveLength(2);

    expect(named[0]).toHaveTextContent("London");
    expect(named[0]).toHaveTextContent("England, United Kingdom");
    expect(named[0]).toHaveTextContent("18.4°C");
    expect(named[0]).toHaveTextContent("Overcast");
    expect(named[0]).toHaveTextContent("0.2 mm");
    expect(named[0]).toHaveTextContent("81 %");
    expect(named[0]).toHaveTextContent("13 km/h");
    expect(named[1]).toHaveTextContent("Berlin");
  });

  it("never uses a coordinate pair as a place's name", async () => {
    const { container } = renderScreen();
    await screen.findByRole("heading", { name: "Saved Locations" });

    // Two four-decimal numbers separated by a comma is what a coordinate label looks like. It was
    // the identity on the old card and is internal metadata on this one.
    expect(container.textContent ?? "").not.toMatch(/-?\d{1,3}\.\d{4}, ?-?\d{1,3}\.\d{4}/);
  });

  it("reads the whole screen once, rather than a provider call per card", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "Saved Locations" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const paths = (fetchMock.mock.calls as [string, RequestInit?][]).map(
      ([input]) => new URL(input).pathname,
    );
    expect(paths).toContain("/api/v1/me/locations/overview");
    // The screen this replaces asked `/weather/current` once per saved place, from inside the card.
    expect(paths.filter((path) => path.startsWith("/api/v1/weather"))).toEqual([]);
    expect(paths.filter((path) => path === "/api/v1/me/locations/overview")).toHaveLength(1);

    const first = (fetchMock.mock.calls as [string, RequestInit?][])[0]!;
    expect((first[1]?.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("computes the overview and the comparison from the readings the backend returned", async () => {
    renderScreen();
    const overview = await screen.findByRole("region", { name: "Multi-location overview" });

    expect(within(overview).getByText("Warmest")).toBeInTheDocument();
    // Named in both the warmest and the coolest facts' neighbourhood, so scope to the one fact.
    expect(within(overview).getAllByText("Berlin").length).toBeGreaterThan(0);
    expect(within(overview).getByText("Temperature spread")).toBeInTheDocument();
    expect(within(overview).getByText("2.7 °C")).toBeInTheDocument();

    const comparison = await screen.findByRole("region", { name: "Location comparison" });
    // Warmest first, both temperatures, and the difference between them.
    const rows = within(comparison).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Berlin");
    expect(rows[0]).toHaveTextContent("21.1 °C");
    expect(rows[1]).toHaveTextContent("London");
    expect(within(comparison).getByText("Temperature difference")).toBeInTheDocument();
  });

  it("stays useful with one saved place, and says what a second would add", async () => {
    fetchMock = backend({ "GET /api/v1/me/locations/overview": () => jsonResponse(200, ONE) });
    renderScreen();

    const overview = await screen.findByRole("region", { name: "Multi-location overview" });
    // Facts about the one place, rather than a blank intelligence panel.
    expect(within(overview).getByText("Current temperature")).toBeInTheDocument();
    expect(within(overview).getByText(/18.4/)).toBeInTheDocument();
    expect(within(overview).getByText(/Save another location to unlock/)).toBeInTheDocument();

    const comparison = screen.getByRole("region", { name: "Location comparison" });
    expect(within(comparison).getByText(/Save another location to compare/)).toBeInTheDocument();
    expect(within(comparison).getByRole("button", { name: "Open Compare Cities" })).toBeInTheDocument();
  });

  it("filters the saved places without asking the backend for anything", async () => {
    renderScreen();
    await screen.findAllByRole("listitem");
    const before = fetchMock.mock.calls.length;

    await userEvent.type(screen.getByLabelText("Search saved locations"), "berl");

    await waitFor(async () => expect(await placeCards()).toHaveLength(1));
    expect((await placeCards())[0]!).toHaveTextContent("Berlin");
    // A filter over what is saved, never a geocoder.
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("keeps a place whose weather could not be retrieved, and says which it is", async () => {
    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () =>
        jsonResponse(200, overview([place("s-london", LONDON, null)])),
    });
    renderScreen();

    // The card survives: a provider outage is not a saved location disappearing.
    const card = (await placeCards())[0]!;
    expect(card).toHaveTextContent("London");
    expect(within(card).getByText(/Weather unavailable/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("draws the attention strip only when a place genuinely wants attention", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "Saved Locations" });
    expect(
      screen.queryByRole("list", { name: "Saved locations wanting attention" }),
    ).not.toBeInTheDocument();

    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () =>
        jsonResponse(
          200,
          overview([place("s-london", LONDON, LONDON_READING, { watch_count: 1, met_watch_count: 1 })], {
            attention: [
              {
                kind: "watch_met",
                saved_id: "s-london",
                name: "London",
                detail: "1 of your 1 watch here is currently met.",
              },
            ],
          }),
        ),
    });
    renderScreen();

    const strip = await screen.findByRole("list", { name: "Saved locations wanting attention" });
    expect(within(strip).getByText(/currently met/)).toBeInTheDocument();
  });

  it("shows a real Weather Watch count on the place it belongs to", async () => {
    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () =>
        jsonResponse(
          200,
          overview([
            place("s-london", LONDON, LONDON_READING, { watch_count: 2, met_watch_count: 0 }),
            place("s-berlin", BERLIN, BERLIN_READING),
          ]),
        ),
    });
    renderScreen();

    const cards = await placeCards();
    expect(cards[0]!).toHaveTextContent("2 watches");
    expect(cards[1]!).not.toHaveTextContent("watch");
  });

  it("demotes the allowance to a strip that still states every figure", async () => {
    renderScreen();
    const usage = await screen.findByRole("region", { name: "Saved location usage" });

    expect(within(usage).getByText("2 / 20")).toBeInTheDocument();
    expect(within(usage).getByText("Remaining")).toBeInTheDocument();
    expect(within(usage).getByText("18")).toBeInTheDocument();
    expect(within(usage).getByText("Countries")).toBeInTheDocument();
    expect(within(usage).getByText("Time zones")).toBeInTheDocument();
  });

  it("offers the first save as the screen's subject when nothing is saved", async () => {
    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () => jsonResponse(200, EMPTY),
      "GET /api/v1/me/locations": () =>
        jsonResponse(200, { count: 0, limit: 20, locations: [] }),
    });
    renderScreen();

    expect(await screen.findByText("Save your first location")).toBeInTheDocument();
    // No empty weather cards and no statistics standing in for content.
    expect(screen.queryByRole("region", { name: "Location comparison" })).not.toBeInTheDocument();
  });

  it("claims none of the artifact's invented apparatus", async () => {
    const { container } = renderScreen();
    await screen.findByRole("heading", { name: "Saved Locations" });
    const text = container.textContent ?? "";

    for (const invented of ARTIFACT_SAMPLE_VALUES) {
      expect(text, `the screen mentions ${invented}`).not.toContain(invented);
    }
    for (const invented of ["Telemetry", "Sensor Calibration", "Model Consensus", "Workspace ID"]) {
      expect(text).not.toContain(invented);
    }
  });
});

describe("adding a location", () => {
  it("resolves the name and saves the canonical place, then re-reads the workspace", async () => {
    let saved = false;
    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () => jsonResponse(200, saved ? TWO : ONE),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, resolved("Berlin", BERLIN)),
      "POST /api/v1/me/locations": () => {
        saved = true;
        return jsonResponse(201, { id: "s-berlin", location: BERLIN, label: null });
      },
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_TWO),
    });
    renderScreen();

    await userEvent.click(await screen.findByRole("button", { name: "Add location" }));
    await userEvent.type(await screen.findByLabelText(/place/i), "Berlin");
    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit?][]).some(
          ([input, init]) =>
            new URL(input).pathname === "/api/v1/me/locations" &&
            (init?.method ?? "GET").toUpperCase() === "POST",
        ),
      ).toBe(true),
    );

    // The name *and* the coordinates: the name for identity, the pair to say which candidate.
    const [, init] = (fetchMock.mock.calls as [string, RequestInit?][]).find(
      ([input, request]) =>
        new URL(input).pathname === "/api/v1/me/locations" &&
        (request?.method ?? "GET").toUpperCase() === "POST",
    )!;
    const body = JSON.parse(String(init?.body));
    expect(body.location).toBe("Berlin");
    expect(body.latitude).toBe(BERLIN.latitude);
  });
});

describe("removing a location", () => {
  it("deletes it through the documented endpoint and re-reads the workspace", async () => {
    let removed = false;
    fetchMock = backend({
      "GET /api/v1/me/locations/overview": () => jsonResponse(200, removed ? ONE : TWO),
      "DELETE /api/v1/me/locations/s-berlin": () => {
        removed = true;
        return jsonResponse(204, null);
      },
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_TWO),
    });
    renderScreen();

    const cards = await placeCards();
    await userEvent.click(within(cards[1]!).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit?][]).some(
          ([input, init]) =>
            new URL(input).pathname === "/api/v1/me/locations/s-berlin" &&
            (init?.method ?? "GET").toUpperCase() === "DELETE",
        ),
      ).toBe(true),
    );
  });
});
