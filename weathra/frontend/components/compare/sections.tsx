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
  EmptyChart,
  LocationImage,
  ProvenanceSection,
  ScrollRegion,
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
import { unavailableReason } from "@/lib/historical/analysis";
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
      {/*
        `04-compare-cities.png` gives each compared city a photographic banner with its name and
        status on it. `LocationImage` holds that frame whether a photograph is present or not — see
        `public/locations/README.md`.
      */}
      <LocationImage
        displayName={candidate.location.display_name}
        latitude={candidate.location.latitude}
        longitude={candidate.location.longitude}
        variant="banner"
      >
        <header className={styles.candidateHead}>
          <span className={styles.rank} aria-label={`Rank ${candidate.rank}`}>
            #{candidate.rank}
          </span>
          <h3 className={styles.candidateName}>{candidate.label}</h3>
          {sharesRank || candidate.tied ? <Badge tone="neutral">Tied</Badge> : null}
        </header>
      </LocationImage>

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

/* ---------------------------------------------------- the differential matrix */

/**
 * "Forecast Delta Explorer" — the place × figure matrix `04-compare-cities.png` puts under the
 * ranking.
 *
 * The artifact's version is a **per-day** matrix: seven columns of daily deltas per place. That is
 * not a shape `ComparisonResult` has. The endpoint answers with each candidate's statistics *over
 * the shared window*, not a per-day series per place, and building the artifact's grid would mean
 * a separate forecast retrieval per place per day for a question this screen does not ask — the
 * reason `docs/design/screens.md` §8 recorded the matrix as not implemented.
 *
 * What is implemented is the same idea over the axis the data actually has: every statistic the
 * comparison applied, down the side, and every place across the top, so the figures behind the
 * ranking can be read against each other rather than only within a card. A place that reported no
 * value for a statistic shows why, in the backend's own words, and never a dash that could be read
 * as a zero.
 *
 * It scrolls inside its own container, because a matrix is exactly the wide content
 * `specs/web-ui` requires to stay reachable at 360 pixels without the page scrolling sideways.
 */
export function DifferentialMatrix({ result }: { readonly result: ComparisonResult }): ReactNode {
  const candidates = result.candidates ?? [];

  /*
   * The rows come from the figures the candidates actually carry, not from `statistics_applied`.
   * That field is what the request asked for and a backend may answer without it; the supporting
   * results are what the ranking was built from, so a matrix keyed on them cannot have a row no
   * candidate has a value for, nor miss one they do. `statistics_applied` is the fallback for a
   * result that reports the plan but no supporting detail.
   */
  const fromCandidates = new Set<string>();
  for (const candidate of candidates) {
    for (const entry of candidate.supporting ?? []) fromCandidates.add(entry.statistic);
  }
  const statistics =
    fromCandidates.size > 0 ? [...fromCandidates] : (result.statistics_applied ?? []);

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Every figure behind the ranking"
      attribution={{
        provider: result.provider ?? null,
        location: null,
        retrievedAt: null,
        period: result.period
          ? {
              start: result.period.start_local,
              end: result.period.end_local,
              timezone: result.period.timezone ?? null,
            }
          : null,
        units: result.unit_system ?? null,
      }}
    >
      {statistics.length === 0 || candidates.length === 0 ? (
        <p className={styles.note}>
          This comparison reported no supporting figures to lay out, so there is nothing to tabulate
          beneath the ranking.
        </p>
      ) : (
      <ScrollRegion label="Figures behind the ranking">
        <table className={styles.matrix}>
          <caption className={styles.matrixCaption}>
            Each statistic the comparison applied, for each place, over the shared window.
          </caption>
          <thead>
            <tr>
              <th scope="col">Statistic</th>
              {candidates.map((candidate) => (
                <th scope="col" key={candidate.label}>
                  {candidate.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statistics.map((statistic) => (
              <tr key={statistic}>
                <th scope="row">{statistic}</th>
                {candidates.map((candidate) => {
                  const found = candidate.supporting?.find(
                    (entry) => entry.statistic === statistic,
                  );
                  const value = formatStatistic(found);
                  return (
                    <td key={`${candidate.label}-${statistic}`}>
                      {value === null ? (
                        <span className={styles.matrixAbsent}>{unavailableReason(found)}</span>
                      ) : (
                        // `formatStatistic` already carries the unit; appending it printed "°C °C".
                        value
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      )}
    </ProvenanceSection>
  );
}

/**
 * "Comparison Synthesis Summary" — the panel the artifact closes on.
 *
 * The artifact's version is model prose about the comparison, over a synthesis-confidence bar.
 * `POST /weather/comparison` is deterministic and returns no model prose at all, so there is
 * nothing for a model to have written and no confidence anybody computed — `screens.md` §8 records
 * that this screen carries no interpretation region for exactly that reason.
 *
 * The panel is kept and says what the comparison *is*: which criterion decided it, over which
 * window, in whose local time, with which statistics, and how ties were handled. Every one of those
 * is a field of the result. It is the honest form of a synthesis: an account of how the answer was
 * produced rather than a paragraph asserting what it means.
 */
export function ComparisonSummary({ result }: { readonly result: ComparisonResult }): ReactNode {
  return (
    <ProvenanceSection
      dataClass="analytics"
      title="How this comparison was made"
      attribution={null}
    >
      <p className={styles.note}>
        Deterministic. No model interpretation, no confidence score.
      </p>
      <dl className={styles.summaryFacts}>
        <div className={styles.summaryFact}>
          <dt>Criterion</dt>
          <dd>{result.criterion}</dd>
        </div>
        <div className={styles.summaryFact}>
          <dt>Mode</dt>
          <dd>{result.mode}</dd>
        </div>
        <div className={styles.summaryFact}>
          <dt>Statistics applied</dt>
          <dd>
            {(result.statistics_applied ?? []).join(", ") ||
              [
                ...new Set(
                  (result.candidates ?? []).flatMap((candidate) =>
                    (candidate.supporting ?? []).map((entry) => entry.statistic),
                  ),
                ),
              ].join(", ") ||
              "Not reported"}
          </dd>
        </div>
        <div className={styles.summaryFact}>
          <dt>Local time basis</dt>
          <dd>
            {result.local_time_basis
              ? "Each place measured in its own local time"
              : "Not reported"}
          </dd>
        </div>
        <div className={styles.summaryFact}>
          <dt>Tie tolerance</dt>
          <dd>{result.tie_tolerance}</dd>
        </div>
        <div className={styles.summaryFact}>
          <dt>Places compared</dt>
          <dd>{(result.candidates ?? []).length}</dd>
        </div>
      </dl>
      {result.weighting_disclosure ? (
        <p className={styles.note}>{result.weighting_disclosure}</p>
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------- forecast delta explorer */

export interface ForecastDeltaProps {
  /** One entry per compared place, in rank order, with whatever forecast was retrieved for it. */
  readonly rows: readonly {
    readonly label: string;
    readonly days: readonly { readonly date: string; readonly high: string | null }[];
  }[];
  readonly dates: readonly string[];
}

/**
 * "Forecast Delta Explorer" — the artifact's day-by-day matrix, one column per compared place.
 *
 * This is the shape `04-compare-cities.png` actually draws, and it is now buildable: the screen
 * asks the backend for each compared place's forecast over the same horizon, so every cell is a
 * figure that place's provider returned. A day a provider did not forecast is a dash with a
 * heading, never an interpolation between the days on either side of it.
 *
 * Seven rows because the artifact has seven; the horizon is what the person asked for, so a shorter
 * answer leaves the later rows unreported rather than inventing them.
 */
export function ForecastDeltaExplorer({ rows, dates }: ForecastDeltaProps): ReactNode {
  return (
    <ProvenanceSection dataClass="forecast" title="Forecast delta explorer" attribution={null}>
      {rows.length === 0 || dates.length === 0 ? (
        <p className={styles.note}>No forecast was retrieved for the compared places.</p>
      ) : (
        <ScrollRegion label="Forecast by day and place">
          <table className={styles.matrix}>
            <caption className={styles.matrixCaption}>
              Each place&rsquo;s forecast high, by day, over the shared horizon.
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {rows.map((row) => (
                  <th scope="col" key={row.label}>
                    {row.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => (
                <tr key={date}>
                  <th scope="row">{date}</th>
                  {rows.map((row) => {
                    const cell = row.days.find((day) => day.date === date);
                    return (
                      <td key={`${row.label}-${date}`}>
                        {cell?.high ?? <span className={styles.matrixAbsent}>Not forecast</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------- the remaining panels */

/**
 * "Climate Pulse Differential" and "Decadal Climate Baseline" — the artifact's two lower charts.
 *
 * Both are drawn as complete chart frames. The differential needs an intra-day series per place,
 * which is the hourly forecast; the decadal baseline needs a multi-decade archive series. Neither
 * is retrieved by this screen's endpoints, so each frame carries its reason rather than a curve
 * built from something else. The geometry is the artifact's; the emptiness is the truth.
 */
export function ComparisonCharts(): ReactNode {
  return (
    <div className={styles.chartRow}>
      <ProvenanceSection dataClass="forecast" title="Climate pulse differential" attribution={null}>
        <EmptyChart
          title="Intra-day temperature by place"
          reason="No hourly series is retrieved for a comparison."
          height={200}
        />
      </ProvenanceSection>
      <ProvenanceSection dataClass="historical" title="Decadal climate baseline" attribution={null}>
        <EmptyChart
          title="Decade-over-decade baseline"
          reason="No multi-decade archive series is retrieved for a comparison."
          height={200}
        />
      </ProvenanceSection>
    </div>
  );
}
