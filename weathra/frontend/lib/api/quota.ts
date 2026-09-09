/**
 * An exhausted allowance, read off the refusal the backend sent — task 33.5.
 *
 * `specs/web-ui` requires a quota refusal to be its own state: "a distinct, honest state naming the
 * limit and when it resets — not a weather error, an authentication error, or a generic failure".
 * Three properties of that sentence decide everything here.
 *
 * **It is distinct.** `quota_exceeded` shares its 429 with `provider_rate_limited`, and the
 * backend gave them separate codes deliberately (`weathra/domain/errors.py`): one is the
 * subscription saying no and the other is the gateway saying not yet. A client that told them
 * apart by status would retry the first forever, and a client that showed the first as a provider
 * failure would blame an outage for a plan limit. So the branch is on the *code*, and
 * `quota_unavailable` — the accounting store being unreachable — is deliberately not part of it:
 * that one knows no allowance, no consumption and no reset, and reporting a limit nobody read as a
 * limit somebody reached would be an invention.
 *
 * **It names the limit.** The figures come from the refusal's own `details`, which the backend
 * fills with the bound dimension, the allowance, the consumption and the reset instant — and
 * nothing else, on purpose. Every field here is nullable and nothing is computed from a default: a
 * detail the backend did not send is reported as unknown rather than shown as zero, because "0 of
 * 0 used" is a figure, and a wrong one.
 *
 * **It leaves the rest alone.** Nothing in this module clears a thread, a saved location or a
 * preference, and nothing in it touches the session. A refusal is a refusal of one request.
 */

import type { QuotaDimension, QuotaWindow } from "./schema";

/** The code the backend uses for an exhausted allowance. */
export const QUOTA_EXCEEDED_CODE = "quota_exceeded";

/**
 * The code for accounting being unreachable, which is *not* an exhausted allowance.
 *
 * Named so the distinction is written down rather than implied by its absence. It fails closed
 * like a quota refusal and means something entirely different, so it stays a generic failure — the
 * gate is down, and saying "you have used your allowance" would be a guess about a person's
 * standing that nothing was able to read.
 */
export const QUOTA_UNAVAILABLE_CODE = "quota_unavailable";

/** Whether a code means the caller's own allowance is exhausted. */
export function isQuotaExhaustedCode(code: string | null | undefined): boolean {
  return code === QUOTA_EXCEEDED_CODE;
}

/** An exhausted allowance, as the backend described it. */
export interface QuotaRefusal {
  /** The bound dimension, when the backend named one. */
  readonly dimension: QuotaDimension | null;
  /** The window the dimension is counted over. */
  readonly window: QuotaWindow | null;
  /** What the plan permits over the window. */
  readonly allowance: number | null;
  /** What has been used of it. */
  readonly consumed: number | null;
  /** When the window resets, as the backend's instant. Null for a concurrency limit, which has no reset. */
  readonly resetsAt: string | null;
  readonly retryAfterSeconds: number | null;
  /** The backend's own sentence, which the spec requires the screen to show. */
  readonly message: string;
  readonly requestId: string | null;
}

/** What this module needs from a thrown failure, so a fake in a test describes one just as well. */
export interface DescribedFailure {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: Record<string, unknown> | null;
  readonly requestId?: string | null;
}

const DIMENSIONS: readonly QuotaDimension[] = [
  "requests_per_day",
  "requests_per_month",
  "tokens_per_month",
  "concurrent_runs",
  "estimated_cost_per_month",
];

const WINDOWS: readonly QuotaWindow[] = ["day", "month", "concurrent"];

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A finite, non-negative count. A negative allowance or a NaN is treated as unreported. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function dimensionOf(value: unknown): QuotaDimension | null {
  const text = textOf(value);
  return text !== null && (DIMENSIONS as readonly string[]).includes(text)
    ? (text as QuotaDimension)
    : null;
}

function windowOf(value: unknown): QuotaWindow | null {
  const text = textOf(value);
  return text !== null && (WINDOWS as readonly string[]).includes(text)
    ? (text as QuotaWindow)
    : null;
}

/**
 * The refusal as a quota state, or null when the failure is not one.
 *
 * Read structurally rather than by `instanceof ApiError`: the same failure arrives as a thrown
 * `ApiError` from a REST call, as a terminal stream event's fields, and as a plain object through
 * a React Query cache — and a check that insisted on the class would show two of the three as a
 * generic error.
 */
export function quotaRefusalFrom(failure: unknown): QuotaRefusal | null {
  const described = (failure ?? {}) as DescribedFailure;
  if (!isQuotaExhaustedCode(described.code ?? null)) return null;

  const details = (described.details ?? {}) as Record<string, unknown>;
  const dimension = dimensionOf(details.dimension);

  return {
    dimension,
    // The dimension implies its window, but the backend states it, so the stated one is used and
    // nothing is derived from a name that could be renamed.
    window: windowOf(details.window),
    allowance: countOf(details.allowance),
    consumed: countOf(details.consumed),
    resetsAt: textOf(details.resets_at),
    retryAfterSeconds: countOf(details.retry_after_seconds),
    message: textOf(described.message) ?? "Your plan's allowance for this request is used up.",
    requestId: textOf(described.requestId),
  };
}

/**
 * What the bound dimension is called, in a person's words.
 *
 * The backend's identifiers are stable and are not sentences. These are the sentences, and there
 * is one per declared dimension including `estimated_cost_per_month`, which nothing enforces
 * today: a dimension that arrives without a label would otherwise reach a person as
 * `tokens_per_month`.
 */
export const DIMENSION_LABELS: Readonly<Record<QuotaDimension, string>> = {
  requests_per_day: "questions today",
  requests_per_month: "questions this month",
  tokens_per_month: "language model tokens this month",
  concurrent_runs: "questions at once",
  estimated_cost_per_month: "estimated model cost this month",
};

/** What the window is called, for the reset sentence. */
export const WINDOW_LABELS: Readonly<Record<QuotaWindow, string>> = {
  day: "day",
  month: "month",
  concurrent: "concurrency limit",
};

/**
 * The limit, as a sentence, or null when the backend named no figures.
 *
 * Both halves are required: an allowance with no consumption reads as a limit nobody has reached,
 * and a consumption with no allowance reads as a count with no bound. Neither is the "naming the
 * limit" the spec asks for, so the sentence is withheld rather than half-written — the backend's
 * own message is on screen regardless.
 */
export function limitSentence(refusal: QuotaRefusal): string | null {
  if (refusal.allowance === null || refusal.consumed === null) return null;
  const what = refusal.dimension === null ? "this allowance" : DIMENSION_LABELS[refusal.dimension];
  return `${refusal.consumed} of ${refusal.allowance} ${what}`;
}
