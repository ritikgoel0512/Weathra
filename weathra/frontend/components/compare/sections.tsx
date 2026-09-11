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

import Link from "next/link";
import { useId, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AttributionFooter,
  Badge,
  DataClassBadge,
  MethodNote,
  EmptyChart,
  LocationImage,
  Meter,
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
import { differencesBetween } from "@/lib/comparison/differences";
import { formatReading, measureLabel } from "@/lib/dashboard/briefing";
import { unavailableReason } from "@/lib/historical/analysis";
import { periodLabel, periodSentence } from "@/lib/historical/analysis";
import { placeLabel } from "@/lib/locations/place";

import styles from "./compare.module.css";

/* ------------------------------------------------------------------ one candidate */

/** One measure's part in a composite score: which way it counts, how much, and to what effect. */
function Contribution({
  contribution,
}: {
  readonly contribution: ComponentContribution;
}): ReactNode {
  return (
    <li className={styles.contribution}>
      <span className={styles.contributionHead}>
        <span className={styles.figureLabel}>
          {measureLabel(contribution.measure)}
        </span>
        <span className={styles.figureValue}>
          {Math.round(contribution.value * 10) / 10}
          <span className={styles.figureUnit}> {contribution.unit}</span>
        </span>
      </span>
      <span className={styles.note}>
        {contribution.direction === "above"
          ? "Higher scores better"
          : "Lower scores better"}{" "}
        · {weightPercentage(contribution.weight)} of the score · added{" "}
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
 *
 * **The headline is not repeated in the list below it**, which is finding 4.3 of the runtime
 * fidelity audit of 2026-09-08. `comparableFigure` takes the *first* supporting statistic, and the
 * figures list then drew that same statistic again — 18.2 °C as the headline, and "mean ·
 * Temperature 18.2 °C" three lines under it. The card now states each figure once: the headline
 * carries the statistic's own name and its method note, and the list holds the statistics the
 * headline is not. A card whose only supporting statistic *is* the headline renders no list rather
 * than an empty one.
 */
export function CandidateCard({
  candidate,
  criterion,
  sharesRank,
}: CandidateCardProps): ReactNode {
  const figure = comparableFigure(candidate);
  const composite = isComposite(candidate);

  /*
   * The same entry `comparableFigure` reads, so the two cannot drift: whatever it promotes to the
   * headline is exactly what the list leaves out. A composite card has no promoted entry — its
   * headline is the 0-1 score, which is in no supporting list — so it keeps all of them.
   */
  const supporting = candidate.supporting ?? [];
  const promoted = composite || figure === null ? null : supporting[0];
  const remaining =
    promoted === undefined || promoted === null
      ? supporting
      : supporting.slice(1);

  return (
    <article
      className={styles.candidate}
      data-candidate="true"
      data-rank={candidate.rank}
    >
      {/*
        `04-compare-cities.png` gives each compared city a photographic banner with its name and
        status on it. `LocationImage` holds that frame whether a photograph is present or not — see
        `public/locations/README.md`.
      */}
      <LocationImage
        displayName={placeLabel(candidate.location) ?? candidate.label}
        latitude={candidate.location.latitude}
        longitude={candidate.location.longitude}
        variant="banner"
      >
        <header className={styles.candidateHead}>
          <span className={styles.rank} aria-label={`Rank ${candidate.rank}`}>
            #{candidate.rank}
          </span>
          <h3 className={styles.candidateName}>{candidate.label}</h3>
          {sharesRank || candidate.tied ? (
            <Badge tone="neutral">Tied</Badge>
          ) : null}
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
            {figure.unit ? (
              <span className={styles.figureUnit}> {figure.unit}</span>
            ) : null}
          </span>
          <span className={styles.note}>
            {/*
              The statistic's own name, taken off the entry the list no longer draws — finding
              3.2's shape on the other screen: "Mean temperature (mean)" rather than a bare measure
              beside a figure nobody can tell the statistic of.
            */}
            {promoted
              ? `${measureLabel(promoted.measure)} (${promoted.statistic.replace(/_/g, " ")})`
              : figure.label}{" "}
            · ranked by {criterionLabel(criterion).toLowerCase()}
          </span>
          {/* The promoted entry's provenance travels with it, so nothing moved off the card. */}
          {promoted ? (
            <MethodNote
              method={promoted.method}
              pointsUsed={promoted.points_used}
              pointsExcluded={promoted.points_excluded}
              unit={promoted.unit || null}
            />
          ) : null}
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
              <Contribution
                key={`${contribution.measure}-${index}`}
                contribution={contribution}
              />
            ))}
          </ul>
        </>
      ) : remaining.length === 0 ? null : (
        <ul className={styles.figures}>
          {remaining.map((entry, index) => {
            const value = formatStatistic(entry);
            return (
              <li className={styles.figure} key={`${entry.statistic}-${index}`}>
                <span className={styles.figureLabel}>
                  {entry.statistic.replace(/_/g, " ")} ·{" "}
                  {measureLabel(entry.measure)}
                </span>
                {value === null ? (
                  <span className={styles.note}>
                    Not computable:{" "}
                    {entry.reason ?? "the backend reported no value."}
                  </span>
                ) : (
                  <span className={styles.figureValue}>{value}</span>
                )}
                <MethodNote
                  method={entry.method}
                  pointsUsed={entry.points_used}
                  pointsExcluded={entry.points_excluded}
                  unit={entry.unit || null}
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
      .filter(
        (rank, _index, ranks) =>
          ranks.filter((other) => other === rank).length > 1,
      ),
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
      {/*
        **The places first, then the account of how they were ranked.** `04-compare-cities.png`
        opens with the two locations side by side — each with its own image, temperature and
        conditions — and carries no ranking chart at the top at all. Production opened with a
        full-width bar chart of two bars, which is a rendering of the same two numbers the cards
        already carry, sized to dominate the screen. The chart is not deleted: it moves under the
        cards with the shared basis, where it explains the ranking rather than replacing it.
      */}
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

      {children}
    </ProvenanceSection>
  );
}

/* ---------------------------------------------------------------- the shared basis */

/** What every candidate was measured by, so the ranking can be checked for fairness. */
export function SharedBasis({
  result,
}: {
  readonly result: ComparisonResult;
}): ReactNode {
  const sourceClass = dataClassFor(result.data_class);

  return (
    <section
      className={styles.basis}
      aria-label="The basis every candidate shares"
    >
      <p className={styles.basisHead}>
        <span className={styles.noteStrong}>
          Every candidate was measured the same way
        </span>
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
export function Excluded({
  result,
}: {
  readonly result: ComparisonResult;
}): ReactNode {
  const excluded = result.excluded ?? [];
  if (excluded.length === 0) return null;

  return (
    <section
      className={styles.excluded}
      aria-label="Locations left out of the ranking"
    >
      {/* Announced when it appears, without the section ceasing to be a landmark to navigate to. */}
      <p className={styles.noteStrong} role="status">
        {excluded.length}{" "}
        {excluded.length === 1 ? "location was" : "locations were"} left out of
        this ranking
      </p>
      {/*
        The failure code is an attribute, not a sentence. `location_not_found` is the stable half of
        the error contract and belongs to whoever debugs this; the reason beside it is the half
        written for the person who typed the name. The runtime audit of 2026-09-08 caught the
        identifier being read out to that person as though it were the explanation.
      */}
      <ul className={styles.excludedList}>
        {excluded.map((candidate) => (
          <li
            className={styles.excludedItem}
            data-failure-code={candidate.code}
            key={`${candidate.label}-${candidate.code}`}
          >
            <span className={styles.excludedName}>{candidate.label}</span>
            <span className={styles.note}>{candidate.reason}</span>
          </li>
        ))}
      </ul>
      <AttributionFooter
        attribution={{ provider: result.provider, location: null }}
      >
        <p className={styles.note}>
          These places are not in the ranking above. Nothing has been estimated
          in their place.
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
export function DifferentialMatrix({
  result,
}: {
  readonly result: ComparisonResult;
}): ReactNode {
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
    for (const entry of candidate.supporting ?? [])
      fromCandidates.add(entry.statistic);
  }
  const statistics =
    fromCandidates.size > 0
      ? [...fromCandidates]
      : (result.statistics_applied ?? []);

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
          This comparison reported no supporting figures to lay out, so there is
          nothing to tabulate beneath the ranking.
        </p>
      ) : (
        // The box is the screen's to supply: `ScrollRegion` measures and adds the tab stop, and
        // without a container the table widens the page instead of scrolling in its card.
        <ScrollRegion
          label="Figures behind the ranking"
          className={styles.tableScroll}
        >
          <table className={styles.matrix}>
            <caption className={styles.matrixCaption}>
              Each statistic the comparison applied, for each place, over the
              shared window.
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
                          <span className={styles.matrixAbsent}>
                            {unavailableReason(found)}
                          </span>
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
 *
 * **What the audit of 2026-09-08 found, and what changed** — finding 4.6: the panel drew six
 * machinery rows, three of which `SharedBasis` states verbatim higher up the same screen, and two
 * of which read as raw API enums (`warmest`, `forecast`) in a sentence addressed to a person. That
 * is finding 2.3's mistake on the Analyst — the same fact twice on one screen — in the other
 * screen's clothes.
 *
 * So: **one sentence on the face**, naming the criterion, the mode and how many places, and the
 * residual fields behind a disclosure on the same panel. The three rows `SharedBasis` already
 * carries — statistics applied, tie tolerance, and the local-time basis — are *not* folded away;
 * they are dropped from here, because they are stated in full a few centimetres above and the
 * screen loses nothing by not saying them twice. Nothing this panel was the only home of has moved.
 */

/**
 * What the comparison held constant and what it varied — the API's `mode`, said as a person would.
 *
 * An unrecognised mode is reported as it arrives rather than dropped: a backend that grew a third
 * one should show it, not hide it behind a screen that only knows two.
 */
function modeLabel(mode: string): string {
  if (mode === "locations") return "Several places over one window";
  if (mode === "days") return "One place over several days";
  return mode.replace(/_/g, " ");
}

/**
 * "Comparison Synthesis Summary" — the region `04-compare-cities.png` closes on. Task 34.31.
 *
 * Production closed on two technical cards instead: "Every figure behind the ranking" over a
 * statistic-by-place matrix, and "How this comparison was made" opening with the word
 * *Deterministic:*. Both are real and both are worth keeping; neither is a finish. The artifact's
 * own close is a paragraph a person reads and two actions — so this states the comparison's result
 * in a sentence, and puts every one of those figures and every word of that methodology one press
 * below it.
 *
 * The artifact's paragraph attributes the divergence to the North Atlantic Jet Stream and
 * recommends drainage monitoring to city planners. Weathra establishes no causality from a
 * comparison of two windows and makes no recommendation from one; the sentence here says what was
 * measured and by how much, which is the whole of what the response supports. Its two actions are
 * `EXPORT PDF` and `RECALIBRATE MODELS` — Weathra exports no PDF and recalibrates no model, so the
 * action here is the evidence record, which it does have.
 */
export function ComparisonSummary({
  result,
  children,
}: {
  readonly result: ComparisonResult;
  /** The technical cards, folded into this one's disclosures rather than trailing it. */
  readonly children?: ReactNode;
}): ReactNode {
  const compared = (result.candidates ?? []).length;
  const ranked = [...(result.candidates ?? [])].sort((one, other) => one.rank - other.rank);
  const leading = ranked[0];
  const trailing = ranked[1];
  const headline = differencesBetween(leading, trailing)[0] ?? null;

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Comparison Summary"
      eyebrow="What this comparison found"
      headingLevel={2}
      attribution={null}
    >
      <p className={styles.summaryLead}>
        {leading && trailing && headline ? (
          <>
            Over {periodSentence(result.period)}, {leading.label} leads on{" "}
            {criterionLabel(result.criterion).toLowerCase()} by{" "}
            {formatReading({ value: Math.abs(headline.value), unit: headline.unit })} of{" "}
            {measureLabel(headline.measure).toLowerCase()}.
          </>
        ) : (
          <>
            {compared} {compared === 1 ? "place was" : "places were"} ranked by{" "}
            {criterionLabel(result.criterion).toLowerCase()} over {periodSentence(result.period)}.
          </>
        )}
      </p>

      <div className={styles.summaryActions}>
        <Link className={styles.summaryAction} href="/evidence">
          View agent evidence
        </Link>
      </div>

      {/*
        Everything the screen used to close on, kept whole and moved behind one control each:
        the ranking chart, the per-place figures, the shared basis, and the fields the comparison
        reported. Nothing here is summarised away — a person checking a ranking gets all of it.
      */}
      <div className={styles.summaryDetails}>{children}</div>

      <details className={styles.summaryDisclosure}>
        <summary className={styles.summarySummary}>How this comparison was made</summary>
        <p className={styles.note}>
          Deterministic: {compared} {compared === 1 ? "candidate" : "candidates"} ranked by{" "}
          {criterionLabel(result.criterion).toLowerCase()}, over {periodLabel(result.period)}. No
          model interpretation and no confidence score entered the ranking.
        </p>
        <dl className={styles.summaryFacts}>
          <div className={styles.summaryFact}>
            <dt>Criterion</dt>
            <dd>{criterionLabel(result.criterion)}</dd>
          </div>
          <div className={styles.summaryFact}>
            <dt>Mode</dt>
            <dd>{modeLabel(result.mode)}</dd>
          </div>
          <div className={styles.summaryFact}>
            <dt>Candidates compared</dt>
            <dd>{compared}</dd>
          </div>
        </dl>
        {/*
          The composite criterion's weighting statement. `SharedBasis` prints it too, and this is
          the one duplicate kept: whose heuristic the weights are is a disclosure obligation, and an
          obligation is not something to state once and hope the reader was looking.
        */}
        {result.weighting_disclosure ? (
          <p className={styles.note}>{result.weighting_disclosure}</p>
        ) : null}
      </details>
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
export interface PulseSeries {
  readonly label: string;
  readonly points: readonly { readonly at: string; readonly value: number | null }[];
}

/**
 * "Climate Pulse Differential" — the artifact's intra-day plot with one line per compared place.
 *
 * This was an empty frame with the reason "no hourly series is retrieved for a comparison", and
 * that reason had stopped being true. The comparison *response* carries no series — it carries
 * ranked figures and, since this pass, two derived statistics — but the screen already fetches
 * each compared place's own forecast to build the day matrix below, and those forecasts carry the
 * hourly series. The data was one component away the whole time.
 *
 * Each line is one place's `hourly` temperature, from its own `GET /weather/forecast`, plotted
 * against the instant. No resampling and no interpolation: an hour a provider did not report is a
 * gap in that line, which is what makes two places of unequal coverage legible rather than
 * silently smoothed into agreement.
 *
 * Up to four lines, matching the four forecasts the matrix already asks for. The artifact draws
 * two; beyond four the plot stops being readable and the ranking above is the answer anyway.
 */
function PulseTooltip({
  active,
  payload,
  label,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { readonly name?: string; readonly value?: number | null }[];
  readonly label?: string | number;
}): ReactNode {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipName}>{String(label)}</p>
      {payload.map((entry) => (
        <p className={styles.tooltipValue} key={entry.name}>
          {entry.name}: {typeof entry.value === "number" ? entry.value.toFixed(1) : "not reported"}
        </p>
      ))}
    </div>
  );
}

export function ClimatePulseDifferential({
  series,
  unit,
}: {
  readonly series: readonly PulseSeries[];
  readonly unit: string | null;
}): ReactNode {
  const described = useId();
  const drawable = series.filter((entry) =>
    entry.points.some((point) => point.value !== null),
  );

  if (drawable.length === 0) {
    return (
      <EmptyChart
        title="Intra-day temperature by place"
        reason="No place's provider reported an hourly series for this window."
        height={200}
      />
    );
  }

  // One row per instant any place reported, so two lines of unequal coverage stay aligned by time.
  const instants = [
    ...new Set(drawable.flatMap((entry) => entry.points.map((point) => point.at))),
  ].sort();
  const rows = instants.map((at) => {
    const row: Record<string, string | number | null> = { at, label: hourLabel(at) };
    for (const entry of drawable) {
      row[entry.label] = entry.points.find((point) => point.at === at)?.value ?? null;
    }
    return row;
  });

  return (
    <figure className={styles.pulse}>
      <div
        className={styles.pulsePlot}
        role="img"
        aria-label={`Intra-day temperature for ${drawable.map((entry) => entry.label).join(" and ")}. The figures are in the matrix below.`}
        aria-describedby={described}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            {/* Dashed hairlines only. A solid grid competes with the two curves drawn on it. */}
            <CartesianGrid
              stroke="var(--color-border-subtle)"
              strokeDasharray="2 6"
              vertical={false}
            />
            <XAxis dataKey="label" {...PULSE_AXIS} minTickGap={28} />
            {/*
              The unit is in the caption under the card, not rotated down the axis. A vertical `°C`
              is the engineering-plot tell the frozen Dashboard's own chart dropped for the same
              reason, and it cost 52 pixels of plot width to say one thing twice.
            */}
            <YAxis {...PULSE_AXIS} width={40} />
            <Tooltip cursor={{ stroke: "var(--color-border-strong)" }} content={<PulseTooltip />} />
            {drawable.map((entry, index) => (
              <Line
                key={entry.label}
                type="monotone"
                dataKey={entry.label}
                name={entry.label}
                stroke={PULSE_COLOURS[index % PULSE_COLOURS.length]}
                strokeWidth={2}
                dot={false}
                // A reported gap stays a gap: joining across it would draw a reading nobody made.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className={styles.pulseNote} id={described}>
        {/*
          One clause. It read as two sentences of chart methodology across the widest card on the
          screen; the gap rule is still stated, because a broken line that does not say why is a
          misleading chart.
        */}
        One line per place from its own hourly forecast{unit ? ` · ${unit}` : ""} · an unreported
        hour is a gap, never a value between its neighbours
      </figcaption>
    </figure>
  );
}

/**
 * "Climate Pulse Differential" — the artifact's wide lower chart, beside the metrics rail.
 *
 * The chart itself is unchanged in what it plots: one line per compared place, from that place's
 * own hourly forecast, with a reported gap left as a gap. What task 34.31 changed is the frame
 * around it, to the standard the frozen Dashboard's own Climate Pulse set — the legend on the
 * card's header rule rather than under the plot, a dashed hairline grid rather than a solid one,
 * the unit stated in the caption rather than rotated down the axis, and the caption itself one
 * clause instead of two sentences of chart methodology.
 */
export function ClimatePulseCard({
  pulse = [],
  pulseUnit = null,
  children,
}: {
  readonly pulse?: readonly PulseSeries[];
  readonly pulseUnit?: string | null;
  /** The deterministic metrics rail, which sits beside the chart in the artifact. */
  readonly children?: ReactNode;
} = {}): ReactNode {
  const drawable = pulse.filter((entry) => entry.points.some((point) => point.value !== null));

  return (
    <div className={styles.pulseBand}>
      <ProvenanceSection
        dataClass="forecast"
        title="Climate Pulse Differential"
        eyebrow="Intra-day temperature comparison"
        attribution={null}
        action={
          drawable.length > 0 ? (
            <span className={styles.pulseLegend}>
              {drawable.map((entry, index) => (
                <span className={styles.pulseLegendItem} key={entry.label} data-series={index}>
                  {entry.label.split(",")[0]}
                </span>
              ))}
            </span>
          ) : null
        }
      >
        <ClimatePulseDifferential series={pulse} unit={pulseUnit} />
      </ProvenanceSection>

      {children}
    </div>
  );
}

/** Axis styling, shared with every other chart in the product so the set reads as one. */
const PULSE_AXIS = {
  stroke: "var(--color-border-strong)",
  tick: { fill: "var(--color-text-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

/** One per compared place, in rank order. Four, because the matrix asks for four forecasts. */
const PULSE_COLOURS = [
  "var(--color-accent)",
  "var(--color-class-historical)",
  "var(--color-class-analytics)",
  "var(--color-class-forecast)",
] as const;

/** An instant as a short axis label, in the reader's locale, at the resolution a day needs. */
function hourLabel(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? at
    : parsed.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit" });
}

/* ------------------------------------------------- the artifact's two deterministic bars */

/**
 * "Correlation score" and "Data density" — the two bars `04-compare-cities.png` draws in its
 * "Synthesis confidence" panel.
 *
 * The artifact puts them inside its Comparison Intelligence card, under a heading that attributes
 * them to a model's synthesis. They are not that. Both are properties of the retrieved data,
 * computed by `weathra/analytics/association.py` and returned on the comparison itself, so they
 * live in a panel of their own badged ANALYTICS — the same figures, at the same place in the
 * reading order, without the borrowed authority of the word *confidence*.
 *
 * # Where each figure comes from
 *
 * * **Correlation** — Pearson's *r* between the two compared places' temperature trajectories,
 *   paired on UTC instant, over the hourly series where the provider supplied one. `result.correlation`.
 * * **Data density** — the instants every candidate reported a value for, over the instants the
 *   window asked for. `result.data_density`.
 *
 * # What the bars do with them
 *
 * The correlation bar's **length is |r|** and its **caption is the signed coefficient**, because
 * a bar cannot show a negative and a length alone cannot distinguish two places that move together
 * from two that move oppositely. Both are shown; neither is shown alone. `r = -0.9` draws a long
 * bar and reads "−0.90 · moves oppositely", which is the honest pair.
 *
 * A `not_computable` figure draws **no bar and the backend's own reason** — never a zero-length bar,
 * which reads as "measured, and it is nothing". The correlation is *absent entirely* above two
 * candidates, because a single coefficient describes one pair and three places have three; the
 * panel says so rather than showing a refusal, since nothing was refused.
 */
function correlationSense(value: number): string {
  // Wording only. The coefficient beside it is the figure; this says which way to read it.
  if (value >= 0.7) return "move closely together";
  if (value >= 0.3) return "move loosely together";
  if (value > -0.3) return "move largely independently";
  if (value > -0.7) return "move loosely opposite";
  return "move closely opposite";
}

export function DeterministicAssociation({
  result,
}: {
  readonly result: ComparisonResult;
}): ReactNode {
  const correlation = result.correlation ?? null;
  const density = result.data_density ?? null;

  // Nothing computed and nothing to explain: the panel is absent rather than empty. A card whose
  // only content is "not available" twice is the shape `sections.tsx` already refuses elsewhere.
  if (correlation === null && density === null) return null;

  const coefficient =
    correlation !== null && typeof correlation.value === "number"
      ? correlation.value
      : null;
  const densityValue =
    density !== null && typeof density.value === "number"
      ? density.value
      : null;

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="How the places moved, and how much was reported"
      headingLevel={2}
    >
      <ul className={styles.association}>
        <li className={styles.associationItem}>
          <Meter
            label="Correlation"
            /* |r|, because a bar has no direction. The sign is in the note beneath it. */
            value={coefficient === null ? null : Math.abs(coefficient)}
            valueLabel={
              coefficient === null ? undefined : coefficient.toFixed(2)
            }
            unavailable={
              correlation === null ? "Two places only" : "Not computable"
            }
            note={
              coefficient !== null ? (
                <>they {correlationSense(coefficient)}</>
              ) : correlation === null ? (
                // Not a refusal: a single coefficient is a pair statistic, and this comparison
                // has more than one pair. Saying "not computable" would imply it was attempted.
                "A correlation describes one pair of places. Compare two to see it."
              ) : (
                <span className={styles.associationReason}>
                  {correlation.reason}
                </span>
              )
            }
          />
          {correlation !== null && coefficient !== null ? (
            /*
             * Folded away. `specs/deterministic-analytics` requires the arithmetic to be
             * *available* wherever the figure is, not printed beside it — and the Pearson formula
             * is three lines of algebra, which next to a bar is the wall of prose the artifact's
             * own composition does not have. One press, and it is the backend's own words.
             */
            <details className={styles.associationMethod}>
              <summary>How it was computed</summary>
              <MethodNote
                method={correlation.method}
                pointsUsed={correlation.points_used}
                pointsExcluded={correlation.points_excluded}
                compact
              />
            </details>
          ) : null}
        </li>

        <li className={styles.associationItem}>
          <Meter
            label="Data density"
            value={densityValue === null ? null : densityValue / 100}
            unavailable="Not computable"
            note={
              densityValue !== null ? (
                <>of the window every place reported</>
              ) : (
                <span className={styles.associationReason}>
                  {density?.reason}
                </span>
              )
            }
          />
          {density !== null && densityValue !== null ? (
            <details className={styles.associationMethod}>
              <summary>How it was computed</summary>
              <MethodNote
                method={density.method}
                pointsUsed={density.points_used}
                pointsExcluded={density.points_excluded}
                compact
              />
            </details>
          ) : null}
        </li>
      </ul>
    </ProvenanceSection>
  );
}
