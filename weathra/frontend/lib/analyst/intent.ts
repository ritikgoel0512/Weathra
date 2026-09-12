/**
 * What a settled run actually was, decided once and read everywhere.
 *
 * Three surfaces on the Analyst have to agree about this and used to decide it separately: the
 * answer body (does it render the report apparatus, or a conversation?), the rail (does it say
 * "Complete", or "Needs location"?), and the composer (is the next thing typed a new question, or
 * the answer to one?). The production review of 2026-09-12 caught all three disagreeing on the same
 * run — an agent status reading COMPLETE beside a reply that had asked a question and retrieved
 * nothing, over two empty figure panels.
 *
 * There is no new backend field behind this. `AnswerEnvelope` already carries everything needed:
 * the clarification the run asked, and `resolved.location_source`, which is `"none"` exactly when
 * resolution reached its last step without a place. Deriving it in one pure function is what stops
 * the three surfaces drifting apart again.
 */

import type { AnswerEnvelope } from "@/lib/api/schema";

/** What a settled run turned out to be. */
export type RunIntent =
  /** A question came back instead of an answer, and it is *which place* — the resumable case. */
  | { readonly kind: "needs-location"; readonly question: string }
  /** A question came back instead of an answer, and supplying a place would not settle it. */
  | { readonly kind: "clarifying"; readonly question: string }
  /** A real answer: prose, figures, or both. */
  | { readonly kind: "answered" };

/**
 * Read a settled answer.
 *
 * The distinction between the two clarifying kinds is the whole point. A missing location is a
 * *slot* the Analyst can fill from a control, a saved place or the next thing typed, after which
 * the original question runs unchanged. An ambiguous name — "Springfield matches more than one
 * place" — is the same shape and the same treatment; it is also a place the person supplies, so it
 * is `needs-location` too. Anything else the backend might ever ask is not resumable by supplying a
 * place, and gets the plain conversational treatment with no location affordances attached.
 */
export function runIntentOf(answer: AnswerEnvelope): RunIntent {
  const question = answer.clarification_question?.trim() ?? "";
  if (question === "") return { kind: "answered" };

  /*
   * A clarification *and* figures is not a clarification: the run answered part of the question and
   * asked about the rest, and hiding the part it answered would lose work the person paid an
   * inference call for. Only a run that produced nothing at all is the conversational state.
   *
   * This is the condition the previous pass got wrong. It required `!answer.answer_prose`, so a run
   * that asked which place *and* wrote a sentence about having asked fell through to the report
   * layout: an interpretation card with nothing in it, two empty figure panels, and the model and
   * policy identifiers underneath.
   */
  const produced = (answer.findings ?? []).length > 0;
  if (produced) return { kind: "answered" };

  /*
   * A clarification with no place resolved is a clarification *about* the place, whichever way the
   * ladder got there: nothing named and nothing saved, a name the geocoder did not know, or a name
   * that matched several places. All three are answered by supplying one, so all three are
   * resumable and all three get the chooser. `location_source` is deliberately not consulted — it
   * reads `"request"` for an ambiguous name, which is true and is not the question being asked.
   *
   * A clarification that *did* resolve a place is asking about something else, and offering a place
   * chooser for it would answer a question nobody asked.
   */
  const located = (answer.resolved?.locations ?? []).length > 0;
  if (!located) return { kind: "needs-location", question };

  return { kind: "clarifying", question };
}

/** Whether this run is waiting for a place, which several surfaces ask directly. */
export function needsLocation(answer: AnswerEnvelope | null): boolean {
  return answer !== null && runIntentOf(answer).kind === "needs-location";
}
