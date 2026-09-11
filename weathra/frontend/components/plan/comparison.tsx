"use client";

/**
 * Plan comparison, upgrading, and the truth about billing — the account page's commercial half.
 *
 * `10-plan-usage.png` puts a tier's entitlements beside its usage, with *Compare all tiers* and
 * *Upgrade Plan* as the way out of the current one. Weathra can draw all three honestly: the tiers
 * and their allowances are rows in `subscription_plans` and `usage_limits`, read through
 * `GET /plans`, and the comparison is a table of figures rather than a list of promises.
 *
 * **What the artifact draws and this refuses.** A subscription id, a billing interval, a next
 * billing date, a payment method, *Download Invoices*, *Manage Payment Information*. None of them
 * exists: there is no payment integration, no subscription record and no invoice anywhere in
 * Weathra. Drawing them would be inventing a commercial relationship with the person reading the
 * page. So billing is one short card saying plainly where things stand — which is a state the
 * design accounts for, not an omission — and every claim about buying goes through
 * `lib/plan/commerce`, the same seam the signup step uses. When a payment provider is added, that
 * seam answers differently and this screen follows without being rewritten.
 *
 * The structure is deliberately the one a billed account needs: a current tier, a comparison, an
 * upgrade path, and a billing section. Manage subscription, downgrade, cancel, payment method and
 * billing history each have an obvious home here the day they exist, and none of them is implied
 * before then.
 */

import type { ReactNode } from "react";

import { Badge, Button, Card, CardBody, CardHeader, LoadingState } from "@/components/ui";
import type { PlanAllowanceView, PlanOfferView, PlansResponse } from "@/lib/api/schema";
import {
  allowanceLabel,
  checkoutFor,
  planActionLabel,
  pricingPublished,
  valueProposition,
} from "@/lib/plan/commerce";
import { useApiQuery } from "@/lib/query/hooks";

import styles from "./plan.module.css";

const PLANS_KEY = ["plans"] as const;

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

function amountFor(plan: PlanOfferView, dimension: string): string {
  const allowance = (plan.allowances ?? []).find((entry) => entry.dimension === dimension);
  if (!allowance) return "—";
  const value = Number(allowance.allowance);
  if (!Number.isFinite(value)) return String(allowance.allowance);
  return value.toLocaleString();
}

export function PlanComparison({ currentPlan }: { readonly currentPlan: string | null }): ReactNode {
  const { state } = useApiQuery<PlansResponse>({
    key: PLANS_KEY,
    request: (client) => client.plans(),
  });

  if (state.kind === "loading") return <LoadingState label="Reading the plans" lines={3} />;
  // The tiers failing to load costs the comparison and nothing else on this page.
  if (state.kind !== "ready") return null;

  const plans = state.data;
  const offered = [...(plans.plans ?? [])].sort((left, right) => left.rank - right.rank);
  if (offered.length === 0) return null;

  const dimensions = dimensionsOf(offered);

  return (
    <>
      <Card aria-labelledby="comparison">
        <CardHeader
          title="Compare plans"
          titleId="comparison"
          subtitle="Every figure is an allowance configured for that tier, not a published price list."
        />
        <CardBody>
          <div className={styles.comparisonScroll}>
            <table className={styles.comparison}>
              <caption className={styles.comparisonCaption}>
                What each tier allows, by the dimensions Weathra counts.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Allowance</th>
                  {offered.map((plan) => (
                    <th scope="col" key={plan.plan_code}>
                      <span className={styles.comparisonTier}>{plan.display_name}</span>
                      {plan.plan_code === currentPlan ? <Badge tone="ok">Current</Badge> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
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
            </table>
          </div>
        </CardBody>
      </Card>

      <Card aria-labelledby="upgrade">
        <CardHeader
          title="Change your plan"
          titleId="upgrade"
          subtitle={
            pricingPublished()
              ? undefined
              : "Pricing is not published yet, and choosing a tier charges nothing."
          }
        />
        <CardBody>
          <ul className={styles.upgradeList}>
            {offered.map((plan) => {
              const checkout = checkoutFor(plan, plans);
              const current = plan.plan_code === currentPlan;
              return (
                <li className={styles.upgradeRow} key={plan.plan_code} data-current={current || undefined}>
                  <div className={styles.upgradeText}>
                    <span className={styles.upgradeName}>
                      {plan.display_name}
                      {current ? <Badge tone="ok">Current</Badge> : null}
                    </span>
                    <span className={styles.upgradeValue}>{valueProposition(plan, plans)}</span>
                  </div>
                  {current ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={checkout.kind === "unavailable"}
                      title={checkout.kind === "unavailable" ? checkout.reason : undefined}
                    >
                      {planActionLabel(plan, plans)}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      <Card aria-labelledby="billing">
        <CardHeader title="Billing" titleId="billing" />
        <CardBody>
          {/*
            One short, true statement. The artifact's invoice list, payment method and billing
            history are not drawn here because none of them exists — see this file's header.
          */}
          <p className={styles.billingState}>
            Weathra is not billing you. There is no payment method on this account, no subscription
            and no invoices, because paid checkout is not enabled yet.
          </p>
          <p className={styles.billingNote}>
            Your plan&rsquo;s allowances apply as shown above. If billing is switched on, it will
            appear here before anything is ever charged.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
