/**
 * What the backend has recorded about one policy candidate, assembled for a person to read.
 *
 * The assembly is here rather than in the screen for one reason: every rule in it is an honesty
 * rule, and honesty rules are worth testing directly. `specs/evaluation` requires a promotion
 * decision to rest on five measured criteria and forbids resting it on a name; `specs/web-ui`
 * requires a candidate the backend never evaluated to read as *unevidenced* rather than as failed.
 * Both are one-line mistakes to make in JSX and neither would look wrong.
 *
 * **Nothing here computes a criterion.** The verdicts come from `model_evaluations.criteria`, which
 * the evaluation framework wrote; this module reads them, formats them, and refuses to invent one.
 * An absent measurement stays absent — `null` renders as "not measured", never as zero, because a
 * candidate whose gateway reported no cost has not been shown to be free.
 *
 * **The selected run and the recorded evaluation are two different facts**, and conflating them is
 * how a run that scored nothing for a candidate ends up cited as the basis for its position. So a
 * candidate carries both: the verdict from whatever evaluation the backend holds, and the number of
 * cases *this* run scored for it.
 */

import type { CatalogObservation, ComparisonResultRecord } from "@/lib/api/schema";

/** Whether the backend holds a scored evaluation for a candidate, and what it said. */
export type CandidateVerdict = "evidenced" | "failed" | "unevidenced";

/** One criterion as a reader sees it: a verdict where it gates, and a reading where it measures. */
export interface CriterionReading {
  readonly name: string;
  readonly label: string;
  /** True or false only for the two gating criteria; null for the three that report. */
  readonly passed: boolean | null;
  /** The measurement in words, or the reason there is none. Never a fabricated zero. */
  readonly reading: string;
  readonly measured: boolean;
}

export interface CandidateEvidence {
  readonly catalogKey: string;
  readonly gatewayModel: string | null;
  readonly verdict: CandidateVerdict;
  /** The gating criteria the recorded evaluation says this candidate failed. */
  readonly failedCriteria: readonly string[];
  /** All five, in the order `specs/evaluation` names them. */
  readonly criteria: readonly CriterionReading[];
  readonly datasetVersion: string | null;
  readonly recordedAt: string | null;
  /** Cells in the selected run that resolved to an evaluation, and cells it ran at all. */
  readonly casesScored: number;
  readonly casesRun: number;
  /**
   * True when a recorded evaluation exists but the selected run is not where it came from.
   *
   * The one case a promotion must not misread: citing this run for this candidate would cite
   * evidence the run does not contain, however good the evidence elsewhere is.
   */
  readonly evidenceFromAnotherRun: boolean;
}

/** The two criteria that block a promotion, per `specs/evaluation`. Everything else reports. */
export const GATING_CRITERIA = ["structured_json_reliability", "groundedness"] as const;

/** The five criteria, in the order the spec's table lists them. */
export const CANONICAL_CRITERIA: readonly { name: string; label: string }[] = [
  { name: "structured_json_reliability", label: "Structured JSON reliability" },
  { name: "groundedness", label: "Groundedness" },
  { name: "latency", label: "Latency" },
  { name: "planning", label: "Tool and planning quality" },
  { name: "cost", label: "Cost" },
];

const NOT_MEASURED = "Not measured — the run recorded no figure for this.";

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(value: unknown): string | null {
  const found = number(value);
  return found === null ? null : found.toFixed(2);
}

function milliseconds(value: unknown): string | null {
  const found = number(value);
  return found === null ? null : `${Math.round(found).toLocaleString("en-GB")} ms`;
}

function section(criteria: Record<string, unknown>, name: string): Record<string, unknown> {
  const measured = criteria.measured;
  const source =
    typeof measured === "object" && measured !== null
      ? ((measured as Record<string, unknown>)[name] ?? criteria[name])
      : criteria[name];
  return typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
}

/**
 * The reading for one criterion.
 *
 * The two gating criteria are stored twice — as a verdict at their own key, and as their figures
 * under `measured` — because the gate reads `criteria[name] is false` and a person reads the
 * numbers. Both are shown: a verdict without its figures is an assertion, and figures without the
 * verdict leave the reader to apply a threshold they cannot see.
 */
export function criterionReading(
  name: string,
  label: string,
  criteria: Record<string, unknown>,
): CriterionReading {
  const gating = (GATING_CRITERIA as readonly string[]).includes(name);
  const verdict = gating && typeof criteria[name] === "boolean" ? (criteria[name] as boolean) : null;
  const figures = section(criteria, name);

  let reading: string | null = null;
  switch (name) {
    case "structured_json_reliability": {
      const rate = ratio(figures.first_attempt_valid_rate);
      const attempts = ratio(figures.mean_attempts_to_valid);
      const decisions = number(figures.decisions);
      reading =
        rate === null
          ? null
          : `${rate} valid on the first attempt over ${decisions ?? 0} structured ` +
            `decision${decisions === 1 ? "" : "s"}` +
            (attempts === null ? "" : `, ${attempts} mean attempts to a valid decision`);
      break;
    }
    case "groundedness": {
      const grounded = ratio(figures.groundedness);
      const hallucination = ratio(figures.hallucination_rate);
      const unsupported = ratio(figures.unsupported_weather_claim_rate);
      reading =
        grounded === null
          ? null
          : `groundedness ${grounded}` +
            (hallucination === null ? "" : `, hallucination rate ${hallucination}`) +
            (unsupported === null ? "" : `, unsupported weather claim rate ${unsupported}`);
      break;
    }
    case "latency": {
      const median = milliseconds(figures.overall_median_ms);
      const p95 = milliseconds(figures.overall_p95_ms);
      reading = median === null ? null : `overall median ${median}${p95 === null ? "" : ` / p95 ${p95}`}`;
      break;
    }
    case "planning": {
      const tools = ratio(figures.tool_selection_accuracy);
      const correctness = ratio(figures.plan_correctness);
      const multiStep = number(figures.multi_step_cases);
      reading =
        tools === null
          ? null
          : `tool-selection accuracy ${tools}; plan correctness ` +
            (correctness === null
              ? `not measured — ${multiStep ?? 0} multi-step case${multiStep === 1 ? "" : "s"} in this run`
              : correctness);
      break;
    }
    case "cost": {
      const total = figures.estimated_total;
      const perCase = figures.estimated_per_case;
      const currency = typeof figures.currency === "string" ? figures.currency : "USD";
      reading =
        total === null || total === undefined
          ? "No cost reported by the gateway. Not filled in from zero, which would be a statement about the price list rather than about the run."
          : `estimated ${String(total)} ${currency} for the run` +
            (perCase === null || perCase === undefined ? "" : `, ${String(perCase)} per case`) +
            " — an estimate, not a billed amount";
      break;
    }
    default:
      reading = null;
  }

  return {
    name,
    label,
    passed: verdict,
    reading: reading ?? NOT_MEASURED,
    measured: reading !== null && reading !== NOT_MEASURED,
  };
}

/** The gating criteria a recorded evaluation says a candidate failed. */
export function failedGates(criteria: Record<string, unknown>): readonly string[] {
  const blockers = criteria.promotion_blockers;
  if (Array.isArray(blockers) && blockers.length > 0) return blockers.map(String);
  return GATING_CRITERIA.filter((name) => criteria[name] === false);
}

/**
 * One candidate's evidence, from the observation the backend recorded and the run's own cells.
 *
 * `observation` absent is the case this exists for: the candidate is unevidenced, which is not the
 * same as having failed and must not be shown as though it were. The backend's promotion gate makes
 * the same distinction — `lab/promotion.py` contributes nothing for a candidate nobody evaluated —
 * so the screen and the gate agree by construction rather than by coincidence.
 */
export function candidateEvidence(
  catalogKey: string,
  observation: CatalogObservation | undefined,
  cells: readonly ComparisonResultRecord[],
): CandidateEvidence {
  const mine = cells.filter((cell) => cell.catalog_key === catalogKey);
  const casesScored = mine.filter(
    (cell) => cell.succeeded && cell.evaluation_id !== null && cell.evaluation_id !== undefined,
  ).length;

  if (observation === undefined) {
    return {
      catalogKey,
      gatewayModel: mine[0]?.gateway_model ?? null,
      verdict: "unevidenced",
      failedCriteria: [],
      criteria: CANONICAL_CRITERIA.map(({ name, label }) => ({
        name,
        label,
        passed: null,
        reading: NOT_MEASURED,
        measured: false,
      })),
      datasetVersion: null,
      recordedAt: null,
      casesScored,
      casesRun: mine.length,
      evidenceFromAnotherRun: false,
    };
  }

  const criteria = observation.criteria ?? {};
  const failed = failedGates(criteria);

  return {
    catalogKey,
    gatewayModel: observation.gateway_model ?? mine[0]?.gateway_model ?? null,
    verdict: failed.length > 0 ? "failed" : "evidenced",
    failedCriteria: failed,
    criteria: CANONICAL_CRITERIA.map(({ name, label }) => criterionReading(name, label, criteria)),
    datasetVersion: observation.dataset_version ?? null,
    recordedAt: observation.recorded_at ?? null,
    casesScored,
    casesRun: mine.length,
    evidenceFromAnotherRun: casesScored === 0,
  };
}

/**
 * Whether submitting `candidates` for a policy would change it.
 *
 * The screen has to say which it is doing. 34.5's promotion is a confirmation in place — the
 * recorded evidence supports the candidate already at the head of the list and supports nothing at
 * all about the one below it — and presenting that as a reorder would claim a decision the
 * evidence does not carry.
 */
export function isConfirmationInPlace(
  stored: readonly string[],
  candidates: readonly string[],
): boolean {
  return stored.length === candidates.length && stored.every((key, at) => key === candidates[at]);
}
