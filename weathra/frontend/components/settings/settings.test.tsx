/**
 * Settings — task 21.6's verification.
 *
 * The four the task names — changing units and seeing a later screen reflect it, deleting thread
 * memory with confirmation, and account data deletion with an explicit confirmation step — then the
 * properties that make each trustworthy: that a preference is persisted through the backend and not
 * relabelled locally, that nothing reads as saved before the backend has confirmed it, that the
 * three account operations stay three operations, and that Settings offers Weathra's one sign-out
 * rather than a second.
 *
 * The unit test is a real cross-screen one: Settings and the Dashboard are mounted inside one
 * session boundary — therefore one query cache, as in the running application — and what is asserted
 * is that the Dashboard *re-requests* in the new unit system and renders the units the backend then
 * sends. Nothing in the browser converts a figure, so a test that only checked a label would be
 * checking the wrong thing.
 *
 * The API is driven through the real client and the real query layer; only `fetch`, Supabase and the
 * sign-out server action are replaced. Those are the architectural boundaries — the network, the
 * browser's session, and the server.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { Dashboard } from "@/components/dashboard/dashboard";
import { SignOutForm } from "@/components/shell/sign-out-form";
import type { PreferenceView } from "@/lib/api/schema";
import { SessionBoundary } from "@/lib/session/provider";

import { Settings } from "./settings";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => {
    throw new Error("Settings must not talk to Supabase directly");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** The one sign-out flow, stubbed at the server boundary rather than replaced by another. */
const signOutAction = vi.fn(async () => {});
vi.mock("@/lib/auth/sign-out", () => ({ signOut: () => signOutAction() }));

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

function preferences(overrides: Partial<PreferenceView> = {}): PreferenceView {
  return {
    unit_system: "metric",
    forecast_horizon_days: 7,
    default_location: BERLIN,
    sources: {
      unit_system: "chosen",
      forecast_horizon_days: "default",
      default_location: "chosen",
    },
    ...overrides,
  } as PreferenceView;
}

const SAVED_LOCATIONS = {
  count: 2,
  limit: 20,
  locations: [
    { id: "s-berlin", location: BERLIN, label: null },
    { id: "s-tokyo", location: TOKYO, label: "Office" },
  ],
};

const ME = {
  user_id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.test",
  email_verified: true,
  profile_created_at: "2026-08-01T09:00:00Z",
  last_seen_at: "2026-09-04T09:00:00Z",
  created_now: false,
  preferences: preferences(),
};

const THREADS = {
  count: 1,
  threads: [
    {
      id: "t-1",
      title: "Berlin this week",
      created_at: "2026-09-03T09:00:00Z",
      last_activity_at: "2026-09-04T08:40:00Z",
      expires_at: "2026-09-11T08:40:00Z",
      locations: ["Berlin, Berlin, DE"],
    },
  ],
};

const DELETION = {
  removed: {
    user_id: ME.user_id,
    saved_locations: 2,
    preferences: 1,
    threads: 1,
    thread_checkpoints_cleared: 4,
    agent_runs: 5,
    profile: 1,
  },
  total: 14,
  note: "Weathra's shared knowledge base is not personal data and is unaffected. Your sign-in itself is managed by Supabase Auth and is not deleted by this endpoint.",
};

/* -------------------------------------------------------- dashboard fixtures */

/** A current-conditions response in whichever unit system was asked for. */
function current(units: "metric" | "imperial") {
  const imperial = units === "imperial";
  return {
    attribution: {
      data_class: "current" as const,
      from_cache: false,
      location: BERLIN,
      provider: "open-meteo",
      retrieved_at: "2026-09-04T06:15:00Z",
      units,
      units_source: "preferences",
    },
    observed_at_local: "2026-09-04T08:15:00+02:00",
    observed_at_utc: "2026-09-04T06:15:00Z",
    units: { temperature: imperial ? "°F" : "°C", relative_humidity: "%" },
    values: { temperature: imperial ? 64.8 : 18.2, relative_humidity: 72 },
  };
}

function forecast(units: "metric" | "imperial") {
  const imperial = units === "imperial";
  return {
    attribution: {
      data_class: "forecast" as const,
      from_cache: false,
      location: BERLIN,
      provider: "open-meteo",
      retrieved_at: "2026-09-04T06:15:00Z",
      units,
      units_source: "preferences",
    },
    horizon_days: 7,
    period: {
      start_local: "2026-09-04T00:00:00+02:00",
      end_local: "2026-09-11T00:00:00+02:00",
      start_utc: "2026-09-03T22:00:00Z",
      end_utc: "2026-09-10T22:00:00Z",
      timezone: "Europe/Berlin",
    },
    hourly: { granularity: "hourly" as const, units: {}, entries: [] },
    daily: {
      granularity: "daily" as const,
      units: { temperature_max: imperial ? "°F" : "°C", temperature_min: imperial ? "°F" : "°C" },
      entries: [
        {
          time_local: "2026-09-04T00:00:00+02:00",
          time_utc: "2026-09-03T22:00:00Z",
          values: {
            temperature_max: imperial ? 70.5 : 21.4,
            temperature_min: imperial ? 53.8 : 12.1,
          },
        },
      ],
    },
    uncertainty: {
      basis: "Confidence decreases with horizon distance, from one provider's output only.",
      provider: "open-meteo",
      reference_time_utc: "2026-09-04T06:15:00Z",
      spread_available: false,
      horizon: [{ confidence: "high" as const, hours_ahead: 6, time_local: "x", time_utc: "y" }],
    },
  };
}

/* --------------------------------------------------------------------- harness */

let fetchMock: Mock;
/** The backend's stored preferences, which a PUT actually changes. */
let stored: PreferenceView;

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

type Handler = (url: URL, init?: RequestInit) => Response;

/** One handler per method-and-path, so a screen asking for anything else fails loudly. */
function backend(routes: Record<string, Handler>) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      return jsonResponse(404, error("not_found", `No fixture for ${method} ${url.pathname}`));
    }
    return handler(url, init);
  }) as unknown as Mock;
}

/** The routes Settings itself uses, with a PUT that really updates what a later GET returns. */
function settingsRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/v1/me/preferences": () => jsonResponse(200, stored),
    "PUT /api/v1/me/preferences": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stored = {
        ...stored,
        ...(typeof body.unit_system === "string"
          ? { unit_system: body.unit_system as PreferenceView["unit_system"] }
          : {}),
        ...(typeof body.forecast_horizon_days === "number"
          ? { forecast_horizon_days: body.forecast_horizon_days }
          : {}),
        ...(body.default_location === "Tokyo, Tokyo, JP" ? { default_location: TOKYO } : {}),
        ...(body.clear_default_location === true ? { default_location: null } : {}),
      } as PreferenceView;
      return jsonResponse(200, stored);
    },
    "DELETE /api/v1/me/preferences": () => {
      stored = preferences({
        unit_system: "metric",
        forecast_horizon_days: 7,
        default_location: null,
        sources: {
          unit_system: "default",
          forecast_horizon_days: "default",
          default_location: "default",
        },
      });
      return jsonResponse(200, stored);
    },
    "GET /api/v1/me/locations": () => jsonResponse(200, SAVED_LOCATIONS),
    "GET /api/v1/me": () => jsonResponse(200, ME),
    "GET /api/v1/threads": () => jsonResponse(200, THREADS),
    ...overrides,
  };
}

function renderSettings() {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "t"}
      fetch={(input, init) => fetchMock(input, init)}
    >
      <Settings signOutControl={<SignOutForm />} />
    </SessionBoundary>,
  );
}

/** Settings and the Dashboard inside one boundary, which is one query cache — as in the app. */
function renderSettingsAndDashboard() {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "t"}
      fetch={(input, init) => fetchMock(input, init)}
    >
      <Settings signOutControl={<SignOutForm />} />
      <Dashboard />
    </SessionBoundary>,
  );
}

/** Move to the Account tab, where the three account operations live. */
async function openAccountTab(person: ReturnType<typeof userEvent.setup>) {
  await person.click(screen.getByRole("tab", { name: "Account" }));
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  stored = preferences();
  fetchMock = backend(settingsRoutes());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------------------- tests */

describe("the preference form", () => {
  it("opens on the preferences the backend reports, saying which are chosen and which are defaults", async () => {
    renderSettings();

    const form = await screen.findByRole("form", { name: "Your Weathra preferences" });
    expect(within(form).getByRole("radio", { name: /Metric/ })).toBeChecked();
    expect(within(form).getByLabelText("Default forecast horizon")).toHaveValue("7");
    expect(within(form).getByLabelText("Default location")).toHaveValue("Berlin, Berlin, DE");

    // A default is never shown as though it were a decision the person made.
    expect(within(form).getAllByText("Your choice.").length).toBeGreaterThan(0);
    expect(
      within(form).getByText(/Weathra's documented default — you have not chosen this\./),
    ).toBeInTheDocument();

    expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeDisabled();
  });

  it("offers the person's saved locations as the default, so the choice is never ambiguous", async () => {
    renderSettings();
    const select = await screen.findByLabelText("Default location");

    expect(
      [...(select as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(["", "Berlin, Berlin, DE", "Tokyo, Tokyo, JP"]);
  });
});

describe("changing the unit system", () => {
  it("persists it through the backend, and reports it saved only once the backend confirmed", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.click(screen.getByRole("radio", { name: /Imperial/ }));
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    // Only the field that changed is sent: nothing the person did not touch is recorded as chosen.
    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([, init]) => init?.method === "PUT",
      );
      expect(put).toBeDefined();
      expect(new URL(String(put?.[0])).pathname).toBe("/api/v1/me/preferences");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ unit_system: "imperial" });
    });

    expect(await screen.findByText("Your preferences are saved.")).toBeInTheDocument();
    expect(stored.unit_system).toBe("imperial");
  });

  it("is reflected by a later screen, which re-requests in the new unit system", async () => {
    const person = userEvent.setup();
    fetchMock = backend(
      settingsRoutes({
        "GET /api/v1/weather/current": (url) =>
          jsonResponse(200, current(url.searchParams.get("units") === "imperial" ? "imperial" : "metric")),
        "GET /api/v1/weather/forecast": (url) =>
          jsonResponse(200, forecast(url.searchParams.get("units") === "imperial" ? "imperial" : "metric")),
      }),
    );

    renderSettingsAndDashboard();

    // The Dashboard opens in the stored unit system.
    expect(await screen.findByText("18.2 °C")).toBeInTheDocument();

    await person.click(screen.getByRole("radio", { name: /Imperial/ }));
    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    // The saved change reaches the Dashboard's own read of the same preferences, and it asks the
    // backend again — for imperial. Nothing is converted in the browser.
    expect(await screen.findByText("64.8 °F")).toBeInTheDocument();
    expect(screen.queryByText("18.2 °C")).toBeNull();

    const asked = (fetchMock.mock.calls as [string][]).map(([input]) => new URL(input));
    const imperialCalls = asked.filter(
      (url) =>
        url.pathname === "/api/v1/weather/current" && url.searchParams.get("units") === "imperial",
    );
    expect(imperialCalls.length).toBeGreaterThan(0);
  });
});

describe("the other preferences", () => {
  it("persists the default forecast horizon", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.selectOptions(screen.getByLabelText("Default forecast horizon"), "10");
    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([, init]) => init?.method === "PUT",
      );
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ forecast_horizon_days: 10 });
    });
    expect(await screen.findByText("Your preferences are saved.")).toBeInTheDocument();
    expect(stored.forecast_horizon_days).toBe(10);
  });

  it("persists the default location by its canonical name", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.selectOptions(screen.getByLabelText("Default location"), "Tokyo, Tokyo, JP");
    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([, init]) => init?.method === "PUT",
      );
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ default_location: "Tokyo, Tokyo, JP" });
    });
    expect(stored.default_location).toEqual(TOKYO);
  });

  it("expresses removing the default as a clear rather than as an empty name", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.selectOptions(screen.getByLabelText("Default location"), "");
    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      const put = (fetchMock.mock.calls as [string, RequestInit][]).find(
        ([, init]) => init?.method === "PUT",
      );
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ clear_default_location: true });
    });
    expect(stored.default_location).toBeNull();
  });

  it("discards an edit locally without asking the backend for anything", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.click(screen.getByRole("radio", { name: /Imperial/ }));
    await person.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByRole("radio", { name: /Metric/ })).toBeChecked();
    expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("clears the preferences through the backend and says the defaults now apply", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit][]).some(
          ([input, init]) =>
            init?.method === "DELETE" &&
            new URL(input).pathname === "/api/v1/me/preferences",
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/Your preferences are cleared\. Weathra's documented defaults now apply\./),
    ).toBeInTheDocument();
  });

  it("does not report a save when the backend refused one", async () => {
    const person = userEvent.setup();
    fetchMock = backend(
      settingsRoutes({
        "PUT /api/v1/me/preferences": () =>
          jsonResponse(400, error("validation_failed", "Weathra could not record that preference.")),
      }),
    );

    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.click(screen.getByRole("radio", { name: /Imperial/ }));
    await person.click(screen.getByRole("button", { name: "Save preferences" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Your preferences were not saved");
    expect(failure).toHaveTextContent("Weathra could not record that preference.");
    expect(screen.queryByText("Your preferences are saved.")).toBeNull();
    // The edit is still in the form, to correct or discard.
    expect(screen.getByRole("radio", { name: /Imperial/ })).toBeChecked();
  });
});

describe("signing out", () => {
  it("offers the shared sign-out control, and posts to the one server action", async () => {
    const person = userEvent.setup();
    renderSettings();
    await openAccountTab(person);

    const account = await screen.findByRole("region", { name: "Your account" });
    const control = within(account).getByRole("button", { name: "Sign out" });

    // Exactly one sign-out on the screen: Settings offers Weathra's, it does not add another.
    expect(screen.getAllByRole("button", { name: /sign out/i })).toHaveLength(1);

    await person.click(control);
    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));

    // Signing out is not a deletion: no request of Weathra's own went with it.
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([, init]) => init?.method === "DELETE",
      ),
    ).toHaveLength(0);
  });

  it("says what signing out is, and that it removes nothing", async () => {
    const person = userEvent.setup();
    renderSettings();
    await openAccountTab(person);

    const account = await screen.findByRole("region", { name: "Your account" });
    expect(account).toHaveTextContent("person@example.test");
    expect(account).toHaveTextContent(/it removes nothing/i);
    // The Supabase subject identifies the account to the system, not to the person.
    expect(account.textContent).not.toContain(ME.user_id);
  });
});

describe("deleting a conversation's memory", () => {
  it("requires a confirmation step before it will delete anything", async () => {
    const person = userEvent.setup();
    renderSettings();
    await openAccountTab(person);

    const memory = await screen.findByRole("region", { name: "Conversation memory" });
    expect(within(memory).getByText("Berlin this week")).toBeInTheDocument();

    await person.click(within(memory).getByRole("button", { name: "Delete this conversation" }));

    // Nothing is sent by opening the confirmation.
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([, init]) => init?.method === "DELETE",
      ),
    ).toHaveLength(0);

    const confirmation = within(memory).getByRole("group", {
      name: 'Delete the memory of “Berlin this week”?',
    });
    expect(confirmation).toHaveTextContent(/Your saved locations and preferences are untouched/);
    expect(confirmation).toHaveTextContent(/does not sign you out/);

    // And cancelling sends nothing either.
    await person.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([, init]) => init?.method === "DELETE",
      ),
    ).toHaveLength(0);
  });

  it("deletes it through the documented thread endpoint once confirmed", async () => {
    const person = userEvent.setup();
    let threads = THREADS;
    fetchMock = backend(
      settingsRoutes({
        "GET /api/v1/threads": () => jsonResponse(200, threads),
        "DELETE /api/v1/threads/t-1": () => {
          threads = { count: 0, threads: [] };
          return jsonResponse(204, null);
        },
      }),
    );

    renderSettings();
    await openAccountTab(person);

    const memory = await screen.findByRole("region", { name: "Conversation memory" });
    await person.click(within(memory).getByRole("button", { name: "Delete this conversation" }));
    await person.click(
      within(memory).getByRole("button", { name: "Delete this conversation's memory" }),
    );

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit][]).some(
          ([input, init]) =>
            init?.method === "DELETE" && new URL(input).pathname === "/api/v1/threads/t-1",
        ),
      ).toBe(true),
    );

    expect(await screen.findByText(/conversation.s memory has been deleted\./)).toBeInTheDocument();
    expect(await screen.findByText("You have no stored conversations")).toBeInTheDocument();

    // Durable preferences are untouched: nothing went to the preferences endpoint.
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([input, init]) =>
          init?.method === "DELETE" && new URL(input).pathname === "/api/v1/me/preferences",
      ),
    ).toHaveLength(0);
  });

  it("does not report a deletion the backend refused", async () => {
    const person = userEvent.setup();
    fetchMock = backend(
      settingsRoutes({
        "DELETE /api/v1/threads/t-1": () =>
          jsonResponse(404, error("thread_not_found", "No conversation with that identifier.")),
      }),
    );

    renderSettings();
    await openAccountTab(person);

    const memory = await screen.findByRole("region", { name: "Conversation memory" });
    await person.click(within(memory).getByRole("button", { name: "Delete this conversation" }));
    await person.click(
      within(memory).getByRole("button", { name: "Delete this conversation's memory" }),
    );

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That conversation was not deleted");
    expect(failure).toHaveTextContent("No conversation with that identifier.");
    expect(screen.queryByText(/conversation.s memory has been deleted\./)).toBeNull();
    expect(screen.getByText("Berlin this week")).toBeInTheDocument();
  });
});

describe("deleting the person's Weathra data", () => {
  it("requires an explicit confirmation: the word must be typed before it can be pressed", async () => {
    const person = userEvent.setup();
    renderSettings();
    await openAccountTab(person);

    const panel = await screen.findByRole("region", { name: "Delete your Weathra data" });
    await person.click(within(panel).getByRole("button", { name: "Delete my Weathra data" }));

    const confirmation = within(panel).getByRole("group", {
      name: "Delete every Weathra record belonging to you?",
    });
    const confirm = within(confirmation).getByRole("button", {
      name: "Delete my Weathra data permanently",
    });

    expect(confirm).toBeDisabled();
    await person.click(confirm);
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(
        ([, init]) => init?.method === "DELETE",
      ),
    ).toHaveLength(0);

    // The panel states what goes and what does not before anything can be pressed.
    expect(confirmation).toHaveTextContent(/cannot be undone/i);
    expect(confirmation).toHaveTextContent(/Your sign-in is not deleted/);

    await person.type(within(confirmation).getByRole("textbox"), "DELETE");
    expect(confirm).toBeEnabled();
  });

  it("deletes through the documented endpoint and reports the backend's own counts", async () => {
    const person = userEvent.setup();
    fetchMock = backend(
      settingsRoutes({ "DELETE /api/v1/me/data": () => jsonResponse(200, DELETION) }),
    );

    renderSettings();
    await openAccountTab(person);

    const panel = await screen.findByRole("region", { name: "Delete your Weathra data" });
    await person.click(within(panel).getByRole("button", { name: "Delete my Weathra data" }));
    await person.type(within(panel).getByRole("textbox"), "DELETE");
    await person.click(
      within(panel).getByRole("button", { name: "Delete my Weathra data permanently" }),
    );

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit][]).some(
          ([input, init]) =>
            init?.method === "DELETE" && new URL(input).pathname === "/api/v1/me/data",
        ),
      ).toBe(true),
    );

    const report = await screen.findByText("Your Weathra data has been deleted.");
    expect(report).toBeInTheDocument();

    const counts = within(panel).getByText("Records removed in total").closest("div");
    expect(counts).toHaveTextContent("14");
    // The backend's own sentence about what it deliberately did not remove.
    expect(panel).toHaveTextContent(/Supabase Auth and is not deleted by this endpoint/);
  });

  it("does not report a deletion the backend refused", async () => {
    const person = userEvent.setup();
    fetchMock = backend(
      settingsRoutes({
        "DELETE /api/v1/me/data": () =>
          jsonResponse(500, error("internal_error", "Weathra could not delete your data.")),
      }),
    );

    renderSettings();
    await openAccountTab(person);

    const panel = await screen.findByRole("region", { name: "Delete your Weathra data" });
    await person.click(within(panel).getByRole("button", { name: "Delete my Weathra data" }));
    await person.type(within(panel).getByRole("textbox"), "DELETE");
    await person.click(
      within(panel).getByRole("button", { name: "Delete my Weathra data permanently" }),
    );

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Your data was not deleted");
    expect(failure).toHaveTextContent("Weathra could not delete your data.");
    expect(screen.queryByText("Your Weathra data has been deleted.")).toBeNull();
  });

  it("keeps the three account operations distinct", async () => {
    const person = userEvent.setup();
    renderSettings();
    await openAccountTab(person);

    // Three separate regions, three separate controls, three different wordings.
    expect(await screen.findByRole("region", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation memory" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Delete your Weathra data" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete my Weathra data" })).toBeInTheDocument();
  });
});

describe("the session and user isolation", () => {
  it("hands an expired session to the shared session boundary", async () => {
    fetchMock = backend({
      "GET /api/v1/me/preferences": () =>
        jsonResponse(401, error("token_expired", "Your access token has expired.")),
      "GET /api/v1/me/locations": () =>
        jsonResponse(401, error("token_expired", "Your access token has expired.")),
    });
    renderSettings();

    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(screen.queryByText("Your preferences could not be loaded")).toBeNull();
    expect(screen.queryByText("Your access token has expired.")).toBeNull();
  });

  it("never names a user: every request is scoped by the bearer token alone", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });
    await person.click(screen.getByRole("radio", { name: /Imperial/ }));
    await person.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText("Your preferences are saved.");
    await openAccountTab(person);
    await screen.findByRole("region", { name: "Conversation memory" });

    for (const [input, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const url = new URL(input);
      expect(url.origin).toBe("http://backend.test");
      expect(url.pathname.startsWith("/api/v1/")).toBe(true);
      // No caller-asserted identity: not in the query, not in the body.
      expect(url.searchParams.get("user_id")).toBeNull();
      if (init?.body) expect(String(init.body)).not.toContain("user_id");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer t");
    }
  });

  it("shows no station, licence or persona from the artifact", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("form", { name: "Your Weathra preferences" });
    await openAccountTab(person);
    await screen.findByRole("region", { name: "Your account" });

    const text = document.body.textContent ?? "";
    for (const sample of [
      "STATION BER-09",
      "Default Station Node",
      "ENTERPRISE LICENSE",
      "WEATHRA V4.8.2-PRO",
      "Dr. Aris Thorne",
      "LAST SAVE: 14:32:01 UTC",
      "Legal & Compliance",
      "API DOCS",
    ]) {
      expect(text).not.toContain(sample);
    }
  });
});
