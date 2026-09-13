"use client";

/**
 * The Weather Intelligence Report's regions, against
 * `docs/design/screens/12-weather-intelligence-report.png`.
 *
 * The artifact is an instrument: a contained header band, a hero that states a conclusion in one
 * line, a column of glyphed metric tiles beside it, a week of day cards, three change notes, one
 * chart under a technical title, two context cards, a completed synthesis with evidence chips, a
 * grounding panel and a status strip. The screen had the same *information* and almost none of that
 * treatment — no glyphs, sentence-case SaaS headings, a photograph where the conclusion belongs,
 * and a call-to-action where the synthesis belongs.
 *
 * Three rules hold across everything below:
 *
 * **The class badge tells the truth about what produced the content.** The hero carries ANALYTICS,
 * not AI INTERPRETATION, because its headline and its figures are computed deterministically and no
 * model is involved — the artifact attributes that same block to a neural agent, and
 * `specs/web-ui` forbids a design that implies a language model produced a number. AI
 * INTERPRETATION appears exactly once, on the synthesis the model actually wrote.
 *
 * **Every glyph is decorative.** The label beside it names the figure; `./icons.tsx` states why.
 *
 * **A region the backend did not answer is not drawn, and never drawn empty.** The attention card
 * is absent unless an entry was flagged; a window with no earlier retrieval gets two compact lines
 * rather than a panel-sized paragraph.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import {
  DataClassBadge,
  ErrorState,
  Meter,
  Skeleton,
  UncertaintyIndicator,
  WeatherIcon,
  formatInstant,
} from "@/components/ui";
import type {
  AnalysisResponse,
  AnswerEnvelope,
  ForecastResponse,
  Location,
  StatisticResult,
} from "@/lib/api/schema";
import { formatReading, measureLabel, statisticPhrase } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import type { ViewFailure } from "@/lib/query/state";
import {
  REPORT_HORIZONS,
  figureOf,
  type AnomalyAttention,
  type ChangedView,
  type CurrentTiles,
  type FooterState,
  type GroundingRow,
  type HistoricalContextView,
  type OutlookDay,
  type ReportFigure,
  type ReportHeadline,
} from "@/lib/report/view-model";

import { DeviationChart, type DeviationPoint } from "./charts";
import { ReportIcon, type ReportIconName } from "./icons";
import styles from "./report.module.css";

/* ------------------------------------------------------------------- region */

/**
 * One region of the report, at one of the artifact's three card weights.
 *
 * `level` is the artifact's own hierarchy rather than a decoration: `lead` is the header, the hero
 * and the synthesis — the three blocks it fills a shade lighter and edges in accent; `panel` is
 * everything that holds a figure or a chart; the third weight is the inset tiles inside them, which
 * are styled where they are drawn. A screen picks a level, never a colour.
 */
export function Region({
  id,
  title,
  icon,
  subtitle,
  badges,
  action,
  level = "panel",
  tone,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly icon?: ReportIconName;
  readonly subtitle?: ReactNode;
  readonly badges?: ReactNode;
  /** A control belonging to this region only. Never the screen's primary action. */
  readonly action?: ReactNode;
  readonly level?: "lead" | "panel";
  readonly tone?: "alert";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={styles.region} data-level={level} data-tone={tone} aria-labelledby={id}>
      <div className={styles.regionHead}>
        <div className={styles.regionHeadings}>
          <h2 className={styles.regionTitle} id={id}>
            {icon ? (
              <span className={styles.regionIcon}>
                <ReportIcon name={icon} size={15} />
              </span>
            ) : null}
            {title}
          </h2>
          {subtitle ? <p className={styles.regionSubtitle}>{subtitle}</p> : null}
        </div>
        {badges || action ? (
          <div className={styles.regionAside}>
            {badges}
            {action}
          </div>
        ) : null}
      </div>
      <div className={styles.regionBody}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- header */

/**
 * The report's own header band — the artifact's top card.
 *
 * It gives this one contained block: a class badge and a report reference on the kicker line, the
 * title in report weight, one line of scope, and on the right the window control and the sync
 * stamp. The screen had four stacked rows and then a full-width place disclosure before the first
 * figure.
 *
 * **No export, and the reference is real or absent.** There is no report export, so no button
 * claims one. The artifact's `REPORT ID: WX-INTEL-882-B` has no equivalent either — Weathra issues
 * no report and stores none — but the synthesis run *is* stored under an evidence id, and naming
 * the report by the record somebody can actually audit is the honest version of that field. Before
 * that record exists the slot is empty rather than filled with a placeholder.
 */
export function ReportHeader({
  location,
  scope,
  reference,
  horizon,
  onHorizon,
  retrievedAt,
  chooser,
}: {
  readonly location: Location;
  /** One line naming what the report covers. Fixed copy about the report, not about the weather. */
  readonly scope: string;
  readonly reference: string | null;
  readonly horizon: string;
  readonly onHorizon: (value: string) => void;
  readonly retrievedAt: string | null;
  readonly chooser: ReactNode;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.headerKicker}>
          <DataClassBadge dataClass="analytics" />
          {reference ? (
            <span className={styles.headerReference}>Report ref · {reference}</span>
          ) : null}
        </div>
        <h1 className={styles.title}>Weather Intelligence Report</h1>
        <p className={styles.lede}>
          <span className={styles.ledePlace}>{friendlyName(location)}</span>
          {" — "}
          {scope}
        </p>
      </div>

      <div className={styles.headerControls}>
        <div className={styles.headerRow}>
          <details className={styles.placeControl}>
            <summary className={styles.placeSummary}>
              <span className={styles.placeName}>{friendlyName(location)}</span>
              <span className={styles.placeHint}>Change place</span>
            </summary>
            {chooser}
          </details>

          {/*
            A radio group rather than four buttons: the four are one choice, and a keyboard reaches
            the group once and then moves inside it — which is what a segmented control is for. Same
            control, same markup, as the Forecast Explorer's.
          */}
          <fieldset className={styles.horizon}>
            <legend className="weathra-visually-hidden">Report window</legend>
            {REPORT_HORIZONS.map((entry) => (
              <label className={styles.horizonOption} key={entry.value}>
                <input
                  type="radio"
                  name="report-horizon"
                  value={entry.value}
                  checked={horizon === entry.value}
                  onChange={() => onHorizon(entry.value)}
                />
                <span aria-hidden="true">{entry.label}</span>
                <span className="weathra-visually-hidden">{entry.name}</span>
              </label>
            ))}
          </fieldset>
        </div>

        {retrievedAt ? (
          <p className={styles.headerStamp}>Sync · {formatInstant(retrievedAt)}</p>
        ) : null}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------- hero */

/**
 * The report's conclusion, first: one statement, the sentences behind it, three figures.
 *
 * The artifact's hero is an alert-weight statement over a dark panel with a row of three figure
 * cards at its foot. The screen had a 220-pixel photograph of the city in that position, with the
 * current temperature over it — a picture where the conclusion belongs, and the one block a reader
 * scans first spent on the one thing they already know. The photograph is gone; the reading it
 * carried is the first of the six tiles beside this card.
 *
 * The badge is ANALYTICS and the kicker says deterministic, because that is what produced both the
 * headline and the figures. The artifact's "NEURAL AGENT V4.8 · GROUNDED SYNTHESIS" belongs to the
 * card at the foot of the report, where a model genuinely wrote the prose.
 */
export function IntelligenceHero({
  headline,
  figures,
}: {
  readonly headline: ReportHeadline;
  readonly figures: readonly ReportFigure[];
}): ReactNode {
  return (
    <section className={styles.hero} aria-labelledby="report-hero-title">
      <div className={styles.heroKicker}>
        <DataClassBadge dataClass="analytics" />
        <span className={styles.heroKickerText}>Deterministic synthesis</span>
      </div>

      <h2 className={styles.heroTitle} id="report-hero-title">
        {headline.headline}
      </h2>

      {headline.support.length > 0 ? (
        <p className={styles.heroSupport}>{headline.support.join(" ")}</p>
      ) : null}

      {figures.length > 0 ? (
        <div className={styles.heroFigures}>
          {figures.map((figure) => (
            <div className={styles.heroFigure} key={figure.key}>
              <span className={styles.heroFigureLabel}>
                {figure.icon ? (
                  <span className={styles.heroFigureIcon}>
                    <ReportIcon name={figure.icon} size={14} />
                  </span>
                ) : null}
                {figure.label}
              </span>
              <span className={styles.heroFigureValue}>{figure.value}</span>
              {figure.note ? (
                <span className={styles.heroFigureNote}>{figure.note}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------- current conditions */

/**
 * The artifact's tile column: six observed measures, each with its glyph, its class and its figure.
 *
 * Bare tiles rather than a titled card, which is how the artifact draws them — the column *is* the
 * region, and a card around it would add a frame the artifact does not have and a heading the
 * badges already supply. The glyph and the badge share the tile's top line and the measure name has
 * the next one to itself, so a long name never collides with the chip beside it.
 *
 * Six is the cap, not the count: `currentTilesFrom` orders the provider's measures the way the
 * artifact orders its tiles and hands back whatever exceeded six, which goes behind the disclosure
 * at the foot of this column. Nothing the provider reported is dropped, and nothing it did not
 * report is drawn as an empty box.
 */
export function ConditionTiles({
  tiles,
  observedAt,
}: {
  readonly tiles: CurrentTiles;
  readonly observedAt: string | null;
}): ReactNode {
  if (tiles.shown.length === 0) return null;

  return (
    <section className={styles.conditions} aria-label="Current conditions">
      <ul className={styles.conditionGrid}>
        {tiles.shown.map((tile) => (
          <li className={styles.conditionTile} key={tile.key}>
            <span className={styles.conditionHead}>
              {tile.icon ? (
                <span className={styles.conditionIcon}>
                  <ReportIcon name={tile.icon} size={16} />
                </span>
              ) : (
                <span />
              )}
              <DataClassBadge dataClass="observed" />
            </span>
            <span className={styles.conditionLabel}>{tile.label}</span>
            <span className={styles.conditionValue}>
              {tile.value}
              {tile.unit ? <span className={styles.conditionUnit}>{tile.unit}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.conditionFoot}>
        {observedAt ? (
          <span className={styles.conditionStamp}>Observed {formatInstant(observedAt)}</span>
        ) : null}
        {tiles.rest.length > 0 ? (
          <details className={styles.disclosure}>
            <summary className={styles.disclosureSummary}>
              More conditions ({tiles.rest.length})
            </summary>
            <ul className={styles.disclosureList}>
              {tiles.rest.map((reading) => (
                <li key={reading.key}>
                  <span>{measureLabel(reading.key)}</span>
                  <span className={styles.disclosureValue}>{formatReading(reading)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- day strip */

/**
 * The outlook as the artifact's row of day cards: the day, the sky, the high, the low, the rain.
 *
 * The glyph is the provider's *own* dominant condition code translated through the product's one
 * condition vocabulary — never a sky inferred from a figure. A day the provider gave no code for
 * gets no glyph, and a day it gave no high for keeps its card and names what it did report rather
 * than being dropped, which would silently shorten the week. The leading day carries the artifact's
 * accent.
 */
export function OutlookStrip({ days }: { readonly days: readonly OutlookDay[] }): ReactNode {
  return (
    <ol className={styles.days}>
      {days.map((day) => (
        <li className={styles.day} key={day.date} data-leading={day.leading ? "true" : undefined}>
          <span className={styles.dayName}>{day.weekday}</span>
          <span className={styles.dayDate}>{day.date.slice(5)}</span>

          <span className={styles.dayIcon}>
            <WeatherIcon condition={day.condition} size={24} />
          </span>

          {/*
            The high leads by size and the low sits under it unlabelled — which only reads as a low
            while there is a larger figure above it. A day with no high reported names its low
            instead, so the one number on the card is never mistaken for the day's temperature.
          */}
          {day.high ? (
            <>
              <span className={styles.dayHigh}>{formatReading(day.high)}</span>
              {day.low ? <span className={styles.dayLow}>{formatReading(day.low)}</span> : null}
            </>
          ) : (
            <>
              <span className={styles.dayUnreported}>No high reported</span>
              {day.low ? (
                <span className={styles.dayLow}>Low {formatReading(day.low)}</span>
              ) : null}
            </>
          )}

          {day.precipitation ? (
            <span className={styles.dayPrecipitation} data-level={day.precipitation.level}>
              {day.precipitation.caption}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------ what changed */

/**
 * The artifact's "What changed?" column: up to three movement cards, each with its own subject.
 *
 * The endpoint returns one row per day per measure — dozens across a fortnight, and the screen
 * listed every one of them beside a week of cards. Three is what the artifact draws and three is
 * what this draws, material movements first, each with the sentence the backend wrote for it.
 *
 * **The first-retrieval state is two lines, not a panel of prose.** A window nothing has been
 * retrieved for before has nothing to be compared against; that is a fact about the record, and the
 * screen filled a whole column with a paragraph saying so. It says it in a sentence now, and says
 * what happens next.
 */
export function WhatChangedPanel({ changed }: { readonly changed: ChangedView | null }): ReactNode {
  if (changed === null || !changed.comparable) {
    return (
      <div className={styles.moved}>
        <p className={styles.movedStatement}>No earlier retrieval of this window is stored yet.</p>
        <p className={styles.quiet}>This report is the baseline the next one is compared against.</p>
      </div>
    );
  }

  return (
    <div className={styles.moved}>
      <p className={styles.movedStatement}>{changed.statement}</p>

      {changed.notes.length > 0 ? (
        <ul className={styles.movedList}>
          {changed.notes.map((note) => (
            <li className={styles.movedNote} key={note.key}>
              <span className={styles.movedHead}>
                <span className={styles.movedIcon}>
                  <ReportIcon name={note.icon} size={14} />
                </span>
                <span className={styles.movedTitle}>{note.title}</span>
                <span className={styles.movedValue} data-tone={note.tone}>
                  {note.value}
                </span>
              </span>
              <span className={styles.movedStatementLine}>
                {note.statement}
                {note.material ? "" : " Inside the margin."}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {changed.hidden > 0 ? (
        <p className={styles.quiet}>
          {changed.hidden} further movement{changed.hidden === 1 ? "" : "s"} in this window{" "}
          {changed.hidden === 1 ? "is" : "are"} in Deep dive.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- the chart stats */

/** The four figures the artifact prints under its chart. */
export function ChartStats({ stats }: { readonly stats: readonly ReportFigure[] }): ReactNode {
  if (stats.length === 0) return null;

  return (
    <dl className={styles.chartStats}>
      {stats.map((stat) => (
        <div className={styles.chartStat} key={stat.key}>
          <dt className={styles.chartStatLabel}>{stat.label}</dt>
          <dd className={styles.chartStatValue}>
            {stat.value}
            {stat.delta ? (
              <span className={styles.chartStatDelta} data-tone={stat.delta.tone}>
                {stat.delta.text}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------- historical context */

/**
 * The artifact's "Historical Context" card: one short line, three figures, one coverage bar.
 *
 * Its decadal stability index and model-alignment bars are refused — neither is computed and both
 * name a capability in order to display it. The one proportion the baseline genuinely supports is
 * drawn instead: how much of the requested archive was actually available. What a baseline is and
 * is not — computed from an archive, not published by an institution — is a sentence in *Deep
 * dive* rather than a disclaimer in the middle of a context card.
 */
export function HistoricalContextCard({
  context,
}: {
  readonly context: HistoricalContextView;
}): ReactNode {
  return (
    <div className={styles.historical}>
      {context.paragraph ? (
        <p className={styles.historicalParagraph}>{context.paragraph}</p>
      ) : null}

      <dl className={styles.contextFigures}>
        {context.figures.map((figure) => (
          <div className={styles.contextFigure} key={figure.key}>
            <dt className={styles.chartStatLabel}>{figure.label}</dt>
            <dd className={styles.chartStatValue}>{figure.value}</dd>
          </div>
        ))}
      </dl>

      <Meter
        label="Archive coverage"
        value={context.coverage}
        unavailable="Not stated"
        note={context.coverageNote}
      />
    </div>
  );
}

/* --------------------------------------------------------- anomaly attention */

/**
 * The artifact's "Anomaly Attention" card, drawn only when the backend flagged something.
 *
 * One figure at alert weight, one line naming what it is, and the count. The method, the threshold
 * and the plot of every flagged entry are in *Deep dive* — a card that opens with
 * "median absolute deviation, threshold 3.5" is an implementation note wearing an alert's colours.
 */
export function AnomalyAttentionCard({
  attention,
}: {
  readonly attention: AnomalyAttention;
}): ReactNode {
  return (
    <div className={styles.attention}>
      <p className={styles.attentionFigure}>{attention.strongest.deviation}</p>
      <p className={styles.attentionLead}>Strongest deviation in this window</p>
      <p className={styles.attentionNote}>
        {attention.count} entr{attention.count === 1 ? "y" : "ies"} flagged · {attention.strongest.stamp}
      </p>
    </div>
  );
}

/* ------------------------------------------------------ the model's reading */

/**
 * The artifact's "Grounded Neural Synthesis", as the thing Weathra can honestly put there.
 *
 * **This is now part of generating the report rather than a button on it.** The screen asked the
 * reader to press "Ask Weathra to read this" and left an empty card until they did, which meant the
 * artifact's conclusive final block was, in production, the one obviously unfinished thing on the
 * page. The run is started with the report and its state is drawn here: a skeleton while it is in
 * flight, the paragraph when it lands, and — because it is a real model call against a real
 * allowance — the backend's own failure with a retry when it does not, rather than a silently
 * missing section.
 *
 * What it carries when it lands is one paragraph, the chips naming the classes it was grounded on,
 * and the link into the run's own evidence. No confidence percentage is attached to the prose: the
 * artifact prints 98.4% there, and nothing measures the certainty of a sentence.
 */
export function GroundedSynthesis({
  answer,
  chips,
  evidenceId,
  busy,
  failure,
  onRetry,
}: {
  readonly answer: AnswerEnvelope | null;
  readonly chips: readonly { readonly label: string; readonly dataClass: GroundingRow["dataClass"] }[];
  readonly evidenceId: string | null;
  readonly busy: boolean;
  readonly failure: ViewFailure | null;
  readonly onRetry: () => void;
}): ReactNode {
  if (failure !== null) {
    return (
      <div className={styles.synthesisBody}>
        <ErrorState failure={failure} title="That reading was not produced" onRetry={onRetry} />
        <p className={styles.quiet}>
          Everything above is retrieved or computed and is unaffected by this.
        </p>
      </div>
    );
  }

  if (answer === null || busy) {
    return (
      <div className={styles.synthesisBody} aria-busy="true">
        <p className={styles.quiet}>Reading the figures above…</p>
        <Skeleton height="var(--space-3)" />
        <Skeleton height="var(--space-3)" />
        <Skeleton height="var(--space-3)" width="72%" />
      </div>
    );
  }

  return (
    <div className={styles.synthesisBody}>
      <p className={styles.synthesis}>{answer.answer_prose}</p>

      {chips.length > 0 ? (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li className={styles.chip} key={chip.label} data-class={chip.dataClass}>
              {chip.label}
            </li>
          ))}
        </ul>
      ) : null}

      {evidenceId ? (
        <Link className={styles.trace} href={`/evidence/${evidenceId}`}>
          <ReportIcon name="verified" size={14} />
          Audit intelligence trace
        </Link>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the grounding */

/** The artifact's "Grounding Evidence" panel: one row per class of figure, short. */
export function GroundingPanel({ rows }: { readonly rows: readonly GroundingRow[] }): ReactNode {
  if (rows.length === 0) return null;

  return (
    <ul className={styles.sources}>
      {rows.map((row) => (
        <li className={styles.source} key={row.role}>
          <span className={styles.sourceMark} data-class={row.dataClass} aria-hidden="true" />
          <span className={styles.sourceRole}>{row.role}</span>
          <span className={styles.sourceName}>{row.provider}</span>
          <DataClassBadge dataClass={row.dataClass} />
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- the footer */

/**
 * The artifact's status strip, as states the backend actually reports.
 *
 * Its version claims operational sensor nodes, a telemetry sync percentage, a validated audit log
 * and a locked system. Weathra has none of those. What it has is how many of the report's reads
 * returned and whether the synthesis run's grounding check verified every figure in its prose —
 * both real, both stated plainly, and the second one says so when it is false.
 */
export function FooterStrip({
  states,
  retrievedAt,
}: {
  readonly states: readonly FooterState[];
  readonly retrievedAt: string | null;
}): ReactNode {
  return (
    <footer className={styles.statusStrip}>
      {states.map((state) => (
        <span className={styles.status} key={state.key} data-tone={state.tone}>
          <ReportIcon name="verified" size={13} />
          {state.label}
        </span>
      ))}
      {retrievedAt ? (
        <span className={styles.statusStamp}>Updated {formatInstant(retrievedAt)}</span>
      ) : null}
    </footer>
  );
}

/* -------------------------------------------------------------- the deep dive */

/**
 * Everything the report computed, behind one control.
 *
 * This is where the widest regions went: the grid of every computed finding, the horizon-by-horizon
 * confidence scale, the plot and list of every flagged entry with the method and threshold that
 * flagged them, and the retrieval stamps that used to sit under every source row. None of it is
 * deleted — `specs/analytics` requires a computed figure to travel with the method that produced
 * it, and it still does. What changed is that a report opens on its conclusions rather than on its
 * working.
 */
export function DeepDive({
  analysis,
  forecast,
  deviations,
  baselineNote,
  retrievals,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly forecast: ForecastResponse | null;
  readonly deviations: readonly DeviationPoint[];
  /** What the archive baseline is built from, and what it is not. */
  readonly baselineNote: string | null;
  readonly retrievals: readonly { readonly label: string; readonly detail: string }[];
}): ReactNode {
  const findings = analysis?.findings ?? [];
  const anomalies = analysis?.anomalies ?? null;
  const uncertainty = forecast?.uncertainty ?? null;
  const horizon = uncertainty?.horizon ?? [];
  const nearest = horizon[0] ?? null;

  if (findings.length === 0 && horizon.length === 0 && deviations.length === 0) return null;

  return (
    <details className={styles.deepDive}>
      <summary className={styles.deepDiveSummary}>
        <span className={styles.deepDiveTitle}>Deep dive</span>
        <span className={styles.deepDiveHint}>
          Every computed figure, the confidence scale, the flagged entries and what was retrieved
          when
        </span>
      </summary>

      <div className={styles.deepDiveBody}>
        {findings.length > 0 ? (
          <section className={styles.deepDiveRegion} aria-labelledby="report-findings">
            <h3 className={styles.deepDiveHeading} id="report-findings">
              Computed for this window
            </h3>
            <div className={styles.findings}>
              {findings.map((result, index) => (
                <FindingRow
                  key={`${result.measure}-${result.statistic}-${index}`}
                  result={result}
                />
              ))}
            </div>
          </section>
        ) : null}

        {horizon.length > 0 && uncertainty && nearest ? (
          <section className={styles.deepDiveRegion} aria-labelledby="report-confidence">
            <h3 className={styles.deepDiveHeading} id="report-confidence">
              Confidence by horizon
            </h3>
            <ol className={styles.horizonScale}>
              {horizon.map((point) => (
                <li
                  className={styles.horizonStep}
                  key={point.time_utc}
                  data-confidence={point.confidence}
                >
                  <span className={styles.horizonBar} aria-hidden="true" />
                  <span className={styles.horizonHours}>{point.hours_ahead} h</span>
                  <span className={styles.horizonBand}>{point.confidence}</span>
                </li>
              ))}
            </ol>
            <UncertaintyIndicator
              confidence={nearest.confidence}
              basis={uncertainty.basis}
              hoursAhead={nearest.hours_ahead}
              spreadAvailable={uncertainty.spread_available}
            />
          </section>
        ) : null}

        {deviations.length > 0 && anomalies ? (
          <section className={styles.deepDiveRegion} aria-labelledby="report-deviation">
            <h3 className={styles.deepDiveHeading} id="report-deviation">
              Entries that stood out
            </h3>
            <DeviationChart
              points={deviations}
              threshold={anomalies.threshold}
              unit={anomalies.unit || null}
              title="Entries that stood out"
              method={anomalies.method}
            />
          </section>
        ) : null}

        {baselineNote || retrievals.length > 0 ? (
          <section className={styles.deepDiveRegion} aria-labelledby="report-provenance">
            <h3 className={styles.deepDiveHeading} id="report-provenance">
              What was retrieved, and when
            </h3>
            {baselineNote ? <p className={styles.quiet}>{baselineNote}</p> : null}
            <ul className={styles.disclosureList}>
              {retrievals.map((entry) => (
                <li key={entry.label}>
                  <span>{entry.label}</span>
                  <span className={styles.disclosureValue}>{entry.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}

/** One computed finding: what it is, the figure, and how it was computed. */
function FindingRow({ result }: { readonly result: StatisticResult }): ReactNode {
  const value = figureOf(result);
  return (
    <div className={styles.finding}>
      <span className={styles.findingLabel}>
        {statisticPhrase(result.statistic, result.measure)}
      </span>
      <span className={styles.findingValue}>{value ?? "Not computable"}</span>
      <span className={styles.findingMethod}>
        {value === null ? (result.reason ?? "") : result.method}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- shared controls */

/** The screen's place control, so both branches of the screen use the same one. */
export function ReportPlaceChooser({
  location,
  usingDefault,
  hasDefault,
  onChoose,
}: {
  readonly location: Location | null;
  readonly usingDefault: boolean;
  readonly hasDefault: boolean;
  readonly onChoose: (location: Location | null) => void;
}): ReactNode {
  return (
    <PlaceChooser
      summary="Report on another place"
      label="Report on a place"
      description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
      current={location}
      usingDefault={usingDefault}
      hasDefault={hasDefault}
      onChoose={onChoose}
    />
  );
}

/** A link to the plotted window, for the artifact's "View hourly trace" control. */
export function HourlyTraceLink(): ReactNode {
  return (
    <a className={styles.regionAction} href="#report-analysis">
      View hourly trace
    </a>
  );
}
