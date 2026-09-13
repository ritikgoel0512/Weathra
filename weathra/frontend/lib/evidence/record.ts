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
  InferenceAttempt,
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
  if (typeof value === "number") return roundedFigure(value);
  return String(value);
}

/**
 * A stored number without its binary-representation tail.
 *
 * `String(21.457142857142856)` prints every digit the double holds, and a mean of seven readings
 * almost always has a tail like that — so tool arguments and results came out reading as machine
 * noise rather than as figures. Two decimals is the widest any evidence value here needs and is
 * kept deliberately *wider* than the one decimal a temperature is shown at elsewhere: this is a
 * stored value being echoed back, not a reading being presented, and the record should round it as
 * little as legibility requires. Trailing zeros are trimmed, and an integer stays an integer.
 */
function roundedFigure(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
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
  /**
   * Every language model call attempt the run recorded, in the order it recorded them.
   *
   * The *configured* pair above says which client was wired up; this says what actually ran, with
   * the policy that resolved it (task 33.6). Empty on a run that needed no inference, and empty on
   * a stored record from before the attempts were recorded — which is why the pair above stays.
   */
  readonly inferenceAttempts: readonly InferenceAttempt[];
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
    inferenceAttempts: objectsOf(record.inference_attempts).filter(
      (attempt) => textOf(attempt.stage) !== null && textOf(attempt.status) !== null,
    ) as unknown as InferenceAttempt[],
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
/**
 * Prose with its float tails trimmed, for display only.
 *
 * A model writing about computed figures repeats them as it was given them, so the synthesis
 * arrives carrying "21.457142857142856 °C" — every digit of the double the mean was held in. The
 * record stores what the model actually wrote and must keep storing it: an evidence trail that
 * quietly edits its own prose is worth less than one that does not. So this is a *rendering*, and
 * the stored text is untouched.
 *
 * Only runs of three or more decimals are rewritten, to one decimal. That threshold is what keeps
 * it safe: a version, a score written to two places, a date and an identifier all pass through
 * unchanged, because none of them carries a three-decimal tail.
 */
export function readableProse(text: string): string {
  return text.replace(/\d+\.\d{3,}/g, (figure) => {
    const value = Number(figure);
    return Number.isFinite(value) ? (Math.round(value * 10) / 10).toFixed(1) : figure;
  });
}

/**
 * How many findings the deterministic band leads with. The artifact sets three across its row.
 */
export const PRIMARY_FIGURES = 3;

/**
 * One card the deterministic band can lead with.
 *
 * Three shapes, because the analytics kernel produces three: a statistic, an anomaly scan, a
 * trend. They are ranked *together* rather than in three separate queues — an anomaly scan that
 * found a real outlier is a more useful first card than the fourth-best descriptive statistic, and
 * the queue-per-shape version could never say so because a statistic could only be beaten by
 * another statistic.
 */
export type AnalyticsCard =
  | { readonly kind: "statistic"; readonly result: StatisticResult }
  | { readonly kind: "anomaly"; readonly report: AnomalyReport }
  | { readonly kind: "trend"; readonly report: TrendReport };

/**
 * What a decision turns on, in order.
 *
 * The ranking is by *kind of finding*, not by value: a difference or a z-score answers "is this
 * unusual", an anomaly scan answers "did anything stand out", a total answers "how much", and an
 * extreme or a range answers none of them on its own. The extremes sit at the bottom deliberately
 * — a rich comparison run computes a minimum, a maximum and a range for every window it read, and
 * storage order put "minimum of the first window" in the place the artifact puts its finding.
 */
const FIGURE_PRIORITY: readonly string[] = [
  // Is this different from what it was compared against?
  "delta",
  "difference",
  "percentage_change",
  // Did anything stand out?
  "anomaly_scan",
  "z_score",
  "anomaly",
  "percentile_rank",
  // How much, and which way — a total is the accumulation a risk is read off, a trend its direction.
  "total",
  "trend",
  // What it was typically like. True, and the least likely of these to change a decision.
  "mean",
  "median",
  "standard_deviation",
  "range",
  "minimum",
  "maximum",
];

/** The kind of finding a card is, as the priority list spells it. */
function cardKind(card: AnalyticsCard): string {
  if (card.kind === "anomaly") return "anomaly_scan";
  if (card.kind === "trend") return "trend";
  return String(card.result.statistic ?? "");
}

/**
 * What a card is *about*, with the aggregate it was taken over removed.
 *
 * `temperature_max`, `temperature_min` and `temperature_mean` are one subject computed three ways,
 * and a band led by all three says one thing three times — which is exactly what a reader saw: a
 * minimum high, a maximum high and a mean, filling every primary slot with the same measure. The
 * suffix comes off so the diversity rule below can tell "another temperature figure" from "the
 * precipitation signal", which is a different finding about a different risk.
 */
function measureFamily(card: AnalyticsCard): string {
  const measure =
    card.kind === "statistic"
      ? String(card.result.measure ?? "")
      : String(card.report.measure ?? "");
  return measure.replace(/_(max|min|mean|sum|total|median|range)$/, "");
}

/** The window a card covers, as a key. Cards with no provenance share one bucket. */
function cardPeriodKey(card: AnalyticsCard): string {
  return periodKeyOf(card.kind === "statistic" ? card.result : card.report);
}

/** The window a figure was computed over, as a key. Figures with no provenance share one bucket. */
function periodKeyOf(figure: unknown): string {
  const provenance = isObject(figure) ? figure.provenance : null;
  const period = isObject(provenance) ? provenance.period : null;
  if (!isObject(period)) return "";
  return `${String(period.start_local ?? "")}..${String(period.end_local ?? "")}`;
}

/**
 * The same finding, recorded twice, collapsed to one.
 *
 * A run can compute a mean through the analytics agent *and* record it again in a statistics tool
 * result, so the band drew two cards reading "Mean · Temperature max" with the same number — which
 * looks like two findings and is one. Identity is the finding, the measure, the window it covers
 * and the value: two means over *different* windows are two findings and must both survive.
 */
function deduplicate(cards: readonly AnalyticsCard[]): AnalyticsCard[] {
  const seen = new Set<string>();
  const kept: AnalyticsCard[] = [];

  for (const card of cards) {
    const held: Record<string, unknown> =
      card.kind === "statistic"
        ? (card.result as unknown as Record<string, unknown>)
        : (card.report as unknown as Record<string, unknown>);
    const key = [
      cardKind(card),
      String(held.measure ?? ""),
      cardPeriodKey(card),
      String(held.value ?? held.direction ?? ""),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(card);
  }

  return kept;
}

/**
 * Whether the card carries a figure at all.
 *
 * The kernel records what it could *not* compute as well as what it could — a maximum over a
 * measure the provider supplied nothing for, with the reason. That belongs in the record and is
 * shown with its reason, but it is not a finding to lead with: a row of three cards where one
 * reads "not computable" has spent a third of the band on an absence.
 */
function hasFigure(card: AnalyticsCard): boolean {
  if (card.kind !== "statistic") return true;
  const held = card.result as unknown as Record<string, unknown>;
  if (held.status === "not_computable") return false;
  return held.value !== null && held.value !== undefined ? true : "values" in held;
}

/**
 * The cards in the order the band leads with them.
 *
 * What was computed before what was not, then by what a decision turns on, then by the order the
 * run recorded them — so a tie is broken by the run itself rather than by anything invented here.
 */
function ranked(cards: readonly AnalyticsCard[]): AnalyticsCard[] {
  return cards
    .map((card, index) => {
      const rank = FIGURE_PRIORITY.indexOf(cardKind(card));
      return {
        card,
        index,
        computed: hasFigure(card) ? 0 : 1,
        rank: rank === -1 ? FIGURE_PRIORITY.length : rank,
      };
    })
    .sort(
      (left, right) =>
        left.computed - right.computed || left.rank - right.rank || left.index - right.index,
    )
    .map((entry) => entry.card);
}

/**
 * The three findings the band leads with, and everything else behind them.
 *
 * Two rules, in this order.
 *
 * **Rank decides what is worth leading with.** `FIGURE_PRIORITY` above, applied across all three
 * shapes at once, so a comparison's delta and a real anomaly outrank the descriptive statistics
 * the kernel computes on its way to them.
 *
 * **One subject per slot, while there is another subject to show.** Rank alone still filled the
 * row with one measure — the difference, the mean and the range of the same temperature — and a
 * reader got three views of one thing while the precipitation the run also computed sat behind a
 * disclosure. So each primary slot takes the highest-ranked card about a subject no slot has yet,
 * and only once the subjects run out does the row fall back to rank alone. A run that genuinely
 * computed one measure still leads with its three best figures about it; nothing is invented to
 * fill a slot, and nothing is dropped — the rest is one press away, in rank order.
 */
export function leadingAnalytics(cards: readonly AnalyticsCard[]): {
  readonly primary: readonly AnalyticsCard[];
  readonly rest: readonly AnalyticsCard[];
} {
  const ordered = ranked(deduplicate(cards));

  const primary: AnalyticsCard[] = [];
  const subjects = new Set<string>();

  for (const card of ordered) {
    if (primary.length === PRIMARY_FIGURES) break;
    // A subject whose only card is an absence does not earn a slot on the strength of being new.
    if (!hasFigure(card)) continue;
    const subject = measureFamily(card);
    if (subjects.has(subject)) continue;
    subjects.add(subject);
    primary.push(card);
  }

  // The subjects ran out before the slots did: fill what is left by rank, nothing skipped.
  const chosen = new Set(primary);
  const remaining = ordered.filter((card) => !chosen.has(card));
  const filled = [...primary, ...remaining.slice(0, PRIMARY_FIGURES - primary.length)];

  return { primary: filled, rest: remaining.slice(filled.length - primary.length) };
}

/** One logical stage of a run: an agent, and every action it took. */
export interface AgentStage {
  readonly agent: string;
  readonly status: string;
  readonly actions: readonly AgentStep[];
  readonly durationMs: number | null;
  readonly startedAt: string | null;
  readonly reasons: readonly string[];
}

/**
 * The run's agents as *stages*, one per agent, in the order they first ran.
 *
 * A supervisor that routes two archive windows records two historical steps, and the flow drew two
 * cards headed "Historical agent" — then two more for the analytics over them. Six cards for four
 * stages, and a reader counting agents got the wrong number. `05-agent-evidence.png` draws one card
 * per agent; what an agent did more than once belongs inside its card, not beside it.
 *
 * The stage's duration is the sum of its actions, which is what that agent cost the run. Its status
 * is the worst of them: a stage with one failed retrieval did not succeed, and rolling it up as
 * success because the other worked would hide the failure this screen exists to show.
 */
/**
 * Agents that share a logical stage on screen.
 *
 * A reading of conditions now, a projection of the days ahead and an imagery pass are different
 * claims under different data classes, which is why the domain keeps `current`, `satellite` and
 * `forecast` as separate agents — and the *sources* table keeps a row for each, for exactly that
 * reason. But a reader looking at the execution column is asking which parts of the pipeline ran,
 * and "fetched the conditions, the window and the imagery" is one part — retrieval — doing three
 * things. Grouping is presentation only: no evidence is merged, every data class still appears in
 * its own right, and every action is still listed inside the card.
 */
const STAGE_ALIASES: Readonly<Record<string, string>> = {
  current: "forecast",
  satellite: "forecast",
};

export function agentStages(record: RunRecord): AgentStage[] {
  const order: string[] = [];
  const byAgent = new Map<string, AgentStep[]>();

  for (const step of record.agents) {
    const named = String(step.agent);
    const agent = STAGE_ALIASES[named] ?? named;
    if (!byAgent.has(agent)) {
      byAgent.set(agent, []);
      order.push(agent);
    }
    byAgent.get(agent)?.push(step);
  }

  return order.map((agent) => {
    const actions = byAgent.get(agent) ?? [];
    const durations = actions
      .map((step) => step.duration_ms)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    return {
      agent,
      status: worstStatus(actions),
      actions,
      durationMs: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : null,
      startedAt: actions.find((step) => step.started_at)?.started_at ?? null,
      reasons: actions
        .map((step) => step.reason)
        .filter((reason): reason is string => typeof reason === "string" && reason.length > 0),
    };
  });
}

/** The worst outcome among a stage's actions: a failure is never rolled up into a success. */
function worstStatus(actions: readonly AgentStep[]): string {
  if (actions.some((step) => step.status === "failed")) return "failed";
  if (actions.some((step) => step.status === "skipped")) return "skipped";
  return actions[0]?.status ?? "succeeded";
}

/**
 * The deterministic analytics a run recorded inside its *tool results* rather than in its
 * analytics list.
 *
 * **Why this has to exist.** `analytics_results` on the stored record is deliberately empty:
 * `weathra/agents/evidence.py` leaves the statistic, anomaly and trend objects inside the tool
 * payloads they arrived in, because duplicating them into typed tuples would mean two copies that
 * can disagree. So *every* run's computed figures are in here, and a band that read only
 * `record.statistics` would say "no statistics" on a screen whose synthesis above quotes them.
 *
 * **It looks for figures, not for fields.** The first version walked each payload and printed
 * every key it found, which turned the band into `ok`, `unit`, `period`, `provider`, `data_class`
 * — the envelope, not the analysis. Only objects that are *shaped* like a result of the analytics
 * kernel and that carry `data_class: "computed_statistic"` — the kernel's own label, which a
 * retrieval envelope never has — are taken. An envelope can therefore never reach the screen as a
 * card, whatever tool returned it.
 *
 * **Four places, because there are four.** A tool that was asked for statistics returns them under
 * `results`; a retrieval tool that computes its own returns them under `findings` with its
 * anomaly scan under `anomalies` and its trend under `trend`. A run that asked the archive and
 * then the forecast has its two windows' figures in two differently-shaped payloads, and a band
 * that read only the first could not show a comparison that the run actually performed.
 *
 * **The window is attached where the figure does not carry one.** A statistic from
 * `weather_statistics` has no `provenance`; the period it covers is on the payload around it, and
 * a retrieval's figures take the period from the retrieval's own attribution. Without that, two
 * means over two different years are indistinguishable — which is exactly the distinction a
 * comparison is about. Nothing is computed here: the period is read off the record and moved next
 * to the figure it already belonged to.
 */
export interface RecoveredAnalytics {
  readonly statistics: readonly StatisticResult[];
  readonly anomalies: readonly AnomalyReport[];
  readonly trends: readonly TrendReport[];
}

export function analyticsFromTools(record: RunRecord): RecoveredAnalytics {
  const statistics: StatisticResult[] = [];
  const anomalies: AnomalyReport[] = [];
  const trends: TrendReport[] = [];

  for (const activity of record.tools) {
    const result = activity.result;
    if (result === null || result.ok === false) continue;

    const payload = result.payload;
    if (!isObject(payload)) continue;

    const period = periodAround(payload, result);

    for (const [figure, covering] of statisticCandidates(payload, period)) {
      statistics.push(withPeriod(figure, covering) as unknown as StatisticResult);
    }

    const scan = anomalyReportIn(payload);
    if (scan !== null) anomalies.push(withPeriod(scan, period) as unknown as AnomalyReport);

    const trend = trendReportIn(payload);
    if (trend !== null) trends.push(withPeriod(trend, period) as unknown as TrendReport);
  }

  return { statistics, anomalies, trends };
}

/** Kept as its own name: the statistics half is what most callers want. */
export function statisticsFromTools(record: RunRecord): StatisticResult[] {
  return [...analyticsFromTools(record).statistics];
}

/** The window a payload says its figures cover, or the one the retrieval was attributed to. */
function periodAround(
  payload: Record<string, unknown>,
  result: ToolResult | null,
): Record<string, unknown> | null {
  if (isObject(payload.period)) return payload.period;
  const attribution: unknown = result?.attribution;
  if (isObject(attribution) && isObject(attribution.period)) return attribution.period;
  return null;
}

/** The same figure with the window it covers beside it, where it did not already carry one. */
function withPeriod(
  figure: Record<string, unknown>,
  period: Record<string, unknown> | null,
): Record<string, unknown> {
  if (period === null) return figure;
  const provenance = isObject(figure.provenance) ? figure.provenance : null;
  if (provenance !== null && isObject(provenance.period)) return figure;
  return { ...figure, provenance: { ...(provenance ?? {}), period } };
}

/**
 * The statistic-shaped objects inside one payload, each with the window it covers.
 *
 * **The baseline is a different window, and that is the point of it.** A comparison call returns
 * this window's aggregates under `results` and the window it was compared against under
 * `baseline`, which carries its own period. Reading both out under the payload's single period
 * would make two means over two years look like one figure recorded twice — and a comparison whose
 * two sides cannot be told apart is not a comparison.
 */
function statisticCandidates(
  payload: Record<string, unknown>,
  period: Record<string, unknown> | null,
): [Record<string, unknown>, Record<string, unknown> | null][] {
  const here = [payload.results, payload.statistics, payload.analytics_results, payload.findings]
    .filter(Array.isArray)
    .flat();
  const roots = isStatisticShaped(payload) ? [payload] : [];
  const differences = Array.isArray(payload.differences) ? payload.differences : [];

  const found: [Record<string, unknown>, Record<string, unknown> | null][] = [
    ...roots, ...here, ...differences,
  ]
    .filter(isStatisticShaped)
    .map((figure): [Record<string, unknown>, Record<string, unknown> | null] => [figure, period]);

  const baseline = payload.baseline;
  if (isObject(baseline)) {
    const covering = isObject(baseline.period) ? baseline.period : null;
    for (const figure of (Array.isArray(baseline.results) ? baseline.results : []).filter(
      isStatisticShaped,
    )) {
      found.push([figure, covering]);
    }
  }

  return found;
}

/**
 * Whether a stored object is a statistic the analytics kernel produced.
 *
 * Four fields: the statistic, the measure, a value, and the kernel's own data class. An envelope
 * carries a provider and a data class of its own and fails the first two; a *retrieved* reading
 * carries a value and no statistic and fails the rest.
 */
function isStatisticShaped(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return (
    typeof value.statistic === "string" &&
    typeof value.measure === "string" &&
    ("value" in value || "values" in value) &&
    value.data_class === "computed_statistic"
  );
}

/** The anomaly scan inside a payload — its own result, or one nested under `anomalies`. */
function anomalyReportIn(payload: Record<string, unknown>): Record<string, unknown> | null {
  const nested = isObject(payload.anomalies) ? payload.anomalies : null;
  for (const candidate of [payload, nested]) {
    if (
      isObject(candidate) &&
      candidate.data_class === "computed_statistic" &&
      typeof candidate.measure === "string" &&
      Array.isArray(candidate.anomalies) &&
      "median_absolute_deviation" in candidate
    ) {
      return candidate;
    }
  }
  return null;
}

/** The trend inside a payload, where the tool computed one. */
function trendReportIn(payload: Record<string, unknown>): Record<string, unknown> | null {
  const trend = payload.trend;
  if (
    isObject(trend) &&
    trend.data_class === "computed_statistic" &&
    typeof trend.measure === "string" &&
    typeof trend.direction === "string" &&
    "slope_per_day" in trend
  ) {
    return trend;
  }
  return null;
}

export function hasAnalytics(record: RunRecord): boolean {
  return record.statistics.length > 0 || record.anomalies.length > 0 || record.trends.length > 0;
}
