"use client";

/**
 * Agent Evidence / Activity — task 21.5.
 *
 * One stored run, fetched from `GET /api/v1/evidence/{id}` with the caller's bearer token and
 * rendered as the record it is. The screen retrieves nothing else: it makes no weather call, opens
 * no stream, and re-runs nothing. `specs/agent-orchestration` requires the stored record to be
 * sufficient for a reader to verify every figure and claim *without re-running the question*, and a
 * screen that fetched anything to fill a gap would be quietly disproving that.
 *
 * **The route is the backend's, and so is the authorization.** There is one evidence system: the
 * `agent_runs` row the orchestrator stored, read back through the one protected endpoint that
 * serves it. The query carries the ownership predicate and Row Level Security sits behind it, so an
 * identifier belonging to somebody else is refused by the database, not by this screen. What this
 * screen does with that refusal is the only part it owns — and it renders an unknown identifier and
 * another person's identifier identically, because the backend answers them identically, byte for
 * byte. Nothing here inspects the difference, because there is none to inspect.
 *
 * **Five states, and none of them invents a run.** Loading, the populated record, a record the
 * response did not actually contain, the not-found answer, and a backend failure that is not
 * not-found. The sixth — an expired session — does not belong to this screen at all: the API client
 * turns a 401 into `SessionExpired` and the shared session boundary replaces the screen, exactly as
 * it does for every other protected surface.
 *
 * Built against `docs/design/screens/05-agent-evidence.png`. The artifact's audit identifier and
 * signature hash, its "cryptographically signed and immutable" claim and stability index, its agent
 * version string, node identifiers, invented providers, station identifiers, fabricated latencies
 * and confidence percentage, and its "Validate Conclusion", "Export Trace", "Inspect Payloads" and
 * "View Chain of Custody" controls are recorded as mockup filler in `docs/design/screens.md` §5;
 * the divergences this screen decides beyond them are in §8.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { ErrorState, LoadingState } from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type { EvidenceResponse } from "@/lib/api/schema";
import { EVIDENCE_NOT_FOUND_CODE } from "@/lib/api/errors";
import { runRecordFrom } from "@/lib/evidence/record";
import { useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";

import {
  DeterministicAnalytics,
  ExecutionFlow,
  FinalSynthesis,
  GroundedSources,
  KnowledgeEvidence,
  RecordAudit,
  RecordProvenance,
  ResolvedContextPanel,
  RunHeader,
  ToolActivityPanel,
  UncertaintyPanel,
} from "./sections";
import styles from "./evidence.module.css";

/** Where somebody goes to produce a run in the first place. */
const ANALYST_PATH = "/analyst";

/**
 * The not-found state, which is also the not-yours state.
 *
 * One rendering for both, because the backend sends one answer for both. It shows the backend's own
 * message and offers no retry: a 404 here is a decision, and asking again unchanged gets the same
 * decision. It states the policy — that a record which never existed and one owned by someone else
 * are answered the same way — which is a fact about Weathra and discloses nothing about this
 * identifier.
 */
function RecordNotFound({ failure }: { readonly failure: ViewFailure }): ReactNode {
  return (
    <div className={styles.state} role="status" data-evidence-state="not-found">
      <p className={styles.stateTitle}>No evidence record with that identifier</p>
      <p className={styles.stateBody}>{failure.message}</p>
      <p className={styles.stateBody}>
        Evidence records belong to the person whose question produced them. An identifier Weathra
        has never stored and one stored for somebody else are answered the same way, so nothing here
        says which this was.
      </p>
      <Link className={styles.link} href={ANALYST_PATH}>
        Ask a question in the AI Weather Analyst
      </Link>
      {failure.requestId ? <p className={styles.note}>Request {failure.requestId}</p> : null}
    </div>
  );
}

/**
 * A row that came back but does not hold a run record.
 *
 * Distinct from not-found on purpose: the record exists and is yours, and Weathra cannot read it.
 * Saying so is the honest answer; rendering the header with empty sections beneath it would present
 * a run that was never recovered.
 */
function RecordUnreadable({ evidenceId }: { readonly evidenceId: string }): ReactNode {
  return (
    <div className={styles.state} role="status" data-evidence-state="unreadable">
      <p className={styles.stateTitle}>This record could not be read</p>
      <p className={styles.stateBody}>
        Weathra stored a run under this identifier, but the stored record is not one this version can
        display. Nothing is shown rather than a partial reconstruction of it.
      </p>
      <p className={styles.note}>Evidence {evidenceId}</p>
    </div>
  );
}

/** The whole record, in the artifact's order. */
function RecordView({ response }: { readonly response: EvidenceResponse }): ReactNode {
  const record = runRecordFrom(response);
  if (record === null) return <RecordUnreadable evidenceId={response.id} />;

  return (
    <>
      <RunHeader record={record} />

      <div className={styles.body}>
        <div className={styles.column}>
          <ExecutionFlow record={record} />
          <ToolActivityPanel record={record} />
        </div>

        <div className={styles.column}>
          <GroundedSources sources={record.sources} citations={record.citations} />
          <DeterministicAnalytics record={record} />
          <UncertaintyPanel record={record} />
          <KnowledgeEvidence citations={record.citations} />
          <FinalSynthesis record={record} />
        </div>
      </div>

      {/* The artifact closes on two panels side by side: what the run was about, and how to trace it. */}
      <div className={styles.footGrid}>
        <ResolvedContextPanel record={record} />
        <RecordAudit record={record} response={response} />
      </div>

      <RecordProvenance record={record} />
    </>
  );
}

export interface AgentEvidenceProps {
  /** The stored record's identifier, from the route. Never generated in the browser. */
  readonly evidenceId: string;
}

export function AgentEvidence({ evidenceId }: AgentEvidenceProps): ReactNode {
  const { state, retry } = useApiQuery<EvidenceResponse>({
    key: ["evidence", evidenceId],
    request: (client) => client.evidence(evidenceId),
    // "Empty" here means the response carried no readable run record — not that the run was empty.
    isEmpty: (data) => runRecordFrom(data) === null,
  });

  return (
    <section className={styles.screen} aria-label="Agent Evidence">
      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => <LoadingState label="Loading this run's evidence record" lines={6} />}
        empty={() => <RecordUnreadable evidenceId={evidenceId} />}
        error={(failure, again) =>
          failure.code === EVIDENCE_NOT_FOUND_CODE ? (
            <RecordNotFound failure={failure} />
          ) : (
            <ErrorState
              failure={failure}
              title="That evidence record could not be loaded"
              onRetry={again}
            />
          )
        }
        ready={(data) => <RecordView response={data} />}
      />
    </section>
  );
}
