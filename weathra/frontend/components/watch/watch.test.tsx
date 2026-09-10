/**
 * Weather Watch — three states, and no claim of monitoring.
 *
 * The most important case is the middle one: a watch whose provider reported nothing is not a watch
 * whose condition was not met. Collapsing those two is how a silent provider becomes calm weather
 * on somebody's screen, and this is a feature where that matters.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { WeatherWatch } from "./watch";

const REYKJAVIK = {
  display_name: "Reykjavík",
  latitude: 64.15,
  longitude: -21.94,
  timezone: "Atlantic/Reykjavik",
  country: "Iceland",
  country_code: "IS",
};

function watch(overrides: Record<string, unknown> = {}) {
  return {
    id: "w-1",
    location: REYKJAVIK,
    label: null,
    measure: "wind_speed",
    comparison: "above",
    threshold: 40,
    enabled: true,
    last_evaluated_at: "2026-09-10T09:00:00Z",
    last_value: 52,
    last_met: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-10T09:00:00Z",
    ...overrides,
  };
}

const NOTE = "Checked when you open this screen or press refresh. Weathra does not monitor continuously and sends no alerts.";
const DISCLAIMER = "Weather Watch is analytical assistance, not an official severe-weather or emergency warning service. Always follow your local meteorological agency.";

function client(overrides: Partial<ApiClient> = {}, watches = [watch()]): ApiClient {
  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: REYKJAVIK,
      sources: {},
    }),
    watches: vi.fn().mockResolvedValue({
      count: watches.length,
      watches,
      watchable: ["temperature", "wind_speed"],
      evaluation_note: NOTE,
      disclaimer: DISCLAIMER,
    }),
    createWatch: vi.fn().mockResolvedValue(watch()),
    evaluateWatch: vi.fn().mockResolvedValue(watch()),
    removeWatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ApiClient;
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

describe("the watch list", () => {
  it("checks the watches as it reads them, which is the product's semantics", async () => {
    const watches = vi.fn().mockResolvedValue({
      count: 1,
      watches: [watch()],
      watchable: ["wind_speed"],
      evaluation_note: NOTE,
      disclaimer: DISCLAIMER,
    });
    mount(client({ watches }));
    await screen.findByRole("heading", { name: "Weather Watch" });

    expect(watches).toHaveBeenCalledWith(true);
  });

  it("shows what was found and when it was found", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Weather Watch" });

    expect(await screen.findByText("Condition met")).toBeInTheDocument();
    expect(screen.getByText(/Last reading 52/)).toBeInTheDocument();
    expect(screen.getByText(/Checked 10 Sep/)).toBeInTheDocument();
  });

  it("distinguishes not-met from no-reading", async () => {
    mount(
      client({}, [
        watch({ id: "a", last_met: false, last_value: 12 }),
        watch({ id: "b", last_met: null, last_value: null, last_evaluated_at: null }),
      ]),
    );
    await screen.findByRole("heading", { name: "Weather Watch" });

    expect(await screen.findByText("Not met")).toBeInTheDocument();
    // Null is its own state. A provider that said nothing has not said "no". Scoped to the list,
    // because the summary row counts them under the same words.
    // Two of them: the badge on the watch, and the summary tile counting it. Both are correct;
    // what matters is that neither reads as "Not met".
    expect(screen.getAllByText("No reading").length).toBeGreaterThanOrEqual(1);
    const rows = screen.getAllByRole("listitem");
    const silent = rows.find((row) => /not checked yet/.test(row.textContent ?? ""));
    expect(within(silent as HTMLElement).getByText("No reading")).toBeInTheDocument();
    expect(within(silent as HTMLElement).queryByText("Not met")).toBeNull();
    expect(screen.getByText(/not checked yet/)).toBeInTheDocument();
  });

  it("checks one watch on request", async () => {
    const evaluateWatch = vi.fn().mockResolvedValue(watch());
    mount(client({ evaluateWatch }));
    await screen.findByRole("heading", { name: "Weather Watch" });

    await userEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(evaluateWatch).toHaveBeenCalledWith("w-1"));
  });

  it("adds a watch for the person's place, with the measure and threshold chosen", async () => {
    const createWatch = vi.fn().mockResolvedValue(watch());
    mount(client({ createWatch }));
    await screen.findByRole("heading", { name: "Weather Watch" });

    await userEvent.click(screen.getByRole("button", { name: "Add this watch" }));

    await waitFor(() => expect(createWatch).toHaveBeenCalledTimes(1));
    expect(createWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: REYKJAVIK.latitude,
        comparison: "above",
        threshold: 25,
      }),
    );
  });
});

describe("what Weather Watch never claims", () => {
  it("states the evaluation semantics the backend reported, rather than one of its own", async () => {
    mount(client());
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("carries the safety disclaimer", async () => {
    mount(client());
    expect(await screen.findByText(DISCLAIMER)).toBeInTheDocument();
  });

  it("never says it is monitoring, alerting or watching in real time", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Weather Watch" });
    const text = container.textContent ?? "";

    for (const claim of [
      "real-time",
      "Real-time",
      "continuous monitoring",
      "Monitoring",
      "watch engine",
      "Watch Engine",
      "recalibration",
      "sensor",
      "push alert",
    ]) {
      expect(text, `Weather Watch claims ${claim}`).not.toContain(claim);
    }
  });
});
