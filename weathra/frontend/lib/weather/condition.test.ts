import { describe, expect, it } from "vitest";

import { conditionFor, isWet } from "./condition";

describe("the provider's condition code, translated", () => {
  it("reads the codes Open-Meteo publishes", () => {
    expect(conditionFor(0)?.label).toBe("Clear");
    expect(conditionFor(3)?.label).toBe("Overcast");
    expect(conditionFor(45)?.label).toBe("Fog");
    expect(conditionFor(61)?.label).toBe("Light rain");
    expect(conditionFor(65)?.label).toBe("Heavy rain");
    expect(conditionFor(71)?.label).toBe("Snow");
    expect(conditionFor(95)?.label).toBe("Thunderstorm");
  });

  it("says nothing for a code nobody reported", () => {
    // Inventing a label for an unreported or unrecognised number would be describing weather the
    // provider did not describe — the inference `specs/safety-grounding` forbids.
    expect(conditionFor(null)).toBeNull();
    expect(conditionFor(undefined)).toBeNull();
    expect(conditionFor(Number.NaN)).toBeNull();
    expect(conditionFor(4242)).toBeNull();
  });

  it("never invents severity on top of the code", () => {
    // 95 is the provider saying thunderstorm. It is not Weathra saying dangerous: the severity
    // referral lives in the backend's safety assessment and nowhere else.
    const storm = conditionFor(95)!;
    expect(storm.label).toBe("Thunderstorm");
    for (const forbidden of [/danger/i, /severe/i, /warning/i, /alert/i, /extreme/i]) {
      expect(storm.label).not.toMatch(forbidden);
    }
  });

  it("carries the code it was given, so a reader can check it", () => {
    expect(conditionFor(63)?.code).toBe(63);
  });

  it("knows which conditions are wet, for the screens that emphasise rain", () => {
    expect(isWet(conditionFor(61))).toBe(true);
    expect(isWet(conditionFor(95))).toBe(true);
    expect(isWet(conditionFor(0))).toBe(false);
    expect(isWet(conditionFor(71))).toBe(false);
    expect(isWet(null)).toBe(false);
  });
});
