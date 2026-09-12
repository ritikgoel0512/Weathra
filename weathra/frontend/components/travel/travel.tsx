"use client";

/**
 * Travel Intelligence — which days at a destination the weather favours, and why.
 *
 * Built against `docs/design/screens/15-travel-intelligence.png`: the trip header, the weather
 * window, the daily outlook, the derived guidance, the disclaimer.
 *
 * **The score is the backend's, not this screen's.** `POST /weather/comparison` already ranks the
 * days inside one place's window against a named criterion, and returns each day's score together
 * with the *contributions* that produced it. So the "travel viability index" the artifact draws is
 * replaced by a figure Weathra actually computes, with its components on screen — rather than by
 * arithmetic invented in a browser, which `specs/deterministic-analytics` puts in the backend for
 * exactly this reason.
 *
 * **It is weather, and says so.** The artifact carries flight stability, airline operations and
 * booking. Weathra knows none of those and offers none of them. What it can say is what the weather
 * is expected to do at a place over a window, which is what this screen says.
 */

import { PlaceChooser } from "@/components/locations/place-chooser";
import { ScreenPreview } from "@/components/locations/screen-preview";
import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  ErrorState,
  NOT_REPORTED,
  LoadingState,
  LocationImage,
  formatInstant,
  Meter,
  WeatherIcon,
} from "@/components/ui";
import type {
  ComparisonCandidate,
  ComparisonResult,
  BaselineComparison,
  Criterion,
  ForecastResponse,
  Location,
  PreferenceView,
  StatisticResult,
  WhatChanged,
} from "@/lib/api/schema";
import {
  briefingLocationFrom,
  formatReading,
  measureLabel,
} from "@/lib/dashboard/briefing";
import { ForecastTrendChart, type TrendPoint } from "@/components/explorer/trend-chart";
import { hourLabel, localLabel } from "@/lib/explorer/reading";
import { baselineYearsStatement, formatSigned } from "@/lib/historical/analysis";
import { friendlyName } from "@/lib/locations/place";
import { conditionFor } from "@/lib/weather/condition";
import { useApiQuery } from "@/lib/query/hooks";
import type { ViewFailure } from "@/lib/query/state";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./travel.module.css";

/** What "good weather to travel for" can mean, in the criteria the backend actually scores. */
const CRITERIA: readonly { value: Criterion; label: string }[] = [
  { value: "outdoor_suitability", label: "Good to be outside" },
  { value: "warmest", label: "Warmest" },
  { value: "coolest", label: "Coolest" },
  { value: "driest", label: "Driest" },
  { value: "least_windy", label: "Least windy" },
];

/**
 * What a candidate's supporting statistics say, keyed the way this screen asks for them.
 *
 * The backend returns the analytics that produced a score; the screen needs three or four of them
 * by name for the hero, the metric row and the guidance. Reading them by measure here, once, is
 * what keeps those three regions from each inventing their own lookup.
 */
function statOf(
  candidate: ComparisonCandidate | null,
  measures: readonly string[],
): StatisticResult | null {
  for (const measure of measures) {
    const found = (candidate?.supporting ?? []).find(
      (statistic) => statistic.measure === measure,
    );
    if (found && typeof found.value === "number" && Number.isFinite(found.value)) return found;
  }
  return null;
}

function reading(statistic: StatisticResult | null): string | null {
  if (statistic === null) return null;
  return formatReading({ value: statistic.value as number, unit: statistic.unit ?? null });
}

/** The weekday and date a candidate's window opens on, from the period the backend stated. */
function dayLabel(candidate: ComparisonCandidate): { weekday: string; date: string } {
  const parsed = localLabel(candidate.period?.start_local);
  if (parsed === null) return { weekday: candidate.label, date: "" };
  const [weekday] = parsed.split(" ");
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(candidate.period.start_local);
  const date = match ? `${match[3]} ${MONTHS[Number(match[2]) - 1]}` : "";
  return { weekday: weekday ?? candidate.label, date };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Where a day's score sits between the worst and the best in this ranking.
 *
 * The meters divided by the best score, which is only meaningful while scores are positive. Ask the
 * backend for "coolest" and it ranks on *negative* temperature — the best day at London scored
 * −15.5 — so every other day divided to more than one and clamped to a full bar: seven days, seven
 * identical meters, and the ranking illegible in exactly the composite-free criteria a traveller is
 * most likely to pick. Placing each score in the range the ranking actually spans is right for both
 * signs, and gives the worst day an empty bar rather than a near-full one.
 *
 * `null` where every day scored alike: a bar implying a distinction the figures do not make would
 * be the screen inventing one.
 */
function scoreSpan(candidates: readonly ComparisonCandidate[]): (score: number) => number | null {
  const scores = candidates
    .map((candidate) => candidate.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) return () => null;

  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  if (highest === lowest) return () => null;

  return (score) => Math.max(0, Math.min(1, (score - lowest) / (highest - lowest)));
}

/**
 * The day a candidate stands for, written the way a person says it.
 *
 * The backend labels a day-level candidate with its ISO date, because a label in a ranking is an
 * identifier and `2026-09-14` is the only unambiguous one. That is the right thing to send and the
 * wrong thing to show: this screen was rendering it verbatim into "Score for 2026-09-14", which is
 * a timestamp on a customer's screen. Every visible use of a candidate's identity goes through
 * here instead.
 */
function candidateLabel(candidate: ComparisonCandidate): string {
  const { weekday, date } = dayLabel(candidate);
  const spoken = `${weekday} ${date}`.trim();
  return spoken === "" ? candidate.label : spoken;
}

/**
 * The provider's own daily entries, keyed by the local date they fall on.
 *
 * The ranking scores a day and returns the statistics that produced the score; the *sky* over that
 * day — its condition code, its high and low, how likely rain is — is in the daily series of the
 * forecast this screen already retrieves for the hourly chart. It was being fetched and then read
 * only for its hours, so the outlook cards drew a mean temperature where the artifact draws a
 * condition and a range. Nothing new is requested for this; it is the same response, read twice.
 */
function dailyByDate(forecast: ForecastResponse | null): Map<string, Record<string, number | null>> {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const entry of forecast?.daily?.entries ?? []) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(entry.time_local ?? "");
    if (match?.[1]) byDate.set(match[1], entry.values ?? {});
  }
  return byDate;
}

/** A finite number from a daily entry, or `null` where the provider reported none. */
function numberOf(values: Record<string, number | null> | undefined, key: string): number | null {
  const found = values?.[key];
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

/** A figure and its unit, as the daily series expresses it. */
function dailyReading(
  forecast: ForecastResponse | null,
  values: Record<string, number | null> | undefined,
  key: string,
): string | null {
  const value = numberOf(values, key);
  if (value === null) return null;
  return formatReading({ value, unit: forecast?.daily?.units?.[key] ?? null });
}

/**
 * The destination hero — the artifact's dominant photographic band, carrying the decision.
 *
 * Its own reads "Weather Window Identified" over a paragraph about marine layer convection at 94%
 * model confidence. What goes here instead is the day the ranking actually put first and the
 * figures that put it there: nothing is characterised, and nothing is claimed about why.
 */
function DestinationHero({
  location,
  best,
}: {
  readonly location: Location;
  readonly best: ComparisonCandidate | null;
}): ReactNode {
  const temperature = statOf(best, ["temperature_max", "temperature_mean", "temperature"]);
  const humidity = statOf(best, ["relative_humidity_mean", "relative_humidity"]);
  const wind = statOf(best, ["wind_speed_max", "wind_speed"]);
  const day = best ? dayLabel(best) : null;

  return (
    <LocationImage
      displayName={friendlyName(location)}
      latitude={location.latitude}
      longitude={location.longitude}
      variant="hero"
      scrim="strong"
    >
      {best ? <Badge tone="accent">Best window</Badge> : null}
      <span className={styles.heroPlace}>{friendlyName(location)}</span>
      <span className={styles.heroZone}>
        {day ? `Weather favours ${day.weekday} ${day.date}`.trim() : location.timezone}
      </span>

      {best ? (
        <dl className={styles.heroFacts}>
          {reading(temperature) ? (
            <div className={styles.heroFact}>
              <dt>{measureLabel(temperature!.measure)}</dt>
              <dd className={styles.heroFigure}>{reading(temperature)}</dd>
            </div>
          ) : null}
          {reading(humidity) ? (
            <div className={styles.heroFact}>
              <dt>Humidity</dt>
              <dd>{reading(humidity)}</dd>
            </div>
          ) : null}
          {reading(wind) ? (
            <div className={styles.heroFact}>
              <dt>Wind</dt>
              <dd>{reading(wind)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </LocationImage>
  );
}

/**
 * The artifact's Travel Viability Index, as a figure Weathra can source.
 *
 * Its own is a ring reading 88 EXCELLENT over "thermal comfort 92%" and "activity exposure 84%",
 * none of which any endpoint produces. What does exist is the backend's own score for each day and
 * the *contributions* that produced it — so the ring carries this day's score against the best day
 * in the window, which is a ratio of two figures the response contains, and the bars beneath it are
 * the contributions named in it.
 */
function SuitabilityCard({
  result,
  best,
}: {
  readonly result: ComparisonResult;
  readonly best: ComparisonCandidate | null;
}): ReactNode {
  const ranked = result.candidates.length;
  const contributions = best?.contributions ?? [];

  return (
    <Card aria-labelledby="travel-suitability">
      <CardHeader
        title="Weather suitability"
        titleId="travel-suitability"
        badge={<DataClassBadge dataClass="analytics" />}
      />
      <CardBody>
        {best === null ? (
          <p className={styles.quiet}>No day in this window could be scored.</p>
        ) : (
          <>
            {/*
              A rank rather than an index out of a hundred. The backend's score has no ceiling and
              turning it into a percentage would invent the scale; what it does have is an order,
              and "first of seven" is the thing a person is actually deciding with.
            */}
            <div className={styles.ring}>
              <span className={styles.ringRank}>#{best.rank}</span>
              <span className={styles.ringOf}>of {ranked} days</span>
            </div>
            <p className={styles.ringDay}>
              {dayLabel(best).weekday} {dayLabel(best).date} ranks first for{" "}
              {result.criterion.replace(/_/g, " ")}.
            </p>

            {contributions.length > 0 ? (
              <dl className={styles.contributions}>
                {contributions.map((contribution) => (
                  <div className={styles.contribution} key={contribution.measure}>
                    <dt>{measureLabel(contribution.measure)}</dt>
                    <dd>{contribution.contribution}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}

        <p className={styles.disclaimer}>
          Weather suitability only — not transport or safety advice.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The four compact cards the artifact sets under the hero, from the best day's own figures.
 *
 * The artifact's four are Temp Variance, Flight Stability, Precip Cluster and Sun Exposure. Two of
 * those are aviation measures Weathra has no data for and does not offer; what stands here instead
 * are four measures it really holds for that day.
 *
 * **Three came from the ranking and the fourth did not.** A day-level ranking supports its score
 * with temperature, precipitation and wind — and nothing else, so a row asking `supporting` for a
 * fourth measure rendered three cards and a gap. The fourth is read from the provider's daily
 * entry for the same day, which is the same retrieval the outlook cards and the chart already use.
 */
function TravelMetrics({
  best,
  forecast,
  daily,
}: {
  readonly best: ComparisonCandidate | null;
  readonly forecast: ForecastResponse | null;
  readonly daily: Record<string, number | null> | undefined;
}): ReactNode {
  const statCards = [
    { key: "temperature", label: "Best-day temperature", stat: statOf(best, ["temperature_max", "temperature_mean", "temperature"]) },
    { key: "precipitation", label: "Rain in the window", stat: statOf(best, ["precipitation_sum", "precipitation"]) },
    { key: "wind", label: "Wind", stat: statOf(best, ["wind_gust_max", "wind_speed_max", "wind_speed"]) },
  ]
    .filter((card) => card.stat !== null)
    .map((card) => ({
      key: card.key,
      label: card.label,
      value: reading(card.stat) as string,
      note: card.stat!.method,
    }));

  /*
   * The fourth, in the order a traveller would ask for it: how likely rain is, then how strong the
   * sun is, then how wide the day swings. Whichever the provider reported first is the one drawn,
   * and where it reported none the row is three cards rather than a card with nothing in it.
   */
  const chance = numberOf(daily, "precipitation_probability_max");
  const uv = numberOf(daily, "uv_index_max");
  const high = numberOf(daily, "temperature_max");
  const low = numberOf(daily, "temperature_min");

  const fourth =
    chance !== null
      ? { key: "chance", label: "Chance of rain", value: `${Math.round(chance)}%`, note: "highest hourly chance the provider reported for this day" }
      : uv !== null
        ? { key: "uv", label: "Strongest sun", value: `${Math.round(uv * 10) / 10} UV`, note: "the day's peak UV index, as the provider reported it" }
        : high !== null && low !== null
          ? {
              key: "range",
              label: "High and low",
              value: `${dailyReading(forecast, daily, "temperature_max")} / ${dailyReading(forecast, daily, "temperature_min")}`,
              note: "the day's reported high and low",
            }
          : null;

  const cards = fourth === null ? statCards : [...statCards, fourth];
  if (cards.length === 0) return null;

  return (
    <section className={styles.metrics} aria-label="Figures for the best-ranked day">
      {cards.map((card) => (
        <div className={styles.metric} key={card.key}>
          <DataClassBadge dataClass={card.key === "chance" || card.key === "uv" || card.key === "range" ? "forecast" : "analytics"} />
          <p className={styles.metricLabel}>{card.label}</p>
          <p className={styles.metricValue}>{card.value}</p>
          <p className={styles.metricNote}>{card.note}</p>
        </div>
      ))}
    </section>
  );
}

/**
 * One day in the window, as the artifact's outlook cards draw them.
 *
 * The full score bar, its supporting figures and the contributions that produced it are all still
 * here — behind the card's own press rather than down the page, which is where they were.
 */
function DayCard({
  candidate,
  place,
  forecast,
  daily,
}: {
  readonly candidate: ComparisonCandidate;
  /** Where this day's score sits in the range the ranking spans. */
  readonly place: (score: number) => number | null;
  readonly forecast: ForecastResponse | null;
  readonly daily: Record<string, number | null> | undefined;
}): ReactNode {
  const { weekday, date } = dayLabel(candidate);
  const temperature = statOf(candidate, ["temperature_max", "temperature_mean", "temperature"]);
  const rain = statOf(candidate, ["precipitation_sum", "precipitation"]);

  /*
   * The sky, the range and the chance of rain, from the provider's own daily entry for this date.
   *
   * The artifact's outlook cards carry a glyph, a high, a low and a precipitation figure. The
   * ranking's `supporting` list carries none of those — it holds the statistics the *score* was
   * computed from — so a card built only from it showed one temperature and no weather at all.
   * These three reads are the provider's values as retrieved, not figures derived here.
   */
  const condition = conditionFor(numberOf(daily, "weather_code_dominant"));
  const high = dailyReading(forecast, daily, "temperature_max");
  const low = dailyReading(forecast, daily, "temperature_min");
  const chance = numberOf(daily, "precipitation_probability_max");

  return (
    <li className={styles.day} data-best={candidate.rank === 1 ? "true" : undefined}>
      <p className={styles.dayWeekday}>{weekday}</p>
      <p className={styles.dayDate}>{date}</p>

      {condition ? (
        <p className={styles.dayCondition}>
          <WeatherIcon condition={condition} size={26} />
          <span>{condition.label}</span>
        </p>
      ) : null}

      <p className={styles.dayFigure}>{high ?? reading(temperature) ?? "—"}</p>
      {low ? <p className={styles.dayRange}>Low {low}</p> : null}
      <p className={styles.dayRain}>
        {reading(rain) ?? "No rain reported"}
        {chance === null ? "" : ` · ${Math.round(chance)}% chance`}
      </p>
      {candidate.rank === 1 ? <Badge tone="ok">Best</Badge> : null}
      {candidate.tied ? <Badge tone="neutral">Tied</Badge> : null}

      <Meter label={`Score for ${candidateLabel(candidate)}`} value={place(candidate.score)} />

      {(candidate.supporting ?? []).length > 0 || (candidate.contributions ?? []).length > 0 ? (
        <details className={styles.why}>
          <summary>Show details</summary>
          {(candidate.supporting ?? []).length > 0 ? (
            <dl className={styles.supporting}>
              {candidate.supporting.map((statistic) => (
                <div key={`${statistic.measure}-${statistic.statistic}`}>
                  <dt>{measureLabel(statistic.measure)}</dt>
                  <dd>
                    {statistic.value === null || statistic.value === undefined
                      ? "Not computable"
                      : formatReading({ value: statistic.value, unit: statistic.unit ?? null })}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {(candidate.contributions ?? []).length > 0 ? (
            <ul className={styles.whyList}>
              {candidate.contributions!.map((contribution) => (
                <li key={contribution.measure}>
                  {measureLabel(contribution.measure)}: {contribution.contribution}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}

/**
 * The artifact's AI Packing Strategy, without the claim.
 *
 * Its own recommends "Light Breathable Linen" and "UVA/UVB Performance Protection" as ESSENTIAL,
 * which is a product catalogue presented as a model's output. Weathra runs no packing model, so
 * what occupies this slot is the small set of considerations the figures on this screen actually
 * justify — each one naming the figure that raised it, so a reader can check it against the card
 * above rather than trust it.
 */
function TripGuidance({
  best,
  forecast,
  daily,
}: {
  readonly best: ComparisonCandidate | null;
  readonly forecast: ForecastResponse | null;
  readonly daily: Record<string, number | null> | undefined;
}): ReactNode {
  const rain = statOf(best, ["precipitation_sum", "precipitation"]);
  const wind = statOf(best, ["wind_gust_max", "wind_speed_max", "wind_speed"]);
  const temperature = statOf(best, ["temperature_max", "temperature_mean", "temperature"]);
  const low = statOf(best, ["temperature_min"]) ?? null;

  /*
   * The day's own low and its peak sun, where the ranking did not supply them.
   *
   * A day-level ranking supports its score with a mean temperature, so "a warmer layer" was being
   * raised against the *mean* rather than against the cold end of the day, and strong sun could
   * not be raised at all. Both figures are in the provider's daily entry for this date.
   */
  const dayLow = numberOf(daily, "temperature_min");
  const dayHigh = numberOf(daily, "temperature_max");
  const uv = numberOf(daily, "uv_index_max");

  const notes: { key: string; text: string; because: string }[] = [];
  if (rain && (rain.value as number) > 0) {
    notes.push({
      key: "rain",
      text: "Rain protection",
      because: `${reading(rain)} forecast for this day`,
    });
  }
  if (wind && (wind.value as number) >= 30) {
    notes.push({
      key: "wind",
      text: "Wind-resistant outer layer",
      because: `${reading(wind)} expected`,
    });
  }
  const lowValue = dayLow ?? ((low?.value ?? temperature?.value) as number | undefined);
  if (typeof lowValue === "number" && lowValue <= 12) {
    notes.push({
      key: "cool",
      text: "A warmer layer",
      because:
        dayLow === null
          ? `${reading(low ?? temperature)} at the low end`
          : `${dailyReading(forecast, daily, "temperature_min")} at the low end`,
    });
  }
  const highValue = dayHigh ?? ((temperature?.value ?? null) as number | null);
  if (typeof highValue === "number" && highValue >= 25) {
    notes.push({
      key: "warm",
      text: "Light, cool clothing",
      because:
        dayHigh === null
          ? `${reading(temperature)} at the high end`
          : `${dailyReading(forecast, daily, "temperature_max")} at the high end`,
    });
  }
  if (uv !== null && uv >= 6) {
    notes.push({
      key: "uv",
      text: "Sun protection",
      because: `a peak UV index of ${Math.round(uv * 10) / 10} on this day`,
    });
  }

  return (
    <Card aria-labelledby="travel-guidance">
      <CardHeader
        title="Weather-aware trip guidance"
        titleId="travel-guidance"
        badge={<DataClassBadge dataClass="analytics" />}
      />
      <CardBody>
        {notes.length === 0 ? (
          <p className={styles.quiet}>
            Nothing in this day&rsquo;s figures raises a specific consideration. The figures
            themselves are on the cards beside this.
          </p>
        ) : (
          <ul className={styles.guidance}>
            {notes.map((note) => (
              <li className={styles.guide} key={note.key}>
                <span className={styles.guideMark} aria-hidden="true" />
                <span className={styles.guideText}>
                  <span className={styles.guideTitle}>{note.text}</span>
                  <span className={styles.guideBecause}>{note.because}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.disclaimer}>
          Derived from the figures on this screen. Weathra runs no packing model and recommends no
          products.
        </p>
      </CardBody>
    </Card>
  );
}

/* ============================================================ the lower bands */

/** The calendar day a candidate's window opens on, as the backend stated it. */
function dateOf(candidate: ComparisonCandidate | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(candidate?.period?.start_local ?? "");
  return match ? (match[1] ?? null) : null;
}

/**
 * The best-ranked day's own hours — the artifact's intra-day band.
 *
 * One day, not the window. The artifact's own chart is captioned for a single date, and a
 * seven-day hourly series drawn here would be the Forecast Explorer's figure on a screen that is
 * deciding *between* days rather than reading one.
 *
 * The chart is Forecast Explorer's, imported unmodified. It already draws exactly this — a filled
 * temperature line, precipitation on its own axis, clock labels — and building a second one would
 * be two descriptions of the same figure.
 */
function IntradayTrend({
  forecast,
  best,
}: {
  readonly forecast: ForecastResponse | null;
  readonly best: ComparisonCandidate | null;
}): ReactNode {
  const day = dateOf(best);
  const entries = (forecast?.hourly?.entries ?? []).filter((entry) =>
    day === null ? false : (entry.time_local ?? "").startsWith(day),
  );

  const points: TrendPoint[] = entries.map((entry) => ({
    at: entry.time_local,
    label: hourLabel(entry.time_local) ?? entry.time_local,
    temperature: typeof entry.values?.temperature === "number" ? entry.values.temperature : null,
    precipitation:
      typeof entry.values?.precipitation === "number" ? entry.values.precipitation : null,
  }));

  const drawable = points.some((point) => point.temperature !== null);
  const wet = points.some((point) => point.precipitation !== null);
  const label = best ? `${dayLabel(best).weekday} ${dayLabel(best).date}`.trim() : null;

  return (
    <Card aria-labelledby="travel-intraday">
      <CardHeader
        title="Intra-day weather trend"
        titleId="travel-intraday"
        badge={<DataClassBadge dataClass="forecast" />}
        subtitle={label ? `Best-ranked day · ${label}` : "The best-ranked day, hour by hour."}
      />
      <CardBody>
        {drawable ? (
          <ForecastTrendChart
            points={points}
            temperatureUnit={forecast?.hourly?.units?.temperature ?? null}
            precipitationUnit={forecast?.hourly?.units?.precipitation ?? null}
            hasPrecipitation={wet}
            missing={points.filter((point) => point.temperature === null).length}
          />
        ) : (
          <p className={styles.quiet}>
            The provider reported no hourly series for this day, so there is nothing to plot. The
            day&rsquo;s own figures are on the card above.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The artifact's temporal comparison, over windows Weathra can actually see.
 *
 * Its own compares four departure windows across September and October at a "viability score" out
 * of a hundred. Weathra's forecast horizon is days, not months, and its ranking has no ceiling — so
 * the windows are slices of the horizon the ranking already covered, and every figure in a row is
 * *selected* from the days in that slice rather than computed over them. The best rank inside a
 * window, and the temperature and rain of the day that holds it: three selections, no new
 * arithmetic, nothing invented to fill a column.
 */
function WindowMatrix({
  result,
  place,
}: {
  readonly result: ComparisonResult;
  readonly place: (score: number) => number | null;
}): ReactNode {
  const days = [...result.candidates].sort((left, right) =>
    (left.period?.start_local ?? "").localeCompare(right.period?.start_local ?? ""),
  );
  if (days.length < 2) return null;

  /*
   * Thirds of whatever the horizon turned out to be, so a three-day window gives three rows of one
   * and a seven-day window gives two, two and three. Never a window beyond what the provider sent.
   */
  const size = Math.max(1, Math.ceil(days.length / 3));
  const windows: ComparisonCandidate[][] = [];
  for (let index = 0; index < days.length; index += size) {
    windows.push(days.slice(index, index + size));
  }

  return (
    <Card aria-labelledby="travel-windows">
      <CardHeader
        title="Temporal comparison"
        titleId="travel-windows"
        badge={<DataClassBadge dataClass="analytics" />}
        subtitle={`Slices of the ranked window, by ${result.criterion.replace(/_/g, " ")}.`}
      />
      <CardBody>
        <table className={styles.windows}>
          <thead>
            <tr>
              <th scope="col">Travel window</th>
              <th scope="col">Best rank</th>
              <th scope="col">Suitability</th>
              <th scope="col">Temperature</th>
              <th scope="col">Rain</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((window) => {
              const leader = window.reduce((carry, day) => (day.rank < carry.rank ? day : carry));
              const first = dayLabel(window[0] as ComparisonCandidate);
              const last = dayLabel(window[window.length - 1] as ComparisonCandidate);
              const span =
                window.length === 1
                  ? `${first.weekday} ${first.date}`.trim()
                  : `${first.weekday} ${first.date} – ${last.weekday} ${last.date}`.trim();
              const temperature = statOf(leader, [
                "temperature_max",
                "temperature_mean",
                "temperature",
              ]);
              const rain = statOf(leader, ["precipitation_sum", "precipitation"]);

              return (
                <tr key={span} data-best={leader.rank === 1 ? "true" : undefined}>
                  <th scope="row">
                    {span}
                    {leader.rank === 1 ? <Badge tone="ok">Best</Badge> : null}
                  </th>
                  <td>#{leader.rank}</td>
                  <td className={styles.windowMeter}>
                    <Meter label={`Suitability for ${span}`} value={place(leader.score)} />
                  </td>
                  <td>{reading(temperature) ?? "—"}</td>
                  <td>{reading(rain) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

/**
 * What moved since the last time this forecast was retrieved.
 *
 * `/weather/changes` already answers this for the Dashboard and it answers it the same way here:
 * the backend holds the previous snapshot, computes the differences, marks which of them clear the
 * measure's materiality margin, and writes the statement. Nothing is compared in the browser.
 *
 * **The card is drawn either way.** With no earlier snapshot the artifact's slot would simply
 * vanish, which is the composition changing shape because of an absence; the backend says so in
 * `comparison_available` and this says so in the same card.
 */
function WhatChangedCard({ changed }: { readonly changed: WhatChanged | null }): ReactNode {
  const material = (changed?.changes ?? []).filter((change) => change.material);

  return (
    <Card aria-labelledby="travel-changed">
      <CardHeader
        title="What changed?"
        titleId="travel-changed"
        badge={<DataClassBadge dataClass="forecast" />}
      />
      <CardBody>
        {changed === null ? (
          <p className={styles.quiet}>Checking whether this forecast has moved.</p>
        ) : !changed.comparison_available ? (
          <p className={styles.quiet}>
            No earlier forecast snapshot is available for this trip yet. Once another forecast is
            recorded, Weathra can compare how the trip outlook changed.
          </p>
        ) : (
          <>
            <p className={styles.railNote}>{changed.statement}</p>
            {material.length === 0 ? (
              <p className={styles.quiet}>
                Nothing moved beyond the margin Weathra treats as material for these measures.
              </p>
            ) : (
              <ul className={styles.changes}>
                {material.slice(0, 4).map((change) => (
                  <li className={styles.change} key={`${change.local_date}-${change.measure}`}>
                    <span className={styles.changeMark} aria-hidden="true" />
                    <span>{change.statement}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The artifact's synthesis band, written by code from the figures already on the screen.
 *
 * Its own is badged AI INTERPRETATION over a paragraph about high-pressure stabilization, a 72-hour
 * window of peak visibility, and evidence from fourteen coastal nodes. No model is called here and
 * none is claimed: every sentence below is a figure this screen already shows, put in order, which
 * is why it is badged analytics. Labelling deterministic text as a model's would be the one
 * mislabelling this product must not make.
 */
function SynthesisBand({
  location,
  result,
  best,
  baseline,
  forecast,
}: {
  readonly location: Location;
  readonly result: ComparisonResult;
  readonly best: ComparisonCandidate | null;
  readonly baseline: BaselineComparison | null;
  readonly forecast: ForecastResponse | null;
}): ReactNode {
  const temperature = statOf(best, ["temperature_max", "temperature_mean", "temperature"]);
  const rain = statOf(best, ["precipitation_sum", "precipitation"]);
  const wind = statOf(best, ["wind_gust_max", "wind_speed_max", "wind_speed"]);
  const day = best ? `${dayLabel(best).weekday} ${dayLabel(best).date}`.trim() : null;
  const difference = baseline ? formatSigned(baseline.difference) : null;

  const sentences = [
    best && day
      ? `Across ${result.candidates.length} ranked days at ${friendlyName(location)}, ${day} scores first for ${result.criterion.replace(/_/g, " ")}.`
      : null,
    reading(temperature)
      ? `It carries ${reading(temperature)}${reading(rain) ? ` with ${reading(rain)} of rain` : ""}.`
      : null,
    reading(wind) ? `Wind reaches ${reading(wind)} on that day.` : null,
    difference && baseline
      ? `The window sits ${difference} ${baseline.difference.unit ?? ""} against Weathra's ${baseline.baseline.years_used.length}-year archive baseline for this calendar period.`.replace(
          /\s+/g,
          " ",
        )
      : null,
  ].filter((sentence): sentence is string => sentence !== null);

  return (
    <div className={styles.synthesis}>
      <Card aria-labelledby="travel-synthesis">
        <CardHeader
          title="Travel intelligence synthesis"
          titleId="travel-synthesis"
          badge={<DataClassBadge dataClass="analytics" />}
        />
        <CardBody>
          {sentences.length === 0 ? (
            <p className={styles.quiet}>
              Nothing in this window could be scored, so there is nothing to summarise.
            </p>
          ) : (
            <p className={styles.synthesisProse}>{sentences.join(" ")}</p>
          )}
          <p className={styles.disclaimer}>
            Written by code from the figures on this screen. No language model was called, and
            nothing here is inferred beyond them.
          </p>
        </CardBody>
      </Card>

      {/*
        The artifact's grounding card reads "vector alignment 0.968", "BCN-EL-PRAT-ST STABLE" and a
        validation hash. Weathra keeps no such record for this screen — no agent run, no evidence
        id — so what this card carries is what a reader would need to check the figures: who
        answered, for where, over what, and when.
      */}
      <Card aria-labelledby="travel-evidence">
        <CardHeader title="Data &amp; evidence" titleId="travel-evidence" />
        <CardBody>
          <dl className={styles.sourceFacts}>
            <div className={styles.sourceFact}>
              <dt>Forecast provider</dt>
              <dd>{result.provider}</dd>
            </div>
            <div className={styles.sourceFact}>
              <dt>Destination</dt>
              <dd>{friendlyName(location)}</dd>
            </div>
            {forecast ? (
              <div className={styles.sourceFact}>
                <dt>Horizon</dt>
                <dd>
                  {forecast.horizon_days} {forecast.horizon_days === 1 ? "day" : "days"}
                </dd>
              </div>
            ) : null}
            {forecast?.attribution?.retrieved_at ? (
              <div className={styles.sourceFact}>
                <dt>Retrieved</dt>
                <dd>{formatInstant(forecast.attribution.retrieved_at)}</dd>
              </div>
            ) : null}
            {baseline ? (
              <div className={styles.sourceFact}>
                <dt>Archive provider</dt>
                <dd>{baseline.baseline.provider}</dd>
              </div>
            ) : null}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The trip window against the archive — the artifact's historical band, with Weathra's own baseline.
 *
 * Its own compares against "the 30-year WMO coastal baseline (1991-2020)". Weathra has a finite
 * baseline of archive years and `baselineYearsStatement` names them, so the card says how many it
 * actually got. The same endpoint Historical Analytics reads, asked for the trip's own calendar
 * window, with the method behind its own press.
 */
function HistoricalContext({
  location,
  baseline,
  pending,
}: {
  readonly location: Location;
  readonly baseline: BaselineComparison | null;
  /** True while the archive is still answering, false once it has answered or failed. */
  readonly pending: boolean;
}): ReactNode {
  /*
   * **The band is drawn either way.**
   *
   * This used to return `null` whenever the archive had not answered, which is the composition
   * changing shape because of an absence — the artifact's closing region simply disappeared, and
   * the page ended on the synthesis. An archive that cannot reach back far enough for a place is a
   * real state and a truthful one; it is said here rather than hidden by removing the region.
   */
  if (baseline === null) {
    return (
      <div className={styles.historical}>
        <Card aria-labelledby="travel-historical">
          <CardHeader
            title="Historical context"
            titleId="travel-historical"
            badge={<DataClassBadge dataClass="analytics" />}
            subtitle="Against the archive years Weathra can retrieve for this calendar period."
          />
          <CardBody>
            {pending ? (
              <LoadingState label="Reading the archive for this calendar period" lines={3} />
            ) : (
              <p className={styles.quiet}>
                Weathra could not retrieve archive observations for this calendar period at{" "}
                {friendlyName(location)}, so the window is not placed against a baseline here. The
                forecast figures above are unaffected.
              </p>
            )}
          </CardBody>
        </Card>

        <LocationImage
          displayName={friendlyName(location)}
          latitude={location.latitude}
          longitude={location.longitude}
          variant="banner"
          scrim="strong"
        >
          <span className={styles.heroZone}>{friendlyName(location)}</span>
        </LocationImage>
      </div>
    );
  }

  const difference = formatSigned(baseline.difference);
  const years = baseline.baseline.years_used.length;

  return (
    <div className={styles.historical}>
      <Card aria-labelledby="travel-historical">
        <CardHeader
          title="Historical context"
          titleId="travel-historical"
          badge={<DataClassBadge dataClass="analytics" />}
          subtitle={`Compared with Weathra's available ${years}-year archive baseline for this calendar period.`}
        />
        <CardBody>
          <p className={styles.railNote}>{baseline.characterization}</p>

          <div className={styles.historicalFigures}>
            <div className={styles.historicalFigure}>
              <span className={styles.historicalLabel}>Difference from baseline</span>
              <span className={styles.historicalValue}>
                {difference === null
                  ? NOT_REPORTED
                  : `${difference} ${baseline.difference.unit ?? ""}`.trim()}
              </span>
            </div>
            <div className={styles.historicalFigure}>
              <span className={styles.historicalLabel}>Baseline mean</span>
              <span className={styles.historicalValue}>
                {typeof baseline.baseline.mean.value === "number"
                  ? `${Math.round(baseline.baseline.mean.value * 10) / 10} ${baseline.baseline.mean.unit ?? ""}`.trim()
                  : NOT_REPORTED}
              </span>
            </div>
            <div className={styles.historicalFigure}>
              <span className={styles.historicalLabel}>Percentile</span>
              <span className={styles.historicalValue}>
                {typeof baseline.percentile_rank?.value === "number"
                  ? `${Math.round(baseline.percentile_rank.value)}th`
                  : NOT_REPORTED}
              </span>
            </div>
          </div>

          <details className={styles.why}>
            <summary>View historical details</summary>
            <p className={styles.quiet}>Baseline years: {baselineYearsStatement(baseline.baseline)}</p>
            <p className={styles.quiet}>{baseline.baseline.labelling}</p>
            {baseline.forecast_side_caveat ? (
              <p className={styles.quiet}>{baseline.forecast_side_caveat}</p>
            ) : null}
          </details>
        </CardBody>
      </Card>

      {/* The artifact sets imagery beside this band; the resolver is the product's own. */}
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="banner"
        scrim="strong"
      >
        <span className={styles.heroZone}>{friendlyName(location)}</span>
      </LocationImage>
    </div>
  );
}

/**
 * The one thing a rate-limited ranking should put on screen.
 *
 * The provider's own message is a sentence about *its* limits ("open-meteo rate-limited the
 * request"), and the request id beside it is a correlation handle for an engineer. Neither is what
 * a customer needs in order to decide what to do, so the plain statement and the retry are what
 * this carries; the technical detail stays behind a disclosure for anyone reporting it.
 */
function RankingUnavailable({
  failure,
  onRetry,
}: {
  readonly failure: ViewFailure;
  readonly onRetry: () => void;
}): ReactNode {
  const limited = failure.code === "provider_rate_limited";

  return (
    <Card aria-labelledby="travel-unavailable">
      <CardHeader
        title={limited ? "Travel weather data is temporarily unavailable" : "Those days were not ranked"}
        titleId="travel-unavailable"
      />
      <CardBody>
        <p className={styles.railNote} role="alert">
          {limited
            ? "The weather provider limited this request. Your trip settings above are unchanged — try again shortly."
            : failure.message}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        {limited || failure.requestId ? (
          <details className={styles.why}>
            <summary>Technical detail</summary>
            {limited ? <p className={styles.quiet}>{failure.message}</p> : null}
            {failure.requestId ? (
              <p className={styles.quiet}>Request {failure.requestId}</p>
            ) : null}
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}

function TravelFor({
  location,
  chooser,
}: {
  readonly location: Location;
  /** The screen's place control, rendered inside the trip strip. */
  readonly chooser: ReactNode;
}): ReactNode {
  const [criterion, setCriterion] = useState<Criterion>("outdoor_suitability");
  const [days, setDays] = useState("7");

  /*
   * **Ranked on arrival, not on a press.**
   *
   * The screen used to open on a form and an empty state telling the person to choose what they
   * wanted from the weather — so the populated product existed only after a button, and the page
   * a customer met was the configuration for it. The defaults are a real question already
   * ("which days here are good to be outside, over the next week"), so it answers that and the
   * controls change the answer.
   */
  const ranking = useApiQuery<ComparisonResult>({
    key: ["travel", "ranking", friendlyName(location), criterion, days],
    request: (client) =>
      client.compareLocations({
        criterion,
        location: friendlyName(location),
        days: Number(days),
      }),
  });

  const result = ranking.state.kind === "ready" ? ranking.state.data : null;
  const best = result?.candidates?.[0] ?? null;
  /** Where each day's score sits in the range this ranking spans; right for negative scores too. */
  const place = scoreSpan(result?.candidates ?? []);

  const point = { latitude: location.latitude, longitude: location.longitude };

  /*
   * **The three reads the lower bands need, all through contracts Weathra already has.**
   *
   * The hourly series is the Forecast Explorer's endpoint, the movement check is the Dashboard's,
   * and the baseline is Historical Analytics'. Nothing new was added to the backend for any of
   * them; what this screen was missing was the request, not the capability.
   *
   * Each is enabled only once the ranking has settled, so a first paint issues one upstream call
   * rather than four — the pacing Historical Analytics learned the hard way when a page load asked
   * the archive for the same place twelve times.
   */
  const settled = ranking.state.kind === "ready";

  const forecast = useApiQuery<ForecastResponse>({
    key: ["travel", "forecast", point, days],
    enabled: settled,
    request: (client) => client.forecast({ ...point, days: Number(days) }),
  });

  const changed = useApiQuery<WhatChanged>({
    key: ["travel", "changes", point, days],
    enabled: settled,
    request: (client) => client.changes({ ...point, days: Number(days) }),
  });

  /*
   * The trip's own calendar window against the archive. The dates come from the days the ranking
   * actually returned, so the baseline covers what the person is travelling for rather than a
   * window this screen chose.
   */
  const first = dateOf(result?.candidates?.[0] ?? null);
  const last = dateOf(result?.candidates?.[(result?.candidates.length ?? 1) - 1] ?? null);
  const baseline = useApiQuery<BaselineComparison>({
    key: ["travel", "baseline", point, first, last],
    enabled: settled && first !== null && last !== null,
    request: (client) =>
      client.baselineComparison({
        ...point,
        start: first as string,
        end: last as string,
        years: 5,
        measure: "temperature_mean",
      }),
  });

  const forecastData = forecast.state.kind === "ready" ? forecast.state.data : null;
  const changedData = changed.state.kind === "ready" ? changed.state.data : null;
  const baselineData = baseline.state.kind === "ready" ? baseline.state.data : null;

  /*
   * The provider's daily entries, indexed once for every band that reads one.
   *
   * The outlook cards, the metric row and the guidance each want the sky over a particular date.
   * Indexing here rather than in each of them is what stops three regions from walking the same
   * series three times and disagreeing about which entry is which day.
   */
  const byDate = dailyByDate(forecastData);
  const bestDaily = byDate.get(dateOf(best) ?? "");

  return (
    <div className={styles.screen}>
      <h1 className="weathra-visually-hidden">Travel Intelligence</h1>

      {/*
        **The artifact's trip strip.** Its own carries origin, destination and dates on one row with
        the actions at the end. Production had a display title, a lede, an always-open place
        disclosure and then a four-field form in a card of its own — four bands before the first
        figure, on a screen whose subject is a decision.
      */}
      <div className={styles.tripStrip}>
        <div className={styles.tripField}>
          <span className={styles.tripLabel}>Destination</span>
          <span className={styles.tripValue}>{friendlyName(location)}</span>
        </div>

        <label className={styles.tripField}>
          <span className={styles.tripLabel}>What you want</span>
          <select
            className={styles.tripSelect}
            value={criterion}
            onChange={(event) => setCriterion(event.target.value as Criterion)}
            aria-label="What you want from the weather"
          >
            {CRITERIA.map((entry) => (
              <option value={entry.value} key={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.tripField}>
          <span className={styles.tripLabel}>Window</span>
          <select
            className={styles.tripSelect}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            aria-label="Trip window"
          >
            <option value="3">Next 3 days</option>
            <option value="7">Next 7 days</option>
            <option value="14">Next 14 days</option>
          </select>
        </label>

        <details className={styles.adjust}>
          <summary className={styles.adjustSummary}>Adjust trip</summary>
          {chooser}
        </details>
      </div>

      {/*
        **A failed ranking ends the screen here.**

        Production rate-limited the ranking and still drew the destination hero over an empty
        Weather suitability card — a photograph of a place, a ring with nothing in it, and skeletons
        below implying an analysis was on its way that was never coming. Nothing downstream of the
        ranking has anything to render, so nothing downstream is rendered: one compact surface,
        beside the controls that produced the request, with the trip's own settings still in them.
      */}
      {ranking.state.kind === "error" ? (
        <RankingUnavailable failure={ranking.state.failure} onRetry={ranking.retry} />
      ) : (
        <>
      <div className={styles.lead}>
        {/*
          The hero is wrapped rather than placed directly. `LocationImage` sizes itself from its own
          aspect ratio and paints an absolutely-positioned stack inside it; as a bare grid child that
          made the row one column wide in a real browser — the card beside it rendered and had
          nowhere to land. A plain block between the grid and the image gives the column something
          ordinary to measure.
        */}
        <div className={styles.leadHero}>
          <DestinationHero location={location} best={best} />
        </div>
        {result ? (
          <SuitabilityCard result={result} best={best} />
        ) : (
          <Card aria-labelledby="travel-suitability-pending">
            <CardHeader title="Weather suitability" titleId="travel-suitability-pending" />
            <CardBody>
              <LoadingState label="Ranking the days in your window" lines={4} />
            </CardBody>
          </Card>
        )}
      </div>

      {result ? (
        <>
          <TravelMetrics best={best} forecast={forecastData} daily={bestDaily} />

          <div className={styles.outlook}>
            <Card aria-labelledby="travel-window">
              <CardHeader
                title="Destination daily outlook"
                titleId="travel-window"
                badge={<DataClassBadge dataClass="analytics" />}
                subtitle={`Ranked by ${result.criterion.replace(/_/g, " ")}, in ${location.timezone}, from ${result.provider}.`}
              />
              <CardBody>
                <ul className={styles.days}>
                  {result.candidates.map((candidate) => (
                    <DayCard
                      key={candidate.label}
                      candidate={candidate}
                      place={place}
                      forecast={forecastData}
                      daily={byDate.get(dateOf(candidate) ?? "")}
                    />
                  ))}
                </ul>
                {(result.excluded?.length ?? 0) > 0 ? (
                  <p className={styles.quiet}>
                    {result.excluded!.length} day
                    {result.excluded!.length === 1 ? " was" : "s were"} left out: the provider
                    reported too little to score them.
                  </p>
                ) : null}
              </CardBody>
            </Card>

            <TripGuidance best={best} forecast={forecastData} daily={bestDaily} />
          </div>

          <IntradayTrend forecast={forecastData} best={best} />

          <div className={styles.comparison}>
            <WindowMatrix result={result} place={place} />
            <WhatChangedCard changed={changed.state.kind === "error" ? null : changedData} />
          </div>

          <SynthesisBand
            location={location}
            result={result}
            best={best}
            baseline={baselineData}
            forecast={forecastData}
          />

          <HistoricalContext
            location={location}
            baseline={baselineData}
            pending={baseline.state.kind === "loading"}
          />

          <p className={styles.advisory}>
            This ranks days by the weather forecast for one place. It is not advice about flights,
            airlines, transport or bookings — Weathra has no information about any of them — and a
            forecast further out is less certain than one nearby.
          </p>
        </>
      ) : null}
        </>
      )}
    </div>
  );
}

export function TravelIntelligence(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });
  /** A place named on this screen. Outranks the default while it is set. */
  const [chosen, setChosen] = useState<Location | null>(null);

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return (
      <ErrorState
        failure={preferences.state.failure}
        onRetry={preferences.retry}
      />
    );
  }
  if (preferences.state.kind !== "ready") return null;

  const saved = briefingLocationFrom(preferences.state.data);
  const location = chosen ?? saved;

  /*
   * Declared once and used in both branches. The empty branch needs it most: its own text
   * says "name one above", and an empty state saying that with nothing above it is the
   * dead end this control exists to remove.
   */
  const chooser = (
    <PlaceChooser
      summary="Travel to another place"
      label="Travel to a place"
      description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
      current={location}
      usingDefault={chosen === null}
      hasDefault={saved !== null}
      onChoose={setChosen}
    />
  );

  return (
    <>
      {/*
        The screen's own place control. With no default this used to be an empty state and a link
        to Settings, which made the feature reachable only by configuring a preference somewhere
        else first — see `PlaceChooser` for why that is not a substitute for a product.
      */}

      {location === null ? (
        <>
          {chooser}
          <ScreenPreview
            title="Travel Intelligence ranks the days at one destination"
            lead="Name a place above, or set a default in Settings and every screen opens on it. Nothing below is filled in yet because no place has been chosen."
            regions={[
              {
                title: "What you want from the weather",
                blurb:
                  "Warm and dry, cool and still, whatever the trip is for — stated as preferences rather than as a score Weathra invented.",
              },
              {
                title: "The days, ranked",
                blurb:
                  "Each day in the horizon scored against what you asked for, with the figures the score came from shown beside it.",
                chart: 150,
              },
              {
                title: "Why a day ranked where it did",
                blurb:
                  "The measure that decided it, so a ranking is something you can check rather than something you have to trust.",
              },
            ]}
          />
        </>
      ) : (
        <TravelFor
          key={`${location.latitude},${location.longitude}`}
          location={location}
          chooser={chooser}
        />
      )}
    </>
  );
}
