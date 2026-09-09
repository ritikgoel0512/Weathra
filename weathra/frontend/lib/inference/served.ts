/**
 * What actually served an answer — task 33.6.
 *
 * `specs/web-ui` requires the provider, model and resolving policy to be "shown as returned rather
 * than assumed client-side", and the frontend to be incapable of deciding which model serves a
 * request. That sounds like a formatting task and is not: the backend returns *two* accounts of
 * which model was involved, they can disagree, and only one of them is evidence.
 *
 * - `AnswerEnvelope.llm_provider` and `llm_model` are read off the **configured** client. The
 *   backend's own docstring says it: "This is not evidence that it answered — read
 *   `inference_attempts` for that." They name a model whether or not one produced a completion.
 * - `evidence.inference_attempts[]` is what each call attempt actually did — the provider, the
 *   model asked for, the model the gateway reported serving, the policy that resolved it, the plan
 *   it resolved from, and the reason. This is the record.
 *
 * So the record wins, and the configured pair is a labelled fallback for a run that recorded no
 * attempt at all. Nothing here derives a value the backend did not send: the policy fields are
 * nullable on the backend precisely because the policy layer fills them, and a run from before it
 * did has no policy — which is reported as unknown rather than guessed from a plan name.
 *
 * **Why the synthesis stage is preferred.** A run can call a model twice: once to route, once to
 * write the prose. The prose is what a person is reading when they ask "what wrote this", so the
 * synthesis attempt is the answer to that question. Where there is no synthesis attempt the last
 * served attempt is used, because it is the last thing that ran.
 */

import type { InferenceAttempt, InferenceStage } from "@/lib/api/schema";

/** Which inference metadata a surface should show, and how much weight it carries. */
export interface InferenceMetadata {
  readonly provider: string | null;
  /** The model, as the gateway reported serving it where it said, or as asked for otherwise. */
  readonly model: string | null;
  /** What was asked for, when the gateway reported serving something else. Null when they agree. */
  readonly requestedModel: string | null;
  /** The policy that resolved the model, when the backend named one. */
  readonly policyId: string | null;
  /** The catalog entry the policy resolved to. */
  readonly catalogKey: string | null;
  /** The plan the resolution came from. */
  readonly plan: string | null;
  /** Why it resolved as it did, in the backend's own words. */
  readonly resolutionReason: string | null;
  readonly stage: InferenceStage | null;
  /**
   * True when these values come from an attempt that actually produced a completion.
   *
   * False means the surface is showing the *configured* pair, which is a weaker claim and is
   * labelled as one wherever it is shown.
   */
  readonly served: boolean;
}

export interface ConfiguredInference {
  readonly provider?: string | null;
  readonly model?: string | null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Whether the attempt produced a completion. `invalid_output` counts: the model answered. */
function served(attempt: InferenceAttempt): boolean {
  return attempt.status === "served" || attempt.status === "invalid_output";
}

/**
 * The attempt that produced the prose, or null when none did.
 *
 * Read from the array's order rather than by sorting on `attempt_number`, which is 1-based *within
 * a stage* and therefore says nothing about order across stages. The backend appends attempts as
 * they happen, so the last matching entry is the latest one.
 */
export function servedAttemptOf(
  attempts: readonly InferenceAttempt[] | null | undefined,
): InferenceAttempt | null {
  if (!attempts || attempts.length === 0) return null;
  const successful = attempts.filter(served);
  if (successful.length === 0) return null;

  const synthesis = successful.filter((attempt) => attempt.stage === "synthesis");
  const pool = synthesis.length > 0 ? synthesis : successful;
  return pool[pool.length - 1] ?? null;
}

/**
 * The metadata a surface should display, from the record when there is one.
 *
 * Returns null only when the backend reported nothing at all — neither an attempt nor a configured
 * provider or model — in which case the surface shows no attribution rather than an empty label.
 */
export function inferenceMetadataFrom(
  attempts: readonly InferenceAttempt[] | null | undefined,
  configured: ConfiguredInference = {},
): InferenceMetadata | null {
  const attempt = servedAttemptOf(attempts);

  if (attempt !== null) {
    const asked = textOf(attempt.selected_model);
    const gave = textOf(attempt.served_model);
    return {
      provider: textOf(attempt.provider),
      // The gateway's report wins where it made one: a route that substituted a model is a fact
      // worth seeing, and showing the requested model as the one that answered would hide it.
      model: gave ?? asked,
      requestedModel: gave !== null && asked !== null && gave !== asked ? asked : null,
      policyId: textOf(attempt.policy_id),
      catalogKey: textOf(attempt.catalog_key),
      plan: textOf(attempt.plan),
      resolutionReason: textOf(attempt.resolution_reason),
      stage: attempt.stage,
      served: true,
    };
  }

  const provider = textOf(configured.provider);
  const model = textOf(configured.model);
  if (provider === null && model === null) return null;

  return {
    provider,
    model,
    requestedModel: null,
    policyId: null,
    catalogKey: null,
    plan: null,
    resolutionReason: null,
    stage: null,
    served: false,
  };
}
