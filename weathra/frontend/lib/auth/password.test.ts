/**
 * The password rules.
 *
 * Pinned here because these are *recorded decisions* rather than something the specs fixed: the
 * numbers are mirrored in the Supabase project's own configuration (`docs/deployment.md`), and a
 * change made in one place and not the other produces the exact failure the rules exist to prevent
 * — a password accepted by this screen and then refused by the provider.
 */

import { describe, expect, it } from "vitest";

import {
  PASSWORD_MAXIMUM_LENGTH,
  PASSWORD_MINIMUM_LENGTH,
  PASSWORD_RULES,
  passwordFailureMessage,
  passwordMeetsRules,
  unmetPasswordRules,
} from "./password";

const GOOD = "correct-horse-battery-staple";

describe("the stated rules", () => {
  it("states a length floor and a ceiling, and nothing about composition", () => {
    expect(PASSWORD_MINIMUM_LENGTH).toBe(12);
    expect(PASSWORD_MAXIMUM_LENGTH).toBe(72);

    const labels = PASSWORD_RULES.map((rule) => rule.label);
    expect(labels).toEqual([
      "At least 12 characters",
      "No more than 72 characters",
      "Not your email address",
    ]);
    // No "must contain a symbol": composition rules buy little and cost usability.
    expect(labels.join(" ")).not.toMatch(/symbol|uppercase|digit|number/i);
  });

  it("names each rule in words a person can act on", () => {
    for (const rule of PASSWORD_RULES) {
      expect(rule.label.length).toBeGreaterThan(8);
      expect(rule.id).toMatch(/^[a-z-]+$/);
    }
  });
});

describe("the length rules", () => {
  it("accepts a password at the floor and refuses one below it", () => {
    expect(passwordMeetsRules("a".repeat(PASSWORD_MINIMUM_LENGTH))).toBe(true);
    expect(passwordMeetsRules("a".repeat(PASSWORD_MINIMUM_LENGTH - 1))).toBe(false);
  });

  it("accepts a password at the ceiling and refuses one above it", () => {
    expect(passwordMeetsRules("a".repeat(PASSWORD_MAXIMUM_LENGTH))).toBe(true);
    // Past this the provider's hash ignores the rest, so accepting it would use part of it.
    expect(passwordMeetsRules("a".repeat(PASSWORD_MAXIMUM_LENGTH + 1))).toBe(false);
  });

  it("refuses an empty password", () => {
    expect(passwordMeetsRules("")).toBe(false);
  });

  it("counts characters rather than words", () => {
    expect(passwordMeetsRules("short one")).toBe(false);
  });
});

describe("the not-your-address rule", () => {
  it("refuses a password containing the local part of the address", () => {
    expect(passwordMeetsRules("samantha-and-more", "samantha@example.test")).toBe(false);
  });

  it("ignores case when comparing", () => {
    expect(passwordMeetsRules("SAMANTHA-and-more", "samantha@example.test")).toBe(false);
  });

  it("refuses the address itself", () => {
    expect(passwordMeetsRules("samantha@example.test", "samantha@example.test")).toBe(false);
  });

  it("accepts an unrelated password of sufficient length", () => {
    expect(passwordMeetsRules(GOOD, "samantha@example.test")).toBe(true);
  });

  it("does not apply when there is no address to compare", () => {
    expect(passwordMeetsRules(GOOD)).toBe(true);
  });

  it("does not apply to a local part too short to mean anything", () => {
    // "ab" appearing inside a passphrase is a coincidence, not a reused address.
    expect(passwordMeetsRules("abstract-nonsense-here", "ab@example.test")).toBe(true);
  });
});

describe("naming the rule that failed", () => {
  it("names the length rule for a short password", () => {
    expect(passwordFailureMessage("short")).toContain("At least 12 characters");
  });

  it("names the address rule when that is the one unmet", () => {
    expect(passwordFailureMessage("samantha-and-more-here", "samantha@example.test")).toContain(
      "Not your email address",
    );
  });

  it("names one rule at a time, the first unmet", () => {
    // "samantha" is both too short and the local part of the address: two rules fail, one is said.
    const message = passwordFailureMessage("samantha", "samantha@example.test") ?? "";
    expect(message).toContain("At least 12 characters");
    expect(message).not.toContain("Not your email address");
  });

  it("says nothing for a password that meets every rule", () => {
    expect(passwordFailureMessage(GOOD, "samantha@example.test")).toBeUndefined();
  });

  it("reports the unmet rules in the order they are stated", () => {
    const unmet = unmetPasswordRules("samantha", "samantha@example.test").map((rule) => rule.id);
    expect(unmet).toEqual(["length", "not-email"]);
  });
});
