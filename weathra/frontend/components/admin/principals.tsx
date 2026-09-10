"use client";

/**
 * Plan management — who is on which tier, and how to move them.
 *
 * **A role and a tier are different things, and this panel is where that is most visible.** Holding
 * the administrative role says what a principal may *do*; a plan says what the product owes them.
 * Weathra's own product owner is both, and neither implies the other: an administrator on Free is a
 * perfectly coherent state, and this screen renders it as one rather than quietly promoting anybody.
 *
 * **What is listed is a subject and a tier**, because that is all there is. `specs/authentication`
 * keeps every email, name and contact detail in Supabase Auth and references a person only by their
 * authentication subject, so this is not a personal-data listing with the personal data stripped
 * out — there is none in this database to strip. An administrator identifies somebody by the
 * subject they already have.
 *
 * Every assignment goes through `PUT /admin/principals/{subject}/plan`, which the backend writes to
 * `admin_audit` in the same transaction. `user_plans` grants the request-serving role `SELECT` and
 * nothing else, so nobody can assign themselves a tier however this screen is driven — the panel is
 * a way of asking, not a way of writing.
 */

import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LoadingState,
  ScrollRegion,
  Select,
} from "@/components/ui";
import { isForbiddenCode } from "@/lib/api/errors";
import type { PlanCode, PlanListResponse, PrincipalListResponse } from "@/lib/api/schema";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";

import styles from "./admin.module.css";

const PRINCIPALS_KEY = ["admin", "principals"] as const;

/** The canonical tiers. There is no other one, and there is deliberately no free-text entry. */
const TIERS: readonly PlanCode[] = ["free", "pro", "premium"];

function when(value: string | null | undefined): string {
  if (!value) return "never assigned";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

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

export function PrincipalPlans(): ReactNode {
  const [pending, setPending] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const principals = useApiQuery<PrincipalListResponse>({
    key: PRINCIPALS_KEY,
    request: (client) => client.adminPrincipals(100),
  });
  const plans = useApiQuery<PlanListResponse>({
    key: ["admin", "plans"],
    request: (client) => client.adminPlans(),
  });

  const assign = useApiMutation<{ subject: string; plan: string }, unknown>({
    run: (client, input) => client.assignPlan(input.subject, { plan_code: input.plan as PlanCode }),
    invalidates: [PRINCIPALS_KEY, ["me"], ["me", "usage"]],
    onDone: () => setActing(null),
  });

  // The tiers the backend actually holds, in its own rank order, falling back to the canonical
  // three before the plan list has loaded. Never a name typed into this file.
  const available =
    plans.state.kind === "ready"
      ? [...plans.state.data.plans].sort((left, right) => left.rank - right.rank)
      : TIERS.map((code) => ({ plan_code: code, display_name: code, rank: 0 }));

  return (
    <Card aria-labelledby="admin-principals">
      <CardHeader
        title="Plans and principals"
        titleId="admin-principals"
        headingLevel={3}
        subtitle="Who is on which tier. A subject and a tier — Weathra stores no contact detail."
      />
      <CardBody>
        {principals.state.kind === "loading" ? (
          <LoadingState label="Reading the principals" lines={4} />
        ) : principals.state.kind === "error" ? (
          <Refusal failure={principals.state.failure} onRetry={principals.retry} />
        ) : principals.state.kind !== "ready" ? null : principals.state.data.principals.length === 0 ? (
          <p className={styles.quiet}>Nobody has signed in yet, so there is no profile to show.</p>
        ) : (
          <>
            {assign.state.kind === "error" ? (
              <Refusal failure={assign.state.failure} />
            ) : null}
            <ScrollRegion label="Principals and their plans" className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Subject</th>
                    <th scope="col">Role</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Assigned</th>
                    <th scope="col">Change plan</th>
                  </tr>
                </thead>
                <tbody>
                  {principals.state.data.principals.map((entry) => {
                    const chosen = pending[entry.subject_id] ?? entry.plan_code ?? "free";
                    const busy = assign.busy && acting === entry.subject_id;
                    return (
                      <tr key={entry.subject_id}>
                        <th scope="row" className={styles.wrapping}>
                          <span className={styles.catalogKey}>{entry.subject_id}</span>
                        </th>
                        <td>
                          {entry.administrative ? (
                            <Badge tone="accent">administrator</Badge>
                          ) : (
                            <span className={styles.quiet}>—</span>
                          )}
                        </td>
                        <td>
                          {entry.plan_code ? (
                            <Badge tone={entry.plan_code === "premium" ? "ok" : "neutral"}>
                              {entry.plan_name ?? entry.plan_code}
                            </Badge>
                          ) : (
                            <span className={styles.quiet}>none assigned</span>
                          )}
                        </td>
                        <td>{when(entry.assigned_at)}</td>
                        <td>
                          <div className={styles.controls}>
                            {/* "Plan", not "Plan for <subject>": the column heading and the row's
                                own header already say which principal this is, and a 36-character
                                UUID repeated as a field label is noise rather than context. */}
                            <Select
                              label="Plan"
                              value={chosen}
                              onChange={(event) =>
                                setPending((current) => ({
                                  ...current,
                                  [entry.subject_id]: event.target.value,
                                }))
                              }
                              options={available.map((plan) => ({
                                value: plan.plan_code,
                                label: plan.display_name,
                              }))}
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              busy={busy}
                              disabled={chosen === entry.plan_code}
                              onClick={() => {
                                setActing(entry.subject_id);
                                assign.submit({ subject: entry.subject_id, plan: chosen });
                              }}
                            >
                              {busy ? "Assigning…" : "Assign"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollRegion>
            <p className={styles.quiet}>
              A plan is an entitlement; the administrative role is an authorization. Changing one
              here never changes the other, and every assignment is recorded against the
              administrator who made it.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
