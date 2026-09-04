/**
 * The Analyst's reading of a run — task 21.2.
 *
 * Two properties matter here and neither is about layout: that a progress step exists only because
 * an event did, and that findings are grouped so no two sources are ever credited as one.
 */

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@/hooks/use-agent-stream";
import type { AnswerEnvelope, EvidenceAttribution, Finding } from "@/lib/api/schema";

import { agentLabel, findingGroups, findingValue, runStepsFrom } from "./run";

let sequence = 0;
function event(type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent {
  sequence += 1;
  return { type, sequence, requestId: "req-1", data };
}

function run(): AgentEvent[] {
  sequence = 0;
  return [
    event("routing", {
      capabilities: ["forecast", "analytics"],
      source: "model",
      reason: "The question asks about the days ahead and what stands out in them.",
    }),
    event("agent_start", { agent: "forecast", reason: "Retrieve the window." }),
    event("agent_end", { agent: "forecast", status: "succeeded", duration_ms: 412.6 }),
    event("tool_start", { tool: "weather_forecast", agent: "forecast" }),
    event("tool_end", { tool: "weather_forecast", ok: true, duration_ms: 388.2 }),
    event("agent_start", { agent: "analytics" }),
    event("agent_end", { agent: "analytics", status: "succeeded", duration_ms: 21.4 }),
    event("agent_start", { agent: "synthesis" }),
    event("agent_end", { agent: "synthesis", status: "succeeded", duration_ms: 903.1 }),
    event("answer_delta", { text: "A sentence." }),
  ];
}

describe("the run's progress", () => {
  it("has one step per event pair, and none without one", () => {
    const steps = runStepsFrom(run());

    expect(steps.map((step) => `${step.kind}:${step.label}`)).toEqual([
      "routing:Routing",
      "agent:Forecast agent",
      "tool:weather_forecast",
      "agent:Analytics agent",
      "agent:Synthesis",
    ]);
    // `answer_delta` is the answer, not a stage. Nothing invents a "retrieving" or "thinking" row.
    expect(steps.every((step) => step.label !== "Retrieving")).toBe(true);
  });

  it("carries each step's own outcome and duration, from the event", () => {
    const steps = runStepsFrom(run());
    const forecast = steps.find((step) => step.label === "Forecast agent");

    expect(forecast?.status).toBe("succeeded");
    expect(forecast?.durationMs).toBe(412.6);
    expect(forecast?.detail).toBe("Retrieve the window.");
  });

  it("states the plan, its source, and the supervisor's reason", () => {
    const [routing] = runStepsFrom(run());

    expect(routing?.detail).toContain("Forecast agent, Analytics agent");
    expect(routing?.detail).toContain("planned by the model");
    expect(routing?.detail).toContain("asks about the days ahead");
  });

  it("attributes a tool call to the agent the event names, not to whatever ran next", () => {
    // The backend reports a node's tool calls after that node's `agent_end`, so a positional
    // reading would file this under the agent that started afterwards.
    const steps = runStepsFrom(run());
    const tool = steps.find((step) => step.kind === "tool");

    expect(tool?.agent).toBe("forecast");
    expect(tool?.status).toBe("succeeded");
  });

  it("leaves a step running while its end event has not arrived", () => {
    sequence = 0;
    const steps = runStepsFrom([
      event("agent_start", { agent: "historical" }),
      event("tool_start", { tool: "weather_history", agent: "historical" }),
    ]);

    expect(steps.map((step) => step.status)).toEqual(["running", "running"]);
  });

  it("reports a failed tool as failed", () => {
    sequence = 0;
    const steps = runStepsFrom([
      event("tool_start", { tool: "weather_history", agent: "historical" }),
      event("tool_end", { tool: "weather_history", ok: false, duration_ms: 12 }),
    ]);

    expect(steps[0]?.status).toBe("failed");
  });

  it("reports a status it does not recognise as ended rather than as succeeded", () => {
    sequence = 0;
    const steps = runStepsFrom([
      event("agent_start", { agent: "forecast" }),
      event("agent_end", { agent: "forecast", status: "abandoned", duration_ms: 5 }),
    ]);

    expect(steps[0]?.status).toBe("ended");
  });

  it("ignores an end event with no step to close rather than inventing one", () => {
    sequence = 0;
    expect(runStepsFrom([event("agent_end", { agent: "forecast", status: "succeeded", duration_ms: 1 })])).toEqual([]);
  });

  it("names an agent it does not know from its own key rather than guessing", () => {
    expect(agentLabel("forecast")).toBe("Forecast agent");
    expect(agentLabel("tidal_surge")).toBe("Tidal surge");
  });
});

/* -------------------------------------------------------------------- findings */

const BERLIN = { display_name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timezone: "Europe/Berlin" };
const PERIOD = {
  start_local: "2026-09-04T00:00:00+02:00",
  end_local: "2026-09-07T00:00:00+02:00",
  start_utc: "2026-09-03T22:00:00Z",
  end_utc: "2026-09-06T22:00:00Z",
  timezone: "Europe/Berlin",
};

function attribution(overrides: Partial<EvidenceAttribution> = {}): EvidenceAttribution {
  return {
    provider: "open-meteo",
    location: BERLIN,
    data_class: "forecast",
    period: PERIOD,
    retrieved_at: "2026-09-04T06:15:00Z",
    ...overrides,
  } as EvidenceAttribution;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    label: "Highest temperature",
    value: 21.4,
    unit: "°C",
    data_class: "forecast",
    attribution: attribution(),
    ...overrides,
  } as Finding;
}

function envelope(findings: Finding[]): AnswerEnvelope {
  return { findings } as AnswerEnvelope;
}

describe("the answer's findings", () => {
  it("groups by data class so each part is labelled with what it is", () => {
    const groups = findingGroups(
      envelope([
        finding(),
        finding({
          label: "Baseline mean",
          data_class: "computed_statistic",
          attribution: attribution({ data_class: "computed_statistic" }),
        }),
      ]),
    );

    expect(groups.map((group) => group.dataClass)).toEqual(["forecast", "analytics"]);
  });

  it("splits two providers apart rather than crediting both to one source", () => {
    const groups = findingGroups(
      envelope([
        finding(),
        finding({ label: "Elsewhere", attribution: attribution({ provider: "another-provider" }) }),
      ]),
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.attribution.provider)).toEqual(["open-meteo", "another-provider"]);
  });

  it("keeps findings that share a class and a source in one group", () => {
    const groups = findingGroups(envelope([finding(), finding({ label: "Lowest temperature", value: 12.1 })]));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings).toHaveLength(2);
  });

  it("drops a finding whose data class it cannot label rather than showing it unlabelled", () => {
    const groups = findingGroups(
      envelope([finding({ data_class: "telemetry" as Finding["data_class"] })]),
    );

    expect(groups).toEqual([]);
  });

  it("reads a value with its unit, and reports an absent one as absent", () => {
    expect(findingValue(finding())).toBe("21.4 °C");
    expect(findingValue(finding({ value: 20, unit: "°C" }))).toBe("20 °C");
    expect(findingValue(finding({ value: null, unavailable_reason: "not supplied" }))).toBeNull();
    expect(findingValue(finding({ value: null, text_value: "north-west" }))).toBe("north-west");
  });
});
