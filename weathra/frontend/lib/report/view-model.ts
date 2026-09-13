/**
 * The Weather Intelligence Report's view model — what the report *shows*, decided in one place.
 *
 * `docs/design/screens/12-weather-intelligence-report.png` is a curated intelligence report: a
 * headline synthesis with three figures under it, six observed tiles beside it, a week of day
 * cards, up to three "what changed" notes, one chart with four stats under it, one historical
 * side card, one attention card, and a short grounding list. Production rendered the same six
 * endpoints *exhaustively* — every finding, every horizon band, every flagged entry and every
 * hourly row — which is why it read as an internal tool rather than as a report.
 *
 * So the curation is a module rather than a set of decisions scattered through JSX. Three rules
 * hold here and are tested:
 *
 * **Nothing is composed.** Every string below is a figure the backend computed, a phrase the
 * backend wrote (`summary`, `characterization`, `labelling`, a `DayChange.statement`, a `method`),
 * or a fixed label for a field. No sentence about the weather is written here.
 *
 * **Nothing is counted or estimated for effect.** The artifact's `EVIDENCE NODES: 124`,
 * `CONFIDENCE 98.4%`, decadal stability index and model-alignment score have no figure behind
 * them; `docs/design/screens.md` §5 refuses each, and none of them is reconstructed here from
 * something that happens to be nearby.
 *
 * **Every limit is a constant, and the overflow is kept.** A cap returns what it dropped, so the
 * screen can put the remainder behind a disclosure instead of the report silently losing figures.
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

/* --------------------------------------------------------------- the limits */

/** The artifact's three hero figures, its six tiles, its week, its three notes, its four stats. */
export const HERO_FIGURE_LIMIT = 3;
export const CURRENT_TILE_LIMIT = 6;
export const OUTLOOK_DAY_LIMIT = 7;
export const CHANGE_NOTE_LIMIT = 3;
export const CHART_STAT_LIMIT = 4;
export const EVIDENCE_CHIP_LIMIT = 4;

/** The horizons the report offers, and the horizons `GET /weather/forecast` takes. */
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

/* -------------------------------------------------------------- small shared */

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
  readonly delta?: { readonly text: string; readonly tone: "up" | "down" | "flat" };
  readonly note?: string;
}

/* ------------------------------------------------------------- the synthesis */

export interface ReportSynthesis {
  /** The report's one headline statement. Written by the backend, never composed here. */
  readonly headline: string | null;
  /** One short grounded paragraph under it, when there is a second backend sentence to show. */
  readonly lead: string | null;
}

/**
 * The hero's headline and its paragraph.
 *
 * The artifact's is "Immediate Convective Alert: Localized Thermal Drift", written by an agent it
 * calls neural and attributes a version to. Weathra has two sentences that are genuinely *about*
 * this window and were genuinely written for it — the comparison's characterization of where the
 * window sits against the record, and the analysis engine's deterministic summary of its own
 * findings. The stronger one leads and the other follows it; where only one exists it leads alone,
 * and where neither does the hero carries its figures and no prose.
 *
 * Neither is ever printed twice: the summary is dropped from the lead when it is already the
 * headline. Repeating one sentence in two weights is the redundancy this pass exists to remove.
 */
export function synthesisFrom({
  analysis,
  comparison,
}: {
  readonly analysis: AnalysisResponse | null;
  readonly comparison: BaselineComparison | null;
}): ReportSynthesis {
  const characterization = comparison?.characterization?.trim() || null;
  const summary = analysis?.summary?.trim() || null;
  const headline = characterization ?? summary;
  return {
    headline,
    lead: headline !== null && headline !== summary ? summary : null,
  };
}

/**
 * The three figures under the headline — the artifact's CONFIDENCE / EVIDENCE NODES / DRIFT
 * VARIANCE row, as the figures Weathra actually computes.
 *
 * Two of the three map straight across: the forecast's own banded confidence at the nearest
 * horizon, and the signed distance from the archive baseline with its z-score beside it. The third
 * does not — there is no evidence-node count, and there will not be one, so the slot goes to the
 * trend the analytics engine computed across the same window. A figure the backend did not return
 * takes no tile, which is what makes a two-tile hero read as a shorter report rather than a broken
 * one.
 */
export function heroFiguresFrom({
  forecast,
  comparison,
  analysis,
}: {
  readonly forecast: ForecastResponse | null;
  readonly comparison: BaselineComparison | null;
  readonly analysis: AnalysisResponse | null;
}): ReportFigure[] {
  const figures: ReportFigure[] = [];

  const nearest = forecast?.uncertainty?.horizon?.[0] ?? null;
  if (nearest) {
    figures.push({
      key: "confidence",
      label: "Outlook confidence",
      value: nearest.confidence,
      dataClass: "forecast",
      note: `At ${nearest.hours_ahead} h into the horizon.`,
    });
  }

  const difference = comparison?.difference;
  const zScore = comparison?.z_score;
  if (difference && typeof difference.value === "number") {
    figures.push({
      key: "baseline-difference",
      label: "Against the baseline",
      value: signedOf(difference.value, difference.unit),
      dataClass: "analytics",
      delta:
        zScore && typeof zScore.value === "number"
          ? { text: `${zScore.value} σ from the mean`, tone: toneOf(zScore.value) }
          : undefined,
      note: difference.method,
    });
  }

  const trend = analysis?.trend ?? null;
  if (trend && typeof trend.magnitude === "number") {
    figures.push({
      key: "trend",
      label: "Trend across the window",
      value: signedOf(trend.magnitude, trend.unit),
      dataClass: "analytics",
      delta: { text: trend.direction, tone: toneOf(trend.slope_per_day) },
      note: trend.method,
    });
  }

  return figures.slice(0, HERO_FIGURE_LIMIT);
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

export interface CurrentTiles {
  /** At most six, in the artifact's order. */
  readonly shown: readonly Reading[];
  /** Everything else the provider reported, for the disclosure. Never dropped. */
  readonly rest: readonly Reading[];
}

export function currentTilesFrom(current: CurrentResponse | null): CurrentTiles {
  const readings = readingsFromCurrent(current);
  const ranked = [...readings].sort((left, right) => rankOf(left.key) - rankOf(right.key));
  return {
    shown: ranked.slice(0, CURRENT_TILE_LIMIT),
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
 * of fourteen is a data dump in the position the report's most scannable region is supposed to
 * occupy. The cap is on the *cards*, not on the retrieval — the chart below still plots the whole
 * window, so nothing retrieved is hidden by it.
 */
export function outlookFrom(forecast: ForecastResponse | null): OutlookDay[] {
  return forecastDaysFrom(forecast?.daily)
    .slice(0, OUTLOOK_DAY_LIMIT)
    .map((day) => ({
      date: day.date,
      weekday: weekdayOf(day.date),
      condition: conditionFor(day.conditionCode),
      high: day.high,
      low: day.low,
      precipitation: dayPrecipitationFrom(day),
    }));
}

/* ---------------------------------------------------------- what has changed */

export interface ChangeNote {
  readonly key: string;
  readonly date: string;
  readonly label: string;
  readonly value: string;
  readonly tone: "up" | "down" | "flat";
  readonly material: boolean;
}

export interface ChangedView {
  /** The backend's own one-line statement about the comparison. */
  readonly statement: string;
  /** At most three movements, material ones first. */
  readonly notes: readonly ChangeNote[];
  /** How many movements the endpoint reported but this panel does not show. */
  readonly hidden: number;
}

/**
 * The artifact's three "what changed" cards, from `GET /weather/changes`.
 *
 * The endpoint returns one `DayChange` per day per measure, which for a fourteen-day window is
 * dozens of rows — production listed all of them. The artifact shows three notes, so three is what
 * this returns: material movements first, in the backend's own order, and the count of what is not
 * shown so the panel can say so rather than appear complete.
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
    statement: changes.statement,
    notes: ordered.slice(0, CHANGE_NOTE_LIMIT).map((change) => ({
      key: `${change.local_date}-${change.measure}`,
      date: change.local_date,
      label: measureLabel(change.measure),
      value: signedOf(change.change, change.unit),
      tone: toneOf(change.change),
      material: change.material,
    })),
    hidden: Math.max(ordered.length - CHANGE_NOTE_LIMIT, 0),
  };
}

/* ------------------------------------------------------- the one chart block */

/** One finding, found by what it measures and what it computes. */
function findingOf(
  analysis: AnalysisResponse | null,
  statistic: string,
): StatisticResult | null {
  return (
    (analysis?.findings ?? []).find(
      (result) => result.statistic === statistic && result.measure.startsWith("temperature"),
    ) ?? null
  );
}

/**
 * The three or four figures the artifact prints under its chart — PEAK DRIFT, HISTORICAL MEAN,
 * Sigma, Confidence — as the figures Weathra has for each.
 *
 * Every one is read off a response: two findings the analytics engine returned for the plotted
 * measure, the baseline's own mean, and the comparison's z-score. Nothing is derived from the
 * plotted series here — the chart and this row must state the same arithmetic, and the only way to
 * guarantee that is for neither to do any.
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
      note: maximum.occurred_at_local ?? undefined,
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
      note: baseline.labelling,
    });
  }

  const zScore = comparison?.z_score;
  if (zScore && typeof zScore.value === "number") {
    stats.push({
      key: "z-score",
      label: "Distance from baseline",
      value: `${zScore.value} σ`,
      dataClass: "analytics",
      note: zScore.method,
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
  /** One short paragraph — the backend's characterization, or the baseline's own labelling. */
  readonly paragraph: string | null;
}

export function historicalContextFrom({
  baseline,
  comparison,
  headline,
}: {
  readonly baseline: Baseline | null;
  readonly comparison: BaselineComparison | null;
  /**
   * What the hero already says, so this card never says it again.
   *
   * The comparison's characterization is the natural paragraph for this card *and* the report's
   * strongest headline, and it cannot be both — the same sentence in two weights on one screen is
   * the prose redundancy this pass exists to remove. The hero wins it, and the card falls back to
   * the baseline's own labelling, which describes the record rather than the window.
   */
  readonly headline: string | null;
}): HistoricalContextView | null {
  if (!baseline) return null;

  const years = baseline.years_used?.length ?? 0;
  const requested = baseline.years_requested ?? 0;
  const figures: ReportFigure[] = [];

  const mean = figureOf(baseline.mean);
  if (mean) {
    figures.push({
      key: "mean",
      label: "Baseline mean",
      value: mean,
      dataClass: "historical",
      note: `${measureLabel(baseline.measure)} over ${years} year${years === 1 ? "" : "s"}.`,
    });
  }

  const maximum = figureOf(baseline.maximum);
  if (maximum) {
    figures.push({
      key: "maximum",
      label: "Highest on record",
      value: maximum,
      dataClass: "historical",
      note: baseline.maximum.occurred_at_local ?? undefined,
    });
  }

  const spread = figureOf(baseline.standard_deviation);
  if (spread) {
    figures.push({
      key: "spread",
      label: "Year-to-year spread",
      value: spread,
      dataClass: "historical",
      note: baseline.standard_deviation.method,
    });
  }

  return {
    figures: figures.slice(0, 3),
    coverage: requested > 0 ? years / requested : null,
    coverageNote:
      baseline.coverage_note ??
      `${years} of the ${requested} requested year${requested === 1 ? "" : "s"} were available.`,
    paragraph:
      comparison?.characterization && comparison.characterization !== headline
        ? comparison.characterization
        : (baseline.labelling ?? null),
  };
}

/* --------------------------------------------------------- anomaly attention */

export interface AnomalyAttention {
  readonly count: number;
  readonly method: string;
  readonly threshold: number;
  /** The entry that stood out furthest, as the backend scored it. Selected, never computed. */
  readonly strongest: {
    readonly stamp: string;
    readonly deviation: string;
    readonly score: number;
  };
}

/**
 * The artifact's "Anomaly Attention" card — and nothing at all when the window is unremarkable.
 *
 * Its version carries a percentage and a sigma figure whichever way the window went. This returns
 * null unless the backend actually flagged an entry, because an alert panel that is always present
 * is not an alert. The plot of every flagged entry stays behind the report's disclosure; what is
 * on the page is the count, the method, and the one that stood out furthest.
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
    threshold: report.threshold,
    strongest: {
      stamp: strongest.time_local,
      deviation: signedOf(strongest.deviation, report.unit || null),
      score: strongest.deviation_score,
    },
  };
}

/* ----------------------------------------------------------- the grounding */

export interface GroundingRow {
  /** What this source supplied, as the report's own short label. */
  readonly role: string;
  readonly provider: string;
  readonly detail: string;
  readonly dataClass: DataClassName;
}

/**
 * The artifact's "Grounding Evidence" panel, compacted to what it is for.
 *
 * Its version scores three named third-party feeds with millisecond latencies. None of those
 * exists. What does is the surface behind each class of figure on the page — one row each, in the
 * order the report reads them, with the provider that answered and one short detail. Production
 * printed the same rows with a sentence of provenance in each; the sentence belongs in Agent
 * Evidence, which is where somebody checking the arithmetic goes.
 */
export function groundingFrom({
  current,
  forecast,
  baseline,
  analysis,
  formatStamp,
}: {
  readonly current: CurrentResponse | null;
  readonly forecast: ForecastResponse | null;
  readonly baseline: Baseline | null;
  readonly analysis: AnalysisResponse | null;
  /** How an instant is rendered, injected so this module formats no time itself. */
  readonly formatStamp: (value: string | null | undefined) => string | null;
}): GroundingRow[] {
  const rows: GroundingRow[] = [];

  if (current?.attribution?.provider) {
    rows.push({
      role: "Conditions now",
      provider: current.attribution.provider,
      detail: formatStamp(current.attribution.retrieved_at) ?? "Retrieval time not reported",
      dataClass: "observed",
    });
  }
  if (forecast?.attribution?.provider) {
    rows.push({
      role: "Outlook",
      provider: forecast.attribution.provider,
      detail: formatStamp(forecast.attribution.retrieved_at) ?? "Retrieval time not reported",
      dataClass: "forecast",
    });
  }
  if (baseline?.provider) {
    rows.push({
      role: "Archive record",
      provider: baseline.provider,
      detail: baseline.labelling,
      dataClass: "historical",
    });
  }
  if (analysis?.provider) {
    rows.push({
      role: "Statistics",
      provider: "Computed by Weathra",
      detail: `From the series ${analysis.provider} returned.`,
      dataClass: "analytics",
    });
  }

  return rows;
}

/**
 * The chips under the model's reading: what it was written about, and what wrote it.
 *
 * The artifact's are `Source ID: WX-CHUNK-882`, `Baseline: WMO-1991-2020` and a protocol
 * validation mark. The first two have Weathra equivalents that are real — the providers the run
 * itself attributed its answer to, and the baseline's own labelling — and the third does not;
 * nothing here validates an answer against a protocol, so no chip claims it. The model that wrote
 * the prose is named instead, which is the disclosure `specs/web-ui` actually requires.
 */
export function evidenceChipsFrom({
  answer,
  baseline,
}: {
  readonly answer: AnswerEnvelope | null;
  readonly baseline: Baseline | null;
}): string[] {
  const chips: string[] = [];

  for (const attribution of answer?.attribution ?? []) {
    const chip = `Read from ${attribution.provider}`;
    if (!chips.includes(chip)) chips.push(chip);
  }
  if (baseline?.labelling) chips.push(baseline.labelling);
  if (answer?.llm_model) {
    chips.push(
      answer.llm_provider ? `${answer.llm_provider} · ${answer.llm_model}` : answer.llm_model,
    );
  }

  return chips.slice(0, EVIDENCE_CHIP_LIMIT);
}
