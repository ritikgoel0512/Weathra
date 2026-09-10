/**
 * The admin usage arithmetic — task 34.18.
 *
 * Folded here rather than through the screen, because the rules being checked are about absence
 * and none of them is visible in markup: a total that must stay null, a median that must not be
 * averaged, a bar that must not be drawn at zero.
 */

import { describe, expect, it } from "vitest";

import type { UsageAggregate } from "@/lib/api/schema";
import { usageBars, usageTotals } from "./usage";

function group(over: Partial<UsageAggregate> = {}): UsageAggregate {
  return {
    group: "vendor/one",
    is_internal: false,
    calls: 10,
    failures: 0,
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    estimated_cost_total: "0.5000",
    latency_p50_ms: 400,
    latency_p95_ms: 900,
    ...over,
  };
}

describe("usageTotals", () => {
  it("sums calls and failures across every group", () => {
    const totals = usageTotals([group({ calls: 10, failures: 1 }), group({ calls: 5, failures: 2 })]);
    expect(totals.calls).toBe(15);
    expect(totals.failures).toBe(3);
    expect(totals.failureRate).toBeCloseTo(3 / 15);
  });

  it("reports no failure rate at all when nothing was called", () => {
    // 0% of nothing is not a fact about reliability, and drawing it as one would be a claim.
    expect(usageTotals([]).failureRate).toBeNull();
    expect(usageTotals([group({ calls: 0, failures: 0 })]).failureRate).toBeNull();
  });

  it("leaves an unreported token total null rather than summing it as zero", () => {
    const totals = usageTotals([group({ total_tokens: null }), group({ total_tokens: null })]);
    expect(totals.tokens).toBeNull();
    expect(totals.reportingTokens).toBe(0);
  });

  it("sums what was reported and counts the groups that reported it", () => {
    const totals = usageTotals([group({ total_tokens: 150 }), group({ total_tokens: null })]);
    expect(totals.tokens).toBe(150);
    expect(totals.reportingTokens).toBe(1);
    expect(totals.groups).toBe(2);
  });

  it("parses the decimal-string cost rather than adding it as text", () => {
    const totals = usageTotals([
      group({ estimated_cost_total: "0.5000" }),
      group({ estimated_cost_total: "1.2500" }),
    ]);
    expect(totals.cost).toBeCloseTo(1.75);
  });

  it("leaves cost null when no group carried a price", () => {
    expect(usageTotals([group({ estimated_cost_total: null })]).cost).toBeNull();
  });

  it("takes the highest per-group p50 rather than averaging medians", () => {
    // The mean of 400 and 1500 is 950, which is a number no request took.
    const totals = usageTotals([group({ latency_p50_ms: 400 }), group({ latency_p50_ms: 1500 })]);
    expect(totals.slowestMedian).toBe(1500);
  });

  it("splits internal traffic from product traffic without dropping either", () => {
    const totals = usageTotals([
      group({ calls: 10, is_internal: false }),
      group({ calls: 4, is_internal: true }),
    ]);
    expect(totals.productCalls).toBe(10);
    expect(totals.internalCalls).toBe(4);
    expect(totals.calls).toBe(14);
  });
});

describe("usageBars", () => {
  it("orders by the chosen measure, largest first", () => {
    const bars = usageBars(
      [group({ group: "a", calls: 3 }), group({ group: "b", calls: 9 })],
      "calls",
    );
    expect(bars.map((bar) => bar.label)).toEqual(["b", "a"]);
  });

  it("gives a group that reported nothing a null value, never a zero", () => {
    const bars = usageBars([group({ group: "quiet", total_tokens: null })], "tokens");
    expect(bars[0]?.value).toBeNull();
  });

  it("keeps the unreported groups last so the order stays readable", () => {
    const bars = usageBars(
      [
        group({ group: "quiet", total_tokens: null }),
        group({ group: "loud", total_tokens: 900 }),
      ],
      "tokens",
    );
    expect(bars.map((bar) => bar.label)).toEqual(["loud", "quiet"]);
  });

  it("names an unlabelled group rather than rendering an empty bar", () => {
    expect(usageBars([group({ group: null })], "calls")[0]?.label).toBe("not recorded");
  });
});
