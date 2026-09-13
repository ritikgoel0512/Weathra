"use client";

/**
 * The Agent Evidence screen's surfaces — task 21.5, against
 * `docs/design/screens/05-agent-evidence.png`.
 *
 * The artifact's structure is reproduced: the record header with its status strip, the execution
 * flow as a connected timeline, the tool activity beneath it, the grounded sources as a table, the
 * deterministic analytics as figure cards, the retrieved knowledge as quoted fragments, and the
 * final synthesis in its own panel at the end.
 *
 * What goes *inside* those surfaces is only ever what the stored record holds. Three rules the
 * components below exist to enforce, and which the tests assert:
 *
 * **A row is a recorded event.** There is no placeholder agent, no expected-but-missing tool call,
 * no derived timing and no inferred provider. A run that recorded nothing under a heading says so
 * in a sentence; it does not render a plausible-looking sequence. The artifact's audit identifier,
 * signature hash, agent version, node identifiers and latency figures have nothing behind them and
 * are recorded as mockup filler in `docs/design/screens.md` §5.
 *
 * **The four tiers stay four regions.** Retrieved provider data, deterministic analytics, retrieved
 * knowledge and the language model's prose each render in a region carrying its own `data-tier`, so
 * the separation is structural rather than a matter of where a card happens to sit. The model's
 * prose goes through `InterpretationPanel` and nothing numeric is passed to it.
 *
 * **Only user-facing observability is shown.** The record carries operational metadata — which
 * agent ran, which tool was called with what arguments, what came back, which method computed a
 * figure, which chunk was cited, how long each took. It carries no model deliberation, and nothing
 * here reaches for a field outside the ones named below: the screen renders named fields, never a
 * dump of whatever the stored dictionary happens to contain.
 */

import { useEffect, useState, type ReactNode } from "react";

import {
  AttributionFooter,
  Badge,
  DataClassBadge,
  InterpretationPanel,
  MethodNote,
  ModelAttribution,
  NOT_REPORTED,
  ProvenanceSection,
  ScrollRegion,
  UncertaintyIndicator,
  formatInstant,
  formatLocalStamp,
} from "@/components/ui";
import type {
  AnomalyReport,
  EvidenceAttribution,
  KnowledgeCitation,
  StatisticResult,
  TrendReport,
} from "@/lib/api/schema";
import { agentLabel, confidenceOf, horizonHoursOf, ROUTING_SOURCE_LABELS } from "@/lib/analyst/run";
import { auditOf, provenanceOf, recordHash } from "@/lib/evidence/audit";
import { measureLabel } from "@/lib/dashboard/briefing";
import { dataClassFor } from "@/lib/design/data-class";
import {
  agentStages,
  analyticsFromTools,
  leadingFigures,
  PRIMARY_FIGURES,
  formatDurationMs,
  readableProse,
  runStatusOf,
  type EvidenceField,
  type RunRecord,
  type ToolActivity,
} from "@/lib/evidence/record";
import { formatStatistic, unavailableReason } from "@/lib/historical/analysis";
import { inferenceMetadataFrom } from "@/lib/inference/served";
import { placeLabel } from "@/lib/locations/place";

import styles from "./evidence.module.css";

/* ------------------------------------------------------------------ formatting */

/** A stored enum value as words, when there is no curated label for it. */
function humanize(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How each recorded outcome is announced. Colour is never the only carrier. */
const STEP_STATUS_LABELS: Readonly<Record<string, string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

function stepStatusLabel(status: string | null | undefined): string {
  if (typeof status !== "string" || status === "") return NOT_REPORTED;
  return STEP_STATUS_LABELS[status] ?? humanize(status);
}

/** What a statistic is, in words: the statistic the engine ran and the measure it ran it on. */
function statisticLabel(result: StatisticResult): string {
  const statistic = typeof result.statistic === "string" ? humanize(result.statistic) : "Statistic";
  const measure = typeof result.measure === "string" ? measureLabel(result.measure) : null;
  return measure === null ? statistic : `${statistic} · ${measure}`;
}

/**
 * The window a figure covers, for the one place two figures are otherwise identical.
 *
 * A comparison's two sides are the same statistic over the same measure — "Mean · Temperature max"
 * twice — so labelled by kind alone they read as one finding recorded twice. The window is the only
 * thing that distinguishes them, and it is the thing the comparison is *about*.
 */
function figurePeriodLabel(result: StatisticResult): string | null {
  const period = result.provenance?.period;
  const from = calendarDay(period?.start_local);
  const to = calendarDay(period?.end_local);
  if (from === null) return null;
  if (to === null || from === to) return from;
  const [fromDay, fromMonth, fromYear] = from.split(" ");
  const [, toMonth, toYear] = to.split(" ");
  return fromMonth === toMonth && fromYear === toYear ? `${fromDay} – ${to}` : `${from} – ${to}`;
}

/**
 * The shape of record this version of the screen knows how to read.
 *
 * The artifact prints an agent version — `v4.8.2-STABLE` — which describes a build nobody here
 * ships. What is real and worth a reader's attention is which *evidence schema* a record was read
 * as, because that is what decides whether a field is absent or merely unread.
 */
const EVIDENCE_SCHEMA_VERSION = "evidence/v1";

/** How many passages lead the knowledge block. The artifact shows two. */
const PRIMARY_CITATIONS = 2;

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** A local timestamp as a calendar day: `06 Sep 2026`. */
function calendarDay(stamp: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp ?? "");
  if (!match) return null;
  return `${match[3]} ${SHORT_MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * The window a source covers, as a person reads a date range.
 *
 * The cell carried `2026-09-04 00:00 to 2026-09-06 00:00 (Europe/Berlin)` — two timestamps, both
 * midnight, and a zone, to say "these three days". Midnight-to-midnight is how a *window* is
 * bounded, not a fact about the data, so the table states the days and the exact bounds stay on the
 * cell's `title` for anyone checking them.
 */
function coverageOf(source: EvidenceAttribution): string {
  const from = calendarDay(source.period?.start_local);
  const to = calendarDay(source.period?.end_local);

  if (from !== null && to !== null) {
    if (from === to) return from;
    // Same month and year: "06 – 13 Sep 2026" rather than repeating both.
    const [fromDay, fromMonth, fromYear] = from.split(" ");
    const [, toMonth, toYear] = to.split(" ");
    return fromMonth === toMonth && fromYear === toYear ? `${fromDay} – ${to}` : `${from} – ${to}`;
  }
  return formatInstant(source.timestamp_utc) ?? NOT_REPORTED;
}

/** The exact bounds, for the cell's title: what the shortened range was shortened from. */
function exactCoverageOf(source: EvidenceAttribution): string | undefined {
  const start = formatLocalStamp(source.period?.start_local);
  const end = formatLocalStamp(source.period?.end_local);
  if (start === null || end === null) return undefined;
  return source.period?.timezone
    ? `${start} to ${end} (${source.period.timezone})`
    : `${start} to ${end}`;
}

/* --------------------------------------------------------------------- header */

/**
 * The record header: what was asked, how the run ended, and what it cost.
 *
 * The artifact's four-cell strip, carrying the four things the backend actually recorded — status,
 * start, completion and duration — in place of its audit identifier, timestamp-without-a-date and
 * confidence percentage.
 */
export function RunHeader({ record }: { readonly record: RunRecord }): ReactNode {
  const status = runStatusOf(record);
  const duration = formatDurationMs(record.timing.totalDurationMs);
  const started = formatInstant(record.timing.startedAt);
  const audit = auditOf(record);

  return (
    /*
     * The artifact's header band: who this run was, on the left; what it did, on the right.
     *
     * Four readings on the right, not six. The agent list and the step count were both here, and
     * both are the execution column's subject — a header that lists the agents makes a reader read
     * the same six names twice before reaching the first piece of evidence. What replaces them is
     * the one reading the artifact's own header carries that Weathra can compute honestly: how
     * complete the record is, as the share of `auditOf`'s checks that passed. Not a model's
     * confidence in its answer, which is what a percentage in this slot usually is.
     */
    <header className={styles.header} data-run-header="true">
      <div className={styles.headerGrid}>
        <div className={styles.heading}>
          <p className={styles.identifiers}>
            <span className={styles.headerMark}>Audit</span>
            <span className={styles.auditId}>Evidence {record.id}</span>
          </p>
          <h1 className={styles.title}>Agent evidence log</h1>
          <p className={styles.question}>{record.question}</p>
        </div>

        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryTerm}>Status</dt>
            <dd className={styles.summaryValue} data-run-status={status.label.toLowerCase()}>
              <Badge tone={status.tone}>{status.label}</Badge>
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryTerm}>Execution</dt>
            <dd className={styles.summaryValue} data-run-duration="true">
              {duration ?? NOT_REPORTED}
            </dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryTerm}>Timestamp</dt>
            <dd className={styles.summaryValue}>
              {started && record.timing.startedAt ? (
                <time dateTime={record.timing.startedAt}>{started}</time>
              ) : (
                NOT_REPORTED
              )}
            </dd>
          </div>
          {/*
            The artifact's confidence figure, replaced by the one this record can support: the
            share of the completeness checks in "Record and traceability" that passed. Its working
            is on the page, a press away, which is the whole difference between this and a 98.4%.
          */}
          <div className={styles.summaryItem}>
            <dt className={styles.summaryTerm}>Evidence completeness</dt>
            <dd
              className={styles.summaryValue}
              data-evidence-completeness={String(audit.completeness)}
            >
              <span className={styles.completeness}>{audit.completeness}%</span>
              <span className={styles.completenessNote}>
                {audit.passed} of {audit.total} checks
              </span>
            </dd>
          </div>
        </dl>
      </div>

      {status.reason ? (
        <p className={styles.noteStrong} role="note">
          This run is partial: {status.reason}
        </p>
      ) : null}
    </header>
  );
}

/* ------------------------------------------------------------- execution flow */

/**
 * The agents that ran, in the order they ran.
 *
 * The artifact's connected timeline. Each entry carries the reason the supervisor recorded for
 * selecting it — or for failing or skipping it — which is what makes the sequence checkable rather
 * than decorative.
 */
/**
 * What each stage of the pipeline *is*, in three or four words.
 *
 * The artifact labels every node with its kind — the agent's name over a compact type line — and
 * that line is the difference between a column of names and a column a reader can follow. Nothing
 * here is data: it describes the agent, which is a fixed part of Weathra rather than anything one
 * run recorded, so it cannot disagree with a record. An agent with no entry gets no line at all.
 */
const STAGE_KINDS: Readonly<Record<string, string>> = {
  supervisor: "Routing · plan selection",
  forecast: "Retrieval · provider tools",
  current: "Retrieval · provider tools",
  satellite: "Retrieval · imagery",
  historical: "Retrieval · archive",
  analytics: "Deterministic · analytics kernel",
  rag: "Retrieval · knowledge corpus",
  synthesis: "Inference · grounded prose",
};

/** How a completed stage is announced. The artifact's word, not the record's enum. */
const STAGE_STATE_LABELS: Readonly<Record<string, string>> = {
  succeeded: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * The agents that ran, in the order they ran.
 *
 * The artifact's connected timeline: a tick on the rail, the agent's name, what kind of stage it
 * is, what it cost, and the state it ended in. One card per *logical* agent — a supervisor routing
 * two archive windows records two historical actions, and two cards headed "Historical agent"
 * makes a reader counting agents get the wrong number.
 *
 * **One line, not a paragraph.** Each stage carries the reason the supervisor recorded for it,
 * clamped to two lines; a stage that did several things says how many and keeps the list behind
 * its own disclosure. The reasons are model-written and run long, and six of them at full length
 * turned the column the page opens on into an essay.
 */
export function ExecutionFlow({ record }: { readonly record: RunRecord }): ReactNode {
  const stages = agentStages(record);

  /** The slowest stage, which is what every bar below is a share of. */
  const longest = stages.reduce(
    (slowest, stage) =>
      typeof stage.durationMs === "number" ? Math.max(slowest, stage.durationMs) : slowest,
    0,
  );
  const routing = record.routingSource
    ? (ROUTING_SOURCE_LABELS[record.routingSource] ?? humanize(record.routingSource))
    : null;

  return (
    <section className={styles.panel} aria-label="Execution flow" data-evidence-section="execution">
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Execution flow</h2>
        <span className={styles.panelCount}>
          {stages.length} {stages.length === 1 ? "stage" : "stages"}
        </span>
      </header>

      {record.routingReason ? (
        <p className={styles.note}>
          Routing: {record.routingReason}
          {routing ? ` (${routing})` : null}
        </p>
      ) : routing ? (
        <p className={styles.note}>Routing: {routing}</p>
      ) : null}

      {stages.length === 0 ? (
        <p className={styles.emptyNote}>This run recorded no agent steps.</p>
      ) : (
        <ol className={styles.steps} data-agent-sequence="true">
          {stages.map((stage, index) => {
            const share =
              longest > 0 && typeof stage.durationMs === "number"
                ? Math.max((stage.durationMs / longest) * 100, 2)
                : null;
            const kind = STAGE_KINDS[stage.agent] ?? null;
            const state = STAGE_STATE_LABELS[stage.status] ?? stepStatusLabel(stage.status);

            return (
              <li
                className={styles.step}
                key={stage.agent}
                data-status={stage.status}
                data-agent={stage.agent}
              >
                <span className={styles.stepHead}>
                  <span className={styles.stepName}>
                    {index + 1}. {agentLabel(stage.agent)}
                  </span>
                  <span className={styles.stepState} data-status={stage.status}>
                    {state}
                  </span>
                </span>

                <span className={styles.stepFacts}>
                  {kind ? <span className={styles.stepKind}>{kind}</span> : null}
                  <span className={styles.stepDuration}>
                    {formatDurationMs(stage.durationMs) ?? NOT_REPORTED}
                  </span>
                  {stage.actions.length > 1 ? (
                    <span className={styles.stepActionCount}>
                      {stage.actions.length} actions
                    </span>
                  ) : null}
                </span>

                {share === null ? null : (
                  <span className={styles.stepBar} aria-hidden="true">
                    <span className={styles.stepBarFill} style={{ inlineSize: `${share}%` }} />
                  </span>
                )}

                {/*
                  One reason, clamped. What an agent did more than once is counted above and listed
                  behind the disclosure — six stages of full model-written prose is the dump this
                  column was rebuilt to stop being.
                */}
                {stage.reasons.length > 0 ? (
                  <span className={styles.stepReason} data-clamped="true">
                    {stage.reasons[0]}
                  </span>
                ) : null}

                {stage.reasons.length > 1 ? (
                  <details className={styles.stepActionsDetail}>
                    <summary>What this agent did ({stage.reasons.length})</summary>
                    <ul className={styles.stepActions}>
                      {stage.reasons.map((reason, position) => (
                        <li key={`${stage.agent}-${position}`}>{reason}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- tool activity */

/** A stored dictionary as named lines. Renders nothing when the record stored nothing. */
function FieldList({
  label,
  fields,
}: {
  readonly label: string;
  readonly fields: readonly EvidenceField[];
}): ReactNode {
  if (fields.length === 0) return null;

  return (
    <details className={styles.disclosure}>
      <summary className={styles.disclosureSummary}>
        {label} ({fields.length})
      </summary>
      <dl className={`${styles.fieldList} ${styles.disclosureBody}`}>
        {fields.map((field) => (
          <div className={styles.fieldRow} key={field.name}>
            <dt className={styles.fieldName}>{field.name}</dt>
            <dd className={styles.fieldValue}>{field.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function ToolEntry({ activity }: { readonly activity: ToolActivity }): ReactNode {
  const result = activity.result;
  const resultClass = dataClassFor(result?.data_class);

  return (
    <li className={styles.tool} data-tool={activity.tool} data-sequence={activity.sequence}>
      <span className={styles.toolHead}>
        <span className={styles.toolName}>
          {activity.sequence}. {activity.tool}
        </span>
        {activity.agent ? (
          <span className={styles.fieldName}>called by {agentLabel(activity.agent)}</span>
        ) : null}
        {activity.durationMs === null ? null : (
          <span className={styles.fieldName}>{formatDurationMs(activity.durationMs)}</span>
        )}
      </span>

      {activity.startedAt ? (
        <span className={styles.note}>Started {formatInstant(activity.startedAt)}</span>
      ) : null}

      <FieldList label="Arguments" fields={activity.argumentFields} />

      {result === null ? (
        <p className={styles.note} data-tool-result="missing">
          No result was recorded for this call.
        </p>
      ) : result.ok ? (
        <div data-tool-result="ok">
          <p className={styles.noteStrong}>
            Returned{resultClass ? " " : ""}
            {resultClass ? <DataClassBadge dataClass={resultClass} /> : null}
          </p>
          {result.attribution ? (
            <p className={styles.note}>
              {result.attribution.provider} · {placeLabel(result.attribution.location) ?? NOT_REPORTED} ·
              retrieved {formatInstant(result.attribution.retrieved_at) ?? NOT_REPORTED}
            </p>
          ) : null}
          <FieldList label="Result values" fields={activity.resultFields} />
        </div>
      ) : (
        <p className={styles.noteStrong} data-tool-result="failed">
          Failed: {result.error_code ?? NOT_REPORTED}
          {result.error_message ? ` — ${result.error_message}` : null}
        </p>
      )}
    </li>
  );
}

/**
 * Every tool call the run made, with what it was passed and what came back.
 *
 * The artifact's "MCP evidence" panel. Its protocol banner, connected-provider line and latency
 * figure are mockup filler; what replaces them is the calls themselves, which is the thing that
 * makes a figure in the answer traceable to a retrieval.
 */
/**
 * What the run called, summarised — with the calls themselves one press away.
 *
 * A run that asked the archive twice and the analytics kernel four times drew six full cards, each
 * with its own arguments and results disclosures, and the left rail ran to twice the height of the
 * evidence beside it. The artifact's own MCP block is a *small supporting card*: what was used, how
 * much, and how it went.
 *
 * Nothing is hidden from the record — the complete trace is still here, and a person auditing a run
 * opens it. What changes is that the default screen answers "which tools did this use" instead of
 * making a reader assemble that answer from six cards.
 */
function ToolSummary({
  tools,
  sources,
}: {
  readonly tools: readonly ToolActivity[];
  readonly sources: readonly EvidenceAttribution[];
}): ReactNode {
  const byTool = new Map<string, { calls: number; failed: number; totalMs: number }>();
  for (const activity of tools) {
    const seen = byTool.get(activity.tool) ?? { calls: 0, failed: 0, totalMs: 0 };
    seen.calls += 1;
    if (activity.result?.ok === false) seen.failed += 1;
    if (typeof activity.durationMs === "number") seen.totalMs += activity.durationMs;
    byTool.set(activity.tool, seen);
  }

  const failures = tools.filter((activity) => activity.result?.ok === false).length;
  const total = tools.reduce(
    (sum, activity) => sum + (typeof activity.durationMs === "number" ? activity.durationMs : 0),
    0,
  );
  /** The providers reached *through* the tool layer, which is what the layer connected to. */
  const providers = [...new Set(sources.map((source) => source.provider))];

  return (
    <>
      {/*
        The artifact's active-tool card: one block saying what the layer is, what it reached, how
        much it did and how it went. The trace was a list of six bordered cards, each with its own
        arguments and results disclosures, and the rail ran to twice the height of the evidence
        beside it — a reader had to assemble "which tools did this use" from the calls themselves.
      */}
      <div className={styles.mcpCard} data-mcp-state={failures > 0 ? "degraded" : "complete"}>
        <p className={styles.mcpState}>
          <span className={styles.mcpStateMark} aria-hidden="true" />
          Active tool layer
          <span className={styles.mcpStateWord}>{failures > 0 ? "Degraded" : "Complete"}</span>
        </p>

        <dl className={styles.mcpFacts}>
          <div className={styles.mcpFact}>
            <dt>Interface</dt>
            <dd>Model Context Protocol</dd>
          </div>
          <div className={styles.mcpFact}>
            <dt>Connected sources</dt>
            <dd>{providers.length > 0 ? providers.join(", ") : NOT_REPORTED}</dd>
          </div>
          <div className={styles.mcpFact}>
            <dt>Calls</dt>
            <dd>
              {tools.length} across {byTool.size} {byTool.size === 1 ? "tool" : "tools"}
            </dd>
          </div>
          <div className={styles.mcpFact}>
            <dt>Total latency</dt>
            <dd>{total > 0 ? formatDurationMs(total) : NOT_REPORTED}</dd>
          </div>
        </dl>

        {failures > 0 ? (
          <p className={styles.toolFailed}>
            {failures} {failures === 1 ? "call" : "calls"} failed — listed in the trace below.
          </p>
        ) : null}
      </div>

      <ul className={styles.toolTally}>
        {[...byTool.entries()].map(([tool, seen]) => (
          <li className={styles.toolTallyRow} key={tool}>
            <span className={styles.toolTallyName}>{tool}</span>
            <span className={styles.toolTallyCount}>
              {seen.calls} {seen.calls === 1 ? "call" : "calls"}
            </span>
          </li>
        ))}
      </ul>

      <details className={styles.toolDetail}>
        <summary>
          View all {tools.length} {tools.length === 1 ? "call" : "calls"}
        </summary>
        <ol className={styles.tools} data-tool-calls="true">
          {tools.map((activity) => (
            <ToolEntry key={activity.key} activity={activity} />
          ))}
        </ol>
      </details>
    </>
  );
}

export function ToolActivityPanel({ record }: { readonly record: RunRecord }): ReactNode {
  return (
    <section
      className={styles.panel}
      aria-label="MCP evidence"
      data-evidence-section="tools"
      data-empty={record.tools.length === 0 ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>MCP evidence</h2>
      </header>

      {record.tools.length === 0 ? (
        <p className={styles.emptyNote}>No tool calls — this run retrieved nothing through a tool.</p>
      ) : (
        <ToolSummary tools={record.tools} sources={record.sources} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- sources */

/**
 * Who supplied what, for where, for when, and when it was fetched.
 *
 * The artifact's "Grounded data sources" table, with its invented providers and station identifiers
 * replaced by the attributions the run actually recorded. The table scrolls inside its own
 * container so the page never scrolls sideways.
 */
export function GroundedSources({
  sources,
  citations = [],
}: {
  readonly sources: readonly EvidenceAttribution[];
  /** Passages the run cited. The corpus is a grounded source and belongs in this table. */
  readonly citations?: readonly KnowledgeCitation[];
}): ReactNode {
  /*
   * The knowledge corpus, as a row of its own.
   *
   * A retrieval records an attribution; the corpus records citations instead, so a run that leaned
   * on documentation showed nothing in the table that said where the explanation came from. The row
   * is derived from citations the run actually recorded — the documents it read, counted — and is
   * omitted entirely when it cited none. Weathra's own corpus, so the provider is Weathra.
   */
  const documents = [...new Set(citations.map((citation) => citation.document_id))];
  return (
    <section
      className={styles.panel}
      aria-label="Grounded data sources"
      data-evidence-section="sources"
      data-tier="retrieved"
      data-empty={sources.length === 0 && documents.length === 0 ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Grounded data sources</h2>
        <span className={styles.panelCount}>
          {sources.length + (documents.length > 0 ? 1 : 0)} sources
        </span>
      </header>

      {sources.length === 0 && documents.length === 0 ? (
        <p className={styles.emptyNote}>
          No provider data — this run answered from knowledge rather than from a weather retrieval.
        </p>
      ) : (
        <>
        <p className={styles.panelLead}>
          Every source this run read, with the place and window it covers and the class of claim it
          supports. Each row is a recorded retrieval, not a catalogue entry.
        </p>
        <ScrollRegion label="Grounded data sources table" className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className="weathra-visually-hidden">
              Every source this run retrieved from, with the location and period it covers, when it
              was retrieved, and what class of data it is.
            </caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Resolved location</th>
                <th scope="col">Period covered</th>
                <th scope="col">Data class</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source, index) => {
                const dataClass = dataClassFor(source.data_class);
                return (
                  <tr
                    key={`${source.provider}-${source.retrieved_at}-${index}`}
                    data-source-class={source.data_class}
                  >
                    <td className={styles.sourceProvider}>{source.provider}</td>
                    <td>{placeLabel(source.location) ?? NOT_REPORTED}</td>
                    <td title={exactCoverageOf(source)}>{coverageOf(source)}</td>
                    <td>{dataClass ? <DataClassBadge dataClass={dataClass} /> : NOT_REPORTED}</td>
                  </tr>
                );
              })}

              {/* The corpus, where the run cited it. Derived from real citations, never invented. */}
              {documents.length > 0 ? (
                <tr data-source-class="knowledge">
                  <td className={styles.sourceProvider}>Weathra knowledge corpus</td>
                  <td>&mdash;</td>
                  <td>
                    {documents.length} {documents.length === 1 ? "document" : "documents"},{" "}
                    {citations.length} {citations.length === 1 ? "passage" : "passages"}
                  </td>
                  <td>
                    <Badge tone="neutral">KNOWLEDGE</Badge>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </ScrollRegion>
        </>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- analytics */

function StatisticFigure({ result }: { readonly result: StatisticResult }): ReactNode {
  const figure = formatStatistic(result);
  const period = figurePeriodLabel(result);

  return (
    <li className={styles.figure} data-statistic={result.statistic}>
      <span className={styles.figureLabel}>{statisticLabel(result)}</span>
      {period === null ? null : <span className={styles.figurePeriod}>{period}</span>}
      {figure === null ? (
        <span className={styles.note}>Not computable: {unavailableReason(result)}</span>
      ) : (
        <span className={styles.figureValue}>
          {figure}
          {result.unit ? ` ${result.unit}` : null}
        </span>
      )}
      <MethodNote
        method={result.method}
        pointsUsed={result.points_used}
        pointsExcluded={result.points_excluded}
        unit={result.unit || null}
      />
    </li>
  );
}

function AnomalyFigure({ report }: { readonly report: AnomalyReport }): ReactNode {
  const found = report.anomalies?.length ?? 0;

  return (
    <li className={styles.figure} data-statistic="anomalies">
      <span className={styles.figureLabel}>Anomalies · {measureLabel(report.measure)}</span>
      <span className={styles.figureValue}>
        {found} {found === 1 ? "point" : "points"}
      </span>
      <p className={styles.note}>
        Median {report.median}
        {report.unit ? ` ${report.unit}` : null}, median absolute deviation{" "}
        {report.median_absolute_deviation}, threshold {report.threshold}.
      </p>
      {report.note ? <p className={styles.note}>{report.note}</p> : null}
      <MethodNote
        method={report.method}
        pointsUsed={report.points_used}
        pointsExcluded={report.points_excluded}
        unit={report.unit || null}
      />
    </li>
  );
}

function TrendFigure({ report }: { readonly report: TrendReport }): ReactNode {
  return (
    <li className={styles.figure} data-statistic="trend">
      <span className={styles.figureLabel}>Trend · {measureLabel(report.measure)}</span>
      <span className={styles.figureValue}>{humanize(report.direction)}</span>
      <p className={styles.note}>
        {report.slope_per_day} {report.unit} per day, {report.magnitude} {report.unit} across the
        window.
      </p>
      <MethodNote
        method={report.method}
        pointsUsed={report.points_used}
        pointsExcluded={report.points_excluded}
        unit={report.unit || null}
      />
    </li>
  );
}

/**
 * What Weathra computed, and how.
 *
 * Its own `ProvenanceSection` of the ANALYTICS class, so the tier is on the DOM: these figures were
 * calculated deterministically from retrieved values, by Weathra and not by a language model, and
 * each carries the method that produced it.
 */
export function DeterministicAnalytics({ record }: { readonly record: RunRecord }): ReactNode {
  /*
   * Everything the run computed, from wherever it recorded it.
   *
   * `analytics_results` on a stored record is empty by design — the backend leaves the figures
   * inside the tool payloads they arrived in rather than keeping a second copy that can disagree —
   * so recovering them is reading what the record already holds, not inventing a statistic. A run
   * that computed through the analytics *agent* and one that computed through the tool boundary
   * present identically here, which is what they are.
   */
  const recovered = analyticsFromTools(record);
  const statistics = [...record.statistics, ...recovered.statistics];
  const anomalies = [...record.anomalies, ...recovered.anomalies];
  const trends = [...record.trends, ...recovered.trends];

  if (statistics.length === 0 && anomalies.length === 0 && trends.length === 0) {
    return (
      <section
        className={styles.panel}
        aria-label="Deterministic analytics"
        data-evidence-section="analytics"
        data-empty="true"
      >
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Deterministic analytics</h2>
        </header>
        <p className={styles.emptyNote}>
          No statistics — this run had no retrieved series to compute over.
        </p>
      </section>
    );
  }

  /*
   * Three figures lead, chosen by what a decision turns on rather than by storage order.
   *
   * A comparison run records a mean, a minimum, a maximum and a range for each window and then the
   * differences between them; rendering those as stored puts "minimum of the first window" where
   * the artifact puts the finding. `leadingFigures` leads a comparison with its two sides and the
   * difference, and everything else with the figures that answer "is this unusual" before the ones
   * that answer "how much". Nothing is dropped: the rest is one press away.
   */
  const leading = leadingFigures(statistics);
  const secondary = [...leading.rest];

  /*
   * The anomaly scan and the trend are findings in their own right, so they compete for the third
   * card rather than waiting behind every descriptive statistic the kernel happened to compute.
   * A run with a real anomaly and four means should lead with the anomaly.
   */
  const spare = PRIMARY_FIGURES - leading.primary.length;
  const promotedAnomalies = anomalies.slice(0, Math.max(0, spare));
  const promotedTrends = trends.slice(0, Math.max(0, spare - promotedAnomalies.length));
  const remainingAnomalies = anomalies.slice(promotedAnomalies.length);
  const remainingTrends = trends.slice(promotedTrends.length);

  const total = statistics.length + anomalies.length + trends.length;
  const held = secondary.length + remainingAnomalies.length + remainingTrends.length;

  return (
    <div data-evidence-section="analytics">
      <ProvenanceSection dataClass="analytics" title="Deterministic analytics">
        <p className={styles.panelLead}>
          Computed by Weathra from the retrieved series, never by a language model. Every figure
          carries the method that produced it and the points it used.
        </p>

        <ul className={styles.figures} data-primary-figures="true">
          {leading.primary.map((result, index) => (
            <StatisticFigure key={`${result.statistic}-${result.measure}-${index}`} result={result} />
          ))}
          {promotedAnomalies.map((report, index) => (
            <AnomalyFigure key={`anomaly-${report.measure}-${index}`} report={report} />
          ))}
          {promotedTrends.map((report, index) => (
            <TrendFigure key={`trend-${report.measure}-${index}`} report={report} />
          ))}
        </ul>

        {held > 0 ? (
          <details className={styles.moreFigures}>
            <summary>Every figure this run computed ({total})</summary>
            <ul className={styles.figures}>
              {secondary.map((result, index) => (
                <StatisticFigure
                  key={`rest-${result.statistic}-${result.measure}-${index}`}
                  result={result}
                />
              ))}
              {remainingAnomalies.map((report, index) => (
                <AnomalyFigure key={`rest-anomaly-${report.measure}-${index}`} report={report} />
              ))}
              {remainingTrends.map((report, index) => (
                <TrendFigure key={`rest-trend-${report.measure}-${index}`} report={report} />
              ))}
            </ul>
          </details>
        ) : null}
      </ProvenanceSection>
    </div>
  );
}

/* ----------------------------------------------------------------- knowledge */

/**
 * The knowledge chunks the run retrieved and cited.
 *
 * Its own region, and deliberately not one of the five data classes: a corpus passage is
 * documentation, not a measurement, and badging it as one would be the conflation
 * `specs/safety-grounding` forbids. Each fragment carries its document, its position in that
 * document, and the relevance score the retriever recorded — enough to find it again.
 */
/** One retrieved passage, as the artifact's reference card draws it. */
function CitationCard({
  citation,
  clamped,
}: {
  readonly citation: KnowledgeCitation;
  readonly clamped: boolean;
}): ReactNode {
  return (
    <li className={styles.citation} data-document={citation.document_id}>
      <span className={styles.citationHead}>
        <span className={styles.citationRef}>
          {citation.document_id}
          {citation.chunk_position === null || citation.chunk_position === undefined
            ? ""
            : ` · ${citation.chunk_position}`}
        </span>
        {typeof citation.score === "number" ? (
          <span className={styles.citationScore}>
            relevance {Math.round(citation.score * 100) / 100}
          </span>
        ) : null}
      </span>

      <span className={styles.citationTitle}>{citation.title}</span>

      <blockquote className={styles.citationText} data-clamped={clamped ? "true" : undefined}>
        {citation.text}
      </blockquote>

      <span className={styles.citationSource}>
        Weathra knowledge corpus
        {citation.topic ? ` · ${citation.topic}` : null}
      </span>

      {clamped ? (
        <details className={styles.citationMore}>
          <summary>View full passage</summary>
          <blockquote className={styles.citationFull}>{citation.text}</blockquote>
        </details>
      ) : null}
    </li>
  );
}

/**
 * The knowledge chunks the run retrieved and cited.
 *
 * Its own region, and deliberately not one of the five data classes: a corpus passage is
 * documentation, not a measurement, and badging it as one would be the conflation
 * `specs/safety-grounding` forbids. Each fragment carries its document, its position in that
 * document, and the relevance score the retriever recorded — enough to find it again.
 *
 * **Two cards, and a line when there are none.** The artifact leads with two passages and puts the
 * rest behind "explore all", because a reader scanning for why a conclusion holds needs the
 * passages that most supported it. A run that cited nothing gets one muted line: a full panel
 * explaining what a corpus is, on a run that did not use one, was the largest empty region on the
 * narrow record and it said nothing.
 */
export function KnowledgeEvidence({
  citations,
}: {
  readonly citations: readonly KnowledgeCitation[];
}): ReactNode {
  /** Strongest first, so "the top two" is by relevance rather than by retrieval order. */
  const ranked = [...citations].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const leadingCitations = ranked.slice(0, PRIMARY_CITATIONS);
  const remainingCitations = ranked.slice(PRIMARY_CITATIONS);

  if (citations.length === 0) {
    return (
      <section
        className={styles.panel}
        aria-label="RAG knowledge evidence"
        data-evidence-section="knowledge"
        data-tier="knowledge"
        data-empty="true"
      >
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>RAG knowledge evidence</h2>
        </header>
        <p className={styles.emptyNote}>
          No knowledge cited — this run answered from retrieved data alone.
        </p>
      </section>
    );
  }

  return (
    <section
      className={styles.panel}
      aria-label="RAG knowledge evidence"
      data-evidence-section="knowledge"
      data-tier="knowledge"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>RAG knowledge evidence</h2>
        <span className={styles.panelCount}>
          {citations.length} {citations.length === 1 ? "passage" : "passages"}
        </span>
      </header>

      <p className={styles.panelLead}>
        Retrieved from Weathra&rsquo;s weather-knowledge corpus. Explanatory documentation, not
        measurement, and not a weather source.
      </p>

      <ul className={styles.citations} data-citations="true">
        {leadingCitations.map((citation, index) => (
          <CitationCard
            key={`${citation.document_id}-${citation.chunk_position}-${index}`}
            citation={citation}
            clamped
          />
        ))}
      </ul>

      {remainingCitations.length > 0 ? (
        <details className={styles.moreFigures}>
          <summary>Explore all knowledge fragments ({citations.length})</summary>
          <ul className={styles.citations}>
            {remainingCitations.map((citation, index) => (
              <CitationCard
                key={`rest-${citation.document_id}-${citation.chunk_position}-${index}`}
                citation={citation}
                clamped={false}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------- context */

/**
 * What the run decided the question was about, and where each part came from.
 *
 * The artifact's "Context used" panel, which shows a conversation excerpt and a preference profile.
 * What Weathra can honestly show is narrower and more useful: the location and window the run
 * resolved to, the units it used, and whether each came from the request, the conversation, or the
 * person's saved preferences — so "you used my saved default" is distinguishable from "you guessed".
 */
/** One named field of the context panel. Renders `not reported` rather than disappearing. */
function ContextField({
  name,
  value,
  attribute,
}: {
  readonly name: string;
  readonly value: ReactNode;
  readonly attribute?: Record<string, string>;
}): ReactNode {
  return (
    <div className={styles.contextField} {...attribute}>
      <dt className={styles.contextName}>{name}</dt>
      <dd className={styles.contextValue}>{value}</dd>
    </div>
  );
}

/** Where a resolved value came from, as the artifact labels it. */
function sourceWords(source: string | null | undefined): string | null {
  if (typeof source !== "string" || source === "") return null;
  return humanize(source);
}

/**
 * What the run decided the question was about, and where each part came from.
 *
 * The artifact's "Context used (agent memory)" panel, in two columns: what the *conversation*
 * established, and what the analysis was actually run with. Its own shows a chat excerpt and a
 * preference profile; what Weathra can honestly show is the request, the thread it belonged to,
 * the place and window the run resolved to, and whether each came from the request, the
 * conversation or the person's saved preferences — so "you used my saved default" is
 * distinguishable from "you guessed".
 *
 * **Field groups, not a sentence.** The backend writes a context statement — "Using London … in
 * metric units" — and it was the first thing in this panel, which made the designed fields under
 * it read as a restatement of a sentence a reader had already read. The statement is still here,
 * under the fields it summarises, where it explains rather than pre-empts.
 */
export function ResolvedContextPanel({ record }: { readonly record: RunRecord }): ReactNode {
  const resolved = record.answer?.resolved ?? null;
  const locations = resolved?.locations ?? [];
  const period = resolved?.period ?? null;
  const places = locations.map((place) => placeLabel(place)).filter(Boolean);

  return (
    <section
      className={styles.panel}
      aria-label="Context used (agent memory)"
      data-evidence-section="context"
      data-empty={resolved === null ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Context used (agent memory)</h2>
      </header>

      {resolved === null ? (
        <p className={styles.emptyNote}>
          No place or window to resolve — this run answered a general question.
        </p>
      ) : (
        <>
          <div className={styles.contextColumns}>
            <div className={styles.contextColumn}>
              <h3 className={styles.contextHeading}>Conversation context</h3>
              <dl className={styles.contextList}>
                <ContextField name="Request" value={record.question} />
                <ContextField
                  name="Focus location"
                  value={places.length > 0 ? places.join(", ") : NOT_REPORTED}
                />
                <ContextField
                  name="Prior context"
                  value={
                    record.threadId
                      ? `Continued in conversation ${record.threadId}`
                      : "None — this run opened its own conversation"
                  }
                />
              </dl>
            </div>

            <div className={styles.contextColumn}>
              <h3 className={styles.contextHeading}>Analyst context</h3>
              <dl className={styles.contextList}>
                <ContextField
                  name="Resolved location"
                  attribute={{ "data-resolved-location": "true" }}
                  value={
                    <>
                      {places.length > 0 ? places.join(", ") : NOT_REPORTED}
                      {sourceWords(resolved.location_source) ? (
                        <span className={styles.contextOrigin}>
                          from the {resolved.location_source}
                        </span>
                      ) : null}
                    </>
                  }
                />
                <ContextField
                  name="Analysis period"
                  attribute={{ "data-resolved-period": "true" }}
                  value={
                    period
                      ? `${formatLocalStamp(period.start_local)} to ${formatLocalStamp(period.end_local)}` +
                        (period.timezone ? ` (${period.timezone})` : "")
                      : NOT_REPORTED
                  }
                />
                <ContextField
                  name="Units"
                  value={
                    <>
                      {resolved.unit_system ?? NOT_REPORTED}
                      {sourceWords(resolved.units_source) ? (
                        <span className={styles.contextOrigin}>
                          from the {resolved.units_source}
                        </span>
                      ) : null}
                    </>
                  }
                />
                {resolved.criterion ? (
                  <ContextField name="Criterion" value={humanize(resolved.criterion)} />
                ) : null}
              </dl>
            </div>
          </div>

          {resolved.statement ? (
            <p className={styles.contextStatement}>{resolved.statement}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- uncertainty */

/**
 * The forecast uncertainty the backend stated, shown only when it stated one.
 *
 * The artifact's header carries a "Confidence 98.4%" figure with nothing behind it, which
 * `docs/design/screens.md` §5 records as refused. What is shown instead is the band the backend
 * reported together with the basis it rests on — and nothing at all when the run reported neither.
 */
export function UncertaintyPanel({ record }: { readonly record: RunRecord }): ReactNode {
  const uncertainty = record.answer?.uncertainty ?? null;
  const confidence = confidenceOf(uncertainty);
  if (uncertainty === null || confidence === null || !uncertainty.basis) return null;

  return (
    <section
      className={styles.panel}
      aria-label="Forecast uncertainty"
      data-evidence-section="uncertainty"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Forecast uncertainty</h2>
      </header>
      <UncertaintyIndicator
        confidence={confidence}
        basis={uncertainty.basis}
        hoursAhead={horizonHoursOf(uncertainty)}
        spreadAvailable={uncertainty.spread_available ?? null}
      />
    </section>
  );
}

/* ----------------------------------------------------------------- synthesis */

/**
 * The final grounded synthesis: the language model's prose, in its own region.
 *
 * `InterpretationPanel` carries the badge, the fixed sentence saying the model produced no
 * measurement, and the provider and model the backend reported. The grounding report goes in the
 * footer, because whether every figure in the prose matched the evidence is the one thing a reader
 * of an evidence record most needs to know about it.
 */
export function FinalSynthesis({ record }: { readonly record: RunRecord }): ReactNode {
  const grounding = record.answer?.grounding ?? null;
  const unanswered = record.answer?.unansweredParts ?? [];
  const clarification = record.answer?.clarificationQuestion ?? null;
  const inference = inferenceMetadataFrom(record.inferenceAttempts, {
    provider: record.llmProvider,
    model: record.llmModel,
  });

  /*
   * What the conclusion rests on, as chips.
   *
   * The artifact puts a row of evidence references under its conclusion, and the honest version is
   * the run's own: which data classes reached the writer, and how many sources and passages were
   * behind them. Every chip is a count of something on this page, so a reader can follow each one
   * up rather than take it.
   */
  const chips: string[] = [];
  if (record.sources.length > 0) {
    chips.push(`${record.sources.length} ${record.sources.length === 1 ? "source" : "sources"}`);
  }
  if (record.citations.length > 0) {
    chips.push(
      `${record.citations.length} ${record.citations.length === 1 ? "passage" : "passages"}`,
    );
  }
  if (grounding?.figures_checked) chips.push(`${grounding.figures_checked} figures checked`);
  for (const value of record.dataClasses) {
    const dataClass = dataClassFor(value);
    if (dataClass !== null) chips.push(humanize(value));
  }

  return (
    <div data-evidence-section="synthesis">
      <InterpretationPanel
        title="Final grounded synthesis"
        /*
         * What actually served the run — task 33.6, from the stored attempts.
         *
         * The record holds both accounts: `llm_provider` and `llm_model` are the configured client,
         * and the attempts are what ran, with the policy that resolved each.
         */
        provider={inference?.provider ?? null}
        model={inference?.model ?? null}
        requestedModel={inference?.requestedModel ?? null}
        policy={inference?.policyId ?? null}
        resolution={inference?.resolutionReason ?? null}
        served={inference?.served ?? true}
        /*
         * The model, the policy and the resolver move into the disclosure below.
         *
         * They were four lines set at the same weight as the conclusion, directly under it, so the
         * panel read as a debug envelope with a paragraph inside — which is exactly what the
         * artifact's synthesis is not. `placement="detail"` is the hook the primitive already has
         * for this: the same component renders the same strings, one press away.
         */
        placement="detail"
        footer={
          <>
            {/*
              The verdict on one line; the method behind it one press away. A *failure* is never
              folded away: an ungrounded figure stays in full, because that is the case a reader
              must not have to open anything to see.
            */}
            {grounding === null ? (
              <p className={styles.note}>This run recorded no grounding report.</p>
            ) : grounding.verified ? (
              <p className={styles.groundingVerified}>Grounding verified</p>
            ) : (
              <p className={styles.noteStrong}>
                {grounding.prose_discarded
                  ? "The interpretation was withheld because it could not be grounded in the evidence above."
                  : "Some figures in this interpretation could not be matched to the evidence above: " +
                    ((grounding.ungrounded_figures ?? []).join(", ") ||
                      grounding.note ||
                      "unstated") +
                    "."}
              </p>
            )}

            {chips.length > 0 ? (
              <p className={styles.evidenceChips} data-evidence-chips="true">
                {chips.map((chip) => (
                  <span className={styles.evidenceChip} key={chip}>
                    {chip}
                  </span>
                ))}
              </p>
            ) : null}

            {unanswered.length > 0 ? (
              <>
                <p className={styles.noteStrong}>Not answered:</p>
                <ul className={styles.plainList}>
                  {unanswered.map((part) => (
                    <li key={part}>{part}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {/*
              Everything about *how* the conclusion was produced, in one place: which model, under
              which policy, and how the grounding check was performed. None of it is the answer,
              and all of it is what a reader checking the answer eventually wants.
            */}
            <details className={styles.groundingDetail}>
              <summary>Grounding details</summary>
              <div className={styles.groundingBody}>
                {grounding !== null && grounding.verified ? (
                  <p className={styles.note}>
                    Every figure in this interpretation matched the evidence above.{" "}
                    {grounding.figures_checked} figures checked by {grounding.method}.
                  </p>
                ) : null}
                <ModelAttribution
                  provider={inference?.provider ?? null}
                  model={inference?.model ?? null}
                  policy={inference?.policyId ?? null}
                  resolution={inference?.resolutionReason ?? null}
                  requestedModel={inference?.requestedModel ?? null}
                  served={inference?.served ?? true}
                />
              </div>
            </details>
          </>
        }
      >
        {clarification ? <p>{clarification}</p> : null}
        {record.answerProse ? (
          <p className={styles.synthesisProse}>{readableProse(record.answerProse)}</p>
        ) : clarification ? null : (
          <p>
            No interpretation was stored for this run. The retrieved and computed evidence above is
            unaffected.
          </p>
        )}
      </InterpretationPanel>
    </div>
  );
}

/* -------------------------------------------------------------- the provenance */

/**
 * The provenance line under the whole record.
 *
 * The weather provider the row recorded, and the instant the run finished. `AttributionFooter`
 * renders `not reported` for anything the backend did not supply, which is what keeps this line
 * from acquiring a plausible-looking default.
 */
export function RecordProvenance({ record }: { readonly record: RunRecord }): ReactNode {
  const classes = record.dataClasses
    .map((value) => dataClassFor(value))
    .filter((value): value is NonNullable<typeof value> => value !== null);

  return (
    <AttributionFooter
      attribution={{
        provider: record.weatherProvider,
        location: placeLabel(record.answer?.resolved?.locations?.[0]),
        retrievedAt: record.timing.completedAt,
      }}
    >
      <p className={styles.note}>
        Data classes in this run:{" "}
        {classes.length > 0 ? (
          classes.map((dataClass) => <DataClassBadge key={dataClass} dataClass={dataClass} />)
        ) : (
          <span>{NOT_REPORTED}</span>
        )}
      </p>
    </AttributionFooter>
  );
}

/**
 * The audit card the artifact closes on, from identifiers Weathra actually holds.
 *
 * Its own carries a signature hash, a chain of custody, an agent version and an "audit stability
 * index", none of which exist — Weathra keeps a run record for observability, and saying otherwise
 * would be the most consequential possible lie on an evidence screen. What sits in that slot is
 * what a person tracing this run would actually need: the three identifiers, when it was stored,
 * what answered it, and whether the record is complete.
 */
export function RecordAudit({
  record,
  response,
}: {
  readonly record: RunRecord;
  /** The record as served, which is what the hash is taken over. */
  readonly response: unknown;
}): ReactNode {
  const status = runStatusOf(record);
  const audit = auditOf(record);
  const events = provenanceOf(record);
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void recordHash(response).then((digest) => {
      if (live) setHash(digest);
    });
    return () => {
      live = false;
    };
  }, [response]);

  return (
    <section
      className={styles.panel}
      aria-label="Record and traceability"
      data-evidence-section="audit"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Record and traceability</h2>
        <span className={styles.integrityState} data-state={audit.state.toLowerCase()}>
          {audit.state}
        </span>
      </header>

      {/*
        The artifact's stability bar, filled by something a reader can check: the share of the
        completeness checks below that passed. Not a model's confidence in its own answer — which is
        what a percentage on an evidence screen usually is, and what nothing here can honestly be.
      */}
      {/*
        The checks are the figure's working, and they belong under it rather than beside it: this is
        the artifact's audit slot, not a feature of its own. Folded away when everything passed,
        because a reader only needs the list when the state is not "optimal".
      */}
      <details className={styles.moreFigures} open={audit.state !== "Optimal"}>
        <summary>
          Evidence complete — {audit.passed} of {audit.total} checks
        </summary>
        <ul className={styles.checks}>
          {audit.checks.map((check) => (
            <li className={styles.check} key={check.id} data-passed={check.passed ? "true" : "false"}>
              <span className={styles.checkMark} aria-hidden="true">
                {check.passed ? "\u2713" : "\u2715"}
              </span>
              <span>
                {check.label}
                {check.note ? <span className={styles.quiet}> — {check.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </details>

      <dl className={styles.auditFacts}>
        <div className={styles.auditFact}>
          <dt>Evidence</dt>
          <dd className={styles.auditMono} title={record.id}>
            {record.id}
          </dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Request</dt>
          <dd className={styles.auditMono} title={record.requestId}>
            {record.requestId}
          </dd>
        </div>
        {record.threadId ? (
          <div className={styles.auditFact}>
            <dt>Conversation</dt>
            <dd className={styles.auditMono} title={record.threadId}>
              {record.threadId}
            </dd>
          </div>
        ) : null}
        <div className={styles.auditFact}>
          <dt>Stored</dt>
          <dd>{record.timing.storedAt ? formatInstant(record.timing.storedAt) : NOT_REPORTED}</dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Record</dt>
          <dd>{status.label}</dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Answered by</dt>
          <dd>
            {record.llmModel
              ? `${record.llmProvider ? `${record.llmProvider} · ` : ""}${record.llmModel}`
              : "No model recorded"}
          </dd>
        </div>
        {/*
          A hash, and called one. It shows two readings of this record are byte-identical; nothing
          signs it with a key, so "signature" would claim an assurance Weathra does not provide.
        */}
        <div className={styles.auditFact}>
          <dt>Record hash</dt>
          <dd className={styles.auditMono} title={hash ?? undefined}>
            {hash === null ? NOT_REPORTED : `${hash.slice(0, 8)}…${hash.slice(-6)}`}
          </dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Evidence schema</dt>
          <dd>{EVIDENCE_SCHEMA_VERSION}</dd>
        </div>
      </dl>

      {events.length > 0 ? (
        <details className={styles.moreFigures}>
          <summary>View provenance ({events.length} events)</summary>
          <ol className={styles.provenance}>
            {events.map((event, index) => (
              <li className={styles.provenanceEvent} key={`${event.at}-${index}`}>
                <span className={styles.provenanceAt}>{formatInstant(event.at)}</span>
                <span>
                  {event.label}
                  {event.detail ? <span className={styles.quiet}> — {event.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <p className={styles.emptyNote}>
        Computed from this record. Weathra does not sign or certify a run, and claims no compliance.
      </p>
    </section>
  );
}

/* -------------------------------------------------------- the empty workspace */

/**
 * One region of the workspace, drawn with nothing in it.
 *
 * A mark in the region's own class, its name, and one line naming the record field it holds. The
 * mark is what makes a column of these read as a designed preview rather than as seven panels that
 * failed to load — and it is the same colour the populated panel's own figures will carry.
 */
function EmptyPanel({
  title,
  note,
  dataClass,
}: {
  readonly title: string;
  readonly note: string;
  readonly dataClass: "observed" | "forecast" | "historical" | "analytics" | "interpretation";
}): ReactNode {
  return (
    <section className={styles.emptyPanel} aria-label={title} data-class={dataClass}>
      <span className={styles.emptyPanelMark} aria-hidden="true" />
      <h2 className={styles.emptyPanelTitle}>{title}</h2>
      <p className={styles.emptyPanelNote}>{note}</p>
    </section>
  );
}

/**
 * The evidence workspace with no run selected.
 *
 * Same regions, same two columns, same order as a populated record — `05-agent-evidence.png` is a
 * workspace and this keeps its silhouette.
 *
 * **Twice now the correction has been about density rather than about content.** The first version
 * collapsed to a paragraph, so `/evidence` and `/evidence/{id}` were differently shaped pages. The
 * second drew seven bordered cards each holding one sentence, and the 2026-09-10 fidelity review
 * photographed the result as seven sections that had failed to load. This is the third: the same
 * seven regions, each a rule in its own data class with a name and one short line, in a grid rather
 * than a column of full-height cards. It is shorter than the page it replaces, and it reads as a
 * contents page for a record — which is what it is.
 *
 * Nothing here is a status. No region claims to be waiting on anything, because nothing has been
 * asked; they are the fields a stored record has.
 */
export function EvidenceWorkspaceSkeleton(): ReactNode {
  return (
    <div className={styles.preview} data-evidence-preview="true">
      <p className={styles.previewLead}>
        These are the fields a run&rsquo;s record holds. Open one from the answer that produced it.
      </p>

      <div className={styles.previewGrid}>
        <EmptyPanel
          title="Execution flow"
          note="The agents that ran, in order, with their timings."
          dataClass="analytics"
        />
        <EmptyPanel
          title="Grounded data sources"
          note="Each provider read, with the window it covered."
          dataClass="observed"
        />
        <EmptyPanel
          title="Tool activity"
          note="Every tool call the run made, and what each returned."
          dataClass="forecast"
        />
        <EmptyPanel
          title="Deterministic analytics"
          note="Figures Weathra computed, with their methods."
          dataClass="analytics"
        />
        <EmptyPanel
          title="Uncertainty"
          note="The confidence the backend stated, and its basis."
          dataClass="forecast"
        />
        <EmptyPanel
          title="Retrieved knowledge"
          note="Passages cited from the weather-knowledge corpus."
          dataClass="historical"
        />
        <EmptyPanel
          title="Final grounded synthesis"
          note="The model's reading, checked against the figures above."
          dataClass="interpretation"
        />
        <EmptyPanel
          title="Context used"
          note="The location, period and units the run resolved to."
          dataClass="observed"
        />
      </div>
    </div>
  );
}
