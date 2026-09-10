"use client";

/**
 * Choose your plan — the second step of creating an account.
 *
 * **Every figure on this screen is a row in the database.** The tiers, their order and their
 * allowances come from `GET /plans`, which reads `subscription_plans` and `usage_limits`. Nothing
 * here is a price list written into the frontend, and there is no fourth tier: the canonical three
 * are Free, Pro and Premium.
 *
 * **It does not sell anything, and it says so.** Weathra has no payment integration, no checkout
 * and no self-service upgrade — `PlansResponse.self_service` is the backend saying that in the
 * contract rather than this file assuming it. So Free is not "activated" here either: a new account
 * is on Free the moment it exists, with no row in `user_plans` at all, and a button claiming to
 * have enrolled somebody would be describing a write that never happened. What the screen does is
 * show what each tier allows and where the person already stands.
 *
 * Choosing Pro or Premium records a preference in this browser and nothing more. It is carried to
 * the account screen so somebody can say what they asked for; it changes no entitlement, and the
 * card says as much before it is pressed rather than after.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Badge, Button, ErrorState, LoadingState } from "@/components/ui";
import type { PlanAllowanceView, PlanOfferView, PlansResponse } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";
import { VERIFY_EMAIL_PATH } from "@/lib/routes";

import styles from "./auth.module.css";

/** Where a chosen tier is remembered until there is an account screen to ask about it. */
export const REQUESTED_PLAN_KEY = "weathra.requested-plan";

const DIMENSION_LABELS: Record<string, string> = {
  requests_per_day: "Requests",
  tokens_per_month: "Tokens",
  concurrent_runs: "Runs at once",
};

const WINDOW_LABELS: Record<string, string> = {
  day: "a day",
  month: "a month",
  concurrent: "at a time",
};

function allowanceLine(allowance: PlanAllowanceView): string {
  const measure = DIMENSION_LABELS[allowance.dimension] ?? allowance.dimension.replace(/_/g, " ");
  const period = WINDOW_LABELS[allowance.window] ?? allowance.window;
  const amount =
    allowance.allowance === null || allowance.allowance === undefined
      ? "Unlimited"
      : allowance.allowance.toLocaleString("en-GB");
  return `${measure}: ${amount} ${period}`;
}

function PlanCard({
  plan,
  isDefault,
  chosen,
  onChoose,
  selfService,
}: {
  readonly plan: PlanOfferView;
  readonly isDefault: boolean;
  readonly chosen: boolean;
  readonly onChoose: (code: string) => void;
  readonly selfService: boolean;
}): ReactNode {
  return (
    <li className={styles.planCard} data-plan={plan.plan_code} data-chosen={chosen ? "true" : undefined}>
      <div className={styles.planHead}>
        <h2 className={styles.planName}>{plan.display_name}</h2>
        {isDefault ? <Badge tone="ok">Your plan</Badge> : <Badge tone="neutral">On request</Badge>}
      </div>

      {plan.allowances.length === 0 ? (
        <p className={styles.planNote}>No allowance is configured for this tier, so nothing caps it.</p>
      ) : (
        <ul className={styles.planAllowances}>
          {[...plan.allowances]
            .sort((left, right) => left.dimension.localeCompare(right.dimension))
            .map((allowance) => (
              <li key={`${allowance.dimension}-${allowance.window}`}>{allowanceLine(allowance)}</li>
            ))}
        </ul>
      )}

      {isDefault ? (
        <p className={styles.planNote}>
          Every new account starts here. There is nothing to activate.
        </p>
      ) : selfService ? null : (
        <>
          <Button
            size="sm"
            variant={chosen ? "primary" : "secondary"}
            onClick={() => onChoose(plan.plan_code)}
            aria-pressed={chosen}
          >
            {chosen ? "Requested" : `Ask about ${plan.display_name}`}
          </Button>
          <p className={styles.planNote}>
            Noting your interest. It charges nothing and changes nothing until somebody at Weathra
            assigns the tier.
          </p>
        </>
      )}
    </li>
  );
}

export function PlanChoice(): ReactNode {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [chosen, setChosen] = useState<string | null>(null);

  const plans = useApiQuery<PlansResponse>({
    key: ["plans"],
    request: (client) => client.plans(),
  });

  const onwards = email === "" ? VERIFY_EMAIL_PATH : `${VERIFY_EMAIL_PATH}?email=${encodeURIComponent(email)}`;

  const choose = (code: string): void => {
    setChosen(code);
    try {
      window.localStorage.setItem(REQUESTED_PLAN_KEY, code);
    } catch {
      // A browser that refuses storage loses the note and nothing else: no entitlement depends on
      // it, so there is nothing here worth failing the screen over.
    }
  };

  if (plans.state.kind === "loading") {
    return <LoadingState label="Reading the plans" lines={4} />;
  }
  if (plans.state.kind === "error") {
    // The tiers could not be read. The account exists either way, so the way forward stays open.
    return (
      <div className={styles.planFallback}>
        <ErrorState failure={plans.state.failure} onRetry={plans.retry} title="Plans unavailable" />
        <Link className={styles.planContinue} href={onwards}>
          <Button variant="primary">Continue to verification</Button>
        </Link>
      </div>
    );
  }
  if (plans.state.kind !== "ready") return null;

  const { plans: offered, default_plan: defaultPlan, assignment_note: note, self_service } = plans.state.data;

  return (
    <div className={styles.planStep}>
      <ul className={styles.planGrid}>
        {offered.map((plan) => (
          <PlanCard
            key={plan.plan_code}
            plan={plan}
            isDefault={plan.plan_code === defaultPlan}
            chosen={chosen === plan.plan_code}
            onChoose={choose}
            selfService={self_service === true}
          />
        ))}
      </ul>

      <p className={styles.planNote}>{note}</p>

      <Link className={styles.planContinue} href={onwards}>
        <Button variant="primary">Continue</Button>
      </Link>
    </div>
  );
}
