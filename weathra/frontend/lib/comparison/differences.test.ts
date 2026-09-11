/**
 * The pairwise arithmetic, and the four cases where it must refuse to produce a number.
 *
 * Every one of those refusals is the same rule from a different angle: a difference is only a
 * figure when both sides are figures, measured the same way, in the same unit. A module that
 * returned a plausible number in any of them would put a wrong reading on a product screen with
 * nothing to mark it as wrong.
 */

import { describe, expect, it } from "vitest";

import { baselineStanding, differencesBetween, windowMeanOf } from "./differences";

function statistic(
  statistic: string,
  measure: string,
  value: number | null,
  unit: string | null,
) {
  return {
    statistic,
    measure,
    value,
    unit,
    method: "arithmetic mean of usable points",
    points_used: 48,
    points_excluded: 0,
    computed: value !== null,
  } as never;
}

function candidate(label: string, supporting: unknown[]) {
  return { label, rank: 1, supporting } as never;
}

describe("the difference between two candidates", () => {
  it("subtracts every statistic both of them reported, in the order given", () => {
    const found = differencesBetween(
      candidate("Berlin", [
        statistic("mean", "temperature_mean", 18.4, "°C"),
        statistic("total", "precipitation_sum", 12.5, "mm"),
      ]),
      candidate("Munich", [
        statistic("mean", "temperature_mean", 16.1, "°C"),
        statistic("total", "precipitation_sum", 18.0, "mm"),
      ]),
    );

    expect(found).toHaveLength(2);
    // Signed, because which way round it is is the whole point of a comparison.
    expect(found[0]?.value).toBeCloseTo(2.3, 5);
    expect(found[1]?.value).toBeCloseTo(-5.5, 5);
    // And both raw figures travel with it, so a screen can state the pair rather than only the gap.
    expect(found[0]?.leading).toBe(18.4);
    expect(found[0]?.trailing).toBe(16.1);
  });

  it("produces nothing for a statistic only one place reported", () => {
    const found = differencesBetween(
      candidate("Berlin", [
        statistic("mean", "temperature_mean", 18.4, "°C"),
        statistic("maximum_gust", "wind_gust_max", 54, "km/h"),
      ]),
      candidate("Munich", [statistic("mean", "temperature_mean", 16.1, "°C")]),
    );

    expect(found.map((entry) => entry.measure)).toEqual(["temperature_mean"]);
  });

  it("refuses a statistic whose two sides are in different units", () => {
    const found = differencesBetween(
      candidate("Berlin", [statistic("mean", "temperature_mean", 65.1, "°F")]),
      candidate("Munich", [statistic("mean", "temperature_mean", 16.1, "°C")]),
    );
    // 65.1 − 16.1 = 49, which is a number and is not a temperature difference.
    expect(found).toEqual([]);
  });

  it("refuses a statistic either side could not compute", () => {
    const found = differencesBetween(
      candidate("Berlin", [statistic("mean", "temperature_mean", 18.4, "°C")]),
      candidate("Munich", [statistic("mean", "temperature_mean", null, "°C")]),
    );
    expect(found).toEqual([]);
  });

  it("produces nothing at all when a candidate is missing", () => {
    expect(differencesBetween(undefined, candidate("Munich", []))).toEqual([]);
  });
});

describe("a window against the years behind it", () => {
  const baseline = {
    mean: { value: 14.7, unit: "°C" },
    standard_deviation: { value: 1.8 },
    years_used: [2021, 2022, 2023],
  };

  it("reads inside the spread as within the usual range", () => {
    const standing = baselineStanding({ value: 15.1, unit: "°C" }, baseline);
    expect(standing?.band).toBe("within");
    expect(standing?.difference).toBeCloseTo(0.4, 5);
    expect(standing?.years).toBe(3);
  });

  it("reads beyond the spread as above or below it, by sign", () => {
    expect(baselineStanding({ value: 18.4, unit: "°C" }, baseline)?.band).toBe("above");
    expect(baselineStanding({ value: 11.2, unit: "°C" }, baseline)?.band).toBe("below");
  });

  it("refuses to read a window against a baseline in another unit", () => {
    expect(baselineStanding({ value: 65.1, unit: "°F" }, baseline)).toBeNull();
  });

  it("refuses when the archive reported no spread to judge against", () => {
    expect(
      baselineStanding({ value: 15.1, unit: "°C" }, { ...baseline, standard_deviation: null }),
    ).toBeNull();
  });
});

describe("the window mean a candidate reported", () => {
  it("accepts either name the backend gives a window's mean temperature", () => {
    expect(
      windowMeanOf(candidate("A", [statistic("mean", "temperature_mean", 18.4, "°C")]))?.value,
    ).toBe(18.4);
    expect(
      windowMeanOf(candidate("A", [statistic("mean", "temperature", 18.4, "°C")]))?.value,
    ).toBe(18.4);
  });

  it("is null where the comparison ranked on something that is not a temperature", () => {
    expect(windowMeanOf(candidate("A", [statistic("total", "precipitation_sum", 12, "mm")]))).toBeNull();
  });
});
