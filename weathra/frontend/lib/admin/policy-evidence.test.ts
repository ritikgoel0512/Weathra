/**
 * The honesty rules of the policy confirmation surface, tested where they live.
 *
 * Each of these is a rule `specs/evaluation` or `specs/web-ui` states and that a screen would
 * break silently: an unevidenced candidate rendered as a failing one looks like a measurement, a
 * null cost rendered as zero looks like a free model, and a run cited for a candidate it never
 * scored looks like evidence.
 */

import { describe, expect, it } from "vitest";

import type { CatalogObservation, ComparisonResultRecord } from "@/lib/api/schema";

import {
  CANONICAL_CRITERIA,
  candidateEvidence,
  criterionReading,
  failedGates,
  isConfirmationInPlace,
} from "./policy-evidence";

/** The shape `model_evaluations.criteria` actually holds, from the run of 2026-09-10. */
const SCORED: CatalogObservation = {
  gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
  dataset_version: "1.0.0",
  passed: true,
  recorded_at: "2026-09-10T09:38:49Z",
  criteria: {
    structured_json_reliability: true,
    groundedness: true,
    latency: { overall_median_ms: 15815.05, overall_p95_ms: 15815.34, samples: 5 },
    planning: { tool_selection_accuracy: 1.0, plan_correctness: null, multi_step_cases: 0 },
    cost: { currency: "USD", is_estimate: true, estimated_total: null, estimated_per_case: null },
    numerical_accuracy_intact: null,
    promotion_blockers: [],
    measured: {
      structured_json_reliability: {
        decisions: 5,
        attempts: 5,
        first_attempt_valid_rate: 1.0,
        mean_attempts_to_valid: 1.0,
      },
      groundedness: {
        groundedness: 1.0,
        hallucination_rate: 0.0,
        unsupported_weather_claim_rate: 0.0,
      },
    },
  },
};

function cell(catalogKey: string, caseId: string, scored: boolean): ComparisonResultRecord {
  return {
    catalog_key: catalogKey,
    gateway_model: `${catalogKey}-model`,
    case_id: caseId,
    succeeded: scored,
    evaluation_id: scored ? "de0d3f67-75d8-45f8-a7e0-53360e7dd553" : null,
  };
}

const CELLS: ComparisonResultRecord[] = [
  ...["a", "b", "c", "d", "e"].map((id) => cell("economy-free-primary", id, true)),
  ...["a", "b", "c", "d", "e"].map((id) => cell("economy-free-secondary", id, false)),
];

describe("a candidate with a recorded evaluation", () => {
  const evidence = candidateEvidence("economy-free-primary", SCORED, CELLS);

  it("is evidenced, with both gates passed and neither criterion invented", () => {
    expect(evidence.verdict).toBe("evidenced");
    expect(evidence.failedCriteria).toEqual([]);
    expect(evidence.casesScored).toBe(5);
    expect(evidence.casesRun).toBe(5);
    expect(evidence.evidenceFromAnotherRun).toBe(false);
  });

  it("reports all five criteria, in the order the spec names them", () => {
    expect(evidence.criteria.map((criterion) => criterion.name)).toEqual(
      CANONICAL_CRITERIA.map((criterion) => criterion.name),
    );
  });

  it("carries the two gates' verdicts and their figures", () => {
    const reliability = evidence.criteria[0];
    const groundedness = evidence.criteria[1];
    expect(reliability?.passed).toBe(true);
    expect(reliability?.reading).toContain("1.00 valid on the first attempt over 5 structured");
    expect(groundedness?.passed).toBe(true);
    expect(groundedness?.reading).toContain("groundedness 1.00");
    expect(groundedness?.reading).toContain("hallucination rate 0.00");
  });

  it("reports latency as a measurement and not as a verdict", () => {
    const latency = evidence.criteria.find((criterion) => criterion.name === "latency");
    expect(latency?.passed).toBeNull();
    expect(latency?.reading).toContain("15,815 ms");
  });

  it("says a null plan correctness was not measured, rather than showing it as zero", () => {
    const planning = evidence.criteria.find((criterion) => criterion.name === "planning");
    expect(planning?.reading).toContain("tool-selection accuracy 1.00");
    expect(planning?.reading).toContain("plan correctness not measured");
    expect(planning?.reading).not.toContain("0.00 multi-step");
  });

  it("says a null cost was not reported, rather than showing it as free", () => {
    const cost = evidence.criteria.find((criterion) => criterion.name === "cost");
    expect(cost?.reading).toContain("No cost reported by the gateway");
    expect(cost?.reading).not.toMatch(/\b0(\.00)?\s*USD/);
  });
});

describe("a candidate the backend never evaluated", () => {
  const evidence = candidateEvidence("economy-free-secondary", undefined, CELLS);

  it("is unevidenced rather than failed", () => {
    expect(evidence.verdict).toBe("unevidenced");
    expect(evidence.failedCriteria).toEqual([]);
  });

  it("still reports its standing in the run: nothing scored, out of what ran", () => {
    expect(evidence.casesScored).toBe(0);
    expect(evidence.casesRun).toBe(5);
  });

  it("reports no criterion as measured, and none as a verdict", () => {
    expect(evidence.criteria).toHaveLength(5);
    for (const criterion of evidence.criteria) {
      expect(criterion.passed).toBeNull();
      expect(criterion.measured).toBe(false);
      expect(criterion.reading).toContain("Not measured");
    }
  });
});

describe("a candidate evaluated somewhere other than the selected run", () => {
  it("keeps its verdict and flags that this run is not its evidence", () => {
    const elsewhere = candidateEvidence("economy-free-primary", SCORED, [
      ...["a", "b"].map((id) => cell("economy-free-primary", id, false)),
    ]);

    expect(elsewhere.verdict).toBe("evidenced");
    expect(elsewhere.casesScored).toBe(0);
    expect(elsewhere.evidenceFromAnotherRun).toBe(true);
  });
});

describe("the gating criteria", () => {
  it("are read from the recorded blockers where the evaluation named them", () => {
    expect(failedGates({ promotion_blockers: ["groundedness"] })).toEqual(["groundedness"]);
  });

  it("are read from the verdicts where no blocker list was written", () => {
    expect(failedGates({ structured_json_reliability: false, groundedness: true })).toEqual([
      "structured_json_reliability",
    ]);
  });

  it("are empty for an evaluation that passed both", () => {
    expect(failedGates({ structured_json_reliability: true, groundedness: true })).toEqual([]);
  });

  it("make a failing candidate failed rather than unevidenced", () => {
    const failing = candidateEvidence(
      "economy-free-primary",
      { ...SCORED, criteria: { ...SCORED.criteria, groundedness: false, promotion_blockers: ["groundedness"] } },
      CELLS,
    );
    expect(failing.verdict).toBe("failed");
    expect(failing.failedCriteria).toEqual(["groundedness"]);
  });
});

describe("an absent measurement", () => {
  it("is stated as unmeasured for every criterion, with nothing filled in", () => {
    for (const { name, label } of CANONICAL_CRITERIA) {
      const reading = criterionReading(name, label, {});
      if (name === "cost") {
        // Cost is the one that says *why*: the gateway reported none, and a zero would be a claim.
        expect(reading.reading).toContain("No cost reported");
      } else {
        expect(reading.reading).toContain("Not measured");
        expect(reading.measured).toBe(false);
      }
      expect(reading.passed).toBeNull();
    }
  });
});

describe("whether a submission changes anything", () => {
  it("is a confirmation when the order submitted is the order stored", () => {
    expect(isConfirmationInPlace(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("is not a confirmation when the order differs", () => {
    expect(isConfirmationInPlace(["a", "b"], ["b", "a"])).toBe(false);
    expect(isConfirmationInPlace(["a"], ["a", "b"])).toBe(false);
  });
});
