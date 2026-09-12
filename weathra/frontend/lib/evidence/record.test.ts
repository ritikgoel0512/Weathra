/**
 * The two presentation rules an evidence record needs and cannot get from the backend.
 *
 * Both exist because the *stored* record is right and the *rendered* one was not: a model repeats a
 * figure with every digit of the double it was given, and a run that computes through the tool
 * boundary records its statistics somewhere the analytics band was not looking.
 */

import { describe, expect, it } from "vitest";

import { figuresFromTools, readableProse, type RunRecord } from "./record";

describe("prose a person can read", () => {
  it("trims the float tail a model repeats from its input", () => {
    expect(readableProse("The mean was 21.457142857142856 °C.")).toBe("The mean was 21.5 °C.");
    expect(readableProse("a range of 8.299999999999997 °C")).toBe("a range of 8.3 °C");
  });

  it("leaves anything that is not a long decimal alone", () => {
    /*
     * The threshold is what makes this safe to run over stored prose: three decimals or more. A
     * date, an identifier, a version and a figure already written to two places all pass through,
     * because none of them carries a tail.
     */
    for (const untouched of [
      "on 2026-09-04 the archive answered",
      "request req_7fefc1 completed",
      "a relevance of 0.81",
      "1.5 °C above the baseline",
      "version 2.15 of the corpus",
    ]) {
      expect(readableProse(untouched)).toBe(untouched);
    }
  });

  it("changes nothing when there is nothing to change", () => {
    expect(readableProse("No figures here at all.")).toBe("No figures here at all.");
  });
});

/** A record carrying only what these helpers read. */
function recordWith(tools: unknown[]): RunRecord {
  return { tools } as unknown as RunRecord;
}

describe("figures a run recorded through its tools", () => {
  it("recovers what a computed-statistic result returned", () => {
    const figures = figuresFromTools(
      recordWith([
        {
          sequence: 3,
          tool: "weather_statistics",
          result: { ok: true, data_class: "computed_statistic" },
          resultFields: [
            { name: "mean_temperature", value: "21.5" },
            { name: "difference", value: "2.2" },
          ],
        },
      ]),
    );

    expect(figures.map((figure) => figure.label)).toEqual(["mean temperature", "difference"]);
    expect(figures[0]?.value).toBe("21.5");
    // Every figure names where it came from, so a reader sees a recovered payload for what it is.
    expect(figures[0]?.tool).toBe("weather_statistics");
  });

  it("ignores a retrieval, because retrieved data is not a statistic", () => {
    const figures = figuresFromTools(
      recordWith([
        {
          sequence: 1,
          tool: "weather_forecast",
          result: { ok: true, data_class: "forecast" },
          resultFields: [{ name: "hourly", value: "24 entries" }],
        },
      ]),
    );

    expect(figures).toEqual([]);
  });

  it("ignores a failed call, which returned no figure to recover", () => {
    const figures = figuresFromTools(
      recordWith([
        {
          sequence: 2,
          tool: "weather_statistics",
          result: { ok: false, data_class: "computed_statistic" },
          resultFields: [{ name: "mean", value: "1" }],
        },
      ]),
    );

    expect(figures).toEqual([]);
  });
});
