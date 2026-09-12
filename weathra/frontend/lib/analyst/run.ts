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
  // "Conditions agent", parallel with the four beside it, rather than "Current conditions" —
  // which is what the *source* row under Active data sources is called, and two adjacent cards
  // saying the same words about two different things read as one thing said twice.
  current: "Conditions agent",
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
  /*
   * "Current conditions", not "Observed data" — the artifact's own heading for this region.
   *
   * Open-Meteo's current block is its analysis for right now, not a reading taken off an instrument
   * at the place. Both are `DataClass.CURRENT` and both are badged OBSERVED, which is the design
   * system's name for the class; the heading a customer reads should not go further than the
   * provider's contract supports, and "observed data" claims a measurement was made.
   */
  observed: "Current conditions",
  forecast: "Forecast figures",
  historical: "Historical figures",
  /*
   * The artifact's highlighted box is headed AGENT INTERPRETATION and holds a causal reading of an
   * atmosphere Weathra does not model. What sits in that position here is the arithmetic — the
   * statistics the answer actually turns on — so it is headed for what it is: the analyst's own
   * reading of the figures above it, computed rather than written. The ANALYTICS badge beside the
   * heading still says which class produced it, so the heading names the role and the badge names
   * the provenance, which is the division every other region on this screen uses.
   */
  analytics: "Analyst interpretation",
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

/* ------------------------------------------------------- the answer, composed */

/**
 * The order the answer's figure panels put their findings in.
 *
 * A real forecast retrieval carries fifteen or so findings — the extremes and mean of the daily
 * maxima and minima, the window's precipitation total and its per-day series, the wet-day count,
 * the probability, wind speed, gust and sector, humidity and pressure. All of them are true and
 * all of them are the run's, and a panel that prints all fifteen is a table rather than a briefing:
 * the customer-level review of 2026-09-12 asked for two to four high-value figures with the rest
 * one press away.
 *
 * So this is a *reading order*, not a filter. Nothing is dropped — `headlineFindings` returns the
 * whole list, ranked — and the panel decides how many it leads with. The rank is by what the
 * measure is, because that is the only thing about a finding that is stable across runs: a
 * temperature is the figure somebody asked a weather question to learn, and a pressure reading is
 * not, whatever order the provider happened to list them in.
 */
const MEASURE_RANK: readonly (readonly [RegExp, number])[] = [
  [/\btemperature\b/i, 0],
  [/\b(precipitation|rain|snow)\b/i, 1],
  [/\bwind|gust\b/i, 2],
  [/\bhumidity\b/i, 3],
  [/\bcondition|cloud|uv\b/i, 4],
  [/\bpressure\b/i, 5],
];

/**
 * The same question asked of a reading of *now*, where the answer is different.
 *
 * Over a window, the precipitation total is one of the two figures somebody came for. Right now,
 * "0 mm of rain" is the least informative true thing on the panel and what the sky is doing is the
 * most: a person glancing at current conditions wants the temperature, the sky, how humid it is and
 * how hard the wind is blowing, in that order. Same mechanism, one table per kind of reading.
 */
const CURRENT_RANK: readonly (readonly [RegExp, number])[] = [
  [/\btemperature\b/i, 0],
  [/\bcondition\b/i, 1],
  [/\bhumidity\b/i, 2],
  [/\bwind\b/i, 3],
  // The apparent temperature is a real reading and not one of the four somebody glances for; it
  // sits with the rest, one press away, rather than taking the temperature's place beside it.
  [/\bfeels like|apparent\b/i, 4],
  [/\b(precipitation|rain|snow)\b/i, 5],
  [/\bpressure|cloud|uv|dew\b/i, 6],
];

function measureRank(label: string, dataClass: DataClassName | null): number {
  const table = dataClass === "observed" ? CURRENT_RANK : MEASURE_RANK;
  for (const [pattern, rank] of table) if (pattern.test(label)) return rank;
  return table.length;
}

/**
 * A group's findings, most useful first, with the ones carrying no value last.
 *
 * "Unavailable" is a fact the answer must keep — `specs/safety-grounding` requires a gap to be
 * stated rather than dropped — and it is not what a panel leads with. Sorting is stable within a
 * rank, so findings the backend listed together stay together.
 */
export function headlineFindings(
  findings: readonly Finding[],
  dataClass: DataClassName | null = null,
): readonly Finding[] {
  return [...findings]
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const reported =
        Number(findingValue(right.finding) !== null) - Number(findingValue(left.finding) !== null);
      if (reported !== 0) return reported;
      const rank =
        measureRank(left.finding.label, dataClass) - measureRank(right.finding.label, dataClass);
      return rank !== 0 ? rank : left.index - right.index;
    })
    .map((entry) => entry.finding);
}

/**
 * Where the place this answer is about came from, in the backend's own five values.
 *
 * Phrased rather than printed: the rail's Analyst context said "(from the preferences)" and, on a
 * run that resolved nowhere, "(from the none)" — the internal name of a rung of the resolution
 * ladder, offered to a customer as provenance.
 */
export const LOCATION_SOURCE_PHRASES: Readonly<Record<string, string>> = {
  request: "named in your question",
  focus: "this conversation's focus",
  thread: "established earlier in this conversation",
  preferences: "your saved default",
};

/**
 * The one line under the AI INTERPRETATION badge: what this answer is about.
 *
 * `02-ai-weather-analyst.png` sets a short grounding line beside that badge — its own reads
 * "Grounding analysis via Weathra MCP…", which names an implementation rather than a subject. What
 * a reader needs there is the place the figures apply to and how Weathra came to use it, both of
 * which are the run's own resolution.
 *
 * **Deliberately carries no figure.** It sits inside the interpretation region, and the rule that
 * region exists to enforce is that nothing measured is stated there without its class and its
 * source. The window, the units and the retrieval time are the panels' attributions and the rail's
 * Analyst context, which is where they carry all four fields. Null when the run resolved no place,
 * because a grounding line that grounds nothing is worse than none.
 */
export function groundingLine(resolved: AnswerEnvelope["resolved"]): string | null {
  const place = resolved?.locations?.[0]?.display_name?.trim() || null;
  if (place === null) return null;
  const from = LOCATION_SOURCE_PHRASES[resolved?.location_source ?? ""] ?? null;
  return from === null ? place : `${place} · ${from}`;
}

/**
 * How much of what the run reported actually carries a figure.
 *
 * The artifact prints "SYNTHESIS CONFIDENCE 98.2%", which no endpoint produces. This is the one
 * proportion on this screen that is arithmetic rather than invention: findings with a value, over
 * findings reported. A run that retrieved nothing has nothing to measure and says so by returning
 * a total of zero rather than a full bar.
 */
export function dataCoverageOf(envelope: AnswerEnvelope | null): {
  readonly reported: number;
  readonly total: number;
} {
  const findings = envelope?.findings ?? [];
  return {
    reported: findings.filter((finding) => findingValue(finding) !== null).length,
    total: findings.length,
  };
}

/* ------------------------------------------------------------------ the sources */

/**
 * What a provider is called in front of a customer.
 *
 * A provider id is a configuration value — `open-meteo`, `open_meteo_archive` — and the rail was
 * printing it twice over. These are the same providers named the way their own documentation names
 * them. An id with no entry is shown as it is rather than prettified into something that might not
 * be the provider's name: guessing at a company's capitalisation is a small fabrication, and this
 * screen has a rule against those.
 */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "open-meteo": "Open-Meteo",
  open_meteo: "Open-Meteo",
  "open-meteo-archive": "Open-Meteo Archive",
  open_meteo_archive: "Open-Meteo Archive",
};

/** A provider's customer-facing name, or its own id when this build does not know one. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/* ------------------------------------------------------------ the agents, again */

/** One agent the run actually used, with how its turn ended. */
export interface RunAgent {
  readonly name: string;
  readonly label: string;
  /** The backend's own step status, or null while the run is still in flight. */
  readonly status: "succeeded" | "failed" | "skipped" | null;
}

/** What each outcome is called in the rail. Never a tick over a status nobody sent. */
export const AGENT_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  succeeded: "Used",
  failed: "Failed",
  skipped: "Skipped",
};

function outcomeOf(value: unknown): RunAgent["status"] {
  return value === "succeeded" || value === "failed" || value === "skipped" ? value : null;
}

/**
 * The agents this run used, and how each one ended.
 *
 * The artifact's Agent Status panel lists "Neural Agent v4.8" against a compute load, which is
 * fiction twice over. What Weathra genuinely records is an `AgentStep` per node — the agent, its
 * status and how long it took — so the rail can say *Forecast agent · Used* and *Historical agent ·
 * Skipped* without inventing a thing.
 *
 * The completed record is preferred over the stream because only the record carries the outcome; a
 * run still in flight has named agents and no statuses yet, and those are listed with no outcome
 * rather than with an assumed one. An agent the plan never routed to appears in neither, and is
 * therefore absent rather than reported as "not needed" — the run has no record of declining it.
 */
export function runAgentsFrom(
  events: readonly AgentEvent[],
  envelope: AnswerEnvelope | null,
): readonly RunAgent[] {
  const recorded = envelope?.evidence?.agents ?? [];
  if (recorded.length > 0) {
    const byAgent = new Map<string, RunAgent>();
    for (const step of recorded) {
      const name = textField(step.agent);
      if (name === null) continue;
      byAgent.set(name, {
        name,
        label: agentLabel(name),
        status: outcomeOf(step.status),
      });
    }
    return [...byAgent.values()];
  }

  const seen = new Set<string>();
  for (const event of events) {
    const agent = (event as { data?: { agent?: unknown } }).data?.agent;
    if (typeof agent === "string" && agent !== "") seen.add(agent);
  }
  return [...seen].map((name) => ({ name, label: agentLabel(name), status: null }));
}
