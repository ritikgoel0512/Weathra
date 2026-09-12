/**
 * What the evidence console is allowed to claim, and how it arrives at it.
 *
 * The artifact closes on a confidence index, a stability bar, a signature hash and a chain of
 * custody. These cases pin the honest equivalents: a completeness figure that is the arithmetic of
 * listed checks, a state word earned by them, a hash that is called a hash, and a timeline built
 * from timestamps the run recorded.
 */

import { describe, expect, it } from "vitest";

import { auditOf, provenanceOf, recordHash } from "./audit";
import type { RunRecord } from "./record";

function runWith(overrides: Partial<Record<string, unknown>> = {}): RunRecord {
  return {
    id: "run-1",
    requestId: "req-1",
    threadId: null,
    agents: [{ agent: "supervisor", status: "succeeded", started_at: "2026-09-04T06:15:00Z" }],
    tools: [],
    statistics: [],
    anomalies: [],
    trends: [],
    citations: [],
    sources: [],
    answerProse: null,
    answer: null,
    partial: false,
    partialReason: null,
    llmProvider: null,
    llmModel: null,
    timing: { startedAt: "2026-09-04T06:15:00Z", completedAt: "2026-09-04T06:15:04Z", totalDurationMs: 4000, stepsUsed: 1, storedAt: "2026-09-04T06:15:05Z" },
    ...overrides,
  } as unknown as RunRecord;
}

describe("evidence completeness", () => {
  it("is the arithmetic of its own checks, and says so", () => {
    const audit = auditOf(runWith());

    expect(audit.total).toBe(audit.checks.length);
    expect(audit.passed).toBe(audit.checks.filter((check) => check.passed).length);
    expect(audit.completeness).toBe(Math.round((audit.passed / audit.total) * 100));
  });

  it("calls a clean run optimal", () => {
    expect(auditOf(runWith()).state).toBe("Optimal");
  });

  it("degrades a run whose stage failed, not merely marks it partial", () => {
    /*
     * A failed stage means the run did not do what it set out to. That is a different fact from a
     * missing grounding report, and rolling both up to one word would hide the worse one.
     */
    const audit = auditOf(
      runWith({ agents: [{ agent: "historical", status: "failed", started_at: "2026-09-04T06:15:00Z" }] }),
    );

    expect(audit.state).toBe("Degraded");
    expect(audit.checks.find((check) => check.id === "stages")?.passed).toBe(false);
  });

  it("does not penalise a run that produced no prose for having no grounding", () => {
    // There is nothing to ground. Marking it down would make the figure meaningless.
    expect(auditOf(runWith()).checks.find((check) => check.id === "grounding")?.passed).toBe(true);
  });

  it("marks an ungrounded interpretation as failing", () => {
    const audit = auditOf(
      runWith({
        answerProse: "Berlin is warm.",
        answer: { grounding: { verified: false } },
      }),
    );

    expect(audit.checks.find((check) => check.id === "grounding")?.passed).toBe(false);
  });
});

describe("the provenance timeline", () => {
  it("orders the run's own recorded moments", () => {
    const events = provenanceOf(
      runWith({
        agents: [{ agent: "supervisor", status: "succeeded", started_at: "2026-09-04T06:15:01Z" }],
        tools: [{ tool: "weather_forecast", startedAt: "2026-09-04T06:15:02Z", result: { ok: true } }],
      }),
    );

    expect(events.map((event) => event.at)).toEqual([
      "2026-09-04T06:15:00Z",
      "2026-09-04T06:15:01Z",
      "2026-09-04T06:15:02Z",
      "2026-09-04T06:15:04Z",
      "2026-09-04T06:15:05Z",
    ]);
  });
});

describe("the record hash", () => {
  it("is stable regardless of key order, because the input is canonicalised", async () => {
    const one = await recordHash({ b: 2, a: { d: 4, c: 3 } });
    const two = await recordHash({ a: { c: 3, d: 4 }, b: 2 });

    expect(one).not.toBeNull();
    expect(one).toBe(two);
  });

  it("changes when the record changes", async () => {
    expect(await recordHash({ a: 1 })).not.toBe(await recordHash({ a: 2 }));
  });
});
