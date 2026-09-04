"use client";

/**
 * Compare Cities' surfaces — task 21.4, against `docs/design/screens/04-compare-cities.png`.
 *
 * The artifact establishes the order this reproduces: the compared places as cards across the top,
 * a comparison chart beneath them, and the per-candidate figures beside it. What it does not
 * establish, and what `specs/location-comparison` does, is that every one of those figures must be
 * checkable.
 *
 * Three rules run through the components below:
 *
 * **A ranking is evidence, not a verdict.** Every candidate carries the analytics results that
 * produced its score, each with the method and the point count behind it, so a reader can see why
 * one place came first rather than being asked to accept it.
 *
 * **A composite score explains itself.** "Best for being outdoors" is the one place a judgment is
 * made rather than a measurement reported, so each contributing measure is shown with its value,
 * its direction, its weight and the points it added — and the result's own disclosure that the
 * weighting is Weathra's heuristic is printed with it.
 *
 * **A place that could not be scored is named.** An excluded candidate is a first-class part of the
 * answer with its reason and its stable code, because a ranking of two presented as a ranking of
 * three is the failure this screen exists to avoid.
 */

import type { ReactNode } from "react";

import {
  AttributionFooter,
  Badge,
  DataClassBadge,
  MethodNote,
  ProvenanceSection,
} from "@/components/ui";
import type {
  ComparisonCandidate,
  ComparisonResult,
  ComponentContribution,
} from "@/lib/api/schema";
import { dataClassFor } from "@/lib/design/data-class";
import {
  comparableFigure,
  criterionLabel,
  formatStatistic,
  isComposite,
  byRank,
  weightPercentage,
} from "@/lib/comparison/ranking";
import { measureLabel } from "@/lib/dashboard/briefing";
import { periodLabel } from "@/lib/historical/analysis";

import styles from "./compare.module.css";

/* ------------------------------------------------------------------ one candidate */

/** One measure's part in a composite score: which way it counts, how much, and to what effect. */
function Contribution({ contribution }: { readonly contribution: ComponentContribution }): ReactNode {
  return (
    <li className={styles.contribution}>
      <span className={styles.contributionHead}>
        <span className={styles.figureLabel}>{measureLabel(contribution.measure)}</span>
        <span className={styles.figureValue}>
          {Math.round(contribution.value * 10) / 10}
          <span className={styles.figureUnit}> {contribution.unit}</span>
        </span>
      </span>
      <span className={styles.note}>
        {contribution.direction === "above" ? "Higher scores better" : "Lower scores better"} ·{" "}
        {weightPercentage(contribution.weight)} of the score · added{" "}
        {Math.round(contribution.contribution * 100) / 100}
      </span>
      <MethodNote
        method={contribution.supporting.method}
        pointsUsed={contribution.supporting.points_used}
        unit={contribution.supporting.unit || null}
      />
    </li>
  );
}

export interface CandidateCardProps {
  readonly candidate: ComparisonCandidate;
  readonly criterion: string;
  /** True when another candidate shares this rank, so the tie can be said rather than inferred. */
  readonly sharesRank: boolean;
}

/**
 * One place in the ranking, with everything behind its position.
 *
 * The headline figure is the *supporting statistic's* own value, not the raw score: for "driest"
 * and "coolest" the backend negates the score so that higher always means better, and putting
 * a negative rainfall on a card would be reporting a measurement that does not exist.
 */
export function CandidateCard({ candidate, criterion, sharesRank }: CandidateCardProps): ReactNode {
  const figure = comparableFigure(candidate);
  const composite = isComposite(candidate);

  return (
    <article className={styles.candidate} data-candidate="true" data-rank={candidate.rank}>
      <header className={styles.candidateHead}>
        <span className={styles.rank} aria-label={`Rank ${candidate.rank}`}>
          #{candidate.rank}
        </span>
        <h3 className={styles.candidateName}>{candidate.label}</h3>
        {sharesRank || candidate.tied ? <Badge tone="neutral">Tied</Badge> : null}
      </header>

      {figure === null ? (
        <p className={styles.note}>
          The backend reported no comparable figure for this candidate.
        </p>
      ) : (
        <p className={styles.candidateFigure}>
          <span className={styles.figureValue}>
            {Math.round(figure.value * 10) / 10}
            {figure.unit ? <span className={styles.figureUnit}> {figure.unit}</span> : null}
          </span>
          <span className={styles.note}>
            {figure.label} · ranked by {criterionLabel(criterion).toLowerCase()}
          </span>
        </p>
      )}

      <p className={styles.note}>
        {/* Each candidate's own window, in its own local time — which is what makes it fair. */}
        Window: {periodLabel(candidate.period)}
        {candidate.period.timezone ? ` (${candidate.period.timezone})` : null}
      </p>

      {composite ? (
        <>
          <p className={styles.noteStrong}>What made up this score</p>
          <ul className={styles.contributions}>
            {(candidate.contributions ?? []).map((contribution, index) => (
              <Contribution key={`${contribution.measure}-${index}`} contribution={contribution} />
            ))}
          </ul>
        </>
      ) : (
        <ul className={styles.figures}>
          {(candidate.supporting ?? []).map((supporting, index) => {
            const value = formatStatistic(supporting);
            return (
              <li className={styles.figure} key={`${supporting.statistic}-${index}`}>
                <span className={styles.figureLabel}>
                  {supporting.statistic.replace(/_/g, " ")} · {measureLabel(supporting.measure)}
                </span>
                {value === null ? (
                  <span className={styles.note}>
                    Not computable: {supporting.reason ?? "the backend reported no value."}
                  </span>
                ) : (
                  <span className={styles.figureValue}>{value}</span>
                )}
                <MethodNote
                  method={supporting.method}
                  pointsUsed={supporting.points_used}
                  pointsExcluded={supporting.points_excluded}
                  unit={supporting.unit || null}
                />
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------- the ranking */

export interface RankingProps {
  readonly result: ComparisonResult;
  readonly children?: ReactNode;
}

/**
 * The ranking itself, badged ANALYTICS.
 *
 * The class is the ranking's own: a comparison is a computation over retrieved figures, not a
 * reading of them. Which class those figures came from is stated in the basis below, badged
 * separately, so "computed from a forecast" and "computed from the archive" are visibly different
 * answers to the same question.
 */
export function Ranking({ result, children }: RankingProps): ReactNode {
  const shared = new Set(
    (result.candidates ?? [])
      .map((candidate) => candidate.rank)
      .filter((rank, _index, ranks) => ranks.filter((other) => other === rank).length > 1),
  );

  return (
    <ProvenanceSection
      dataClass="analytics"
      title={`Ranked by ${criterionLabel(result.criterion).toLowerCase()}`}
      attribution={{
        provider: result.provider,
        location: null,
        period: {
          start: result.period.start_local,
          end: result.period.end_local,
          timezone: result.period.timezone ?? null,
        },
        units: result.unit_system,
      }}
    >
      {children}

      <div className={styles.candidates}>
        {byRank(result).map((candidate) => (
          <CandidateCard
            key={`${candidate.label}-${candidate.rank}`}
            candidate={candidate}
            criterion={result.criterion}
            sharesRank={shared.has(candidate.rank)}
          />
        ))}
      </div>
    </ProvenanceSection>
  );
}

/* ---------------------------------------------------------------- the shared basis */

/** What every candidate was measured by, so the ranking can be checked for fairness. */
export function SharedBasis({ result }: { readonly result: ComparisonResult }): ReactNode {
  const sourceClass = dataClassFor(result.data_class);

  return (
    <section className={styles.basis} aria-label="The basis every candidate shares">
      <p className={styles.basisHead}>
        <span className={styles.noteStrong}>Every candidate was measured the same way</span>
        {sourceClass ? <DataClassBadge dataClass={sourceClass} /> : null}
      </p>

      <dl className={styles.basisList}>
        <div className={styles.basisItem}>
          <dt>Window</dt>
          <dd>
            {periodLabel(result.period)}
            {result.local_time_basis === false
              ? " (one shared clock)"
              : " · applied in each candidate's own local time"}
          </dd>
        </div>
        <div className={styles.basisItem}>
          <dt>Provider</dt>
          <dd>{result.provider}</dd>
        </div>
        <div className={styles.basisItem}>
          <dt>Units</dt>
          <dd>{result.unit_system}</dd>
        </div>
        <div className={styles.basisItem}>
          <dt>Statistics applied</dt>
          <dd>{(result.statistics_applied ?? []).join("; ")}</dd>
        </div>
        <div className={styles.basisItem}>
          <dt>Tie tolerance</dt>
          <dd>Scores within {result.tie_tolerance} share a rank.</dd>
        </div>
      </dl>

      {/* Required for the composite criterion: whose heuristic the weights are. */}
      {result.weighting_disclosure ? (
        <p className={styles.disclosure} data-disclosure="true">
          {result.weighting_disclosure}
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------- exclusions */

/**
 * The places that could not be scored, each with the reason it was left out.
 *
 * Rendered whenever there is one, and never folded into a footnote: a reader who asked about three
 * places and is shown two has to be told which one is missing and why.
 */
export function Excluded({ result }: { readonly result: ComparisonResult }): ReactNode {
  const excluded = result.excluded ?? [];
  if (excluded.length === 0) return null;

  return (
    <section className={styles.excluded} aria-label="Locations left out of the ranking">
      {/* Announced when it appears, without the section ceasing to be a landmark to navigate to. */}
      <p className={styles.noteStrong} role="status">
        {excluded.length} {excluded.length === 1 ? "location was" : "locations were"} left out of
        this ranking
      </p>
      <ul className={styles.excludedList}>
        {excluded.map((candidate) => (
          <li className={styles.excludedItem} key={`${candidate.label}-${candidate.code}`}>
            <span className={styles.excludedName}>{candidate.label}</span>
            <span className={styles.note}>{candidate.reason}</span>
            <span className={styles.excludedCode}>{candidate.code}</span>
          </li>
        ))}
      </ul>
      <AttributionFooter attribution={{ provider: result.provider, location: null }}>
        <p className={styles.note}>
          These places are not in the ranking above. Nothing has been estimated in their place.
        </p>
      </AttributionFooter>
    </section>
  );
}
