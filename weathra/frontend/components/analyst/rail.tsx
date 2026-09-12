"use client";

/**
 * The Analyst's right rail — the column `02-ai-weather-analyst.png` runs beside the conversation.
 *
 * The artifact stacks four panels there: Agent Status, Active Data Sources, Analyst Context, and a
 * synthesis-confidence figure over a "View Full Agent Evidence" action. All four are reproduced, in
 * that order, and every value in them comes from the run the person is looking at.
 *
 * **What the artifact shows there that is not reproduced, and why.** Its Agent Status panel reports
 * "Neural Agent v4.8" and a 14.2% compute load; its Active Data Sources panel shows generated
 * imagery over three named third-party feeds; its Analyst Context panel lists remembered business
 * preferences; and it prints "Synthesis Confidence 98.2%". `docs/design/screens.md` §5 refuses all
 * of it — an agent version, a compute figure, invented providers and an invented confidence are
 * exactly the fabrications that make a grounded product untrustworthy. The panels stay; what fills
 * them is the run's own record.
 *
 * So: Agent Status is the run's real status and the agents the stream actually reported. Active
 * Data Sources are the providers in the answer's attribution, each with the data class it supplied.
 * Analyst Context is `ResolvedContext` — the location, period and unit system the run settled on,
 * *and where each came from*, which is the honest version of "what the agent remembered". And the
 * confidence slot carries the backend's `UncertaintyStatement` when it supplied one and says it
 * supplied none when it did not, rather than printing a number nobody computed.
 *
 * **Before the first question the rail is one line, not four panels.** The artifact never draws
 * that state, and the first attempt at it gave each of the four panels a paragraph explaining what
 * it would eventually contain. The runtime audit of 2026-09-08 photographed the result: beside an
 * empty conversation, and beside a failed one, the tallest thing on the screen was four paragraphs
 * of the interface describing itself. A person who has not asked anything does not need the rail
 * explained; they need the question box. So the rail says once that it fills in after a run, and
 * the four panels — in the artifact's order, with the artifact's geometry — appear as soon as there
 * is a run to describe.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, Card, CardBody, CardHeader, formatLocalStamp } from "@/components/ui";
import type { AnswerEnvelope } from "@/lib/api/schema";
import { needsLocation } from "@/lib/analyst/intent";
import { placeLabel } from "@/lib/locations/place";
import type { AgentStreamState } from "@/hooks/use-agent-stream";

import styles from "./analyst.module.css";

/**
 * What the rail says the agent is doing, from the stream's own status.
 *
 * "Complete" is reserved for a run that completed an *analysis*. The 2026-09-12 review photographed
 * this badge reading COMPLETE beside a reply that had asked which place to look at and retrieved
 * nothing at all — a green tick over a run that never started. A run waiting for context is not a
 * finished one, and saying so was the panel's own small fabrication.
 */
function statusOf(
  live: AgentStreamState | null,
  answered: boolean,
  waiting: boolean,
): {
  label: string;
  tone: "ok" | "accent" | "neutral" | "warning";
} {
  if (live?.status === "streaming") return { label: "Running", tone: "accent" };
  // A run that ended in anything but an answer. The terminal says which, and none of them is
  // "complete" — reporting one as complete would be the panel's own small fabrication.
  const terminal = live?.terminal?.kind;
  if (terminal !== undefined && terminal !== "final") return { label: "Did not finish", tone: "neutral" };
  if (waiting) return { label: "Needs location", tone: "warning" };
  if (answered) return { label: "Complete", tone: "ok" };
  return { label: "Idle", tone: "neutral" };
}

/** The agents the stream named, in the order it named them. Never a fixed list. */
function agentsFrom(live: AgentStreamState | null): readonly string[] {
  const seen = new Set<string>();
  for (const event of live?.events ?? []) {
    const data = event as { data?: { agent?: unknown } };
    const agent = data.data?.agent;
    if (typeof agent === "string" && agent !== "") seen.add(agent);
  }
  return [...seen];
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
  current: "Observed conditions",
  forecast: "Forecast",
  historical: "Archive",
  analytics: "Computed figures",
};

export function AnalystRail({ live, answer, evidenceId, memory }: AnalystRailProps): ReactNode {
  /*
   * A run that came back asking for a place is the rail's own special case, and every panel below
   * reads it. `needsLocation` is the same function the answer body and the composer use, so the
   * three cannot describe one run three ways again.
   */
  const waiting = needsLocation(answer);
  const status = statusOf(live, answer !== null && !waiting, waiting);
  const agents = agentsFrom(live);
  const resolved = answer?.resolved ?? null;
  const uncertainty = answer?.uncertainty ?? null;
  const grounding = answer?.grounding ?? null;

  /*
   * One row per provider *and role*, not one per attribution entry. A run citing the same provider
   * for four things listed it four times with four timestamps, which is a log rather than a source
   * list — and the artifact's own panel names four distinct sources.
   */
  const sources = [
    ...new Map(
      (answer?.attribution ?? []).map((entry) => [
        `${entry.provider}|${entry.data_class}`,
        {
          provider: entry.provider,
          role: SOURCE_ROLES[entry.data_class ?? ""] ?? entry.data_class ?? null,
          place: placeLabel(entry.location),
        },
      ]),
    ).values(),
  ];

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
        Inference" and a 14.2% compute load. Weathra runs no neural agent of its own, names no
        process and measures no compute; what it has is the run's real state and the agents the
        stream actually named, which is what this says.
      */}
      <Card aria-labelledby="analyst-status">
        <CardHeader headingLevel={2}
          title="Analyst status"
          titleId="analyst-status"
          badge={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody>
          {/*
            **What the agents did, or why they did not run.**

            "This run named no agents." was the debug line the 2026-09-12 review objected to: an
            implementation fact, in implementation words, offered to a customer as the explanation
            for an empty screen. Orchestration not running is not a property of agents — it is a
            property of the context the run was given, and that is what this now says. The
            node-level execution record has not moved: it is the Agent Evidence trace this rail
            links to at the bottom of the column.
          */}
          {agents.length > 0 ? (
            <ul className={styles.railAgents}>
              {agents.map((agent) => (
                <li className={styles.railAgent} key={agent}>
                  <span className={styles.railAgentMark} aria-hidden="true" />
                  <span className={styles.railAgentName}>{agent}</span>
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
        `screens.md` §5 refuses all four. These are the providers this answer cites, each with what
        it supplied.
      */}
      <Card aria-labelledby="analyst-sources">
        <CardHeader headingLevel={2} title="Active data sources" titleId="analyst-sources" />
        <CardBody>
          {sources.length > 0 ? (
            <ul className={styles.railSources}>
              {sources.map((source, index) => (
                <li className={styles.railSource} key={`${source.provider}-${index}`}>
                  <span className={styles.railSourceMark} aria-hidden="true" />
                  <span className={styles.railSourceText}>
                    <span className={styles.railSourceName}>{source.provider}</span>
                    {source.role ? (
                      <span className={styles.railSourceRole}>{source.role}</span>
                    ) : null}
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
        **Analyst context.** The artifact's version is a remembered business preference — "B2B City
        Planning", an alert threshold. Weathra remembers what a person explicitly saved and what
        this conversation established, and that is what this reports: the place, the window and the
        units the run settled on, and where each came from.
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
                    ? ` (from the ${resolved.location_source})`
                    : ""}
                </dd>
              </div>
              <div className={styles.railFact}>
                <dt>Units</dt>
                <dd>
                  {resolved.unit_system ?? "Not resolved"}
                  {resolved.units_source ? ` (from the ${resolved.units_source})` : ""}
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
            </dl>
          ) : (
            <p className={styles.note}>This run resolved no place, window or unit system.</p>
          )}

          {memory ? (
            <p className={styles.note}>
              {memory.available
                ? (memory.note ?? "This conversation's earlier turns are available to the agent.")
                : "Conversation memory is not available for this run."}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/*
        **Confidence and grounding, and the way to the whole record.**

        The artifact prints "SYNTHESIS CONFIDENCE 98.2%" over its evidence button. No endpoint
        produces a confidence figure for a *run*: the backend states uncertainty about a forecast
        *figure*, with its basis, which is a different claim and the only one it has grounds for. So
        this is a band and a count rather than a percentage — and the three paragraphs of method
        that used to sit here are one press away, which is the economy the frozen screens settled.
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
