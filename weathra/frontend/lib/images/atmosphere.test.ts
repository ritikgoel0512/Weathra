/**
 * The credential-free fallback, held to the four properties that make it usable.
 *
 * It is decorative, so there is nothing here about whether it looks right — that is a judgement
 * from a picture, and the picture is in `docs/city-imagery.md`. What is testable is the set of
 * guarantees the rest of the system leans on: it always answers, it answers the same way twice, it
 * answers differently for different places, and it stays inside the palette.
 */

import { describe, expect, it } from "vitest";

import { atmosphereFor } from "./atmosphere";

describe("the atmospheric fallback", () => {
  it("always produces an image, for any key at all", () => {
    // This is the tier that cannot fail: every other tier is allowed to, and this one catches them.
    for (const key of ["lisbon", "osaka", "", "x", "a-very-long-place-name-indeed", "123"]) {
      expect(atmosphereFor(key).url.startsWith("data:image/svg+xml"), key).toBe(true);
    }
  });

  it("draws the same key identically every time", () => {
    /*
     * The property the capture harness depends on. A drawing seeded from anything but the key —
     * the clock, `Math.random`, a module-level counter — would make every screenshot of every
     * screen with a hero band differ from the last, and none of them evidence.
     */
    expect(atmosphereFor("nairobi").url).toBe(atmosphereFor("nairobi").url);
    expect(atmosphereFor("nairobi").hue).toBe(atmosphereFor("nairobi").hue);
  });

  it("draws different keys differently", () => {
    // The whole reason this replaced a shared `generic.svg`. Sampled across a spread of real
    // places rather than two, because a generator can easily be distinct for two and not for ten.
    const places = [
      "lisbon",
      "osaka",
      "nairobi",
      "reykjavik",
      "sao-paulo",
      "cairo",
      "mumbai",
      "toronto",
      "wellington",
      "lima",
    ];
    const drawings = new Set(places.map((place) => atmosphereFor(place).url));
    expect(drawings.size).toBe(places.length);
  });

  it("stays inside the palette, so a wall of them reads as one set", () => {
    /*
     * A free-running hue is the obvious implementation and the wrong one: it eventually hands some
     * city a lime sky. The upper bound matters as much as the lower — the first version ran to 268
     * and the horizon glow came out hot pink on São Paulo.
     */
    for (let index = 0; index < 400; index += 1) {
      const { hue } = atmosphereFor(`place-${index}`);
      expect(hue, `place-${index}`).toBeGreaterThanOrEqual(196);
      expect(hue, `place-${index}`).toBeLessThanOrEqual(266);
    }
  });

  it("uses every hue in the palette across enough places", () => {
    // A hash that collapsed onto two or three hues would satisfy the bounds above and still look
    // like a mistake on a screen of saved locations.
    const hues = new Set(
      Array.from({ length: 400 }, (_, index) => atmosphereFor(`place-${index}`).hue),
    );
    expect(hues.size).toBe(8);
  });

  it("stays small enough to inline on every card of a list", () => {
    // A hero band and a dozen comparison cards may each carry one. Kept well under the point where
    // a data URI would be worth replacing with a request.
    for (const key of ["lisbon", "a-much-longer-place-name"]) {
      expect(atmosphereFor(key).url.length, key).toBeLessThan(40_000);
    }
  });

  it("encodes nothing about the weather", () => {
    /*
     * `specs/safety-grounding` draws a hard line at imagery implying a measurement. The drawing
     * takes a place key and nothing else — no temperature, no condition, no time of day — and this
     * asserts the signature rather than the output, because that is where the rule would break.
     */
    expect(atmosphereFor.length).toBe(1);
  });
});
