/**
 * Saved Locations — task 21.6's verification.
 *
 * Two of the task's named criteria live here — saving a location and removing one — along with the
 * properties that make them trustworthy: that the list is the backend's, that nothing is reported
 * as saved before the backend confirmed it, that the canonical resolved place is what is stored and
 * shown, and that a refusal is shown as the backend worded it.
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

const TOKYO = {
  display_name: "Tokyo",
  latitude: 35.6895,
  longitude: 139.6917,
  timezone: "Asia/Tokyo",
  region: "Tokyo",
  country: "Japan",
  country_code: "JP",
};

const SAVED_ONE: SavedLocationsResponse = {
  count: 1,
  limit: 20,
  locations: [{ id: "s-berlin", location: BERLIN, label: null }],
};

const SAVED_TWO: SavedLocationsResponse = {
  count: 2,
  limit: 20,
  locations: [
    { id: "s-berlin", location: BERLIN, label: null },
    { id: "s-tokyo", location: TOKYO, label: "Office" },
  ],
};

const EMPTY: SavedLocationsResponse = { count: 0, limit: 20, locations: [] };

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
  fetchMock = backend({ "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_TWO) });
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("the saved list", () => {
  it("renders the places the backend holds, with their canonical resolved data", async () => {
    renderScreen();

    const list = await screen.findByRole("region", { name: "Your saved locations" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);

    expect(cards[0]).toHaveAttribute("data-saved-location", "s-berlin");
    expect(cards[0]).toHaveTextContent("Berlin, Germany");
    expect(cards[0]).toHaveTextContent("52.5200, 13.4050");
    expect(cards[0]).toHaveTextContent("Europe/Berlin");

    // A person's own label leads, with the canonical name still shown beneath it.
    expect(cards[1]).toHaveTextContent("Office");
    // Under a label, the place is named for a person: "Tokyo, Japan", not the geocoder's
    // round-trip form.
    expect(cards[1]).toHaveTextContent("Tokyo, Japan");

    expect(within(list).getByText("2 of 20")).toBeInTheDocument();
  });

  it("asks the documented endpoint, authenticated, and talks to nothing else", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(input);
    expect(url.origin).toBe("http://backend.test");
    expect(url.pathname).toBe("/api/v1/me/locations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");

    for (const [called] of fetchMock.mock.calls as [string][]) {
      expect(new URL(called).host).not.toMatch(/open-meteo|supabase|openrouter/i);
    }
  });

  it("says the list is empty rather than showing an empty grid as an answer", async () => {
    fetchMock = backend({ "GET /api/v1/me/locations": () => jsonResponse(200, EMPTY) });
    renderScreen();

    expect(await screen.findByText("You have not saved any locations yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your saved locations" })).toBeNull();
  });

  it("narrows the list with the filter without asking the backend for anything", async () => {
    const person = userEvent.setup();
    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    const before = fetchMock.mock.calls.length;
    await person.type(screen.getByLabelText("Filter these locations"), "japan");

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Your saved locations" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );
    expect(screen.getByText("Office")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("announces its loading state, and offers a retry when the read fails", async () => {
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(500, error("internal_error", "Weathra could not read your locations.")),
    });
    renderScreen();

    const failure = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(failure).toHaveTextContent("Your saved locations could not be loaded");
    expect(failure).toHaveTextContent("Weathra could not read your locations.");
    expect(within(failure).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("adding a location", () => {
  it("sends the name to the documented endpoint and re-reads the list the backend now holds", async () => {
    const person = userEvent.setup();
    let listing = SAVED_ONE;
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, listing),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, resolved("Tokyo", TOKYO)),
      "POST /api/v1/me/locations": () => {
        listing = SAVED_TWO;
        return jsonResponse(201, { id: "s-tokyo", location: TOKYO, label: "Office", created_now: true });
      },
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    await person.type(screen.getByLabelText("Place"), "Tokyo");
    await person.type(screen.getByLabelText("Your name for it (optional)"), "Office");
    await person.click(screen.getByRole("button", { name: "Save location" }));

    // Task 21.7: the name is resolved first, and what is saved is the *resolved* place — the
    // coordinates the backend returned, and the canonical name it returned with them. Never the
    // text the person typed: `location` here is the resolution's own `display_name`, and the
    // coordinates are what choose between that name's candidates server-side.
    //
    // The coordinates alone were what this used to send, and `specs/memory` requires a saved
    // location to list "its canonical name" — which coordinates cannot produce, because
    // Open-Meteo has no reverse geocoding. A saved Munich read "48.1374, 11.5755".
    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([, init]) => (init?.method ?? "GET") === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        location: TOKYO.display_name,
        latitude: TOKYO.latitude,
        longitude: TOKYO.longitude,
        label: "Office",
      });
    });

    // Confirmed by the backend, and the list re-read rather than patched locally.
    expect(await screen.findByText("Saved Tokyo, Japan.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Your saved locations" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
    expect((screen.getByLabelText("Place") as HTMLInputElement).value).toBe("");
  });

  it("sends nothing for an empty name", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    expect(screen.getByRole("button", { name: "Save location" })).toBeDisabled();
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("shows the backend's refusal of the save itself, and reports nothing as saved", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, resolved("Tokyo", TOKYO)),
      "POST /api/v1/me/locations": () =>
        jsonResponse(503, error("memory_unavailable", "Weathra could not reach its own store.")),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    await person.type(screen.getByLabelText("Place"), "Tokyo");
    await person.click(screen.getByRole("button", { name: "Save location" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That location was not saved");
    expect(failure).toHaveTextContent("Weathra could not reach its own store.");
    expect(screen.queryByText(/^Saved [A-Z].*\.$/)).toBeNull();
    // The list is unchanged, and what was typed is still there to correct.
    expect(
      within(screen.getByRole("region", { name: "Your saved locations" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect((screen.getByLabelText("Place") as HTMLInputElement).value).toBe("Tokyo");
  });

  it("reports the saved-location limit as the backend states it", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, { ...SAVED_TWO, count: 20, limit: 20 }),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, resolved("Tokyo", TOKYO)),
      "POST /api/v1/me/locations": () =>
        jsonResponse(
          409,
          error("saved_location_limit_reached", "You have reached the limit of 20 saved locations."),
        ),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    expect(screen.getByText(/limit of 20 saved locations/)).toBeInTheDocument();

    await person.type(screen.getByLabelText("Place"), "Tokyo");
    await person.click(screen.getByRole("button", { name: "Save location" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("You have reached the limit of 20 saved locations.");
  });
});

describe("removing a location", () => {
  it("deletes it through the documented endpoint and re-reads the list", async () => {
    const person = userEvent.setup();
    let listing = SAVED_TWO;
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, listing),
      "DELETE /api/v1/me/locations/s-tokyo": () => {
        listing = SAVED_ONE;
        return jsonResponse(204, null);
      },
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    await person.click(screen.getByRole("button", { name: "Remove Office" }));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit][]).some(
          ([input, init]) =>
            init?.method === "DELETE" && new URL(input).pathname === "/api/v1/me/locations/s-tokyo",
        ),
      ).toBe(true),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Your saved locations" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );
    expect(screen.queryByText("Office")).toBeNull();
  });

  it("keeps the location on screen when the backend refuses to remove it", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_TWO),
      "DELETE /api/v1/me/locations/s-tokyo": () =>
        jsonResponse(404, error("record_not_found", "No saved location with that identifier.")),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await person.click(screen.getByRole("button", { name: "Remove Office" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That location was not removed");
    expect(failure).toHaveTextContent("No saved location with that identifier.");
    expect(screen.getByText("Office")).toBeInTheDocument();
  });
});

describe("the session and the artifact", () => {
  it("hands an expired session to the shared session boundary", async () => {
    fetchMock = backend({
      "GET /api/v1/me/locations": () =>
        jsonResponse(401, error("token_expired", "Your access token has expired.")),
    });
    renderScreen();

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(screen.queryByText("Your saved locations could not be loaded")).toBeNull();
    expect(screen.queryByText("Your access token has expired.")).toBeNull();
  });

  it("shows no identifier, node or persona from the artifact", async () => {
    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    const text = document.body.textContent ?? "";
    for (const sample of ARTIFACT_SAMPLE_VALUES) {
      expect(text).not.toContain(sample);
    }
  });
});

/* ------------------------------------------------------- task 21.7: ambiguity */

/**
 * An ambiguous place being saved — task 21.7.
 *
 * `specs/memory` requires a saved location to hold the canonical resolved place rather than the
 * query text, so this is the surface where a silently-picked first result would be *persisted*
 * rather than merely displayed. Nothing is saved until a candidate is pressed, and what is saved is
 * that candidate's own coordinates.
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

function posts(): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(
    ([, init]) => (init?.method ?? "GET") === "POST",
  );
}

async function typeAndSave(person: ReturnType<typeof userEvent.setup>, name: string) {
  await person.type(screen.getByLabelText("Place"), name);
  await person.click(screen.getByRole("button", { name: "Save location" }));
}

describe("saving an ambiguous place", () => {
  it("presents the candidates and saves nothing", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, AMBIGUOUS_SPRINGFIELD),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await typeAndSave(person, "Springfield");

    const chooser = await screen.findByRole("group", { name: "Places matching what you entered" });
    const candidates = within(chooser).getAllByRole("button");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent("Illinois, United States");
    expect(candidates[0]).toHaveTextContent("39.8017, -89.6437");
    expect(candidates[1]).toHaveTextContent("Missouri, United States");

    expect(screen.getByText("Which place did you mean?")).toBeInTheDocument();
    // Nothing was written, and nothing reads as saved.
    expect(posts()).toHaveLength(0);
    expect(screen.queryByText(/^Saved [A-Z].*\.$/)).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Your saved locations" })).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  it("saves only the candidate that was pressed, by its own coordinates", async () => {
    const person = userEvent.setup();
    let listing = SAVED_ONE;
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, listing),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, AMBIGUOUS_SPRINGFIELD),
      "POST /api/v1/me/locations": () => {
        listing = {
          count: 2,
          limit: 20,
          locations: [...SAVED_ONE.locations, { id: "s-mo", location: SPRINGFIELD_MO, label: null }],
        };
        return jsonResponse(201, { id: "s-mo", location: SPRINGFIELD_MO, created_now: true });
      },
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await typeAndSave(person, "Springfield");

    const chooser = await screen.findByRole("group", { name: "Places matching what you entered" });
    await person.click(within(chooser).getAllByRole("button")[1]!);

    await waitFor(() => expect(posts()).toHaveLength(1));
    // The chosen candidate's own coordinates, from the response — never the other one. The name
    // rides along, and it is the ambiguous one on purpose: "Springfield" plus *these* coordinates
    // names exactly one place server-side, which is what lets an ambiguous name be saved at all.
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      location: "Springfield",
      latitude: 37.2153,
      longitude: -93.2982,
      label: null,
    });
    expect(await screen.findByText("Saved Springfield, Missouri, United States.")).toBeInTheDocument();
  });

  it("keeps the person's own label when they choose a candidate", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () => jsonResponse(200, AMBIGUOUS_SPRINGFIELD),
      "POST /api/v1/me/locations": () =>
        jsonResponse(201, { id: "s-mo", location: SPRINGFIELD_MO, label: "Nan's", created_now: true }),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await person.type(screen.getByLabelText("Your name for it (optional)"), "Nan's");
    await typeAndSave(person, "Springfield");

    const chooser = await screen.findByRole("group", { name: "Places matching what you entered" });
    await person.click(within(chooser).getAllByRole("button")[0]!);

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      location: "Springfield",
      latitude: 39.8017,
      longitude: -89.6437,
      label: "Nan's",
    });
  });

  it("says a name matched nothing, distinctly from matching several, and saves nothing", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () =>
        jsonResponse(404, error("location_not_found", "No location matches 'Zzzzz'.")),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await typeAndSave(person, "Zzzzz");

    expect(await screen.findByText("No place matches that name")).toBeInTheDocument();
    expect(screen.getByText("No location matches 'Zzzzz'.")).toBeInTheDocument();
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("says a lookup failed, distinctly from either, and saves nothing", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () =>
        jsonResponse(500, error("internal_error", "Weathra could not reach its geocoder.")),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await typeAndSave(person, "Berlin");

    expect(await screen.findByText("That location could not be looked up")).toBeInTheDocument();
    expect(screen.getByText("Weathra could not reach its geocoder.")).toBeInTheDocument();
    expect(screen.queryByText("No place matches that name")).toBeNull();
    expect(screen.queryByText("Which place did you mean?")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("routes a 401 on the lookup to the shared expired-session state", async () => {
    const person = userEvent.setup();
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE),
      "GET /api/v1/locations/resolve": () =>
        jsonResponse(401, error("token_expired", "Your access token has expired.")),
    });

    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });
    await typeAndSave(person, "Springfield");

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});

describe("a saved place the backend could only describe by its coordinates", () => {
  /** An arbitrary point, deliberately nowhere near the fixtures' cities. */
  const UNNAMED = {
    display_name: "28.4595, 77.0266",
    latitude: 28.4595,
    longitude: 77.0266,
    timezone: "Asia/Kolkata",
  };

  const WITH_UNNAMED = {
    count: 1,
    limit: 20,
    locations: [{ id: "s-unnamed", location: UNNAMED, label: null as string | null }],
  };

  it("is not presented as though its coordinates were its name", async () => {
    fetchMock = backend({ "GET /api/v1/me/locations": () => jsonResponse(200, WITH_UNNAMED) });
    renderScreen();

    expect(await screen.findByText("Unnamed place")).toBeInTheDocument();
    // The coordinates stay on the card as metadata — under "Coordinates", where they belong.
    const card = screen.getByText("Unnamed place").closest("li");
    expect(within(card as HTMLElement).getByText(/28\.4595/)).toBeInTheDocument();
    // And not as the heading.
    expect(screen.getByText("Unnamed place").textContent).not.toMatch(/\d/);
  });

  it("offers to name it, rather than asking the person to remove and re-add it", async () => {
    const person = userEvent.setup();
    fetchMock = backend({ "GET /api/v1/me/locations": () => jsonResponse(200, WITH_UNNAMED) });
    renderScreen();
    await screen.findByText("Unnamed place");

    expect(screen.getByText(/Weathra has no name for this place\./)).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Name this place" }));
    expect(screen.getByLabelText("What is this place called?")).toBeInTheDocument();
  });

  it("repairs the row: the typed name goes with the stored coordinates, so the place is re-resolved", async () => {
    const person = userEvent.setup();
    let listing = WITH_UNNAMED;
    fetchMock = backend({
      "GET /api/v1/me/locations": () => jsonResponse(200, listing),
      "POST /api/v1/me/locations": () => {
        listing = {
          count: 1,
          limit: 20,
          locations: [{ id: "s-unnamed", location: UNNAMED, label: "Office" as string | null }],
        };
        return jsonResponse(201, { id: "s-unnamed", location: UNNAMED, label: "Office" });
      },
    });

    renderScreen();
    await screen.findByText("Unnamed place");
    await person.click(screen.getByRole("button", { name: "Name this place" }));
    await person.type(screen.getByLabelText("What is this place called?"), "Office");
    await person.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    /*
     * The coordinates exactly as stored — naming a place must never be able to move it — *and* the
     * typed text as the place name.
     *
     * This used to send the label alone, which left the row's stored location untouched: it got a
     * label and kept `48.1374, 11.5755` as its name underneath. Sending both makes the save a
     * repair. `resolve_for_saving` uses the name to search and the coordinates to pick the right
     * candidate, so "Munich" restores the canonical city, region and country; text that resolves to
     * nothing falls back to these coordinates and the label stands alone; and text naming a
     * different place is refused by the backend rather than silently moving the row.
     */
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      location: "Office",
      latitude: UNNAMED.latitude,
      longitude: UNNAMED.longitude,
      label: "Office",
    });
    // The list is re-read, and the place now has its name.
    expect(await screen.findByText("Office")).toBeInTheDocument();
    expect(screen.queryByText("Unnamed place")).toBeNull();
  });

  it("does not offer to name a place that already has a canonical name", async () => {
    fetchMock = backend({ "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_ONE) });
    renderScreen();
    await screen.findByRole("region", { name: "Your saved locations" });

    expect(screen.queryByRole("button", { name: "Name this place" })).toBeNull();
  });
});
