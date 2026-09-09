/**
 * Reading an exhausted allowance off the backend's refusal — task 33.5.
 *
 * The assertions worth having are all about *not* inventing something. A quota state that shows
 * "0 of 0 questions used" because the details were missing, or that treats a gateway rate limit as
 * a plan limit because both are 429s, is worse than a generic error: it is a specific claim about
 * somebody's plan that nothing supports.
 */

import { describe, expect, it } from "vitest";

import { ApiError } from "./client";
import {
  DIMENSION_LABELS,
  QUOTA_EXCEEDED_CODE,
  QUOTA_UNAVAILABLE_CODE,
  limitSentence,
  quotaRefusalFrom,
} from "./quota";

/** The refusal `weathra/entitlements/quotas.py` builds, field for field. */
const DETAILS = {
  dimension: "requests_per_day",
  window: "day",
  allowance: 20,
  consumed: 20,
  resets_at: "2026-09-10T00:00:00+02:00",
  retry_after_seconds: 16_200,
};

const MESSAGE =
  "You have used today's allowance of agent questions. It resets at the start of the next day. " +
  "Forecasts, history, comparisons and analysis are unaffected.";

function exhausted(details: Record<string, unknown> = DETAILS): ApiError {
  return new ApiError(429, {
    code: QUOTA_EXCEEDED_CODE,
    message: MESSAGE,
    details,
    request_id: "req-9",
  });
}

describe("recognising an exhausted allowance", () => {
  it("reads the dimension, window, allowance, consumption and reset from the refusal", () => {
    const refusal = quotaRefusalFrom(exhausted());

    expect(refusal).not.toBeNull();
    expect(refusal?.dimension).toBe("requests_per_day");
    expect(refusal?.window).toBe("day");
    expect(refusal?.allowance).toBe(20);
    expect(refusal?.consumed).toBe(20);
    expect(refusal?.resetsAt).toBe("2026-09-10T00:00:00+02:00");
    expect(refusal?.retryAfterSeconds).toBe(16_200);
    expect(refusal?.message).toBe(MESSAGE);
    expect(refusal?.requestId).toBe("req-9");
  });

  it("is not a gateway rate limit, though both are 429s", () => {
    // The distinction the backend drew on purpose: one is the subscription saying no, the other is
    // the gateway saying not yet. A client that could not tell them apart would retry the first
    // forever, and would tell a person on their plan's limit that a provider was overloaded.
    const rateLimited = new ApiError(429, {
      code: "provider_rate_limited",
      message: "The inference gateway is rate limiting requests.",
      details: null,
      request_id: "req-10",
    });

    expect(quotaRefusalFrom(rateLimited)).toBeNull();
  });

  it("is not an accounting outage, which knows no limit to name", () => {
    const unavailable = new ApiError(503, {
      code: QUOTA_UNAVAILABLE_CODE,
      message: "Usage accounting is unavailable, so the request was refused.",
      details: null,
      request_id: "req-11",
    });

    expect(quotaRefusalFrom(unavailable)).toBeNull();
  });

  it("is not a weather failure, an authentication failure or an unconfigured agent", () => {
    for (const code of [
      "provider_unavailable",
      "token_expired",
      "agent_not_configured",
      "internal_error",
    ]) {
      expect(quotaRefusalFrom({ code, message: "…" }), code).toBeNull();
    }
    expect(quotaRefusalFrom(null)).toBeNull();
    expect(quotaRefusalFrom(new Error("the stream ended"))).toBeNull();
  });

  it("describes a failure that only looks like one, without the class", () => {
    // The same refusal reaches a view as a plain object through a React Query cache and as the
    // fields of a terminal stream event. Both must produce the state.
    const asObject = quotaRefusalFrom({
      code: QUOTA_EXCEEDED_CODE,
      message: MESSAGE,
      details: DETAILS,
      requestId: "req-9",
    });
    expect(asObject?.allowance).toBe(20);
  });
});

describe("what the refusal did not say", () => {
  it("reports an absent figure as unknown rather than as zero", () => {
    const refusal = quotaRefusalFrom(exhausted({ dimension: "requests_per_month" }));

    expect(refusal?.allowance).toBeNull();
    expect(refusal?.consumed).toBeNull();
    expect(refusal?.resetsAt).toBeNull();
    expect(refusal?.retryAfterSeconds).toBeNull();
    // And the sentence is withheld rather than half-written.
    expect(limitSentence(refusal!)).toBeNull();
  });

  it("ignores a figure that is not a usable count", () => {
    const refusal = quotaRefusalFrom(
      exhausted({ ...DETAILS, allowance: "twenty", consumed: -1, retry_after_seconds: Number.NaN }),
    );

    expect(refusal?.allowance).toBeNull();
    expect(refusal?.consumed).toBeNull();
    expect(refusal?.retryAfterSeconds).toBeNull();
  });

  it("ignores a dimension or window it does not recognise", () => {
    const refusal = quotaRefusalFrom(
      exhausted({ ...DETAILS, dimension: "requests_per_fortnight", window: "fortnight" }),
    );

    expect(refusal?.dimension).toBeNull();
    expect(refusal?.window).toBeNull();
    // The figures still stand, so the limit is still named — just not by dimension.
    expect(limitSentence(refusal!)).toBe("20 of 20 this allowance");
  });

  it("falls back to its own sentence only when the backend sent none", () => {
    const refusal = quotaRefusalFrom({ code: QUOTA_EXCEEDED_CODE, message: "  ", details: DETAILS });
    expect(refusal?.message).toBe("Your plan's allowance for this request is used up.");
  });

  it("has a person's label for every dimension the backend can bind", () => {
    // Including `estimated_cost_per_month`, which nothing enforces today: a dimension without a
    // label would reach a person as its identifier.
    for (const [dimension, label] of Object.entries(DIMENSION_LABELS)) {
      expect(label, dimension).not.toBe("");
      expect(label, dimension).not.toContain("_");
    }
  });

  it("names the limit with the dimension's words", () => {
    expect(limitSentence(quotaRefusalFrom(exhausted())!)).toBe("20 of 20 questions today");
    expect(
      limitSentence(
        quotaRefusalFrom(
          exhausted({ ...DETAILS, dimension: "concurrent_runs", window: "concurrent", allowance: 2, consumed: 2 }),
        )!,
      ),
    ).toBe("2 of 2 questions at once");
  });
});
