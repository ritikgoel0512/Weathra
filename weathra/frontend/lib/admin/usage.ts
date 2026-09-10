/**
 * The arithmetic behind the admin usage dashboard, kept out of the component so it can be checked
 * against figures rather than against markup.
 *
 * `GET /admin/usage` returns one entry per (group, internal) pair for a period. Everything the
 * screen shows above the table is a fold over those entries, and each fold has one rule that
 * matters more than the sum itself:
 *
 * * **Absent is not zero.** `total_tokens` and `estimated_cost_total` are nullable — the gateway
 *   does not always report usage, and a call priced before the catalog knew a price has no cost.
 *   Summing nulls as zeros would draw a total that reads as "cheap" when it means "unknown", so a
 *   total is `null` unless at least one group reported the figure, and the count of groups that
 *   did is carried alongside it so the screen can say so.
 * * **A median of medians is not a median.** There is no way to recover a true p50 from per-group
 *   p50s, so the highest one is reported as exactly that rather than averaged into a number with
 *   no definition.
 * * **Internal traffic is separate, not excluded.** An administrator's own product-path call is
 *   accounted against the internal allowance and never against a plan (design.md decision 25), so
 *   the split is shown rather than folded away — but the estate totals include both, because the
 *   gateway billed both.
 */

import type { UsageAggregate, UsageSummaryResponse } from "@/lib/api/schema";

/** What a bar chart of the groups can be drawn from. */
export type UsageMeasure = "calls" | "tokens" | "cost";

export const MEASURE_LABELS: Record<UsageMeasure, string> = {
  calls: "Calls",
  tokens: "Tokens",
  cost: "Estimated cost",
};

export interface UsageTotals {
  readonly calls: number;
  readonly failures: number;
  /** Null when no group reported token usage at all. */
  readonly tokens: number | null;
  /** Null when no group carried a price. Always an estimate. */
  readonly cost: number | null;
  /** The highest per-group p50, which is not the estate's median and is not labelled as one. */
  readonly slowestMedian: number | null;
  /** Null rather than 0 when nothing was called, because 0% failure of nothing is not a fact. */
  readonly failureRate: number | null;
  readonly internalCalls: number;
  readonly productCalls: number;
  /** How many of the groups reported tokens and cost, so the screen can qualify a partial total. */
  readonly reportingTokens: number;
  readonly reportingCost: number;
  readonly groups: number;
}

function known(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Estimated cost arrives as a decimal string, so it is parsed once and never with `+`. */
export function costOf(group: UsageAggregate): number | null {
  const raw = group.estimated_cost_total;
  if (raw === null || raw === undefined) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function usageTotals(groups: readonly UsageAggregate[]): UsageTotals {
  let calls = 0;
  let failures = 0;
  let tokens = 0;
  let cost = 0;
  let reportingTokens = 0;
  let reportingCost = 0;
  let internalCalls = 0;
  let slowestMedian: number | null = null;

  for (const group of groups) {
    calls += group.calls;
    failures += group.failures;
    if (group.is_internal) internalCalls += group.calls;

    if (known(group.total_tokens)) {
      tokens += group.total_tokens;
      reportingTokens += 1;
    }
    const groupCost = costOf(group);
    if (groupCost !== null) {
      cost += groupCost;
      reportingCost += 1;
    }
    if (known(group.latency_p50_ms)) {
      slowestMedian = slowestMedian === null ? group.latency_p50_ms : Math.max(slowestMedian, group.latency_p50_ms);
    }
  }

  return {
    calls,
    failures,
    tokens: reportingTokens > 0 ? tokens : null,
    cost: reportingCost > 0 ? cost : null,
    slowestMedian,
    failureRate: calls === 0 ? null : failures / calls,
    internalCalls,
    productCalls: calls - internalCalls,
    reportingTokens,
    reportingCost,
    groups: groups.length,
  };
}

export interface UsageBar {
  readonly label: string;
  readonly internal: boolean;
  /** Null where this group did not report the chosen measure. The bar is then absent, not zero. */
  readonly value: number | null;
}

/**
 * The groups as bars, largest first, with the ones that reported nothing kept at the end rather
 * than dropped: a model that reported no tokens is a fact about the model, and removing its row
 * would make the chart disagree with the table under it.
 */
export function usageBars(
  groups: readonly UsageAggregate[],
  measure: UsageMeasure,
): readonly UsageBar[] {
  const bars = groups.map((group) => ({
    label: group.group ?? "not recorded",
    internal: group.is_internal,
    value:
      measure === "calls"
        ? group.calls
        : measure === "tokens"
          ? known(group.total_tokens)
            ? group.total_tokens
            : null
          : costOf(group),
  }));

  return [...bars].sort((left, right) => {
    if (left.value === null && right.value === null) return left.label.localeCompare(right.label);
    if (left.value === null) return 1;
    if (right.value === null) return -1;
    return right.value - left.value;
  });
}

/** "10 Aug – 9 Sep", so the period a figure covers is stated rather than implied by a control. */
export function windowLabel(summary: UsageSummaryResponse): string {
  const format = (value: string): string => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  return `${format(summary.window.start)} – ${format(summary.window.end)}`;
}
