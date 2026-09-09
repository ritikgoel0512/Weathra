/**
 * Which account of "what model answered" a surface shows — task 33.6.
 *
 * The backend deliberately returns two, and they can disagree. These assertions fix which one
 * wins, and that nothing is invented when neither says anything.
 */

import { describe, expect, it } from "vitest";

import type { InferenceAttempt } from "@/lib/api/schema";

import { inferenceMetadataFrom, servedAttemptOf } from "./served";

function attempt(overrides: Partial<InferenceAttempt> = {}): InferenceAttempt {
  return {
    stage: "synthesis",
    status: "served",
    attempt_number: 1,
    provider: "openrouter",
    selected_model: "a-policy-model",
    served_model: "a-policy-model",
    catalog_key: "a-policy-model",
    policy_id: "free-synthesis",
    plan: "free",
    resolution_reason: "First enabled candidate of the plan's synthesis policy.",
    latency_ms: 912,
    ...overrides,
  };
}

describe("the attempt that served the answer", () => {
  it("is the synthesis attempt, not the routing one", () => {
    // A run calls a model twice. The prose a person is reading came from the second.
    const attempts = [
      attempt({ stage: "routing", selected_model: "a-router-model", served_model: "a-router-model" }),
      attempt({ stage: "synthesis", selected_model: "a-writer-model", served_model: "a-writer-model" }),
    ];

    expect(servedAttemptOf(attempts)?.selected_model).toBe("a-writer-model");
    expect(inferenceMetadataFrom(attempts)?.model).toBe("a-writer-model");
  });

  it("is the last one that ran when a first attempt failed over", () => {
    const attempts = [
      attempt({ status: "rate_limited", selected_model: "the-first-candidate", served_model: null }),
      attempt({
        attempt_number: 2,
        selected_model: "the-second-candidate",
        served_model: "the-second-candidate",
        resolution_reason: "The first candidate was rate limited.",
      }),
    ];

    const metadata = inferenceMetadataFrom(attempts);
    expect(metadata?.model).toBe("the-second-candidate");
    expect(metadata?.resolutionReason).toBe("The first candidate was rate limited.");
  });

  it("counts an ungrounded answer as served, because the model did answer", () => {
    expect(servedAttemptOf([attempt({ status: "invalid_output" })])).not.toBeNull();
  });

  it("is null when every attempt failed, and null for a run that called no model", () => {
    for (const status of ["rate_limited", "model_unavailable", "provider_error", "timeout", "not_configured"] as const) {
      expect(servedAttemptOf([attempt({ status })]), status).toBeNull();
    }
    expect(servedAttemptOf([])).toBeNull();
    expect(servedAttemptOf(undefined)).toBeNull();
  });

  it("falls back to the routing attempt when that is the only one that served", () => {
    const attempts = [attempt({ stage: "routing" }), attempt({ status: "timeout", served_model: null })];
    expect(servedAttemptOf(attempts)?.stage).toBe("routing");
  });
});

describe("the metadata a surface shows", () => {
  it("comes from the attempt, with the policy that resolved it", () => {
    const metadata = inferenceMetadataFrom([attempt()], {
      provider: "a-configured-provider",
      model: "a-configured-model",
    });

    // Not the configured pair, even though one was supplied: the record is the evidence.
    expect(metadata).toEqual({
      provider: "openrouter",
      model: "a-policy-model",
      requestedModel: null,
      policyId: "free-synthesis",
      catalogKey: "a-policy-model",
      plan: "free",
      resolutionReason: "First enabled candidate of the plan's synthesis policy.",
      stage: "synthesis",
      served: true,
    });
  });

  it("shows the model the gateway served, and says what was asked for", () => {
    const metadata = inferenceMetadataFrom([
      attempt({ selected_model: "asked-for", served_model: "actually-served" }),
    ]);

    expect(metadata?.model).toBe("actually-served");
    expect(metadata?.requestedModel).toBe("asked-for");
  });

  it("falls back to the selected model when the gateway reported none", () => {
    const metadata = inferenceMetadataFrom([attempt({ served_model: null })]);
    expect(metadata?.model).toBe("a-policy-model");
    expect(metadata?.requestedModel).toBeNull();
  });

  it("reports no policy where the record holds none, rather than deriving one", () => {
    const metadata = inferenceMetadataFrom([
      attempt({ policy_id: null, catalog_key: null, plan: null, resolution_reason: null }),
    ]);

    expect(metadata?.policyId).toBeNull();
    expect(metadata?.plan).toBeNull();
    expect(metadata?.resolutionReason).toBeNull();
    expect(metadata?.model).toBe("a-policy-model");
  });

  it("labels the configured pair as configured when no attempt served", () => {
    const metadata = inferenceMetadataFrom([attempt({ status: "timeout" })], {
      provider: "openrouter",
      model: "a-configured-model",
    });

    expect(metadata?.served).toBe(false);
    expect(metadata?.model).toBe("a-configured-model");
    expect(metadata?.policyId).toBeNull();
  });

  it("is null when the backend reported nothing at all", () => {
    expect(inferenceMetadataFrom([], {})).toBeNull();
    expect(inferenceMetadataFrom(undefined, { provider: null, model: "  " })).toBeNull();
  });
});
