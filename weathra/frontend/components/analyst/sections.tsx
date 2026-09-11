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
  InterpretationPanel,
  Skeleton,
  MethodNote,
  ProvenanceSection,
  UncertaintyIndicator,
  formatInstant,
  formatLocalStamp,
} from "@/components/ui";
import type { AnswerEnvelope, EvidenceAttribution, Finding } from "@/lib/api/schema";
import type { DataClassName } from "@/lib/design/tokens";
import {
  agentLabel,
  confidenceOf,
  findingGroups,
  GROUP_TITLES,
  findingValue,
  horizonHoursOf,
  type RunStep,
} from "@/lib/analyst/run";
import { inferenceMetadataFrom } from "@/lib/inference/served";
import { evidencePath } from "@/lib/routes";
import { placeLabel } from "@/lib/locations/place";
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
   * A settled run with nothing to report renders nothing at all.
   *
   * "Run progress — no steps" above a failure notice, which the runtime audit of 2026-09-08
   * photographed, is a heading for an empty list: it tells a person whose question just failed that
   * there is a log, and that the log is empty. While the stream is open the placeholder is
   * meaningful — the run has started and has not reported yet — so it is kept for that case only.
   */
  if (steps.length === 0 && !streaming && !gap) return null;

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
    location: placeLabel(attribution.location),
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
  const inference = inferenceMetadataFrom(answer.evidence?.inference_attempts, {
    provider: answer.llm_provider,
    model: answer.llm_model,
  });

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
        /*
         * What actually served this answer — task 33.6.
         *
         * From the run's own inference attempts, which is the only account that is evidence:
         * `llm_provider` and `llm_model` are read off the configured client and are used only
         * where the run recorded no attempt, labelled as configured when they are. Nothing here
         * chooses a model, and nothing here fills in a policy the backend did not report.
         */
        provider={inference?.provider ?? null}
        model={inference?.model ?? null}
        requestedModel={inference?.requestedModel ?? null}
        policy={inference?.policyId ?? null}
        resolution={inference?.resolutionReason ?? null}
        served={inference?.served ?? true}
        prominence="lead"
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

      {/*
        What the run decided the question was about, and where a default came from.
        *
        Inside a disclosure, because the rail beside this column already states the resolved
        location, window and unit system in full: the runtime audit of 2026-09-08 photographed the
        same three lines twice on one screen, once here and once there. The rail is the copy a
        reader meets without asking; this is the copy that travels with the answer, kept so a
        transcript of several turns still says what each individual turn resolved to.
      */}
      {resolved ? (
        <details className={styles.resolved} aria-label="What this answer resolved to">
          <summary className={styles.resolvedTitle}>What this answer resolved to</summary>
          {resolved.statement ? <p>{resolved.statement}</p> : null}
          <dl className={styles.resolvedList}>
            {(resolved.locations ?? []).length > 0 ? (
              <div className={styles.resolvedItem}>
                <dt>Location</dt>
                <dd>
                  {(resolved.locations ?? []).map((place) => placeLabel(place)).join(", ")}
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
        </details>
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
    /*
      A run's record is not a weather reading, and is attributed as one — finding 2.11 of the
      runtime fidelity audit of 2026-09-08, closed by the `specs/web-ui` clarification of
      2026-09-09.

      This footer used to print "Location: not reported · Period: not reported" beneath every
      answer: two weather provenance fields that could never be anything else here, because this
      run had no place and covered no window. It says what produced the answer and when it
      finished, which is what applies to it. **Every weather figure inside the answer keeps all
      four fields** — each is its own `ProvenanceSection` with its own weather footer, which is
      where the requirement lives and where it is unchanged.
    */
    <AttributionFooter
      scope="model-run"
      attribution={{
        provider: answer.llm_provider ?? null,
        model: answer.llm_model ?? null,
        completedAt: evidence.completed_at,
      }}
    >
      <div className={styles.evidence} data-evidence="true">
        {/*
          Whether the answer is whole is not a detail, so it stays outside the disclosure. Everything
          else below it describes how the answer was produced rather than what it says.
        */}
        {evidence.partial ? (
          <p className={styles.noteStrong}>
            This answer is partial: {evidence.partial_reason ?? "a bound was reached."}
          </p>
        ) : null}

        {/*
          How the run happened, one disclosure deep.
          *
          The runtime audit of 2026-09-08 photographed six lines of this under every answer —
          routing, the agents and their statuses, the tools, the knowledge cited, and two
          identifiers — set in the same quiet grey and reading, together, as a console log with a
          weather answer above it. Not one of those lines is removed: every word is still on this
          screen, under a summary that says what it is, and the same facts are on
          `05-agent-evidence.png` in full. What changes is that a person who asked about the weather
          is no longer shown the orchestrator's paperwork before they can leave the page.
        */}
        <details className={styles.evidenceDetails}>
          <summary className={styles.evidenceSummary}>How this answer was produced</summary>

          {evidence.routing_reason ? (
            <p className={styles.note}>Routing: {evidence.routing_reason}</p>
          ) : null}

          {agents.length > 0 ? (
            <p className={styles.note}>
              Agents: {agents.map((step) => `${agentLabel(step.agent)} (${step.status})`).join(", ")}
            </p>
          ) : null}

          {toolCalls.length > 0 ? (
            <p className={styles.note}>Tools: {toolCalls.map((call) => call.tool).join(", ")}</p>
          ) : null}

          {citations.length > 0 ? (
            <p className={styles.note}>
              Knowledge cited: {citations.map((citation) => citation.title).join("; ")}
            </p>
          ) : null}

          <p className={styles.note}>
            Request {answer.request_id}
            {evidenceId ? ` · evidence ${evidenceId}` : null}
            {evidence.completed_at ? ` · completed ${formatInstant(evidence.completed_at)}` : null}
          </p>
        </details>

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

/**
 * What the screen shows before anything has been asked.
 *
 * It was an `EmptyState` — a heading over one four-line paragraph, which is what the production
 * fidelity review of 2026-09-10 photographed sitting alone in an otherwise empty workspace. The
 * replacement makes the same claim graphically: the four agents the supervisor can route to, as
 * labelled chips in their own data classes, over one line rather than four.
 *
 * The four are not a decorative list. They are `AgentName`'s own routable members, and the class
 * on each chip is the class of the figures that agent produces — which is the same colour the
 * answer's own panels will carry when one of them runs. Nothing here is a status: none of them has
 * run, and none of them claims to have.
 */
const ROUTABLE: readonly {
  readonly name: string;
  readonly dataClass: DataClassName;
  readonly reads: string;
}[] = [
  { name: "Forecast", dataClass: "forecast", reads: "The days ahead, with their uncertainty" },
  { name: "Historical", dataClass: "historical", reads: "The archive record and its baselines" },
  { name: "Analytics", dataClass: "analytics", reads: "Statistics computed from what was retrieved" },
  { name: "Knowledge", dataClass: "interpretation", reads: "Passages from the weather corpus" },
];

export function AnalystIntroduction(): ReactNode {
  return (
    <section className={styles.introduction} aria-labelledby="analyst-introduction">
      <h2 className={styles.introductionTitle} id="analyst-introduction">
        Ask Weathra a weather question
      </h2>
      <p className={styles.introductionLede}>
        The supervisor routes it to whichever of these it needs, shows each step as it runs, and
        answers with the figures they retrieved or computed.
      </p>

      <ul className={styles.introductionAgents}>
        {ROUTABLE.map((agent) => (
          <li className={styles.introductionAgent} key={agent.name} data-class={agent.dataClass}>
            <span className={styles.introductionAgentMark} aria-hidden="true" />
            <span className={styles.introductionAgentName}>{agent.name}</span>
            <span className={styles.introductionAgentReads}>{agent.reads}</span>
          </li>
        ))}
      </ul>

      <p className={styles.note}>
        Every figure in the answer carries what it is and where it came from, and the run is kept as
        an evidence record you can open.
      </p>
    </section>
  );
}

/**
 * The answer's shape while the run is still producing it.
 *
 * `RunProgress` reports the steps, which is the honest live signal — but on its own it left the
 * answer region blank for the whole of a run, and a blank region beside a progress list reads as a
 * screen that has stopped. This holds the geometry the answer will occupy, hidden from assistive
 * technology because `RunProgress` is the live region and two announcements of the same event is
 * one too many.
 *
 * It claims nothing. No badge, no attribution line, no placeholder figure — only the block shapes
 * of prose, which is the one thing every answer has.
 */
export function AnswerSkeleton(): ReactNode {
  return (
    <div className={styles.answerSkeleton} aria-hidden="true" data-answer-skeleton="true">
      <Skeleton width="34%" height="var(--space-5)" />
      <Skeleton width="100%" />
      <Skeleton width="92%" />
      <Skeleton width="74%" />
    </div>
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
 * **A card with nothing in it says so once.** The runtime audit of 2026-09-08 photographed the
 * observed card as three rows of "Not reported" followed by a sentence explaining that the run
 * retrieved no observation. The sentence is the honest form; the three empty rows underneath a
 * heading are a table of nulls, and repeating "not reported" per field says nothing the one
 * sentence has not. So the rows appear when at least one of them has a value — where the contrast
 * between a reported field and an unreported one is the information — and give way to the sentence
 * when none does.
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

  const observedFacts: readonly (readonly [string, string | null])[] = [
    [
      "Location",
      placeLabel(observed?.location) ?? placeLabel(resolved?.locations?.[0]),
    ],
    ["Provider", observed?.provider ?? null],
    ["Retrieved", observed?.retrieved_at ?? null],
  ];

  const forecastFacts: readonly (readonly [string, string | null])[] = [
    [
      "Window",
      resolved?.period
        ? `${formatLocalStamp(resolved.period.start_local)} to ${formatLocalStamp(resolved.period.end_local)}`
        : null,
    ],
    ["Provider", forecast?.provider ?? null],
    ["Confidence", horizon?.confidence ? `${horizon.confidence} at ${horizon.hours_ahead} h` : null],
    [
      "Spread",
      uncertainty ? (uncertainty.spread_available ? "Supplied by the provider" : "Not supplied") : null,
    ],
  ];

  const anyReported = (facts: readonly (readonly [string, string | null])[]) =>
    facts.some(([, value]) => value !== null);

  return (
    <div className={styles.subcards}>
      <section className={styles.subcard} aria-label="Observed data">
        <header className={styles.subcardHead}>
          <DataClassBadge dataClass="observed" />
          <h3 className={styles.subcardTitle}>Observed data</h3>
        </header>
        {anyReported(observedFacts) ? (
          <dl className={styles.facts}>
            {observedFacts.map(([term, value]) => (
              <Fact key={term} term={term} value={value} />
            ))}
          </dl>
        ) : null}
        {observed ? null : (
          <p className={styles.subcardNote}>This run retrieved no observation.</p>
        )}
      </section>

      <section className={styles.subcard} aria-label="Forecast vector">
        <header className={styles.subcardHead}>
          <DataClassBadge dataClass="forecast" />
          <h3 className={styles.subcardTitle}>Forecast vector</h3>
        </header>
        {anyReported(forecastFacts) ? (
          <dl className={styles.facts}>
            {forecastFacts.map(([term, value]) => (
              <Fact key={term} term={term} value={value} />
            ))}
          </dl>
        ) : (
          <p className={styles.subcardNote}>This run retrieved no forecast.</p>
        )}
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
