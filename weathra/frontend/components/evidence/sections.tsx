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
  AgentStep,
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
  formatDurationMs,
  hasAnalytics,
  runStatusOf,
  type EvidenceField,
  type RunRecord,
  type ToolActivity,
} from "@/lib/evidence/record";
import { formatStatistic, unavailableReason } from "@/lib/historical/analysis";
import { inferenceMetadataFrom } from "@/lib/inference/served";

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

/** The window or the instant a source covers, as the backend resolved it. */
function coverageOf(source: EvidenceAttribution): string {
  const start = formatLocalStamp(source.period?.start_local);
  const end = formatLocalStamp(source.period?.end_local);
  if (start !== null && end !== null) {
    return source.period?.timezone ? `${start} to ${end} (${source.period.timezone})` : `${start} to ${end}`;
  }
  return formatInstant(source.timestamp_utc) ?? NOT_REPORTED;
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
  const completed = formatInstant(record.timing.completedAt);
  const involved = [...new Set(record.agents.map((step) => agentLabel(step.agent)))];

  return (
    <header className={styles.header} data-run-header="true">
      <div className={styles.headerTop}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Agent evidence</h1>
          <p className={styles.question}>{record.question}</p>
          <p className={styles.subtitle}>
            The record of one run: the agents that ran, every tool call and what it returned, the
            deterministic analytics and their methods, the knowledge cited, and the timings. It is
            a run record kept for observability, not a compliance artifact.
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <dl className={styles.summary}>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Status</dt>
          <dd className={styles.summaryValue} data-run-status={status.label.toLowerCase()}>
            {status.label}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Started</dt>
          <dd className={styles.summaryValue}>
            {started && record.timing.startedAt ? (
              <time dateTime={record.timing.startedAt}>{started}</time>
            ) : (
              NOT_REPORTED
            )}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Completed</dt>
          <dd className={styles.summaryValue}>
            {completed && record.timing.completedAt ? (
              <time dateTime={record.timing.completedAt}>{completed}</time>
            ) : (
              NOT_REPORTED
            )}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Duration</dt>
          <dd className={styles.summaryValue} data-run-duration="true">
            {duration ?? NOT_REPORTED}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Graph steps</dt>
          <dd className={styles.summaryValue} data-run-steps="true">
            {record.timing.stepsUsed ?? NOT_REPORTED}
          </dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryTerm}>Agents involved</dt>
          <dd className={styles.summaryValue} data-agents-involved="true">
            {involved.length > 0 ? involved.join(", ") : "None recorded"}
          </dd>
        </div>
      </dl>

      {status.reason ? (
        <p className={styles.noteStrong} role="note">
          This run is partial: {status.reason}
        </p>
      ) : null}

      {/* The identifiers the backend actually returns. No audit id, no signature, no node name. */}
      <p className={styles.identifiers}>
        <span>Evidence {record.id}</span>
        <span>Request {record.requestId}</span>
        {record.threadId ? <span>Conversation {record.threadId}</span> : null}
        {record.timing.storedAt ? <span>Stored {formatInstant(record.timing.storedAt)}</span> : null}
      </p>
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

      {record.agents.length === 0 ? (
        <p className={styles.note}>This run recorded no agent steps.</p>
      ) : (
        <ol className={styles.steps} data-agent-sequence="true">
          {record.agents.map((step: AgentStep, index) => (
            <li
              className={styles.step}
              key={`${step.sequence ?? index}-${step.agent}`}
              data-status={step.status}
              data-agent={step.agent}
            >
              <span className={styles.stepHead}>
                <span className={styles.stepName}>
                  {index + 1}. {agentLabel(step.agent)}
                </span>
                <span className={styles.stepMeta}>{stepStatusLabel(step.status)}</span>
              </span>
              <span className={styles.stepMeta}>
                {formatDurationMs(step.duration_ms) ?? NOT_REPORTED}
                {step.started_at ? ` · started ${formatInstant(step.started_at)}` : null}
              </span>
              {step.reason ? <span className={styles.stepReason}>{step.reason}</span> : null}
            </li>
          ))}
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
              {result.attribution.provider} · {result.attribution.location?.display_name ?? NOT_REPORTED} ·
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
export function ToolActivityPanel({ record }: { readonly record: RunRecord }): ReactNode {
  return (
    <section className={styles.panel} aria-label="MCP evidence" data-evidence-section="tools">
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>MCP evidence</h2>
      </header>

      <p className={styles.note}>
        Every retrieval went through the approved tool interface. Nothing
        here was called by the browser.
      </p>

      {record.tools.length === 0 ? (
        <p className={styles.note}>This run recorded no tool calls.</p>
      ) : (
        <ol className={styles.tools} data-tool-calls="true">
          {record.tools.map((activity) => (
            <ToolEntry key={activity.key} activity={activity} />
          ))}
        </ol>
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
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Grounded data sources</h2>
      </header>

      {sources.length === 0 ? (
        <p className={styles.note}>This run recorded no retrieved data sources.</p>
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
                    <td>{source.location?.display_name ?? NOT_REPORTED}</td>
                    <td>{coverageOf(source)}</td>
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
  if (!hasAnalytics(record)) {
    return (
      <section
        className={styles.panel}
        aria-label="Deterministic analytics"
        data-evidence-section="analytics"
      >
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Deterministic analytics</h2>
        </header>
        <p className={styles.note}>This run computed no statistics.</p>
      </section>
    );
  }

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
        <ul className={styles.figures}>
          {record.statistics.map((result, index) => (
            <StatisticFigure key={`${result.statistic}-${result.measure}-${index}`} result={result} />
          ))}
          {record.anomalies.map((report, index) => (
            <AnomalyFigure key={`anomaly-${report.measure}-${index}`} report={report} />
          ))}
          {record.trends.map((report, index) => (
            <TrendFigure key={`trend-${report.measure}-${index}`} report={report} />
          ))}
        </ul>
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
        <p className={styles.note}>This run cited no knowledge.</p>
      ) : (
        <ul className={styles.citations} data-citations="true">
          {citations.map((citation, index) => (
            <li
              className={styles.citation}
              key={`${citation.document_id}-${citation.chunk_position}-${index}`}
              data-document={citation.document_id}
            >
              <span className={styles.citationHead}>
                <span className={styles.citationTitle}>{citation.title}</span>
                <span className={styles.fieldName}>
                  {citation.document_id} · chunk {citation.chunk_position}
                  {citation.topic ? ` · ${citation.topic}` : null} · relevance {citation.score}
                </span>
              </span>
              <blockquote className={styles.citationText}>{citation.text}</blockquote>
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
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Context this run resolved to</h2>
      </header>

      {resolved === null ? (
        <p className={styles.note}>This run recorded no resolved context.</p>
      ) : (
        <>
          {resolved.statement ? <p className={styles.stateBody}>{resolved.statement}</p> : null}
          <dl className={styles.fieldList}>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldName}>Resolved location</dt>
              <dd className={styles.fieldValue} data-resolved-location="true">
                {locations.length > 0
                  ? locations.map((place) => place.display_name).join(", ")
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
            {grounding === null ? (
              <p className={styles.note}>This run recorded no grounding report.</p>
            ) : grounding.verified ? (
              <p className={styles.note}>
                Grounding verified: every figure in this interpretation matched the evidence above.{" "}
                {grounding.figures_checked} checked by {grounding.method}.
              </p>
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
          <p>{record.answerProse}</p>
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
        location: record.answer?.resolved?.locations?.[0]?.display_name ?? null,
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

/* -------------------------------------------------------- the empty workspace */

/** One region of the workspace, drawn with nothing in it. */
function EmptyPanel({ title, note }: { readonly title: string; readonly note: string }): ReactNode {
  return (
    <section className={styles.panel} aria-label={title}>
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
      </header>
      <p className={styles.note}>{note}</p>
    </section>
  );
}

/**
 * The evidence workspace with no run selected.
 *
 * Same regions, same two columns, same order as a populated record — `05-agent-evidence.png` is a
 * workspace and this keeps its silhouette. Each panel says what it will hold rather than explaining
 * the feature: a person arriving from the navigation learns the shape of an evidence record by
 * looking at it.
 */
export function EvidenceWorkspaceSkeleton(): ReactNode {
  return (
    <>
      {/*
        Named as a preview, because it does not look like one.

        Seven headings each followed by one sentence and nothing else is the shape of the populated
        screen, which is why it is drawn — but the runtime audit of 2026-09-08 photographed the
        result, and it reads as seven sections that failed to load rather than as seven sections
        waiting for a run. One line naming what follows is the difference between a preview and an
        outage.
      */}
      <p className={styles.previewLead}>
        These are the sections a run&rsquo;s record fills. They stay empty until you open one.
      </p>

      <div className={styles.columns}>
        <div className={styles.column}>
          <EmptyPanel title="Execution flow" note="The agents a run took, in order, with their timings." />
          <EmptyPanel title="MCP evidence" note="Every tool call the run made, and what each returned." />
          <EmptyPanel title="Context used" note="The location, period and units the run resolved to." />
        </div>
        <div className={styles.column}>
          <EmptyPanel title="Grounded data sources" note="Each provider read, with the window it covered." />
          <EmptyPanel title="Deterministic analytics" note="Figures Weathra computed, with their methods." />
          <EmptyPanel title="Retrieved knowledge" note="Passages cited from the weather-knowledge corpus." />
          <EmptyPanel title="Final grounded synthesis" note="The model's reading, checked against the figures above." />
        </div>
      </div>
    </>
  );
}
