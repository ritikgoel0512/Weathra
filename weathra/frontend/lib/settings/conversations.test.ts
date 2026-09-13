/**
 * How Settings reads its conversation list — the two presentational decisions in it.
 *
 * Neither touches retention, order or deletion: the backend owns all three. What is asserted here
 * is that the page opens compact, and that a stored instant is written as a date without being
 * converted out of the zone the backend reported it in.
 */

import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "@/lib/api/schema";

import { CONVERSATIONS_SHOWN, readableInstant, visibleConversations } from "./conversations";

function threads(count: number): ThreadSummary[] {
  return Array.from(
    { length: count },
    (_, index) => ({ id: `t-${index}` }) as unknown as ThreadSummary,
  );
}

describe("visibleConversations", () => {
  it("opens with a few rather than with everything", () => {
    expect(visibleConversations(threads(11), false)).toHaveLength(CONVERSATIONS_SHOWN);
  });

  it("shows all of them once expanded", () => {
    expect(visibleConversations(threads(11), true)).toHaveLength(11);
  });

  it("shows everything when there is less than a page of them", () => {
    expect(visibleConversations(threads(2), false)).toHaveLength(2);
  });
});

describe("readableInstant", () => {
  it("writes the backend's own UTC instant with the month as a word", () => {
    expect(readableInstant("2026-09-13T08:16:00Z")).toBe("13 Sept 2026, 08:16 UTC");
  });

  it("does not shift the instant into the reader's zone", () => {
    // Same moment, expressed with an offset. The hour shown is still the UTC one, because the
    // label says UTC — a converted figure under a UTC label would be the wrong time twice over.
    expect(readableInstant("2026-09-13T10:16:00+02:00")).toBe("13 Sept 2026, 08:16 UTC");
  });

  it("has nothing to say about nothing, or about a value it cannot read", () => {
    expect(readableInstant(null)).toBeNull();
    expect(readableInstant("not a date")).toBeNull();
  });
});
