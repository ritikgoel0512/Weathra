/**
 * The two presentation rules an evidence record needs and cannot get from the backend.
 *
 * Both exist because the *stored* record is right and the *rendered* one was not: a model repeats a
 * figure with every digit of the double it was given, and a run that computes through the tool
 * boundary records its statistics somewhere the analytics band was not looking.
 */

import { describe, expect, it } from "vitest";

import {
  agentStages,
  readableProse,
  statisticsFromTools,
  type RunRecord,
} from "./record";

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

describe("statistics a run recorded through its tools", () => {
  it("recovers the figures nested in a computed-statistic payload", () => {
    const found = statisticsFromTools(
      recordWith([
        {
          sequence: 3,
          tool: "weather_statistics",
          result: {
            ok: true,
            data_class: "computed_statistic",
            payload: {
              // The envelope the band must never print as cards.
              ok: true,
              provider: "open-meteo",
              unit: "°C",
              measure: "temperature_mean",
              points_supplied: 7,
              results: [
                { statistic: "mean", measure: "temperature_mean", value: 21.5, unit: "°C" },
                { statistic: "delta", measure: "temperature_mean", value: 2.2, unit: "°C" },
              ],
            },
          },
        },
      ]),
    );

    expect(found.map((result) => result.statistic)).toEqual(["mean", "delta"]);
    expect(found[0]?.value).toBe(21.5);
  });

  it("never returns the envelope around the figures", () => {
    /*
     * The defect this replaced: walking the payload and printing every key turned the analytics
     * band into `ok`, `unit`, `period`, `provider`, `data_class` — schema, not analysis.
     */
    const found = statisticsFromTools(
      recordWith([
        {
          sequence: 1,
          tool: "weather_statistics",
          result: {
            ok: true,
            data_class: "computed_statistic",
            payload: { ok: true, provider: "open-meteo", unit: "°C", points_supplied: 7 },
          },
        },
      ]),
    );

    expect(found).toEqual([]);
  });

  it("ignores a retrieval, because retrieved data is not a statistic", () => {
    const found = statisticsFromTools(
      recordWith([
        {
          sequence: 1,
          tool: "weather_forecast",
          result: {
            ok: true,
            data_class: "forecast",
            payload: { results: [{ statistic: "mean", measure: "temperature", value: 1 }] },
          },
        },
      ]),
    );

    expect(found).toEqual([]);
  });

  it("ignores a failed call, which computed nothing to recover", () => {
    const found = statisticsFromTools(
      recordWith([
        {
          sequence: 2,
          tool: "weather_statistics",
          result: {
            ok: false,
            data_class: "computed_statistic",
            payload: { results: [{ statistic: "mean", measure: "temperature_mean", value: 1 }] },
          },
        },
      ]),
    );

    expect(found).toEqual([]);
  });
});

/** A record carrying only the agent steps these cases read. */
function runWith(agents: unknown[]): RunRecord {
  return { agents } as unknown as RunRecord;
}

describe("the run's agents as logical stages", () => {
  it("draws one card per agent, however many times it ran", () => {
    /*
     * A supervisor routing two archive windows records two historical steps, and the flow drew two
     * cards headed "Historical agent" — then two more for the analytics over them. Six cards for
     * four stages, so a reader counting agents got the wrong number.
     */
    const stages = agentStages(
      runWith([
        { sequence: 1, agent: "supervisor", status: "succeeded", duration_ms: 90, reason: "Planned." },
        { sequence: 2, agent: "historical", status: "succeeded", duration_ms: 300, reason: "This week." },
        { sequence: 3, agent: "historical", status: "succeeded", duration_ms: 200, reason: "Last year." },
        { sequence: 4, agent: "analytics", status: "succeeded", duration_ms: 100, reason: "Mean." },
        { sequence: 5, agent: "analytics", status: "succeeded", duration_ms: 50, reason: "Difference." },
        { sequence: 6, agent: "synthesis", status: "succeeded", duration_ms: 800 },
      ]),
    );

    expect(stages.map((stage) => stage.agent)).toEqual([
      "supervisor",
      "historical",
      "analytics",
      "synthesis",
    ]);

    const historical = stages[1];
    // The stage costs what its actions cost together, and keeps both reasons inside it.
    expect(historical?.durationMs).toBe(500);
    expect(historical?.actions).toHaveLength(2);
    expect(historical?.reasons).toEqual(["This week.", "Last year."]);
  });

  it("never rolls a failed action up into a succeeded stage", () => {
    /*
     * The case that must not be smoothed over: an agent that retrieved one window and failed the
     * other did not succeed, and a green stage would hide the failure this screen exists to show.
     */
    const stages = agentStages(
      runWith([
        { sequence: 1, agent: "historical", status: "succeeded", duration_ms: 300 },
        { sequence: 2, agent: "historical", status: "failed", duration_ms: 20 },
      ]),
    );

    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe("failed");
  });

  it("keeps the order the agents first ran in", () => {
    const stages = agentStages(
      runWith([
        { sequence: 1, agent: "supervisor", status: "succeeded" },
        { sequence: 2, agent: "forecast", status: "succeeded" },
        { sequence: 3, agent: "historical", status: "succeeded" },
        { sequence: 4, agent: "forecast", status: "succeeded" },
      ]),
    );

    expect(stages.map((stage) => stage.agent)).toEqual(["supervisor", "forecast", "historical"]);
  });
});
