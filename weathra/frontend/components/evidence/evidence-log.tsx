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
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LoadingState,
  formatInstant,
} from "@/components/ui";
import type { EvidenceListResponse, EvidenceSummary } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";

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

/** One stored run, as a row that opens it. */
function RecordRow({ record }: { readonly record: EvidenceSummary }): ReactNode {
  const places = record.locations ?? [];

  return (
    <li className={styles.logRow}>
      <Link className={styles.logLink} href={`/evidence/${record.id}`}>
        <span className={styles.logQuestion}>{record.question}</span>

        {record.answer_preview ? (
          <span className={styles.logPreview}>{record.answer_preview}</span>
        ) : null}

        <span className={styles.logFacts}>
          <span className={styles.logFact}>{formatInstant(record.created_at)}</span>
          {places.length > 0 ? (
            <span className={styles.logFact}>{places.join(" · ")}</span>
          ) : null}
          <span className={styles.logFact}>
            {record.steps} {record.steps === 1 ? "agent" : "agents"}
          </span>
          <span className={styles.logFact}>{spokenDuration(record.duration_ms)}</span>
          {record.weather_provider ? (
            <span className={styles.logFact}>{record.weather_provider}</span>
          ) : null}
        </span>
      </Link>

      {record.partial ? <Badge tone="warning">Partial</Badge> : null}
    </li>
  );
}

/**
 * The state a new account meets, and the one that must not read as a failure.
 *
 * Nothing has gone wrong when there are no runs: nobody has asked a question yet. It says where a
 * run comes from rather than leaving the reader to guess which of Weathra's screens produces one.
 */
function NoRecords(): ReactNode {
  return (
    <div className={styles.state} role="status" data-evidence-state="empty">
      <p className={styles.stateTitle}>No evidence records yet</p>
      <p className={styles.stateBody}>
        Weathra stores a record every time it answers a question through its agents — what ran, what
        each step retrieved, the analytics it computed and the knowledge it cited. Ask one and its
        record will appear here.
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

export function EvidenceLog(): ReactNode {
  const records = useApiQuery<EvidenceListResponse>({
    key: ["evidence", "records"],
    request: (client) => client.evidenceRecords({ limit: 20 }),
  });

  return (
    <section className={styles.log} aria-label="Agent Evidence">
      <header className={styles.logHead}>
        <h1 className={styles.logTitle}>Agent evidence log</h1>
        <p className={styles.logLead}>
          Every question Weathra answered through its agents, with the full record of how it got
          there. Open one to see the steps, the sources, the analytics and the knowledge behind it.
        </p>
        <p className={styles.note}>
          Run records are private to the person whose question produced them: this page is behind
          sign-in, and a run is readable only by the account that created it.
        </p>
      </header>

      {records.state.kind === "loading" ? (
        <LoadingState label="Reading your evidence records" lines={5} />
      ) : records.state.kind === "error" ? (
        <ErrorState
          failure={records.state.failure}
          title="Your evidence records could not be read"
          onRetry={records.retry}
        />
      ) : records.state.kind === "ready" && (records.state.data.records ?? []).length === 0 ? (
        <NoRecords />
      ) : records.state.kind === "ready" ? (
        <Card aria-labelledby="evidence-records">
          <CardHeader
            title="Recent runs"
            titleId="evidence-records"
            subtitle={`${records.state.data.returned} of your most recent ${
              records.state.data.returned === 1 ? "run" : "runs"
            }, newest first.`}
          />
          <CardBody>
            <ul className={styles.logList}>
              {(records.state.data.records ?? []).map((record) => (
                <RecordRow key={record.id} record={record} />
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </section>
  );
}
