/**
 * Reading the readiness probe's inference line.
 *
 * The rule these cases hold is that every word shown to a person came out of the identifier the
 * backend reported. A lookup table of pretty model names would go stale the moment a deployment
 * changed its model, and a settings page confidently naming a model the backend is not using is
 * worse than one printing an identifier.
 *
 * The identifiers below are deliberately invented. Nothing here recognises a model, so a real one
 * would prove nothing a made-up one does not — and writing a vendor's model name into frontend
 * source is the coupling `test_no_vendor_coupling.py` forbids.
 */

import { describe, expect, it } from "vitest";

import { describeInference, modelLabel } from "./inference";

describe("describeInference", () => {
  it("reads the shape the backend actually writes", () => {
    expect(describeInference("openrouter, model vendor-x/weather-reasoner-9b-v2.")).toEqual({
      provider: "OpenRouter",
      model: "Weather Reasoner 9B v2",
      modelId: "vendor-x/weather-reasoner-9b-v2",
      detail: "openrouter, model vendor-x/weather-reasoner-9b-v2.",
    });
  });

  it("keeps a routing tier in the identifier and out of the name", () => {
    // `:free` is how the request is routed, not what the model is called.
    const found = describeInference("openrouter, model vendor-x/weather-reasoner-32b-v2:free.");
    expect(found.model).toBe("Weather Reasoner 32B v2");
    expect(found.modelId).toBe("vendor-x/weather-reasoner-32b-v2:free");
  });

  it("keeps the sentence when the shape is not the one it knows", () => {
    // A probe whose wording changes must not produce a half-parsed guess.
    const found = describeInference("No inference credential is configured.");
    expect(found.provider).toBeNull();
    expect(found.model).toBeNull();
    expect(found.modelId).toBeNull();
    expect(found.detail).toBe("No inference credential is configured.");
  });

  it("has nothing to say about nothing", () => {
    expect(describeInference(null).detail).toBeNull();
    expect(describeInference(undefined).provider).toBeNull();
  });

  it("title-cases a gateway it does not know rather than claiming a spelling", () => {
    expect(describeInference("somegateway, model x/y-7b.").provider).toBe("Somegateway");
  });
});

describe("modelLabel", () => {
  it("writes a parameter count the way the identifier does", () => {
    expect(modelLabel("vendor-x/weather-reasoner-3.1-70b-instruct")).toBe(
      "Weather Reasoner 3.1 70B Instruct",
    );
  });

  it("leaves a version lowercase", () => {
    expect(modelLabel("vendor-y/granular-v3")).toBe("Granular v3");
  });

  it("reads an active-parameter count as a count", () => {
    expect(modelLabel("vendor-x/weather-reasoner-3-super-120b-a12b:free")).toBe(
      "Weather Reasoner 3 Super 120B A12B",
    );
  });

  it("names a model it has never seen, because it recognises none of them", () => {
    // The point of the generic formatter: a deployment can change its model without a code change.
    expect(modelLabel("nobody/has_shipped-this-yet-1t:nitro")).toBe("Has Shipped This Yet 1T");
  });

  it("never invents a word the identifier does not contain", () => {
    // Every token in the label is a token of the identifier's model name, cased. Nothing is added.
    const label = modelLabel("vendor-x/weather-reasoner-9b-v2");
    expect(label.split(" ").map((word) => word.toLowerCase())).toEqual(
      "weather-reasoner-9b-v2".split("-"),
    );
  });

  it("falls back to the identifier when there is nothing to title", () => {
    expect(modelLabel("vendor/-")).toBe("vendor/-");
  });
});
