/**
 * What Weathra can honestly say about a run record, computed from the record itself.
 *
 * `05-agent-evidence.png` closes on an audit panel: a confidence index, a stability bar, a
 * signature hash, a chain of custody and an ISO compliance badge. Four of those five describe
 * guarantees Weathra does not provide, and reproducing their *names* would be the most
 * consequential lie an evidence screen could tell — a reader trusts this page precisely because it
 * is the page that does not overstate.
 *
 * So each one is met by the honest thing underneath it:
 *
 * * a **confidence index** → evidence completeness, from checks listed below, not a model's opinion
 *   of its own answer;
 * * a **stability index** → run health, from whether the stages and sources a run needed actually
 *   arrived;
 * * a **signature hash** → a record hash. SHA-256 over the record, which proves the bytes have not
 *   changed *since this page read them* — it is not a signature, nothing is signed with a key, and
 *   the label says hash for that reason;
 * * a **chain of custody** → a provenance timeline, built from timestamps the run already recorded;
 * * an **ISO compliance badge** → nothing. There is no honest equivalent of a certification nobody
 *   obtained, so the slot stays empty.
 *
 * Every figure here is computed in the browser from the stored record. Nothing is fetched, nothing
 * is persisted, and no provider is called.
 */

import type { RunRecord } from "./record";

/** One thing that had to be true for a record to be complete, and whether it was. */
export interface EvidenceCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  /** Why it did not pass, where that is worth saying. */
  readonly note?: string;
}

export type IntegrityState = "Optimal" | "Complete" | "Partial" | "Degraded";

export interface EvidenceAudit {
  readonly checks: readonly EvidenceCheck[];
  readonly passed: number;
  readonly total: number;
  /** Whole percent of checks that passed. Presentation of the checks, not a separate judgement. */
  readonly completeness: number;
  readonly state: IntegrityState;
}

/**
 * The checks a completeness figure is the arithmetic of.
 *
 * Deliberately few, deliberately boring, and every one answerable from the stored record alone. A
 * check nobody can verify from the record would make the number unfalsifiable, which is the thing
 * a confidence percentage on an evidence screen most often is.
 */
export function auditOf(record: RunRecord): EvidenceAudit {
  const grounding = record.answer?.grounding ?? null;
  const failedStages = record.agents.filter((step) => step.status === "failed");
  const failedTools = record.tools.filter((activity) => activity.result?.ok === false);
  const citedWithoutSource = record.citations.length > 0 && record.sources.length === 0;

  const checks: EvidenceCheck[] = [
    {
      id: "persisted",
      label: "Record persisted",
      // It was read back from storage to be on this screen at all.
      passed: record.id.length > 0,
    },
    {
      id: "stages",
      label: "Every stage completed",
      passed: record.agents.length > 0 && failedStages.length === 0,
      note:
        failedStages.length > 0
          ? `${failedStages.length} stage${failedStages.length === 1 ? "" : "s"} failed`
          : record.agents.length === 0
            ? "no stages recorded"
            : undefined,
    },
    {
      id: "tools",
      label: "Every tool call returned",
      passed: failedTools.length === 0,
      note:
        failedTools.length > 0
          ? `${failedTools.length} call${failedTools.length === 1 ? "" : "s"} failed`
          : undefined,
    },
    {
      id: "sources",
      label: "Sources recorded for what was retrieved",
      // A run that called a retrieval tool and recorded no attribution has lost its lineage.
      passed: record.tools.length === 0 || record.sources.length > 0,
      note: citedWithoutSource ? "knowledge cited with no source recorded" : undefined,
    },
    {
      id: "grounding",
      label: "Interpretation grounded in the evidence",
      // A run with no prose has nothing to ground, and is not penalised for it.
      passed: record.answerProse === null ? true : grounding?.verified === true,
      note:
        record.answerProse !== null && grounding === null
          ? "no grounding report recorded"
          : record.answerProse !== null && grounding?.verified !== true
            ? "figures did not match the evidence"
            : undefined,
    },
    {
      id: "complete",
      label: "Run completed in full",
      passed: !record.partial,
      note: record.partial ? (record.partialReason ?? "run was partial") : undefined,
    },
  ];

  const passed = checks.filter((check) => check.passed).length;
  const completeness = Math.round((passed / checks.length) * 100);

  return { checks, passed, total: checks.length, completeness, state: stateOf(checks) };
}

/**
 * The word for a set of checks.
 *
 * "Optimal" is reserved for everything passing — the artifact uses it, and it is the one of its
 * five audit words that can be earned. A failed *stage* degrades further than a missing grounding
 * report, because one means the run did not do what it set out to and the other means it cannot be
 * fully vouched for.
 */
function stateOf(checks: readonly EvidenceCheck[]): IntegrityState {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) return "Optimal";
  if (failed.some((check) => check.id === "stages" || check.id === "persisted")) return "Degraded";
  if (failed.length === 1) return "Complete";
  return "Partial";
}

/** One recorded moment in a run, for the provenance timeline. */
export interface ProvenanceEvent {
  readonly at: string;
  readonly label: string;
  readonly detail: string | null;
}

/**
 * The run's own timestamps, in order — the honest form of a chain of custody.
 *
 * Not a custody chain: nothing here is countersigned, and it proves only what the run recorded
 * about itself. What it does give a reader is the sequence and the gaps, which is what somebody
 * checking "when did this happen, and in what order" actually opens an evidence record for.
 */
export function provenanceOf(record: RunRecord): ProvenanceEvent[] {
  const events: ProvenanceEvent[] = [];

  if (record.timing.startedAt) {
    events.push({ at: record.timing.startedAt, label: "Run started", detail: null });
  }
  for (const step of record.agents) {
    if (!step.started_at) continue;
    events.push({
      at: step.started_at,
      label: `${humanStage(String(step.agent))} ran`,
      detail: step.reason ?? null,
    });
  }
  for (const activity of record.tools) {
    if (!activity.startedAt) continue;
    events.push({
      at: activity.startedAt,
      label: `${activity.tool} called`,
      detail: activity.result?.ok === false ? "failed" : null,
    });
  }
  if (record.timing.completedAt) {
    events.push({ at: record.timing.completedAt, label: "Run completed", detail: null });
  }
  if (record.timing.storedAt) {
    events.push({ at: record.timing.storedAt, label: "Record persisted", detail: null });
  }

  return events.sort((left, right) => left.at.localeCompare(right.at));
}

function humanStage(agent: string): string {
  const words = agent.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * SHA-256 over the record, as this page received it.
 *
 * **This is a hash, and it is labelled one.** It proves two readings of the same record are
 * byte-identical; it proves nothing about who produced the record, because nothing signs it with a
 * key. The artifact calls its equivalent a signature hash, and that word would claim an assurance
 * Weathra does not provide.
 *
 * The input is canonical JSON — keys sorted at every depth — so two readings of one record hash the
 * same regardless of how the transport ordered them. `null` where the browser offers no
 * `crypto.subtle`, which is every insecure origin; a missing hash is shown as unavailable rather
 * than replaced with something weaker that looks the same.
 */
export async function recordHash(record: unknown): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;

  try {
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(record)));
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** The same value with every object's keys in sorted order, so the encoding is deterministic. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}
