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

import type { ReactNode } from "react";

import {
  AttributionFooter,
  Badge,
  DataClassBadge,
  InterpretationPanel,
  MethodNote,
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
import { measureLabel } from "@/lib/dashboard/briefing";
import { dataClassFor } from "@/lib/design/data-class";
import {
  agentStages,
  leadingFigures,
  statisticsFromTools,
  formatDurationMs,
  readableProse,
  hasAnalytics,
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
  const involved = [...new Set(record.agents.map((step) => agentLabel(step.agent)))];

  return (
    /*
     * The artifact's header band: who this run was, on the left; what it did, on the right.
     *
     * These were stacked — a title, the question, a three-line paragraph explaining what an
     * evidence record is, and then a full-width strip of figures — so the band alone took a third
     * of the first screen before the trace began. The explanation is the page's least useful line
     * for someone who navigated here on purpose; it goes, and the two halves sit side by side.
     */
    <header className={styles.header} data-run-header="true">
      <div className={styles.headerGrid}>
        <div className={styles.heading}>
          <p className={styles.identifiers}>
            <span className={styles.auditId}>Evidence {record.id}</span>
            {record.timing.storedAt ? (
              <span>Stored {formatInstant(record.timing.storedAt)}</span>
            ) : null}
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
          <dt className={styles.summaryTerm}>Timestamp</dt>
          <dd className={styles.summaryValue}>
            {started && record.timing.startedAt ? (
              <time dateTime={record.timing.startedAt}>{started}</time>
            ) : (
              NOT_REPORTED
            )}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Execution</dt>
          <dd className={styles.summaryValue} data-run-duration="true">
            {duration ?? NOT_REPORTED}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Steps</dt>
          <dd className={styles.summaryValue} data-run-steps="true">
            {record.timing.stepsUsed ?? NOT_REPORTED}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Agents</dt>
          <dd className={styles.summaryValue} data-agents-involved="true">
            {involved.length > 0 ? involved.join(", ") : "None recorded"}
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
export function ExecutionFlow({ record }: { readonly record: RunRecord }): ReactNode {
  /*
   * One card per agent, not one per action.
   *
   * A supervisor routing two archive windows records two historical steps, and this drew two cards
   * headed "Historical agent" and then two more for the analytics over them — six cards for four
   * stages, so a reader counting agents got the wrong number. What an agent did more than once is
   * inside its card now.
   */
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
        <p className={styles.note}>This run recorded no agent steps.</p>
      ) : (
        <ol className={styles.steps} data-agent-sequence="true">
          {stages.map((stage, index) => {
            const share =
              longest > 0 && typeof stage.durationMs === "number"
                ? Math.max((stage.durationMs / longest) * 100, 2)
                : null;

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
                  <span className={styles.stepMeta}>{stepStatusLabel(stage.status)}</span>
                </span>
                <span className={styles.stepMeta}>
                  {formatDurationMs(stage.durationMs) ?? NOT_REPORTED}
                  {stage.actions.length > 1 ? ` \u00b7 ${stage.actions.length} actions` : null}
                  {stage.startedAt ? ` \u00b7 started ${formatInstant(stage.startedAt)}` : null}
                </span>
                {share === null ? null : (
                  <span className={styles.stepBar} aria-hidden="true">
                    <span className={styles.stepBarFill} style={{ inlineSize: `${share}%` }} />
                  </span>
                )}
                {/*
                  What the agent did. One line for one action; a list when it did several, which is
                  the detail the duplicate cards used to carry and the reason they existed.
                */}
                {stage.reasons.length === 1 ? (
                  <span className={styles.stepReason}>{stage.reasons[0]}</span>
                ) : stage.reasons.length > 1 ? (
                  <ul className={styles.stepActions}>
                    {stage.reasons.map((reason, position) => (
                      <li key={`${stage.agent}-${position}`}>{reason}</li>
                    ))}
                  </ul>
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
function ToolSummary({ tools }: { readonly tools: readonly ToolActivity[] }): ReactNode {
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

  return (
    <>
      <p className={styles.toolTotals}>
        <span>
          {tools.length} {tools.length === 1 ? "call" : "calls"}
        </span>
        <span>
          {byTool.size} {byTool.size === 1 ? "tool" : "tools"}
        </span>
        {total > 0 ? <span>{formatDurationMs(total)}</span> : null}
        {failures > 0 ? (
          <span className={styles.toolFailed}>
            {failures} failed
          </span>
        ) : null}
      </p>

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
      /*
       * The space a section takes is the space its data earns.
       *
       * A run that called no tools was given the same full panel as one that called six — a heading,
       * a paragraph about the tool interface, and a sentence saying nothing happened, for three
       * lines of meaning. On a conceptual knowledge run three such panels stacked up and the page
       * read as mostly absence. Empty sections now state themselves in one line.
       */
      data-empty={record.tools.length === 0 ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>MCP evidence</h2>
      </header>

      {record.tools.length === 0 ? (
        <p className={styles.emptyNote}>No tool calls — this run retrieved nothing through a tool.</p>
      ) : (
        <ToolSummary tools={record.tools} />
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
}: {
  readonly sources: readonly EvidenceAttribution[];
}): ReactNode {
  return (
    <section
      className={styles.panel}
      aria-label="Grounded data sources"
      data-evidence-section="sources"
      data-tier="retrieved"
      data-empty={sources.length === 0 ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Grounded data sources</h2>
      </header>

      {sources.length === 0 ? (
        <p className={styles.emptyNote}>
          No provider data — this run answered from knowledge rather than from a weather retrieval.
        </p>
      ) : (
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
                <th scope="col">Retrieved</th>
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
                    <td>{source.provider}</td>
                    <td>{placeLabel(source.location) ?? NOT_REPORTED}</td>
                    <td title={exactCoverageOf(source)}>{coverageOf(source)}</td>
                    <td>{formatInstant(source.retrieved_at) ?? NOT_REPORTED}</td>
                    <td>{dataClass ? <DataClassBadge dataClass={dataClass} /> : NOT_REPORTED}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- analytics */

function StatisticFigure({ result }: { readonly result: StatisticResult }): ReactNode {
  const figure = formatStatistic(result);

  return (
    <li className={styles.figure} data-statistic={result.statistic}>
      <span className={styles.figureLabel}>{statisticLabel(result)}</span>
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
   * A run that computed through the tool boundary rather than through the analytics agent records
   * its figures in the tool's own result. Recovering them is not inventing a statistic — it is
   * reading one the record already holds, and it stops the band from saying "no statistics" on a
   * screen whose synthesis above quotes them.
   */
  const recovered = hasAnalytics(record) ? [] : statisticsFromTools(record);

  if (!hasAnalytics(record) && recovered.length > 0) {
    return (
      <div data-evidence-section="analytics">
        <ProvenanceSection dataClass="analytics" title="Deterministic analytics">
          {/*
            Rendered by the same component the analytics list uses, so a figure the run recorded
            through a tool is presented exactly as one recorded by the agent — label, value, unit
            and the method that produced it. The band never shows a payload's envelope.
          */}
          <ul className={styles.figures}>
            {leadingFigures(recovered).primary.map((result, index) => (
              <StatisticFigure key={`${result.statistic}-${result.measure}-${index}`} result={result} />
            ))}
          </ul>
          <p className={styles.note}>
            Computed by Weathra during this run and recorded in its tool results.
          </p>
        </ProvenanceSection>
      </div>
    );
  }

  if (!hasAnalytics(record)) {
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

  const leading = leadingFigures(record.statistics);

  return (
    <div data-evidence-section="analytics">
      {/*
        A second-level heading, because this panel is a *sibling* of "Grounded data sources" and
        "Forecast uncertainty" in the same column — not a subsection of either. It was a third-level
        heading, which put it under whichever h2 preceded it in the heading list and claimed a
        containment the screen does not have; the same panel's no-statistics branch above has always
        been an h2, so the level also changed with the data.
      */}
      <ProvenanceSection dataClass="analytics" title="Deterministic analytics">
        {/*
          The band shows the figures worth leading with; the rest are a press away.
          
          A run that computed a mean, a minimum, a maximum and a range for two windows recorded ten
          results, and ten cards is a dump whatever each one says. `05-agent-evidence.png` leads
          with three. The ordering is the analytics layer's own — the order the run computed them —
          so "the first four" is not this screen ranking evidence, it is the run's own sequence.
        */}
        {/*
          Three figures lead, chosen by what a decision turns on rather than by storage order.
          
          A comparison run records ten results — a mean, a minimum, a maximum and a range for each
          window, then the differences — so rendering them as stored puts "minimum of the first
          window" where the artifact puts the anomaly. Everything past the third is behind the
          band's own disclosure; nothing is dropped.
        */}
        <ul className={styles.figures}>
          {leading.primary.map((result, index) => (
            <StatisticFigure key={`${result.statistic}-${result.measure}-${index}`} result={result} />
          ))}
          {leading.rest.length === 0
            ? record.anomalies.map((report, index) => (
                <AnomalyFigure key={`anomaly-${report.measure}-${index}`} report={report} />
              ))
            : null}
          {leading.rest.length === 0
            ? record.trends.map((report, index) => (
                <TrendFigure key={`trend-${report.measure}-${index}`} report={report} />
              ))
            : null}
        </ul>

        {leading.rest.length > 0 ? (
          <details className={styles.moreFigures}>
            <summary>
              Every figure this run computed ({record.statistics.length})
            </summary>
            <ul className={styles.figures}>
              {leading.rest.map((result, index) => (
                <StatisticFigure
                  key={`rest-${result.statistic}-${result.measure}-${index}`}
                  result={result}
                />
              ))}
              {record.anomalies.map((report, index) => (
                <AnomalyFigure key={`anomaly-${report.measure}-${index}`} report={report} />
              ))}
              {record.trends.map((report, index) => (
                <TrendFigure key={`trend-${report.measure}-${index}`} report={report} />
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
export function KnowledgeEvidence({
  citations,
}: {
  readonly citations: readonly KnowledgeCitation[];
}): ReactNode {
  return (
    <section
      className={styles.panel}
      aria-label="Retrieved knowledge"
      data-evidence-section="knowledge"
      data-tier="knowledge"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Retrieved knowledge</h2>
      </header>

      <p className={styles.note}>
        Passages retrieved from Weathra&rsquo;s weather-knowledge corpus. Explanatory documentation,
        not measurement, and not a weather source.
      </p>

      {citations.length === 0 ? (
        <p className={styles.emptyNote}>
          No knowledge cited — this run answered from retrieved data alone.
        </p>
      ) : (
        <ul className={styles.citations} data-citations="true">
          {citations.map((citation, index) => (
            <li
              className={styles.citation}
              key={`${citation.document_id}-${citation.chunk_position}-${index}`}
              data-document={citation.document_id}
            >
              {/*
                The artifact's own reference card: an identifier, a title, and the similarity, on
                one row. The passage below it is *clamped* rather than printed in full — a run that
                cited three chunks printed three paragraphs and pushed the synthesis off the screen
                the evidence exists to support. The whole passage is one press away, which is where
                a quotation belongs on a page that is summarising why it was retrieved.
              */}
              <span className={styles.citationHead}>
                <span className={styles.citationRef}>
                  {citation.document_id}
                  {citation.chunk_position === null || citation.chunk_position === undefined
                    ? ""
                    : ` · ${citation.chunk_position}`}
                </span>
                <span className={styles.citationTitle}>{citation.title}</span>
                {typeof citation.score === "number" ? (
                  <span className={styles.citationScore}>
                    relevance {Math.round(citation.score * 100) / 100}
                  </span>
                ) : null}
              </span>

              <blockquote className={styles.citationText} data-clamped="true">
                {citation.text}
              </blockquote>

              <details className={styles.citationMore}>
                <summary>View full passage</summary>
                <blockquote className={styles.citationFull}>{citation.text}</blockquote>
                {citation.topic ? (
                  <p className={styles.fieldName}>Topic: {citation.topic}</p>
                ) : null}
              </details>
            </li>
          ))}
        </ul>
      )}
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
export function ResolvedContextPanel({ record }: { readonly record: RunRecord }): ReactNode {
  const resolved = record.answer?.resolved ?? null;
  const locations = resolved?.locations ?? [];
  const period = resolved?.period ?? null;

  return (
    <section
      className={styles.panel}
      aria-label="Context this run resolved to"
      data-evidence-section="context"
      data-empty={resolved === null ? "true" : undefined}
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Context this run resolved to</h2>
      </header>

      {resolved === null ? (
        <p className={styles.emptyNote}>
          No place or window to resolve — this run answered a general question.
        </p>
      ) : (
        <>
          {resolved.statement ? <p className={styles.stateBody}>{resolved.statement}</p> : null}
          <dl className={styles.fieldList}>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldName}>Resolved location</dt>
              <dd className={styles.fieldValue} data-resolved-location="true">
                {locations.length > 0
                  ? locations.map((place) => placeLabel(place)).join(", ")
                  : NOT_REPORTED}
                {resolved.location_source ? ` (from the ${resolved.location_source})` : null}
              </dd>
            </div>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldName}>Analysis period</dt>
              <dd className={styles.fieldValue} data-resolved-period="true">
                {period
                  ? `${formatLocalStamp(period.start_local)} to ${formatLocalStamp(period.end_local)}` +
                    (period.timezone ? ` (${period.timezone})` : "")
                  : NOT_REPORTED}
              </dd>
            </div>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldName}>Units</dt>
              <dd className={styles.fieldValue}>
                {resolved.unit_system ?? NOT_REPORTED}
                {resolved.units_source ? ` (from the ${resolved.units_source})` : null}
              </dd>
            </div>
            {resolved.criterion ? (
              <div className={styles.fieldRow}>
                <dt className={styles.fieldName}>Criterion</dt>
                <dd className={styles.fieldValue}>{resolved.criterion}</dd>
              </div>
            ) : null}
          </dl>
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

  return (
    <div data-evidence-section="synthesis">
      <InterpretationPanel
        title="Final grounded synthesis"
        /*
         * What actually served the run — task 33.6, from the stored attempts.
         *
         * The record holds both accounts: `llm_provider` and `llm_model` are the configured client,
         * and the attempts are what ran, with the policy that resolved each. An evidence record is
         * read precisely to check claims, so the weaker account is used only where the record holds
         * no attempt, and is labelled as configured when it is.
         */
        provider={inference?.provider ?? null}
        model={inference?.model ?? null}
        requestedModel={inference?.requestedModel ?? null}
        policy={inference?.policyId ?? null}
        resolution={inference?.resolutionReason ?? null}
        served={inference?.served ?? true}
        footer={
          <>
            {/*
              The verdict on one line; the method behind it one press away.
              
              "Grounding verified: every figure matched the evidence above. 6 checked by figures
              extracted from the prose and matched within 0.05" is two facts — one a reader needs at
              a glance, one they need only when checking the checker. Printing both under every
              conclusion made the synthesis read as a diagnostic dump. A failure is *not* folded
              away: an ungrounded figure stays in full, because that is the case a reader must not
              have to open anything to see.
            */}
            {grounding === null ? (
              <p className={styles.note}>This run recorded no grounding report.</p>
            ) : grounding.verified ? (
              <>
                <p className={styles.groundingVerified}>Grounding verified</p>
                <p className={styles.note}>
                  Every figure in this interpretation matched the evidence above.
                </p>
                <details className={styles.groundingDetail}>
                  <summary>Grounding details</summary>
                  <p className={styles.note}>
                    {grounding.figures_checked} figures checked by {grounding.method}.
                  </p>
                </details>
              </>
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
export function RecordAudit({ record }: { readonly record: RunRecord }): ReactNode {
  const status = runStatusOf(record);
  const model = record.llmModel ?? null;
  const provider = record.llmProvider ?? null;

  return (
    <section
      className={styles.panel}
      aria-label="Record and traceability"
      data-evidence-section="audit"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Record and traceability</h2>
      </header>

      <dl className={styles.auditFacts}>
        <div className={styles.auditFact}>
          <dt>Evidence</dt>
          <dd className={styles.auditMono}>{record.id}</dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Request</dt>
          <dd className={styles.auditMono}>{record.requestId}</dd>
        </div>
        {record.threadId ? (
          <div className={styles.auditFact}>
            <dt>Conversation</dt>
            <dd className={styles.auditMono}>{record.threadId}</dd>
          </div>
        ) : null}
        <div className={styles.auditFact}>
          <dt>Stored</dt>
          <dd>
            {record.timing.storedAt ? formatInstant(record.timing.storedAt) : NOT_REPORTED}
          </dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Record</dt>
          <dd>{status.label}</dd>
        </div>
        <div className={styles.auditFact}>
          <dt>Answered by</dt>
          <dd>
            {model ? `${provider ? `${provider} · ` : ""}${model}` : "No model recorded"}
          </dd>
        </div>
      </dl>

      <p className={styles.emptyNote}>
        Kept for observability. Weathra does not sign or seal a run record, and does not claim to.
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
