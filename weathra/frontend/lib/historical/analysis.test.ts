/**
 * Historical Analytics' reading of a response — task 21.3.
 *
 * The property under test is that nothing here produces a number: a statistic is found or it is
 * absent, a gap stays a gap, and a baseline states the years it actually used.
 */

import { describe, expect, it } from "vitest";

import type { Baseline, Series, StatisticResult } from "@/lib/api/schema";

import {
  baselineMeanOf,
  baselineYearsStatement,
  formatSigned,
  formatStatistic,
  hasValues,
  isComputed,
  missingCount,
  periodLabel,
  pointsFrom,
  statisticFor,
  unavailableReason,
  unitFor,
  yearsBefore,
} from "./analysis";

function statistic(overrides: Partial<StatisticResult> = {}): StatisticResult {
  return {
    statistic: "mean",
    measure: "temperature_mean",
    value: 15.63,
    unit: "°C",
    method: "arithmetic mean of usable points",
    minimum_points: 1,
    points_used: 7,
    points_excluded: 0,
    status: "computed",
    provenance: {} as never,
    ...overrides,
  } as StatisticResult;
}

const SERIES: Series = {
  granularity: "daily",
  units: { temperature_mean: "°C", precipitation_sum: "mm" },
  entries: [
    {
      time_utc: "2025-06-01T00:00:00Z",
      time_local: "2025-06-01T02:00:00+02:00",
      values: { temperature_mean: 14.2, precipitation_sum: 0 },
    },
    {
      time_utc: "2025-06-02T00:00:00Z",
      time_local: "2025-06-02T02:00:00+02:00",
      // The archive did not report this day.
      values: { temperature_mean: null, precipitation_sum: null },
    },
    {
      time_utc: "2025-06-03T00:00:00Z",
      time_local: "2025-06-03T02:00:00+02:00",
      values: { temperature_mean: 17.1, precipitation_sum: 4.6 },
    },
  ],
};

describe("reading a statistic", () => {
  it("finds one by its statistic and measure, and reports none when the backend sent none", () => {
    const results = [statistic(), statistic({ statistic: "maximum", value: 22.1 })];

    expect(statisticFor(results, "mean", "temperature_mean")?.value).toBe(15.63);
    expect(statisticFor(results, "minimum", "temperature_mean")).toBeUndefined();
    expect(statisticFor(undefined, "mean", "temperature_mean")).toBeUndefined();
  });

  it("formats to one decimal place and never invents precision", () => {
    expect(formatStatistic(statistic())).toBe("15.6");
    expect(formatStatistic(statistic({ value: 20 }))).toBe("20");
    expect(formatSigned(statistic({ statistic: "delta", value: 3.24 }))).toBe("+3.2");
    expect(formatSigned(statistic({ statistic: "delta", value: -1.24 }))).toBe("-1.2");
  });

  it("reports a not-computable statistic as such, with the backend's own reason", () => {
    const absent = statistic({ value: null, status: "not_computable", reason: "no usable points" });

    expect(isComputed(absent)).toBe(false);
    expect(formatStatistic(absent)).toBeNull();
    expect(unavailableReason(absent)).toBe("no usable points");
    // And never a zero standing in for a value.
    expect(formatStatistic(absent)).not.toBe("0");
  });

  it("says something honest when the backend sent no result at all", () => {
    expect(unavailableReason(undefined)).toMatch(/reported no result/i);
  });
});

describe("reading a series", () => {
  it("keeps an unreported day as a gap rather than as a value", () => {
    const points = pointsFrom(SERIES);

    expect(points.map((point) => point.date)).toEqual(["2025-06-01", "2025-06-02", "2025-06-03"]);
    expect(points[1]?.values.temperature_mean).toBeNull();
    // Neither dropped nor carried forward: the row is there, and it is empty.
    expect(points).toHaveLength(3);
  });

  it("counts the days the archive did not report", () => {
    expect(missingCount(pointsFrom(SERIES), "temperature_mean")).toBe(1);
    expect(hasValues(pointsFrom(SERIES), "temperature_mean")).toBe(true);
    expect(hasValues(pointsFrom(SERIES), "wind_speed_max")).toBe(false);
  });

  it("takes the unit from the series rather than choosing one", () => {
    expect(unitFor(SERIES, "temperature_mean")).toBe("°C");
    expect(unitFor(SERIES, "wind_speed_max")).toBeNull();
    expect(unitFor(undefined, "temperature_mean")).toBeNull();
  });

  it("reads the local calendar date as text, so no timezone is re-applied", () => {
    expect(pointsFrom(SERIES)[0]?.date).toBe("2025-06-01");
  });
});

describe("reading a baseline", () => {
  function baseline(overrides: Partial<Baseline> = {}): Baseline {
    return {
      years_requested: 10,
      years_used: [2019, 2020, 2021, 2022, 2023, 2024],
      mean: statistic({ value: 14.4 }),
      ...overrides,
    } as Baseline;
  }

  it("states the years it actually used, not the count requested", () => {
    const statement = baselineYearsStatement(baseline());

    expect(statement).toContain("6 years of 10 requested");
    expect(statement).toContain("2019, 2020, 2021, 2022, 2023, 2024");
  });

  it("says so when the archive reported no years rather than showing an empty list", () => {
    expect(baselineYearsStatement(baseline({ years_used: [] }))).toMatch(/reported no years/i);
  });

  it("offers a reference value only when the backend computed one", () => {
    expect(baselineMeanOf(baseline())).toBe(14.4);
    expect(baselineMeanOf(baseline({ mean: statistic({ value: null }) }))).toBeNull();
    expect(baselineMeanOf(undefined)).toBeNull();
  });
});

describe("reading a period", () => {
  it("labels it with the local calendar dates the backend resolved", () => {
    expect(
      periodLabel({ start_local: "2025-06-01T00:00:00+02:00", end_local: "2025-06-07T23:59:00+02:00" }),
    ).toBe("2025-06-01 to 2025-06-07");
    expect(periodLabel(undefined)).toBeNull();
  });

  it("shifts a date by whole years for the form's starting values only", () => {
    expect(yearsBefore("2025-06-01", 1)).toBe("2024-06-01");
    expect(yearsBefore("not-a-date", 1)).toBe("not-a-date");
  });
});
