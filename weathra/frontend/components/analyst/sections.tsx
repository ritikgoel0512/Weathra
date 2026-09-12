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
  InterpretationPanel,
  Skeleton,
  MethodNote,
  ModelAttribution,
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
  type FindingGroup,
  findingGroups,
  groundingLine,
  GROUP_TITLES,
  headlineFindings,
  findingValue,
  horizonHoursOf,
  type RunStep,
} from "@/lib/analyst/run";
import { inferenceMetadataFrom } from "@/lib/inference/served";
import { evidencePath } from "@/lib/routes";
import { placeLabel } from "@/lib/locations/place";
import { runIntentOf } from "@/lib/analyst/intent";

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
  /**
   * Rendered inside a clarification that is waiting for a place — the saved places to press and
   * the resolver to type into. Supplied by the screen rather than built here, because the same
   * control is the composer's FOCUS and there must be exactly one of it.
   */
  readonly locationOptions?: ReactNode;
}

/**
 * The completed answer: what was retrieved, what was computed, and what the model made of it.
 *
 * The three tiers are three regions — `data-tier` on each — so the separation between a provider's
 * figures, Weathra's arithmetic and a language model's sentences is structural rather than a
 * matter of layout.
 */
export function AnswerView({
  answer,
  evidenceId = null,
  locationOptions = null,
}: AnswerViewProps): ReactNode {
  const groups = findingGroups(answer);
  const confidence = confidenceOf(answer.uncertainty);
  const resolved = answer.resolved;
  const grounding = answer.grounding;
  const inference = inferenceMetadataFrom(answer.evidence?.inference_attempts, {
    provider: answer.llm_provider,
    model: answer.llm_model,
  });

  /*
   * **The two figure panels, from the run's own findings.**
   *
   * `02-ai-weather-analyst.png` puts an OBSERVED DATA panel and a FORECAST panel under the
   * synthesis, each holding a handful of *readings*. Ours held the run's metadata instead —
   * Location, Provider, Retrieved on one side, Window, Provider, Confidence, Spread on the other —
   * which is provenance wearing the costume of weather, and on a run that retrieved neither it was
   * two bordered boxes saying so. The customer-level review of 2026-09-11 named both.
   *
   * So the panels are the findings the run actually produced, split by the class the backend
   * stamped on each, and a class with no findings renders **no panel at all** rather than an empty
   * one. The provenance those panels used to carry has not gone anywhere: it is the compact rule
   * under the answer and the rail beside it.
   */
  const observedGroups = groups.filter((group) => group.dataClass === "observed");
  const forecastGroups = groups.filter((group) => group.dataClass === "forecast");
  const computedGroups = groups.filter(
    (group) => group.dataClass !== "observed" && group.dataClass !== "forecast",
  );

  /*
   * **A question the run could not answer is a conversation, not a report.**
   *
   * When the agent asks which place it should look at, there is no observation, no forecast, no
   * computed figure and no interpretation to show — and production rendered the whole apparatus
   * anyway: an empty observed card, an empty forecast card, a grounding note reading "0 figure(s)
   * checked", the model and policy identifiers, and a run-progress strip. The clarification is the
   * answer in that case, so it is the only thing shown.
   *
   * The test for it lives in `lib/analyst/intent.ts` now, and not for tidiness: this condition also
   * decides what the rail says and what the composer does with the next thing typed, and the three
   * had drifted apart. The previous version of it lived here and required `!answer.answer_prose`,
   * so a run that asked which place *and* wrote a sentence fell through to the report layout — an
   * interpretation card with nothing in it over two empty panels, which is the state the
   * 2026-09-12 review rejected.
   */
  const intent = runIntentOf(answer);
  const clarifying = intent.kind !== "answered";

  return (
    /*
      One agent reply, as `02-ai-weather-analyst.png` composes it: the identity line, then a card
      that leads with the synthesis, sets the figures beneath it in compact panels, highlights the
      reading Weathra computed, and closes on one rule of provenance.
    */
    <article className={styles.answer}>
      <header className={styles.agentHead}>
        <span className={styles.agentMark} aria-hidden="true" />
        <span className={styles.agentName}>Weathra Intelligence Agent</span>
      </header>

      {clarifying ? (
        /*
          **The clarification, answered here.**

          It used to end in two links off the screen — *Your saved places* and *Set a default
          location* — which asked somebody who wanted a forecast to go and configure a durable
          preference on a different screen and then come back and retype their question. The
          2026-09-12 review named that as the defect. The places are now offered *in* the
          clarification, and pressing one runs the question that was already asked.
        */
        <div className={styles.clarification} role="note">
          <p className={styles.clarificationTitle}>{intent.question}</p>
          {intent.kind === "needs-location" ? (
            <>
              <p className={styles.note}>
                Weathra does not guess a place, and does not read one from your device or your
                account. Choose one and the question you just asked runs for it.
              </p>
              {locationOptions}
              <p className={styles.clarificationFootnote}>
                Choosing here points this conversation at that place. It does not change your saved
                default — <Link href="/settings">Settings</Link> does that, and{" "}
                <Link href="/locations">Saved Locations</Link> keeps the list.
              </p>
            </>
          ) : (
            <p className={styles.note}>
              Answer in the box below and Weathra will carry on from here.
            </p>
          )}
        </div>
      ) : (
        <div className={styles.answerCard}>
          {/*
            The card's own head: the badge that marks model-written language, and one short line
            saying what it rests on. The boundary sentence and the model identifiers used to open
            the reply; both are still on this screen — the sentence inside the panel below, the
            identifiers in the answer's details — and neither is the first thing a customer meets.
          */}
          {/*
            **Only where a model actually wrote something.**

            This region used to render unconditionally, so a run whose prose was withheld — or never
            written — showed the AI INTERPRETATION badge over the sentence "No interpretation was
            written for this answer." A labelled card whose content is a note saying the card is
            empty is worse than no card: it gives the most prominent treatment on the screen to the
            absence of the thing it is for. The figures are unaffected either way, and where the
            interpretation was *withheld* rather than absent the grounding footer below still says
            so, because that is a fact about the answer rather than about a card.
          */}
          {answer.answer_prose ? (
          <InterpretationPanel
            /*
              The region keeps the name it has always had: it *is* the AI interpretation, and that
              is what a screen reader should hear when it lands here. `titleVisible` only stops it
              being painted a second time — the card's own badge already says what this is, and the
              artifact's reply opens on the answer rather than on a heading.
            */
            title="AI interpretation"
            titleVisible={false}
            density="compact"
            prominence="lead"
            placement="detail"
            /*
              The artifact's short grounding line beside the badge. Its own reads "Grounding
              analysis via Weathra MCP…", which names an implementation; this names the subject —
              the place and the window the figures below apply to, as the run resolved them. Absent
              on a run that resolved neither, rather than shown empty.
            */
            eyebrow={groundingLine(resolved) ?? undefined}
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
            <p>{answer.answer_prose}</p>
          </InterpretationPanel>
          ) : grounding.prose_discarded ? (
            <p className={styles.withheld} role="note">
              The interpretation was withheld because it could not be grounded in the figures below.
              They are what the run retrieved and computed, and they are unaffected.
            </p>
          ) : null}

          {/* Asked rather than assumed, where the run also produced figures. */}
          {answer.clarification_question && !clarifying ? (
            <p className={styles.clarificationInline}>{answer.clarification_question}</p>
          ) : null}

          {/*
            **The artifact's pair — each present only where the run has something to put in it.**

            They are `ProvenanceSection`s rather than hand-built cards, and that is not a detail:
            `specs/web-ui` requires the separation between a provider's figures, Weathra's
            arithmetic and a model's sentences to be *structural*, and that component is what puts
            `data-tier` on the element and the data-class badge in the header. The recomposition
            changes which figures are in them and whether an empty one is drawn at all; it does not
            get to change what makes them checkable.
          */}
          {observedGroups.length > 0 || forecastGroups.length > 0 ? (
            <div className={styles.subcards}>
              {observedGroups.length > 0 ? (
                <FigurePanel title="Observed data" groups={observedGroups} />
              ) : null}
              {forecastGroups.length > 0 ? (
                <FigurePanel title="Forecast" groups={forecastGroups} />
              ) : null}
            </div>
          ) : null}

          {/*
            **The artifact's highlighted interpretation box, filled with what Weathra computed.**
            Its own reads "Convergence zones have shifted 4km Eastward from standard ECMWF models",
            which is an atmosphere this product does not model. What earns the same emphasis here is
            the arithmetic: the statistics the answer actually turns on, each with the method that
            produced it. Absent entirely on a run that computed nothing.
          */}
          {computedGroups.map((group) => (
            <ProvenanceSection
              key={group.key}
              dataClass={group.dataClass}
              title={GROUP_TITLES[group.dataClass]}
              attribution={attributionOf(group.attribution)}
              headingLevel={3}
            >
              {/*
                Ranked, so the statistic the answer turns on leads the panel rather than whichever
                one the analytics tool happened to report first. Nothing is dropped: a computed
                group is short by construction, and every figure it holds is here.
              */}
              <ul className={styles.findings}>
                {headlineFindings(group.findings).map((finding, index) => (
                  <FindingRow key={`${finding.label}-${index}`} finding={finding} />
                ))}
              </ul>
            </ProvenanceSection>
          ))}

          {/* Required on every forecast figure, at the compact step the Dashboard settled. */}
          {confidence && answer.uncertainty?.basis ? (
            <UncertaintyIndicator
              confidence={confidence}
              basis={answer.uncertainty.basis}
              hoursAhead={horizonHoursOf(answer.uncertainty)}
              spreadAvailable={answer.uncertainty.spread_available ?? null}
              compact
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
            **One rule, and everything technical behind it.**

            The reply used to close on five surfaces: what it resolved to, "Produced by … Completed
            …", "How this answer was produced", the evidence summary and a run-progress list. They
            are all still here and none is summarised away — they are the disclosure on this rule,
            which is the same economy the frozen Dashboard and Compare Cities use for provenance.
          */}
          <div className={styles.answerRule}>
            <AnswerProvenance answer={answer} />
            <details className={styles.answerDetails} aria-label="Answer details">
              <summary className={styles.answerDetailsSummary}>Answer details</summary>

              {/* What served it. Moved off the face of the reply by task 34.32, not dropped. */}
              <ModelAttribution
                provider={inference?.provider ?? null}
                model={inference?.model ?? null}
                requestedModel={inference?.requestedModel ?? null}
                policy={inference?.policyId ?? null}
                resolution={inference?.resolutionReason ?? null}
                served={inference?.served ?? true}
              />

              {resolved ? (
                <>
                  {resolved.statement ? <p className={styles.note}>{resolved.statement}</p> : null}
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
                </>
              ) : null}

              <EvidenceSummary answer={answer} evidenceId={evidenceId} />
            </details>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * One class of figures the run produced, as the artifact's inset panel.
 *
 * The label, the value, and the group's own attribution on the compact rule the frozen screens
 * settled — a method note per row turned this region into the log the customer-level review of
 * 2026-09-11 objected to, and the methods are still one press away on that rule.
 */
/**
 * How many figures a panel leads with before the rest go behind a press.
 *
 * Four, because a real forecast retrieval produces around fifteen findings and the customer-level
 * review of 2026-09-12 asked for "2–4 real high-value values" with strong figure hierarchy. Nothing
 * is hidden: the remainder are in the same panel, under a summary that counts them, and every one
 * carries the same attribution as the four above it.
 */
const HEADLINE_FIGURES = 4;

function FigurePanel({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly FindingGroup[];
}): ReactNode {
  const first = groups[0];
  if (first === undefined) return null;

  /*
   * One ordered list across the panel's groups, not one list per group.
   *
   * A panel holds one data class; it holds more than one group only when the same class arrived
   * from two sources, and a reader looking for the temperature does not care which of the two
   * carried it. `headlineFindings` ranks by what the measure is — see its note — and the
   * attribution each figure rests on is the panel's own footer.
   */
  const ordered = headlineFindings(groups.flatMap((group) => [...group.findings]));
  const lead = ordered.slice(0, HEADLINE_FIGURES);
  const rest = ordered.slice(HEADLINE_FIGURES);

  return (
    <ProvenanceSection
      dataClass={first.dataClass}
      title={title}
      attribution={attributionOf(first.attribution)}
      headingLevel={3}
    >
      <FigureList findings={lead} />
      {rest.length > 0 ? (
        <details className={styles.moreFigures}>
          <summary className={styles.moreFiguresSummary}>
            {rest.length} more {rest.length === 1 ? "figure" : "figures"}
          </summary>
          <FigureList findings={rest} />
        </details>
      ) : null}
    </ProvenanceSection>
  );
}

/**
 * A run's figures as figures: the label small above, the value large beneath it.
 *
 * The panels were a label-left/value-right list at meta size, which reads as a settings table. The
 * artifact sets its OBSERVED DATA and FORECAST VECTOR blocks the other way round — a quiet label
 * over a prominent number — and that is the hierarchy somebody scanning an answer actually uses.
 * An unreported finding keeps its row and says so in body type, because the gap is a fact about
 * the run and setting it in the figure face would make an absence look like a reading.
 */
function FigureList({ findings }: { readonly findings: readonly Finding[] }): ReactNode {
  return (
    <dl className={styles.facts}>
      {findings.map((finding, index) => {
        const value = findingValue(finding);
        return (
          <div className={styles.factRow} key={`${finding.label}-${index}`}>
            <dt className={styles.factTerm}>{finding.label}</dt>
            <dd className={styles.factValue} data-reported={value ? "true" : "false"}>
              {value ?? "Not reported"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The reply's one provenance rule.
 *
 * The provider the figures came from, the window they cover, and how many agents and tools the run
 * used — the four facts a reader checks, on one line, at the label step the frozen screens settled.
 * Everything else the run recorded is the disclosure beside it.
 */
function AnswerProvenance({ answer }: { readonly answer: AnswerEnvelope }): ReactNode {
  const providers = [
    ...new Set((answer.attribution ?? []).map((entry) => entry.provider).filter(Boolean)),
  ];
  const period = answer.resolved?.period ?? null;
  const record = answer.evidence;
  const agents = record?.agents?.length ?? 0;
  const tools = record?.tool_calls?.length ?? 0;

  return (
    <p className={styles.answerSources}>
      {providers.length > 0 ? (
        <span className={styles.answerSource}>{providers.join(" · ")}</span>
      ) : null}
      {period ? (
        <span className={styles.answerSource}>
          {formatLocalStamp(period.start_local)} to {formatLocalStamp(period.end_local)}
        </span>
      ) : null}
      {agents > 0 || tools > 0 ? (
        <span className={styles.answerSource}>
          {agents} {agents === 1 ? "agent" : "agents"} · {tools} {tools === 1 ? "tool" : "tools"}
        </span>
      ) : null}
    </p>
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
