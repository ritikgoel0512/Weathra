"use client";

/**
 * Model policy — the administrative surface that confirms a policy's candidate list against
 * recorded evidence, and the audited write that does it.
 *
 * **Why this exists and the rest of the screen does not.** `specs/web-ui` keeps Admin Model & AI
 * Usage post-MVP, with one named exception: the policy confirmation surface, because the audited
 * candidate-list write is the only administrative write the MVP's own evidence trail depends on
 * (task 34.5). Model status, token usage, cost, latency, errors and plan usage are still unbuilt
 * and the route still says so — this panel sits beside that statement rather than replacing it.
 *
 * **It authorizes nothing.** The administrative role is a row in `admin_roles` keyed by the
 * validated token subject; every read and the write are refused by the backend for a principal
 * without it. So this panel asks, and renders the answer: a 403 becomes the not-permitted state
 * because the backend said so, not because the frontend decided who may look. Hiding it from a
 * non-administrator would be a presentation convenience, which is exactly what `specs/web-ui`
 * says such hiding is allowed to be and nothing more.
 *
 * **Three honesty rules, all of them one line away from being broken:**
 *
 * 1. A candidate the backend never evaluated is *unevidenced*, never failed. `lib/admin/policy-
 *    evidence.ts` holds that rule and is tested on it directly.
 * 2. A comparison run that scored nothing for a candidate is not evidence about that candidate,
 *    however good the evidence recorded elsewhere is. Cited runs are shown per candidate for that
 *    reason.
 * 3. Submitting the stored order unchanged is a *confirmation*, and is labelled one. Calling it a
 *    promotion would claim a decision the evidence did not support.
 *
 * **The result is read back, not assumed.** A successful `PUT` proves the request was accepted; it
 * does not prove what was recorded. So the confirmation state renders the policy the backend
 * returned and the audit row the backend then hands back, which is the only evidence a reviewer
 * should accept — and the only one that could show the citation actually landed.
 */

import { useCallback, useState, type ReactNode } from "react";

import { isForbiddenCode, promotionGateFailures } from "@/lib/api/errors";
import type {
  AuditEntry,
  ComparisonResultRecord,
  ComparisonRunRecord,
  PolicyRecord,
} from "@/lib/api/schema";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";
import {
  candidateEvidence,
  isConfirmationInPlace,
  type CandidateEvidence,
} from "@/lib/admin/policy-evidence";
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, LoadingState, Select } from "@/components/ui";

import styles from "./admin.module.css";

const POLICIES_KEY = ["admin", "policies"] as const;

/** What a candidate's badge says, and in which tone. Never "failed" for an unevidenced one. */
const VERDICT_LABELS: Record<CandidateEvidence["verdict"], { label: string; tone: "ok" | "error" | "warning" }> = {
  evidenced: { label: "Evidenced — both gates passed", tone: "ok" },
  failed: { label: "Failed a gating criterion", tone: "error" },
  unevidenced: { label: "Unevidenced", tone: "warning" },
};

function instant(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(".000Z", "Z");
}

/** A run in the selector: enough to tell two apart without reading a UUID aloud. */
function runLabel(run: ComparisonRunRecord): string {
  const scope = run.dataset_version === null || run.dataset_version === undefined
    ? (run.question ?? "ad-hoc question")
    : `dataset ${run.dataset_version}`;
  return `${run.id.slice(0, 8)}… — ${instant(run.started_at)} — ${scope} — ${run.status}`;
}

interface CandidateRowProps {
  readonly position: number;
  readonly evidence: CandidateEvidence;
  readonly citedRunId: string | null;
}

function CandidateRow({ position, evidence, citedRunId }: CandidateRowProps): ReactNode {
  const verdict = VERDICT_LABELS[evidence.verdict];

  return (
    <li className={styles.candidate}>
      <div className={styles.candidateHead}>
        <span className={styles.position}>{position}</span>
        <span className={styles.candidateKey}>{evidence.catalogKey}</span>
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
      </div>

      {evidence.gatewayModel === null ? null : (
        <p className={styles.gatewayModel}>{evidence.gatewayModel}</p>
      )}

      {/* One sentence per element: a paragraph assembled from three conditionals reads as one
          claim to a screen reader and cannot be asserted on separately. */}
      <p className={styles.runStanding}>
        {evidence.casesRun === 0
          ? "Not part of the selected comparison run."
          : `${evidence.casesScored} of ${evidence.casesRun} cases scored in the selected run.`}
      </p>
      {evidence.verdict === "unevidenced" ? (
        <p className={styles.runStanding}>
          No evaluation is recorded for this candidate, so it has not been shown to be worse than
          any other — it has not been shown anything.
        </p>
      ) : null}
      {evidence.evidenceFromAnotherRun && evidence.verdict !== "unevidenced" ? (
        <p className={styles.runStanding}>
          The recorded evaluation did not come from this run, so this run cannot be cited as
          evidence for this candidate.
        </p>
      ) : null}

      {evidence.verdict === "unevidenced" ? null : (
        <dl className={styles.criteria}>
          {evidence.criteria.map((criterion) => (
            <div className={styles.criterion} key={criterion.name}>
              <dt>
                {criterion.label}
                {criterion.passed === null ? null : (
                  <Badge tone={criterion.passed ? "ok" : "error"}>
                    {criterion.passed ? "pass" : "fail"}
                  </Badge>
                )}
              </dt>
              <dd data-measured={criterion.measured}>{criterion.reading}</dd>
            </div>
          ))}
        </dl>
      )}

      {evidence.verdict === "evidenced" && !evidence.evidenceFromAnotherRun && citedRunId !== null ? (
        <p className={styles.citable}>
          Citable from this run: <code>{citedRunId}</code>
        </p>
      ) : null}
    </li>
  );
}

interface ConfirmationProps {
  readonly policy: PolicyRecord;
  readonly submittedOrder: readonly string[];
  readonly citedRunIds: readonly string[];
  readonly audit: AuditEntry | null;
}

function Confirmation({ policy, submittedOrder, citedRunIds, audit }: ConfirmationProps): ReactNode {
  const inPlace = isConfirmationInPlace(submittedOrder, policy.candidate_catalog_keys);

  return (
    <div className={styles.confirmation} role="status">
      <Badge tone="ok">{inPlace ? "Candidate order confirmed" : "Candidate order changed"}</Badge>
      <p>
        {inPlace
          ? "The order the backend now holds is the order it held before. This was a confirmation against the cited evidence, not a reordering."
          : "The backend recorded a new candidate order."}
      </p>
      <ol className={styles.finalOrder}>
        {policy.candidate_catalog_keys.map((key) => (
          <li key={key}>{key}</li>
        ))}
      </ol>
      <p>
        Cited comparison {citedRunIds.length === 1 ? "run" : "runs"}:{" "}
        {citedRunIds.length === 0 ? (
          "none — the change cites no comparison"
        ) : (
          citedRunIds.map((id) => <code key={id}>{id}</code>)
        )}
      </p>
      {audit === null ? (
        <p>Reading the audit record back…</p>
      ) : (
        <p className={styles.auditLine}>
          Audited: <strong>{audit.action}</strong> on {audit.subject_kind}{" "}
          <code>{audit.subject_id}</code> at {instant(audit.created_at)}, citing{" "}
          {(audit.cited_comparison_run_ids ?? []).length === 0
            ? "no run"
            : (audit.cited_comparison_run_ids ?? []).map((id) => <code key={id}>{id}</code>)}
          .
        </p>
      )}
    </div>
  );
}

/** A refusal, said as itself. Five outcomes, five sentences, and no automatic retry. */
function Refusal({ failure, onRetry }: { failure: ViewFailure; onRetry?: () => void }): ReactNode {
  const gated = promotionGateFailures(failure.details);

  if (gated !== null) {
    return (
      <div className={styles.refusal} role="alert">
        <Badge tone="error">Refused by the promotion gate</Badge>
        <p>{failure.message}</p>
        <ul>
          {Object.entries(gated).map(([candidate, criteria]) => (
            <li key={candidate}>
              <code>{candidate}</code> failed {criteria.join(", ")}
            </li>
          ))}
        </ul>
        <p>
          A candidate that failed structured JSON reliability or groundedness is not promoted for
          being cheaper or faster. Overriding it is a separate, recorded decision, and is not made
          from this screen.
        </p>
      </div>
    );
  }

  if (isForbiddenCode(failure.code)) {
    return (
      <div className={styles.refusal} role="alert">
        <Badge tone="error">Not permitted</Badge>
        <p>{failure.message}</p>
      </div>
    );
  }

  return <ErrorState failure={failure} onRetry={onRetry} title="That change was not made" />;
}

interface PolicyCardProps {
  readonly policy: PolicyRecord;
  readonly evidence: readonly CandidateEvidence[];
  readonly citedRunId: string | null;
  readonly busy: boolean;
  readonly onConfirm: (policy: PolicyRecord) => void;
  readonly outcome: ReactNode;
}

function PolicyCard({
  policy,
  evidence,
  citedRunId,
  busy,
  onConfirm,
  outcome,
}: PolicyCardProps): ReactNode {
  const titleId = `policy-${policy.policy_id}`;

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader
        title={policy.display_name}
        titleId={titleId}
        subtitle={
          <>
            <code>{policy.policy_id}</code> · {policy.eligibility} ·{" "}
            {policy.applicable_call_roles.join(", ")} ·{" "}
            {policy.failover_enabled === false ? "failover off" : "failover on"}
          </>
        }
        badge={<Badge tone="neutral">{policy.candidate_catalog_keys.length} candidates</Badge>}
      />
      <CardBody>
        <ol className={styles.candidates}>
          {evidence.map((candidate, at) => (
            <CandidateRow
              key={candidate.catalogKey}
              position={at + 1}
              evidence={candidate}
              citedRunId={citedRunId}
            />
          ))}
        </ol>

        <div className={styles.actions}>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => onConfirm(policy)}
            aria-describedby={`${titleId}-explains`}
          >
            Confirm candidate order
          </Button>
          <p id={`${titleId}-explains`} className={styles.actionNote}>
            Submits this order exactly as it stands, citing the selected comparison run. The order
            is unchanged, so this records a confirmation against the evidence rather than a
            reordering — and the backend audits it either way.
          </p>
        </div>

        {outcome}
      </CardBody>
    </Card>
  );
}

export function ModelPolicyPanel(): ReactNode {
  const policies = useApiQuery({ key: POLICIES_KEY, request: (client) => client.adminPolicies() });
  const catalog = useApiQuery({ key: ["admin", "catalog"], request: (client) => client.adminCatalog() });
  const comparisons = useApiQuery({
    key: ["admin", "comparisons"],
    request: (client) => client.adminComparisons(20),
  });

  const [chosenRunId, setChosenRunId] = useState<string | null>(null);
  const listedRuns = comparisons.state.kind === "ready" ? comparisons.state.data.runs : [];
  // Newest first from the backend, so the default is the most recent run rather than an arbitrary
  // one — and an explicit choice always wins over the default.
  const runId = chosenRunId ?? listedRuns[0]?.id ?? null;

  const comparison = useApiQuery({
    key: ["admin", "comparison", runId],
    request: (client) => client.adminComparison(runId as string),
    enabled: runId !== null,
  });

  const [confirmedPolicyId, setConfirmedPolicyId] = useState<string | null>(null);
  const [attempted, setAttempted] = useState<{ policyId: string; order: readonly string[]; cited: readonly string[] } | null>(null);

  const audit = useApiQuery({
    key: ["admin", "policy-audit", confirmedPolicyId],
    request: (client) => client.adminPolicyAudit(confirmedPolicyId as string, 5),
    enabled: confirmedPolicyId !== null,
  });

  const confirm = useApiMutation({
    run: (client, input: { policyId: string; order: readonly string[]; cited: readonly string[] }) =>
      client.confirmPolicyCandidates(input.policyId, {
        candidate_catalog_keys: [...input.order],
        cited_comparison_run_ids: [...input.cited],
      }),
    invalidates: [POLICIES_KEY],
    // Runs only after the backend confirmed the write, with the policy it returned — so the audit
    // read below is triggered by a recorded change rather than by a request having been sent.
    onDone: (policy) => setConfirmedPolicyId(policy.policy_id),
  });

  const onConfirm = useCallback(
    (policy: PolicyRecord) => {
      const input = {
        policyId: policy.policy_id,
        order: policy.candidate_catalog_keys,
        cited: runId === null ? [] : [runId],
      };
      setAttempted(input);
      setConfirmedPolicyId(null);
      confirm.submit(input);
    },
    [confirm, runId],
  );

  if (policies.state.kind === "error" && isForbiddenCode(policies.state.failure.code)) {
    return (
      <section className={styles.panel} aria-labelledby="model-policy">
        <h2 id="model-policy">Model policy</h2>
        <div className={styles.refusal} role="alert">
          <Badge tone="error">Not permitted</Badge>
          <p>
            This surface is for principals holding Weathra&rsquo;s administrative role. Your
            session is valid; it does not hold the role, and signing in again will not change that.
          </p>
          <p>Nothing about the policies, the catalog, the comparisons or the audit trail is loaded.</p>
        </div>
      </section>
    );
  }

  const observations = catalog.state.kind === "ready" ? (catalog.state.data.observations ?? {}) : {};
  const cells: readonly ComparisonResultRecord[] =
    comparison.state.kind === "ready" ? (comparison.state.data.run.results ?? []) : [];
  const selectedRun = comparison.state.kind === "ready" ? comparison.state.data.run : null;

  return (
    <section className={styles.panel} aria-labelledby="model-policy">
      <h2 id="model-policy">Model policy</h2>
      <p className={styles.intro}>
        Each policy&rsquo;s ordered candidate list, the evaluation the backend has recorded for each
        candidate, and the audited write that confirms the order against a comparison run. Nothing
        here computes a criterion or decides who may look: the figures are what the evaluation
        framework recorded, and every read and write on this panel is one the backend refuses to a
        caller without the administrative role.
      </p>

      <Card aria-labelledby="comparison-evidence">
        <CardHeader
          title="Comparison evidence"
          titleId="comparison-evidence"
          subtitle="The run a confirmation cites as its basis."
        />
        <CardBody>
          {comparisons.state.kind === "loading" ? (
            <LoadingState label="Reading the recorded comparisons" />
          ) : comparisons.state.kind === "error" ? (
            <Refusal failure={comparisons.state.failure} onRetry={comparisons.retry} />
          ) : listedRuns.length === 0 ? (
            <p>No comparison run has been recorded, so there is no evidence to cite.</p>
          ) : (
            <>
              <Select
                label="Comparison run"
                description="Newest first. The selected run is the one a confirmation cites."
                value={runId ?? ""}
                onChange={(event) => setChosenRunId(event.target.value)}
                options={listedRuns.map((run) => ({ value: run.id, label: runLabel(run) }))}
              />
              {selectedRun === null ? (
                comparison.state.kind === "error" ? (
                  <Refusal failure={comparison.state.failure} onRetry={comparison.retry} />
                ) : (
                  <LoadingState label="Reading the run" />
                )
              ) : (
                <dl className={styles.runFacts}>
                  <div>
                    <dt>Run</dt>
                    <dd>
                      <code>{selectedRun.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <Badge tone={selectedRun.status === "completed" ? "ok" : "warning"}>
                        {selectedRun.status}
                      </Badge>
                      {selectedRun.status === "partial"
                        ? " — one or more candidates produced no evaluation. Which ones is stated per candidate below."
                        : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Candidates compared</dt>
                    <dd>{selectedRun.candidate_catalog_keys.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Dataset</dt>
                    <dd>{selectedRun.dataset_version ?? selectedRun.question ?? "not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Commit</dt>
                    <dd>{selectedRun.commit_sha ?? "not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Ran</dt>
                    <dd>
                      {instant(selectedRun.started_at)} to {instant(selectedRun.completed_at)}
                    </dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {policies.state.kind === "loading" ? (
        <LoadingState label="Reading the model policies" />
      ) : policies.state.kind === "error" ? (
        <Refusal failure={policies.state.failure} onRetry={policies.retry} />
      ) : policies.state.kind === "empty" ? (
        <p>No model policy is configured.</p>
      ) : (
        <div className={styles.policies}>
          {policies.state.data.policies.map((policy) => {
            const evidence = policy.candidate_catalog_keys.map((key) =>
              candidateEvidence(key, observations[key], cells),
            );
            const isAttempted = attempted?.policyId === policy.policy_id;

            let outcome: ReactNode = null;
            if (isAttempted && confirm.state.kind === "error") {
              outcome = <Refusal failure={confirm.state.failure} />;
            } else if (isAttempted && confirm.state.kind === "saved") {
              outcome = (
                <Confirmation
                  policy={confirm.state.data}
                  submittedOrder={attempted.order}
                  citedRunIds={attempted.cited}
                  audit={
                    audit.state.kind === "ready" ? (audit.state.data.entries[0] ?? null) : null
                  }
                />
              );
            }

            return (
              <PolicyCard
                key={policy.policy_id}
                policy={policy}
                evidence={evidence}
                citedRunId={runId}
                busy={confirm.busy && isAttempted}
                onConfirm={onConfirm}
                outcome={outcome}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
