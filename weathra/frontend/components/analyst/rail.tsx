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

import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import type { AnswerEnvelope } from "@/lib/api/schema";
import { placeLabel } from "@/lib/locations/place";
import type { AgentStreamState } from "@/hooks/use-agent-stream";

import styles from "./analyst.module.css";

/** What the rail says the agent is doing, from the stream's own status. */
function statusOf(live: AgentStreamState | null, answered: boolean): {
  label: string;
  tone: "ok" | "accent" | "neutral";
} {
  if (live?.status === "streaming") return { label: "Running", tone: "accent" };
  // A run that ended in anything but an answer. The terminal says which, and none of them is
  // "complete" — reporting one as complete would be the panel's own small fabrication.
  const terminal = live?.terminal?.kind;
  if (terminal !== undefined && terminal !== "final") return { label: "Did not finish", tone: "neutral" };
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

export function AnalystRail({ live, answer, evidenceId, memory }: AnalystRailProps): ReactNode {
  const status = statusOf(live, answer !== null);
  const agents = agentsFrom(live);
  const sources = answer?.attribution ?? [];
  const resolved = answer?.resolved ?? null;
  const uncertainty = answer?.uncertainty ?? null;
  const grounding = answer?.grounding ?? null;

  /*
   * Whether there is a run to describe at all.
   *
   * `live` is a run in flight or the last one that settled, `answer` the last completed one. With
   * neither, every panel below would be a placeholder, and four placeholders are not a rail.
   */
  const described = live !== null || answer !== null;

  if (!described) {
    /*
     * Before the first question: the status, and the four regions named — not explained.
     *
     * The first version of this state gave each of the artifact's four panels a paragraph about
     * what it would eventually contain, and the runtime audit of 2026-09-08 photographed four
     * paragraphs of the interface describing itself. The correction went the other way and left one
     * sentence in an otherwise empty column, which the 2026-09-10 fidelity review photographed
     * beside an equally empty workspace.
     *
     * This is the middle: one status card carrying the artifact's own status geometry, and the
     * regions as a labelled list — a name and four words each, in the order they will fill. It is
     * shorter than the paragraph it replaces and it holds the rail's shape, which is what the
     * artifact fixes about this column.
     */
    return (
      <aside className={styles.rail} aria-label="Run detail">
        <Card aria-labelledby="analyst-rail-waiting">
          <CardHeader
            headingLevel={2}
            title="Agent status"
            titleId="analyst-rail-waiting"
            badge={<Badge tone="neutral">Idle</Badge>}
          />
          <CardBody>
            <p className={styles.note}>
              No run yet. These fill from the run itself, in this order.
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
      <Card aria-labelledby="analyst-status">
        <CardHeader headingLevel={2}
          title="Agent status"
          titleId="analyst-status"
          badge={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody>
          {agents.length > 0 ? (
            <ul className={styles.railList}>
              {agents.map((agent) => (
                <li className={styles.railRow} key={agent}>
                  <span className={styles.railName}>{agent}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>This run named no agents.</p>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="analyst-sources">
        <CardHeader headingLevel={2} title="Active data sources" titleId="analyst-sources" />
        <CardBody>
          {sources.length > 0 ? (
            <ul className={styles.railList}>
              {sources.map((source, index) => (
                <li className={styles.railRow} key={`${source.provider}-${index}`}>
                  <span className={styles.railName}>{source.provider}</span>
                  <span className={styles.railMeta}>{placeLabel(source.location)}</span>
                  <span className={styles.railMeta}>Retrieved {source.retrieved_at}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>This run retrieved from no provider.</p>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="analyst-context">
        <CardHeader headingLevel={2} title="Analyst context" titleId="analyst-context" />
        <CardBody>
          {resolved ? (
            <dl className={styles.railFacts}>
              <div className={styles.railFact}>
                <dt>Location</dt>
                <dd>
                  {placeLabel(resolved.locations?.[0]) ?? "Not resolved"}
                  {resolved.location_source ? ` (from the ${resolved.location_source})` : ""}
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
                    {resolved.period.start_local} to {resolved.period.end_local}
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

      <Card aria-labelledby="analyst-confidence">
        <CardHeader headingLevel={2} title="Confidence and grounding" titleId="analyst-confidence" />
        <CardBody>
          {/*
            The artifact's "Synthesis Confidence 98.2%". No endpoint produces a confidence figure
            for a *run*; the backend states uncertainty about a forecast *figure*, which is a
            different claim and the only one it has a basis for. So this shows that statement when
            there is one, and says there is none when there is not.
          */}
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

          {evidenceId ? (
            <Link className={styles.railAction} href={`/evidence/${evidenceId}`}>
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
