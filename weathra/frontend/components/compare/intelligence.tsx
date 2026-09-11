"use client";

/**
 * "Comparison Intelligence" — the card `04-compare-cities.png` puts under the two city heroes,
 * built with Weathra's own figures. Task 34.31.
 *
 * The artifact's version is the screen's centrepiece: a tinted header band with a circular mark,
 * a labelled interpretation column, two inset sub-cards under it, and a narrow right column
 * carrying two meters and one action. Production had none of it — `screens.md` §8 recorded the
 * whole card as unimplementable because "nothing on this screen is model-written", and then put
 * the two meters in a bare analytics band of their own halfway down the page.
 *
 * Both halves of that reasoning have expired. The card's *composition* never depended on a model:
 * its left column is a reading of the comparison and its right column is two properties of the
 * retrieved data. And the Dashboard has since shipped exactly this card, with a real interpretation
 * asked for on request rather than spent on every load — so this is that card, with a comparison
 * in it.
 *
 * # What each region actually holds
 *
 * * **The lead** — a deterministic sentence naming the gap between the two places, in the measure
 *   the ranking turned on, built by `differencesBetween` from figures already on the screen.
 *   Where somebody presses for one, the model's reading of the same comparison replaces it inside
 *   `InterpretationPanel`, behind that panel's badge and boundary sentence.
 * * **What separates them** — every statistic both places reported, and the signed gap.
 * * **Why** — which statistic decided the ranking, by how much, and how the two places moved.
 * * **The meters** — Pearson's *r* and the data density the backend computed, as
 *   `DeterministicAssociation` already drew them, now where the artifact puts them.
 *
 * # What is refused
 *
 * The artifact heads its card `NEURAL AGENT V4.8 • MULTI-NODE SYNTHESIS` and labels the meters
 * `SYNTHESIS CONFIDENCE`. There is no neural agent, no multi-node synthesis, and the two figures
 * are properties of the data rather than a model's confidence in anything. The subtitle states what
 * this card is instead, and the meters keep their own true names.
 */

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";

import {
  Button,
  IntelligenceMark,
  InterpretationPanel,
  MethodNote,
  Meter,
  QuotaState,
} from "@/components/ui";
import { isAgentUnavailableCode } from "@/lib/api/errors";
import { quotaRefusalFrom, type QuotaRefusal } from "@/lib/api/quota";
import { useApiClient } from "@/lib/api/context";
import type { AskResponse, ComparisonResult, UnitSystem } from "@/lib/api/schema";
import { criterionLabel } from "@/lib/comparison/ranking";
import { differencesBetween, type Difference } from "@/lib/comparison/differences";
import { measureLabel, formatReading } from "@/lib/dashboard/briefing";
import { inferenceMetadataFrom } from "@/lib/inference/served";
import { describeFailure } from "@/lib/query/state";

import styles from "./compare.module.css";

/** Wording only. The coefficient beside it is the figure; this says which way to read it. */
export function correlationSense(value: number): string {
  if (value >= 0.7) return "move closely together";
  if (value >= 0.3) return "move loosely together";
  if (value > -0.3) return "move largely independently";
  if (value > -0.7) return "move loosely opposite";
  return "move closely opposite";
}

/** `+2.3 °C`, with the sign, because which way round a difference runs is the point of it. */
export function signedReading(difference: Difference): string {
  const size = formatReading({ value: Math.abs(difference.value), unit: difference.unit });
  return `${difference.value >= 0 ? "+" : "−"}${size}`;
}

/**
 * The model's reading of this comparison, asked for on request.
 *
 * Exactly the Dashboard's arrangement and for the same reason: an interpretation costs an inference
 * call, `specs/usage-limits` counts them, and a screen that spent one on arrival would be spending
 * somebody's allowance without being asked. Until it is asked for, the card's lead is the
 * deterministic sentence beside it — which is why this screen is fully useful with no inference
 * provider configured at all.
 */
function ComparisonReading({
  places,
  criterion,
  units,
  lead,
}: {
  readonly places: readonly string[];
  readonly criterion: string;
  readonly units: UnitSystem;
  readonly lead: ReactNode;
}): ReactNode {
  const client = useApiClient();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "asking" }
    | { kind: "answered"; answer: AskResponse }
    | { kind: "refused"; refusal: QuotaRefusal }
    | { kind: "failed"; message: string; unavailable: boolean }
  >({ kind: "idle" });

  const ask = useCallback(async () => {
    setState({ kind: "asking" });
    try {
      const answer = await client.ask({
        question: `Compare ${places.join(" and ")} over this window, ranked by ${criterionLabel(
          criterion,
        ).toLowerCase()}, and say what the difference between them amounts to.`,
        units,
      });
      setState({ kind: "answered", answer });
    } catch (error) {
      const failure = describeFailure(error);
      const refusal = quotaRefusalFrom(failure);
      setState(
        refusal !== null
          ? { kind: "refused", refusal }
          : {
              kind: "failed",
              message: failure.message,
              unavailable: isAgentUnavailableCode(failure.code),
            },
      );
    }
  }, [client, criterion, places, units]);

  if (state.kind === "answered") {
    const envelope = state.answer.answer;
    const inference = inferenceMetadataFrom(envelope.evidence?.inference_attempts, {
      provider: envelope.llm_provider,
      model: envelope.llm_model,
    });
    return (
      <InterpretationPanel
        title="Comparison interpretation"
        titleVisible={false}
        eyebrow="Current interpretation"
        density="compact"
        provider={inference?.provider ?? null}
        model={inference?.model ?? null}
        requestedModel={inference?.requestedModel ?? null}
        policy={inference?.policyId ?? null}
        resolution={inference?.resolutionReason ?? null}
        served={inference?.served ?? true}
      >
        {envelope.answer_prose ? (
          <p>{envelope.answer_prose}</p>
        ) : (
          <p>
            The interpretation was withheld because it could not be grounded in the figures on this
            screen. Every figure here is retrieved or computed and is unaffected.
          </p>
        )}
      </InterpretationPanel>
    );
  }

  if (state.kind === "refused") {
    return <QuotaState refusal={state.refusal} onRetry={ask} />;
  }

  return (
    <InterpretationPanel
      title="Comparison interpretation"
      titleVisible={false}
      eyebrow="What the comparison says"
      density="compact"
    >
      {/*
        The deterministic reading is the *content* of this region, not a placeholder for one — which
        is why it sits inside the panel above the control rather than beside it. It is marked as
        interpretation because it is a reading of figures rather than a figure; every number in it
        came from the comparison and none of it was written by a model.
      */}
      {lead}
      {state.kind === "failed" ? (
        <p className={styles.note}>
          {state.unavailable
            ? "No inference provider is configured. Every figure on this screen is retrieved or computed and is unaffected."
            : state.message}
        </p>
      ) : null}

      <div className={styles.intelligenceAsk}>
        <Button variant="primary" size="sm" onClick={ask} busy={state.kind === "asking"}>
          {state.kind === "asking" ? "Reading the figures…" : "Read this comparison"}
        </Button>
      </div>
    </InterpretationPanel>
  );
}

export interface ComparisonIntelligenceProps {
  readonly result: ComparisonResult;
}

export function ComparisonIntelligence({ result }: ComparisonIntelligenceProps): ReactNode {
  const ranked = [...(result.candidates ?? [])].sort((one, other) => one.rank - other.rank);
  const leading = ranked[0];
  const trailing = ranked[1];
  const differences = differencesBetween(leading, trailing);
  const headline = differences[0] ?? null;

  const correlation = result.correlation ?? null;
  const density = result.data_density ?? null;
  const coefficient =
    correlation !== null && typeof correlation.value === "number" ? correlation.value : null;
  const densityValue =
    density !== null && typeof density.value === "number" ? density.value : null;

  const places = ranked.map((candidate) => candidate.label);

  /*
   * The lead sentence: the gap, in the measure the ranking turned on, between the two places by
   * name. Every figure in it is `headline`'s, which is a subtraction of two values the backend
   * returned. Where the comparison produced no shared statistic there is no sentence rather than a
   * vaguer one.
   */
  const lead =
    headline && leading && trailing ? (
      <p>
        {leading.label} is{" "}
        <strong>{formatReading({ value: Math.abs(headline.value), unit: headline.unit })}</strong>{" "}
        {headline.value >= 0 ? "above" : "below"} {trailing.label} on{" "}
        {measureLabel(headline.measure).toLowerCase()} across this window
        {coefficient !== null ? `, and the two ${correlationSense(coefficient)}` : ""}.
      </p>
    ) : (
      <p>
        The comparison returned no statistic both places reported, so there is no difference to
        state between them.
      </p>
    );

  return (
    /*
      **A section rather than a `ProvenanceSection`, and one heading rather than two.** The frozen
      Dashboard's intelligence card is a plain region whose header band carries the name; wrapping
      this one in a provenance card put "ANALYTICS Comparison Intelligence" immediately above a band
      that said "Comparison Intelligence" again. The band *is* the header, so the heading lives in
      it — and the data-class badge belongs to the interpretation region inside, which carries its
      own, rather than to a card that holds three tiers at once.
    */
    <section className={styles.intelligenceCard} aria-label="Comparison Intelligence">
      <div className={styles.intelligenceHead}>
        <span className={styles.intelligenceMark} aria-hidden="true">
          <IntelligenceMark />
        </span>
        <span className={styles.intelligenceHeadText}>
          <h2 className={styles.intelligenceHeadTitle}>Comparison Intelligence</h2>
          <span className={styles.intelligenceHeadMeta}>
            Deterministic comparison of {places.length}{" "}
            {places.length === 1 ? "place" : "places"}
          </span>
        </span>
      </div>

        <div className={styles.intelligenceMain}>
          <div className={styles.intelligencePrimary}>
            <ComparisonReading
              places={places}
              criterion={result.criterion}
              units={(result.unit_system ?? "metric") as UnitSystem}
              lead={lead}
            />
          </div>

          <div className={styles.intelligenceAside}>
            {/*
              The artifact's two bars, where the artifact puts them. They were a full-width analytics
              band of their own, which is the "floating engineering bar" the customer-level review
              named — the figures are unchanged and so are their methods.
            */}
            <section className={styles.meters} aria-label="How the places moved, and how much was reported">
              <h3 className={styles.metersTitle}>Data association</h3>

              <Meter
                label="Correlation"
                /* |r|, because a bar has no direction. The sign is the caption beside it. */
                value={coefficient === null ? null : Math.abs(coefficient)}
                valueLabel={coefficient === null ? undefined : coefficient.toFixed(2)}
                unavailable={correlation === null ? "Two places only" : "Not computable"}
                note={
                  coefficient !== null
                    ? `they ${correlationSense(coefficient)}`
                    : correlation === null
                      ? "A correlation describes one pair. Compare two to see it."
                      : (correlation.reason ?? "Not computable")
                }
              />
              <Meter
                label="Data density"
                value={densityValue === null ? null : densityValue / 100}
                unavailable="Not computable"
                note={
                  densityValue !== null
                    ? "of the window every place reported"
                    : (density?.reason ?? "Not computable")
                }
              />

              {correlation !== null || density !== null ? (
                <details className={styles.metersMethod}>
                  <summary className={styles.metersMethodSummary}>How these were computed</summary>
                  {correlation !== null && coefficient !== null ? (
                    <MethodNote
                      method={correlation.method}
                      pointsUsed={correlation.points_used}
                      pointsExcluded={correlation.points_excluded}
                      compact
                    />
                  ) : null}
                  {density !== null && densityValue !== null ? (
                    <MethodNote
                      method={density.method}
                      pointsUsed={density.points_used}
                      pointsExcluded={density.points_excluded}
                      compact
                    />
                  ) : null}
                </details>
              ) : null}
            </section>

            <div className={styles.intelligenceActions}>
              <Link className={styles.intelligenceAction} href="/evidence">
                View agent evidence
              </Link>
            </div>
          </div>

          {/*
            The artifact's two inset sub-cards. Its own are "WHAT CHANGED?" and "WHY?", answered
            with convergence zones and tropospheric wind shear — an atmosphere Weathra does not
            model. The visual role is kept and the questions are the ones this screen can answer:
            what separates the two places, and what decided the order they are in.
          */}
          <div className={styles.intelligenceSubcards}>
            <section className={styles.subcard} aria-label="What separates them">
              <h3 className={styles.subcardTitle}>What separates them</h3>
              {differences.length === 0 ? (
                <p className={styles.note}>
                  No statistic was reported for both places, so nothing can be subtracted.
                </p>
              ) : (
                <ul className={styles.subcardFigures}>
                  {differences.slice(0, 3).map((difference) => (
                    <li
                      className={styles.subcardFigure}
                      key={`${difference.statistic}-${difference.measure}`}
                    >
                      <span className={styles.subcardFigureLabel}>
                        {measureLabel(difference.measure)}
                      </span>
                      <span
                        className={styles.subcardFigureValue}
                        data-direction={difference.value >= 0 ? "up" : "down"}
                      >
                        {signedReading(difference)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.subcard} aria-label="Why this order">
              <h3 className={styles.subcardTitle}>Why this order</h3>
              <p className={styles.subcardProse}>
                {leading && trailing && headline ? (
                  <>
                    The ranking turned on {measureLabel(headline.measure).toLowerCase()}, where{" "}
                    {leading.label} reported{" "}
                    {formatReading({ value: headline.leading, unit: headline.unit })} against{" "}
                    {trailing.label}&rsquo;s{" "}
                    {formatReading({ value: headline.trailing, unit: headline.unit })}.
                  </>
                ) : (
                  <>
                    The ranking is by {criterionLabel(result.criterion).toLowerCase()} over the
                    window every place shares.
                  </>
                )}
              </p>
            </section>
        </div>
      </div>
    </section>
  );
}
