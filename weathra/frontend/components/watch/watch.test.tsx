/**
 * Weather Watch — a monitoring workspace, from one read of one endpoint.
 *
 * The cases that matter most are the ones a monitoring product fails at quietly.
 *
 * **A silent provider is not calm weather.** "The provider reported nothing", "the retrieval
 * failed" and "the condition did not hold" are three different facts and are drawn as three, because
 * collapsing them is how a screen somebody relies on comes to say the wrong thing in the one
 * situation that matters.
 *
 * **Scheduled is not live.** The screen must never say real-time, continuous, or live, and every
 * state it reports must carry the moment it was found.
 *
 * **Reading the screen evaluates nothing.** One read, no provider call per watch, and every panel
 * drawn from that one response so no two can disagree about whether a condition is met.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { WeatherWatch } from "./watch";

/** What `?place=` holds for the test currently running. Reset in `beforeEach`. */
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/watch",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => searchParams,
}));

beforeEach(() => {
  searchParams = new URLSearchParams();
});

const LONDON = {
  display_name: "London",
  latitude: 51.5072,
  longitude: -0.1276,
  timezone: "Europe/London",
  region: "England",
  country: "United Kingdom",
  country_code: "GB",
};

const MUNICH = {
  display_name: "Munich",
  latitude: 48.1374,
  longitude: 11.5755,
  timezone: "Europe/Berlin",
  region: "Bavaria",
  country: "Germany",
  country_code: "DE",
};

const NOTE =
  "Checked on a schedule, when a watch is created, and when you press refresh. Weathra does not monitor continuously and sends no alerts.";
const DISCLAIMER =
  "Weather Watch is analytical assistance, not an official severe-weather or emergency warning service. Always follow your local meteorological agency.";

function watch(): Record<string, unknown> {
  return {
    id: "w-london",
    location: LONDON,
    label: null,
    measure: "temperature",
    comparison: "above",
    threshold: 25,
    enabled: true,
    state: "met",
    previous_state: "not_met",
    last_evaluated_at: "2026-09-13T12:00:00Z",
    last_value: 26.3,
    last_unit: "°C",
    last_met: true,
    last_error: null,
    next_evaluation_at: "2026-09-13T13:00:00Z",
    created_at: "2026-09-12T00:00:00Z",
    updated_at: "2026-09-13T12:00:00Z",
  };
}

function entry(hour: number, temperature: number | null) {
  const stamp = `2026-09-13T${String(hour).padStart(2, "0")}:00:00+01:00`;
  return { time_local: stamp, time_utc: stamp, values: { temperature } };
}

/**
 * One dashboard, as the endpoint returns it.
 *
 * Typed loosely on purpose: these cases override whole top-level fields with narrower shapes — no
 * selection, no watches, one degraded watch — and a literal type inferred from the happy case would
 * reject every one of them. The client is cast at the boundary anyway, so the contract is asserted
 * by `scripts/api-types.test.ts` rather than by this fixture's inferred type.
 */
function dashboard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: {
      active_watch_count: 2,
      monitored_location_count: 2,
      changes_detected: 3,
      changes_window_hours: 24,
      met_count: 1,
      last_evaluation_at: "2026-09-13T12:00:00Z",
      next_evaluation_at: "2026-09-13T13:00:00Z",
      cadence_minutes: 60,
    },
    watched_locations: [
      {
        location_id: "51.51,-0.13",
        location: LONDON,
        watch_count: 1,
        met_count: 1,
        state: "met",
        conditions: { temperature: 26.3, wind_speed: 14.2, precipitation: 0 },
        units: { temperature: "°C", wind_speed: "km/h", precipitation: "mm" },
        provider: "open-meteo",
        last_evaluated_at: "2026-09-13T12:00:00Z",
      },
      {
        location_id: "48.14,11.58",
        location: MUNICH,
        watch_count: 1,
        met_count: 0,
        state: "not_met",
        conditions: { temperature: 18.1 },
        units: { temperature: "°C" },
        provider: "open-meteo",
        last_evaluated_at: "2026-09-13T12:00:00Z",
      },
    ],
    watches: [
      { ...watch() },
      {
        ...watch(),
        id: "w-munich",
        location: MUNICH,
        measure: "precipitation",
        threshold: 10,
        state: "not_met",
        last_value: 1.2,
        last_unit: "mm",
        last_met: false,
      },
    ],
    selected: {
      watch: watch(),
      series: {
        granularity: "hourly",
        units: { temperature: "°C" },
        entries: [entry(12, 22.0), entry(13, 24.9), entry(14, 26.1), entry(15, 26.3)],
      },
      outcome: {
        measure: "temperature",
        comparison: "above",
        threshold: 25,
        unit: "°C",
        value: 26.3,
        met: true,
        margin: 1.3,
        matched_at_local: "2026-09-13T15:00:00+01:00",
        matched_at_utc: "2026-09-13T14:00:00Z",
        peak: 26.3,
        crossing: {
          at_utc: "2026-09-13T13:00:00Z",
          at_local: "2026-09-13T14:00:00+01:00",
          value: 26.1,
        },
        points_used: 4,
      },
      evidence:
        "The London temperature watch is met. open-meteo reports 26.3 °C at 15:00 on 13 September, 1.3 °C above the 25 °C threshold.",
      changes: [
        {
          kind: "condition_met",
          summary: "The London watch changed from not met to met.",
          previous_state: "not_met",
          new_state: "met",
        },
        {
          kind: "reading_moved",
          summary: "The watched temperature moved +2.3 °C since the previous evaluation, to 26.3 °C.",
          delta: 2.3,
          unit: "°C",
        },
      ],
      provider: "open-meteo",
      retrieved_at: "2026-09-13T11:55:00Z",
      evaluated_at: "2026-09-13T12:00:00Z",
      evaluation_count: 2,
    },
    activity: [
      {
        id: "e-2",
        watch_id: "w-london",
        occurred_at: "2026-09-13T12:00:00Z",
        event_type: "condition_met",
        previous_state: "not_met",
        new_state: "met",
        summary: "The London watch changed from not met to met.",
      },
      {
        id: "e-1",
        watch_id: "w-london",
        occurred_at: "2026-09-12T00:00:00Z",
        event_type: "watch_created",
        new_state: "pending",
        summary: "Watch created: London temperature above 25 °C.",
      },
    ],
    watchable: ["precipitation", "relative_humidity", "temperature", "wind_speed"],
    monitoring_note: NOTE,
    disclaimer: DISCLAIMER,
    ...overrides,
  };
}

function client(overrides: Partial<ApiClient> = {}, data = dashboard()): ApiClient {
  return {
    watchDashboard: vi.fn().mockResolvedValue(data),
    watches: vi.fn().mockResolvedValue({ count: 0, watches: [], watchable: [] }),
    createWatch: vi.fn(),
    updateWatch: vi.fn(),
    removeWatch: vi.fn(),
    // The canonical answer the backend gives for "London" — the same one both the typed flow and
    // the `?place=` flow must end up holding.
    resolveLocation: vi.fn().mockResolvedValue({ kind: "resolved", query: "London", location: LONDON }),
    ...overrides,
  } as unknown as ApiClient;
}

/** A dashboard with nothing watched yet, which is the state the first-watch flow starts in. */
function empty() {
  const data = dashboard();
  return {
    ...data,
    watches: [],
    watched_locations: [],
    selected: null,
    activity: [],
    summary: { ...(data.summary as Record<string, unknown>), active_watch_count: 0 },
  };
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <WeatherWatch />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the screen's composition", () => {
  it("draws every region the artifact does, from one read", async () => {
    const api = client();
    mount(api);
    expect(await screen.findByRole("heading", { name: "Weather Watch" })).toBeInTheDocument();

    for (const region of [
      "Watched locations",
      "Active watches",
      "Temporal watch analysis",
      "What changed?",
      "Watch evidence",
      "Activity feed",
      "Quick watch config",
    ]) {
      expect(await screen.findByRole("heading", { name: region })).toBeInTheDocument();
    }
    expect(screen.getByText("Analytical monitoring notice")).toBeInTheDocument();
    // One read, for all of it.
    expect(api.watchDashboard).toHaveBeenCalledTimes(1);
  });

  it("reads the screen without evaluating anything", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Watched locations" });

    // `watches(true)` is the explicit refresh. Opening the screen must not be one.
    expect(api.watches).not.toHaveBeenCalled();
  });

  it("draws exactly four counters, each of them counted", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Watched locations" });

    for (const label of [
      "Active watches",
      "Locations monitored",
      "Changes detected",
      "Next evaluation",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Recorded in the last 24 hours")).toBeInTheDocument();
  });
});

describe("multiple locations", () => {
  it("shows every watched place with its own last retrieval, not one focus place", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Watched locations" });

    expect(within(panel).getByText(/London/)).toBeInTheDocument();
    expect(within(panel).getByText(/Munich/)).toBeInTheDocument();
    // Real values from that place's own check, at the precision the unit is read at.
    expect(within(panel).getByText("26.3 °C")).toBeInTheDocument();
    expect(within(panel).getByText("18.1 °C")).toBeInTheDocument();
    expect(within(panel).getByText("14.2 km/h")).toBeInTheDocument();
  });

  it("lists every watch in the rail, whatever place it is about", async () => {
    mount(client());
    const rail = await screen.findByRole("region", { name: "Active watches" });

    expect(within(rail).getByText("Temperature above 25 °C")).toBeInTheDocument();
    expect(within(rail).getByText("Precipitation above 10 mm")).toBeInTheDocument();
  });

  it("selects a different watch by pressing its place, without a second read of everything", async () => {
    const api = client();
    mount(api);
    const panel = await screen.findByRole("region", { name: "Watched locations" });

    await userEvent.click(within(panel).getByRole("button", { name: /Munich/ }));

    await waitFor(() =>
      expect(api.watchDashboard).toHaveBeenLastCalledWith("w-munich"),
    );
  });
});

describe("the threshold plot", () => {
  it("plots the series against the threshold and says how much of it is past the line", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Temporal watch analysis" });

    expect(
      within(panel).getByRole("img", { name: /against a threshold of 25 °C/ }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/2 of 4 retrieved hours are above 25 °C/)).toBeInTheDocument();
  });

  it("carries the real figures under it, and no confidence among them", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Temporal watch analysis" });

    expect(within(panel).getByText("Latest reading")).toBeInTheDocument();
    expect(within(panel).getByText("26.3 °C")).toBeInTheDocument();
    // Twice, and both are right: once in the legend naming the line, once as the figure itself.
    expect(within(panel).getAllByText("Threshold")).toHaveLength(2);
    expect(within(panel).getByText("Past the threshold by")).toBeInTheDocument();
    expect(within(panel).getByText("1.3 °C")).toBeInTheDocument();
    expect(within(panel).getByText("First crossing")).toBeInTheDocument();
    expect(within(panel).queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it("keeps the plotted figures reachable as a table", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Temporal watch analysis" });

    await userEvent.click(screen.getByRole("button", { name: "Show the figures" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("Yes").length).toBe(2);
    expect(within(table).getAllByText("No").length).toBe(2);
  });
});

describe("the evidence", () => {
  it("explains the state from the retrieval it was made against", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Watch evidence" });

    expect(within(panel).getByText(/1.3 °C above the 25 °C threshold/)).toBeInTheDocument();
    expect(within(panel).getByText("open-meteo")).toBeInTheDocument();
    expect(within(panel).getByText("Provider")).toBeInTheDocument();
    expect(within(panel).getByText("Retrieved")).toBeInTheDocument();
    expect(within(panel).getByText("Evaluated")).toBeInTheDocument();
  });
});

describe("what changed and what happened", () => {
  it("shows the real differences from the previous check", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "What changed?" });

    expect(within(panel).getByText("State change")).toBeInTheDocument();
    expect(within(panel).getByText(/changed from not met to met/)).toBeInTheDocument();
    expect(within(panel).getByText("Forecast shift")).toBeInTheDocument();
    expect(within(panel).getByText(/moved \+2.3 °C/)).toBeInTheDocument();
  });

  it("says so in one line when nothing moved, rather than filling the panel", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        selected: { ...(data.selected as Record<string, unknown>), changes: [] },
      }),
    );
    const panel = await screen.findByRole("region", { name: "What changed?" });

    expect(within(panel).getByText(/No material change since the previous evaluation/)).toBeInTheDocument();
  });

  it("lists the recorded events, newest first", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Activity feed" });

    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("State change");
    expect(rows[1]).toHaveTextContent("Watch created");
  });
});

describe("the three ways a check ends without an answer", () => {
  it("draws a silent provider as its own state, never as the condition being unmet", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        watches: [{ ...watch(), state: "no_reading", last_value: null, last_met: null }],
      }),
    );
    const rail = await screen.findByRole("region", { name: "Active watches" });

    expect(within(rail).getByText("No reading")).toBeInTheDocument();
    expect(within(rail).queryByText("Watching")).not.toBeInTheDocument();
    expect(within(rail).getByText(/No reading ·/)).toBeInTheDocument();
  });

  it("draws a failed retrieval as Weathra's failure rather than as the weather's", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        watches: [{ ...watch(), state: "degraded", last_error: "Open-Meteo did not respond." }],
      }),
    );
    const rail = await screen.findByRole("region", { name: "Active watches" });

    expect(within(rail).getByText("Not checked")).toBeInTheDocument();
    expect(await screen.findByText(/Watch engine: Degraded/)).toBeInTheDocument();
  });

  it("draws a paused watch as paused rather than as its last reading", async () => {
    const data = dashboard();
    mount(client({}, { ...data, watches: [{ ...watch(), enabled: false, state: "paused" }] }));
    const rail = await screen.findByRole("region", { name: "Active watches" });

    expect(within(rail).getByText("Paused")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });
});

describe("naming a place, in both of the screen's states", () => {
  /*
   * Weather Watch is not one of the screens with a focus place, so it is not in
   * `place-chooser.test.tsx`'s suite. This is its equivalent: a place can be named on the screen in
   * either state without a trip to Settings, which is finding 1.7's actual requirement.
   */
  it("keeps the chooser reachable without a click once there are watches to add to", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Quick watch config" });

    // Open rather than folded: adding a watch is this screen's primary action, and a disclosure
    // would put the one thing somebody came to do behind a press.
    expect(within(panel).getByRole("form", { name: "Quick watch configuration" })).toBeInTheDocument();
    expect(within(panel).getByRole("textbox")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Measure")).toBeInTheDocument();
  });
});

describe("the first-watch place, from typing it and from the URL", () => {
  /*
   * This suite exists because of a defect that reached production, and the shape of the defect is
   * the reason the suite is written against the *DOM* rather than only against behaviour.
   *
   * `QuickWatchConfig` wrapped the place chooser inside its own `<form>`, and the chooser renders a
   * `<form>` of its own. HTML has no nested form: the parser drops the inner element, the field
   * inside it ends up owned by no form at all, and pressing *Show this place* performed a native
   * GET submit instead of running the resolver. The browser navigated to `/watch?place=London`, the
   * component remounted, and the typed name was gone — so a person could type a place, watch the
   * URL change, and still have nothing selected.
   *
   * None of that was visible to a jsdom test, because React builds that DOM with `createElement`
   * rather than through the HTML parser, so both forms exist and the association is fine. Hence the
   * first case below: it asserts the *structure* that made the browser behave differently from the
   * test, which is the only thing that would have caught it here.
   */
  it("keeps the place control out of the configuration form, so neither is nested in the other", async () => {
    const { container } = mount(client({}, empty()));
    await screen.findByText("Create your first watch");

    expect(container.querySelectorAll("form form")).toHaveLength(0);
    // And the field belongs to the chooser's own form rather than to the configuration one.
    const field = screen.getByRole("textbox") as HTMLInputElement;
    expect(field.closest("form")?.getAttribute("aria-label")).toBe("Watch a place");
  });

  it("keeps the resolved place after it is named, without asking for it twice", async () => {
    const api = client({}, empty());
    mount(api);
    await screen.findByText("Create your first watch");

    await userEvent.type(screen.getByRole("textbox"), "London");
    await userEvent.click(screen.getByRole("button", { name: "Show this place" }));

    // The canonical name the resolver returned, not the typed string and not coordinates.
    expect(await screen.findByText("London, England, United Kingdom")).toBeInTheDocument();
    expect(screen.getByText("Place")).toBeInTheDocument();
    // The field is gone, because the place is chosen: nobody types it a second time.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change place" })).toBeInTheDocument();
  });

  it("hydrates the place from the URL on a cold load, through the same resolver", async () => {
    searchParams = new URLSearchParams("place=London");
    const api = client({}, empty());
    mount(api);

    expect(await screen.findByText("London, England, United Kingdom")).toBeInTheDocument();
    expect(api.resolveLocation).toHaveBeenCalledWith(expect.objectContaining({ query: "London" }));
    // Resolved once, not once per render.
    expect(api.resolveLocation).toHaveBeenCalledTimes(1);
  });

  it("leaves the chooser alone when the URL names something that cannot be resolved", async () => {
    searchParams = new URLSearchParams("place=Nowhereville");
    const api = client(
      {
        resolveLocation: vi.fn().mockResolvedValue({
          kind: "ambiguous",
          query: "Nowhereville",
          candidates: [],
        }),
      },
      empty(),
    );
    mount(api);
    await screen.findByText("Create your first watch");

    // No silent fallback to another city: the chooser is exactly as it would be if nobody typed.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText("Place")).not.toBeInTheDocument();
  });

  it("creates the watch with the resolved place, not with the typed string", async () => {
    const created = { ...watch(), id: "w-new" };
    const api = client({ createWatch: vi.fn().mockResolvedValue(created) }, empty());
    mount(api);
    await screen.findByText("Create your first watch");

    await userEvent.type(screen.getByRole("textbox"), "London");
    await userEvent.click(screen.getByRole("button", { name: "Show this place" }));
    await screen.findByText("London, England, United Kingdom");

    await userEvent.selectOptions(screen.getByLabelText("Measure"), "temperature");
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "above");
    await userEvent.type(screen.getByLabelText(/Threshold/), "25");
    await userEvent.click(screen.getByRole("button", { name: "Create watch" }));

    // The canonical coordinates the resolver returned — never a name for the backend to re-resolve.
    await waitFor(() =>
      expect(api.createWatch).toHaveBeenCalledWith({
        // The name *and* the pair. Coordinates alone produced a production watch labelled
        // `51.5085, -0.1257` on every surface, because Open-Meteo has no reverse geocoding and a
        // save by coordinates names the point after itself.
        location: LONDON.display_name,
        latitude: LONDON.latitude,
        longitude: LONDON.longitude,
        measure: "temperature",
        comparison: "above",
        threshold: 25,
      }),
    );
  });

  it("leaves onboarding for the full dashboard once the first watch exists", async () => {
    const created = { ...watch(), id: "w-new" };
    // The first read has nothing; the read after creation has the watch the backend just evaluated.
    const watchDashboard = vi
      .fn()
      .mockResolvedValueOnce(empty())
      .mockResolvedValue(dashboard());
    const api = client({ watchDashboard, createWatch: vi.fn().mockResolvedValue(created) }, empty());
    mount(api);
    await screen.findByText("Create your first watch");

    await userEvent.type(screen.getByRole("textbox"), "London");
    await userEvent.click(screen.getByRole("button", { name: "Show this place" }));
    await screen.findByText("London, England, United Kingdom");
    await userEvent.type(screen.getByLabelText(/Threshold/), "25");
    await userEvent.click(screen.getByRole("button", { name: "Create watch" }));

    // No manual reload: the mutation invalidates the dashboard read and the screen re-renders.
    expect(
      await screen.findByRole("heading", { name: "Watched locations" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Create your first watch")).not.toBeInTheDocument();
    for (const region of ["Active watches", "Temporal watch analysis", "Watch evidence", "Activity feed"]) {
      expect(screen.getByRole("heading", { name: region })).toBeInTheDocument();
    }
  });
});

describe("creating the first watch", () => {
  it("is the whole screen when there is nothing to monitor, not three empty panels", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        watches: [],
        watched_locations: [],
        selected: null,
        activity: [],
        summary: { ...(data.summary as Record<string, unknown>), active_watch_count: 0 },
      }),
    );
    expect(await screen.findByText("Create your first watch")).toBeInTheDocument();

    // The panels of a loaded screen are not drawn empty beside it.
    for (const region of ["Watched locations", "Temporal watch analysis", "Activity feed"]) {
      expect(screen.queryByRole("heading", { name: region })).not.toBeInTheDocument();
    }
    // And the form that resolves it is right there, with the place control as its subject rather
    // than folded into a disclosure asking for "another" place from somebody who has had none.
    expect(screen.getByRole("form", { name: "Quick watch configuration" })).toBeInTheDocument();
    expect(screen.getByText("Choose a place to begin")).toBeInTheDocument();
    expect(screen.getByLabelText("Measure")).toBeInTheDocument();
    expect(screen.getByLabelText("Direction")).toBeInTheDocument();
    expect(screen.getByLabelText(/Threshold/)).toBeInTheDocument();
  });

  it("offers only the measures the backend says it can evaluate", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        watches: [],
        watched_locations: [],
        selected: null,
        watchable: ["temperature", "wind_speed"],
      }),
    );
    const measure = (await screen.findByLabelText("Measure")) as HTMLSelectElement;

    expect([...measure.options].map((option) => option.value)).toEqual([
      "temperature",
      "wind_speed",
    ]);
  });

  it("creates the watch with what was typed, and the backend evaluates it immediately", async () => {
    const created = { ...watch(), id: "w-new" };
    const api = client(
      { createWatch: vi.fn().mockResolvedValue(created) },
      {
        ...dashboard(),
        watches: [],
        watched_locations: [],
        selected: null,
      },
    );
    mount(api);
    await screen.findByText("Create your first watch");

    // The place chooser resolves a name before anything is created; this test drives the fields it
    // owns and asserts the request, which is where the contract actually is.
    await userEvent.selectOptions(screen.getByLabelText("Measure"), "temperature");
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "above");
    await userEvent.type(screen.getByLabelText(/Threshold/), "25");

    // With no place resolved the control refuses rather than sending a watch about nowhere.
    expect(screen.getByRole("button", { name: "Create watch" })).toBeDisabled();
  });
});

describe("the place a watch is about, as a person reads it", () => {
  /*
   * A production watch created from London rendered `51.5085, -0.1257` on six surfaces. The cause
   * was the create payload carrying coordinates only, so the *stored* canonical name became the
   * coordinate string — every screen was faithfully displaying what had been saved.
   *
   * These cases hold the display end of that: whatever the backend stores is what is shown, the
   * canonical name is preferred wherever there is one, and no coordinate pair is ever assembled
   * into a place name in the interface.
   */
  it("names every surface from the stored canonical location", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Watch evidence" });

    for (const region of [
      "Watched locations",
      "Active watches",
      "Temporal watch analysis",
      "What changed?",
    ]) {
      const panel = screen.getByRole("region", { name: region });
      expect(within(panel).getAllByText(/London, England, United Kingdom/).length, region)
        .toBeGreaterThan(0);
    }
  });

  it("shows no coordinate pair as a place name anywhere on the screen", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Activity feed" });

    // Two signed decimals separated by a comma is what a coordinate label looks like. Latitude and
    // longitude are internal metadata and must never reach a surface as the name of a place.
    expect(container.textContent ?? "").not.toMatch(/-?\d{1,3}\.\d{4}, ?-?\d{1,3}\.\d{4}/);
  });

  it("keeps two places distinct rather than merging them by label", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Watched locations" });

    const cards = within(panel).getAllByRole("button");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("London");
    expect(cards[1]).toHaveTextContent("Munich");
  });
});

describe("changes detected, against what the panel beside it says", () => {
  it("reads zero for a watch that has only been checked once", async () => {
    const data = dashboard();
    mount(
      client({}, {
        ...data,
        summary: { ...(data.summary as Record<string, unknown>), changes_detected: 0 },
        selected: {
          ...(data.selected as Record<string, unknown>),
          changes: [],
          evaluation_count: 1,
        },
        activity: [
          {
            id: "e-1",
            watch_id: "w-london",
            occurred_at: "2026-09-13T12:00:00Z",
            event_type: "watch_created",
            new_state: "pending",
            summary: "Watch created: London temperature above 25 °C.",
          },
        ],
      }),
    );
    await screen.findByRole("heading", { name: "Watched locations" });

    // The KPI and the panel agree: nothing has changed, and the creation is not a change.
    const counters = screen.getByText("Changes detected").closest("li");
    expect(counters).toHaveTextContent("0");
    expect(
      within(screen.getByRole("region", { name: "What changed?" })).getByText(
        /only been checked once so far/,
      ),
    ).toBeInTheDocument();

    // The feed still carries the creation, because an audit stream is not a change counter.
    expect(
      within(screen.getByRole("region", { name: "Activity feed" })).getByText("Watch created"),
    ).toBeInTheDocument();
  });

  it("reads what the backend counted once a real transition has happened", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Watched locations" });

    expect(screen.getByText("Changes detected").closest("li")).toHaveTextContent("3");
    expect(
      within(screen.getByRole("region", { name: "What changed?" })).getByText("State change"),
    ).toBeInTheDocument();
  });
});

describe("what the screen refuses to claim", () => {
  it("never says live, real-time or continuous monitoring", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Watch evidence" });
    const text = (container.textContent ?? "").toLowerCase();

    for (const forbidden of ["real-time", "realtime", "live monitoring", "continuous monitoring"]) {
      expect(text, `the screen claims ${forbidden}`).not.toContain(forbidden);
    }
    // And it states the honest thing instead.
    expect(text).toContain("scheduled");
  });

  it("claims none of the artifact's invented apparatus", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Activity feed" });
    const text = container.textContent ?? "";

    for (const invented of [
      "96.4",
      "98.4",
      "Inference confidence",
      "Model recalibration",
      "anomalies",
      "Grounding",
      "active nodes",
      "Compliance lock",
      "Sensor network",
      "Emergency alert",
    ]) {
      expect(text, `the screen mentions ${invented}`).not.toContain(invented);
    }
  });

  it("carries the disclaimer in the backend's own sentence, not one of its own", async () => {
    mount(client());
    expect(await screen.findByText(DISCLAIMER)).toBeInTheDocument();
  });

  it("shows real system facts in the status strip and no node counts", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Activity feed" });

    expect(screen.getByText("Watch engine")).toBeInTheDocument();
    expect(screen.getByText("Last evaluation")).toBeInTheDocument();
    expect(screen.getAllByText("open-meteo").length).toBeGreaterThan(0);
  });
});

/**
 * Removing a watch — task 21.8 defect B.
 *
 * A watch is a standing instruction somebody set up deliberately, and removing one destroys it
 * along with the readings behind it. There is no undo, so the press that starts it must not be the
 * press that does it. These cases hold the whole contract: the first press asks, Cancel and Escape
 * both answer no, only the second control answers yes, and each row's control says which watch it
 * belongs to so a screen-reader user is not choosing between identical names.
 */
describe("removing a watch", () => {
  // `placeOf` composes the whole friendly name, which is what the row shows and therefore what the
  // control must be named by — naming it "London" would not match what a person reads on screen.
  const LONDON_NAME = "London, England, United Kingdom";
  const REMOVE_LONDON = `Remove watch: ${LONDON_NAME}`;
  const REMOVE_MUNICH = "Remove watch: Munich, Bavaria, Germany";
  const ASK_LONDON = `Remove the watch on ${LONDON_NAME}?`;

  /** The rail, where every watch is listed. */
  async function rail() {
    return await screen.findByRole("region", { name: /Active watches/ });
  }

  it("names each row's control by the watch it removes", async () => {
    mount(client());
    const list = await rail();

    expect(
      within(list).getByRole("button", { name: REMOVE_LONDON }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: REMOVE_MUNICH }),
    ).toBeInTheDocument();
    // The defect this replaces: two controls sharing one name, with nothing to tell them apart.
    expect(within(list).queryAllByRole("button", { name: "Remove" })).toHaveLength(0);
  });

  it("asks before it removes anything, and sends nothing by asking", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockResolvedValue(undefined);
    mount(client({ removeWatch }));
    const list = await rail();

    await person.click(within(list).getByRole("button", { name: REMOVE_LONDON }));

    const confirmation = await screen.findByRole("alertdialog", {
      name: ASK_LONDON,
    });
    expect(confirmation).toHaveTextContent(/permanently removes this weather watch/);
    expect(removeWatch).not.toHaveBeenCalled();
  });

  it("cancels without removing it", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockResolvedValue(undefined);
    mount(client({ removeWatch }));
    const list = await rail();

    await person.click(within(list).getByRole("button", { name: REMOVE_LONDON }));
    const confirmation = await screen.findByRole("alertdialog", {
      name: ASK_LONDON,
    });
    await person.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    expect(removeWatch).not.toHaveBeenCalled();
    // The confirmation is gone and the trigger is back, focused, so the keyboard is where it was.
    expect(
      screen.queryByRole("alertdialog", { name: ASK_LONDON }),
    ).toBeNull();
    const trigger = within(await rail()).getByRole("button", { name: REMOVE_LONDON });
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape without removing it", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockResolvedValue(undefined);
    mount(client({ removeWatch }));
    const list = await rail();

    await person.click(within(list).getByRole("button", { name: REMOVE_LONDON }));
    await screen.findByRole("alertdialog", { name: ASK_LONDON });
    await person.keyboard("{Escape}");

    expect(removeWatch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alertdialog", { name: ASK_LONDON }),
    ).toBeNull();
  });

  it("removes it, by its identifier, once the second control is pressed", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockResolvedValue(undefined);
    mount(client({ removeWatch }));
    const list = await rail();

    await person.click(within(list).getByRole("button", { name: REMOVE_LONDON }));
    const confirmation = await screen.findByRole("alertdialog", {
      name: ASK_LONDON,
    });
    await person.click(within(confirmation).getByRole("button", { name: "Remove watch" }));

    await waitFor(() => expect(removeWatch).toHaveBeenCalledWith("w-london"));
    expect(removeWatch).toHaveBeenCalledTimes(1);
  });

  it("is operable from the keyboard alone, with focus moved into the confirmation", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockResolvedValue(undefined);
    mount(client({ removeWatch }));
    const list = await rail();

    const trigger = within(list).getByRole("button", { name: REMOVE_LONDON });
    trigger.focus();
    await person.keyboard("{Enter}");

    const confirmation = await screen.findByRole("alertdialog", {
      name: ASK_LONDON,
    });
    // Focus is inside the panel, so the warning is met rather than tabbed past.
    expect(confirmation).toHaveFocus();

    await person.tab();
    await person.keyboard("{Enter}");
    await waitFor(() => expect(removeWatch).toHaveBeenCalledWith("w-london"));
  });

  it("does not report a removal the backend refused", async () => {
    const person = userEvent.setup();
    const removeWatch = vi.fn().mockRejectedValue(new Error("The watch could not be removed."));
    mount(client({ removeWatch }));
    const list = await rail();

    await person.click(within(list).getByRole("button", { name: REMOVE_LONDON }));
    const confirmation = await screen.findByRole("alertdialog", {
      name: ASK_LONDON,
    });
    await person.click(within(confirmation).getByRole("button", { name: "Remove watch" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That watch was not removed");
    // The watch is still listed, because it still exists — a refusal is never drawn as a removal.
    expect(within(await rail()).getByText(LONDON_NAME)).toBeInTheDocument();
    // And the confirmation stays open rather than closing as though it had worked.
    expect(screen.getByRole("alertdialog", { name: ASK_LONDON })).toBeInTheDocument();
  });
});
