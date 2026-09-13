/**
 * Weather Scenario Lab — the workspace, from one run of a real endpoint.
 *
 * The cases that matter most are the three the rebuild and this polish pass exist for.
 *
 * **The lab opens loaded.** It used to open on an empty state asking for a place, and then on three
 * more empty cards asking for a button press. A place now resolves straight into a run with every
 * assumption at zero — the retrieved forecast, which is a legitimate thing to draw — so the
 * baseline, the plot and the archive block are populated before anything is supposed.
 *
 * **One run feeds every panel.** The endpoint returns the baseline series, the adjusted series, the
 * per-measure arithmetic, the counted effects and the archive comparison together, and no panel
 * re-fetches. A second retrieval per section is what makes two panels disagree.
 *
 * **A baseline run says it is a baseline.** Every panel branches on the assumptions the *displayed
 * response* was calculated with, so with nothing supposed the calculated card reads UNCHANGED, the
 * four tiles read Unchanged, the plot says the two series overlap, the reading is one sentence, and
 * the archive block is titled for what it is actually placing. The moment an assumption is run,
 * every one of those switches over — and switches back on reset.
 *
 * The fixture applies the assumptions the way `analytics/scenario.py` does — offsets, a percentage
 * scale, the physical bounds — rather than returning a canned response, so a test that asserts a
 * scenario differs from its baseline is asserting about arithmetic and not about a literal.
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

/** The retrieved window, as the provider reported it. Three hours is enough to have a shape. */
const RETRIEVED = [
  { hour: 6, temperature: 12.4, precipitation: 0, relative_humidity: 70, wind_speed: 10 },
  { hour: 12, temperature: 18.44, precipitation: 1.2, relative_humidity: 64, wind_speed: 14 },
  { hour: 18, temperature: 15.1, precipitation: 0, relative_humidity: 72, wind_speed: 12 },
] as const;

type Measure = "temperature" | "precipitation" | "relative_humidity" | "wind_speed";

interface Assumptions {
  readonly temperature_delta?: number;
  readonly precipitation_percent?: number;
  readonly relative_humidity_delta?: number;
  readonly wind_speed_delta?: number;
}

/** Which assumption addresses which measure, and how it is applied. Mirrors `ADJUSTABLE`. */
const APPLIES: readonly {
  readonly key: keyof Assumptions;
  readonly measure: Measure;
  readonly kind: "offset" | "scale";
  readonly minimum?: number;
  readonly maximum?: number;
}[] = [
  { key: "temperature_delta", measure: "temperature", kind: "offset" },
  { key: "precipitation_percent", measure: "precipitation", kind: "scale", minimum: 0 },
  {
    key: "relative_humidity_delta",
    measure: "relative_humidity",
    kind: "offset",
    minimum: 0,
    maximum: 100,
  },
  { key: "wind_speed_delta", measure: "wind_speed", kind: "offset", minimum: 0 },
];

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function seriesOf(values: readonly Record<Measure, number>[]) {
  return {
    granularity: "hourly",
    units: UNITS,
    entries: values.map((row, index) => entry(RETRIEVED[index]!.hour, { ...row })),
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

/**
 * A run of the endpoint, with the stated assumptions applied the way the backend applies them.
 *
 * Offsets add, the percentage scales, and the physical bounds hold — so a scenario the test asserts
 * about is one the arithmetic produced rather than a literal somebody typed beside the expectation.
 */
function response(assumptions: Assumptions) {
  const stated = APPLIES.filter((rule) => {
    const amount = assumptions[rule.key];
    return typeof amount === "number" && amount !== 0;
  });

  const baselineRows: Record<Measure, number>[] = RETRIEVED.map((row) => ({
    temperature: row.temperature,
    precipitation: row.precipitation,
    relative_humidity: row.relative_humidity,
    wind_speed: row.wind_speed,
  }));

  const scenarioRows = baselineRows.map((row) => {
    const moved: Record<Measure, number> = { ...row };
    for (const rule of stated) {
      const amount = assumptions[rule.key]!;
      let value =
        rule.kind === "scale" ? row[rule.measure] * (1 + amount / 100) : row[rule.measure] + amount;
      if (rule.minimum !== undefined) value = Math.max(rule.minimum, value);
      if (rule.maximum !== undefined) value = Math.min(rule.maximum, value);
      moved[rule.measure] = value;
    }
    return moved;
  });

  const measures = stated.map((rule) => {
    const amount = assumptions[rule.key]!;
    const before = mean(baselineRows.map((row) => row[rule.measure]));
    const after = mean(scenarioRows.map((row) => row[rule.measure]));
    return {
      measure: rule.measure,
      unit: UNITS[rule.measure],
      assumption: amount,
      method:
        rule.kind === "scale"
          ? `each reported value scaled by ${amount > 0 ? "+" : ""}${amount.toFixed(1)}%`
          : `${amount > 0 ? "+" : ""}${amount.toFixed(2)} added to each reported value`,
      baseline_mean: before,
      scenario_mean: after,
      difference: after - before,
      points_used: 3,
      points_excluded: 0,
      clipped: 0,
    };
  });

  const peak = (rows: readonly Record<Measure, number>[], measure: Measure) =>
    Math.max(...rows.map((row) => row[measure]));
  const windMoved = peak(scenarioRows, "wind_speed") - peak(baselineRows, "wind_speed");
  const scenarioMean = mean(scenarioRows.map((row) => row.temperature));

  /*
   * The two derived signals, chosen the way `summarise_effects` chooses them: the largest counted
   * change for the risk signal, and the assumption that moved its own measure furthest relative to
   * that measure's own baseline for the sensitivity one.
   */
  const ranked = measures
    .map((row) => ({
      row,
      share: row.baseline_mean === 0 ? Math.abs(row.difference) : Math.abs(row.difference / row.baseline_mean),
    }))
    .sort((left, right) => right.share - left.share)[0];

  const risk =
    measures.length === 0
      ? {
          kind: "none",
          label: "No assumption applied",
          detail: "The scenario is the retrieved forecast, unchanged.",
        }
      : windMoved > 0
        ? {
            kind: "higher-peak-wind",
            label: "Higher peak wind",
            detail: `The highest wind speed in the window rises from ${peak(baselineRows, "wind_speed").toFixed(1)} to ${peak(scenarioRows, "wind_speed").toFixed(1)} km/h.`,
            measure: "wind_speed",
          }
        : {
            kind: "higher-peak-temperature",
            label: "Higher peak temperature",
            detail: `The highest temperature in the window rises to ${peak(scenarioRows, "temperature").toFixed(1)} °C, from ${peak(baselineRows, "temperature").toFixed(1)} °C.`,
            measure: "temperature",
          };

  const sensitivity =
    ranked === undefined
      ? { kind: "none", label: "Not ranked", detail: "No assumption moved a measure." }
      : {
          kind: "most-sensitive",
          label: `Most sensitive to ${ranked.row.measure.replace(/_/g, " ")}`,
          detail: `That assumption moved its own mean by ${(ranked.share * 100).toFixed(1)}% of the retrieved mean, the largest share of the four.`,
          measure: ranked.row.measure,
        };

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
    assumptions: Object.fromEntries(
      stated.map((rule) => [rule.key, assumptions[rule.key]!]),
    ) as Assumptions,
    baseline: seriesOf(baselineRows),
    scenario: seriesOf(scenarioRows),
    measures,
    effects: {
      risk,
      sensitivity,
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
          baseline: peak(baselineRows, "temperature"),
          scenario: peak(scenarioRows, "temperature"),
          difference: peak(scenarioRows, "temperature") - peak(baselineRows, "temperature"),
          occurred_at_local: "2026-09-10T12:00:00+02:00",
        },
      ],
      method: "Counted from the two series directly.",
    },
    history: {
      scenario_mean: scenarioMean,
      method: "The scenario's mean temperature across the window, placed against the archive.",
      nearest_analog: { year: 2022, mean: 15.9, distance: 0.5866666666666, unit: "°C" },
      comparison: {
        location: BERLIN,
        measure: "temperature_mean",
        observed_or_forecast_value: scenarioMean,
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

function client(overrides: Partial<ApiClient> = {}, location: unknown = BERLIN): ApiClient {
  const scenario = vi.fn(async (request: { assumptions?: Assumptions }) =>
    response(request.assumptions ?? {}),
  );

  return {
    preferences: vi.fn().mockResolvedValue({
      unit_system: "metric",
      forecast_horizon_days: 7,
      default_location: location,
      sources: {},
    }),
    scenario,
    ...overrides,
  } as unknown as ApiClient;
}

/** The four-assumption run the acceptance cases use, typed into the rail one field at a time. */
const SCENARIO = [
  { label: /Temperature shift, exact value/, value: "2.5" },
  { label: /Precipitation change, exact value/, value: "15" },
  { label: /Humidity shift, exact value/, value: "5" },
  { label: /Wind speed shift, exact value/, value: "10" },
] as const;

async function stateAndRun(
  fields: readonly { readonly label: RegExp; readonly value: string }[] = SCENARIO,
) {
  for (const field of fields) {
    const input = screen.getByLabelText(field.label);
    await userEvent.clear(input);
    await userEvent.type(input, field.value);
  }
  await userEvent.click(screen.getByRole("button", { name: "Run scenario" }));
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
      // Nothing is supposed yet, so the archive block is titled for what it is actually placing.
      "Baseline historical context",
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
    // Nothing has been supposed, so the calculated side does not claim a simulation.
    expect(within(impact).getByText("Unchanged")).toBeInTheDocument();
    expect(within(impact).queryByText("Simulated")).not.toBeInTheDocument();
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
    const field = screen.getByLabelText(/Temperature shift, exact value/);
    await userEvent.clear(field);
    await userEvent.type(field, "2.5");

    // One value, in two places that cannot disagree: the slider and the field that reads it back.
    expect((slider as HTMLInputElement).value).toBe("2.5");
    expect(field).toHaveValue(2.5);
    // The sign and the unit sit in the chip around the field, so the readout is `+2.5°C` and not a
    // bare number in a box; the slider announces the same figure whole.
    const chip = within(field.parentElement as HTMLElement);
    expect(chip.getByText("+")).toBeInTheDocument();
    expect(chip.getByText("°C")).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuetext", "+2.5 °C");
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

describe("the lab without a place", () => {
  it("is an introduction and a chooser, not three empty panels", async () => {
    mount(client({}, null));
    expect(
      await screen.findByRole("heading", { name: "Weather Scenario Lab" }),
    ).toBeInTheDocument();

    // The chooser is the whole interaction; the regions of a loaded lab are not drawn empty.
    expect(screen.getByText("Choose a place to begin")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Experiment on a place" })).toBeInTheDocument();
    for (const region of [
      "User-defined assumptions",
      "Temporal impact projection",
      "Historical correlation model",
      "Baseline historical context",
    ]) {
      expect(screen.queryByRole("heading", { name: region })).not.toBeInTheDocument();
    }
  });

  it("retrieves nothing until a place resolves", async () => {
    const api = client({}, null);
    mount(api);
    await screen.findByRole("heading", { name: "Weather Scenario Lab" });

    expect(api.scenario).not.toHaveBeenCalled();
  });
});

describe("the baseline state", () => {
  it("puts the retrieved figure under every slider, never a claim that none arrived", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    // The means of the retrieved window, one per adjustable quantity.
    expect(screen.getByText("Baseline mean 15.3 °C")).toBeInTheDocument();
    expect(screen.getByText("Baseline precipitation 0.4 mm")).toBeInTheDocument();
    expect(screen.getByText("Baseline humidity 68.7 %")).toBeInTheDocument();
    expect(screen.getByText("Baseline wind 12 km/h")).toBeInTheDocument();
    expect(screen.queryByText(/No baseline reported/)).not.toBeInTheDocument();
  });

  it("omits the reference line rather than naming an absence the provider did report", async () => {
    const bare = response({});
    const stripped = {
      ...bare,
      baseline: {
        ...bare.baseline,
        entries: bare.baseline.entries.map((row) => ({
          ...row,
          values: { ...row.values, wind_speed: null },
        })),
      },
    };
    mount(client({ scenario: vi.fn().mockResolvedValue(stripped) }));
    await screen.findByRole("heading", { name: "User-defined assumptions" });

    expect(screen.getByText("Baseline mean 15.3 °C")).toBeInTheDocument();
    expect(screen.queryByText(/Baseline wind/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No baseline reported/)).not.toBeInTheDocument();
  });

  it("says the scenario is the baseline rather than leaving it to be inferred", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    expect(screen.getByText(/Scenario = baseline\./)).toBeInTheDocument();
    expect(screen.getByText(/Scenario overlaps baseline — no adjustments applied\./)).toBeInTheDocument();
  });

  it("draws the calculated card as unchanged rather than as a simulation", async () => {
    mount(client());
    const impact = await screen.findByRole("region", { name: "Calculated analytical impact" });

    expect(within(impact).getByText("Unchanged")).toBeInTheDocument();
    expect(within(impact).getByText("Matches retrieved baseline")).toBeInTheDocument();
    // The figure is the baseline's own, and it is the same figure the baseline card shows.
    expect(within(impact).getByText("15.3")).toBeInTheDocument();
  });

  it("reads all four delta tiles as unchanged, never as +0.0", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    expect(screen.getAllByText("Unchanged").length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText("No assumption applied")).toHaveLength(4);
    expect(screen.queryByText("+0 °C")).not.toBeInTheDocument();
    expect(screen.queryByText("+0.0 °C")).not.toBeInTheDocument();
  });

  it("reads the baseline once rather than saying nothing moved three times over", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Interpretation & insights" });

    expect(
      within(panel).getByText(
        /No assumptions are applied\. This is the retrieved 2-day baseline forecast for Berlin, Germany/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Baseline")).toBeInTheDocument();
    expect(within(panel).getByText("Not evaluated")).toBeInTheDocument();
    // The backend's own baseline sentences would each repeat the paragraph above them.
    expect(within(panel).queryByText(/The scenario is the retrieved forecast, unchanged/)).toBeNull();
    expect(within(panel).queryByText(/No assumption moved a measure/)).toBeNull();
  });

  it("places the retrieved forecast against the archive, and says that is what it placed", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Baseline historical context" });

    expect(
      within(panel).getByText(
        "This baseline forecast is +2.1 °C / +0.67σ relative to the archived comparison window.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/The simulated scenario is/)).toBeNull();
  });
});

describe("running a scenario", () => {
  it("applies the assumptions and updates every panel from the one run", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await stateAndRun([SCENARIO[0]]);

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

    await stateAndRun([SCENARIO[0]]);

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

    await stateAndRun([{ label: /Temperature shift, exact value/, value: "4" }]);
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

describe("a real scenario, and the reset that undoes it", () => {
  /*
   * The acceptance run: +2.5 °C, +15% precipitation, +5 points of humidity, +10 km/h of wind.
   *
   * One case rather than eight, because the thing being asserted is that *every* panel leaves the
   * baseline state together off one run — a version of this split per panel would pass with three
   * of them still reading the baseline.
   */
  it("moves every panel off the baseline when four assumptions are run", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await stateAndRun();

    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(2));
    expect(api.scenario).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assumptions: {
          temperature_delta: 2.5,
          precipitation_percent: 15,
          relative_humidity_delta: 5,
          wind_speed_delta: 10,
        },
      }),
    );

    // The scenario is not the baseline: 15.3 retrieved, 17.8 under the assumptions.
    const baseline = await screen.findByRole("region", { name: "Baseline weather data" });
    const impact = await screen.findByRole("region", { name: "Calculated analytical impact" });
    expect(within(baseline).getByText("15.3")).toBeInTheDocument();
    expect(within(impact).getByText("17.8")).toBeInTheDocument();
    expect(within(impact).getByText("Simulated")).toBeInTheDocument();
    expect(within(impact).queryByText("Unchanged")).not.toBeInTheDocument();
    expect(within(impact).getByText("+2.5 °C")).toBeInTheDocument();

    // The plot draws two series that are no longer one.
    expect(
      screen.getByRole("img", { name: /and the scenario it was adjusted into/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Scenario overlaps baseline/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Scenario = baseline/)).not.toBeInTheDocument();

    // All four delta tiles carry a movement — none of them is still "Unchanged".
    expect(screen.queryByText("Unchanged")).not.toBeInTheDocument();
    expect(screen.queryByText("No assumption applied")).not.toBeInTheDocument();
    for (const moved of ["+2.5 °C", "+0.1 mm", "+5 %", "+10 km/h"]) {
      expect(screen.getAllByText(moved).length, `no tile reads ${moved}`).toBeGreaterThan(0);
    }

    // The reading is the run's, not the baseline's, and both signals are populated.
    const reading = screen.getByRole("region", { name: "Interpretation & insights" });
    expect(within(reading).queryByText(/No assumptions are applied/)).toBeNull();
    expect(
      within(reading).getByText(/Applied to the retrieved 2-day forecast for Berlin, Germany/),
    ).toBeInTheDocument();
    expect(within(reading).getByText("Higher peak wind")).toBeInTheDocument();
    expect(within(reading).getByText("Most sensitive to wind speed")).toBeInTheDocument();

    // The archive block is now evaluating the simulated scenario, and says so in its own title.
    const archive = screen.getByRole("region", { name: "Historical correlation model" });
    expect(
      within(archive).getByText(
        "The simulated scenario is +2.1 °C / +0.67σ relative to the archived comparison window.",
      ),
    ).toBeInTheDocument();
    expect(within(archive).getByText(/Nearest archived year · 2022/)).toBeInTheDocument();
    expect(
      within(archive).getByRole("complementary", { name: "Evidence context" }),
    ).toBeInTheDocument();
  });

  it("returns every panel to the baseline state on reset, and keeps the place", async () => {
    const api = client();
    mount(api);
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    await stateAndRun();
    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(2));
    await screen.findByRole("region", { name: "Historical correlation model" });

    await userEvent.click(screen.getByRole("button", { name: "Reset to baseline" }));
    await waitFor(() => expect(api.scenario).toHaveBeenCalledTimes(3));
    expect(api.scenario).toHaveBeenLastCalledWith(expect.objectContaining({ assumptions: {} }));

    // Every control back to zero, and the run behind the screen back to the retrieved forecast.
    await waitFor(() =>
      expect(
        screen.getAllByRole("slider").every((slider) => (slider as HTMLInputElement).value === "0"),
      ).toBe(true),
    );
    expect(screen.getByText(/Scenario = baseline\./)).toBeInTheDocument();

    const impact = screen.getByRole("region", { name: "Calculated analytical impact" });
    expect(within(impact).getByText("Unchanged")).toBeInTheDocument();
    expect(within(impact).getByText("15.3")).toBeInTheDocument();
    expect(screen.getAllByText("No assumption applied")).toHaveLength(4);

    const reading = screen.getByRole("region", { name: "Interpretation & insights" });
    expect(within(reading).getByText(/No assumptions are applied/)).toBeInTheDocument();
    expect(within(reading).getByText("Not evaluated")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Baseline historical context" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Historical correlation model" }),
    ).not.toBeInTheDocument();

    // Reset returns the assumptions, not the screen: the place it was experimenting on stays.
    expect(screen.getAllByText(/Berlin/).length).toBeGreaterThan(0);
  });
});

describe("the chart", () => {
  it("plots the retrieved forecast, and the scenario over it once one is run", async () => {
    mount(client());
    expect(
      await screen.findByRole("img", { name: /overlaps it exactly/ }),
    ).toBeInTheDocument();

    await stateAndRun([SCENARIO[0]]);

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
    const panel = await screen.findByRole("region", { name: "Baseline historical context" });

    expect(within(panel).getByText("0.67σ")).toBeInTheDocument();
    expect(within(panel).getByText("+2.1 °C")).toBeInTheDocument();
    expect(within(panel).getByText("83.3%")).toBeInTheDocument();
    expect(within(panel).getByText(/Nearest archived year · 2022/)).toBeInTheDocument();
  });

  it("names the archive it was compared against", async () => {
    mount(client());
    const panel = await screen.findByRole("region", { name: "Baseline historical context" });
    const evidence = within(panel).getByRole("complementary", { name: "Evidence context" });

    expect(within(evidence).getByText("open-meteo")).toBeInTheDocument();
    expect(within(evidence).getByText("3")).toBeInTheDocument();
    expect(within(evidence).getByText("Baseline for 10-12 September")).toBeInTheDocument();
  });

  it("is absent, not empty, when the archive could not serve the window", async () => {
    mount(
      client({
        scenario: vi.fn().mockResolvedValue({ ...response({}), history: null }),
      }),
    );
    await screen.findByRole("heading", { name: "Temporal impact projection" });

    expect(
      screen.queryByRole("heading", { name: "Baseline historical context" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Historical correlation model" }),
    ).not.toBeInTheDocument();
  });
});

describe("what the lab refuses to claim", () => {
  it("claims none of the artifact's invented apparatus, and shows no raw float", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Baseline historical context" });
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
