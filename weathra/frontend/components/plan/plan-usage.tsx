"use client";

/**
 * Plan & Usage — the signed-in person's own plan, allowances and consumption.
 *
 * Built against `docs/design/screens/10-plan-usage.png` for layout, hierarchy and finish: the tier
 * card, the metric tiles, the allocation bars, the reset schedule. What the artifact draws and
 * Weathra does not have is not here, and the list is long enough to be worth naming — a
 * subscription id, a billing interval, a next billing date, a payment method, "Manage Payment
 * Information", "Download Invoices", "Upgrade Plan", "Enterprise Authorized", vector storage nodes
 * with a cache to clear, API rate limiters, a usage export with per-user cost attribution, and a
 * status bar asserting encryption. `docs/design/screens.md` §5 already refuses all of it: this
 * change bills nobody, and drawing a card would be an invented commercial relationship.
 *
 * Every figure comes from `GET /me/usage`, which answers for the token subject and takes no
 * argument that could ask about anybody else. There is no other person's usage on this screen, no
 * internal usage where the caller is not internal, and no cross-user total — `specs/web-ui`
 * requires all three, and the endpoint's own shape is what makes them true.
 */

import type { ReactNode } from "react";

import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingState, Meter } from "@/components/ui";
import type { UsageResponse } from "@/lib/api/schema";
import {
  PLANS,
  headlineDimension,
  isInternal,
  pressuredDimensions,
  readDimension,
  resetSchedule,
  type DimensionReading,
} from "@/lib/plan/usage";
import { useApiQuery } from "@/lib/query/hooks";

import styles from "./plan.module.css";

const USAGE_KEY = ["me", "usage"] as const;

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-GB");
}

/** An instant, as a person reads it. Never a countdown: a ticking clock is not what makes it legible. */
function instant(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Tile({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
}): ReactNode {
  return (
    <div className={styles.tile}>
      <p className={styles.tileLabel}>{label}</p>
      <p className={styles.tileValue}>
        {value}
        {unit === undefined ? null : <span className={styles.tileUnit}>{unit}</span>}
      </p>
      {note === undefined ? null : <p className={styles.tileNote}>{note}</p>}
    </div>
  );
}

function Allowance({ reading }: { reading: DimensionReading }): ReactNode {
  return (
    <li className={styles.allowance}>
      <div className={styles.allowanceHead}>
        <span className={styles.allowanceName}>{reading.label}</span>
        {reading.exhausted ? (
          <Badge tone="quota">Exhausted</Badge>
        ) : reading.nearLimit ? (
          <Badge tone="warning">Nearly used</Badge>
        ) : null}
        <span className={styles.allowanceWindow}>{reading.windowLabel}</span>
      </div>

      {reading.limited ? (
        <>
          <p className={styles.allowanceFigures}>
            <strong>{count(reading.consumed)}</strong> of {count(reading.allowance)} used
            <span className={styles.allowanceRemaining}>{count(reading.remaining)} left</span>
          </p>
          <Meter
            label={`${reading.label} used`}
            value={reading.percentUsed === null ? null : reading.percentUsed / 100}
          />
        </>
      ) : (
        <p className={styles.allowanceFigures}>
          <strong>{count(reading.consumed)}</strong> used · Unlimited on your plan
        </p>
      )}
    </li>
  );
}

function Ready({ usage }: { usage: UsageResponse }): ReactNode {
  const dimensions = usage.dimensions.map(readDimension);
  const headline = headlineDimension(usage.dimensions);
  const resets = resetSchedule(usage.dimensions);
  const pressured = pressuredDimensions(usage.dimensions);
  const internal = isInternal(usage);

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1>Plan &amp; Usage</h1>
        <p className={styles.lede}>Your plan, what you have used, and when each allowance resets.</p>
      </header>

      <div className={styles.top}>
        <Card aria-labelledby="plan-card">
          <CardHeader
            title="Your plan"
            titleId="plan-card"
            badge={<Badge tone="accent">{usage.plan_name}</Badge>}
          />
          <CardBody>
            <ol className={styles.tiers}>
              {PLANS.map((plan) => {
                const active = plan.code === usage.plan_code;
                return (
                  <li key={plan.code} className={styles.tier} data-active={active || undefined}>
                    <span>{plan.name}</span>
                    {active ? <Badge tone="ok">Current</Badge> : null}
                  </li>
                );
              })}
            </ol>
            <p className={styles.planNote}>
              Plan changes are made by a Weathra administrator. There is no self-service checkout.
            </p>
            {internal ? (
              <p className={styles.planNote}>
                Your calls are accounted as internal usage, not against this plan&rsquo;s
                allowances.
              </p>
            ) : null}
          </CardBody>
        </Card>

        <div className={styles.tiles}>
          <Tile
            label="Requests used"
            value={count(headline?.consumed ?? null)}
            note={
              headline === null
                ? "No request allowance on your plan"
                : `of ${count(headline.allowance)} · ${headline.windowLabel.toLowerCase()}`
            }
          />
          <Tile
            label="Remaining"
            value={count(headline?.remaining ?? null)}
            note={headline === null ? "Unlimited" : `${headline.percentUsed ?? 0}% used`}
          />
          <Tile
            label="Tokens"
            value={count(usage.recent.total_tokens)}
            note={
              usage.recent.total_tokens === null || usage.recent.total_tokens === undefined
                ? "Not reported by the gateway"
                : `last ${usage.recent.days} days`
            }
          />
          <Tile
            label="Next reset"
            value={resets.length === 0 ? "—" : instant(resets[0]!.resetsAt)}
            note={resets.length === 0 ? "No windowed allowance" : resets[0]!.label}
          />
        </div>
      </div>

      {pressured.length > 0 ? (
        <div className={styles.pressure} role="status">
          <Badge tone="warning">Approaching a limit</Badge>
          <p>
            {pressured.map((reading) => reading.label).join(", ")} —{" "}
            {pressured.some((reading) => reading.exhausted)
              ? "an exhausted allowance is refused until it resets. Forecasts, history, analytics and comparison are unaffected."
              : "close to your plan's allowance for this window."}
          </p>
        </div>
      ) : null}

      <div className={styles.columns}>
        <Card aria-labelledby="allowances">
          <CardHeader
            title="Allowances"
            titleId="allowances"
            subtitle="What your plan permits, and what you have used in the current window."
          />
          <CardBody>
            {dimensions.length === 0 ? (
              <p>Your plan sets no allowances.</p>
            ) : (
              <ul className={styles.allowances}>
                {dimensions.map((reading) => (
                  <Allowance key={reading.dimension} reading={reading} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className={styles.side}>
          <Card aria-labelledby="recent">
            <CardHeader
              title="Recent activity"
              titleId="recent"
              subtitle={`Your last ${usage.recent.days} days.`}
            />
            <CardBody>
              <dl className={styles.facts}>
                <div>
                  <dt>Model calls</dt>
                  <dd>{count(usage.recent.calls)}</dd>
                </div>
                <div>
                  <dt>Failed</dt>
                  <dd>{count(usage.recent.failures)}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>{count(usage.recent.total_tokens)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card aria-labelledby="resets">
            <CardHeader title="Reset windows" titleId="resets" />
            <CardBody>
              {resets.length === 0 ? (
                <p>Nothing on your plan is counted over a window.</p>
              ) : (
                <ul className={styles.resets}>
                  {resets.map((reading) => (
                    <li key={reading.dimension}>
                      <span>{reading.label}</span>
                      <span className={styles.resetAt}>{instant(reading.resetsAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function PlanUsage(): ReactNode {
  const { state, retry } = useApiQuery<UsageResponse>({
    key: USAGE_KEY,
    request: (client) => client.usage(),
  });

  if (state.kind === "loading") return <LoadingState label="Reading your plan and usage" />;
  if (state.kind === "error")
    return <ErrorState failure={state.failure} onRetry={retry} title="Your plan is not available" />;
  if (state.kind === "empty") return <p>Your plan and usage are not available.</p>;

  return <Ready usage={state.data} />;
}
