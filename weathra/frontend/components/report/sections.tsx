"use client";

/**
 * The Weather Intelligence Report's regions — the header bar, the hero, the tiles, the day strip,
 * the side cards and the grounding panel that carry the report between the charts in
 * `./charts.tsx`.
 *
 * `docs/design/screens/12-weather-intelligence-report.png` is a *curated* report: one headline with
 * three figures under it, six observed tiles beside it, a week of day cards, three "what changed"
 * notes, one chart with four stats, one historical side card, one attention card, one synthesis and
 * a short grounding list. The build before this one rendered the same endpoints exhaustively —
 * every computed finding as a tile, every horizon band as a bar, every flagged entry as a row, a
 * paragraph of provenance under every source — which is the data dump this pass exists to remove.
 *
 * Every region here obeys the same hierarchy, and every count it shows is a constant in
 * `lib/report/view-model.ts` rather than "however many came back":
 *
 *     THE FIGURE or THE VISUALISATION  →  A SHORT LABEL  →  ONE SHORT LINE
 *
 * Nothing composes a sentence about the weather; each line is a backend figure, a backend phrase,
 * or a statement of method. What overflowed a cap is not lost — it is behind the report's own
 * disclosure, which is the last region in this file.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import {
  Badge,
  Button,
  DataClassBadge,
  LocationImage,
  Metric,
  Meter,
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
import { formatFigure, formatReading, measureLabel, statisticPhrase } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import {
  REPORT_HORIZONS,
  figureOf,
  type AnomalyAttention,
  type ChangedView,
  type CurrentTiles,
  type GroundingRow,
  type HistoricalContextView,
  type OutlookDay,
  type ReportFigure,
  type ReportSynthesis,
} from "@/lib/report/view-model";

import { DeviationChart, type DeviationPoint } from "./charts";
import styles from "./report.module.css";

/* ------------------------------------------------------------------- header */

/**
 * The report's own header: what it is, where, over what window, and when it was read.
 *
 * The artifact gives this one compact band — a report identifier, the title, a one-line scope, four
 * horizon buttons, a sync stamp and an export control. Production spent four stacked rows on it and
 * then opened a full-width place disclosure underneath before the first figure. This is the
 * artifact's band, with the two controls Weathra genuinely has: the horizon, which the forecast
 * endpoint takes, and the place, folded into the bar rather than sitting open beneath it.
 *
 * **No export and no report identifier.** There is no report export, and nothing issues a report an
 * id — `docs/design/screens.md` §5 refuses both, and a disabled button labelled "Export PDF" would
 * advertise the capability in order to deny it.
 */
export function ReportHeader({
  location,
  scope,
  horizon,
  onHorizon,
  retrievedAt,
  chooser,
}: {
  readonly location: Location;
  /** One line naming what the report covers. Fixed copy about the report, not about the weather. */
  readonly scope: string;
  readonly horizon: string;
  readonly onHorizon: (value: string) => void;
  readonly retrievedAt: string | null;
  readonly chooser: ReactNode;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.headerBadges}>
          <DataClassBadge dataClass="analytics" />
          <span className={styles.headerPeriod}>{location.timezone}</span>
        </div>
        <h1 className={styles.title}>Weather Intelligence Report</h1>
        <p className={styles.lede}>
          <span className={styles.ledePlace}>{friendlyName(location)}</span>
          {" — "}
          {scope}
        </p>
      </div>

      <div className={styles.headerControls}>
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

        {retrievedAt ? (
          <p className={styles.headerStamp}>Retrieved {formatInstant(retrievedAt)}</p>
        ) : null}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------- hero */

/**
 * The report's opening block: the place, the headline, one paragraph, three figures.
 *
 * The artifact's hero is a dark photographic panel with an alert-weight statement across it, a
 * short grounded paragraph, and a row of three figure cards at its foot. This is that composition
 * with Weathra's own statements in it — the headline and the paragraph come from
 * `synthesisFrom`, which only ever promotes something the backend wrote, and the three cards come
 * from `heroFiguresFrom`, which refuses the artifact's evidence-node count outright.
 *
 * A hero with nothing to say still draws: the place, its reading, and whichever figures exist.
 */
export function ReportHero({
  location,
  synthesis,
  figures,
  reading,
  observedAt,
}: {
  readonly location: Location;
  readonly synthesis: ReportSynthesis;
  readonly figures: readonly ReportFigure[];
  /** The current temperature, already formatted, or null where none was reported. */
  readonly reading: { readonly figure: string; readonly unit: string | null } | null;
  readonly observedAt: string | null;
}): ReactNode {
  return (
    <section className={styles.hero} aria-labelledby="report-hero-title">
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="hero"
        scrim="strong"
      >
        <div className={styles.heroOverlay}>
          <div className={styles.heroOverlayText}>
            <p className={styles.heroPlace}>{friendlyName(location)}</p>
            {observedAt ? (
              <p className={styles.heroStamp}>Observed {formatInstant(observedAt)}</p>
            ) : null}
          </div>
          {reading ? (
            <p className={styles.heroReadout}>
              {reading.figure}
              {reading.unit ? <span className={styles.heroUnit}>{reading.unit}</span> : null}
            </p>
          ) : null}
        </div>
      </LocationImage>

      <div className={styles.heroBody}>
        <div className={styles.heroHeading}>
          <DataClassBadge dataClass="analytics" />
          <span className={styles.heroKicker}>Computed synthesis</span>
        </div>

        <h2 className={styles.heroTitle} id="report-hero-title">
          {synthesis.headline ?? "Computed reading of this window"}
        </h2>
        {synthesis.lead ? <p className={styles.heroSummary}>{synthesis.lead}</p> : null}

        {figures.length > 0 ? (
          <div className={styles.heroTiles}>
            {figures.map((figure) => (
              <FigureTile key={figure.key} figure={figure} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** One curated figure, wherever the report shows one. */
function FigureTile({ figure }: { readonly figure: ReportFigure }): ReactNode {
  return (
    <Metric
      label={figure.label}
      value={figure.value}
      dataClass={figure.dataClass}
      delta={figure.delta}
      note={figure.note}
    />
  );
}

/* -------------------------------------------------------- conditions now */

/**
 * The artifact's tile column: six observed measures, compact, each with its class.
 *
 * Six is the cap, not the count — `currentTilesFrom` orders the provider's measures the way the
 * artifact orders its tiles and hands back whatever exceeded six, which goes behind the disclosure
 * at the foot of this panel. Nothing the provider reported is dropped, and nothing it did not
 * report is drawn as an empty box.
 */
export function ConditionTiles({ tiles }: { readonly tiles: CurrentTiles }): ReactNode {
  if (tiles.shown.length === 0) return null;

  return (
    <div className={styles.conditions}>
      <ul className={styles.conditionGrid}>
        {tiles.shown.map((reading) => (
          <li className={styles.conditionTile} key={reading.key}>
            <span className={styles.conditionLabel}>{measureLabel(reading.key)}</span>
            <span className={styles.conditionValue}>
              {formatFigure(reading)}
              {reading.unit ? <span className={styles.conditionUnit}>{reading.unit}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {tiles.rest.length > 0 ? (
        <details className={styles.disclosure}>
          <summary className={styles.disclosureSummary}>
            {tiles.rest.length} more measure{tiles.rest.length === 1 ? "" : "s"} reported
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
  );
}

/* --------------------------------------------------------------- day strip */

/**
 * The outlook as the artifact's row of day cards: the day, the sky, the high, the rain cue.
 *
 * The glyph is the provider's *own* dominant condition code translated through the product's one
 * condition vocabulary — never a sky inferred from a figure. A day the provider gave no code for
 * gets no glyph, and a day it gave no range for keeps its card and says so rather than being
 * dropped, which would silently shorten the week.
 */
export function OutlookStrip({ days }: { readonly days: readonly OutlookDay[] }): ReactNode {
  return (
    <ol className={styles.days}>
      {days.map((day) => (
        <li className={styles.day} key={day.date}>
          <span className={styles.dayName}>{day.weekday}</span>
          <span className={styles.dayDate}>{day.date.slice(5)}</span>

          <span className={styles.dayIcon}>
            <WeatherIcon condition={day.condition} size={26} />
          </span>

          {/*
            The high leads by size, and the low sits under it unlabelled — which only reads as a
            low while there is a larger figure above it. A day the provider gave no high for used
            to print "Not reported" with a bare figure beneath it, so the one number on the card
            was the one a reader would take for the day's temperature. The low is named in that
            case, and only in that case.
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

          {day.condition ? (
            <span className={styles.dayCondition}>{day.condition.label}</span>
          ) : null}
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
 * The artifact's "What changed?" column: the backend's statement, then up to three movements.
 *
 * The endpoint returns one row per day per measure — dozens across a fortnight, and production
 * listed every one of them beside a week of cards. Three is what the artifact draws and three is
 * what this draws, material movements first, with the number not shown stated rather than
 * implied.
 */
export function WhatChangedNotes({ changed }: { readonly changed: ChangedView }): ReactNode {
  return (
    <div className={styles.moved}>
      <p className={styles.movedStatement}>{changed.statement}</p>

      {changed.notes.length > 0 ? (
        <ul className={styles.movedList}>
          {changed.notes.map((note) => (
            <li className={styles.movedNote} key={note.key}>
              <span className={styles.movedValue} data-tone={note.tone}>
                {note.value}
              </span>
              <span className={styles.movedMeasure}>{note.label}</span>
              <span className={styles.movedDate}>
                {note.date}
                {note.material ? "" : " · inside the margin"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {changed.hidden > 0 ? (
        <p className={styles.quiet}>
          {changed.hidden} further movement{changed.hidden === 1 ? "" : "s"} in this window{" "}
          {changed.hidden === 1 ? "is" : "are"} not shown.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- the chart stats */

/** The three or four figures the artifact prints under its chart. */
export function ChartStats({ stats }: { readonly stats: readonly ReportFigure[] }): ReactNode {
  if (stats.length === 0) return null;

  return (
    <dl className={styles.chartStats}>
      {stats.map((stat) => (
        <div className={styles.chartStat} key={stat.key}>
          <dt className={styles.chartStatLabel}>{stat.label}</dt>
          <dd className={styles.chartStatValue}>{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------- historical context */

/**
 * The artifact's "Historical Context" card: three figures, one paragraph, one coverage bar.
 *
 * Its decadal stability index and model-alignment score are refused — neither is computed and both
 * name a capability in order to display it. The one proportion the baseline genuinely supports is
 * drawn instead: how much of the requested archive was actually available, which is the figure
 * `coverage_note` states in words.
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

      <dl className={styles.chartStats}>
        {context.figures.map((figure) => (
          <div className={styles.chartStat} key={figure.key}>
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
 * One count, one method, and the entry that stood out furthest. The plot of every flagged entry and
 * its per-entry list are behind the report's disclosure, where a reader who wants the arithmetic
 * finds them and a reader who wants the report does not have to scroll past them.
 */
export function AnomalyAttentionCard({
  attention,
}: {
  readonly attention: AnomalyAttention;
}): ReactNode {
  return (
    <div className={styles.attention}>
      <div className={styles.attentionHead}>
        <Badge tone="warning">Attention</Badge>
        <span className={styles.attentionCount}>
          {attention.count} entr{attention.count === 1 ? "y" : "ies"} stood out
        </span>
      </div>
      <p className={styles.attentionFigure}>
        {attention.strongest.deviation}
        <span className={styles.attentionScore}>
          {attention.strongest.score} against a threshold of {attention.threshold}
        </span>
      </p>
      <p className={styles.attentionNote}>{attention.strongest.stamp}</p>
      <p className={styles.attentionNote}>{attention.method}</p>
    </div>
  );
}

/* ------------------------------------------------------ the model's reading */

/**
 * The artifact's "Grounded Neural Synthesis", as the thing Weathra can honestly put there.
 *
 * The artifact's appears the moment the page opens, is attributed to an agent it versions, and
 * carries a confidence percentage on the prose. Weathra's is a real model call against a real
 * allowance, so it stays a control — but a *secondary* one, and the report above is complete
 * without it. What it produces is one paragraph, the chips naming what it was read from, the model
 * that wrote it, and a link into the run's own evidence.
 */
export function GroundedSynthesis({
  answer,
  chips,
  evidenceId,
  busy,
  onAsk,
}: {
  readonly answer: AnswerEnvelope | null;
  readonly chips: readonly string[];
  readonly evidenceId: string | null;
  readonly busy: boolean;
  readonly onAsk: () => void;
}): ReactNode {
  if (answer === null) {
    return (
      <div className={styles.synthesisPrompt}>
        <p className={styles.quiet}>
          Everything above is retrieved or computed. A model reading is one call, and optional.
        </p>
        <Button variant="secondary" size="sm" busy={busy} onClick={onAsk}>
          {busy ? "Reading…" : "Add a model reading"}
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.synthesisBody}>
      <p className={styles.synthesis}>{answer.answer_prose}</p>
      {chips.length > 0 ? (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li className={styles.chip} key={chip}>
              {chip}
            </li>
          ))}
        </ul>
      ) : null}
      {evidenceId ? (
        <Link className={styles.evidence} href={`/evidence/${evidenceId}`}>
          See how this answer was produced
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
          <span className={styles.sourceDetail}>{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- the deep dive */

/**
 * Everything the report computed, behind one control.
 *
 * This is where the old page's three widest regions went: the grid of every computed finding, the
 * horizon-by-horizon confidence scale, and the plot and list of every flagged entry. None of it is
 * deleted — a figure that was on screen yesterday is still reachable today, and `specs/analytics`
 * requires a computed figure to travel with the method that produced it, which it still does. What
 * changed is that a report opens on its conclusions rather than on its working.
 */
export function DeepDive({
  analysis,
  forecast,
  deviations,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly forecast: ForecastResponse | null;
  readonly deviations: readonly DeviationPoint[];
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
          Every computed figure, the confidence scale and the flagged entries
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
                <FindingTile key={`${result.measure}-${result.statistic}-${index}`} result={result} />
              ))}
            </div>
          </section>
        ) : null}

        {horizon.length > 0 && uncertainty ? (
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
            {nearest ? (
              <UncertaintyIndicator
                confidence={nearest.confidence}
                basis={uncertainty.basis}
                hoursAhead={nearest.hours_ahead}
                spreadAvailable={uncertainty.spread_available}
              />
            ) : null}
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
      </div>
    </details>
  );
}

/** One computed finding: the figure, what it is, and how it was computed. */
function FindingTile({ result }: { readonly result: StatisticResult }): ReactNode {
  const value = figureOf(result);
  return (
    <Metric
      label={statisticPhrase(result.statistic, result.measure)}
      value={value ?? "Not computable"}
      dataClass="analytics"
      note={value === null ? (result.reason ?? undefined) : result.method}
    />
  );
}

/* ----------------------------------------------------------- the empty state */

/** The screen's place control, exported so both branches of the screen use the same one. */
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
