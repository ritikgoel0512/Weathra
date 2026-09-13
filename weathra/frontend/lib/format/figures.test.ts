/**
 * How a figure is read, and — more importantly — what this pass must never touch.
 *
 * The formatting half of these cases is easy and the guard half is the reason the file exists. A
 * sweep that shortens numbers in prose is one bad lookahead away from rewriting a timestamp, a
 * version, an identifier or a date, and the damage would be silent: the sentence would still read
 * fine and would no longer be true. Every one of those shapes is pinned below.
 */

import { describe, expect, it } from "vitest";

import { formatFigureFor, formatMeasured, formatProse, placesFor } from "./figures";

describe("the precision of a unit", () => {
  it("reads a measurement at the places its unit is read at", () => {
    expect(formatMeasured(20.14285714285714, "°C")).toBe("20.1 °C");
    expect(formatMeasured(6.700000000000001, "mm")).toBe("6.7 mm");
    expect(formatMeasured(18.671428571428574, "km/h")).toBe("18.7 km/h");
    expect(formatMeasured(1011.1607, "hPa")).toBe("1011.2 hPa");
    expect(formatMeasured(70.5000001, "%")).toBe("70.5 %");
    expect(formatMeasured(29.921256, "inHg")).toBe("29.92 inHg");
  });

  it("reads a whole figure as a whole one, without a decimal it did not need", () => {
    expect(formatMeasured(18, "°C")).toBe("18 °C");
    expect(formatMeasured(71, "%")).toBe("71 %");
    expect(formatMeasured(1012, "hPa")).toBe("1012 hPa");
  });

  it("falls back to two places for a unit it does not know, and for none at all", () => {
    expect(placesFor("furlongs")).toBe(2);
    expect(placesFor("")).toBe(2);
    expect(formatMeasured(0.6706849412785952, "")).toBe("0.67");
  });

  it("never reads inHg as an inch", () => {
    expect(placesFor("inHg")).toBe(2);
    expect(placesFor("inch")).toBe(1);
  });

  it("gives the figure alone where the caller sets the unit apart from it", () => {
    expect(formatFigureFor(18.44, "°C")).toBe("18.4");
    expect(formatFigureFor(1011.1607, "hPa")).toBe("1011.2");
  });
});

describe("prose", () => {
  it("shortens every measurement in a sentence and changes nothing else about it", () => {
    expect(
      formatProse(
        "Berlin is running warmer than usual: the mean of 20.142857142857142 °C sits 1.5 °C above the baseline, with 6.700000000000001 mm of rain and gusts to 18.671428571428573 km/h.",
      ),
    ).toBe(
      "Berlin is running warmer than usual: the mean of 20.1 °C sits 1.5 °C above the baseline, with 6.7 mm of rain and gusts to 18.7 km/h.",
    );
  });

  it("keeps the writer's own spacing between a figure and its unit", () => {
    expect(formatProse("70.500000% humidity")).toBe("70.5% humidity");
    expect(formatProse("70.500000 % humidity")).toBe("70.5 % humidity");
  });

  it("reads a measurement that ends a sentence", () => {
    expect(formatProse("It rose by 1.4500000001 °C.")).toBe("It rose by 1.5 °C.");
  });

  it("shortens a sigma to two places, written either way", () => {
    expect(formatProse("a deviation of 0.6706849412785952σ")).toBe("a deviation of 0.67σ");
    expect(formatProse("a deviation of 0.6706849412785952 σ")).toBe("a deviation of 0.67 σ");
  });

  it("shortens a bare float nothing measured to that precision", () => {
    expect(formatProse("the z-score is 0.6706849412785952 for this window")).toBe(
      "the z-score is 0.67 for this window",
    );
  });

  it("leaves a figure a writer chose to give to three places alone", () => {
    expect(formatProse("a threshold of 3.500 and a score of 7.251")).toBe(
      "a threshold of 3.500 and a score of 7.251",
    );
  });

  it("holds a coordinate to four places rather than rounding it to two", () => {
    expect(formatProse("at 52.5200066° north")).toBe("at 52.52° north");
    expect(formatProse("at 13.4049541° east")).toBe("at 13.405° east");
  });

  it("reads a negative measurement, and one already clean", () => {
    expect(formatProse("a low of -5.9000000001 °C and a high of 24.5 °C")).toBe(
      "a low of -5.9 °C and a high of 24.5 °C",
    );
  });
});

describe("what prose formatting must never touch", () => {
  it("leaves a date alone", () => {
    expect(formatProse("Retrieved on 2026-09-13 for 2026-09-10 to 2026-09-17.")).toBe(
      "Retrieved on 2026-09-13 for 2026-09-10 to 2026-09-17.",
    );
  });

  it("leaves a timestamp alone, fractional seconds included", () => {
    const stamp = "Read at 2026-09-13T06:00:00.123456Z, local 08:00:00+02:00.";
    expect(formatProse(stamp)).toBe(stamp);
  });

  it("leaves an identifier and a run reference alone", () => {
    const ids = "Run run-9b5849dd-1a2b, evidence 9B5849DD, model a-model-4.8.2.";
    expect(formatProse(ids)).toBe(ids);
  });

  it("leaves a version and an ordinary number alone", () => {
    expect(formatProse("Version 4.8.2 covered 3 of 10 requested years across 7 days.")).toBe(
      "Version 4.8.2 covered 3 of 10 requested years across 7 days.",
    );
  });

  it("does not read a unit out of the middle of a word", () => {
    expect(formatProse("12.3456789 mmol of something")).toBe("12.35 mmol of something");
    expect(formatProse("6 inches of rain")).toBe("6 inches of rain");
  });

  it("does not treat a bare number in a sentence as a measurement", () => {
    expect(formatProse("2 entries were flagged in 14 days")).toBe(
      "2 entries were flagged in 14 days",
    );
  });

  it("returns a new string and leaves the one it was given untouched", () => {
    const original = "The mean was 20.142857142857142 °C.";
    const rendered = formatProse(original);
    expect(original).toBe("The mean was 20.142857142857142 °C.");
    expect(rendered).not.toBe(original);
  });
});
