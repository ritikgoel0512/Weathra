"use client";

/**
 * The AI Weather Analyst's surfaces — task 21.2, against
 * `docs/design/screens/02-ai-weather-analyst.png`.
 *
 * The artifact's answer card establishes the order this reproduces: the interpretation badge and
 * the model's prose, then the retrieved and computed figures as their own labelled panels beside
 * it, then the provenance line beneath. What it does not establish, and what the specs do, is what
 * goes *in* those panels — and the answer to that is only ever what the backend sent.
 *
 * Three rules the components below exist to enforce:
 *
 * **A step is an event.** `RunProgress` renders `runStepsFrom`'s output and nothing else. There is
 * no placeholder row for a stage that has not reported, and no row for a stage the backend does not
 * emit. A progress list is a claim about what happened.
 *
 * **A figure carries its class and its source.** Every finding renders inside a `ProvenanceSection`
 * of its own data class with its own `AttributionFooter`, so a forecast figure and an archive
 * figure in one answer carry separate providers, periods and retrieval times rather than a blended
 * credit line.
 *
 * **The model's language is a region, not a paragraph.** The prose goes through
 * `InterpretationPanel`, which carries the badge and the fixed sentence saying the model produced
 * no measurement. Nothing numeric is passed to it.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  AttributionFooter,
  Badge,
  DataClassBadge,
  EmptyState,
  InterpretationPanel,
  MethodNote,
  ProvenanceSection,
  UncertaintyIndicator,
  formatInstant,
  formatLocalStamp,
} from "@/components/ui";
import type { AnswerEnvelope, EvidenceAttribution, Finding } from "@/lib/api/schema";
import {
  agentLabel,
  confidenceOf,
  findingGroups,
  GROUP_TITLES,
  findingValue,
  horizonHoursOf,
  type RunStep,
} from "@/lib/analyst/run";
import { evidencePath } from "@/lib/routes";
import styles from "./analyst.module.css";

/* --------------------------------------------------------------------- progress */

/** What each step's outcome is announced as. Colour is never the only carrier. */
const STATUS_LABELS: Readonly<Record<RunStep["status"], string>> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  ended: "Ended",
};

export interface RunProgressProps {
  readonly steps: readonly RunStep[];
  /** True while the stream is open, so the list is announced as it grows. */
  readonly streaming: boolean;
  /** True when a sequence number was missing: the list is not the whole run. */
  readonly gap?: boolean;
}

/**
 * The run as it happens: routing, each agent, each tool call.
 *
 * A live region while streaming, so somebody who cannot see the list still learns that the run is
 * progressing. Every row came from an event; a run that emitted nothing renders nothing rather
 * than a plausible-looking sequence.
 */
export function RunProgress({ steps, streaming, gap = false }: RunProgressProps): ReactNode {
  /*
   * Collapsed once the run finishes.
   *
   * `02-ai-weather-analyst.png` leads with the answer; the step-by-step execution belongs to
   * `05-agent-evidence.png`, which is a whole screen for it. Rendering the full timeline above every
   * finished answer made the Analyst read as a developer tool — the log was the tallest thing on the
   * page and the answer sat beneath it. While the run is streaming the steps are the only thing
   * there is to show, so it opens; when the answer arrives it closes to a summary line, and anyone
   * who wants the detail can open it or follow the evidence link.
   */
  return (
    <section className={styles.progress} aria-label="Run progress" data-progress="true">
      <details open={streaming}>
        <summary className={styles.progressHeader}>
          <h2 className={styles.progressTitle}>Run progress</h2>
          {streaming ? <Badge tone="accent">Running</Badge> : null}
          <span className={styles.progressCount}>
            {steps.length === 0 ? "no steps" : `${steps.length} steps`}
          </span>
        </summary>

      {steps.length === 0 ? (
        <p className={styles.note} role="status" aria-live="polite">
          {streaming
            ? "Waiting for Weathra to report its first step."
            : "The run reported no steps."}
        </p>
      ) : (
        <ol className={styles.steps} aria-live={streaming ? "polite" : undefined}>
          {steps.map((step) => (
            <li className={styles.step} key={step.id} data-step={step.kind} data-status={step.status}>
              <span className={styles.stepLabel}>
                {step.kind === "tool" ? (
                  <>
                    <span className={styles.stepKind}>Tool</span> {step.label}
                    {step.agent ? <span className={styles.stepAside}> · {agentLabel(step.agent)}</span> : null}
                  </>
                ) : (
                  step.label
                )}
              </span>
              <span className={styles.stepStatus}>{STATUS_LABELS[step.status]}</span>
              {step.detail ? <span className={styles.stepDetail}>{step.detail}</span> : null}
              {typeof step.durationMs === "number" ? (
                <span className={styles.stepAside}>{Math.round(step.durationMs)} ms</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}

        {gap ? (
          <p className={styles.note}>
            An event was missing from the stream, so this list is not the whole run.
          </p>
        ) : null}
      </details>
    </section>
  );
}

/* ----------------------------------------------------------------- the findings */

function attributionOf(attribution: EvidenceAttribution) {
  return {
    provider: attribution.provider,
    location: attribution.location?.display_name ?? null,
    retrievedAt: attribution.retrieved_at,
    period: attribution.period
      ? {
          start: attribution.period.start_local,
          end: attribution.period.end_local,
          timezone: attribution.period.timezone ?? null,
        }
      : null,
  };
}

/** One reported figure: what it is, what it reads, and how it was produced. */
function FindingRow({ finding }: { readonly finding: Finding }): ReactNode {
  const value = findingValue(finding);

  return (
    <li className={styles.finding}>
      <span className={styles.findingLabel}>{finding.label}</span>
      {value === null ? (
        // Never a zero and never a stand-in: the backend said why there is no value.
        <span className={styles.note}>
          Unavailable{finding.unavailable_reason ? `: ${finding.unavailable_reason}` : "."}
        </span>
      ) : (
        <span className={styles.findingValue}>{value}</span>
      )}
      {finding.method ? (
        <MethodNote
          method={finding.method}
          pointsUsed={finding.points_used}
          unit={finding.unit ?? null}
        />
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------- the answer */

export interface AnswerViewProps {
  readonly answer: AnswerEnvelope;
  /** The stored evidence record's identifier, when the backend stored one. */
  readonly evidenceId?: string | null;
}

/**
 * The completed answer: what was retrieved, what was computed, and what the model made of it.
 *
 * The three tiers are three regions — `data-tier` on each — so the separation between a provider's
 * figures, Weathra's arithmetic and a language model's sentences is structural rather than a
 * matter of layout.
 */
export function AnswerView({ answer, evidenceId = null }: AnswerViewProps): ReactNode {
  const groups = findingGroups(answer);
  const confidence = confidenceOf(answer.uncertainty);
  const resolved = answer.resolved;
  const grounding = answer.grounding;

  return (
    /*
      One agent response, as `02-ai-weather-analyst.png` composes it: an agent header, the
      interpretation, the retrieved and computed figures as compact side-by-side subcards, and the
      provenance beneath. It used to be a run of unrelated full-width panels, which read as a
      report rather than as a reply.
    */
    <article className={styles.answer}>
      <header className={styles.agentHead}>
        <span className={styles.agentMark} aria-hidden="true" />
        <span className={styles.agentName}>Weathra Intelligence Agent</span>
        <RunSummaryLine answer={answer} evidenceId={evidenceId} />
      </header>

      {/* Asked rather than assumed: a reference the run could not resolve. */}
      {answer.clarification_question ? (
        <div className={styles.clarification} role="note">
          <p className={styles.clarificationTitle}>Weathra needs to know</p>
          <p>{answer.clarification_question}</p>
        </div>
      ) : null}

      <InterpretationPanel
        provider={answer.llm_provider ?? null}
        model={answer.llm_model ?? null}
        footer={
          grounding.verified ? null : (
            <p className={styles.note}>
              {grounding.prose_discarded
                ? "The interpretation was withheld because it could not be grounded in the figures below."
                : "Some figures in this interpretation could not be matched to the evidence: " +
                  ((grounding.ungrounded_figures ?? []).join(", ") || grounding.note || "unstated") +
                  "."}
            </p>
          )
        }
      >
        {answer.answer_prose ? (
          <p>{answer.answer_prose}</p>
        ) : (
          <p>
            No interpretation was written for this answer. The retrieved and computed figures below
            are unaffected.
          </p>
        )}
      </InterpretationPanel>

      {/* The artifact's fixed pair, from the run's own attribution and resolved context. */}
      <RunFacts answer={answer} />

      {/*
        Anything else the run produced, by class. The pair above is the artifact's fixed geometry;
        this is whatever findings a particular run actually carried, and is often nothing.
      */}
      {groups.length > 0 ? (
        <div className={styles.subcards}>
          {groups.map((group) => (
            <ProvenanceSection
              key={group.key}
              dataClass={group.dataClass}
              title={GROUP_TITLES[group.dataClass]}
              attribution={attributionOf(group.attribution)}
              headingLevel={3}
            >
              <ul className={styles.findings}>
                {group.findings.map((finding, index) => (
                  <FindingRow key={`${finding.label}-${index}`} finding={finding} />
                ))}
              </ul>
            </ProvenanceSection>
          ))}
        </div>
      ) : null}

      {/* Required on every forecast figure: the band, and the basis it rests on. */}
      {confidence && answer.uncertainty?.basis ? (
        <UncertaintyIndicator
          confidence={confidence}
          basis={answer.uncertainty.basis}
          hoursAhead={horizonHoursOf(answer.uncertainty)}
          spreadAvailable={answer.uncertainty.spread_available ?? null}
        />
      ) : null}

      {(answer.unanswered_parts ?? []).length > 0 ? (
        <div className={styles.unanswered}>
          <p className={styles.noteStrong}>Not answered:</p>
          <ul className={styles.plainList}>
            {(answer.unanswered_parts ?? []).map((part) => (
              <li key={part}>{part}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* What the run decided the question was about, and where a default came from. */}
      {resolved ? (
        <section className={styles.resolved} aria-label="What this answer resolved to">
          <h2 className={styles.resolvedTitle}>What this answer resolved to</h2>
          {resolved.statement ? <p>{resolved.statement}</p> : null}
          <dl className={styles.resolvedList}>
            {(resolved.locations ?? []).length > 0 ? (
              <div className={styles.resolvedItem}>
                <dt>Location</dt>
                <dd>
                  {(resolved.locations ?? []).map((place) => place.display_name).join(", ")}
                  {resolved.location_source ? ` (from the ${resolved.location_source})` : null}
                </dd>
              </div>
            ) : null}
            {resolved.period ? (
              <div className={styles.resolvedItem}>
                <dt>Window</dt>
                <dd>
                  {formatLocalStamp(resolved.period.start_local)} to{" "}
                  {formatLocalStamp(resolved.period.end_local)}
                  {resolved.period.timezone ? ` (${resolved.period.timezone})` : null}
                </dd>
              </div>
            ) : null}
            {resolved.unit_system ? (
              <div className={styles.resolvedItem}>
                <dt>Units</dt>
                <dd>
                  {resolved.unit_system}
                  {resolved.units_source ? ` (from the ${resolved.units_source})` : null}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <EvidenceSummary answer={answer} evidenceId={evidenceId} />
    </article>
  );
}

/* ----------------------------------------------------------------- the evidence */

/**
 * The run record behind the answer, as far as the answer carries it.
 *
 * The agents that ran, the tools they called, the knowledge cited, and the identifiers that make
 * this run findable in the backend's logs. The full record — arguments, results, per-step timings —
 * is the Agent Evidence screen's job (task 21.5); what is here is what the answer envelope already
 * contains, and no more.
 */
function EvidenceSummary({
  answer,
  evidenceId,
}: {
  readonly answer: AnswerEnvelope;
  readonly evidenceId: string | null;
}): ReactNode {
  const evidence = answer.evidence;
  const agents = evidence.agents ?? [];
  const toolCalls = evidence.tool_calls ?? [];
  const citations = evidence.citations ?? [];

  return (
    <AttributionFooter
      attribution={{
        provider: answer.llm_provider ?? null,
        location: null,
        retrievedAt: evidence.completed_at,
      }}
    >
      <div className={styles.evidence} data-evidence="true">
        {evidence.routing_reason ? (
          <p className={styles.note}>Routing: {evidence.routing_reason}</p>
        ) : null}

        {agents.length > 0 ? (
          <p className={styles.note}>
            Agents: {agents.map((step) => `${agentLabel(step.agent)} (${step.status})`).join(", ")}
          </p>
        ) : null}

        {toolCalls.length > 0 ? (
          <p className={styles.note}>
            Tools: {toolCalls.map((call) => call.tool).join(", ")}
          </p>
        ) : null}

        {citations.length > 0 ? (
          <p className={styles.note}>
            Knowledge cited: {citations.map((citation) => citation.title).join("; ")}
          </p>
        ) : null}

        {evidence.partial ? (
          <p className={styles.noteStrong}>
            This answer is partial: {evidence.partial_reason ?? "a bound was reached."}
          </p>
        ) : null}

        <p className={styles.note}>
          Request {answer.request_id}
          {evidenceId ? ` · evidence ${evidenceId}` : null}
          {evidence.completed_at ? ` · completed ${formatInstant(evidence.completed_at)}` : null}
        </p>

        {/*
          The artifact's "View Full Agent Evidence" affordance, deferred in task 21.2 until the
          Agent Evidence screen and its route existed, and completed in task 21.5. The identifier is
          the backend's own `evidence_id` from the final stream event; when the record could not be
          stored the backend sends none, and no link is offered rather than one to an identifier
          this screen made up.
        */}
        {evidenceId ? (
          <Link className={styles.evidenceLink} href={evidencePath(evidenceId)}>
            View full agent evidence
          </Link>
        ) : (
          <p className={styles.note}>
            This run&rsquo;s evidence record could not be stored, so there is no full record to
            open. Everything the answer carries is above.
          </p>
        )}
      </div>
    </AttributionFooter>
  );
}

/* ------------------------------------------------------------------- empty state */

/** What the screen says before anything has been asked. */
export function AnalystIntroduction(): ReactNode {
  return (
    <EmptyState title="Ask Weathra a weather question">
      Weathra routes the question to its forecast, historical, analytics and knowledge agents, shows
      each step as it runs, and answers with the figures it retrieved or computed — each labelled
      with what it is and where it came from.
    </EmptyState>
  );
}

/**
 * One question, as the transcript shows it.
 *
 * Deliberately carries no data-class badge. The five classes describe *reported values*, and a
 * person's own question is not one — badging it would be the first step towards badging something
 * else wrongly.
 */
export function QuestionTurn({ question }: { readonly question: string }): ReactNode {
  return (
    /* The artifact's right-aligned question bubble, above the agent's reply. */
    <div className={styles.questionRow} data-turn="question">
      <div className={styles.question}>
        <p className={styles.questionRole}>You</p>
        <p className={styles.questionText}>{question}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------ observed data / forecast vector */

/** One row of a subcard: a term, and either its value or why there isn't one. */
function Fact({
  term,
  value,
}: {
  readonly term: string;
  readonly value: string | null;
}): ReactNode {
  return (
    <div className={styles.factRow}>
      <dt className={styles.factTerm}>{term}</dt>
      <dd className={styles.factValue} data-reported={value ? "true" : "false"}>
        {value ?? "Not reported"}
      </dd>
    </div>
  );
}

export interface RunFactsProps {
  readonly answer: AnswerEnvelope;
}

/**
 * The OBSERVED DATA / FORECAST VECTOR pair `02-ai-weather-analyst.png` puts under the synthesis.
 *
 * The artifact fills them with a pressure drop, a humidity reading, a precipitation window and a
 * 94% confidence. Weathra does not have those figures for every run — and inventing them is the one
 * thing this product must not do — so the pair is built from what the *envelope* actually carries:
 * the attribution entries the run recorded, the context it resolved to, and the backend's own
 * uncertainty statement.
 *
 * **Both cards render on every answer.** The geometry is the artifact's and does not depend on the
 * data; a field the run did not report says so. That is the whole distinction this screen is built
 * on — missing data changes the content, never the layout.
 *
 * Attribution is split by the data class the backend stamped on it, so an observed reading lands in
 * the observed card and a forecast in the forecast one. Nothing is re-classified here.
 */
export function RunFacts({ answer }: RunFactsProps): ReactNode {
  const attribution = answer.attribution ?? [];
  // `current` is the backend's own class for an observation; there is no separate "observed".
  const observed = attribution.find((entry) => entry.data_class === "current");
  const forecast = attribution.find((entry) => entry.data_class === "forecast");
  const resolved = answer.resolved ?? null;
  const uncertainty = answer.uncertainty ?? null;
  const horizon = uncertainty?.horizon?.[0] ?? null;

  return (
    <div className={styles.subcards}>
      <section className={styles.subcard} aria-label="Observed data">
        <header className={styles.subcardHead}>
          <DataClassBadge dataClass="observed" />
          <h3 className={styles.subcardTitle}>Observed data</h3>
        </header>
        <dl className={styles.facts}>
          <Fact term="Location" value={observed?.location.display_name ?? resolved?.locations?.[0]?.display_name ?? null} />
          <Fact term="Provider" value={observed?.provider ?? null} />
          <Fact term="Retrieved" value={observed?.retrieved_at ?? null} />
        </dl>
        {observed ? null : (
          <p className={styles.subcardNote}>This run retrieved no observation.</p>
        )}
      </section>

      <section className={styles.subcard} aria-label="Forecast vector">
        <header className={styles.subcardHead}>
          <DataClassBadge dataClass="forecast" />
          <h3 className={styles.subcardTitle}>Forecast vector</h3>
        </header>
        <dl className={styles.facts}>
          <Fact
            term="Window"
            value={
              resolved?.period
                ? `${formatLocalStamp(resolved.period.start_local)} to ${formatLocalStamp(resolved.period.end_local)}`
                : null
            }
          />
          <Fact term="Provider" value={forecast?.provider ?? null} />
          <Fact
            term="Confidence"
            value={
              horizon?.confidence
                ? `${horizon.confidence} at ${horizon.hours_ahead} h`
                : null
            }
          />
          <Fact
            term="Spread"
            value={
              uncertainty
                ? uncertainty.spread_available
                  ? "Supplied by the provider"
                  : "Not supplied"
                : null
            }
          />
        </dl>
      </section>
    </div>
  );
}


/* -------------------------------------------------------- the compact run status */

/**
 * The run, in one line.
 *
 * `02-ai-weather-analyst.png` shows a status chip beside the agent's name, not a step-by-step
 * timeline: the full trace is a whole screen of its own at `/evidence/{id}`, and reproducing it
 * above every answer made the Analyst read as a trace viewer. This states what ran and offers the
 * way to the detail; nothing is lost, and the answer leads.
 */
export function RunSummaryLine({
  answer,
  evidenceId,
}: {
  readonly answer: AnswerEnvelope;
  readonly evidenceId: string | null;
}): ReactNode {
  const record = answer.evidence;
  const agents = record?.agents?.length ?? 0;
  const tools = record?.tool_calls?.length ?? 0;

  return (
    <span className={styles.runSummary}>
      <span className={styles.runSummaryItem}>
        {agents > 0 ? `${agents} agents` : "No agent reported"}
      </span>
      <span className={styles.runSummaryItem}>
        {tools > 0 ? `${tools} tools` : "No tool call"}
      </span>
      {evidenceId ? (
        <Link className={styles.runSummaryLink} href={evidencePath(evidenceId)}>
          View agent evidence
        </Link>
      ) : (
        <span className={styles.runSummaryItem}>No evidence record</span>
      )}
    </span>
  );
}
