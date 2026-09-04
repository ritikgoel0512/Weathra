/**
 * The data-class mapping and the three provenance tiers — task 20.15.
 *
 * Two properties, and both would fail silently if they broke. The mapping is what stops a screen
 * calling a language model's prose a measurement, so it is asserted value by value against the
 * backend's own `DataClass` union rather than by spot check. The tiers are what the presentation
 * layer uses to keep retrieved data, deterministic calculation and model-written language apart.
 */

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_LEVELS,
  DATA_CLASS_BY_API,
  confidenceLevelFor,
  dataClassFor,
  isComputed,
  isInterpretation,
  isRetrieved,
  tierOf,
} from "./data-class";
import { DATA_CLASS_NAMES } from "./tokens";

/** The backend's `DataClass` union, mirrored from `lib/api/schema.ts`. */
const API_DATA_CLASSES = [
  "current",
  "forecast",
  "historical_observation",
  "computed_statistic",
  "ai_interpretation",
] as const;

describe("the backend's classes and the design's badges", () => {
  it("maps every class the backend can report", () => {
    for (const value of API_DATA_CLASSES) {
      expect(dataClassFor(value), value).not.toBeNull();
    }
    expect(Object.keys(DATA_CLASS_BY_API)).toHaveLength(API_DATA_CLASSES.length);
  });

  it("maps each one to the class the design system badges", () => {
    expect(dataClassFor("current")).toBe("observed");
    expect(dataClassFor("forecast")).toBe("forecast");
    expect(dataClassFor("historical_observation")).toBe("historical");
    expect(dataClassFor("computed_statistic")).toBe("analytics");
    expect(dataClassFor("ai_interpretation")).toBe("interpretation");
  });

  it("keeps a forecast and a historical observation apart", () => {
    // A past value shown as a forecast, or the reverse, is the mislabelling that matters most.
    expect(dataClassFor("forecast")).not.toBe(dataClassFor("historical_observation"));
  });

  it("reaches every badge the design system defines, and invents none", () => {
    expect(new Set(Object.values(DATA_CLASS_BY_API))).toEqual(new Set(DATA_CLASS_NAMES));
  });

  it("refuses to guess at anything it does not recognise", () => {
    // An unlabelled figure is recoverable; a wrongly labelled one is not.
    for (const value of ["", "observation", "ai", "AI_INTERPRETATION", null, undefined]) {
      expect(dataClassFor(value as string | null | undefined), String(value)).toBeNull();
    }
  });
});

describe("who produced a figure", () => {
  it("puts every provider-supplied class in the retrieved tier", () => {
    for (const dataClass of ["observed", "forecast", "historical"] as const) {
      expect(tierOf(dataClass), dataClass).toBe("retrieved");
      expect(isRetrieved(dataClass), dataClass).toBe(true);
      expect(isComputed(dataClass), dataClass).toBe(false);
      expect(isInterpretation(dataClass), dataClass).toBe(false);
    }
  });

  it("puts analytics in its own tier: Weathra computed it, no provider supplied it", () => {
    expect(tierOf("analytics")).toBe("computed");
    expect(isComputed("analytics")).toBe(true);
    expect(isRetrieved("analytics")).toBe(false);
    expect(isInterpretation("analytics")).toBe(false);
  });

  it("puts interpretation alone, and never in a tier that produced a number", () => {
    expect(tierOf("interpretation")).toBe("interpretation");
    expect(isInterpretation("interpretation")).toBe(true);
    expect(isRetrieved("interpretation")).toBe(false);
    expect(isComputed("interpretation")).toBe(false);
  });

  it("gives every class exactly one tier", () => {
    for (const dataClass of DATA_CLASS_NAMES) {
      expect(["retrieved", "computed", "interpretation"], dataClass).toContain(tierOf(dataClass));
    }
  });
});

describe("confidence bands", () => {
  it("recognises the three the backend reports", () => {
    for (const level of CONFIDENCE_LEVELS) {
      expect(confidenceLevelFor(level), level).toBe(level);
    }
  });

  it("has no band between them, and refuses anything else", () => {
    // Weathra reads one provider's output; a percentage would be precision it does not have.
    expect(CONFIDENCE_LEVELS).toHaveLength(3);
    for (const value of ["0.82", "82%", "very high", "", null, undefined]) {
      expect(confidenceLevelFor(value as string | null | undefined), String(value)).toBeNull();
    }
  });
});
