import { describe, expect, it } from "vitest";

import { forecastDaysFrom, type ForecastDay } from "./briefing";
import { insightsFor } from "./insights";

function days(entries: readonly Record<string, number>[]): ForecastDay[] {
  return forecastDaysFrom({
    granularity: "daily",
    units: {
      temperature_max: "°C",
      temperature_min: "°C",
      precipitation_sum: "mm",
      precipitation_probability_max: "%",
      wind_gust_max: "km/h",
    },
    entries: entries.map((values, index) => ({
      time_utc: `2026-09-${11 + index}T00:00:00Z`,
      time_local: `2026-09-${11 + index}T00:00:00+02:00`,
      values,
    })),
  } as never);
}

describe("what Weathra can say without asking a model", () => {
  it("says nothing at all about an empty window", () => {
    expect(insightsFor([])).toEqual([]);
  });

  it("leads with tomorrow against today, and states the move", () => {
    const insights = insightsFor(days([{ temperature_max: 19 }, { temperature_max: 21.3 }]));
    const first = insights[0]!;
    expect(first.title).toBe("Warmer tomorrow");
    expect(first.value).toBe("+2.3 °C");
    expect(first.direction).toBe("up");
  });

  it("calls two days within half a degree steady rather than inventing a trend", () => {
    const insights = insightsFor(days([{ temperature_max: 19 }, { temperature_max: 19.3 }]));
    expect(insights[0]!.title).toBe("Steady into tomorrow");
    expect(insights[0]!.direction).toBe("flat");
  });

  it("names the day rain is likeliest, by the provider's own probability", () => {
    const insights = insightsFor(
      days([
        { temperature_max: 19, precipitation_probability_max: 10 },
        { temperature_max: 19, precipitation_probability_max: 89 },
      ]),
    );
    const rain = insights.find((insight) => insight.key === "rain-risk")!;
    expect(rain.value).toBe("89%");
    expect(rain.detail).toMatch(/on \w+day/);
  });

  it("says plainly when no rain is forecast, rather than omitting the subject", () => {
    const insights = insightsFor(
      days([
        { temperature_max: 19, precipitation_sum: 0 },
        { temperature_max: 19, precipitation_sum: 0 },
      ]),
    );
    expect(insights.find((insight) => insight.key === "rain-none")?.value).toBe("0 mm");
  });

  it("mentions gusts only when they are actually strong", () => {
    const calm = insightsFor(days([{ temperature_max: 19, wind_gust_max: 20 }, { temperature_max: 19 }]));
    expect(calm.find((insight) => insight.key === "wind")).toBeUndefined();

    const windy = insightsFor(days([{ temperature_max: 19, wind_gust_max: 72 }, { temperature_max: 19 }]));
    expect(windy.find((insight) => insight.key === "wind")?.value).toBe("72 km/h");
  });

  it("reports the baseline difference it was given, and ignores a trivial one", () => {
    const forecast = days([{ temperature_max: 19 }, { temperature_max: 19 }]);
    const warm = insightsFor(forecast, {
      baselineDifference: { value: 3.3, unit: "°C", years: 9 },
    });
    expect(warm.find((insight) => insight.key === "baseline")?.title).toBe("Warmer than usual");
    expect(warm.find((insight) => insight.key === "baseline")?.value).toBe("+3.3 °C");

    const same = insightsFor(forecast, {
      baselineDifference: { value: 0.2, unit: "°C", years: 9 },
    });
    expect(same.find((insight) => insight.key === "baseline")).toBeUndefined();
  });

  it("produces nothing for measures the provider did not report", () => {
    // A window with only temperatures says only what temperatures support.
    const insights = insightsFor(days([{ temperature_max: 19 }, { temperature_max: 22 }]));
    expect(insights.find((insight) => insight.key.startsWith("rain"))).toBeUndefined();
    expect(insights.every((insight) => insight.value.trim().length > 0)).toBe(true);
  });
});
