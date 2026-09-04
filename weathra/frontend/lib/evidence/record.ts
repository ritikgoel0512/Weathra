/**
 * One stored run, read out of the evidence endpoint's response — task 21.5.
 *
 * `GET /api/v1/evidence/{id}` returns the row as it was stored: two JSON columns, declared in the
 * OpenAPI document as opaque objects because that is what a JSONB column is. Everything inside them
 * *is* typed — `envelope` is an `AnswerEnvelope` minus its evidence, `evidence` is an
 * `EvidenceRecord`, both dumped by `weathra/agents/evidence.py` — but the declared response type
 * cannot say so, and a screen that cast the dictionaries and read straight through them would crash
 * on a row written by an older build rather than tell the reader the record cannot be shown.
 *
 * So this module is the one place the dictionaries are read, and it reads them the way the rest of
 * the frontend reads anything provenance-bearing: **absent is absent**. A missing field becomes
 * `null` and the screen says the backend did not report it. Nothing here supplies a provider name, a
 * duration, an agent, a tool call, a station, a model or a confidence figure that the stored record
 * does not contain, and nothing here derives one from another. `runRecordFrom` returns `null` for a
 * row whose evidence is not an evidence record at all, which the screen renders as an unavailable
 * record — never as an empty but plausible-looking run.
 *
 * The shape it produces is the run as the Agent Evidence screen needs it: the agent sequence in
 * execution order, each tool call paired with the result that answered it, the deterministic
 * analytics with their methods, the knowledge chunks cited, the sources with their data classes,
 * and the timings. That is the list `specs/agent-orchestration` requires an evidence record to
 * carry, and it is the list `specs/web-ui` requires this screen to show.
 */

import type {
  AgentStep,
  AnomalyReport,
  DataClass,
  EvidenceAttribution,
  EvidenceResponse,
  Finding,
  GroundingReport,
  KnowledgeCitation,
  ResolvedContext,
  StatisticResult,
  ToolCall,
  ToolResult,
  TrendReport,
  UncertaintyStatement,
} from "@/lib/api/schema";

/* ------------------------------------------------------------- reading a field */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The objects in an array field, in the order they were stored. Anything else is not a record. */
function objectsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/* ------------------------------------------------------------------- one field */

/** A stored key and what it holds, as a line of evidence rather than a figure. */
export interface EvidenceField {
  readonly name: string;
  readonly value: string;
}

/** What is shown for a stored `null`. Never a zero, never a blank. */
export const NOT_REPORTED = "not reported";

/**
 * One stored value, described rather than reproduced.
 *
 * A tool's arguments are small and scalar and read as themselves. A tool's *result* can be a whole
 * hourly series, and printing it would bury the run record in numbers a reader cannot check
 * anything against. So a collection is described by its size — which is a fact about the result,
 * not a summary of it — and a scalar is printed exactly as it was stored, with no rounding,
 * unit-guessing or reformatting.
 */
export function describeStoredValue(value: unknown): string {
  if (value === null || value === undefined) return NOT_REPORTED;
  if (Array.isArray(value)) return value.length === 1 ? "1 entry" : `${value.length} entries`;
  if (isObject(value)) {
    const fields = Object.keys(value).length;
    return fields === 1 ? "1 field" : `${fields} fields`;
  }
  return String(value);
}

/** A stored dictionary as named lines, in the order it was stored. */
export function fieldsOf(value: unknown): EvidenceField[] {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([name, held]) => ({ name, value: describeStoredValue(held) }));
}

/* ------------------------------------------------------------------- the timing */

/** When the run ran and what it cost. Every part is the backend's, or null. */
export interface RunTiming {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly totalDurationMs: number | null;
  readonly stepsUsed: number | null;
  /** When the record was stored, from the row rather than from the evidence inside it. */
  readonly storedAt: string | null;
}

/**
 * A duration as text, or null when none was recorded.
 *
 * Milliseconds below a second and seconds to one decimal above it — the same resolution the
 * backend measures in, neither padded nor rounded up into a rounder-looking figure.
 */
export function formatDurationMs(value: number | null | undefined): string | null {
  const milliseconds = numberOf(value);
  if (milliseconds === null || milliseconds < 0) return null;
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/* --------------------------------------------------------------- tool activity */

/**
 * One tool call and the result that answered it.
 *
 * Paired on the sequence number the backend assigns, which is the pairing it validates on the way
 * in. A call with no result and a result with no call are both representable, because both are
 * real: a run cut short by a budget leaves the first, and neither is worth hiding by dropping the
 * half that did arrive.
 */
export interface ToolActivity {
  readonly key: string;
  readonly sequence: number;
  readonly tool: string;
  readonly agent: string | null;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly argumentFields: readonly EvidenceField[];
  readonly call: ToolCall | null;
  readonly result: ToolResult | null;
  readonly resultFields: readonly EvidenceField[];
}

function toolActivities(record: Record<string, unknown>): ToolActivity[] {
  const calls = objectsOf(record.tool_calls);
  const results = objectsOf(record.tool_results);

  const bySequence = new Map<number, Record<string, unknown>>();
  for (const result of results) {
    const sequence = numberOf(result.sequence);
    if (sequence !== null) bySequence.set(sequence, result);
  }

  const activities: ToolActivity[] = [];
  const answered = new Set<number>();

  for (const call of calls) {
    const sequence = numberOf(call.sequence);
    const tool = textOf(call.tool);
    if (sequence === null || tool === null) continue;

    const result = bySequence.get(sequence) ?? null;
    if (result !== null) answered.add(sequence);

    activities.push({
      key: `call-${sequence}`,
      sequence,
      tool,
      agent: textOf(call.agent),
      startedAt: textOf(call.started_at),
      durationMs: numberOf(call.duration_ms),
      argumentFields: fieldsOf(call.arguments),
      call: call as unknown as ToolCall,
      result: result === null ? null : (result as unknown as ToolResult),
      resultFields: result === null ? [] : fieldsOf(result.payload),
    });
  }

  // A result whose call was not stored is still evidence that a tool ran. Listed, not discarded.
  for (const result of results) {
    const sequence = numberOf(result.sequence);
    const tool = textOf(result.tool);
    if (sequence === null || tool === null || answered.has(sequence)) continue;
    activities.push({
      key: `result-${sequence}`,
      sequence,
      tool,
      agent: null,
      startedAt: null,
      durationMs: null,
      argumentFields: [],
      call: null,
      result: result as unknown as ToolResult,
      resultFields: fieldsOf(result.payload),
    });
  }

  return activities.sort((left, right) => left.sequence - right.sequence);
}

/* ------------------------------------------------------------------ the answer */

/**
 * The parts of the stored answer envelope this screen shows.
 *
 * Not the findings: they are the *answer's* figures and the Analyst renders them beside the prose
 * they belong to. What the run record needs from the envelope is what the run decided and how well
 * it held up — the resolved context, the grounding report, the uncertainty the backend stated, and
 * anything it said it could not answer.
 */
export interface StoredAnswer {
  readonly resolved: ResolvedContext | null;
  readonly grounding: GroundingReport | null;
  readonly uncertainty: UncertaintyStatement | null;
  readonly clarificationQuestion: string | null;
  readonly unansweredParts: readonly string[];
  readonly findings: readonly Finding[];
}

function storedAnswerOf(value: unknown): StoredAnswer | null {
  if (!isObject(value)) return null;
  return {
    resolved: isObject(value.resolved) ? (value.resolved as unknown as ResolvedContext) : null,
    grounding: isObject(value.grounding) ? (value.grounding as unknown as GroundingReport) : null,
    uncertainty: isObject(value.uncertainty)
      ? (value.uncertainty as unknown as UncertaintyStatement)
      : null,
    clarificationQuestion: textOf(value.clarification_question),
    unansweredParts: stringsOf(value.unanswered_parts),
    findings: objectsOf(value.findings) as unknown as Finding[],
  };
}

/* --------------------------------------------------------------- the whole run */

/** One stored run, as the Agent Evidence screen reads it. */
export interface RunRecord {
  /** The stored record's own identifier — the one in the URL. */
  readonly id: string;
  /** The request identifier, which ties the run to the backend's logs. */
  readonly requestId: string;
  readonly threadId: string | null;
  readonly question: string;
  readonly routingReason: string | null;
  readonly routingSource: string | null;
  /** The agents that ran, in execution order. */
  readonly agents: readonly AgentStep[];
  readonly tools: readonly ToolActivity[];
  readonly statistics: readonly StatisticResult[];
  readonly anomalies: readonly AnomalyReport[];
  readonly trends: readonly TrendReport[];
  readonly citations: readonly KnowledgeCitation[];
  /** Who supplied what, for where, for when, and when it was fetched. */
  readonly sources: readonly EvidenceAttribution[];
  readonly dataClasses: readonly DataClass[];
  readonly timing: RunTiming;
  readonly partial: boolean;
  readonly partialReason: string | null;
  readonly llmProvider: string | null;
  readonly llmModel: string | null;
  /** The weather provider the row recorded for the run. */
  readonly weatherProvider: string | null;
  /** The model's prose, or null when the grounding guard withheld it. */
  readonly answerProse: string | null;
  readonly answer: StoredAnswer | null;
}

/**
 * The stored row as a run record, or null when the row does not hold one.
 *
 * The four fields checked are the ones without which the record is not a run: which request it was,
 * what was asked, when it started and when it finished. A row missing any of them is reported as
 * unavailable rather than rendered as a run with blanks where its identity should be.
 */
export function runRecordFrom(response: EvidenceResponse): RunRecord | null {
  const record = response.evidence;
  if (!isObject(record)) return null;

  const requestId = textOf(record.request_id) ?? textOf(response.request_id);
  const question = textOf(record.question) ?? textOf(response.question);
  const startedAt = textOf(record.started_at);
  const completedAt = textOf(record.completed_at);
  if (requestId === null || question === null || startedAt === null || completedAt === null) {
    return null;
  }

  const agents = objectsOf(record.agents)
    .filter((step) => textOf(step.agent) !== null)
    .sort((left, right) => (numberOf(left.sequence) ?? 0) - (numberOf(right.sequence) ?? 0));

  return {
    id: response.id,
    requestId,
    threadId: textOf(record.thread_id) ?? textOf(response.thread_id),
    question,
    routingReason: textOf(record.routing_reason),
    routingSource: textOf(record.routing_source),
    agents: agents as unknown as AgentStep[],
    tools: toolActivities(record),
    statistics: objectsOf(record.analytics_results) as unknown as StatisticResult[],
    anomalies: objectsOf(record.anomaly_reports) as unknown as AnomalyReport[],
    trends: objectsOf(record.trend_reports) as unknown as TrendReport[],
    citations: objectsOf(record.citations) as unknown as KnowledgeCitation[],
    sources: objectsOf(record.attributions) as unknown as EvidenceAttribution[],
    dataClasses: stringsOf(record.data_classes) as DataClass[],
    timing: {
      startedAt,
      completedAt,
      totalDurationMs: numberOf(record.total_duration_ms) ?? numberOf(response.duration_ms),
      stepsUsed: numberOf(record.steps_used),
      storedAt: textOf(response.created_at),
    },
    partial: record.partial === true || response.partial === true,
    partialReason: textOf(record.partial_reason),
    llmProvider: textOf(record.llm_provider) ?? textOf(response.llm_provider),
    llmModel: textOf(record.llm_model) ?? textOf(response.llm_model),
    weatherProvider: textOf(response.weather_provider),
    answerProse: textOf(response.answer_prose),
    answer: storedAnswerOf(response.envelope),
  };
}

/* ------------------------------------------------------------------ the status */

/** How the run ended, said in a word and in a sentence. */
export interface RunStatus {
  readonly label: string;
  readonly tone: "ok" | "warning";
  /** Which bound was reached, in the backend's own words. Null for a complete run. */
  readonly reason: string | null;
}

export function runStatusOf(record: RunRecord): RunStatus {
  if (!record.partial) return { label: "Complete", tone: "ok", reason: null };
  return {
    label: "Partial",
    tone: "warning",
    reason: record.partialReason ?? "The backend did not say which bound was reached.",
  };
}

/** Whether the run recorded any deterministic calculation at all. */
export function hasAnalytics(record: RunRecord): boolean {
  return record.statistics.length > 0 || record.anomalies.length > 0 || record.trends.length > 0;
}
