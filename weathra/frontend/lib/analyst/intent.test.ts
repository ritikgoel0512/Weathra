/**
 * The one decision three Analyst surfaces read — task 34.33.
 *
 * The answer body, the rail and the composer each used to decide separately whether a run had
 * answered, and the 2026-09-12 review caught them disagreeing about the same run: a status badge
 * reading COMPLETE beside a reply that had asked which place to look at, over two empty figure
 * panels. Deriving it once is the fix, so this is the suite that pins the derivation.
 */

import { describe, expect, it } from "vitest";

import type { AnswerEnvelope, Finding } from "@/lib/api/schema";
import { needsLocation, runIntentOf } from "./intent";

const SOURCE = {
  provider: "open-meteo",
  location: {
    display_name: "Berlin",
    latitude: 52.52,
    longitude: 13.405,
    timezone: "Europe/Berlin",
    country: "Germany",
  },
  data_class: "forecast",
  retrieved_at: "2026-09-04T06:15:00Z",
} as unknown as Finding["attribution"];

/** One figure, shaped as the backend sends it. Its content is irrelevant; its presence is not. */
const FIGURE = {
  label: "Highest temperature",
  value: 21.4,
  unit: "°C",
  data_class: "forecast",
  attribution: SOURCE,
} as unknown as Finding;

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  country: "Germany",
};

function envelope(over: Partial<AnswerEnvelope> = {}): AnswerEnvelope {
  return {
    request_id: "req-1",
    answer_prose: "",
    findings: [],
    attribution: [],
    grounding: { verified: true, method: "figure extraction", figures_checked: 0 },
    ...over,
  } as AnswerEnvelope;
}

describe("runIntentOf", () => {
  it("reads a run with prose as answered", () => {
    expect(runIntentOf(envelope({ answer_prose: "Mild through the weekend." })).kind).toBe(
      "answered",
    );
  });

  it("reads a run with figures and no prose as answered", () => {
    const answer = envelope({
      findings: [FIGURE],
    });
    expect(runIntentOf(answer).kind).toBe("answered");
  });

  it("asks for a place when nothing was named, resolved or saved", () => {
    const answer = envelope({
      clarification_question: "Which place should Weathra look at?",
      resolved: { locations: [], location_source: "none" },
    } as Partial<AnswerEnvelope>);

    expect(runIntentOf(answer)).toEqual({
      kind: "needs-location",
      question: "Which place should Weathra look at?",
    });
    expect(needsLocation(answer)).toBe(true);
  });

  it("asks for a place when the name was ambiguous, though the source reads request", () => {
    /*
      The case the first version of this got wrong. An ambiguous name resolves *from the request*
      and produces no location, so a test keyed on `location_source === "none"` classified it as
      some other kind of clarification and withheld the chooser — from the one clarification where
      pressing a candidate is the entire remedy.
    */
    const answer = envelope({
      clarification_question: "'Springfield' matches more than one place. Which did you mean?",
      resolved: { locations: [], location_source: "request" },
    } as Partial<AnswerEnvelope>);

    expect(runIntentOf(answer).kind).toBe("needs-location");
  });

  it("does not offer a place chooser for a clarification that already has a place", () => {
    const answer = envelope({
      clarification_question: "Which of the two weeks did you mean?",
      resolved: { locations: [BERLIN], location_source: "request" },
    } as Partial<AnswerEnvelope>);

    expect(runIntentOf(answer).kind).toBe("clarifying");
    expect(needsLocation(answer)).toBe(false);
  });

  it("treats a clarification that also produced figures as an answer", () => {
    /*
      A run that answered part of the question and asked about the rest has done work somebody paid
      an inference call for, and hiding it behind the conversational treatment would lose it.
    */
    const answer = envelope({
      clarification_question: "Which of the two weeks did you mean?",
      findings: [FIGURE],
      resolved: { locations: [], location_source: "none" },
    } as Partial<AnswerEnvelope>);

    expect(runIntentOf(answer).kind).toBe("answered");
  });

  it("ignores a clarification that is only whitespace", () => {
    expect(runIntentOf(envelope({ clarification_question: "   " })).kind).toBe("answered");
  });

  it("reports no location need for a run that never settled", () => {
    expect(needsLocation(null)).toBe(false);
  });
});
