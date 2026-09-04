/**
 * Reading a stored run out of the evidence response — task 21.5.
 *
 * The two columns the endpoint returns are opaque objects in the OpenAPI document, so the risk this
 * module carries is not a wrong type: it is a *plausible* one. A reader of an evidence record must
 * be able to trust that a duration on screen was measured, that a provider named was used, and that
 * a tool row happened. So the assertions below are mostly about absence — that a field the backend
 * did not send arrives as `null` rather than as a default, and that a row that is not a run record
 * is refused outright rather than rendered with blanks.
 */

import { describe, expect, it } from "vitest";

import type { EvidenceResponse } from "@/lib/api/schema";

import {
  describeStoredValue,
  fieldsOf,
  formatDurationMs,
  hasAnalytics,
  runRecordFrom,
  runStatusOf,
} from "./record";

const STARTED = "2026-09-04T09:04:55Z";
const COMPLETED = "2026-09-04T09:04:59Z";

function response(overrides: Partial<EvidenceResponse> = {}): EvidenceResponse {
  return {
    id: "run-1",
    request_id: "req-77",
    thread_id: "thread-3",
    question: "How warm will it be tomorrow?",
    answer_prose: "The provider's forecast puts tomorrow's mean at 15.6 °C.",
    envelope: {},
    evidence: {
      request_id: "req-77",
      question: "How warm will it be tomorrow?",
      started_at: STARTED,
      completed_at: COMPLETED,
      total_duration_ms: 4210,
    },
    llm_provider: "openrouter",
    llm_model: "a-model",
    weather_provider: "open-meteo",
    duration_ms: 4210,
    partial: false,
    created_at: "2026-09-04T09:05:00Z",
    ...overrides,
  } as EvidenceResponse;
}

describe("runRecordFrom", () => {
  it("reads the run's identity, timing and providers from the stored record", () => {
    const record = runRecordFrom(response());

    expect(record).not.toBeNull();
    expect(record?.id).toBe("run-1");
    expect(record?.requestId).toBe("req-77");
    expect(record?.threadId).toBe("thread-3");
    expect(record?.timing.startedAt).toBe(STARTED);
    expect(record?.timing.completedAt).toBe(COMPLETED);
    expect(record?.timing.totalDurationMs).toBe(4210);
    expect(record?.llmProvider).toBe("openrouter");
    expect(record?.weatherProvider).toBe("open-meteo");
  });

  it("refuses a row whose stored evidence is not a run record", () => {
    expect(runRecordFrom(response({ evidence: {} }))).toBeNull();
    expect(runRecordFrom(response({ evidence: null as never }))).toBeNull();
    expect(
      runRecordFrom(response({ evidence: { request_id: "req-77", question: "q" } })),
    ).toBeNull();
  });

  it("reports an unsent field as absent rather than supplying a default", () => {
    const record = runRecordFrom(
      response({
        llm_provider: null,
        llm_model: null,
        weather_provider: null,
        thread_id: null,
        answer_prose: null,
        envelope: null as never,
      }),
    );

    expect(record?.llmProvider).toBeNull();
    expect(record?.llmModel).toBeNull();
    expect(record?.weatherProvider).toBeNull();
    expect(record?.threadId).toBeNull();
    expect(record?.answerProse).toBeNull();
    expect(record?.answer).toBeNull();
    expect(record?.timing.stepsUsed).toBeNull();
    expect(record?.agents).toEqual([]);
    expect(record?.tools).toEqual([]);
    expect(record?.sources).toEqual([]);
    expect(record?.citations).toEqual([]);
  });

  it("puts the agent steps in execution order whatever order they were stored in", () => {
    const record = runRecordFrom(
      response({
        evidence: {
          ...response().evidence,
          agents: [
            { sequence: 3, agent: "synthesis", status: "succeeded", duration_ms: 1200 },
            { sequence: 1, agent: "supervisor", status: "succeeded", duration_ms: 120 },
            { sequence: 2, agent: "forecast", status: "failed", duration_ms: 40 },
          ],
        },
      }),
    );

    expect(record?.agents.map((step) => step.agent)).toEqual([
      "supervisor",
      "forecast",
      "synthesis",
    ]);
  });

  it("pairs each tool call with the result that answered it, on the backend's sequence", () => {
    const record = runRecordFrom(
      response({
        evidence: {
          ...response().evidence,
          tool_calls: [
            {
              sequence: 2,
              tool: "weather_statistics",
              agent: "analytics",
              arguments: { statistic: "mean" },
              started_at: STARTED,
              duration_ms: 610,
            },
            {
              sequence: 1,
              tool: "weather_forecast",
              agent: "forecast",
              arguments: { latitude: 52.52 },
              started_at: STARTED,
              duration_ms: 850,
            },
          ],
          tool_results: [
            { sequence: 1, tool: "weather_forecast", ok: true, data_class: "forecast", payload: { hourly: [1, 2] } },
            { sequence: 2, tool: "weather_statistics", ok: false, error_code: "provider_timeout" },
          ],
        },
      }),
    );

    expect(record?.tools.map((activity) => activity.sequence)).toEqual([1, 2]);
    expect(record?.tools[0]?.tool).toBe("weather_forecast");
    expect(record?.tools[0]?.result?.ok).toBe(true);
    expect(record?.tools[0]?.argumentFields).toEqual([{ name: "latitude", value: "52.52" }]);
    expect(record?.tools[1]?.result?.error_code).toBe("provider_timeout");
  });

  it("keeps a call whose result was never recorded, and a result whose call was not", () => {
    const record = runRecordFrom(
      response({
        evidence: {
          ...response().evidence,
          tool_calls: [
            { sequence: 1, tool: "weather_forecast", agent: "forecast", duration_ms: 10 },
          ],
          tool_results: [{ sequence: 5, tool: "weather_history", ok: false, error_code: "x" }],
        },
      }),
    );

    expect(record?.tools).toHaveLength(2);
    expect(record?.tools[0]?.result).toBeNull();
    expect(record?.tools[1]?.call).toBeNull();
    expect(record?.tools[1]?.tool).toBe("weather_history");
  });

  it("reads the answer envelope's resolved context, grounding and uncertainty", () => {
    const record = runRecordFrom(
      response({
        envelope: {
          resolved: { locations: [{ display_name: "Berlin, Germany" }], location_source: "preferences" },
          grounding: { verified: true, method: "exact match", figures_checked: 2 },
          uncertainty: { basis: "One provider's output.", horizon: [{ confidence: "high" }] },
          unanswered_parts: ["the second half of the question"],
        },
      }),
    );

    expect(record?.answer?.resolved?.location_source).toBe("preferences");
    expect(record?.answer?.grounding?.verified).toBe(true);
    expect(record?.answer?.uncertainty?.basis).toBe("One provider's output.");
    expect(record?.answer?.unansweredParts).toEqual(["the second half of the question"]);
  });
});

describe("runStatusOf", () => {
  it("reports a complete run as complete", () => {
    const record = runRecordFrom(response());
    expect(record && runStatusOf(record)).toEqual({ label: "Complete", tone: "ok", reason: null });
  });

  it("reports a partial run with the bound the backend named", () => {
    const record = runRecordFrom(
      response({
        partial: true,
        evidence: {
          ...response().evidence,
          partial: true,
          partial_reason: "the step budget was exhausted",
        },
      }),
    );

    expect(record && runStatusOf(record)).toEqual({
      label: "Partial",
      tone: "warning",
      reason: "the step budget was exhausted",
    });
  });
});

describe("formatDurationMs", () => {
  it("keeps the backend's own resolution and never rounds up into a rounder figure", () => {
    expect(formatDurationMs(120)).toBe("120 ms");
    expect(formatDurationMs(999)).toBe("999 ms");
    expect(formatDurationMs(1000)).toBe("1.0 s");
    expect(formatDurationMs(4210)).toBe("4.2 s");
    expect(formatDurationMs(0)).toBe("0 ms");
  });

  it("returns null rather than a zero for a duration that was not recorded", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(Number.NaN)).toBeNull();
    expect(formatDurationMs(-1)).toBeNull();
  });
});

describe("describeStoredValue and fieldsOf", () => {
  it("prints a scalar exactly as it was stored", () => {
    expect(describeStoredValue(52.52)).toBe("52.52");
    expect(describeStoredValue("metric")).toBe("metric");
    expect(describeStoredValue(false)).toBe("false");
  });

  it("describes a collection by its size rather than reproducing it", () => {
    expect(describeStoredValue([1, 2, 3])).toBe("3 entries");
    expect(describeStoredValue([1])).toBe("1 entry");
    expect(describeStoredValue({ a: 1, b: 2 })).toBe("2 fields");
  });

  it("says a stored null is not reported", () => {
    expect(describeStoredValue(null)).toBe("not reported");
    expect(describeStoredValue(undefined)).toBe("not reported");
  });

  it("reads a stored dictionary in the order it was stored, and nothing else as one", () => {
    expect(fieldsOf({ latitude: 52.52, days: 3 })).toEqual([
      { name: "latitude", value: "52.52" },
      { name: "days", value: "3" },
    ]);
    expect(fieldsOf(null)).toEqual([]);
    expect(fieldsOf("not a dictionary")).toEqual([]);
  });
});

describe("hasAnalytics", () => {
  it("is false for a run that computed nothing", () => {
    const record = runRecordFrom(response());
    expect(record && hasAnalytics(record)).toBe(false);
  });

  it("is true when the run stored a statistic, an anomaly report or a trend", () => {
    const record = runRecordFrom(
      response({
        evidence: { ...response().evidence, trend_reports: [{ measure: "temperature" }] },
      }),
    );
    expect(record && hasAnalytics(record)).toBe(true);
  });
});
