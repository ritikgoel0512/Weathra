"use client";

/**
 * Agent Evidence with no run selected — the caller's own runs, newest first.
 *
 * **Why this replaced an empty workspace.** `/evidence` used to render every panel a record has,
 * unpopulated and labelled, and that was a reasonable answer to a real constraint: the API exposed
 * a record only by its identifier, and a screen listing runs would have had to invent the listing.
 * The cost was that a person with a dozen stored runs saw exactly what a person with none saw — a
 * page describing the evidence log without ever showing one. `GET /evidence` answers "which runs
 * do I have", so the screen can stop describing and start showing.
 *
 * **It lists what the record actually holds.** The question asked, when it ran, how long it took,
 * how many agents it recorded, and the places it resolved *by display name* — never a coordinate
 * pair, which is internal metadata everywhere else in Weathra and is internal metadata here.
 *
 * **Records come from runs, and only some surfaces run one.** An agent run is stored when a
 * question goes through the orchestrator, which today means the AI Weather Analyst and the Weather
 * Intelligence Report. The deterministic screens compute their answers without an agent and store
 * no run, so they have no records to list — said plainly on the empty state rather than implied
 * away by a list that stays mysteriously short.
 *
 * **It opens on a record, not on a list.** `05-agent-evidence.png` is a *populated trace*, and a
 * list is not one: landing on an index meant the navigation entry still showed the shape of the
 * evidence log rather than an actual execution. The newest run is rendered in full underneath a
 * compact switcher, so the page a person meets is the thing the artifact draws, and every other
 * run is one press away. `/evidence/{id}` is unchanged and still opens any record directly.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  Badge,
  ErrorState,
  LoadingState,
  formatInstant,
} from "@/components/ui";
import type { EvidenceListResponse, EvidenceSummary } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";

import { AgentEvidence } from "./evidence";
import styles from "./evidence.module.css";

/** Where a run is produced in the first place. */
const ANALYST_PATH = "/analyst";
const REPORT_PATH = "/report";

/** A duration a person reads: milliseconds are the record's unit, not the reader's. */
function spokenDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/**
 * One stored run in the switcher.
 *
 * A button rather than a link, because pressing it changes what is shown *on this page* rather
 * than navigating away — the record appears below it. The deep link still exists: every run has
 * its own route, offered beside the selection for anyone who wants to share or bookmark one.
 */
function RunChip({
  record,
  selected,
  onSelect,
}: {
  readonly record: EvidenceSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const places = record.locations ?? [];

  return (
    <li className={styles.chipItem}>
      <button
        type="button"
        className={styles.chip}
        data-selected={selected ? "true" : undefined}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className={styles.chipQuestion}>{record.question}</span>
        <span className={styles.chipFacts}>
          <span>{formatInstant(record.created_at)}</span>
          {places.length > 0 ? <span>{places.join(" · ")}</span> : null}
          <span>
            {record.steps} {record.steps === 1 ? "agent" : "agents"}
          </span>
          <span>{spokenDuration(record.duration_ms)}</span>
          {record.partial ? <Badge tone="warning">Partial</Badge> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The state a new account meets, and the one that must not read as a failure.
 *
 * Nothing has gone wrong when there are no runs: nobody has asked a question yet. It says where a
 * run comes from rather than leaving the reader to guess which of Weathra's screens produces one.
 *
 * **It says "this account", because that is what emptiness here means.** Evidence is owner-scoped
 * twice over — `GET /api/v1/evidence` filters on the caller's own id, and `agent_runs` carries a
 * forced `FOR ALL` row-level policy on top of it — so one account's records are never the other's
 * to see. Somebody signed in to a second account was reading an unqualified "no evidence records"
 * as Weathra having lost the runs they had just watched it make on the first. The scope is a fact
 * about the screen, so the screen states it.
 */
function NoRecords(): ReactNode {
  return (
    <div className={styles.state} role="status" data-evidence-state="empty">
      <p className={styles.stateTitle}>No evidence records yet for this account</p>
      <p className={styles.stateBody}>
        Evidence appears here after this account runs the AI Weather Analyst or a Weather
        Intelligence Report. Weathra stores a record every time it answers a question through its
        agents — what ran, what each step retrieved, the analytics it computed and the knowledge it
        cited. Records belong to the account that made them, so signing in as somebody else shows
        theirs rather than these.
      </p>
      <p className={styles.stateBody}>
        The screens that compute their answers directly — Travel Intelligence, Forecast Explorer,
        Historical Analytics and Compare Cities — show their own workings on the page and run no
        agent, so they produce no record here.
      </p>
      <span className={styles.stateActions}>
        <Link className={styles.link} href={ANALYST_PATH}>
          Ask the AI Weather Analyst
        </Link>
        <Link className={styles.link} href={REPORT_PATH}>
          Build a Weather Intelligence Report
        </Link>
      </span>
    </div>
  );
}

/**
 * The runs a person has, newest first.
 *
 * `GET /evidence` orders by `created_at` descending and this repeats the ordering rather than
 * trusting it. The page opens on whichever run this puts first, so "the newest run" being a
 * property of the *response's row order* would mean a change at the other end of the system
 * silently pinning this screen to an old record — which is exactly the failure that made the
 * console look, for several passes, like it could only ever show one run.
 */
function newestFirst(records: readonly EvidenceSummary[]): EvidenceSummary[] {
  return [...records].sort((left, right) => {
    const at = (record: EvidenceSummary): number => {
      const stamp = Date.parse(record.created_at ?? "");
      return Number.isNaN(stamp) ? 0 : stamp;
    };
    return at(right) - at(left);
  });
}

/** The switcher and the record it selects. */
function Log({ records: listed }: { readonly records: readonly EvidenceSummary[] }): ReactNode {
  const records = newestFirst(listed);
  const newest = records[0] as EvidenceSummary;
  const [selected, setSelected] = useState<string>(newest.id);
  const current = records.find((record) => record.id === selected) ?? newest;

  return (
    <>
      {/*
        More than one run is worth switching between; exactly one is not, and a switcher offering a
        single choice is furniture. With one record the page is simply that record.
      */}
      {/*
        A compact selector, not a run browser.
        
        The switcher was a full card of pills above the record, so the trace — the thing the page
        exists to show — began a third of the way down. `05-agent-evidence.png` is an evidence
        *record*; choosing which one is a control on it, and folds away.
      */}
      {records.length > 1 ? (
        <details className={styles.switcher}>
          <summary className={styles.switcherSummary}>
            <span className={styles.switcherLabel}>Run</span>
            <span className={styles.switcherCurrent}>{current.question}</span>
            <span className={styles.switcherCount}>{records.length} recent</span>
          </summary>
          <ul className={styles.chips}>
            {records.map((record) => (
              <RunChip
                key={record.id}
                record={record}
                selected={record.id === current.id}
                onSelect={() => setSelected(record.id)}
              />
            ))}
          </ul>
        </details>
      ) : null}

      <p className={styles.recordLink}>
        <Link className={styles.link} href={`/evidence/${current.id}`}>
          Open this run on its own page
        </Link>
        <span className={styles.note}>
          Records are readable only by the account that produced them.
        </span>
      </p>

      {/* The record itself, rendered by the same component `/evidence/{id}` uses. One screen. */}
      <AgentEvidence key={current.id} evidenceId={current.id} />
    </>
  );
}

export function EvidenceLog(): ReactNode {
  const records = useApiQuery<EvidenceListResponse>({
    key: ["evidence", "records"],
    request: (client) => client.evidenceRecords({ limit: 20 }),
  });

  const found = records.state.kind === "ready" ? (records.state.data.records ?? []) : [];

  return (
    <section className={styles.log} aria-label="Agent Evidence">
      {records.state.kind === "loading" ? (
        <LoadingState label="Reading your evidence records" lines={5} />
      ) : records.state.kind === "error" ? (
        <ErrorState
          failure={records.state.failure}
          title="Your evidence records could not be read"
          onRetry={records.retry}
        />
      ) : found.length === 0 ? (
        <NoRecords />
      ) : (
        <Log records={found} />
      )}
    </section>
  );
}
