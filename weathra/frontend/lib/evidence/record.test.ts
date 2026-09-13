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
  leadingAnalytics,
  readableProse,
  statisticsFromTools,
  type AnalyticsCard,
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
                {
                  statistic: "mean",
                  measure: "temperature_mean",
                  value: 21.5,
                  unit: "°C",
                  data_class: "computed_statistic",
                },
                {
                  statistic: "delta",
                  measure: "temperature_mean",
                  value: 2.2,
                  unit: "°C",
                  data_class: "computed_statistic",
                },
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

/** A statistic as the analytics layer records one, over a stated window. */
function figure(statistic: string, measure: string, value: number, window: string) {
  return {
    statistic,
    measure,
    value,
    unit: "°C",
    provenance: { period: { start_local: `${window}T00:00:00+01:00`, end_local: `${window}T23:00:00+01:00` } },
  };
}

/** The same, as the card the band ranks. */
function card(statistic: string, measure: string, value: number, window: string) {
  return { kind: "statistic" as const, result: figure(statistic, measure, value, window) as never };
}

function values(cards: readonly AnalyticsCard[]): unknown[] {
  return cards.map((entry) =>
    entry.kind === "statistic" ? entry.result.value : entry.report.measure,
  );
}

function kinds(cards: readonly AnalyticsCard[]): string[] {
  return cards.map((entry) =>
    entry.kind === "statistic" ? String(entry.result.statistic) : entry.kind,
  );
}

describe("the findings the analytics band leads with", () => {
  it("leads with the difference, then one finding per subject", () => {
    /*
     * The defect this replaced. A rich comparison computes a mean, a minimum, a maximum and a
     * range for each window it read and then the difference between them, and ranking put three
     * views of one temperature across the row — a minimum high, a maximum high and a mean — while
     * the difference the question was actually about sat behind a disclosure.
     */
    const { primary, rest } = leadingAnalytics([
      card("minimum", "temperature_max", 16.1, "2026-09-04"),
      card("maximum", "temperature_max", 25.9, "2026-09-04"),
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("range", "temperature_max", 9.8, "2026-09-04"),
      card("mean", "temperature_max", 19.2, "2025-09-04"),
      card("total", "precipitation_sum", 18.2, "2026-09-04"),
      card("delta", "temperature_max", 2.3, "2026-09-04"),
      { kind: "trend" as const, report: { measure: "wind_speed", direction: "rising" } as never },
    ]);

    expect(primary).toHaveLength(3);
    expect(kinds(primary)).toEqual(["delta", "total", "trend"]);
    // Three subjects, not three views of one: temperature, precipitation, wind.
    expect(values(primary)).toEqual([2.3, 18.2, "wind_speed"]);
    expect(rest).toHaveLength(5);
  });

  it("promotes the anomaly scan over the descriptive statistics it was computed beside", () => {
    const { primary } = leadingAnalytics([
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("minimum", "temperature_max", 16.1, "2026-09-04"),
      { kind: "anomaly" as const, report: { measure: "precipitation" } as never },
    ]);

    expect(kinds(primary)).toEqual(["anomaly", "mean", "minimum"]);
  });

  it("falls back to rank alone once the run has no other subject to show", () => {
    /*
     * A run that genuinely computed one measure still leads with its three best figures about it.
     * The diversity rule is there to find another subject, not to leave a slot empty when there
     * is none.
     */
    const { primary, rest } = leadingAnalytics([
      card("minimum", "temperature_max", 16.1, "2026-09-04"),
      card("maximum", "temperature_max", 25.9, "2026-09-04"),
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("delta", "temperature_max", 2.3, "2026-09-04"),
    ]);

    expect(kinds(primary)).toEqual(["delta", "mean", "minimum"]);
    expect(rest).toHaveLength(1);
  });

  it("collapses the same figure recorded twice", () => {
    /*
     * A run can compute a mean through the analytics agent and record it again in a statistics tool
     * result. Two cards with the same number over the same window look like two findings and are
     * one. Two means over *different* windows are two findings and both survive — that distinction
     * is the whole of a comparison.
     */
    const { primary, rest } = leadingAnalytics([
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("mean", "temperature_max", 19.2, "2025-09-04"),
      card("delta", "temperature_max", 2.3, "2026-09-04"),
    ]);

    expect(values(primary)).toEqual([2.3, 21.5, 19.2]);
    expect(rest).toHaveLength(0);
  });

  it("ranks by what a decision turns on, never by storage order", () => {
    const { primary, rest } = leadingAnalytics([
      card("minimum", "temperature_max", 16.1, "2026-09-04"),
      card("maximum", "temperature_max", 25.9, "2026-09-04"),
      card("mean", "temperature_max", 21.5, "2026-09-04"),
      card("total", "precipitation_sum", 18.2, "2026-09-04"),
      card("z_score", "wind_gust_max", 1.18, "2026-09-04"),
    ]);

    // A z-score and a total answer "is this unusual" and "how much"; an extreme answers neither.
    expect(kinds(primary)).toEqual(["z_score", "total", "mean"]);
    expect(rest).toHaveLength(2);
  });
});
