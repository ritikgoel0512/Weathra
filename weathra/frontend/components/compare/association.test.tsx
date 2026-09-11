/**
 * The two deterministic bars, and the four ways a bar can lie about a statistic.
 *
 * `04-compare-cities.png` draws a correlation and a data density as bars, which is the least
 * forgiving way to show a figure: a filled track reads as a measurement whether or not one was
 * taken. Every case here is one where a naive rendering produces something confident and wrong —
 * a negative coefficient drawn as a short bar, a not-computable figure drawn as an empty one, a
 * pair statistic drawn for three places.
 *
 * The panel is rendered directly rather than through the screen: what is under test is the
 * mapping from a `StatisticResult` to a bar, and driving it through the comparison flow would make
 * every case a fixture-assembly exercise.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ComparisonResult, StatisticResult } from "@/lib/api/schema";

import { DeterministicAssociation } from "./sections";

const PROVENANCE = {
  provider: "open-meteo",
  computed_by: "weathra",
} as unknown as StatisticResult["provenance"];

function statistic(overrides: Partial<StatisticResult>): StatisticResult {
  return {
    statistic: "correlation",
    measure: "temperature",
    status: "computed",
    value: 0.87,
    unit: "correlation coefficient",
    method: "Pearson correlation of the two places' values, paired on UTC time",
    parameters: {},
    minimum_points: 3,
    points_used: 22,
    points_excluded: 2,
    provenance: PROVENANCE,
    ...overrides,
  } as StatisticResult;
}

function result(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    mode: "locations",
    criterion: "warmest",
    data_class: "forecast",
    unit_system: "metric",
    provider: "open-meteo",
    statistics_applied: ["temperature_mean: mean"],
    candidates: [],
    excluded: [],
    tie_tolerance: 0.05,
    local_time_basis: true,
    ...overrides,
  } as unknown as ComparisonResult;
}

/** The bar itself, which `Meter` renders as a `meter` named after its label. */
function meterFor(label: string): HTMLElement {
  return screen.getByRole("meter", { name: new RegExp(label, "i") });
}

describe("the correlation bar", () => {
  it("shows the signed coefficient beside a bar whose length is its magnitude", () => {
    render(
      <DeterministicAssociation
        result={result({ correlation: statistic({ value: 0.87 }) })}
      />,
    );
    // The coefficient, not the bar's length as a percentage: 0.87 rather than "87%".
    expect(screen.getByText("0.87")).toBeInTheDocument();
    expect(meterFor("Correlation")).toHaveAttribute("aria-valuetext", "0.87");
    expect(screen.getByText(/move closely together/)).toBeInTheDocument();
  });

  it("says a negative coefficient is negative, because a bar cannot", () => {
    /*
     * The case a magnitude-only bar gets wrong. Two places moving in opposite directions correlate
     * at −0.9, which has the same *length* as +0.9 and the opposite meaning. The sign is in the
     * caption and the direction is in words, so neither reading depends on the other.
     */
    render(
      <DeterministicAssociation
        result={result({ correlation: statistic({ value: -0.9 }) })}
      />,
    );
    expect(screen.getByText("-0.90")).toBeInTheDocument();
    // The bar is 90% long and the figure is negative. A screen reader is told the figure.
    expect(meterFor("Correlation")).toHaveAttribute("aria-valuetext", "-0.90");
    expect(screen.getByText(/move closely opposite/)).toBeInTheDocument();
  });

  it("reads a coefficient near zero as independent rather than as nothing", () => {
    render(
      <DeterministicAssociation
        result={result({ correlation: statistic({ value: 0.05 }) })}
      />,
    );
    expect(screen.getByText(/move largely independently/)).toBeInTheDocument();
  });

  it("draws the backend's reason instead of a bar when the figure is not computable", () => {
    /*
     * Never a zero-length bar: an empty track reads as "measured, and it is nothing", which is a
     * different claim from "could not be measured". The reason is the backend's own words.
     */
    render(
      <DeterministicAssociation
        result={result({
          correlation: statistic({
            status: "not_computable",
            value: null,
            reason:
              "The correlation is undefined: Berlin reported the same value at every instant.",
          }),
        })}
      />,
    );
    expect(
      screen.getByText(/undefined: Berlin reported the same value/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/move closely/)).toBeNull();
  });

  it("says a correlation needs a pair, rather than calling three places not computable", () => {
    /*
     * The backend returns `null` above two candidates and that is deliberate: nothing was attempted,
     * so "not computable" would be a refusal of a question nobody asked. Three places have three
     * pairs and no single coefficient.
     */
    render(
      <DeterministicAssociation
        result={result({
          data_density: statistic({
            statistic: "data_density",
            value: 88,
            unit: "%",
          }),
        })}
      />,
    );
    expect(
      screen.getByText(/describes one pair of places/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not computable/)).toBeNull();
  });

  it("states the method and the points behind a computed coefficient", () => {
    render(
      <DeterministicAssociation
        result={result({ correlation: statistic({}) })}
      />,
    );
    // `specs/deterministic-analytics`: the arithmetic is named wherever the figure is shown.
    expect(screen.getByText(/Pearson correlation/)).toBeInTheDocument();
  });
});

describe("the data-density bar", () => {
  const density = (overrides: Partial<StatisticResult> = {}) =>
    statistic({
      statistic: "data_density",
      value: 91.7,
      unit: "%",
      points_used: 24,
      ...overrides,
    });

  it("shows the percentage and what it is a percentage of", () => {
    render(
      <DeterministicAssociation result={result({ data_density: density() })} />,
    );
    // 91.7 rounds to 92 in the headline; the note says what the 92% is a share *of*, rather than
    // repeating the figure beside itself.
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(
      screen.getByText(/of the window every place reported/),
    ).toBeInTheDocument();
  });

  it("draws a genuine zero as a zero rather than as unavailable", () => {
    /*
     * A provider that answered with nothing is a real, measured 0% — distinct from a window that
     * asked for nothing, which is the not-computable case below. Collapsing the two would hide an
     * empty provider response behind the same blank a misconfiguration produces.
     */
    render(
      <DeterministicAssociation
        result={result({ data_density: density({ value: 0 }) })}
      />,
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText(/Not computable/)).toBeNull();
  });

  it("draws the reason when there was no denominator at all", () => {
    render(
      <DeterministicAssociation
        result={result({
          data_density: density({
            status: "not_computable",
            value: null,
            reason:
              "The window asked for no instants, so there is no denominator.",
          }),
        })}
      />,
    );
    expect(screen.getByText(/no denominator/)).toBeInTheDocument();
  });
});

describe("the panel itself", () => {
  it("is absent when the comparison carried neither figure", () => {
    // A card whose only content is "not available" twice is worse than no card.
    const { container } = render(
      <DeterministicAssociation result={result()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("is present when only one of the two arrived", () => {
    render(
      <DeterministicAssociation
        result={result({
          data_density: statistic({
            statistic: "data_density",
            value: 75,
            unit: "%",
          }),
        })}
      />,
    );
    expect(meterFor("Data density")).toBeInTheDocument();
  });

  it("is badged as analytics, never as an interpretation", () => {
    /*
     * The artifact files these two under "Synthesis confidence", inside a card attributed to a
     * neural agent. They are arithmetic over retrieved data, and the badge has to say so — this is
     * the one screen where the artifact's own framing would have been the wrong data class.
     */
    render(
      <DeterministicAssociation
        result={result({ correlation: statistic({}) })}
      />,
    );
    expect(screen.getByText("ANALYTICS")).toBeInTheDocument();
    expect(screen.queryByText("AI INTERPRETATION")).toBeNull();
  });
});
