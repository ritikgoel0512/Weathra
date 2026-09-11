/**
 * The two derived figures on Plan & Usage, held to their stated formulas.
 *
 * `10-plan-usage.png` draws a peak and a week-over-week delta beside its activity chart. Both are
 * arithmetic over the series `/me/usage` returns, which means both can be wrong in ways a
 * screenshot would never show — the cases that matter are the degenerate ones, and they are what
 * this file is about: a window with nothing in it, a first week with no week before it, and a
 * window too short to carry two weeks at all.
 */

import { describe, expect, it } from "vitest";

import type { UsageDay } from "@/lib/api/schema";

import { deltaOf, peakOf, pointsOf } from "./activity";

/** `n` days ending today, each with the calls the caller lists, oldest first. */
function series(calls: readonly number[]): UsageDay[] {
  return calls.map((count, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    calls: count,
    failures: 0,
    total_tokens: count === 0 ? null : count * 100,
  }));
}

describe("the peak day", () => {
  it("is the busiest day, and says which day it was", () => {
    const peak = peakOf(pointsOf(series([3, 11, 4])));
    expect(peak?.calls).toBe(11);
    // The label is the day, formatted — a peak with no date attached is a number, not a fact.
    expect(peak?.label).toMatch(/2/);
  });

  it("is absent rather than zero when nothing was called", () => {
    // A dense series of zeros is a real answer: the account made no calls. "Peak: 0" would read
    // as a measured maximum rather than as an idle window.
    expect(peakOf(pointsOf(series([0, 0, 0])))).toBeNull();
  });

  it("breaks a tie toward the earlier day, so the same series gives the same tile twice", () => {
    const peak = peakOf(pointsOf(series([5, 5])));
    expect(peak?.label).toBe(pointsOf(series([5, 5]))[0]!.label);
  });
});

describe("the week-on-week delta", () => {
  it("compares the last seven days against the seven before them", () => {
    // Earlier week 7 × 10 = 70; recent week 7 × 15 = 105. (105 − 70) / 70 = +50%.
    const delta = deltaOf(pointsOf(series([...Array(7).fill(10), ...Array(7).fill(15)])));
    expect(delta?.earlier).toBe(70);
    expect(delta?.recent).toBe(105);
    expect(delta?.percent).toBeCloseTo(50);
  });

  it("reports a fall as a negative proportion rather than an absolute", () => {
    const delta = deltaOf(pointsOf(series([...Array(7).fill(10), ...Array(7).fill(5)])));
    expect(delta?.percent).toBeCloseTo(-50);
  });

  it("has no percentage against a week that was empty, and says what it does have", () => {
    /*
     * The case a naive formula gets wrong. A first week of use divides by zero: reported as
     * infinity it is meaningless, and rounded to "+100%" it claims a measured doubling against a
     * week nothing happened in. Null, with both counts kept so the panel can state them instead.
     */
    const delta = deltaOf(pointsOf(series([...Array(7).fill(0), ...Array(7).fill(9)])));
    expect(delta?.percent).toBeNull();
    expect(delta?.earlier).toBe(0);
    expect(delta?.recent).toBe(63);
  });

  it("is absent when the window cannot hold two whole weeks", () => {
    // Thirteen days would compare a full week against a partial one, which overstates growth by
    // however much of the earlier week is missing.
    expect(deltaOf(pointsOf(series(Array(13).fill(4))))).toBeNull();
    expect(deltaOf(pointsOf(series(Array(14).fill(4))))).not.toBeNull();
  });
});

describe("the series a chart is drawn from", () => {
  it("survives a response that carries no series at all", () => {
    // The field is optional in the contract, so an older backend answers without it.
    expect(pointsOf(undefined)).toEqual([]);
    expect(peakOf(pointsOf(undefined))).toBeNull();
    expect(deltaOf(pointsOf(undefined))).toBeNull();
  });

  it("keeps every day, zeros included, because the window is dense", () => {
    // The backend fills the window; dropping the zeros here would put the gaps back.
    expect(pointsOf(series([0, 4, 0]))).toHaveLength(3);
  });
});
