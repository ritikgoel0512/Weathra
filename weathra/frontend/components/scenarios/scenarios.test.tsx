/**
 * Weather Scenario Lab — the workspace, from one run of a real endpoint.
 *
 * The cases that matter most are the two the rebuild exists for.
 *
 * **The lab opens loaded.** It used to open on an empty state asking for a place, and then on three
 * more empty cards asking for a button press. A place now resolves straight into a run with every
 * assumption at zero — the retrieved forecast, which is a legitimate thing to draw — so the
 * baseline, the plot and the archive block are populated before anything is supposed.
 *
 * **One run feeds every panel.** The endpoint returns the baseline series, the adjusted series, the
 * per-measure arithmetic, the counted effects and the archive comparison together, and no panel
 * re-fetches. A second retrieval per section is what makes two panels disagree.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { WeatherScenarioLab } from "./scenarios";

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
};

const PERIOD = {
  start_local: "2026-09-10T00:00:00+02:00",
  end_local: "2026-09-12T00:00:00+02:00",
  start_utc: "2026-09-09T22:00:00Z",
  end_utc: "2026-09-11T22:00:00Z",
  timezone: "Europe/Berlin",
};

const UNITS = {
  temperature: "°C",
  precipitation: "mm",
  relative_humidity: "%",
  wind_speed: "km/h",
};

function entry(hour: number, values: Record<string, number | null>) {
  const stamp = `2026-09-10T${String(hour).padStart(2, "0")}:00:00+02:00`;
  return { time_local: stamp, time_utc: stamp, values };
}

function series(shift: number) {
  return {
    granularity: "hourly",
    units: UNITS,
    entries: [
      entry(6, {
        temperature: 12.4 + shift,
        precipitation: 0,
        relative_humidity: 70,
        wind_speed: 10,
      }),
      entry(12, {
        temperature: 18.44 + shift,
        precipitation: 1.2,
        relative_humidity: 64,
        wind_speed: 14,
      }),
      entry(18, {
        temperature: 15.1 + shift,
        precipitation: 0,
        relative_humidity: 72,
        wind_speed: 12,
      }),
    ],
  };
}

function statistic(measure: string, name: string, value: number, unit: string) {
  return {
    measure,
    statistic: name,
    value,
    unit,
    method: "m",
    minimum_points: 1,
    points_used: 3,
    provenance: {},
  };
}

/** A run of the endpoint. `shift` is what the temperature assumption moved it by. */
function response(shift: number) {
  return {
    simulated: true,
    disclaimer:
      "A hypothetical: your stated assumptions applied to a real forecast. It is not a forecast.",
    attribution: {
      provider: "open-meteo",
      location: BERLIN,
      retrieved_at: "2026-09-10T06:00:00Z",
    },
    period: PERIOD,
    horizon_days: 2,
    assumptions: shift === 0 ? {} : { temperature_delta: shift },
    baseline: series(0),
    scenario: series(shift),
    measures:
      shift === 0
        ? []
        : [
            {
              measure: "temperature",
              unit: "°C",
              assumption: shift,
              method: `+${shift.toFixed(2)} added to each reported value`,
              baseline_mean: 15.313333333333333,
              scenario_mean: 15.313333333333333 + shift,
              difference: shift,
              points_used: 3,
              points_excluded: 0,
              clipped: 0,
            },
          ],
    effects: {
      risk:
        shift === 0
          ? {
              kind: "none",
              label: "No assumption applied",
              detail: "The scenario is the retrieved forecast, unchanged.",
            }
          : {
              kind: "higher-peak-temperature",
              label: "Higher peak temperature",
              detail: `The highest temperature in the window rises to ${(18.44 + shift).toFixed(1)} °C, from 18.4 °C.`,
              measure: "temperature",
            },
      sensitivity:
        shift === 0
          ? { kind: "none", label: "Not ranked", detail: "No assumption moved a measure." }
          : {
              kind: "most-sensitive",
              label: "Most sensitive to temperature",
              detail: "That assumption moved its own mean by 16.3% of the retrieved mean.",
              measure: "temperature",
            },
      crossings: [
        {
          measure: "precipitation",
          unit: "mm",
          threshold: 0,
          label: "hours with precipitation reported",
          baseline_hours: 1,
          scenario_hours: 1,
          difference: 0,
        },
      ],
      extremes: [
        {
          measure: "temperature",
          unit: "°C",
          baseline: 18.44,
          scenario: 18.44 + shift,
          difference: shift,
          occurred_at_local: "2026-09-10T12:00:00+02:00",
        },
      ],
      method: "Counted from the two series directly.",
    },
    history: {
      scenario_mean: 15.313333333333333 + shift,
      method: "The scenario's mean temperature across the window, placed against the archive.",
      nearest_analog: { year: 2022, mean: 15.9, distance: 0.5866666666666, unit: "°C" },
      comparison: {
        location: BERLIN,
        measure: "temperature_mean",
        observed_or_forecast_value: 15.313333333333333 + shift,
        observed_data_class: "computed_statistic",
        characterization:
          "17.8 °C is 2.1 °C above the 3-year baseline temperature mean of 15.7 °C (+0.67 standard deviations).",
        difference: statistic("temperature_mean", "delta", 2.1, "°C"),
        z_score: { ...statistic("temperature_mean", "z_score", 0.6706849412785952, ""), unit: "" },
        percentile_rank: statistic("temperature_mean", "percentile_rank", 83.3333333, "%"),
        baseline: {
          labelling: "Baseline for 10-12 September",
          measure: "temperature_mean",
          calendar_period: PERIOD,
          location: BERLIN,
          provider: "open-meteo",
          mean: statistic("temperature_mean", "mean", 15.7, "°C"),
          minimum: statistic("temperature_mean", "minimum", 14.1, "°C"),
          maximum: statistic("temperature_mean", "maximum", 17.2, "°C"),
          standard_deviation: statistic("temperature_mean", "standard_deviation", 1.2, "°C"),
          years_requested: 10,
          years_used: [2021, 2022, 2023],
          yearly_means: [
            { year: 2021, value: 14.8, points_used: 3 },
            { year: 2022, value: 15.9, points_used: 3 },
            { year: 2023, value: 16.4, points_used: 3 },
          ],
        },
      },
    },
  };
}

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  const scenario = vi.fn(
    async (request: { assumptions?: { temperature_delta?: number } }) =>
      response(request.assumptions?.temperature_delta ?? 0),
  );

  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: BERLIN,
      sources: {},
    }),
    scenario,
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <WeatherScenarioLab />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the lab's composition", () => {
  it("opens loaded on the saved place, with every region the artifact draws", async () => {
    mount(client());
    expect(
      await screen.findByRole("heading", { name: "Weather Scenario Lab" }),
    ).toBeInTheDocument();

    for (const region of [
      "User-defined assumptions",
      "Baseline weather data",
      "Calculated analytical impact",
      "Temporal impact projection",
      "Interpretation & insights",
      "Historical correlation model",
    ]) {
      expect(await screen.findByRole("heading", { name: region })).toBeInTheDocument();
    }
    expect(screen.getByText("Analytical disclaimer")).toBeInTheDocument();
  });

  it("retrieves the baseline once, without waiting for a button press", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Baseline weather data" });

    expect(api.scenario).toHaveBeenCalledTimes(1);
    expect(api.scenario).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 52.52, assumptions: {} }),
    );
  });

  it("puts the run controls in the lab header rather than inside the assumptions card", async () => {
    mount(client());
    const header = (await screen.findByRole("banner", { hidden: true })) as HTMLElement;

    expect(within(header).getByRole("button", { name: "Run scenario" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Reset to baseline" })).toBeInTheDocument();
  });

  it("draws the baseline and the scenario as two cards, classed differently", async () => {
    mount(client());
    const baseline = await screen.findByRole("region", { name: "Baseline weather data" });
    const impact = await screen.findByRole("region", { name: "Calculated analytical impact" });

    expect(within(baseline).getByText("FORECAST")).toBeInTheDocument();
    expect(within(impact).getByText("Simulated")).toBeInTheDocument();
    // The mean of the retrieved window, rounded, not a raw float.
    expect(within(baseline).getByText("15.3")).toBeInTheDocument();
  });
});

describe("the assumptions rail", () => {
  it("offers a slider per adjustable quantity, at zero to begin with", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(4);
    expect(sliders.every((slider) => (slider as HTMLInputElement).value === "0")).toBe(true);
    expect(screen.getByLabelText("Temperature shift")).toBeInTheDocument();
  });

  it("reads a shift back signed, with its unit, as it is moved", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    const slider = screen.getByLabelText("Temperature shift");
    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "2.5");

    expect((slider as HTMLInputElement).value).toBe("2.5");
    expect(screen.getByText("+2.5 °C")).toBeInTheDocument();
  });

  it("says when the controls hold something not yet run", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "3");

    expect(screen.getByText(/Assumptions changed/)).toBeInTheDocument();
  });

  it("states what the run rests on rather than a confidence percentage", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    expect(screen.getByText("Scenario basis")).toBeInTheDocument();
    expect(screen.getByText("3 hours retrieved")).toBeInTheDocument();
    expect(screen.getByText("Archive comparison")).toBeInTheDocument();
    expect(screen.queryByText(/Inference confidence/i)).not.toBeInTheDocument();
  });
});

describe("running a scenario", () => {
  it("applies the assumptions and updates every panel from the one run", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Run scenario" }));

    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(2));
    expect(api.scenario).toHaveBeenLastCalledWith(
      expect.objectContaining({ assumptions: { temperature_delta: 2.5 } }),
    );

    // The impact card, the delta strip and the interpretation all read the same run.
    const impact = await screen.findByRole("region", { name: "Calculated analytical impact" });
    expect(within(impact).getByText("+2.5 °C")).toBeInTheDocument();
    expect(await screen.findByText(/Higher peak temperature/)).toBeInTheDocument();
    expect(screen.getByText(/Most sensitive to temperature/)).toBeInTheDocument();
  });

  it("draws exactly four delta tiles, naming the ones nothing was supposed about", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Run scenario" }));

    // Four tiles, always: the one that moved, and the three nothing was supposed about.
    expect(await screen.findAllByText("Unchanged")).toHaveLength(3);
    expect(screen.getAllByText("No assumption applied")).toHaveLength(3);
    // The temperature tile carries the movement; the readout, the impact card and the rail carry
    // it too, which is the same figure doing four different jobs rather than a duplicate.
    expect(screen.getAllByText("+2.5 °C").length).toBeGreaterThan(0);
  });

  it("returns every control to zero and re-runs the baseline on reset", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "4");
    await userEvent.click(screen.getByRole("button", { name: "Run scenario" }));
    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Reset to baseline" }));

    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(3));
    expect(api.scenario).toHaveBeenLastCalledWith(
      expect.objectContaining({ assumptions: {} }),
    );
    expect(
      screen.getAllByRole("slider").every((slider) => (slider as HTMLInputElement).value === "0"),
    ).toBe(true);
    // The place is preserved: reset returns the assumptions, not the screen.
    expect(screen.getAllByText(/Berlin/).length).toBeGreaterThan(0);
  });
});

describe("the chart", () => {
  it("plots the retrieved forecast, and the scenario over it once one is run", async () => {
    mount(client());
    expect(
      await screen.findByRole("img", { name: /with no assumption applied/ }),
    ).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/Temperature shift, exact value/));
    await userEvent.type(screen.getByLabelText(/Temperature shift, exact value/), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Run scenario" }));

    expect(
      await screen.findByRole("img", { name: /and the scenario it was adjusted into/ }),
    ).toBeInTheDocument();
  });

  it("keeps the plotted figures reachable as a table", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await userEvent.click(screen.getByRole("button", { name: "Show the figures" }));
    const table = screen.getByRole("table");
    // Rounded at the cell, never at the precision the provider sent.
    expect(within(table).getAllByText("18.4").length).toBeGreaterThan(0);
    expect(within(table).queryByText("18.44")).not.toBeInTheDocument();
  });
});

describe("the archive block", () => {
  it("places the scenario against the archived years, with the year it most resembles", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Historical correlation model" });

    expect(within(panel).getByText("0.67σ")).toBeInTheDocument();
    expect(within(panel).getByText("+2.1 °C")).toBeInTheDocument();
    expect(within(panel).getByText("83.3%")).toBeInTheDocument();
    expect(within(panel).getByText(/Nearest archived year · 2022/)).toBeInTheDocument();
  });

  it("names the archive it was compared against", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Historical correlation model" });
    const evidence = within(panel).getByRole("complementary", { name: "Evidence context" });

    expect(within(evidence).getByText("open-meteo")).toBeInTheDocument();
    expect(within(evidence).getByText("3")).toBeInTheDocument();
    expect(within(evidence).getByText("Baseline for 10-12 September")).toBeInTheDocument();
  });

  it("is absent, not empty, when the archive could not serve the window", async () => {
    mount(
      client({
        scenario: vi.fn().mockResolvedValue({ ...response(0), history: null }),
      }),
    );
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    expect(
      screen.queryByRole("heading", { name: "Historical correlation model" }),
    ).not.toBeInTheDocument();
  });
});

describe("what the lab refuses to claim", () => {
  it("claims none of the artifact's invented apparatus, and shows no raw float", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Historical correlation model" });
    const text = container.textContent ?? "";

    for (const invented of [
      "Neural simulation",
      "DELTA-INFERENCE",
      "Inference confidence",
      "Evaporation rate",
      "Thermal inertia",
      "Infrastructure sensitivity",
      "Model matching",
      "Atm. stability",
      "active nodes",
      "SCENARIO_LOCK",
      "Export simulation report",
    ]) {
      expect(text, `the lab mentions ${invented}`).not.toContain(invented);
    }

    expect(text).not.toContain("0.6706849412785952");
    expect(text).not.toContain("15.313333333333333");
  });

  it("labels the reading as computed rather than as a model's", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Interpretation & insights" });

    expect(within(panel).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(panel).queryByText("AI INTERPRETATION")).not.toBeInTheDocument();
    expect(
      within(panel).getByText(/not a physical model of the atmosphere/),
    ).toBeInTheDocument();
  });
});
