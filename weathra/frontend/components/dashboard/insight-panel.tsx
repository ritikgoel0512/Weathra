"use client";

import type { ReactNode } from "react";

import type { ForecastDay } from "@/lib/dashboard/briefing";
import { insightsFor, type Insight } from "@/lib/dashboard/insights";

import styles from "./dashboard.module.css";

/**
 * Weathra Intelligence, level one: what the figures on this screen already say.
 *
 * The panel this sits above used to be the whole of the feature — *"Ask Weathra to read the figures
 * above"* and a button. A product's headline capability should not be a promise the person has to
 * press to collect, and the first thing it says should not cost an inference call.
 *
 * Every card is arithmetic over the same daily series the forecast strip renders. No model is
 * called, so this is populated on a Dashboard with no inference provider configured at all — which
 * is also the state that used to render the panel's least useful sentence. The deeper reading is
 * still a button, one level down, where a model genuinely adds something.
 */
export function DeterministicInsights({
  days,
  baselineDifference,
}: {
  readonly days: readonly ForecastDay[];
  readonly baselineDifference?: { value: number; unit: string; years: number } | null;
}): ReactNode {
  const insights = insightsFor(days, { baselineDifference: baselineDifference ?? null });
  if (insights.length === 0) return null;

  return (
    <ul className={styles.insightGrid} aria-label="What the forecast says">
      {insights.map((insight) => (
        <InsightCard insight={insight} key={insight.key} />
      ))}
    </ul>
  );
}

function InsightCard({ insight }: { readonly insight: Insight }): ReactNode {
  return (
    <li className={styles.insight} data-direction={insight.direction}>
      <span className={styles.insightTitle}>{insight.title}</span>
      <span className={styles.insightValue}>{insight.value}</span>
      {insight.detail ? <span className={styles.insightDetail}>{insight.detail}</span> : null}
    </li>
  );
}
