"use client";

/**
 * Compare the tiers, and change yours — one table, one action per tier, one place.
 *
 * **This used to be two interfaces.** A comparison table, and beneath it a separate *Change your
 * plan* list repeating every tier with its own button. Two competing places to do one thing, and
 * neither of them worked: `checkoutFor` answered `unavailable` for every paid tier because the
 * backend's `self_service` was false, so both lists rendered a disabled control with a tooltip.
 * The comparison and the change are now the same table — the tier headings carry the current
 * badge, the rows say what each allows, and the footer row carries the one button that acts.
 *
 * **What it can honestly claim.** Every figure is a configured allowance read from `GET /plans`;
 * the *Answers with* row is three rows deep in the database (plan → policy → catalog entry) and
 * resolved by the backend. Nothing here names a model, a vendor or a price. Changing tier goes
 * through `PUT /me/plan`, charges nothing, and says so.
 *
 * **What it still refuses to draw**, because none of it exists: a subscription id, a billing
 * interval, a next billing date, a payment method, *Download Invoices*, *Manage Payment
 * Information*. `docs/design/screens.md` §5 refuses all of it. Billing is one short card stating
 * plainly where things stand, which is a state the design accounts for rather than an omission.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Badge, Button, Card, CardBody, CardHeader, LoadingState } from "@/components/ui";
import type {
  PlanAllowanceView,
  PlanCode,
  PlanOfferView,
  PlansResponse,
  UsageResponse,
} from "@/lib/api/schema";
import {
  BILLING_NOTE,
  allowanceLabel,
  modelTierLabel,
  planActionLabel,
  planChangePrompt,
  planSelection,
  pricingPublished,
} from "@/lib/plan/commerce";
import { PLANS_KEY, USAGE_KEY, asPlanCode } from "@/lib/plan/usage";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";

import styles from "./plan.module.css";

/** Every allowance dimension any tier declares, in a stable order, so the table has rows. */
function dimensionsOf(plans: readonly PlanOfferView[]): readonly string[] {
  const seen = new Map<string, PlanAllowanceView>();
  for (const plan of plans) {
    for (const allowance of plan.allowances ?? []) {
      if (!seen.has(allowance.dimension)) seen.set(allowance.dimension, allowance);
    }
  }
  return [...seen.keys()].sort();
}

/**
 * One tier's figure for one dimension.
 *
 * A dimension a tier declares no row for is *unlimited*, not zero and not unknown — that is what
 * `PlanAllowanceView`'s own contract says of a null allowance, and rendering it as a dash would
 * make the most generous answer look like the least.
 */
function amountFor(plan: PlanOfferView, dimension: string): string {
  const allowance = (plan.allowances ?? []).find((entry) => entry.dimension === dimension);
  if (!allowance) return "Unlimited";
  if (allowance.allowance === null || allowance.allowance === undefined) return "Unlimited";
  const value = Number(allowance.allowance);
  if (!Number.isFinite(value)) return String(allowance.allowance);
  return value.toLocaleString("en-GB");
}

/**
 * The step between pressing *Choose Pro* and the tier actually changing.
 *
 * Not a safety rail — a plan change is instant, free and reversible. It is here because allowances
 * change *immediately*, and somebody moving down should read that before it happens rather than
 * infer it from a meter afterwards. Focus moves into the panel on open, so the sentence is
 * encountered rather than tabbed past.
 */
function ChangeConfirmation({
  plan,
  current,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly plan: PlanOfferView;
  readonly current: PlanOfferView | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  const prompt = planChangePrompt(plan, current);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div
      className={styles.confirm}
      role="group"
      aria-label={prompt.title}
      ref={panel}
      tabIndex={-1}
    >
      <p className={styles.confirmTitle}>{prompt.title}</p>
      {prompt.lines.map((line) => (
        <p className={styles.confirmLine} key={line}>
          {line}
        </p>
      ))}
      <div className={styles.confirmActions}>
        <Button size="sm" busy={busy} onClick={onConfirm}>
          Change to {plan.display_name}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function PlanComparison({ currentPlan }: { readonly currentPlan: string | null }): ReactNode {
  const { state } = useApiQuery<PlansResponse>({
    key: PLANS_KEY,
    request: (client) => client.plans(),
  });
  const [pending, setPending] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);

  const change = useApiMutation<PlanCode, UsageResponse>({
    run: (client, plan_code) => client.choosePlan({ plan_code }),
    // The screen's own read, so the tier, the allowances and every remaining figure above are
    // refetched from the backend rather than patched here. `/plans` too: a tier's *Current* badge
    // is drawn from the usage read, but the comparison is cached beside it and a stale pair is how
    // a screen ends up disagreeing with itself.
    invalidates: [USAGE_KEY, PLANS_KEY],
    onDone: (usage) => {
      // Named from what the backend returned, never from what was asked for.
      setChanged(usage.plan_name);
      setPending(null);
    },
  });

  const { reset } = change;
  const cancel = useCallback(() => {
    setPending(null);
    reset();
  }, [reset]);

  if (state.kind === "loading") return <LoadingState label="Reading the plans" lines={3} />;
  // The tiers failing to load costs the comparison and nothing else on this page.
  if (state.kind !== "ready") return null;

  const plans = state.data;
  const offered = [...(plans.plans ?? [])].sort((left, right) => left.rank - right.rank);
  if (offered.length === 0) return null;

  const dimensions = dimensionsOf(offered);
  const current = offered.find((plan) => plan.plan_code === currentPlan) ?? null;
  const chosen = pending === null ? null : (offered.find((p) => p.plan_code === pending) ?? null);

  return (
    <>
      <Card aria-labelledby="comparison">
        <CardHeader
          title="Compare plans"
          titleId="comparison"
          subtitle={
            pricingPublished()
              ? undefined
              : "Every figure is an allowance configured for that tier, not a published price list."
          }
        />
        <CardBody>
          <div className={styles.comparisonScroll}>
            <table className={styles.comparison}>
              <caption className={styles.comparisonCaption}>
                What each tier allows, by the dimensions Weathra counts, and how to move between
                them.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Allowance</th>
                  {offered.map((plan) => (
                    <th
                      scope="col"
                      key={plan.plan_code}
                      data-current={plan.plan_code === currentPlan || undefined}
                    >
                      <span className={styles.comparisonTier}>{plan.display_name}</span>
                      {plan.plan_code === currentPlan ? <Badge tone="ok">Current</Badge> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/*
                  The row that is not a number. Which model answers is the difference between the
                  tiers a bigger allowance cannot express, and it is three rows deep in the database
                  — plan → policy → catalog entry — resolved by `/plans` rather than asserted here.
                */}
                {offered.some((plan) => plan.model_tier) ? (
                  <tr>
                    <th scope="row">Answers with</th>
                    {offered.map((plan) => (
                      <td key={plan.plan_code}>{modelTierLabel(plan) ?? "—"}</td>
                    ))}
                  </tr>
                ) : null}
                {dimensions.map((dimension) => {
                  const sample = offered
                    .flatMap((plan) => plan.allowances ?? [])
                    .find((allowance) => allowance.dimension === dimension);
                  return (
                    <tr key={dimension}>
                      <th scope="row">{sample ? allowanceLabel(sample) : dimension}</th>
                      {offered.map((plan) => (
                        <td key={plan.plan_code}>{amountFor(plan, dimension)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Your plan</th>
                  {offered.map((plan) => {
                    const selection = planSelection(plan, plans, currentPlan);
                    const code = asPlanCode(plan.plan_code);
                    return (
                      <td key={plan.plan_code}>
                        {selection.kind === "current" || code === null ? (
                          <span className={styles.comparisonCurrent}>
                            {selection.kind === "current" ? "Current plan" : "—"}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={selection.kind === "unavailable" || change.busy}
                            title={
                              selection.kind === "unavailable" ? selection.reason : undefined
                            }
                            onClick={() => {
                              setChanged(null);
                              reset();
                              setPending(plan.plan_code);
                            }}
                          >
                            {planActionLabel(plan, plans, currentPlan)}
                          </Button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>

          {chosen === null ? null : (
            <ChangeConfirmation
              plan={chosen}
              current={current}
              busy={change.busy}
              onConfirm={() => {
                const code = asPlanCode(chosen.plan_code);
                if (code !== null) change.submit(code);
              }}
              onCancel={cancel}
            />
          )}

          {/*
            One live region for the whole interaction, so a change is announced once rather than
            once per state. Nothing claims success before the backend confirmed it: the name shown
            comes from the resolved response, not from what was asked for.

            Empty at rest, deliberately. The standing statement about charging is the Billing card
            below, and saying it here as well would be the same sentence twice on one screen.
          */}
          <p className={styles.changeStatus} role="status" data-tone={change.state.kind}>
            {change.state.kind === "saving"
              ? "Changing plan…"
              : change.state.kind === "error"
                ? `Could not change plan. ${change.state.failure.message}`
                : changed !== null
                  ? `Plan changed to ${changed}.`
                  : ""}
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="billing">
        <CardHeader title="Billing" titleId="billing" />
        <CardBody>
          {/*
            One short, true statement. The artifact's invoice list, payment method and billing
            history are not drawn here because none of them exists — see this file's header.
          */}
          <p className={styles.billingState}>{BILLING_NOTE}</p>
          <p className={styles.billingNote}>
            There is no payment method on this account, no subscription and no invoices. If billing
            is switched on, it will appear here before anything is ever charged.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
