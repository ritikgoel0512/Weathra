/**
 * What Forecast Explorer reads out of its responses — the decisions a rendered-markup test misses.
 *
 * Two of these are wrong in ways that look right on screen: a label that shifts an instant into the
 * reader's own timezone shows a plausible hour for the wrong moment, and a sampling rule that drops
 * the wettest period shows a plausible table of the wrong rows.
 */

import { describe, expect, it } from "vitest";

import type { AnalysisResponse, SeriesEntry } from "@/lib/api/schema";

import { coverageOf, hourLabel, localLabel, matrixRows, trendSignals } from "./reading";

function entry(timeLocal: string, values: Record<string, number | null> = {}): SeriesEntry {
  return {
    time_local: timeLocal,
    time_utc: timeLocal,
    values,
  } as unknown as SeriesEntry;
}

describe("a provider instant, as a person reads it", () => {
  it("names the weekday and the hour the provider stated", () => {
    expect(localLabel("2026-09-10T08:00:00+02:00")).toBe("Thu 08:00");
    expect(hourLabel("2026-09-10T08:00:00+02:00")).toBe("08:00");
  });

  it("reads the hour at the place, not the hour where the reader is sitting", () => {
    /*
     * The whole reason this is parsed textually. `time_local` is eight in the morning *in Berlin*;
     * `new Date(...)` and a locale format would render eight in the morning wherever the browser
     * is, which is a different moment. Two offsets, same wall-clock reading, same label.
     */
    expect(localLabel("2026-09-10T08:00:00+02:00")).toBe(
      localLabel("2026-09-10T08:00:00-07:00"),
    );
  });

  it("says nothing rather than half of something", () => {
    expect(localLabel("not a timestamp")).toBeNull();
    expect(localLabel(null)).toBeNull();
    expect(hourLabel(undefined)).toBeNull();
  });
});

describe("the rows the matrix leads with", () => {
  it("returns every entry when there are few enough to show", () => {
    const entries = [entry("2026-09-10T08:00:00+02:00"), entry("2026-09-10T12:00:00+02:00")];
    expect(matrixRows(entries)).toHaveLength(2);
  });

  it("samples the readable hours across the days, in order, and caps the row count", () => {
    // Four days of six-hourly entries: 16 in, no more than 8 out.
    const entries = ["10", "11", "12", "13"].flatMap((day) =>
      ["00", "06", "12", "18"].map((hour) => entry(`2026-09-${day}T${hour}:00:00+02:00`)),
    );

    const rows = matrixRows(entries);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.length).toBeGreaterThan(0);

    // In order, and every row an entry the provider actually sent.
    const stamps = rows.map((row) => row.time_local);
    expect([...stamps].sort()).toEqual(stamps);
    for (const row of rows) expect(entries).toContain(row);
  });

  it("still returns real rows when the stamps are not a shape it can read", () => {
    const entries = Array.from({ length: 12 }, (_, index) => entry(`entry-${index}`));
    const rows = matrixRows(entries);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(entries).toContain(row);
  });
});

describe("the trend signals", () => {
  function analysis(findings: unknown[]): AnalysisResponse {
    return { findings, summary: "x" } as unknown as AnalysisResponse;
  }

  it("phrases the computed statistics, at most three of them", () => {
    const signals = trendSignals(
      analysis([
        { measure: "temperature_max", statistic: "maximum", value: 24.53, unit: "°C" },
        { measure: "temperature_min", statistic: "minimum", value: 9.7, unit: "°C" },
        { measure: "precipitation_sum", statistic: "total", value: 12.5, unit: "mm" },
        { measure: "wind_gust_max", statistic: "maximum_gust", value: 45, unit: "km/h" },
      ]),
    );

    expect(signals).toHaveLength(3);
    expect(signals[0]?.text).toBe("Warmest point of the window reaches 24.5 °C");
    expect(signals[2]?.text).toBe("12.5 mm of precipitation forecast across the window");
  });

  it("says nothing about a statistic the analysis did not compute", () => {
    const signals = trendSignals(
      analysis([{ measure: "temperature_max", statistic: "maximum", value: null, unit: "°C" }]),
    );
    expect(signals).toEqual([]);
    expect(trendSignals(null)).toEqual([]);
  });
});

describe("data coverage", () => {
  it("counts entries carrying a value over entries returned", () => {
    const entries = [
      entry("2026-09-10T08:00:00+02:00", { temperature: 14.8 }),
      entry("2026-09-10T12:00:00+02:00", { temperature: null }),
      entry("2026-09-10T16:00:00+02:00", { temperature: 19.5 }),
    ];
    expect(coverageOf(entries, "temperature")).toEqual({ reported: 2, total: 3 });
  });

  it("measures nothing on an empty series rather than scoring it zero", () => {
    expect(coverageOf([], "temperature")).toEqual({ reported: 0, total: 0 });
  });
});
