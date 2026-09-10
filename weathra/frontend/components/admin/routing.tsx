"use client";

/**
 * Model routing — which model a plan's call role actually resolves to, and how to change it.
 *
 * The architecture this renders is the one the backend already has and is not being replaced:
 *
 *     plan → call role → policy → ordered candidates → resolver, with a fallback policy
 *
 * A plan does not name a model. It names a *policy* per call role, and the policy holds an ordered
 * list of catalog keys; the resolver walks that list and takes the first entry that is enabled and
 * that the plan is entitled to. So "primary model" here is the first candidate of the policy the
 * plan maps that role to, and "fallback" is the first candidate of the policy that policy falls
 * back to — both read from the records rather than stored anywhere as a pair.
 *
 * **Every model name comes from `model_catalog`.** Nothing in this file names a vendor or a model,
 * and the artifact's four invented catalog rows and its two in-house engine versions appear
 * nowhere: the selectors are populated from `GET /admin/models`, so an estate with three models
 * offers three, and an entry that has been disabled says so instead of being silently offered.
 *
 * **What this screen refuses to do.** It does not reorder a policy's candidates — that is the
 * audited promotion the panel below it exists for, and it is gated on recorded comparison evidence
 * rather than on a dropdown. It changes the two things that are genuinely a mapping: which policy a
 * plan's role resolves to, and which policy a policy falls back to. Both are `PUT`s the backend
 * authorizes, validates and writes to `admin_audit`; neither can name a policy that does not exist.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LoadingState,
  Select,
} from "@/components/ui";
import { isForbiddenCode } from "@/lib/api/errors";
import type {
  CallRole,
  CatalogListResponse,
  PlanListResponse,
  PolicyListResponse,
} from "@/lib/api/schema";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";

import styles from "./admin.module.css";

const PLANS_KEY = ["admin", "plans"] as const;
const POLICIES_KEY = ["admin", "policies"] as const;

/**
 * The call roles, named as the product speaks of them.
 *
 * The values are the backend's own — a role is a column in every policy record — and the labels say
 * what each one is for, because "synthesis" is not what somebody administering the estate is
 * thinking about when they want to change the model behind the Analyst.
 */
const ROLES: readonly { readonly value: CallRole; readonly label: string }[] = [
  { value: "routing", label: "Routing — deciding which agents a question needs" },
  { value: "synthesis", label: "Synthesis — writing the answer over retrieved figures" },
  { value: "lab", label: "Lab — evaluation and comparison runs" },
];

function Refusal({ failure, onRetry }: { readonly failure: ViewFailure; readonly onRetry?: () => void }): ReactNode {
  if (isForbiddenCode(failure.code)) {
    return (
      <div className={styles.refusal} role="alert">
        <Badge tone="error">Not permitted</Badge>
        <p>{failure.message}</p>
      </div>
    );
  }
  return <ErrorState failure={failure} onRetry={failure.retryable ? onRetry : undefined} />;
}

export function ModelRouting(): ReactNode {
  const [planCode, setPlanCode] = useState<string>("free");
  const [role, setRole] = useState<CallRole>("synthesis");
  const [draftPolicy, setDraftPolicy] = useState<string | null>(null);
  const [draftFallback, setDraftFallback] = useState<string | null>(null);

  const plans = useApiQuery<PlanListResponse>({
    key: PLANS_KEY,
    request: (client) => client.adminPlans(),
  });
  const policies = useApiQuery<PolicyListResponse>({
    key: POLICIES_KEY,
    request: (client) => client.adminPolicies(),
  });
  const catalog = useApiQuery<CatalogListResponse>({
    key: ["admin", "catalog"],
    request: (client) => client.adminCatalog(),
  });

  const mapPlan = useApiMutation<{ plan: string; mapping: Record<string, string> }, unknown>({
    run: (client, input) => client.setPlanPolicies(input.plan, { policy_by_call_role: input.mapping }),
    invalidates: [PLANS_KEY, POLICIES_KEY],
  });

  const setFallback = useApiMutation<{ policy: string; fallback: string | null }, unknown>({
    run: (client, input) =>
      client.setPolicyFallback(input.policy, { fallback_policy_id: input.fallback }),
    invalidates: [POLICIES_KEY],
  });

  const planList = plans.state.kind === "ready" ? plans.state.data.plans : [];
  const policyList = policies.state.kind === "ready" ? policies.state.data.policies : [];
  const entries = catalog.state.kind === "ready" ? catalog.state.data.entries : [];

  const plan = planList.find((entry) => entry.plan_code === planCode) ?? planList[0] ?? null;
  const mappedPolicyId = plan?.policy_by_call_role?.[role] ?? null;
  const policyId = draftPolicy ?? mappedPolicyId;
  const policy = policyList.find((entry) => entry.policy_id === policyId) ?? null;
  const fallbackId = draftFallback ?? policy?.fallback_policy_id ?? "";
  const fallbackPolicy = policyList.find((entry) => entry.policy_id === fallbackId) ?? null;

  /** The first enabled candidate of a policy — what the resolver would actually reach for. */
  const resolvedOf = useMemo(
    () =>
      (candidates: readonly string[] | undefined): { key: string; enabled: boolean } | null => {
        for (const key of candidates ?? []) {
          const entry = entries.find((item) => item.catalog_key === key);
          if (entry && entry.status === "enabled") return { key, enabled: true };
        }
        const first = (candidates ?? [])[0];
        return first === undefined ? null : { key: first, enabled: false };
      },
    [entries],
  );

  const primary = resolvedOf(policy?.candidate_catalog_keys);
  const fallbackModel = resolvedOf(fallbackPolicy?.candidate_catalog_keys);

  const failure =
    plans.state.kind === "error"
      ? plans.state.failure
      : policies.state.kind === "error"
        ? policies.state.failure
        : catalog.state.kind === "error"
          ? catalog.state.failure
          : null;

  if (failure !== null) {
    return (
      <Card aria-labelledby="admin-routing">
        <CardHeader title="Model routing" titleId="admin-routing" headingLevel={3} />
        <CardBody>
          <Refusal failure={failure} onRetry={plans.retry} />
        </CardBody>
      </Card>
    );
  }

  const loading =
    plans.state.kind === "loading" ||
    policies.state.kind === "loading" ||
    catalog.state.kind === "loading";

  return (
    <Card aria-labelledby="admin-routing">
      <CardHeader
        title="Model routing"
        titleId="admin-routing"
        headingLevel={3}
        subtitle="Which policy a plan's call role resolves to, and which model that policy reaches first."
      />
      <CardBody>
        {loading ? (
          <LoadingState label="Reading plans, policies and the catalog" lines={4} />
        ) : (
          <>
            <div className={styles.routingControls}>
              <Select
                label="Plan"
                value={plan?.plan_code ?? ""}
                onChange={(event) => {
                  setPlanCode(event.target.value);
                  setDraftPolicy(null);
                  setDraftFallback(null);
                }}
                options={[...planList]
                  .sort((left, right) => left.rank - right.rank)
                  .map((entry) => ({ value: entry.plan_code, label: entry.display_name }))}
              />
              <Select
                label="Capability"
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as CallRole);
                  setDraftPolicy(null);
                  setDraftFallback(null);
                }}
                options={ROLES.map((entry) => ({ value: entry.value, label: entry.label }))}
              />
              <Select
                label="Policy"
                value={policyId ?? ""}
                onChange={(event) => setDraftPolicy(event.target.value)}
                options={policyList.map((entry) => ({
                  value: entry.policy_id,
                  label: `${entry.display_name} (${entry.eligibility})`,
                }))}
              />
              <Select
                label="Fallback policy"
                value={fallbackId}
                onChange={(event) => setDraftFallback(event.target.value)}
                options={[
                  { value: "", label: "None — refuse rather than fall back" },
                  ...policyList
                    .filter((entry) => entry.policy_id !== policyId)
                    .map((entry) => ({ value: entry.policy_id, label: entry.display_name })),
                ]}
              />
            </div>

            <dl className={styles.resolved}>
              <div>
                <dt>Primary model</dt>
                <dd>
                  {primary === null ? (
                    <span className={styles.quiet}>This policy lists no candidates.</span>
                  ) : (
                    <ModelFacts catalogKey={primary.key} entries={entries} reachable={primary.enabled} />
                  )}
                </dd>
              </div>
              <div>
                <dt>Fallback model</dt>
                <dd>
                  {fallbackModel === null ? (
                    <span className={styles.quiet}>No fallback policy.</span>
                  ) : (
                    <ModelFacts
                      catalogKey={fallbackModel.key}
                      entries={entries}
                      reachable={fallbackModel.enabled}
                    />
                  )}
                </dd>
              </div>
            </dl>

            <div className={styles.controls}>
              <Button
                variant="primary"
                size="sm"
                busy={mapPlan.busy}
                disabled={policyId === null || policyId === mappedPolicyId}
                onClick={() => {
                  if (plan === null || policyId === null) return;
                  mapPlan.submit({
                    plan: plan.plan_code,
                    // The whole mapping, with this role changed: the endpoint sets the map, so
                    // sending only the edited role would clear the others.
                    mapping: { ...(plan.policy_by_call_role ?? {}), [role]: policyId },
                  });
                }}
              >
                Point this capability at that policy
              </Button>
              <Button
                size="sm"
                busy={setFallback.busy}
                disabled={policy === null || fallbackId === (policy?.fallback_policy_id ?? "")}
                onClick={() => {
                  if (policy === null) return;
                  setFallback.submit({
                    policy: policy.policy_id,
                    fallback: fallbackId === "" ? null : fallbackId,
                  });
                }}
              >
                Set this policy&rsquo;s fallback
              </Button>
            </div>

            {mapPlan.state.kind === "error" ? <Refusal failure={mapPlan.state.failure} /> : null}
            {setFallback.state.kind === "error" ? (
              <Refusal failure={setFallback.state.failure} />
            ) : null}

            <p className={styles.quiet}>
              Changing the order of a policy&rsquo;s candidates is a different action and is not made
              from a dropdown: it is the audited promotion below, which cites the comparison run it
              rests on. This panel maps a capability to a policy and a policy to its fallback.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** One model, as the catalog holds it. No name is written here. */
function ModelFacts({
  catalogKey,
  entries,
  reachable,
}: {
  readonly catalogKey: string;
  readonly entries: CatalogListResponse["entries"];
  readonly reachable: boolean;
}): ReactNode {
  const entry = entries.find((item) => item.catalog_key === catalogKey);
  if (entry === undefined) {
    return (
      <span className={styles.quiet}>
        <code>{catalogKey}</code> is not in the catalog.
      </span>
    );
  }
  return (
    <div className={styles.modelFacts}>
      <span className={styles.modelName}>{entry.display_name}</span>
      <span className={styles.catalogKey}>
        {entry.gateway_model} · {entry.gateway_provider}
      </span>
      <span className={styles.modelBadges}>
        <Badge tone={entry.status === "enabled" ? "ok" : "error"}>{entry.status}</Badge>
        <Badge tone="neutral">{entry.is_free_tier ? "free tier" : "paid"}</Badge>
        <Badge tone="neutral">
          {entry.supports_structured_output ? "structured output" : "no structured output"}
        </Badge>
        <Badge tone="neutral">{entry.capability_tier}</Badge>
      </span>
      {reachable ? null : (
        <span className={styles.quiet}>
          Every candidate in this policy is disabled, so this one is listed first but would not be
          reached.
        </span>
      )}
    </div>
  );
}
