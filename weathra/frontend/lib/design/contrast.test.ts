/**
 * The contrast arithmetic, checked against values WCAG itself fixes.
 *
 * If this maths is wrong, every assertion in `tokens.test.ts` is wrong in the same direction and
 * the palette ships unreadable while the suite stays green. So the extremes and one mid-grey are
 * pinned here against numbers that do not depend on Weathra's palette at all.
 */

import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  hueDegrees,
  hueSeparation,
  parseHex,
  relativeLuminance,
  roundRatio,
} from "./contrast";

describe("parseHex", () => {
  it("reads the three channels", () => {
    expect(parseHex("#22d3ee")).toEqual({ red: 0x22, green: 0xd3, blue: 0xee });
  });

  it("accepts upper case and surrounding space", () => {
    expect(parseHex("  #FFFFFF ")).toEqual({ red: 255, green: 255, blue: 255 });
  });

  it.each(["#fff", "#22d3eeff", "rgb(0 0 0)", "", "#gggggg"])("refuses %s", (value) => {
    expect(() => parseHex(value)).toThrow(/six-digit hex/);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("matches the WCAG value for mid grey", () => {
    // #808080 is the canonical worked example: 0.2159 to four places.
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 4);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(roundRatio(contrastRatio("#000000", "#ffffff"))).toBe(21);
  });

  it("is 1:1 for a colour against itself", () => {
    expect(roundRatio(contrastRatio("#22d3ee", "#22d3ee"))).toBe(1);
  });

  it("does not depend on the order of its arguments", () => {
    expect(contrastRatio("#0b141d", "#f4f7fa")).toBe(contrastRatio("#f4f7fa", "#0b141d"));
  });

  it("matches the published ratio for a known pair", () => {
    // #767676 on white is WCAG's borderline example for body text: 4.54:1.
    expect(roundRatio(contrastRatio("#767676", "#ffffff"))).toBeCloseTo(4.54, 2);
  });
});

describe("hue", () => {
  it("places the primaries where a colour wheel does", () => {
    expect(hueDegrees("#ff0000")).toBeCloseTo(0, 5);
    expect(hueDegrees("#00ff00")).toBeCloseTo(120, 5);
    expect(hueDegrees("#0000ff")).toBeCloseTo(240, 5);
  });

  it("gives grey no hue", () => {
    expect(hueDegrees("#808080")).toBe(0);
  });

  it("takes the shorter way round the wheel", () => {
    // 350 degrees apart the long way is 10 degrees apart the short way.
    expect(hueSeparation("#ff0000", "#ff0044")).toBeLessThan(20);
    expect(hueSeparation("#ff0000", "#00ffff")).toBeCloseTo(180, 5);
  });
});
