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
  resetPhrase,
  resetSchedule,
  type DimensionReading,
} from "@/lib/plan/usage";
import { useApiQuery } from "@/lib/query/hooks";

import { ActivityChart, deltaOf, peakOf, pointsOf, type Delta } from "./activity";
import { PlanComparison } from "./comparison";
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

/** Up, down or level — for colour only; the number beside it carries the meaning. */
function deltaTone(delta: Delta | null): "up" | "down" | "flat" {
  if (delta === null || delta.percent === null || delta.percent === 0) return "flat";
  return delta.percent > 0 ? "up" : "down";
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

/**
 * What the dimension counts, for the unit beside its figure.
 *
 * `10-plan-usage.png` prints "/ 10,000 REQ" and "/ 25,000,000 TOKENS", which is the artifact
 * telling a reader what the big number *is* before they read the label. Derived from the
 * dimension name rather than stored, because the backend's dimensions already say it —
 * `requests_per_day`, `tokens_per_month` — and a second source would be one to keep in step.
 */
function unitOf(dimension: string): string | null {
  if (dimension.startsWith("requests")) return "req";
  if (dimension.startsWith("tokens")) return "tokens";
  if (dimension.startsWith("concurrent")) return "at once";
  return null;
}

function Allowance({ reading }: { reading: DimensionReading }): ReactNode {
  const unit = unitOf(reading.dimension);
  return (
    <li className={styles.allowance}>
      <div className={styles.allowanceHead}>
        <span className={styles.allowanceName}>{reading.label}</span>
        {reading.exhausted ? (
          <Badge tone="quota">Exhausted</Badge>
        ) : reading.nearLimit ? (
          <Badge tone="warning">Nearly used</Badge>
        ) : null}
        {/* "Resets tomorrow", not "11 Sept, 00:00". The instant stays in the reset schedule below,
            which is where somebody who wants the exact turnover looks for it. */}
        <span className={styles.allowanceWindow}>
          {resetPhrase(reading.resetsAt) ?? reading.windowLabel}
        </span>
      </div>

      {reading.limited ? (
        <>
          {/*
            The artifact's allocation row: the consumed figure at metric size, its allowance and
            unit beside it, and the share right-aligned. It was one line of body text with the
            numbers in it — the same figures at a third of the prominence the artifact gives them,
            which is most of why this panel read as a list where the artifact reads as a meter.
          */}
          <p className={styles.allowanceReading}>
            <span className={styles.allowanceValue}>{count(reading.consumed)}</span>
            <span className={styles.allowanceOf}>
              / {count(reading.allowance)}
              {unit === null ? "" : ` ${unit}`}
            </span>
            <span className={styles.allowanceShare}>
              {reading.percentUsed === null ? "—" : `${reading.percentUsed}% used`}
            </span>
          </p>
          <Meter
            label={`${reading.label} used`}
            value={reading.percentUsed === null ? null : reading.percentUsed / 100}
          />
          <p className={styles.allowanceFoot}>
            <span>Consumed: {count(reading.consumed)}</span>
            <span>Remaining: {count(reading.remaining)}</span>
          </p>
        </>
      ) : (
        <p className={styles.allowanceReading}>
          <span className={styles.allowanceValue}>{count(reading.consumed)}</span>
          <span className={styles.allowanceOf}>
            {unit === null ? "used" : `${unit} used`} · unlimited on your plan
          </span>
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
  const points = pointsOf(usage.recent.series);
  const peak = peakOf(points);
  const delta = deltaOf(points);

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
              Every account starts on Free. Compare the plans below to see what each one allows.
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
              {/*
                The artifact's activity chart, over the series `/me/usage` now returns. What was
                here was these same three totals as a definition list — the right figures with
                none of the shape the artifact gives them.
              */}
              <ActivityChart points={points} days={usage.recent.days} />
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
              {/*
                The artifact's two derived tiles. Both are arithmetic over the series above and
                both state their basis: a peak with no day attached is a number rather than a
                fact, and a percentage with no window named is not checkable.
              */}
              <div className={styles.derived}>
                <div className={styles.derivedTile}>
                  <span className={styles.derivedLabel}>Peak day</span>
                  <span className={styles.derivedValue}>
                    {peak === null ? "—" : count(peak.calls)}
                  </span>
                  <span className={styles.derivedNote}>
                    {peak === null ? "No calls in this window" : peak.label}
                  </span>
                </div>
                <div className={styles.derivedTile}>
                  <span className={styles.derivedLabel}>Week on week</span>
                  <span className={styles.derivedValue} data-tone={deltaTone(delta)}>
                    {delta === null || delta.percent === null
                      ? "—"
                      : `${delta.percent >= 0 ? "+" : ""}${delta.percent.toFixed(1)}%`}
                  </span>
                  <span className={styles.derivedNote}>
                    {delta === null
                      ? "Needs two full weeks to compare"
                      : delta.percent === null
                        ? `${count(delta.recent)} this week, none the week before`
                        : `${count(delta.recent)} against ${count(delta.earlier)} the week before`}
                  </span>
                </div>
              </div>
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

      {/*
        Full width, under the usage bands. The commercial half of the account page — what the other
        tiers allow, how to move, and the truth about billing. It sat in the narrow right rail,
        where a four-column tier table had nowhere to go and clipped its last column; a comparison
        that cannot show the tier being compared to is not one. Its own component because every
        claim it makes goes through `lib/plan/commerce`, the seam a payment provider replaces.
      */}
      <PlanComparison currentPlan={usage.plan_code ?? null} />
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
