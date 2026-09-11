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
 *
 * **Nothing it reads is trusted to be well-formed.** This screen is reached from a redirect that
 * carries an address in the query string, and it is the only unauthenticated screen that calls the
 * API — so the address, the response envelope, and every array inside it are treated as input from
 * outside. A person who has just created an account is the worst possible audience for an error
 * screen, and the way forward stays open through every one of these branches.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Badge, Button, ErrorState, LoadingState, Meter } from "@/components/ui";
import {
  continueLabel,
  planActionLabel,
  pricingPublished,
  selectionNotice,
  valueProposition,
} from "@/lib/plan/commerce";
import type { PlanAllowanceView, PlanOfferView, PlansResponse } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";
import { VERIFY_EMAIL_PATH } from "@/lib/routes";

import styles from "./auth.module.css";

/** Where a chosen tier is remembered until there is an account screen to ask about it. */
export const REQUESTED_PLAN_KEY = "weathra.requested-plan";

const DIMENSION_LABELS: Record<string, string> = {
  requests_per_day: "Requests",
  requests_per_month: "Requests",
  tokens_per_month: "Tokens",
  concurrent_runs: "Runs at once",
};

const WINDOW_LABELS: Record<string, string> = {
  day: "a day",
  month: "a month",
  concurrent: "at a time",
};

/**
 * The order the allowances read in, widest cadence first.
 *
 * Alphabetical order put "Runs at once" above the request counts, which buries the figure most
 * people are actually comparing. Anything the backend adds later that is not named here sorts
 * after these, alphabetically, so a new dimension appears rather than disappearing.
 */
const DIMENSION_ORDER = [
  "requests_per_day",
  "requests_per_month",
  "tokens_per_month",
  "concurrent_runs",
];

function rankOf(dimension: string): number {
  const at = DIMENSION_ORDER.indexOf(dimension);
  return at === -1 ? DIMENSION_ORDER.length : at;
}

function measureOf(allowance: PlanAllowanceView): string {
  return DIMENSION_LABELS[allowance.dimension] ?? allowance.dimension.replace(/_/g, " ");
}

function periodOf(allowance: PlanAllowanceView): string {
  return WINDOW_LABELS[allowance.window] ?? allowance.window;
}

/**
 * The bar's label: the measure and its window, unless the measure already carries the window.
 *
 * "Runs at once" over a `concurrent` window composed to "Runs at once at a time", which is what
 * production drew. Where the measure's own name states the cadence, the window is left off rather
 * than a second phrase for the same thing being appended to it.
 */
function meterLabel(allowance: PlanAllowanceView): string {
  const measure = measureOf(allowance);
  const period = periodOf(allowance);
  return measure.toLowerCase().endsWith("at once") ? measure : `${measure} ${period}`;
}

/** An allowance with no ceiling is genuinely unlimited, not zero and not unknown. */
function isUnlimited(allowance: PlanAllowanceView): boolean {
  return allowance.allowance === null || allowance.allowance === undefined;
}

function amountOf(allowance: PlanAllowanceView): string {
  return isUnlimited(allowance)
    ? "Unlimited"
    : Number(allowance.allowance).toLocaleString("en-GB");
}

export function allowanceLine(allowance: PlanAllowanceView): string {
  return `${measureOf(allowance)}: ${amountOf(allowance)} ${periodOf(allowance)}`;
}

/** Identifies an allowance across tiers, so the same row can be compared between cards. */
function keyOf(allowance: PlanAllowanceView): string {
  return `${allowance.dimension}-${allowance.window}`;
}

/**
 * The largest allowance each dimension reaches across the offered tiers.
 *
 * The bars are relative to *this*, not to an invented ceiling: Free's 25 requests a day drawn
 * against Premium's 1,000 is the comparison somebody is making when they look at three cards side
 * by side, and it is computed entirely from the rows the backend returned.
 */
function ceilings(plans: readonly PlanOfferView[]): ReadonlyMap<string, number> {
  const highest = new Map<string, number>();
  for (const plan of plans) {
    for (const allowance of allowancesOf(plan)) {
      if (isUnlimited(allowance)) continue;
      const value = Number(allowance.allowance);
      if (!Number.isFinite(value)) continue;
      const key = keyOf(allowance);
      highest.set(key, Math.max(highest.get(key) ?? 0, value));
    }
  }
  return highest;
}

/** The allowances of a tier, defended against a malformed envelope. */
function allowancesOf(plan: PlanOfferView): readonly PlanAllowanceView[] {
  return Array.isArray(plan.allowances) ? plan.allowances : [];
}

function PlanCard({
  plan,
  plans,
  isDefault,
  chosen,
  onChoose,
  highest,
}: {
  readonly plan: PlanOfferView;
  readonly plans: PlansResponse;
  readonly isDefault: boolean;
  readonly chosen: boolean;
  readonly onChoose: (code: string) => void;
  readonly highest: ReadonlyMap<string, number>;
}): ReactNode {
  const proposition = valueProposition(plan, plans);
  const actionLabel = planActionLabel(plan, plans);
  // Stated, not guessed: no price exists in the plans contract, so none is rendered.
  const pricingNote = pricingPublished()
    ? ""
    : "Pricing is not published yet. Selecting this charges nothing.";
  const allowances = [...allowancesOf(plan)].sort(
    (left, right) =>
      rankOf(left.dimension) - rankOf(right.dimension) ||
      left.dimension.localeCompare(right.dimension),
  );

  return (
    <li
      className={styles.planCard}
      data-plan={plan.plan_code}
      data-chosen={chosen ? "true" : undefined}
      data-default={isDefault ? "true" : undefined}
    >
      <div className={styles.planHead}>
        <h2 className={styles.planName}>{plan.display_name}</h2>
        {isDefault ? (
          <Badge tone="ok">Current plan</Badge>
        ) : chosen ? (
          <Badge tone="accent">Selected</Badge>
        ) : null}
      </div>

      {/* Derived from the allowances rather than written here — see `lib/plan/commerce`. */}
      <p className={styles.planValue}>{proposition}</p>

      {allowances.length === 0 ? (
        <p className={styles.planNote}>No allowance is configured for this tier, so nothing caps it.</p>
      ) : (
        <ul className={styles.planAllowances}>
          {allowances.map((allowance) => {
            const ceiling = highest.get(keyOf(allowance)) ?? 0;
            const unlimited = isUnlimited(allowance);
            const value = unlimited ? 1 : ceiling > 0 ? Number(allowance.allowance) / ceiling : null;

            return (
              <li key={keyOf(allowance)}>
                <Meter
                  label={meterLabel(allowance)}
                  value={Number.isFinite(value as number) ? value : null}
                  valueLabel={amountOf(allowance)}
                  unavailable={amountOf(allowance)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <Button
        size="sm"
        variant={chosen ? "primary" : "secondary"}
        onClick={() => onChoose(plan.plan_code)}
        aria-pressed={chosen}
        fullWidth
      >
        {chosen ? "Selected" : actionLabel}
      </Button>

      {isDefault ? (
        <p className={styles.planNote}>Every new account starts here. There is nothing to activate.</p>
      ) : (
        <p className={styles.planNote}>{pricingNote}</p>
      )}
    </li>
  );
}

/**
 * Whether the address in the query string is worth carrying to the next screen.
 *
 * Verify Email prefills from this parameter. A malformed one is not worth prefilling and is not
 * worth failing over either, so it is dropped and the next screen asks — which is exactly what it
 * does when the parameter is absent.
 */
export function usableEmail(raw: string | null): string {
  const email = (raw ?? "").trim();
  if (email === "" || email.length > 320) return "";
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : "";
}

export function PlanChoice(): ReactNode {
  // `useSearchParams` is non-null under the app router, but this screen is the one reached straight
  // from a redirect and nothing here needs the parameter badly enough to throw for it.
  const params = useSearchParams();
  const email = usableEmail(params?.get("email") ?? null);
  const [chosen, setChosen] = useState<string | null>(null);

  const plans = useApiQuery<PlansResponse>({
    key: ["plans"],
    request: (client) => client.plans(),
  });

  const onwards =
    email === "" ? VERIFY_EMAIL_PATH : `${VERIFY_EMAIL_PATH}?email=${encodeURIComponent(email)}`;

  const choose = (code: string): void => {
    setChosen(code);
    try {
      window.localStorage.setItem(REQUESTED_PLAN_KEY, code);
    } catch {
      // A browser that refuses storage loses the note and nothing else: no entitlement depends on
      // it, so there is nothing here worth failing the screen over.
    }
  };

  /** The way on, which every branch below keeps available. */
  const continueOn = (label: string): ReactNode => (
    <Link className={styles.planContinue} href={onwards}>
      <Button variant="primary">{label}</Button>
    </Link>
  );

  if (plans.state.kind === "loading") {
    return <LoadingState label="Reading the plans" lines={4} />;
  }
  if (plans.state.kind === "error") {
    // The tiers could not be read. The account exists either way, so the way forward stays open.
    return (
      <div className={styles.planFallback}>
        <ErrorState failure={plans.state.failure} onRetry={plans.retry} title="Plans unavailable" />
        {continueOn("Continue to verification")}
      </div>
    );
  }
  if (plans.state.kind !== "ready") return null;

  const envelope = plans.state.data as Partial<PlansResponse> | null;
  const offered = Array.isArray(envelope?.plans) ? envelope.plans : [];
  const defaultPlan = envelope?.default_plan ?? null;
  const note = envelope?.assignment_note ?? "";

  // A well-formed answer that offers nothing is not an error, and it is not a blank screen either.
  if (offered.length === 0) {
    return (
      <div className={styles.planFallback}>
        <p className={styles.planNote}>
          No tiers are published right now. Your account is already on Weathra&rsquo;s default plan,
          so there is nothing to choose and nothing to pay.
        </p>
        {continueOn("Continue to verification")}
      </div>
    );
  }

  const highest = ceilings(offered);
  const response = envelope as PlansResponse;
  const selected = offered.find((plan) => plan.plan_code === chosen) ?? null;
  // The truthful state after choosing a tier that cannot be bought yet. Null for the current plan,
  // and null again the day a payment provider makes `self_service` true.
  const notice = selected ? selectionNotice(selected, response) : null;

  return (
    <div className={styles.planStep}>
      <ul className={styles.planGrid}>
        {offered.map((plan) => (
          <PlanCard
            key={plan.plan_code}
            plan={plan}
            plans={response}
            isDefault={plan.plan_code === defaultPlan}
            chosen={chosen === plan.plan_code}
            onChoose={choose}
            highest={highest}
          />
        ))}
      </ul>

      {notice ? (
        <div className={styles.planNotice} role="status">
          <p className={styles.planNoticeTitle}>{notice.title}</p>
          <p className={styles.planNote}>{notice.detail}</p>
        </div>
      ) : null}

      {note === "" ? null : <p className={styles.planNote}>{note}</p>}

      {/* The step's one primary action, naming the tier the person picked. */}
      {continueOn(continueLabel(selected))}
    </div>
  );
}
