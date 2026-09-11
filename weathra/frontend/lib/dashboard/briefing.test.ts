/**
 * The Dashboard's adapter — task 21.1.
 *
 * The rules that would fabricate a measurement if they broke, asserted directly: an absent measure
 * is dropped rather than zeroed, the unit comes from the response, and no figure gains precision on
 * its way to the screen.
 */

import { describe, expect, it } from "vitest";

import type { PreferenceView, Series } from "@/lib/api/schema";

import {
  briefingLocationFrom,
  calendarWindowFrom,
  forecastDaysFrom,
  formatReading,
  localDateOf,
  dayDetails,
  dayHeadline,
  measureLabel,
  statisticPhrase,
  preferenceSource,
  readingFor,
  readingsFrom,
} from "./briefing";

describe("reading what the provider reported", () => {
  it("keeps every reported measure, with the unit the response declared", () => {
    const readings = readingsFrom(
      { temperature: 18.2, relative_humidity: 72 },
      { temperature: "°C", relative_humidity: "%" },
    );

    expect(readings).toEqual([
      { key: "temperature", label: "Temperature", value: 18.2, unit: "°C" },
      { key: "relative_humidity", label: "Relative humidity", value: 72, unit: "%" },
    ]);
  });

  it("drops an unreported measure rather than showing it as zero", () => {
    // The API is explicit that null means 'not reported' and is never a zero. Rendering it as 0
    // would be a fabricated measurement in the most literal sense.
    const readings = readingsFrom(
      { temperature: 18.2, precipitation: null, uv_index: null },
      { temperature: "°C", precipitation: "mm", uv_index: "" },
    );

    expect(readings.map((reading) => reading.key)).toEqual(["temperature"]);
    expect(readingFor("precipitation", { precipitation: null }, {})).toBeNull();
  });

  it("drops a value that is not a finite number", () => {
    expect(readingsFrom({ a: Number.NaN, b: Number.POSITIVE_INFINITY }, {})).toEqual([]);
  });

  it("says the unit is absent rather than inventing one", () => {
    const [reading] = readingsFrom({ temperature: 18 }, {});
    expect(reading?.unit).toBeNull();
    expect(formatReading({ value: 18, unit: null })).toBe("18");
  });

  it("names a measure it has never seen rather than dropping or guessing at it", () => {
    expect(measureLabel("temperature")).toBe("Temperature");
    expect(measureLabel("soil_moisture_0_to_7cm")).toBe("Soil moisture 0 to 7cm");
  });

  it("adds no precision on the way to the screen", () => {
    expect(formatReading({ value: 18, unit: "°C" })).toBe("18 °C");
    expect(formatReading({ value: 18.25, unit: "°C" })).toBe("18.3 °C");
    expect(formatReading({ value: -3.04, unit: "°C" })).toBe("-3 °C");
    // Never padded out to look more precise than it is.
    expect(formatReading({ value: 72, unit: "%" })).toBe("72 %");
  });
});

describe("the forecast strip", () => {
  const series: Series = {
    granularity: "daily",
    units: { temperature_max: "°C", temperature_min: "°C", precipitation_sum: "mm" },
    entries: [
      {
        time_local: "2026-09-04T00:00:00+02:00",
        time_utc: "2026-09-03T22:00:00Z",
        values: { temperature_max: 21.4, temperature_min: 12.1, precipitation_sum: null },
      },
      {
        time_local: "2026-09-05T00:00:00+02:00",
        time_utc: "2026-09-04T22:00:00Z",
        values: { temperature_max: 24, temperature_min: 14, precipitation_sum: 2.4 },
      },
    ],
  };

  it("reads a row per entry, with its high and its low", () => {
    const days = forecastDaysFrom(series);

    expect(days).toHaveLength(2);
    expect(days[0]?.date).toBe("2026-09-04");
    expect(days[0]?.high?.value).toBe(21.4);
    expect(days[0]?.low?.value).toBe(12.1);
  });

  it("leaves out a measure the provider did not report for that day", () => {
    const days = forecastDaysFrom(series);
    expect(days[0]?.other).toEqual([]);
    expect(days[1]?.other.map((reading) => reading.key)).toEqual(["precipitation_sum"]);
  });

  it("reads the local date as text, so no timezone is re-applied to it", () => {
    // Parsing through Date would show a reader in another zone the wrong calendar day.
    expect(localDateOf("2026-09-04T00:00:00+02:00")).toBe("2026-09-04");
  });

  it("produces no rows at all when the backend sent no entries", () => {
    expect(forecastDaysFrom({ granularity: "daily", units: {} })).toEqual([]);
    expect(forecastDaysFrom(undefined)).toEqual([]);
  });
});

describe("whose briefing this is", () => {
  const preferences: PreferenceView = {
    unit_system: "metric",
    forecast_horizon_days: 7,
    sources: { unit_system: "chosen", default_location: "chosen" },
    default_location: {
      display_name: "Berlin, Germany",
      latitude: 52.52,
      longitude: 13.405,
      timezone: "Europe/Berlin",
    },
  };

  it("uses the saved default location", () => {
    expect(briefingLocationFrom(preferences)?.display_name).toBe("Berlin, Germany");
  });

  it("reports no location rather than choosing one when none is saved", () => {
    // Weathra does not infer a default from use; an unset default is a real state with its own
    // screen.
    expect(briefingLocationFrom({ ...preferences, default_location: null })).toBeNull();
    expect(briefingLocationFrom(undefined)).toBeNull();
  });

  it("carries whether the person chose a preference or Weathra assumed it", () => {
    expect(preferenceSource(preferences, "unit_system")).toBe("chosen");
    expect(preferenceSource(preferences, "nothing_like_this")).toBeNull();
  });
});

describe("the historical window", () => {
  it("is the forecast's own period, in the location's calendar", () => {
    expect(
      calendarWindowFrom({
        start_local: "2026-09-04T00:00:00+02:00",
        end_local: "2026-09-11T00:00:00+02:00",
        start_utc: "2026-09-03T22:00:00Z",
        end_utc: "2026-09-10T22:00:00Z",
        timezone: "Europe/Berlin",
      }),
    ).toEqual({ start: "2026-09-04", end: "2026-09-11" });
  });

  it("asks for nothing when there is no period to ask about", () => {
    expect(calendarWindowFrom(undefined)).toBeNull();
  });
});

describe("statisticPhrase — what a computed figure is called on a consumer screen", () => {
  it("says what the Dashboard used to print as two field names", () => {
    // Observed in production on 2026-09-11: `mean · temperature max`, `range · temperature max`,
    // `probability maximum · precipitation probability max`.
    expect(statisticPhrase("mean", "temperature_max")).toBe("Average high");
    expect(statisticPhrase("range", "temperature_max")).toBe("High temperature range");
    expect(statisticPhrase("probability_maximum", "precipitation_probability_max")).toBe(
      "Peak rain chance",
    );
    expect(statisticPhrase("maximum", "wind_gust_max")).toBe("Strongest gust");
    expect(statisticPhrase("mean", "relative_humidity")).toBe("Average humidity");
  });

  it("never prints an underscore or a bare canonical key", () => {
    for (const [statistic, measure] of [
      ["mean", "temperature_max"],
      ["sum", "precipitation_sum"],
      ["some_new_statistic", "a_new_measure"],
    ] as const) {
      expect(statisticPhrase(statistic, measure)).not.toMatch(/_/);
    }
  });

  it("stays readable for a pair nobody has phrased yet", () => {
    // A statistic the table does not cover still reads as words, never as a key.
    expect(statisticPhrase("mean", "soil_moisture_0_to_7cm")).toBe("Average soil moisture 0 to 7cm");
    expect(statisticPhrase("kurtosis", "temperature_max")).toBe("Kurtosis high");
  });
});

describe("what a forecast card shows first", () => {
  function day(values: Record<string, number>) {
    return forecastDaysFrom({
      granularity: "daily",
      units: {
        temperature_max: "°C",
        temperature_min: "°C",
        precipitation_sum: "mm",
        precipitation_probability_max: "%",
        wind_gust_max: "km/h",
        uv_index_max: "index",
      },
      entries: [{ time_local: "2026-09-11T00:00:00+02:00", time_utc: "2026-09-10T22:00:00Z", values }],
    } as never)[0]!;
  }

  it("keeps the temperatures and the rain on the card, and nothing else", () => {
    // Seven days of every reported measure is fifty-odd figures on a strip whose job is to answer
    // "what are the next few days like".
    const subject = day({
      temperature_max: 21.5,
      temperature_min: 11.6,
      precipitation_sum: 6.4,
      precipitation_probability_max: 63,
      wind_gust_max: 32.4,
      uv_index_max: 4.25,
    });

    expect(dayHeadline(subject).map((reading) => reading.key)).toEqual(["precipitation_sum"]);
    expect(dayDetails(subject).map((reading) => reading.key)).toEqual(
      expect.arrayContaining(["precipitation_probability_max", "wind_gust_max", "uv_index_max"]),
    );
  });

  it("drops nothing — every measure is on the card or behind it, never neither", () => {
    const subject = day({
      temperature_max: 21.5,
      temperature_min: 11.6,
      precipitation_sum: 6.4,
      wind_gust_max: 32.4,
    });
    const shown = [...dayHeadline(subject), ...dayDetails(subject)].map((reading) => reading.key);
    expect([...shown].sort()).toEqual([...subject.other.map((r) => r.key)].sort());
  });

  it("falls back to the chance of rain when no total is reported", () => {
    const subject = day({ temperature_max: 21.5, precipitation_probability_max: 63 });
    expect(dayHeadline(subject).map((reading) => reading.key)).toEqual([
      "precipitation_probability_max",
    ]);
  });
});
