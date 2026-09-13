/**
 * The Weather Intelligence Report's view model — what the report *says*, decided in one place.
 *
 * `docs/design/screens/12-weather-intelligence-report.png` is a curated intelligence report: a
 * contained header, an interpretation hero with three figures under it, six observed tiles beside
 * it, a week of day cards, three "what changed" notes, one chart with four stats, one historical
 * side card, one attention card, a completed synthesis and a short grounding list. The screen
 * rendered the same six endpoints exhaustively, which is why it read as an internal tool.
 *
 * So the curation is a module rather than a set of decisions scattered through JSX. Four rules hold
 * here, and each is tested:
 *
 * **Nothing is counted or estimated for effect.** The artifact's `EVIDENCE NODES: 124`,
 * `CONFIDENCE 98.4%`, retrieval score, decadal stability index and model-alignment score have no
 * figure behind them; `docs/design/screens.md` §5 refuses each, and none is reconstructed here from
 * something that happens to be nearby.
 *
 * **Every limit is a constant, and the overflow is kept.** A cap returns what it dropped, so the
 * screen can put the remainder behind a disclosure instead of the report silently losing figures.
 *
 * **No figure reaches the screen at the precision it was computed at.** A z-score arrives as
 * `0.6706849412785952`; printing that claims a precision nothing measured and reads as a machine
 * talking to itself. Everything user-facing goes through `roundTo` or the briefing formatters, and
 * the unrounded value stays in Agent Evidence, where the arithmetic is checked.
 *
 * **One sentence is composed here, and only one.** `headlineFrom` assembles the report's headline
 * from *classifications the backend made* — which side of the record the window sits on, which
 * direction the trend runs, how many of the returned days carry precipitation. It introduces no
 * number, no adjective a computed figure does not license, and no claim about what the weather
 * means. Everything else on the page is a backend string or a backend figure. The reason this one
 * exception exists is that the only backend sentence about the window is
 * `BaselineComparison.characterization`, which is built as "17.2 °C is 1.6 °C above the 9-year
 * baseline temperature mean of 15.6 °C (+0.67 standard deviations)." — accurate, and a headline
 * nobody can read. That sentence is still on the page, one level down, as the hero's supporting
 * line, where being exact is the job.
 */

import type {
  AnalysisResponse,
  AnswerEnvelope,
  Baseline,
  BaselineComparison,
  CurrentResponse,
  DayChange,
  ForecastResponse,
  StatisticResult,
  WhatChanged,
} from "@/lib/api/schema";
import {
  dayPrecipitationFrom,
  forecastDaysFrom,
  formatReading,
  measureLabel,
  readingsFrom,
  statisticPhrase,
  type DayPrecipitation,
  type Reading,
} from "@/lib/dashboard/briefing";
import type { DataClassName } from "@/lib/design/tokens";
import { conditionFor, type Condition } from "@/lib/weather/condition";

import type { ReportIconName } from "@/components/report/icons";

/* --------------------------------------------------------------- the limits */

/** The artifact's three hero figures, six tiles, week, three notes and four stats. */
export const HERO_FIGURE_LIMIT = 3;
export const CURRENT_TILE_LIMIT = 6;
export const OUTLOOK_DAY_LIMIT = 7;
export const CHANGE_NOTE_LIMIT = 3;
export const CHART_STAT_LIMIT = 4;
export const HISTORICAL_FIGURE_LIMIT = 3;
export const GROUNDING_ROW_LIMIT = 5;

/** The horizons the report offers, and the horizons the weather endpoints take. */
export const REPORT_HORIZONS = [
  { value: "1", label: "Today", name: "Today" },
  { value: "3", label: "3D", name: "3 days" },
  { value: "7", label: "7D", name: "7 days" },
  { value: "14", label: "14D", name: "14 days" },
] as const;

export type ReportHorizon = (typeof REPORT_HORIZONS)[number]["value"];

export function isReportHorizon(value: string): value is ReportHorizon {
  return REPORT_HORIZONS.some((entry) => entry.value === value);
}

/* ------------------------------------------------------------ the precision */

/**
 * A figure at the precision it is *read* at, not the precision it was computed at.
 *
 * Rounding down the number of digits is presentation; rounding up would be invention, and nothing
 * here ever adds one. Trailing zeros are dropped because "0.70" and "0.7" are the same claim and
 * the shorter one reads.
 */
export function roundTo(value: number, places: number): string {
  if (!Number.isFinite(value)) return "—";
  const factor = 10 ** places;
  return String(Math.round(value * factor) / factor);
}

/** A standard-deviation figure, at the two places a z-score is meaningful to. */
export function formatSigma(value: number): string {
  return `${roundTo(value, 2)}σ`;
}

/** A signed figure, so a delta reads as a direction before it reads as a number. */
export function signedOf(value: number, unit: string | null | undefined): string {
  return `${value > 0 ? "+" : ""}${formatReading({ value, unit: unit ?? null })}`;
}

/** Which way a figure points, for a tone. Never the only carrier — the sign leads. */
export function toneOf(value: number): "up" | "down" | "flat" {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/** A statistic's figure with its unit, or null where the backend could not compute it. */
export function figureOf(result: StatisticResult | null | undefined): string | null {
  if (!result) return null;
  if (result.value === null || result.value === undefined) return null;
  return formatReading({ value: result.value, unit: result.unit ?? null });
}

/** One figure on the report: already formatted, already labelled, already classed. */
export interface ReportFigure {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly dataClass: DataClassName;
  readonly icon?: ReportIconName;
  readonly delta?: { readonly text: string; readonly tone: "up" | "down" | "flat" };
  readonly note?: string;
}

/* ------------------------------------------------------------- the headline */

/** How far from the record a window has to sit before the headline says so without a qualifier. */
const SLIGHT_SIGMA = 1;
const MARKED_SIGMA = 2;
/** Below this, a difference is reported as being in line with the record rather than above it. */
const LEVEL_DIFFERENCE = 0.05;

export interface ReportHeadline {
  /** The report's one decision-level statement. Composed from backend classifications only. */
  readonly headline: string;
  /** The backend's own sentences under it, in the order they are read. */
  readonly support: readonly string[];
}

/**
 * The report's headline, and the sentences that support it.
 *
 * The headline is three clauses at most, and every clause is licensed by something the backend
 * decided rather than by anything this module worked out:
 *
 *   - where the window sits against the record — the sign of `BaselineComparison.difference`, with
 *     its strength taken from the *magnitude band* of the z-score rather than from the z-score
 *     itself, so the word is a reading of the backend's own statistic and not a new one;
 *   - which way it is moving — `TrendReport.direction`, the backend's own classification, which
 *     already carries its significance margin, so a window it calls steady is never called warming;
 *   - whether rain is in it — a count of the returned days carrying precipitation, which is a count
 *     of rows rather than a judgement about the sky.
 *
 * No number appears in it. Nothing here decides a condition is severe, urgent or worth acting on:
 * the severity referral in the backend remains the only thing in this product that speaks to
 * danger, and "Immediate Convective Alert" stays the artifact's phrase rather than becoming ours.
 */
export function headlineFrom({
  comparison,
  analysis,
  outlook,
}: {
  readonly comparison: BaselineComparison | null;
  readonly analysis: AnalysisResponse | null;
  readonly outlook: readonly OutlookDay[];
}): ReportHeadline {
  const clauses: string[] = [];

  const difference = comparison?.difference?.value;
  const zScore = comparison?.z_score?.value;
  if (typeof difference === "number") {
    if (Math.abs(difference) < LEVEL_DIFFERENCE) {
      clauses.push("in line with the seasonal record");
    } else {
      const strength =
        typeof zScore === "number" && Math.abs(zScore) >= MARKED_SIGMA
          ? "markedly "
          : typeof zScore === "number" && Math.abs(zScore) < SLIGHT_SIGMA
            ? "slightly "
            : "";
      clauses.push(`${strength}${difference > 0 ? "above" : "below"} the seasonal record`);
    }
  }

  const direction = analysis?.trend?.direction;
  if (direction === "rising") clauses.push("warming through the window");
  else if (direction === "falling") clauses.push("cooling through the window");
  else if (direction === "steady") clauses.push("steady through the window");

  const wet = outlook.filter(
    (day) => day.precipitation !== null && day.precipitation.level !== "dry",
  ).length;
  if (wet > 0) {
    clauses.push(
      wet === outlook.length
        ? "with rain on every day reported"
        : `with rain on ${wet} of ${outlook.length} days`,
    );
  }

  const first = clauses[0];
  const headline =
    first === undefined
      ? "Retrieved and computed for this window"
      : `${first[0]!.toUpperCase()}${first.slice(1)}${
          clauses.length > 1 ? `, ${clauses.slice(1).join(", ")}` : ""
        }.`;

  /*
   * The analytics engine's own summary leads the support and the comparison's characterization
   * follows it — what the window is, then where it sits. Both are backend-written; neither is ever
   * promoted to the headline, because both are built to be exact rather than to be read first.
   */
  const support = [analysis?.summary, comparison?.characterization]
    .map((sentence) => sentence?.trim())
    .filter((sentence): sentence is string => Boolean(sentence));

  return { headline, support };
}

/**
 * The three figures under the headline — the artifact's CONFIDENCE / EVIDENCE NODES / DRIFT
 * VARIANCE row, as the figures Weathra actually has for each.
 *
 * The first and third map straight across: the forecast's own banded confidence at the nearest
 * horizon, and the strongest deviation the analytics engine flagged — or, where it flagged none,
 * the window's own distance from the baseline. The middle one does not. There is no evidence-node
 * count and there will not be one, so the slot holds the number of *source classes* the report was
 * read from, which is a count of the rows on its own grounding panel rather than a number invented
 * to fill a tile. Once the synthesis has run, the figures its grounding check verified sit under it
 * as the note.
 */
export function heroFiguresFrom({
  forecast,
  comparison,
  analysis,
  groundingRows,
  answer,
}: {
  readonly forecast: ForecastResponse | null;
  readonly comparison: BaselineComparison | null;
  readonly analysis: AnalysisResponse | null;
  readonly groundingRows: number;
  readonly answer: AnswerEnvelope | null;
}): ReportFigure[] {
  const figures: ReportFigure[] = [];

  const nearest = forecast?.uncertainty?.horizon?.[0] ?? null;
  if (nearest) {
    figures.push({
      key: "confidence",
      label: "Outlook confidence",
      value: capitalise(nearest.confidence),
      dataClass: "forecast",
      icon: "outlook",
      note: `At ${nearest.hours_ahead} h ahead`,
    });
  }

  if (groundingRows > 0) {
    const checked = answer?.grounding?.figures_checked;
    figures.push({
      key: "sources",
      label: "Grounded sources",
      value: String(groundingRows),
      dataClass: "analytics",
      icon: "grounding",
      note:
        typeof checked === "number"
          ? `${checked} figure${checked === 1 ? "" : "s"} checked`
          : "Classes this report was read from",
    });
  }

  /*
   * The window's own distance from the record, and *not* the strongest flagged entry.
   *
   * The flagged entry was here first, and it put the same figure in two places on one screen: the
   * hero tile and the attention card beside the chart, which exists for exactly that number. The
   * hero states how unusual the window is; the attention card states which entry was worst. It
   * falls back to the flagged entry only where there is no comparison to state, so the two are
   * never both drawn.
   */
  const attention = anomalyAttentionFrom(analysis);
  const zScore = comparison?.z_score?.value;
  if (typeof zScore === "number") {
    figures.push({
      key: "deviation",
      label: "Distance from baseline",
      value: formatSigma(zScore),
      dataClass: "analytics",
      icon: "analytics",
      note: attention
        ? `${attention.count} entr${attention.count === 1 ? "y" : "ies"} flagged`
        : "No entry was flagged in this window",
    });
  } else if (attention) {
    figures.push({
      key: "deviation",
      label: "Strongest deviation",
      value: attention.strongest.deviation,
      dataClass: "analytics",
      icon: "alert",
      note: `${attention.count} entr${attention.count === 1 ? "y" : "ies"} flagged`,
    });
  }

  return figures.slice(0, HERO_FIGURE_LIMIT);
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/* -------------------------------------------------------- current conditions */

/**
 * The order the artifact's six tiles are in, and what fills the sixth when UV is not reported.
 *
 * `12-weather-intelligence-report.png` draws TEMPERATURE, PRECIPITATION, HUMIDITY, WIND VELOCITY,
 * ATM. PRESSURE and UV INTENSITY. Open-Meteo's current block does not always carry a UV index, so
 * the order continues past it rather than leaving a labelled empty box in the artifact's last
 * position — the same substitution the Forecast Explorer's strip makes, for the same reason.
 */
const CURRENT_TILE_ORDER: readonly string[] = [
  "temperature",
  "precipitation",
  "relative_humidity",
  "wind_speed",
  "surface_pressure",
  "uv_index",
  "cloud_cover",
  "apparent_temperature",
  "wind_gust",
  "dew_point",
];

/** Which glyph a measure is drawn with. A measure with none is drawn with none. */
const MEASURE_ICONS: Readonly<Record<string, ReportIconName>> = {
  temperature: "temperature",
  apparent_temperature: "temperature",
  precipitation: "precipitation",
  relative_humidity: "humidity",
  wind_speed: "wind",
  wind_gust: "gust",
  surface_pressure: "pressure",
  uv_index: "uv",
  cloud_cover: "cloud",
  dew_point: "dew",
};

export interface ConditionTile {
  readonly key: string;
  readonly label: string;
  /** The figure alone. The tile sets the unit beside it, at its own size. */
  readonly value: string;
  readonly unit: string | null;
  readonly icon: ReportIconName | null;
}

export interface CurrentTiles {
  /** At most six, in the artifact's order. */
  readonly shown: readonly ConditionTile[];
  /** Everything else the provider reported, for the disclosure. Never dropped. */
  readonly rest: readonly Reading[];
}

export function currentTilesFrom(current: CurrentResponse | null): CurrentTiles {
  const ranked = [...readingsFromCurrent(current)].sort(
    (left, right) => rankOf(left.key) - rankOf(right.key),
  );

  return {
    shown: ranked.slice(0, CURRENT_TILE_LIMIT).map((reading) => ({
      key: reading.key,
      label: measureLabel(reading.key),
      value: roundTo(reading.value, 1),
      unit: reading.unit,
      icon: MEASURE_ICONS[reading.key] ?? null,
    })),
    rest: ranked.slice(CURRENT_TILE_LIMIT),
  };
}

function rankOf(key: string): number {
  const index = CURRENT_TILE_ORDER.indexOf(key);
  return index === -1 ? CURRENT_TILE_ORDER.length : index;
}

/** The provider's reported measures, with the condition code left out — it is not a figure. */
function readingsFromCurrent(current: CurrentResponse | null): Reading[] {
  if (!current) return [];
  return readingsFrom(current.values, current.units).filter(
    (reading) => reading.key !== "weather_code",
  );
}

/** The sky the provider reported now, or null where it reported none. */
export function currentConditionFrom(current: CurrentResponse | null): Condition | null {
  return conditionFor(current?.values?.weather_code);
}

/* ------------------------------------------------------------ the day cards */

export interface OutlookDay {
  readonly date: string;
  readonly weekday: string;
  /** The provider's own dominant code, translated. Null where it reported none. */
  readonly condition: Condition | null;
  readonly high: Reading | null;
  readonly low: Reading | null;
  /** The day's own precipitation, read back. Never a guess at the sky. */
  readonly precipitation: DayPrecipitation | null;
  /** The first day of the window — the artifact accents it. */
  readonly leading: boolean;
}

/** The weekday of a local calendar date — calendar arithmetic, not a timezone conversion. */
function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()] ?? "";
}

/**
 * The outlook, capped at the artifact's week.
 *
 * A horizon of fourteen days returns fourteen entries and the artifact draws seven cards; a strip
 * of fourteen is a data dump in the position the report's most scannable region occupies. The cap
 * is on the *cards*, not on the retrieval — the chart below still plots the whole window, so
 * nothing retrieved is hidden by it.
 */
export function outlookFrom(forecast: ForecastResponse | null): OutlookDay[] {
  return forecastDaysFrom(forecast?.daily)
    .slice(0, OUTLOOK_DAY_LIMIT)
    .map((day, index) => ({
      date: day.date,
      weekday: weekdayOf(day.date),
      condition: conditionFor(day.conditionCode),
      high: day.high,
      low: day.low,
      precipitation: dayPrecipitationFrom(day),
      leading: index === 0,
    }));
}

/* ---------------------------------------------------------- what has changed */

export interface ChangeNote {
  readonly key: string;
  readonly title: string;
  readonly icon: ReportIconName;
  readonly value: string;
  readonly tone: "up" | "down" | "flat";
  /** One short sentence: the backend's own statement about this day's movement. */
  readonly statement: string;
  readonly material: boolean;
}

export interface ChangedView {
  /** True when an earlier retrieval of this window exists to compare against. */
  readonly comparable: boolean;
  /** The backend's own one-line statement about the comparison. */
  readonly statement: string;
  /** At most three movements, material ones first. */
  readonly notes: readonly ChangeNote[];
  /** How many movements the endpoint reported but this panel does not show. */
  readonly hidden: number;
}

/** What a moved measure is called at the head of its card, and what it is drawn with. */
function changeSubject(measure: string): { title: string; icon: ReportIconName } {
  if (measure.startsWith("precipitation")) {
    return { title: "Precipitation shift", icon: "precipitation" };
  }
  if (measure.startsWith("wind")) return { title: "Wind shift", icon: "wind" };
  if (measure.startsWith("temperature") || measure.startsWith("apparent")) {
    return { title: "Temperature shift", icon: "temperature" };
  }
  return { title: `${measureLabel(measure)} shift`, icon: "changed" };
}

/**
 * The artifact's three "what changed" cards, from `GET /weather/changes`.
 *
 * The endpoint returns one `DayChange` per day per measure, which for a fortnight is dozens of
 * rows — the screen listed all of them. The artifact shows three notes, so three is what this
 * returns: material movements first, in the backend's own order, each with the sentence the backend
 * wrote for it, and the count of what is not shown so the panel can say so rather than appear
 * complete.
 *
 * `comparable` is the state the artifact has no equivalent for and the product must: a first
 * retrieval of a window has nothing to be compared against, which is a fact about the record rather
 * than a failure, and it is not the same as two retrievals that happened to agree.
 */
export function changedFrom(changes: WhatChanged | null): ChangedView | null {
  if (!changes) return null;

  const moved = (changes.changes ?? []).filter(
    (change): change is DayChange & { change: number } => typeof change.change === "number",
  );
  const ordered = [
    ...moved.filter((change) => change.material),
    ...moved.filter((change) => !change.material),
  ];

  return {
    comparable: changes.comparison_available,
    statement: changes.statement,
    notes: ordered.slice(0, CHANGE_NOTE_LIMIT).map((change) => {
      const subject = changeSubject(change.measure);
      return {
        key: `${change.local_date}-${change.measure}`,
        title: subject.title,
        icon: subject.icon,
        value: signedOf(change.change, change.unit),
        tone: toneOf(change.change),
        statement: change.statement,
        material: change.material,
      };
    }),
    hidden: Math.max(ordered.length - CHANGE_NOTE_LIMIT, 0),
  };
}

/* ------------------------------------------------------- the one chart block */

/** One finding, found by what it measures and what it computes. */
function findingOf(analysis: AnalysisResponse | null, statistic: string): StatisticResult | null {
  return (
    (analysis?.findings ?? []).find(
      (result) => result.statistic === statistic && result.measure.startsWith("temperature"),
    ) ?? null
  );
}

/**
 * The four figures the artifact prints under its chart — PEAK DRIFT, HISTORICAL MEAN, Sigma,
 * Confidence — as the figures Weathra has for each.
 *
 * Every one is read off a response: two findings the analytics engine returned for the plotted
 * measure, the baseline's own mean, and the comparison's difference with its z-score beside it.
 * Nothing is derived from the plotted series here — the chart and this row must state the same
 * arithmetic, and the only way to guarantee that is for neither to do any.
 */
export function chartStatsFrom({
  analysis,
  baseline,
  comparison,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly baseline: Baseline | null;
  readonly comparison: BaselineComparison | null;
}): ReportFigure[] {
  const stats: ReportFigure[] = [];

  const maximum = findingOf(analysis, "maximum");
  const maximumFigure = figureOf(maximum);
  if (maximum && maximumFigure) {
    stats.push({
      key: "window-maximum",
      label: statisticPhrase(maximum.statistic, maximum.measure),
      value: maximumFigure,
      dataClass: "analytics",
    });
  }

  const mean = findingOf(analysis, "mean");
  const meanFigure = figureOf(mean);
  if (mean && meanFigure) {
    stats.push({
      key: "window-mean",
      label: statisticPhrase(mean.statistic, mean.measure),
      value: meanFigure,
      dataClass: "analytics",
    });
  }

  const baselineMean = figureOf(baseline?.mean);
  if (baseline && baselineMean) {
    stats.push({
      key: "baseline-mean",
      label: "Baseline mean",
      value: baselineMean,
      dataClass: "historical",
    });
  }

  /*
   * The difference in the measure's own unit, and deliberately without the z-score beside it.
   *
   * The hero's third figure is that z-score, and carrying it here too put "0.67σ" twice on one
   * screen — the duplication rule this composition is built on. Four figures under the chart, each
   * stating something the other three do not.
   */
  const difference = comparison?.difference?.value;
  if (typeof difference === "number") {
    stats.push({
      key: "deviation",
      label: "Against baseline",
      value: signedOf(difference, comparison?.difference?.unit),
      dataClass: "analytics",
    });
  }

  return stats.slice(0, CHART_STAT_LIMIT);
}

/* ------------------------------------------------------- historical context */

export interface HistoricalContextView {
  /** At most three key figures, as the artifact's side card carries. */
  readonly figures: readonly ReportFigure[];
  /** How much of the requested archive was available, 0–1, or null where it cannot be stated. */
  readonly coverage: number | null;
  readonly coverageNote: string;
  /** One short line about the record itself. Never the hero's supporting sentence again. */
  readonly paragraph: string | null;
}

/**
 * The artifact's "Historical Context" card: three figures, one short line, one coverage bar.
 *
 * Its decadal stability index and model-alignment score are refused — neither is computed and both
 * name a capability in order to display it. The one proportion the baseline genuinely supports is
 * drawn instead: how much of the requested archive was actually available.
 *
 * The card deliberately does *not* repeat the comparison's characterization. That sentence is the
 * hero's support, and the same sentence in two weights on one screen is the redundancy this pass
 * exists to remove. The caveat about what a baseline is and is not — that it is computed from an
 * archive rather than published by an institution — is in *Deep dive* with the methods.
 */
export function historicalContextFrom({
  baseline,
}: {
  readonly baseline: Baseline | null;
}): HistoricalContextView | null {
  if (!baseline) return null;

  const years = baseline.years_used?.length ?? 0;
  const requested = baseline.years_requested ?? 0;
  const figures: ReportFigure[] = [];

  const mean = figureOf(baseline.mean);
  if (mean) {
    figures.push({ key: "mean", label: "Baseline mean", value: mean, dataClass: "historical" });
  }

  const maximum = figureOf(baseline.maximum);
  if (maximum) {
    figures.push({
      key: "maximum",
      label: "Highest on record",
      value: maximum,
      dataClass: "historical",
    });
  }

  const spread = figureOf(baseline.standard_deviation);
  if (spread) {
    figures.push({
      key: "spread",
      label: "Year-to-year spread",
      value: spread,
      dataClass: "historical",
    });
  }

  return {
    figures: figures.slice(0, HISTORICAL_FIGURE_LIMIT),
    coverage: requested > 0 ? years / requested : null,
    coverageNote: `${years} of ${requested} requested year${requested === 1 ? "" : "s"}`,
    paragraph: baseline.labelling ?? null,
  };
}

/* --------------------------------------------------------- anomaly attention */

export interface AnomalyAttention {
  readonly count: number;
  readonly method: string;
  readonly threshold: string;
  /** The entry that stood out furthest, as the backend scored it. Selected, never computed. */
  readonly strongest: {
    readonly stamp: string;
    readonly deviation: string;
    readonly score: string;
  };
}

/**
 * The artifact's "Anomaly Attention" card — and nothing at all when the window is unremarkable.
 *
 * Its version carries a percentage and a sigma figure whichever way the window went. This returns
 * null unless the backend actually flagged an entry, because an alert panel that is always present
 * is not an alert. The method and the threshold travel with it for the disclosure; what the card
 * shows is the count and the one that stood out furthest.
 */
export function anomalyAttentionFrom(analysis: AnalysisResponse | null): AnomalyAttention | null {
  const report = analysis?.anomalies ?? null;
  const points = report?.anomalies ?? [];
  if (!report || points.length === 0) return null;

  const strongest = points.reduce((furthest, point) =>
    Math.abs(point.deviation_score) > Math.abs(furthest.deviation_score) ? point : furthest,
  );

  return {
    count: points.length,
    method: report.method,
    threshold: roundTo(report.threshold, 2),
    strongest: {
      // The local day and hour, not the full offset-bearing stamp: a card is read, not audited.
      stamp: strongest.time_local.slice(0, 16).replace("T", " "),
      deviation: signedOf(strongest.deviation, report.unit || null),
      score: roundTo(strongest.deviation_score, 2),
    },
  };
}

/* ------------------------------------------------------------- the grounding */

export interface GroundingRow {
  /** What this source supplied, as the report's own short label. */
  readonly role: string;
  readonly provider: string;
  readonly dataClass: DataClassName;
}

/**
 * The artifact's "Grounding Evidence" panel, compacted to what it is for.
 *
 * Its version scores three named third-party feeds with millisecond latencies, under a retrieval
 * score of 0.964. None of those exists. What does is the surface behind each class of figure on
 * the page — one row each, in the order the report reads them, with the provider that answered and
 * the class it supplied. The retrieval timestamps that used to sit in these rows are in *Deep
 * dive*, which is where somebody checking a retrieval looks.
 */
export function groundingFrom({
  current,
  forecast,
  baseline,
  analysis,
  answer,
}: {
  readonly current: CurrentResponse | null;
  readonly forecast: ForecastResponse | null;
  readonly baseline: Baseline | null;
  readonly analysis: AnalysisResponse | null;
  readonly answer: AnswerEnvelope | null;
}): GroundingRow[] {
  const rows: GroundingRow[] = [];

  if (current?.attribution?.provider) {
    rows.push({
      role: "Conditions now",
      provider: current.attribution.provider,
      dataClass: "observed",
    });
  }
  if (forecast?.attribution?.provider) {
    rows.push({ role: "Forecast", provider: forecast.attribution.provider, dataClass: "forecast" });
  }
  if (baseline?.provider) {
    rows.push({ role: "Archive record", provider: baseline.provider, dataClass: "historical" });
  }
  if (analysis?.provider) {
    rows.push({ role: "Analytics", provider: "Weathra", dataClass: "analytics" });
  }
  if (answer?.llm_model) {
    rows.push({
      role: "Synthesis",
      provider: answer.llm_provider ?? answer.llm_model,
      dataClass: "interpretation",
    });
  }

  return rows.slice(0, GROUNDING_ROW_LIMIT);
}

/* --------------------------------------------------------------- the footer */

export interface FooterState {
  readonly key: string;
  readonly label: string;
  readonly tone: "ok" | "warning";
}

/**
 * The artifact's footer strip, as states the backend actually reports.
 *
 * Its version reads "ALL SENSOR NODES OPERATIONAL · TELEMETRY_SYNC: 100% · VALIDATED AUDIT LOG ·
 * WEATHRA V4.8.2-PRO · SYSTEM_LOCKED". Weathra owns no node, syncs no telemetry, validates no audit
 * log, and versions nothing on a screen. What it does have is how many of the report's reads
 * returned, and whether the synthesis run's own grounding check verified every figure in the prose
 * — `GroundingReport.verified` is a real boolean from a real check, and where it is false this says
 * so rather than going quiet.
 */
export function footerFrom({
  reads,
  returned,
  answer,
}: {
  readonly reads: number;
  readonly returned: number;
  readonly answer: AnswerEnvelope | null;
}): FooterState[] {
  const states: FooterState[] = [
    returned === reads
      ? { key: "retrieval", label: "Retrieval complete", tone: "ok" }
      : { key: "retrieval", label: `${returned} of ${reads} reads returned`, tone: "warning" },
  ];

  const grounding = answer?.grounding;
  if (grounding) {
    states.push(
      grounding.verified
        ? { key: "grounding", label: "Grounding verified", tone: "ok" }
        : { key: "grounding", label: "Grounding not verified", tone: "warning" },
    );
  }

  return states;
}

/**
 * The report's reference, from the one identifier this run genuinely has.
 *
 * The artifact prints `REPORT ID: WX-INTEL-882-B`. Weathra issues no report and stores none, so
 * there is no such id — but the synthesis run *is* stored, under the evidence id the grounding
 * panel links to, and naming the report by the record that can be audited is the honest version of
 * the artifact's field. Nothing is printed before that record exists.
 */
export function reportReferenceFrom(evidenceId: string | null | undefined): string | null {
  if (!evidenceId) return null;
  const trimmed = evidenceId.replace(/^run-/, "");
  return trimmed.length === 0 ? null : trimmed.slice(0, 8).toUpperCase();
}
