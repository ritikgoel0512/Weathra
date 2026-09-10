"use client";

/**
 * Admin Model & AI Usage — the operational view of the model layer.
 *
 * Built against `docs/design/screens/09-admin-model-ai-usage.png`: the KPI row, the usage chart, the
 * model status table, the product/internal split and the errors panel. Every figure comes from
 * `GET /admin/usage`, which aggregates recorded usage events and returns measures rather than rows —
 * never a prompt, a completion or a subject — and from `GET /admin/models`, the catalog with the
 * latest recorded evaluation per entry.
 *
 * **The artifact's model rows are not Weathra's.** It draws four named vendor models across four
 * providers, and a comparison lab benching two versions of an in-house engine. Weathra reaches one
 * gateway, trains no model and versions none, and the vendor strings it does resolve live in the
 * catalog rather than in a component — a rule the backend asserts. What this table shows is
 * whatever `model_catalog` actually holds, rendered from the API and named nowhere in this file.
 *
 * **Also refused:** the reasoning-quality and cost-efficiency composites, because an invented
 * composite is the thing a model comparison exists to replace; the per-tier user headcounts against
 * user caps, which Weathra neither stores nor limits; the export and full-reliability-audit
 * controls, which have no endpoint; and the "all services operational" footer, which is a claim
 * made by a strip that checked nothing.
 *
 * Cost is labelled an estimate wherever it appears — priced from what the catalog said at the time
 * of each call, never a billed amount. `specs/web-ui` requires that, and so does the endpoint's own
 * description of the column.
 */

import { useId, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyChart,
  ErrorState,
  LoadingState,
  Meter,
  ScrollRegion,
  Select,
} from "@/components/ui";
import { isForbiddenCode } from "@/lib/api/errors";
import type { CatalogListResponse, UsageSummaryResponse } from "@/lib/api/schema";
import { MEASURE_LABELS, usageBars, usageTotals, windowLabel, type UsageMeasure } from "@/lib/admin/usage";
import { useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";

import styles from "./admin.module.css";

/** The groupings the endpoint supports, in the order an operator would reach for them. */
const GROUPINGS = [
  { value: "model", label: "By model" },
  { value: "provider", label: "By provider" },
  { value: "catalog_key", label: "By catalog entry" },
  { value: "policy", label: "By policy" },
  { value: "plan", label: "By plan" },
  { value: "call_role", label: "By call role" },
  { value: "status", label: "By outcome" },
] as const;

/** Periods within the endpoint's own bounds. Its default is thirty days, so that is the default. */
const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

const MEASURES: readonly UsageMeasure[] = ["calls", "tokens", "cost"];

const AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
} as const;

/**
 * A refusal, said as itself rather than as a failed request.
 *
 * Everything on this screen is administrative, so the interesting failure is not "the network went
 * away" but "you may not look at this" — and the difference matters at the control: a person
 * without the role who is offered *Try again* is being invited to repeat a question that has
 * already been answered. The policy panel below draws the same shape for the same reason.
 */
function Refusal({ failure, onRetry }: { readonly failure: ViewFailure; readonly onRetry?: () => void }): ReactNode {
  if (isForbiddenCode(failure.code)) {
    return (
      <div className={styles.refusal} role="alert">
        <Badge tone="error">Not permitted</Badge>
        <p>{failure.message}</p>
      </div>
    );
  }
  return (
    <ErrorState
      failure={failure}
      onRetry={failure.retryable ? onRetry : undefined}
      title="That did not load"
    />
  );
}

/**
 * An axis tick a reader can tell apart, for a label that is a gateway string.
 *
 * Two catalog entries from the same gateway share a vendor prefix and run to forty characters; on a
 * 700-pixel axis they draw as one run-on word. The prefix is the part every row shares, so the tick
 * drops it and the tooltip — and the table below — carry the whole string.
 */
export function tickLabel(label: string): string {
  const tail = label.includes("/") ? label.slice(label.indexOf("/") + 1) : label;
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail;
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : Math.round(value).toLocaleString("en-GB");
}

function Kpi({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}): ReactNode {
  return (
    <div className={styles.kpi}>
      <p className={styles.kpiLabel}>{label}</p>
      <p className={styles.kpiValue}>{value}</p>
      {note === undefined ? null : <p className={styles.kpiNote}>{note}</p>}
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  measure,
}: {
  active?: boolean;
  payload?: readonly { value?: number | null }[];
  label?: string | number;
  measure: UsageMeasure;
}): ReactNode {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      <p className={styles.tooltipValue}>
        {MEASURE_LABELS[measure]}:{" "}
        {typeof value === "number"
          ? measure === "cost"
            ? value.toFixed(4)
            : count(value)
          : "not reported"}
      </p>
    </div>
  );
}

function UsageChart({
  summary,
  measure,
}: {
  readonly summary: UsageSummaryResponse;
  readonly measure: UsageMeasure;
}): ReactNode {
  const described = useId();
  const bars = usageBars(summary.groups, measure).filter((bar) => bar.value !== null);
  const title = `${MEASURE_LABELS[measure]} by ${summary.grouped_by}`;

  if (bars.length === 0) {
    return (
      <EmptyChart
        title={title}
        reason={
          measure === "calls"
            ? "No calls were recorded in this period."
            : `The gateway reported no ${measure === "cost" ? "pricing" : "token usage"} for this period.`
        }
      />
    );
  }

  return (
    <figure className={styles.chart}>
      <div
        className={styles.chartPlot}
        role="img"
        aria-label={`${title}, ${bars.length} groups. The figures are in the table below.`}
        aria-describedby={described}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...bars]} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barCategoryGap={8}>
            <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="0" vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval={0} tickFormatter={tickLabel} />
            <YAxis {...AXIS} width={64} />
            <Tooltip
              cursor={{ fill: "var(--color-surface-raised)" }}
              content={<ChartTooltip measure={measure} />}
            />
            <Bar
              dataKey="value"
              name={MEASURE_LABELS[measure]}
              fill="var(--color-class-analytics)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className={styles.chartNote} id={described}>
        One bar per group that reported the figure. A group the gateway reported nothing for is
        absent from the chart and still present in the table, because absent is not zero.
      </figcaption>
    </figure>
  );
}

function CatalogPanel(): ReactNode {
  const catalog = useApiQuery<CatalogListResponse>({
    key: ["admin", "catalog"],
    request: (client) => client.adminCatalog(),
  });

  return (
    <Card aria-labelledby="admin-catalog">
      <CardHeader
        title="Model catalog"
        titleId="admin-catalog"
        headingLevel={3}
        subtitle="What Weathra may resolve, and what the lab last recorded about each."
      />
      <CardBody>
        {catalog.state.kind === "loading" ? (
          <LoadingState label="Reading the catalog" lines={3} />
        ) : catalog.state.kind === "error" ? (
          <Refusal failure={catalog.state.failure} onRetry={catalog.retry} />
        ) : catalog.state.kind !== "ready" ? null : catalog.state.data.entries.length === 0 ? (
          <p className={styles.quiet}>The catalog holds no entries.</p>
        ) : (
          <ScrollRegion label="Model catalog" className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">Gateway model</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Structured</th>
                  <th scope="col">Price class</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last evaluated</th>
                </tr>
              </thead>
              <tbody>
                {catalog.state.data.entries.map((entry) => {
                  const observed = catalog.state.kind === "ready"
                    ? catalog.state.data.observations?.[entry.catalog_key]
                    : undefined;
                  return (
                    <tr key={entry.catalog_key}>
                      <th scope="row" className={styles.wrapping}>
                        {entry.display_name}
                        <span className={styles.catalogKey}>{entry.catalog_key}</span>
                      </th>
                      <td className={`${styles.gateway} ${styles.wrapping}`}>
                        {entry.gateway_model}
                        <span className={styles.catalogKey}>{entry.gateway_provider}</span>
                      </td>
                      {/* Three role names is the longest cell in the row and the one that decided
                          whether the last column fitted. It wraps; the numbers do not. */}
                      <td className={styles.wrapping}>{entry.capability_roles.join(", ")}</td>
                      <td>{entry.capability_tier}</td>
                      <td>{entry.supports_structured_output ? "yes" : "no"}</td>
                      <td>{entry.is_free_tier ? "free tier" : "paid"}</td>
                      <td>
                        <Badge tone={entry.status === "enabled" ? "ok" : "neutral"}>
                          {entry.status}
                        </Badge>
                      </td>
                      <td>
                        {observed === undefined ? (
                          <span className={styles.quiet}>never</span>
                        ) : observed.passed === false ? (
                          <Badge tone="error">failed a gate</Badge>
                        ) : observed.passed === true ? (
                          <Badge tone="ok">passed</Badge>
                        ) : (
                          <span className={styles.quiet}>recorded, no verdict</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </CardBody>
    </Card>
  );
}

export function AdminOverview(): ReactNode {
  const [by, setBy] = useState<string>("model");
  const [days, setDays] = useState<string>("30");
  const [measure, setMeasure] = useState<UsageMeasure>("calls");

  const usage = useApiQuery<UsageSummaryResponse>({
    key: ["admin", "usage", by, days],
    request: (client) => client.adminUsage(by, Number(days)),
  });

  const summary = usage.state.kind === "ready" ? usage.state.data : null;
  const groups = summary?.groups ?? [];
  const totals = usageTotals(groups);
  const failing = groups.filter((group) => group.failures > 0);

  return (
    <section className={styles.overview} aria-label="Model and AI usage">
      <div className={styles.kpis}>
        <Kpi
          label="Model calls"
          value={summary === null ? "—" : count(totals.calls)}
          note={summary === null ? undefined : windowLabel(summary)}
        />
        <Kpi
          label="Tokens"
          value={totals.tokens === null ? "Not reported" : count(totals.tokens)}
          note={
            totals.tokens === null
              ? "the gateway reported none"
              : totals.reportingTokens < totals.groups
                ? `${totals.reportingTokens} of ${totals.groups} groups reported`
                : undefined
          }
        />
        <Kpi
          label="Estimated cost"
          value={totals.cost === null ? "Not reported" : totals.cost.toFixed(2)}
          note="an estimate, never a billed amount"
        />
        <Kpi
          label="Failure rate"
          value={totals.failureRate === null ? "—" : `${(totals.failureRate * 100).toFixed(2)}%`}
          note={`${count(totals.failures)} of ${count(totals.calls)} calls`}
        />
        <Kpi
          label="Slowest median"
          value={totals.slowestMedian === null ? "Not reported" : `${Math.round(totals.slowestMedian)} ms`}
          note="the highest per-group p50, not the estate's"
        />
      </div>

      <div className={styles.overviewBody}>
        <Card aria-labelledby="admin-usage">
          <CardHeader
            title="Usage and estimated cost"
            titleId="admin-usage"
            headingLevel={3}
            subtitle="Aggregated from recorded usage events: measures only, never a row and never a subject."
            actions={
              <div className={styles.controls}>
                <Select
                  label="Group by"
                  value={by}
                  onChange={(event) => setBy(event.target.value)}
                  options={GROUPINGS.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
                <Select
                  label="Period"
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  options={PERIODS.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
              </div>
            }
          />
          <CardBody>
            {usage.state.kind === "loading" ? (
              <LoadingState label="Reading recorded usage" lines={5} />
            ) : usage.state.kind === "error" ? (
              <Refusal failure={usage.state.failure} onRetry={usage.retry} />
            ) : summary === null ? null : groups.length === 0 ? (
              <p className={styles.quiet}>No usage was recorded in this period.</p>
            ) : (
              <>
                <div className={styles.measures} role="group" aria-label="What the chart draws">
                  {MEASURES.map((entry) => (
                    <Button
                      key={entry}
                      size="sm"
                      variant={entry === measure ? "primary" : "secondary"}
                      aria-pressed={entry === measure}
                      onClick={() => setMeasure(entry)}
                    >
                      {MEASURE_LABELS[entry]}
                    </Button>
                  ))}
                </div>

                <UsageChart summary={summary} measure={measure} />
              </>
            )}
          </CardBody>
        </Card>

        <div className={styles.overviewSide}>
          <Card aria-labelledby="admin-split">
            <CardHeader
              title="Product and internal"
              titleId="admin-split"
              headingLevel={3}
              subtitle="Internal traffic is accounted against the internal allowance, never a plan."
            />
            <CardBody>
              <dl className={styles.split}>
                <div>
                  <dt>Product calls</dt>
                  <dd>{summary === null ? "—" : count(totals.productCalls)}</dd>
                </div>
                <div>
                  <dt>Internal calls</dt>
                  <dd>{summary === null ? "—" : count(totals.internalCalls)}</dd>
                </div>
              </dl>
              <Meter
                label="Share of calls that are internal"
                value={totals.calls === 0 ? null : totals.internalCalls / totals.calls}
                unavailable="No calls in this period"
              />
            </CardBody>
          </Card>

          <Card aria-labelledby="admin-errors">
            <CardHeader title="Failures" titleId="admin-errors" headingLevel={3} />
            <CardBody>
              {summary === null ? (
                <p className={styles.quiet}>Not loaded.</p>
              ) : failing.length === 0 ? (
                <p className={styles.quiet}>
                  Nothing failed in this period. A failure here is a call the gateway did not
                  complete, not an answer somebody disagreed with.
                </p>
              ) : (
                <ul className={styles.failures}>
                  {failing.map((group) => (
                    <li key={`${group.group}-${group.is_internal}`}>
                      <span>{group.group ?? "not recorded"}</span>
                      <span>
                        {count(group.failures)} of {count(group.calls)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/*
        The figures the chart is drawn from, at full width — where the artifact puts its table too.
        It was inside the chart card, which is two thirds of a row, and a nine-column table in two
        thirds of a row scrolls at every width including the one the artifact is drawn at.
      */}
      {summary === null || groups.length === 0 ? null : (
        <Card aria-labelledby="admin-figures">
          <CardHeader
            title="The figures behind the chart"
            titleId="admin-figures"
            headingLevel={3}
            subtitle={`Grouped by ${summary.grouped_by.replace("_", " ")}, over ${windowLabel(summary)}.`}
          />
          <CardBody>
            <ScrollRegion label={`Usage grouped by ${summary.grouped_by}`} className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{summary.grouped_by.replace("_", " ")}</th>
                    <th scope="col">Traffic</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Failures</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Estimated cost</th>
                    <th scope="col">p50 ms</th>
                    <th scope="col">p95 ms</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={`${group.group}-${group.is_internal}`}>
                      <th scope="row" className={styles.wrapping}>
                        {group.group ?? "not recorded"}
                      </th>
                      <td>
                        <Badge tone={group.is_internal ? "accent" : "neutral"}>
                          {group.is_internal ? "internal" : "product"}
                        </Badge>
                      </td>
                      <td>{count(group.calls)}</td>
                      <td>{count(group.failures)}</td>
                      <td>{count(group.total_tokens)}</td>
                      <td>{group.estimated_cost_total ?? "—"}</td>
                      <td>{count(group.latency_p50_ms)}</td>
                      <td>{count(group.latency_p95_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </CardBody>
        </Card>
      )}

      <CatalogPanel />
    </section>
  );
}
