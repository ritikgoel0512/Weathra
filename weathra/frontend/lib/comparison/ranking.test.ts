/**
 * Compare Cities' reading of a result — task 21.4.
 *
 * The properties under test: that nothing here ranks or scores, that a negated score is never
 * shown as a measurement, and that the two-location rule is decided before a request is made.
 */

import { describe, expect, it } from "vitest";

import type { ComparisonCandidate, ComparisonResult, StatisticResult } from "@/lib/api/schema";

import {
  blockingReason,
  byRank,
  comparableFigure,
  criterionLabel,
  formatStatistic,
  isComposite,
  namedLocations,
  rankedRows,
  tiedRanks,
  weightPercentage,
} from "./ranking";

function statistic(overrides: Partial<StatisticResult> = {}): StatisticResult {
  return {
    statistic: "mean",
    measure: "temperature_mean",
    value: 18.4,
    unit: "°C",
    method: "arithmetic mean of usable points",
    minimum_points: 1,
    points_used: 5,
    status: "computed",
    provenance: {} as never,
    ...overrides,
  } as StatisticResult;
}

function candidate(overrides: Partial<ComparisonCandidate> = {}): ComparisonCandidate {
  return {
    label: "Berlin",
    location: { display_name: "Berlin", latitude: 52.5, longitude: 13.4, timezone: "Europe/Berlin" },
    period: {} as never,
    rank: 1,
    score: 18.4,
    supporting: [statistic()],
    ...overrides,
  } as ComparisonCandidate;
}

function result(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    mode: "locations",
    criterion: "warmest",
    data_class: "forecast",
    period: {} as never,
    unit_system: "metric",
    provider: "open-meteo",
    statistics_applied: ["temperature_mean: mean"],
    candidates: [candidate()],
    tie_tolerance: 0.1,
    ...overrides,
  } as ComparisonResult;
}

describe("the criteria", () => {
  it("names every criterion the backend supports, and titles an unknown one from itself", () => {
    expect(criterionLabel("warmest")).toBe("Warmest");
    expect(criterionLabel("outdoor_suitability")).toBe("Best for being outdoors");
    expect(criterionLabel("least_windy")).toBe("Least windy");
    expect(criterionLabel("stillest_air")).toBe("Stillest air");
  });
});

describe("the comparable figure", () => {
  it("is the supporting statistic's own value for a single-measure criterion", () => {
    expect(comparableFigure(candidate())).toEqual({
      value: 18.4,
      unit: "°C",
      label: "temperature mean",
    });
  });

  it("never shows the negated score a lower-is-better criterion produces", () => {
    // The backend scores "driest" as -total so that higher always ranks better. The figure a
    // reader sees is the total itself; a negative rainfall would be a measurement that cannot exist.
    const driest = candidate({
      score: -4.6,
      supporting: [statistic({ statistic: "total", measure: "precipitation_sum", value: 4.6, unit: "mm" })],
    });

    expect(comparableFigure(driest)).toEqual({ value: 4.6, unit: "mm", label: "precipitation sum" });
  });

  it("is the 0-1 score for a composite criterion, which is comparable as it stands", () => {
    const composite = candidate({
      score: 0.82,
      contributions: [
        {
          measure: "temperature_mean",
          value: 21,
          unit: "°C",
          direction: "above",
          weight: 0.5,
          contribution: 0.45,
          supporting: statistic(),
        },
      ],
    });

    expect(isComposite(composite)).toBe(true);
    expect(comparableFigure(composite)).toEqual({
      value: 0.82,
      unit: null,
      label: "Outdoor-suitability score (0–1)",
    });
  });

  it("reports no figure when the backend computed no value, rather than substituting the score", () => {
    const absent = candidate({
      score: 3,
      supporting: [statistic({ value: null, status: "not_computable", reason: "no usable points" })],
    });

    expect(comparableFigure(absent)).toBeNull();
  });
});

describe("the ranking", () => {
  it("keeps the backend's order and its shared ranks", () => {
    const ranked = result({
      candidates: [
        candidate({ label: "Munich", rank: 2, score: 16.1, supporting: [statistic({ value: 16.1 })] }),
        candidate({ label: "Berlin", rank: 1 }),
        candidate({ label: "Aachen", rank: 1, tied: true, supporting: [statistic({ value: 18.45 })] }),
      ],
    });

    expect(byRank(ranked).map((entry) => entry.label)).toEqual(["Aachen", "Berlin", "Munich"]);
    expect([...tiedRanks(ranked)]).toEqual([1]);
  });

  it("builds chart rows from the measured figures, in rank order", () => {
    const ranked = result({
      candidates: [
        candidate({ label: "Munich", rank: 2, supporting: [statistic({ value: 16.1 })] }),
        candidate({ label: "Berlin", rank: 1 }),
      ],
    });

    const { rows, unit, label } = rankedRows(ranked);
    expect(rows.map((row) => row.label)).toEqual(["Berlin", "Munich"]);
    expect(rows.map((row) => row.value)).toEqual([18.4, 16.1]);
    expect(unit).toBe("°C");
    expect(label).toBe("temperature mean");
  });

  it("leaves a candidate with no figure out of the chart rather than plotting a zero", () => {
    const ranked = result({
      candidates: [
        candidate({ label: "Berlin", rank: 1 }),
        candidate({
          label: "Munich",
          rank: 2,
          supporting: [statistic({ value: null, status: "not_computable", reason: "none" })],
        }),
      ],
    });

    expect(rankedRows(ranked).rows.map((row) => row.label)).toEqual(["Berlin"]);
  });

  it("formats a statistic with its unit, and reports an absent one as absent", () => {
    expect(formatStatistic(statistic())).toBe("18.4 °C");
    expect(formatStatistic(statistic({ value: 20 }))).toBe("20 °C");
    expect(formatStatistic(statistic({ value: null }))).toBeNull();
    expect(formatStatistic(undefined)).toBeNull();
  });

  it("states a weight as a share of the whole score", () => {
    expect(weightPercentage(0.5)).toBe("50%");
    expect(weightPercentage(0.25)).toBe("25%");
  });
});

describe("what may be sent", () => {
  it("blocks a comparison of fewer than two places, before any request", () => {
    expect(blockingReason([])).toMatch(/at least two locations/);
    expect(blockingReason(["Berlin"])).toMatch(/at least two locations/);
    expect(blockingReason(["Berlin", "   "])).toMatch(/at least two locations/);
  });

  it("blocks a place compared with itself", () => {
    expect(blockingReason(["Berlin", "berlin"])).toMatch(/listed twice/);
  });

  it("allows two or more distinct places", () => {
    expect(blockingReason(["Berlin", "Munich"])).toBeNull();
    expect(blockingReason(["Berlin", "Munich", "Hamburg"])).toBeNull();
  });

  it("sends only the rows that name something", () => {
    expect(namedLocations([" Berlin ", "", "Munich", "  "])).toEqual(["Berlin", "Munich"]);
  });
});
