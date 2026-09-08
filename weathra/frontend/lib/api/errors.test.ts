/**
 * What a person may be shown when something is misconfigured — the guard, and why it exists.
 *
 * On 2026-09-08 production told a signed-in visitor, on the Analyst screen: "The inference provider
 * rejected the configured credential. Check OPENROUTER_API_KEY." An instruction they could not act
 * on, about a variable they should not have to know exists.
 *
 * The backend no longer composes that sentence. This tests the second line of defence, which exists
 * because this screen renders whatever it is handed: an older deployment still serving mid-rollout,
 * a provider whose own error text is forwarded, or code written later can all hand it one.
 */

import { describe, expect, it } from "vitest";

import { AGENT_UNAVAILABLE_FALLBACK, presentableMessage } from "./errors";

describe("presentableMessage", () => {
  it("passes a product sentence through unchanged", () => {
    const message = "Weather intelligence is temporarily unavailable. Forecasts are unaffected.";
    expect(presentableMessage(message)).toBe(message);
  });

  it("replaces the sentence production actually showed a signed-in visitor", () => {
    // Replaced whole rather than edited: a partially redacted sentence reads as a bug, and the
    // product has something better to say.
    const leaked =
      "The inference provider rejected the configured credential. Check OPENROUTER_API_KEY.";
    const shown = presentableMessage(leaked);
    expect(shown).not.toContain("OPENROUTER_API_KEY");
    expect(shown).toBe(AGENT_UNAVAILABLE_FALLBACK);
  });

  it.each([
    "Set SUPABASE_SERVICE_ROLE_KEY to enable this.",
    "DATABASE_URL_PRIVILEGED is not configured.",
    "Check the WEATHRA_RUNTIME_MODE environment variable.",
    "Set the env var and restart.",
  ])("replaces anything naming configuration: %s", (message) => {
    expect(presentableMessage(message)).toBe(AGENT_UNAVAILABLE_FALLBACK);
  });

  it("recognises the shape rather than a list of names, so a new variable is covered too", () => {
    expect(presentableMessage("SOME_FUTURE_SETTING_NAME is missing.")).toBe(
      AGENT_UNAVAILABLE_FALLBACK,
    );
  });

  it("does not mistake ordinary product words for configuration", () => {
    for (const message of [
      "Weathra could not reach the provider.",
      "The forecast for Berlin is unavailable right now.",
      "AI interpretation is unavailable; every figure below is retrieved or computed.",
    ]) {
      expect(presentableMessage(message)).toBe(message);
    }
  });

  it("falls back for an empty message rather than rendering nothing", () => {
    expect(presentableMessage("   ")).toBe(AGENT_UNAVAILABLE_FALLBACK);
  });

  it("takes a caller's own fallback when the screen has better words", () => {
    expect(presentableMessage("SOMETHING_IS_UNSET", "Not available.")).toBe("Not available.");
  });
});
