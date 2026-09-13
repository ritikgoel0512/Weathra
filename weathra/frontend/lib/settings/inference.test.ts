/**
 * Reading the readiness probe's inference line.
 *
 * The rule these cases hold is that every word shown to a person came out of the identifier the
 * backend reported. A lookup table of pretty model names would go stale the moment a deployment
 * changed its model, and a settings page confidently naming a model the backend is not using is
 * worse than one printing an identifier.
 */

import { describe, expect, it } from "vitest";

import { describeInference, modelLabel } from "./inference";

describe("describeInference", () => {
  it("reads the shape the backend actually writes", () => {
    expect(describeInference("openrouter, model nvidia/nemotron-nano-9b-v2.")).toEqual({
      provider: "OpenRouter",
      model: "NVIDIA Nemotron Nano 9B v2",
      modelId: "nvidia/nemotron-nano-9b-v2",
      detail: "openrouter, model nvidia/nemotron-nano-9b-v2.",
    });
  });

  it("keeps a routing tier in the identifier and out of the name", () => {
    // `:free` is how the request is routed, not what the model is called.
    const found = describeInference("openrouter, model nvidia/nemotron-3-super-120b-a12b:free.");
    expect(found.model).toBe("NVIDIA Nemotron 3 Super 120B A12B");
    expect(found.modelId).toBe("nvidia/nemotron-3-super-120b-a12b:free");
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
    expect(describeInference("together, model x/y-7b.").provider).toBe("Together");
  });
});

describe("modelLabel", () => {
  it("writes a parameter count the way the identifier does", () => {
    expect(modelLabel("meta/llama-3.1-70b-instruct")).toBe("Meta Llama 3.1 70B Instruct");
  });

  it("leaves a version lowercase and uppercases a short vendor token", () => {
    expect(modelLabel("ibm/granite-v3")).toBe("IBM Granite v3");
  });

  it("never invents a word the identifier does not contain", () => {
    // Every token in the label is a token of the identifier, cased. Nothing is added.
    const label = modelLabel("nvidia/nemotron-nano-9b-v2");
    const source = "nvidia/nemotron-nano-9b-v2".split(/[/\-_]/);
    expect(label.split(" ").map((word) => word.toLowerCase())).toEqual(source);
  });
});
