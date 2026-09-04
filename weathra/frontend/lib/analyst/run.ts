/**
 * The AI Weather Analyst's adapter — task 21.2.
 *
 * Two readings, and both are *readings*: nothing here computes a figure, infers a step, or fills in
 * a field the backend did not send.
 *
 * **The run, from its events.** `runStepsFrom` turns the stream's event vocabulary — `routing`,
 * `agent_start`, `agent_end`, `tool_start`, `tool_end` (design.md decision 17) — into the progress
 * list the screen renders. One step per event pair the backend actually emitted, and *no* step
 * without one: a progress list that showed "Retrieving…" because a screen assumed retrieval
 * happens would be describing an architecture rather than a run. The agent that made a tool call is
 * read from the event's own `agent` field rather than from position, because the backend reports a
 * node's tool calls *after* that node's `agent_end` — read positionally they would appear under
 * whatever ran next.
 *
 * **The answer, from its envelope.** `findingGroups` splits the answer's findings into one region
 * per data class *and* per source, because `specs/safety-grounding` requires an answer drawing on
 * both a forecast and an archive to carry each part's own provider, period and retrieval time
 * rather than one blended credit line. Grouping by class alone would produce that blended line the
 * first time an answer touched two providers.
 *
 * What is deliberately absent: any default provider, any assumed agent, any derived confidence.
 * `docs/design/screens.md` §5 records that the artifact's telemetry, node counts and synthesis
 * percentages are mockup filler, and the way to keep that true is to have nothing here to fall back
 * on.
 */

import type { AgentEvent } from "@/hooks/use-agent-stream";
import type {
  AnswerEnvelope,
  EvidenceAttribution,
  Finding,
  UncertaintyStatement,
} from "@/lib/api/schema";
import { confidenceLevelFor, dataClassFor, type ConfidenceLevel } from "@/lib/design/data-class";
import type { DataClassName } from "@/lib/design/tokens";

/* --------------------------------------------------------------- reading a field */

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/* ------------------------------------------------------------------- the agents */

/**
 * What each agent is called on screen.
 *
 * Presentation naming for the six names `weathra/domain/evidence.py` already defines — four
 * capabilities and the two nodes that frame a run, exactly as `docs/agents.md` names them. Not a
 * claim about what any of them did.
 */
export const AGENT_LABELS: Readonly<Record<string, string>> = {
  supervisor: "Supervisor",
  forecast: "Forecast agent",
  historical: "Historical agent",
  analytics: "Analytics agent",
  rag: "Knowledge agent",
  synthesis: "Synthesis",
};

/** An agent's name. An unrecognised one is titled from itself rather than dropped or guessed. */
export function agentLabel(name: string): string {
  const known = AGENT_LABELS[name];
  if (known) return known;
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How the routing plan was arrived at, in the backend's own two values. */
export const ROUTING_SOURCE_LABELS: Readonly<Record<string, string>> = {
  model: "planned by the model",
  deterministic_fallback: "deterministic fallback",
};

/* ------------------------------------------------------------------ the progress */

/**
 * How a step ended.
 *
 * `ended` exists for a status the backend grew and this build does not recognise. Reporting an
 * unknown outcome as "succeeded" is the one mapping that could turn a failure into a green tick.
 */
export type RunStepStatus = "running" | "succeeded" | "failed" | "skipped" | "ended";

export type RunStepKind = "routing" | "agent" | "tool";

/** One thing the run did, as the stream reported it. */
export interface RunStep {
  /** Stable across re-renders: the sequence number of the event that opened the step. */
  readonly id: string;
  readonly kind: RunStepKind;
  readonly label: string;
  /** The backend's own reason or capability list. Null when it sent none. */
  readonly detail: string | null;
  readonly status: RunStepStatus;
  readonly durationMs: number | null;
  /** For a tool call, the agent that made it — from the event, never from position. */
  readonly agent: string | null;
}

function statusFrom(value: unknown): RunStepStatus {
  const named = textField(value);
  if (named === "succeeded" || named === "failed" || named === "skipped") return named;
  return "ended";
}

/**
 * The run's steps, in the order the backend reported them.
 *
 * A step is opened by `routing`, `agent_start` or `tool_start` and closed by the matching end
 * event. An end event with no open step is ignored rather than inventing one to close — a gap in
 * the sequence is already reported separately, and fabricating a step to explain it would hide it.
 */
export function runStepsFrom(events: readonly AgentEvent[]): RunStep[] {
  const steps: RunStep[] = [];

  /** The most recent still-running step of a kind, matched on the field the backend sends. */
  function closeLast(kind: RunStepKind, name: string, change: Partial<RunStep>): void {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps.at(index);
      if (step === undefined) continue;
      if (step.kind !== kind || step.status !== "running") continue;
      const matches = kind === "tool" ? step.label === name : step.agent === name;
      if (!matches) continue;
      steps.splice(index, 1, { ...step, ...change });
      return;
    }
  }

  for (const event of events) {
    if (event.type === "routing") {
      const capabilities = stringList(event.data.capabilities);
      const source = textField(event.data.source);
      const reason = textField(event.data.reason);
      const plan = capabilities.length > 0 ? capabilities.map(agentLabel).join(", ") : null;
      const how = source ? (ROUTING_SOURCE_LABELS[source] ?? source) : null;

      steps.push({
        id: `routing-${event.sequence}`,
        kind: "routing",
        label: "Routing",
        detail: [plan, how, reason].filter(Boolean).join(" · ") || null,
        status: "succeeded",
        durationMs: null,
        agent: null,
      });
      continue;
    }

    if (event.type === "agent_start") {
      const agent = textField(event.data.agent);
      if (agent === null) continue;
      steps.push({
        id: `agent-${event.sequence}`,
        kind: "agent",
        label: agentLabel(agent),
        detail: textField(event.data.reason),
        status: "running",
        durationMs: null,
        agent,
      });
      continue;
    }

    if (event.type === "agent_end") {
      const agent = textField(event.data.agent);
      if (agent === null) continue;
      closeLast("agent", agent, {
        status: statusFrom(event.data.status),
        durationMs: numberField(event.data.duration_ms),
      });
      continue;
    }

    if (event.type === "tool_start") {
      const tool = textField(event.data.tool);
      if (tool === null) continue;
      steps.push({
        id: `tool-${event.sequence}`,
        kind: "tool",
        label: tool,
        detail: null,
        status: "running",
        durationMs: null,
        // The agent that made the call, as the event states it. Tool calls are reported after
        // their node's `agent_end`, so reading this positionally would attribute them wrongly.
        agent: textField(event.data.agent),
      });
      continue;
    }

    if (event.type === "tool_end") {
      const tool = textField(event.data.tool);
      if (tool === null) continue;
      closeLast("tool", tool, {
        status: event.data.ok === true ? "succeeded" : "failed",
        durationMs: numberField(event.data.duration_ms),
      });
    }
  }

  return steps;
}

/* -------------------------------------------------------------------- the answer */

/**
 * One region of the answer: findings that share a data class *and* a source.
 *
 * Two groups rather than one whenever the providers, locations, periods or retrieval times differ,
 * so each part carries its own attribution as `specs/safety-grounding` requires.
 */
export interface FindingGroup {
  readonly key: string;
  readonly dataClass: DataClassName;
  readonly attribution: EvidenceAttribution;
  readonly findings: readonly Finding[];
}

/**
 * What a group of findings is called on screen.
 *
 * A readable name rather than the badge's own text: the badge already says the class in capitals,
 * and a heading repeating it word for word tells a reader nothing the badge beside it did not.
 */
export const GROUP_TITLES: Readonly<Record<DataClassName, string>> = {
  observed: "Observed figures",
  forecast: "Forecast figures",
  historical: "Historical figures",
  analytics: "Computed figures",
  interpretation: "AI interpretation",
};

function attributionKey(attribution: EvidenceAttribution): string {
  const period = attribution.period ? `${attribution.period.start_utc}..${attribution.period.end_utc}` : "";
  return [
    attribution.provider,
    attribution.location?.display_name ?? "",
    period,
    attribution.timestamp_utc ?? "",
    attribution.retrieved_at,
  ].join("|");
}

/**
 * The answer's findings, grouped for rendering, in the order the backend listed them.
 *
 * A finding whose `data_class` this build does not recognise is dropped rather than shown
 * unlabelled: `specs/safety-grounding` requires every reported value to carry its class, and an
 * unlabelled figure beside labelled ones reads as though the label did not apply.
 */
export function findingGroups(envelope: AnswerEnvelope): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const byKey = new Map<string, FindingGroup>();

  for (const finding of envelope.findings ?? []) {
    const dataClass = dataClassFor(finding.data_class);
    if (dataClass === null) continue;

    const key = `${dataClass}|${attributionKey(finding.attribution)}`;
    const held = byKey.get(key);
    if (held === undefined) {
      const group: FindingGroup = {
        key,
        dataClass,
        attribution: finding.attribution,
        findings: [finding],
      };
      byKey.set(key, group);
      groups.push(group);
      continue;
    }
    byKey.set(key, { ...held, findings: [...held.findings, finding] });
  }

  // Rebuilt from the map so each group carries every finding, in first-seen order.
  return groups.map((group) => byKey.get(group.key) ?? group);
}

/** A finding's figure and unit as text, or null when the backend reported no value. */
export function findingValue(finding: Finding): string | null {
  if (typeof finding.value === "number" && Number.isFinite(finding.value)) {
    const rounded = Math.round(finding.value * 10) / 10;
    const figure = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return finding.unit ? `${figure} ${finding.unit}` : figure;
  }
  return finding.text_value?.trim() || null;
}

/** The confidence band the backend stated for the nearest horizon point, or null. */
export function confidenceOf(uncertainty: UncertaintyStatement | null | undefined): ConfidenceLevel | null {
  return confidenceLevelFor(uncertainty?.horizon?.[0]?.confidence);
}

/** How far into the horizon the band applies, when the backend measured it. */
export function horizonHoursOf(uncertainty: UncertaintyStatement | null | undefined): number | null {
  return numberField(uncertainty?.horizon?.[0]?.hours_ahead);
}
