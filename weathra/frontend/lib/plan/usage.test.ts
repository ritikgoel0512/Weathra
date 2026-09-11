/**
 * Reading a plan's allowances — the rules that decide what a figure *means*.
 *
 * Each of these is a way a usage screen lies without looking wrong: a null allowance rendered as
 * 0%, a null token count rendered as zero, a concurrency dimension given a reset date, a headline
 * that quietly followed whatever order the backend returned.
 */

import { describe, expect, it } from "vitest";

import type { DimensionView, UsageResponse } from "@/lib/api/schema";

import {
  NEAR_LIMIT,
  PLANS,
  dimensionLabel,
  headlineDimension,
  isInternal,
  pressuredDimensions,
  readDimension,
  resetPhrase,
  resetSchedule,
  windowLabel,
} from "./usage";

function dimension(overrides: Partial<DimensionView> = {}): DimensionView {
  return {
    dimension: "requests_per_day",
    window: "day",
    allowance: 30,
    consumed: 12,
    remaining: 18,
    resets_at: "2026-09-11T00:00:00Z",
    ...overrides,
  };
}

describe("the plans", () => {
  it("are the three canonical ones, in order, and never include plus", () => {
    expect(PLANS.map((plan) => plan.code)).toEqual(["free", "pro", "premium"]);
    expect(PLANS.map((plan) => plan.code)).not.toContain("plus");
  });
});

describe("naming", () => {
  it("derives a dimension's name from its identifier rather than a lookup", () => {
    // Derived, so a dimension the backend adds later reads as itself instead of vanishing behind a
    // map nobody updated.
    expect(dimensionLabel("requests_per_day")).toBe("Requests per day");
    expect(dimensionLabel("tokens_per_month")).toBe("Tokens per month");
    expect(dimensionLabel("some_future_dimension")).toBe("Some future dimension");
  });

  it("says what a window means", () => {
    expect(windowLabel("day")).toBe("Resets daily");
    expect(windowLabel("month")).toBe("Resets monthly");
    expect(windowLabel("concurrent")).toBe("At once");
    // An unknown window passes through rather than being guessed at.
    expect(windowLabel("fortnight")).toBe("fortnight");
  });
});

describe("a limited dimension", () => {
  it("reports its share used, its remainder and its window", () => {
    const reading = readDimension(dimension());
    expect(reading.limited).toBe(true);
    expect(reading.percentUsed).toBe(40);
    expect(reading.remaining).toBe(18);
    expect(reading.nearLimit).toBe(false);
    expect(reading.exhausted).toBe(false);
  });

  it("is near its limit at the threshold and exhausted at its allowance", () => {
    const near = readDimension(dimension({ consumed: Math.ceil(30 * NEAR_LIMIT) }));
    expect(near.nearLimit).toBe(true);
    expect(near.exhausted).toBe(false);

    const spent = readDimension(dimension({ consumed: 30, remaining: 0 }));
    expect(spent.exhausted).toBe(true);
    expect(spent.nearLimit).toBe(false);
  });

  it("caps the share at 100 rather than reporting more than an allowance", () => {
    // Consumption can exceed an allowance where a refusal raced a write; a 130% bar is a rendering
    // artefact rather than a fact worth showing.
    expect(readDimension(dimension({ consumed: 40 })).percentUsed).toBe(100);
  });
});

describe("an unlimited dimension", () => {
  const reading = readDimension(
    dimension({ allowance: null, remaining: null, resets_at: null, consumed: 900 }),
  );

  it("has no share, because a proportion of nothing is not a number", () => {
    expect(reading.limited).toBe(false);
    expect(reading.percentUsed).toBeNull();
  });

  it("is neither near a limit nor exhausted", () => {
    expect(reading.nearLimit).toBe(false);
    expect(reading.exhausted).toBe(false);
  });

  it("still reports what has been used", () => {
    expect(reading.consumed).toBe(900);
  });
});

describe("the headline", () => {
  it("prefers a requests dimension over whatever came first", () => {
    const chosen = headlineDimension([
      dimension({ dimension: "tokens_per_month", window: "month" }),
      dimension({ dimension: "requests_per_day" }),
    ]);
    expect(chosen?.dimension).toBe("requests_per_day");
  });

  it("falls back to the first limited dimension, and is null where none is limited", () => {
    expect(
      headlineDimension([dimension({ dimension: "tokens_per_month", allowance: 5 })])?.dimension,
    ).toBe("tokens_per_month");
    expect(headlineDimension([dimension({ allowance: null })])).toBeNull();
    expect(headlineDimension([])).toBeNull();
  });
});

describe("the reset schedule", () => {
  it("lists windowed dimensions soonest first", () => {
    const schedule = resetSchedule([
      dimension({ dimension: "tokens_per_month", resets_at: "2026-10-01T00:00:00Z" }),
      dimension({ dimension: "requests_per_day", resets_at: "2026-09-11T00:00:00Z" }),
    ]);
    expect(schedule.map((reading) => reading.dimension)).toEqual([
      "requests_per_day",
      "tokens_per_month",
    ]);
  });

  it("leaves out a dimension that does not turn over", () => {
    // Concurrency has no window: it falls as soon as a run finishes, which is not a date, and
    // inventing one would put a countdown on screen that means nothing.
    const schedule = resetSchedule([
      dimension({ dimension: "concurrent_runs", window: "concurrent", resets_at: null }),
    ]);
    expect(schedule).toEqual([]);
  });
});

describe("dimensions under pressure", () => {
  it("are the ones at or over their allowance, and normally none", () => {
    expect(pressuredDimensions([dimension()])).toEqual([]);
    expect(pressuredDimensions([dimension({ consumed: 29, remaining: 1 })])).toHaveLength(1);
    expect(pressuredDimensions([dimension({ consumed: 30, remaining: 0 })])).toHaveLength(1);
  });

  it("never include an unlimited dimension, however much it has been used", () => {
    expect(
      pressuredDimensions([dimension({ allowance: null, remaining: null, consumed: 10_000 })]),
    ).toEqual([]);
  });
});

describe("an internal account", () => {
  it("is recognised from the backend's own flag and nothing else", () => {
    const usage = { internal: true } as UsageResponse;
    expect(isInternal(usage)).toBe(true);
    expect(isInternal({} as UsageResponse)).toBe(false);
    expect(isInternal({ internal: false } as UsageResponse)).toBe(false);
  });
});

describe("when an allowance refills, in words", () => {
  const now = new Date("2026-09-10T09:00:00Z");

  it("answers the question a customer is actually asking", () => {
    // The account page listed `11 Sept, 00:00` beside every dimension — the exact turnover instant,
    // which is the shape of an operations console rather than an answer.
    expect(resetPhrase("2026-09-10T23:00:00Z", now)).toBe("Resets today");
    expect(resetPhrase("2026-09-11T00:00:00Z", now)).toBe("Resets tomorrow");
    expect(resetPhrase("2026-10-01T00:00:00Z", now)).toMatch(/^Resets .*Oct/);
  });

  it("names the weekday for something inside the week", () => {
    expect(resetPhrase("2026-09-13T00:00:00Z", now)).toMatch(/^Resets \w+day$/);
  });

  it("says nothing rather than guessing for a dimension with no window", () => {
    expect(resetPhrase(null, now)).toBeNull();
    expect(resetPhrase("not a date", now)).toBeNull();
  });
});
