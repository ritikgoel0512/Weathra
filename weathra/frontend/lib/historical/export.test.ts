/**
 * The CSV export — finding 3.6 of the runtime fidelity audit of 2026-09-08.
 *
 * The properties worth holding are the honesty ones rather than the formatting ones: that a day the
 * archive did not report leaves an empty cell rather than a zero, that the units travel with the
 * columns, and that the file says where its figures came from. A spreadsheet is the one place
 * Weathra's figures end up with no attribution footer beside them, so the preamble is not
 * decoration.
 */

import { describe, expect, it } from "vitest";

import type { HistoryResponse } from "@/lib/api/schema";

import { csvFilenameFor, csvFromHistory, measuresIn } from "./export";

const PERIOD = {
  start_local: "2025-06-01T00:00:00+02:00",
  end_local: "2025-06-03T00:00:00+02:00",
  start_utc: "2025-05-31T22:00:00Z",
  end_utc: "2025-06-02T22:00:00Z",
  timezone: "Europe/Berlin",
};

function history(overrides: Record<string, unknown> = {}): HistoryResponse {
  return {
    location: { display_name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timezone: "Europe/Berlin" },
    provider: "open-meteo",
    units: "metric",
    data_class: "historical_observation",
    requested_period: PERIOD,
    covered_period: PERIOD,
    retrieved_at: "2025-06-10T06:15:00Z",
    partial: false,
    unavailable_note: null,
    daily: {
      granularity: "daily",
      units: { temperature_mean: "°C", precipitation_sum: "mm" },
      entries: [
        {
          time_utc: "2025-05-31T22:00:00Z",
          time_local: "2025-06-01T00:00:00+02:00",
          values: { temperature_mean: 14.2, precipitation_sum: 0 },
        },
        {
          time_utc: "2025-06-01T22:00:00Z",
          time_local: "2025-06-02T00:00:00+02:00",
          // The archive reported neither measure for this day.
          values: { temperature_mean: null, precipitation_sum: null },
        },
      ],
    },
    ...overrides,
  } as unknown as HistoryResponse;
}

function lines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("the exported window", () => {
  it("names every measure the response reported, in the order it reported them", () => {
    expect(measuresIn(history())).toEqual(["temperature_mean", "precipitation_sum"]);
  });

  it("carries each column's unit in its heading", () => {
    const heading = lines(csvFromHistory(history())).find((line) => line.startsWith("date_local"));
    expect(heading).toBe("date_local,temperature_mean (°C),precipitation_sum (mm)");
  });

  it("leaves a day the provider did not report empty, and never as a zero", () => {
    const rows = lines(csvFromHistory(history())).filter((line) => line.startsWith("2025-06-"));

    // A real zero is written as a zero; an absent figure is written as nothing at all.
    expect(rows[0]).toBe("2025-06-01T00:00:00+02:00,14.2,0");
    expect(rows[1]).toBe("2025-06-02T00:00:00+02:00,,");
  });

  it("says where the figures came from, since a file has no attribution footer beside it", () => {
    const csv = csvFromHistory(history());

    expect(csv).toContain("# Provider: open-meteo");
    expect(csv).toContain("# Location: Berlin, Germany");
    expect(csv).toContain("# Units: metric");
    expect(csv).toContain("2025-06-01T00:00:00+02:00 to 2025-06-03T00:00:00+02:00");
    expect(csv).toContain("It is not a zero.");
  });

  it("quotes a field that would otherwise break the row", () => {
    const csv = csvFromHistory(
      history({
        location: { display_name: 'Berlin, "the capital"', latitude: 52.52, longitude: 13.405, timezone: "Europe/Berlin" },
      }),
    );

    expect(csv).toContain('"# Location: Berlin, ""the capital"""');
  });

  it("exports the period the response covered rather than the one that was asked for", () => {
    // The archive's reporting lag makes these differ, and the rows are for the covered one.
    const csv = csvFromHistory(
      history({
        requested_period: { ...PERIOD, end_local: "2025-06-30T00:00:00+02:00" },
      }),
    );

    expect(csv).toContain("to 2025-06-03T00:00:00+02:00");
    expect(csv).not.toContain("2025-06-30");
  });

  it("names the file after the place and the window, so two exports never collide", () => {
    expect(csvFilenameFor(history())).toBe("weathra-berlin-germany-2025-06-01-to-2025-06-03.csv");
  });

  it("still names a file when the response reported no place", () => {
    expect(csvFilenameFor(history({ location: null }))).toContain("weathra-location-");
  });
});
