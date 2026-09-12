"use client";

/**
 * The Analyst's right rail — the column `02-ai-weather-analyst.png` runs beside the conversation.
 *
 * The artifact stacks four panels there: Agent Status, Active Data Sources, Analyst Context, and a
 * synthesis-confidence figure over a "View Full Agent Evidence" action. All of them are reproduced,
 * in that order, and every value in them comes from the run the person is looking at.
 *
 * **What the artifact shows there that is not reproduced, and why.** Its Agent Status panel reports
 * "Neural Agent v4.8" and a 14.2% compute load; its Active Data Sources panel shows generated
 * imagery over three named third-party feeds; its Analyst Context panel lists invented business
 * preferences; and it prints "Synthesis Confidence 98.2%". `docs/design/screens.md` §5 refuses all
 * of it — an agent version, a compute figure, invented providers and an invented confidence are
 * exactly the fabrications that make a grounded product untrustworthy. The panels stay; what fills
 * them is the run's own record.
 *
 * So: Agent Status is the run's real status and the agents the record names, each with the outcome
 * the backend stamped on it. Active Data Sources are the providers this answer cites, named the way
 * their own documentation names them, each with what it supplied — plus Weathra's own analytics and
 * knowledge corpus where the run actually used them. Analyst Context is `ResolvedContext`: the
 * location, period and unit system the run settled on and where each came from. Saved preferences
 * is `PreferenceView`, and it lists **only** the fields that report `chosen` — a value Weathra
 * assumed is not something the person saved, and a memory panel listing assumptions would be the
 * artifact's fiction with better manners. And the confidence slot carries the backend's
 * `UncertaintyStatement`, the grounding report, and the one proportion on this screen that is
 * arithmetic rather than invention: how much of what the run reported carries a figure.
 *
 * **Before the first question the rail is one line, not four panels.** The artifact never draws
 * that state, and the first attempt at it gave each of the panels a paragraph explaining what it
 * would eventually contain. The runtime audit of 2026-09-08 photographed the result: beside an
 * empty conversation, and beside a failed one, the tallest thing on the screen was four paragraphs
 * of the interface describing itself. A person who has not asked anything does not need the rail
 * explained; they need the question box. So the rail says once that it fills in after a run, and
 * the panels — in the artifact's order, with the artifact's geometry — appear as soon as there is a
 * run to describe.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  IntelligenceMark,
  Meter,
  formatLocalStamp,
} from "@/components/ui";
import type { AnswerEnvelope, PreferenceView } from "@/lib/api/schema";
import { needsLocation } from "@/lib/analyst/intent";
import {
  AGENT_OUTCOME_LABELS,
  dataCoverageOf,
  LOCATION_SOURCE_PHRASES,
  providerLabel,
  runAgentsFrom,
} from "@/lib/analyst/run";
import { dataClassFor } from "@/lib/design/data-class";
import type { DataClassName } from "@/lib/design/tokens";
import { friendlyName, placeLabel } from "@/lib/locations/place";
import type { AgentStreamState } from "@/hooks/use-agent-stream";

import styles from "./analyst.module.css";

/**
 * What the rail says the agent is doing, from the stream's own status.
 *
 * "Complete" is reserved for a run that completed an *analysis*. The 2026-09-12 review photographed
 * this badge reading COMPLETE beside a reply that had asked which place to look at and retrieved
 * nothing at all — a green tick over a run that never started. A run waiting for context is not a
 * finished one, and saying so was the panel's own small fabrication.
 *
 * The sentence beside the badge says the same thing in words, because a status word in a coloured
 * pill is the artifact's whole Agent Status panel and a person reading it should not have to learn
 * what green means here.
 */
function statusOf(
  live: AgentStreamState | null,
  answered: boolean,
  waiting: boolean,
): {
  label: string;
  state: string;
  tone: "ok" | "accent" | "neutral" | "warning";
} {
  if (live?.status === "streaming") {
    return { label: "Running", state: "Retrieving and analysing.", tone: "accent" };
  }
  // A run that ended in anything but an answer. The terminal says which, and none of them is
  // "complete" — reporting one as complete would be the panel's own small fabrication.
  const terminal = live?.terminal?.kind;
  if (terminal !== undefined && terminal !== "final") {
    return { label: "Did not finish", state: "The last run did not complete.", tone: "neutral" };
  }
  if (waiting) {
    return {
      label: "Needs location",
      state: "No place to work from yet.",
      tone: "warning",
    };
  }
  if (answered) return { label: "Complete", state: "The analysis finished.", tone: "ok" };
  return { label: "Idle", state: "Nothing has run yet.", tone: "neutral" };
}

/**
 * The four regions the artifact stacks in this column, and what each is filled from.
 *
 * The order is the artifact's — status, sources, context, confidence — so the empty rail and the
 * populated one are the same column rather than two different ones. Each note names a *record*,
 * never a capability: "the providers the answer cites" is a fact about where the panel's content
 * comes from, and makes no claim that any provider has been read.
 */
const RAIL_REGIONS: readonly { readonly name: string; readonly fills: string }[] = [
  { name: "Active data sources", fills: "The providers the answer cites" },
  { name: "Analyst context", fills: "The place, window and units it resolved to" },
  { name: "Confidence and grounding", fills: "The backend's uncertainty statement" },
  { name: "Evidence record", fills: "The stored trace of the run" },
];

export interface AnalystRailProps {
  /** The run the rail describes: the one in flight, or the last one that finished. */
  readonly live: AgentStreamState | null;
  /** The most recent completed answer, when there is one. */
  readonly answer: AnswerEnvelope | null;
  /** The evidence record the last answer produced, when the backend stored one. */
  readonly evidenceId: string | null;
  /** Whether the backend reported conversation memory as available for this run. */
  readonly memory: { readonly available: boolean; readonly note: string | null } | null;
  /** The durable preferences this account has stored, as the preferences endpoint reports them. */
  readonly preferences?: PreferenceView | null;
  /** Whether a conversation is open on the backend, so earlier turns are available to the run. */
  readonly threadOpen?: boolean;
}

/**
 * The data class a provider supplied, said the way a person says it.
 *
 * The rail listed two identical `stub-provider` rows with an ISO instant under each, because the
 * run cited the same provider for its observation and its forecast. Naming what each supplied is
 * the distinction that makes two rows worth having; the instant is provenance and belongs to the
 * answer's own rule.
 */
const SOURCE_ROLES: Readonly<Record<string, string>> = {
  /*
   * "Current conditions", not "Observed conditions": the provider's current block is its analysis
   * for right now rather than a reading taken at the place, and the row names the role a source
   * played rather than upgrading what it supplied. Two rows for one provider are right here —
   * `specs/safety-grounding` wants the present and the days ahead credited separately — and they
   * are two rows only because the roles genuinely differ.
   */
  current: "Current conditions",
  forecast: "Forecast data",
  historical_observation: "Archive observations",
};

/** One row of the Active data sources panel. */
interface SourceRow {
  readonly key: string;
  readonly name: string;
  readonly role: string;
  /** The class whose colour marks the row. Never decoration: it says what kind of figure it fed. */
  readonly dataClass: DataClassName;
}

/**
 * The sources this answer actually drew on.
 *
 * Three kinds, and each one is a record rather than a capability:
 *
 * * the **providers** in the answer's attribution, one row per provider *and role* — a run citing
 *   one provider for four things listed it four times with four timestamps, which is a log rather
 *   than a source list;
 * * **Weathra's own analytics**, where the run produced a computed statistic. Its figures are
 *   attributed to the weather provider whose series they were computed over, so without this row
 *   the deterministic layer — the one thing on this screen Weathra itself produced — is the only
 *   contributor the panel never names;
 * * the **knowledge corpus**, where the run cited a passage from it.
 *
 * What is deliberately not here: a row for a provider that served no part of this answer, and a row
 * for the conversation. Thread context is context, not a source of figures, and it is reported as
 * context in the panel below — see the note there on the distinction.
 */
function sourcesFrom(answer: AnswerEnvelope | null): readonly SourceRow[] {
  if (answer === null) return [];

  const rows = new Map<string, SourceRow>();

  for (const entry of answer.attribution ?? []) {
    const role = SOURCE_ROLES[entry.data_class ?? ""];
    const dataClass = dataClassFor(entry.data_class);
    // A class with no customer-facing role is one this build does not recognise, and a source row
    // reading "computed_statistic" under a provider's name is the raw field it was meant to replace.
    if (role === undefined || dataClass === null) continue;
    const key = `${entry.provider}|${entry.data_class}`;
    if (!rows.has(key)) {
      rows.set(key, { key, name: providerLabel(entry.provider), role, dataClass });
    }
  }

  const sources = [...rows.values()];

  if ((answer.findings ?? []).some((finding) => finding.data_class === "computed_statistic")) {
    sources.push({
      key: "weathra-analytics",
      name: "Weathra Analytics",
      role: "Deterministic calculations",
      dataClass: "analytics",
    });
  }

  if ((answer.evidence?.citations ?? []).length > 0) {
    sources.push({
      key: "weathra-knowledge",
      name: "Weather Knowledge",
      role: "Retrieved terminology and context",
      dataClass: "interpretation",
    });
  }

  return sources;
}

/**
 * The durable preferences this account has actually saved.
 *
 * `PreferenceView.sources` reports, per field, whether the person **chose** the value or Weathra
 * assumed it — and that distinction is the whole of this panel. The artifact's Analyst Context card
 * lists remembered business preferences it invented; the honest version of that card lists what is
 * genuinely in the store and says plainly when nothing is. A default horizon of seven days rendered
 * as "remembered" would be the same fiction with a real number in it.
 */
function savedPreferencesFrom(
  preferences: PreferenceView | null | undefined,
): readonly { readonly term: string; readonly value: string }[] {
  if (!preferences) return [];
  const chosen = (field: string): boolean => preferences.sources?.[field] === "chosen";
  const rows: { term: string; value: string }[] = [];

  if (chosen("default_location") && preferences.default_location) {
    rows.push({ term: "Default location", value: friendlyName(preferences.default_location) });
  }
  if (chosen("unit_system")) {
    rows.push({ term: "Temperature units", value: preferences.unit_system });
  }
  if (chosen("forecast_horizon_days")) {
    rows.push({
      term: "Forecast horizon",
      value: `${preferences.forecast_horizon_days} ${preferences.forecast_horizon_days === 1 ? "day" : "days"}`,
    });
  }
  return rows;
}

export function AnalystRail({
  live,
  answer,
  evidenceId,
  memory,
  preferences = null,
  threadOpen = false,
}: AnalystRailProps): ReactNode {
  /*
   * A run that came back asking for a place is the rail's own special case, and every panel below
   * reads it. `needsLocation` is the same function the answer body and the composer use, so the
   * three cannot describe one run three ways again.
   */
  const waiting = needsLocation(answer);
  const status = statusOf(live, answer !== null && !waiting, waiting);
  const agents = runAgentsFrom(live?.events ?? [], waiting ? null : answer);
  const resolved = answer?.resolved ?? null;
  const uncertainty = answer?.uncertainty ?? null;
  const grounding = answer?.grounding ?? null;
  const sources = sourcesFrom(waiting ? null : answer);
  const saved = savedPreferencesFrom(preferences);
  const coverage = dataCoverageOf(waiting ? null : answer);

  const described = live !== null || answer !== null;

  if (!described) {
    /*
     * Before the first question: the status, and the regions named — not explained. See the note at
     * the top of this file for the two states this sits between.
     */
    return (
      <aside className={styles.rail} aria-label="Run detail">
        <Card aria-labelledby="analyst-rail-waiting">
          <CardHeader
            headingLevel={2}
            title="Analyst status"
            titleId="analyst-rail-waiting"
            badge={<Badge tone="neutral">Ready</Badge>}
          />
          <CardBody>
            <p className={styles.note}>
              Ask a question and this fills from the run itself, in this order.
            </p>
            <ol className={styles.railPlan}>
              {RAIL_REGIONS.map((region) => (
                <li className={styles.railPlanRow} key={region.name}>
                  <span className={styles.railPlanName}>{region.name}</span>
                  <span className={styles.railPlanNote}>{region.fills}</span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </aside>
    );
  }

  return (
    <aside className={styles.rail} aria-label="Run detail">
      {/*
        **Analyst status.** The artifact's panel reports "Neural Agent v4.8", "Process: Active
        Inference" and a 14.2% compute load, over a generated portrait of a neural net. Weathra runs
        no neural agent of its own, names no process and measures no compute; what it has is its own
        intelligence mark, the run's real state, and the agents the record names with the outcome
        each one was stamped with.
      */}
      <Card aria-labelledby="analyst-status">
        <CardHeader headingLevel={2}
          title="Agent status"
          titleId="analyst-status"
          badge={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody>
          <div className={styles.railIdentity}>
            <span className={styles.railIdentityMark} aria-hidden="true">
              <IntelligenceMark size={26} />
            </span>
            <span className={styles.railIdentityText}>
              <span className={styles.railIdentityName}>Weathra Analyst</span>
              <span className={styles.railIdentityState}>{status.state}</span>
            </span>
          </div>

          {/*
            **What the agents did, or why they did not run.**

            "This run named no agents." was the debug line the 2026-09-12 review objected to: an
            implementation fact, in implementation words, offered to a customer as the explanation
            for an empty screen. Orchestration not running is not a property of agents — it is a
            property of the context the run was given, and that is what this now says.

            Where the record exists, each row carries the backend's own `StepStatus` for that node,
            so "Forecast agent · Used" and "Historical agent · Skipped" are read rather than
            assumed. An agent the plan never routed to appears in neither the record nor the stream,
            and is therefore absent: the run has no evidence it declined one, and inventing a "not
            needed" row would be a claim about a decision nobody recorded.
          */}
          {agents.length > 0 ? (
            <ul className={styles.railAgents}>
              {agents.map((agent) => (
                <li className={styles.railAgent} key={agent.name} data-status={agent.status ?? "running"}>
                  <span className={styles.railAgentMark} aria-hidden="true" />
                  <span className={styles.railAgentName}>{agent.label}</span>
                  {agent.status ? (
                    <span className={styles.railAgentOutcome}>
                      {AGENT_OUTCOME_LABELS[agent.status] ?? agent.status}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : waiting ? (
            <p className={styles.note}>
              Waiting for a place. Nothing has been retrieved and nothing has been analysed.
            </p>
          ) : (
            <p className={styles.note}>No analysis has run yet.</p>
          )}
        </CardBody>
      </Card>

      {/*
        **Active data sources.** The artifact shows GLOBAL_SAT, L_RADAR, an ECMWF reanalysis and a
        Berlin-Mitte ground station over a generated visualisation. Weathra reads none of those, and
        `screens.md` §5 refuses all four. These are the sources this answer actually drew on, each
        marked in the colour of the class it fed — which is a real signal rather than an icon
        standing in for a feed nobody has.
      */}
      <Card aria-labelledby="analyst-sources">
        <CardHeader headingLevel={2} title="Active data sources" titleId="analyst-sources" />
        <CardBody>
          {sources.length > 0 ? (
            <ul className={styles.railSources}>
              {sources.map((source) => (
                <li className={styles.railSource} key={source.key}>
                  <span
                    className={styles.railSourceMark}
                    data-class={source.dataClass}
                    aria-hidden="true"
                  />
                  <span className={styles.railSourceText}>
                    <span className={styles.railSourceName}>{source.name}</span>
                    <span className={styles.railSourceRole}>{source.role}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : waiting ? (
            <p className={styles.note}>Not queried yet.</p>
          ) : (
            <p className={styles.note}>This run retrieved from no provider.</p>
          )}
        </CardBody>
      </Card>

      {/*
        **Analyst context.** The artifact's version is an invented business preference — "B2B City
        Planning", an alert threshold. What Weathra has is what this run resolved to and where each
        part came from, which is the honest version of "what the agent is working from".
      */}
      <Card aria-labelledby="analyst-context">
        <CardHeader headingLevel={2} title="Analyst context" titleId="analyst-context" />
        <CardBody>
          {resolved ? (
            <dl className={styles.railFacts}>
              <div className={styles.railFact}>
                <dt>Location</dt>
                {/*
                  A run that resolved nowhere said "Not resolved (from the none)" — the internal
                  name of the last step of the resolution ladder, printed as though it were a
                  source. There is no source to name when nothing was resolved, so none is named.
                */}
                <dd>
                  {placeLabel(resolved.locations?.[0]) ??
                    (waiting ? "Not set — choose one below" : "Not resolved")}
                  {resolved.locations?.length && resolved.location_source
                    ? ` — ${LOCATION_SOURCE_PHRASES[resolved.location_source] ?? resolved.location_source}`
                    : ""}
                </dd>
              </div>
              <div className={styles.railFact}>
                <dt>Units</dt>
                <dd>
                  {resolved.unit_system ?? "Not resolved"}
                  {resolved.units_source === "preferences" ? " — your saved default" : ""}
                </dd>
              </div>
              {resolved.period ? (
                <div className={styles.railFact}>
                  <dt>Window</dt>
                  <dd>
                    {/* The calendar days, not the backend's offset-bearing stamps. */}
                    {formatLocalStamp(resolved.period.start_local)} to{" "}
                    {formatLocalStamp(resolved.period.end_local)}
                  </dd>
                </div>
              ) : null}
              {/*
                **Thread context is context, and is labelled as context.**

                `specs/memory` keeps two things apart and so does this panel: what *this
                conversation* has established, which lasts as long as the conversation, and what the
                person *saved*, which lasts until they change it. The artifact calls its invented
                card LONG-TERM MEMORY and fills it with neither. Calling an open thread long-term
                memory would be the same mistake with real data behind it.
              */}
              <div className={styles.railFact}>
                <dt>Conversation</dt>
                <dd>
                  {memory && !memory.available
                    ? (memory.note ?? "Conversation memory was unreachable for this run.")
                    : threadOpen
                      ? "Open — this conversation's turns resolve the next question"
                      : "Not open yet — the next question starts one"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className={styles.note}>This run resolved no place, window or unit system.</p>
          )}
        </CardBody>
      </Card>

      {/*
        **Saved preferences — the honest half of the artifact's memory card.**

        Its own lists "Prioritizing B2B City Planning" and "Alert threshold set for Thermal Drift >
        1.5°C", neither of which Weathra stores or could. What Weathra does store is a unit system,
        a default location and a forecast horizon, each stamped with whether the person chose it or
        Weathra assumed it — and only the chosen ones are memory. With nothing chosen the card says
        so in one line and offers the screen that changes it, rather than standing empty or, worse,
        listing the defaults as though they had been remembered.
      */}
      <Card aria-labelledby="analyst-memory">
        <CardHeader headingLevel={2} title="Preferences in use" titleId="analyst-memory" />
        <CardBody>
          {saved.length > 0 ? (
            <dl className={styles.railFacts}>
              {saved.map((row) => (
                <div className={styles.railFact} key={row.term}>
                  <dt>{row.term}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={styles.note}>
              No saved analyst preferences yet. <Link href="/settings">Settings</Link> keeps your
              units, default location and horizon.
            </p>
          )}
        </CardBody>
      </Card>

      {/*
        **Confidence and grounding, and the way to the whole record.**

        The artifact prints "SYNTHESIS CONFIDENCE 98.2%" over its evidence button. No endpoint
        produces a confidence figure for a *run*: the backend states uncertainty about a forecast
        *figure*, with its basis, which is a different claim and the only one it has grounds for. So
        the confidence is a band, the grounding is a count, and the one bar on this panel measures
        the one proportion that is arithmetic — how much of what the run reported carries a figure.
        The three paragraphs of method that used to sit here are one press away, which is the
        economy the frozen screens settled.
      */}
      <Card aria-labelledby="analyst-confidence">
        <CardHeader headingLevel={2} title="Confidence and grounding" titleId="analyst-confidence" />
        <CardBody>
          <dl className={styles.railFacts}>
            <div className={styles.railFact}>
              <dt>Forecast confidence</dt>
              <dd>
                {uncertainty?.horizon?.[0]?.confidence
                  ? `${uncertainty.horizon[0].confidence} at ${uncertainty.horizon[0].hours_ahead} h`
                  : waiting
                    ? "Not assessed yet"
                    : "Not stated for this run"}
              </dd>
            </div>
            <div className={styles.railFact}>
              <dt>Grounded figures</dt>
              <dd>
                {grounding && grounding.figures_checked > 0
                  ? `${grounding.figures_checked} checked · ${grounding.verified ? "verified" : "not verified"}`
                  : waiting
                    ? "Nothing retrieved yet"
                    : grounding
                      ? "No figure to check"
                      : "Not reported"}
              </dd>
            </div>
          </dl>

          {/*
            The one meter this screen is entitled to. `reported / total` over the run's own findings
            — a proportion of things it actually listed, not a score of how well it did. A run that
            reported nothing has nothing to measure, and `Meter` draws the same track and says so
            rather than filling to zero as though zero were the measurement.
          */}
          <div className={styles.railMeter}>
            <Meter
              label="Data coverage"
              value={coverage.total > 0 ? coverage.reported / coverage.total : null}
              unavailable={waiting ? "Nothing retrieved yet" : "No figure reported"}
              note={
                coverage.total > 0 ? (
                  <span className={styles.note}>
                    {coverage.reported} of {coverage.total} reported figures carry a value
                  </span>
                ) : null
              }
            />
          </div>

          <details className={styles.railMethod}>
            <summary className={styles.railMethodSummary}>How this is judged</summary>
            {uncertainty ? (
              <>
                <p className={styles.note}>{uncertainty.basis}</p>
                <p className={styles.note}>
                  {uncertainty.spread_available
                    ? `${uncertainty.provider} supplied a spread.`
                    : `${uncertainty.provider} supplied no spread, so none is shown.`}
                </p>
              </>
            ) : (
              <p className={styles.note}>
                This run stated no uncertainty. Weathra states it about a forecast figure, with its
                basis, and does not score a run as a whole.
              </p>
            )}
            {grounding ? (
              <p className={styles.note}>
                Grounding: {grounding.verified ? "verified" : "not verified"} —{" "}
                {grounding.figures_checked} figure(s) checked by {grounding.method}.
              </p>
            ) : null}
          </details>

          {evidenceId ? (
            <Link className={styles.railEvidence} href={`/evidence/${evidenceId}`}>
              View full agent evidence
            </Link>
          ) : (
            <p className={styles.note}>This run stored no evidence record.</p>
          )}
        </CardBody>
      </Card>
    </aside>
  );
}
