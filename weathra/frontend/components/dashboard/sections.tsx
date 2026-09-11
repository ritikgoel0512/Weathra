"use client";

/**
 * The Dashboard's surfaces — task 21.1.
 *
 * Each is one region of one data class, rendered through the shared provenance primitives of task
 * 20.15 rather than through anything invented here: `ProvenanceSection` carries the badge and the
 * tier, `AttributionFooter` carries the provider, location, period and retrieval time,
 * `UncertaintyIndicator` carries a forecast's confidence with its basis, `MethodNote` carries what
 * computed a figure, and `InterpretationPanel` carries the model's language behind its boundary
 * sentence.
 *
 * The separation is the point, and it is structural: retrieved provider figures, deterministic
 * analytics and model-written prose are three regions with three tiers, so nothing on this screen
 * can suggest the language model produced a measurement.
 *
 * Every number rendered here arrives from the API. There is no fallback value, no placeholder
 * figure, and no sample datum carried over from the design artifact.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyChart,
  LocationImage,
  Meter,
  EmptyState,
  MethodNote,
  ProvenanceSection,
  UncertaintyIndicator,
  WeatherIcon,
  type Attribution,
} from "@/components/ui";
import type {
  AnalysisResponse,
  Baseline,
  CurrentResponse,
  ForecastResponse,
  Location,
  SavedLocationsResponse,
  StatisticResult,
} from "@/lib/api/schema";
import type { ViewState } from "@/lib/query/state";
import { confidenceLevelFor } from "@/lib/design/data-class";
import { resolvedPlaceLabel } from "@/lib/locations/place";
import { useResolvedPlace } from "@/lib/locations/resolved-place";
import { conditionFor } from "@/lib/weather/condition";
import {
  dayDetails,
  dayPrecipitationFrom,
  formatReading,
  formatFigure,
  forecastDaysFrom,
  readingFor,
  measureLabel,
  readingsFrom,
  statisticPhrase,
  type DayPrecipitation,
  type ForecastDay,
  type Reading,
  type WhatChangedReport,
} from "@/lib/dashboard/briefing";

import { BaselineYearsChart } from "./baseline-years";
import { PrecipitationMark, StatusMark } from "./marks";
import { IntradayChart, intradayHours, peakOf } from "./intraday";

import styles from "./dashboard.module.css";

/**
 * The UV index for the observed hour, from the forecast's hourly series.
 *
 * Matched on the hour of `observed_at_local` rather than taken from the first entry: the hourly
 * series starts at midnight, and its first value is the UV index at midnight, which is zero
 * everywhere and would be a true number about the wrong time.
 */
function uvNow(current: CurrentResponse, forecast: ForecastResponse | null): Reading | null {
  const observed = current.observed_at_local ?? "";
  const hour = observed.slice(0, 13); // `2026-09-11T14`
  if (hour.length < 13 || !forecast?.hourly) return null;

  const entry = forecast.hourly.entries?.find((candidate) =>
    (candidate.time_local ?? "").startsWith(hour),
  );
  if (!entry) return null;
  return readingFor("uv_index", entry.values, forecast.hourly.units);
}

/** One reported number, or null. The provider's condition code is a number in the values map. */
function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A location as the attribution line names it. Never a station, never a coordinate pair alone. */
function placeOf(
  location: Location | null | undefined,
  known: Location | null | undefined,
): string | null {
  // `resolvedPlaceLabel` rather than the raw `display_name`: a provider that named no point hands
  // back its coordinates as the name, and `48.1374, 11.5755` in an attribution line is a pin, not a
  // place. `known` is the place this screen already resolved — every card here is about that one
  // place, and every request after the first is made by coordinate, so without it these lines read
  // `Unnamed place` under a header naming the city. See `lib/locations/resolved-place`.
  return resolvedPlaceLabel(location, known);
}

function attributionOf(
  parts: {
    provider?: string | null;
    location?: Location | null;
    known?: Location | null;
    retrievedAt?: string | null;
    period?: { start_local: string; end_local: string; timezone?: string | null } | null;
    units?: string | null;
    fromCache?: boolean;
  },
): Attribution {
  return {
    provider: parts.provider ?? null,
    location: placeOf(parts.location, parts.known),
    retrievedAt: parts.retrievedAt ?? null,
    period: parts.period
      ? {
          start: parts.period.start_local,
          end: parts.period.end_local,
          timezone: parts.period.timezone ?? null,
        }
      : null,
    units: parts.units ?? null,
    fromCache: parts.fromCache,
  };
}

/** A labelled list of reported measures. An unreported measure is not in it. */
function Measures({ readings }: { readonly readings: readonly Reading[] }): ReactNode {
  if (readings.length === 0) return null;
  return (
    <dl className={styles.measures}>
      {readings.map((reading) => (
        <div className={styles.measure} key={reading.key}>
          <dt className={styles.measureTerm}>{reading.label}</dt>
          <dd className={styles.measureValue}>{formatReading(reading)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------- current conditions */

export interface CurrentConditionsProps {
  readonly current: CurrentResponse;
  readonly location: Location;
  /**
   * The forecast this screen already holds, for the one hero figure `current` does not carry.
   *
   * Optional: the hero renders without it, one slot shorter. Passed rather than fetched — the
   * Dashboard has the series already, and a second request for one number would be a worse answer
   * than a missing tile.
   */
  readonly forecast?: ForecastResponse | null;
}

/**
 * The canonical four the Dashboard artifact's hero reads out beside the temperature.
 *
 * The artifact prints HUMIDITY, UV INDEX, WIND and PRESSURE. Weathra's provider reports whichever
 * of them it reports, and the stub reports one. The slots are kept anyway and an absent one says
 * "Not reported" — which is the difference between a composition and a claim. Dropping a slot
 * because a value is missing loses the artifact's hero; inventing the value loses the point of the
 * product. Naming the measure and saying it was not reported does neither, and it is the same
 * sentence the attribution footer already uses for a period nobody supplied.
 *
 * `key` is the provider's own measure name, so a provider that *does* report wind fills the slot
 * with no change here.
 */
/**
 * The hero's secondary slots: the artifact's four, in the artifact's 2×2 block.
 *
 * `01-dashboard.png` puts humidity and wind over UV index and pressure, to the right of the
 * temperature. **UV is not in the `current` series** — the provider reports it hourly and daily
 * only — so it is read from the forecast's own hourly series at the hour the observation belongs
 * to. That is the same provider, the same place and the same hour, which is what makes it the UV
 * for *now* rather than a number borrowed from a different time. Where no hourly series is present
 * the slot is absent rather than stated as unavailable.
 */
const HERO_MEASURES: readonly { key: string; label: string }[] = [
  { key: "relative_humidity", label: "Humidity" },
  { key: "wind_speed", label: "Wind" },
  { key: "uv_index", label: "UV index" },
  { key: "surface_pressure", label: "Pressure" },
];

/**
 * The observed moment, in the words a person reads a clock in.
 *
 * It printed `Observed 2026-09-04T08:15:00+02:00` — the stamp exactly as the backend sent it,
 * against an artifact whose hero says "Updated 2m ago". An offset-bearing ISO string is the right
 * thing to send over a wire and the wrong thing to put in a hero: the reader wants the hour.
 *
 * Not a relative age, deliberately. "2m ago" is only true for as long as it takes to read, and the
 * backend's own freshness is already stated by `Updated` in the attribution beneath. This is the
 * hour the *provider observed*, which is a fixed fact about the reading and stays true.
 */
function formatObserved(timeLocal: string | null | undefined): string | null {
  if (!timeLocal) return null;
  // Both parts are read from the stamp's own text, so the provider's local hour and calendar day
  // survive whatever timezone the reader's browser is in. Reapplying the reader's timezone would
  // move the observation to a moment the provider never reported.
  const clock = /T(\d{2}:\d{2})/.exec(timeLocal)?.[1] ?? null;
  const day = shortDate(timeLocal);
  if (clock && day) return `${clock} · ${day}`;
  return clock ?? day;
}

/** The short month names, so a date's parts are ordered by this product rather than by a locale. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-04T08:15:00+02:00` → `4 Sep`, from the stamp's own text. */
function shortDate(timeLocal: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(timeLocal);
  if (!parts) return null;
  const month = MONTHS[Number(parts[2]) - 1];
  return month ? `${Number(parts[3])} ${month}` : null;
}

/**
 * The leading band: what the provider measured, badged OBSERVED.
 *
 * `01-dashboard.png` opens with a wide hero — the place and its status on the left, a dominant
 * temperature on the right, and a row of secondary measures beside it. That geometry is reproduced
 * here. What is *not* reproduced is the artifact's photograph of a city at dusk, its invented
 * station identifier, and its "Agent Ready" telemetry: `docs/design/screens.md` §5 refuses
 * generated decorative imagery set-wide, and the other two are figures no endpoint produces. The
 * band keeps its height and its atmospheric ground through the surface tokens instead, which is the
 * treatment the correction pass agreed for a hero with no approved asset behind it.
 */
export function CurrentConditions({
  current,
  location,
  forecast = null,
}: CurrentConditionsProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  const temperature = readingFor("temperature", current.values, current.units);
  const condition = conditionFor(numberFrom(current.values?.weather_code));
  const uv = uvNow(current, forecast);
  // Feels-like belongs with the temperature it qualifies, not in the tile block beside it: it is
  // the same measure in the same unit, and a reader meets it as a caveat on the big number rather
  // than as a fifth statistic. `01-dashboard.png` has no slot for it at all; this is where a
  // weather product puts it, and §8 of the reconstruction brief requires it on the screen.
  const feelsLike = readingFor("apparent_temperature", current.values, current.units);
  const observed = formatObserved(current.observed_at_local);
  const placeName = resolvedPlaceLabel(current.attribution?.location ?? location, known);
  // Anything the provider reported that the hero's four slots do not already name. The slots are
  // the artifact's composition; this is the guarantee that the composition never hides a reading.
  // The condition code is rendered as the condition, above. It must never also appear as a figure:
  // "Weather code 61" is the provider's identifier for "light rain", not a measurement, and a
  // reader shown both is being shown the same fact twice, once in a form they cannot use.
  const named = new Set<string>([
    "temperature",
    "apparent_temperature",
    "weather_code",
    ...HERO_MEASURES.map((measure) => measure.key),
  ]);
  const extras = readingsFrom(current.values, current.units).filter(
    (reading) => !named.has(reading.key),
  );

  return (
    <ProvenanceSection
      variant="hero"
      dataClass="observed"
      title="Current conditions"
      /*
        Everything else `current` reported, on the section's own footer rule rather than inside the
        band. The artifact's hero is one photograph with a readout on it and nothing beneath; a
        second strip of labelled figures below the image is a different composition, and it is
        where feels-like and precipitation were landing once the block above took the artifact's
        own four.
      */
      footer={
        extras.length > 0 ? (
          <details className={styles.heroExtras}>
            <summary className={styles.heroExtrasSummary}>All current readings</summary>
            <Measures readings={extras} />
          </details>
        ) : null
      }
      attribution={attributionOf({
        known,
        provider: current.attribution?.provider,
        location: current.attribution?.location ?? location,
        retrievedAt: current.attribution?.retrieved_at,
        units: current.attribution?.units,
        fromCache: current.attribution?.from_cache,
      })}
    >
      {/*
        The artifact's photographic band. `LocationImage` carries the frame whether a photograph is
        present or not, so the readout sits in the same place either way — see
        `public/locations/README.md` for what turns the field into a photograph.
      */}
      <LocationImage
        displayName={location.display_name}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="hero"
      >
        <div className={styles.hero}>
          <div className={styles.heroPlace}>
            {/* The artifact names the city large and its region beneath, not the timezone. */}
            <p className={styles.place}>{placeName}</p>
            <p className={styles.placeMeta}>
              {/* The artifact's small pill beside the place name. It is the zone the observation's
                  own clock is in, which is what makes the hour beside it readable. */}
              <span className={styles.heroZone}>{location.timezone}</span>
              {observed ? <span>Observed {observed}</span> : null}
            </p>
          </div>

          <div className={styles.heroReadout}>
            {temperature ? (
              // The degree mark is set apart from the figure so the number itself carries the
              // weight, which is what makes the artifact's hero read as one dominant element
              // rather than as a line of text that happens to be large.
              <p className={styles.readout}>
                <span className={styles.readoutFigure}>{formatFigure(temperature)}</span>
                <span className={styles.readoutUnit}>{temperature.unit ?? ""}</span>
              </p>
            ) : (
              <p className={styles.note}>No temperature reported</p>
            )}
            {/*
              The condition, under the temperature, exactly where the artifact puts "Light Rain".
              It is the provider's own `weather_code` translated — never inferred from the figures
              beside it. Absent when the provider reported no code.
            */}
            {condition ? (
              <p className={styles.readoutCondition}>
                <WeatherIcon condition={condition} size={30} />
                <span>{condition.label}</span>
              </p>
            ) : null}
            {feelsLike ? (
              <p className={styles.readoutFeels}>Feels like {formatReading(feelsLike)}</p>
            ) : null}
          </div>

          {/*
            Only the slots the provider actually reported. A tile reading "Unavailable" on every
            load advertises a field this series does not carry — which is what the UV slot did
            before it was removed, and what a fixed precipitation slot would do on a dry day.
            `dashboard.test.tsx` holds this: an unreported measure is absent, not stated as absent.
          */}
          <dl className={styles.heroMeasures}>
            {HERO_MEASURES.map(({ key, label }) => ({
              key,
              label,
              // UV is the one slot `current` does not carry; it comes from the hour the
              // observation belongs to in the forecast's own hourly series.
              reading: key === "uv_index" ? uv : readingFor(key, current.values, current.units),
            }))
              .filter((slot) => slot.reading !== null)
              .map((slot) => (
                <div className={styles.heroMeasure} key={slot.key}>
                  <dt className={styles.heroMeasureTerm}>{slot.label}</dt>
                  <dd className={styles.heroMeasureValue} data-reported="true">
                    {formatReading(slot.reading!)}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      </LocationImage>

    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------- forecast strip */

/**
 * The day card's glyph: a drawing of the precipitation figures, with those figures as its caption.
 *
 * Three shapes, one per level `dayPrecipitationFrom` distinguishes, and no fourth for "clear" —
 * there is no clear-sky figure in the response and inventing one is the whole thing this avoids.
 * The `<svg>` is `aria-hidden` and the caption carries the words, so a screen reader is read the
 * figures rather than a shape; `title` gives the same sentence to a pointer.
 */
function DayPrecipitationGlyph({
  outlook,
}: {
  readonly outlook: DayPrecipitation | null;
}): ReactNode {
  if (outlook === null) return null;
  return (
    <p className={styles.stripGlyph} data-level={outlook.level} title={outlook.description}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7.5 16.5a4.5 4.5 0 0 1 .3-9 5.5 5.5 0 0 1 10.3 1.4 3.8 3.8 0 0 1-.6 7.6z" />
        {outlook.level === "wet" ? (
          <path d="M9 19l-1 2.5M13 19l-1 2.5M17 19l-1 2.5" />
        ) : outlook.level === "possible" ? (
          <path d="M12 19l-1 2.5" />
        ) : null}
      </svg>
      <span className={styles.stripGlyphCaption}>{outlook.caption}</span>
      {/* The figures the glyph was drawn from, for a reader that never sees the drawing. */}
      <span className="weathra-visually-hidden">{outlook.description}</span>
    </p>
  );
}

export interface ForecastStripProps {
  readonly forecast: ForecastResponse;
}

/**
 * The day-by-day strip `01-dashboard.png` calls "Forecast Explorer".
 *
 * Three things about it are deliberate.
 *
 * **The name is not the artifact's.** *Forecast Explorer* is a post-MVP screen
 * (`docs/design/roadmap.md`), and `screens.md` §5 records that a Dashboard section may not carry it
 * or the navigation would advertise as built something that is not.
 *
 * **The number of cards is the number of days the backend returned**, not the artifact's seven. The
 * horizon is the person's saved preference and the provider answers with what it has; rendering
 * seven would mean drawing days nobody forecast. Fewer cards in the same card language is the
 * honest form of the same strip.
 *
 * **A precipitation glyph, not a condition glyph.** The artifact labels each day "LIGHT RAIN",
 * "SUNNY", and so on, and this strip carried nothing at all — finding 1.8 of the runtime fidelity
 * audit of 2026-09-08. Weathra's provider reports no condition, so what the card draws is the day's
 * own precipitation: the total, the maximum probability, and a glyph that is a picture of those two
 * figures. See `dayPrecipitationFrom`. A dry day is never drawn as a sunny one.
 */
/** A day's condition, from the provider's dominant code for that day. */
function conditionOf(day: ForecastDay): ReturnType<typeof conditionFor> {
  return conditionFor(day.conditionCode);
}

/** `2026-09-12T00:00:00+02:00` → `Friday`, from the day's own local stamp. */
function weekdayOf(day: { timeLocal: string; date: string }): string {
  const parsed = new Date(day.timeLocal);
  if (Number.isNaN(parsed.getTime())) return day.date;
  return parsed.toLocaleDateString(undefined, { weekday: "short" });
}

/**
 * `2026-09-12T00:00:00+02:00` → `12 Sep`. The certainty under the weekday, without the stamp.
 *
 * Built from the stamp's own text rather than through `toLocaleDateString`, for the same reason
 * the clock in `formatObserved` is: the provider's local calendar day must survive whatever
 * timezone the reader's browser is in, and the order of the parts must not depend on which locale
 * the browser reports — `Sep 4` and `4 Sep` are the same date rendered by two machines, and a
 * screen whose text changes with the reader's region is a screen no test can pin down.
 */
function shortDateOf(day: { timeLocal: string; date: string }): string {
  return shortDate(day.timeLocal) ?? day.date;
}

export function ForecastStrip({ forecast }: ForecastStripProps): ReactNode {
  const days = forecastDaysFrom(forecast.daily);

  /*
   * Seven cards, because `01-dashboard.png` is a seven-card strip and the strip is the composition.
   * The backend answers with the days it has — the horizon is the person's preference and the
   * provider supplies what it supplies — so the cards beyond that carry an unavailable state rather
   * than a guessed forecast. A strip that shrank to two cards read as a different component; a
   * strip that invented five days would be the fabrication this product exists to avoid.
   */
  const slots = Array.from({ length: 7 }, (_, index) => days[index] ?? null);

  return (
    <div className={styles.strip}>
      {slots.map((day, index) => (
        <article
          className={styles.stripDay}
          key={day?.timeLocal ?? `empty-${index}`}
          data-reported={day ? "true" : "false"}
        >
          {day ? (
            <>
              {/*
                **One line, not two.** `01-dashboard.png`'s card opens on `MON` alone and nothing
                else above the icon; ours carried the weekday and `4 Sep` under it, which made every
                card in the strip a row taller than the artifact's and pushed the temperature — the
                thing the card exists for — down past the middle of it. The date is not lost: it
                heads the card's own Details, where the rest of the day's figures already are.
              */}
              <p className={styles.stripDayName}>{weekdayOf(day)}</p>
              {/*
                The artifact's day card is an icon and a condition word over the temperatures. That
                was a precipitation glyph until the provider's `weather_code` arrived, because
                Weathra carried no condition and "a dry day is never drawn as a sunny one" was the
                right call while that was true. It no longer is. The glyph stays as the fallback for
                a day the provider reported no code for.
              */}
              {conditionOf(day) ? (
                <span className={styles.stripIcon}>
                  <WeatherIcon condition={conditionOf(day)} size={32} />
                </span>
              ) : dayPrecipitationFrom(day) !== null ? (
                <DayPrecipitationGlyph outlook={dayPrecipitationFrom(day)} />
              ) : (
                /*
                 * **A day with no condition and no precipitation figure.** Both glyph sources are
                 * absent — the provider sent no dominant code and no rain total — and the card
                 * rendered nothing at all in the slot, so the last card in the 2026-09-11 strip
                 * had a hole where its neighbours had an icon and read as broken rather than as
                 * unreported. A neutral mark keeps all seven cards one shape and says which of
                 * the two it is; the figures the day *does* carry are untouched beneath it.
                 */
                <span
                  className={styles.stripIconEmpty}
                  title="The provider reported no condition for this day."
                >
                  <span aria-hidden="true">·</span>
                  <span className="weathra-visually-hidden">
                    No condition reported for this day.
                  </span>
                </span>
              )}

              {/*
                **The day's temperature, at the size the artifact draws it.** The card carried
                `HIGH 19.6 °C` over `LOW 10.4 °C` as two equal labelled rows, which made a strip of
                seven cards a table of fourteen figures with no entry point;
                `01-dashboard.png` puts one temperature on each card at three times the size of
                anything else on it and keeps the pair as a small rule underneath. The figure is
                the high, which is the one the day is spoken of by, and the unit sits beside it
                once rather than on both rows.
              */}
              <p className={styles.stripReadout}>
                {day.high ? (
                  <>
                    <span className={styles.stripReadoutFigure}>{formatFigure(day.high)}</span>
                    <span className={styles.stripReadoutUnit}>{day.high.unit ?? ""}</span>
                  </>
                ) : (
                  <span className={styles.stripReadoutFigure}>—</span>
                )}
              </p>
              {conditionOf(day) ? (
                <p className={styles.stripCondition}>{conditionOf(day)?.label}</p>
              ) : null}

              <dl className={styles.stripFigures}>
                <div className={styles.stripFigure}>
                  <dt className={styles.stripFigureTerm}>L</dt>
                  <dd className={styles.stripFigureValue}>
                    {day.low ? formatFigure(day.low) : "—"}
                  </dd>
                </div>
                <div className={styles.stripFigure}>
                  <dt className={styles.stripFigureTerm}>H</dt>
                  <dd className={styles.stripFigureValue}>
                    {day.high ? formatFigure(day.high) : "—"}
                  </dd>
                </div>
              </dl>
              {/* The date, and everything else the provider reported for this day, one
                  interaction away. The card stays the artifact's five rows; nothing the backend
                  sent is dropped. */}
              <details className={styles.dayDetails}>
                <summary className={styles.dayDetailsSummary}>Details</summary>
                <span className={styles.dayOther}>
                  <span>{shortDateOf(day)}</span>
                  {dayDetails(day).map((reading) => (
                    <span key={reading.key}>
                      {reading.label}: {formatReading(reading)}
                    </span>
                  ))}
                </span>
              </details>
            </>
          ) : (
            <>
              <p className={styles.stripDayName}>Day {index + 1}</p>
              <p className={styles.stripEmpty}>Not forecast</p>
            </>
          )}
        </article>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- forecast movement */

export interface ForecastMovementProps {
  readonly forecast: ForecastResponse;
  readonly location: Location;
}

/**
 * The seven-day strip, badged FORECAST — the artifact's "Forecast Explorer".
 *
 * **Why it now carries the artifact's own name.** `docs/design/screens.md` §5 refused the label on
 * the grounds that it collided with a post-MVP screen and would advertise something unbuilt. That
 * reasoning has expired: `/explorer` ships, it is in the navigation, and `11-explorer.png` is the
 * screen it was named after. So the Dashboard section uses the product's real name for the thing
 * it is a summary of, and the heading links to the full screen — which is what makes the name a
 * signpost rather than a claim.
 */
export function ForecastMovement({ forecast, location }: ForecastMovementProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  const days = forecastDaysFrom(forecast.daily);
  const confidence = confidenceLevelFor(forecast.uncertainty?.horizon?.[0]?.confidence);

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Forecast Explorer"
      eyebrow={`${days.length}-day analysis`}
      action={
        <Link className={styles.panelLink} href="/explorer">
          Open Forecast Explorer
        </Link>
      }
      attribution={attributionOf({
        known,
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location ?? location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
    >
      {/*
        **One strip, not two.** This band and "The days ahead" rendered the same seven days on one
        screen — the same highs, lows and precipitation totals, in two card languages. Two readings
        of one forecast is not twice the evidence. The cards are now the strip's, drawn once, and
        this band keeps what only it carried: the data-class badge, the attribution, and the
        confidence the forecast rests on.
      */}
      {days.length === 0 ? (
        <EmptyState title="No forecast days returned">
          The provider returned no daily entries for this window.
        </EmptyState>
      ) : (
        <ForecastStrip forecast={forecast} />
      )}

      {/*
        Required on every forecast: the band, and the basis it rests on. `compact` is finding 14 of
        the customer-level review of 2026-09-11 — the basis and the no-spread note were two lines of
        defensive prose across the full width of the Dashboard's widest card. Both are still here,
        behind the control on the same line, where a person checking the method finds them and a
        person reading the weather does not have to.
      */}
      {confidence && forecast.uncertainty?.basis ? (
        <UncertaintyIndicator
          confidence={confidence}
          basis={forecast.uncertainty.basis}
          hoursAhead={forecast.uncertainty.horizon?.[0]?.hours_ahead ?? null}
          spreadAvailable={forecast.uncertainty.spread_available ?? null}
          compact
        />
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------- deterministic analytics */

/** One computed figure with the method that produced it. */
function Finding({ result }: { readonly result: StatisticResult }): ReactNode {
  const value = typeof result.value === "number" ? result.value : null;
  return (
    <li className={styles.finding}>
      {/* `Average high`, not `mean · temperature max`. The canonical keys stay in the method note
          and in Agent Evidence, which is where somebody checking the arithmetic looks. */}
      <span className={styles.findingLabel}>
        {statisticPhrase(result.statistic, result.measure)}
      </span>
      {value === null ? (
        // "Not reported", not "Not computable": the arithmetic is fine, the provider sent nothing
        // to do it with, and the second sentence — "Not computable: The provider reported no wind
        // speed for this window.." — was the same fact said twice in a developer's words.
        <span className={styles.note}>Not reported</span>
      ) : (
        <span className={styles.findingValue}>
          {formatReading({ value, unit: result.unit ?? null })}
        </span>
      )}
      <MethodNote
        method={result.method}
        pointsUsed={result.points_used}
        pointsExcluded={result.points_excluded}
        unit={result.unit ?? null}
        reason={result.status === "not_computable" ? (result.reason ?? null) : null}
      />
    </li>
  );
}

export interface DeterministicAnalyticsProps {
  readonly analysis: AnalysisResponse;
  readonly location: Location;
}

export interface AnomalyDetectionProps extends DeterministicAnalyticsProps {
  /**
   * The multi-year baseline, where the screen has one.
   *
   * `01-dashboard.png`'s anomaly panel closes on "HISTORICAL AVG (OCT) 14.2°C" and
   * "VARIANCE +3.8°C". The first is the baseline's own mean and is passed straight through. The
   * second is a *deviation* in the artifact, and no endpoint on this screen computes one — the
   * analysis and the baseline are two separate reads, and subtracting one from the other here
   * would make the Dashboard the first place in Weathra that does arithmetic on a figure. So the
   * slot carries the baseline's own spread instead, which is a statistic the backend computed and
   * stated a method for. Historical Analytics is where a real deviation lives, over an endpoint
   * built to compute it.
   */
  readonly baseline?: Baseline | null;
}

/**
 * The figures Weathra computed, badged ANALYTICS — anomalies, trend, and the findings.
 *
 * `analysis.summary` is the backend's own sentence about its own findings, written by code with no
 * model involved, which is why it sits in this region rather than in the interpretation panel.
 */
/**
 * Where this window sits against the years behind it: above, within, or below what is usual.
 *
 * Both halves are figures the screen already holds. The window's mean comes from the analysis
 * findings; the baseline's mean and its standard deviation come from the historical endpoint for
 * the same calendar days. "Usual" is one standard deviation of the reference years — which is the
 * spread the baseline itself reports, not a threshold invented here — so a window inside it is
 * within the usual range and one outside it is above or below.
 *
 * Null unless every part is present **and in the same unit**. Comparing a Celsius mean against a
 * Fahrenheit baseline would produce a confident sentence and a wrong one.
 */
function usualRangeOf(
  analysis: AnalysisResponse,
  baseline: Baseline | null,
): { title: string; detail: string; tone: "flag" | "calm" } | null {
  /*
   * `temperature_mean` where the analysis ran over a daily series, `temperature` where it ran over
   * an hourly one. Both are the arithmetic mean of the window's temperature in the same unit, and
   * matching only the first is why this card kept falling back to its own-distribution sentence
   * with a perfectly good baseline sitting in the rail beside it.
   */
  const mean = (analysis.findings ?? []).find(
    (finding) =>
      finding.statistic === "mean" &&
      (finding.measure === "temperature_mean" || finding.measure === "temperature"),
  );
  const current = typeof mean?.value === "number" ? mean.value : null;
  const reference = typeof baseline?.mean?.value === "number" ? baseline.mean.value : null;
  const spread =
    typeof baseline?.standard_deviation?.value === "number"
      ? baseline.standard_deviation.value
      : null;
  if (current === null || reference === null || spread === null) return null;
  if ((mean?.unit ?? null) !== (baseline?.mean?.unit ?? null)) return null;

  const difference = current - reference;
  const years = (baseline?.years_used ?? []).length;
  const size = formatReading({ value: Math.abs(difference), unit: baseline?.mean?.unit ?? null });
  const against = years > 0 ? `the ${years}-year average` : "the archive baseline";

  if (Math.abs(difference) <= spread) {
    return {
      title: "Within usual range",
      detail: `This window sits ${size} from ${against} for these days.`,
      tone: "calm",
    };
  }
  return {
    title: difference > 0 ? "Above usual range" : "Below usual range",
    detail: `${size} ${difference > 0 ? "above" : "below"} ${against}, beyond its usual spread.`,
    tone: "flag",
  };
}

export function DeterministicAnalytics({
  analysis,
  location,
  baseline = null,
}: AnomalyDetectionProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();
  const anomalies = analysis.anomalies?.anomalies ?? [];
  const trend = analysis.trend;
  const band = usualRangeOf(analysis, baseline);

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Anomaly detection"
      attribution={attributionOf({
        known,
        provider: analysis.provider,
        location: analysis.location ?? location,
        period: analysis.period,
        units: analysis.units,
        fromCache: analysis.from_cache,
      })}
    >
      {/*
        **States, then the arithmetic behind them.** This panel read out four findings, each with
        its own "Computed by Weathra / View analysis" pair and its own method — median absolute
        deviation, a Theil–Sen slope, a baseline spread — in a rail card the artifact draws as one
        alert line and two figures. The analytics are unchanged and none of them moved screens;
        what a person meets first is now the answer rather than the method.
      */}
      {/*
        **One statement, then two figures.** `01-dashboard.png` draws this panel as a single tinted
        alert line over a historical average and a variance — five lines in a rail, read in a
        glance on the way past. It had become four equal label/value rows with the trend among
        them, which is a small table: nothing in it was wrong and nothing in it was first.
      */}
      {/*
        **The status the card is read for, at the size a status is read at.**
        `01-dashboard.png` fills this slot with a warning icon over "THERMAL DRIFT DETECTED" and
        "Berlin-Mitte is 1.4°C above predicted trend" — a claim about a station and a model
        prediction Weathra has neither of. What it does have is the window's own mean against the
        multi-year baseline for the same calendar days, and the spread of the years that baseline
        averages: those two figures say whether this window is above, within or below what is usual
        here, which is the real version of the statement the artifact is making.
        Where no baseline came back the card still states what the analysis found on its own —
        whether anything in the window stood out against the rest of it — rather than going quiet.
      */}
      {/*
        **The status reads as a status** — task 34.30. `01-dashboard.png` draws this slot as a
        tinted alert with a warning mark beside two lines of text, and the mark is most of what
        makes it legible in a glance from across the rail. Ours had the two lines and no mark, so
        every state looked like the same quiet box whichever one it was.
        The mark is chosen by the state, never by a colour alone: a window outside its usual spread
        gets the warning triangle, one inside it gets the settled check. `StatusMark` draws both.
      */}
      {band ? (
        <p className={styles.anomalyHeadline} data-tone={band.tone}>
          <StatusMark tone={band.tone} />
          <span className={styles.anomalyHeadlineText}>
            <span className={styles.anomalyHeadlineTitle}>{band.title}</span>
            <span className={styles.anomalyHeadlineDetail}>{band.detail}</span>
          </span>
        </p>
      ) : analysis.anomalies ? (
        <p
          className={styles.anomalyHeadline}
          data-tone={anomalies.length > 0 ? "flag" : "calm"}
        >
          <StatusMark tone={anomalies.length > 0 ? "flag" : "calm"} />
          <span className={styles.anomalyHeadlineText}>
            <span className={styles.anomalyHeadlineTitle}>
              {anomalies.length === 0
                ? "Nothing unusual"
                : `${anomalies.length} ${anomalies.length === 1 ? "day" : "days"} stood out`}
            </span>
            <span className={styles.anomalyHeadlineDetail}>
              {measureLabel(analysis.anomalies.measure)} against this window&rsquo;s own
              distribution.
            </span>
          </span>
        </p>
      ) : null}

      <dl className={styles.anomalyStates}>
        {baseline?.mean && typeof baseline.mean.value === "number" ? (
          <div className={styles.anomalyState}>
            <dt className={styles.anomalyTerm}>
              {(baseline.years_used ?? []).length}-year average
            </dt>
            <dd className={styles.anomalyValue}>
              {formatReading({ value: baseline.mean.value, unit: baseline.mean.unit ?? null })}
            </dd>
          </div>
        ) : null}

        {baseline?.standard_deviation &&
        typeof baseline.standard_deviation.value === "number" ? (
          <div className={styles.anomalyState}>
            <dt className={styles.anomalyTerm}>Usual spread</dt>
            <dd className={styles.anomalyValue}>
              ±
              {formatReading({
                value: baseline.standard_deviation.value,
                unit: baseline.standard_deviation.unit ?? null,
              })}
            </dd>
          </div>
        ) : null}
      </dl>

      {/*
        The sentence the backend wrote about its own findings, and every method behind the states
        above — one disclosure for the panel rather than one per figure.
      */}
      <details className={styles.anomalyAnalysis}>
        <summary className={styles.anomalyAnalysisSummary}>View analysis</summary>

        {analysis.summary ? <p className={styles.summary}>{analysis.summary}</p> : null}

        {/*
          The trend, with the two figures above rather than between them. It is a real computed
          statistic and it is not the panel's headline: a rail card states whether anything is
          unusual, and the direction of a Theil–Sen slope is the arithmetic behind that answer.
        */}
        {trend ? (
          <dl className={styles.anomalyStates}>
            <div className={styles.anomalyState}>
              <dt className={styles.anomalyTerm}>Trend</dt>
              <dd className={styles.anomalyValue}>
                {trend.direction} · {formatReading({ value: trend.magnitude, unit: trend.unit })}
              </dd>
            </div>
          </dl>
        ) : null}

        {analysis.anomalies ? (
          <MethodNote
            method={analysis.anomalies.method}
            pointsUsed={analysis.anomalies.points_used}
            pointsExcluded={analysis.anomalies.points_excluded}
            compact
          />
        ) : null}
        {trend ? (
          <MethodNote
            method={trend.method}
            pointsUsed={trend.points_used}
            pointsExcluded={trend.points_excluded}
            unit={trend.unit}
            compact
          />
        ) : null}
        {baseline?.mean ? <MethodNote method={baseline.mean.method} compact /> : null}
      </details>

    </ProvenanceSection>
  );
}

/**
 * The computed figures, as their own panel in the wide column.
 *
 * Split out of `DeterministicAnalytics` above, and the split is the artifact's own.
 * `01-dashboard.png`'s right-hand column is short — an anomaly alert, a historical average and a
 * variance, then three saved snapshots — while its wide left column carries the interpretation and
 * its two nested cards. Ours had the anomaly, the trend *and* six computed statistics with their
 * methods and provenance all in the narrow column, which made that column about twice the height
 * of the one beside it and left roughly 360 pixels of page ground under "What Changed?".
 *
 * The figures were the wrong half to put there. An anomaly alert is a short statement and belongs
 * in a rail; six statistics with their arithmetic named are the screen's substance and belong in
 * the column with room for them. Both keep their own provenance, because they are read separately
 * now and an attribution that only appeared on one of them would leave the other unsourced.
 */
export function ComputedFigures({
  analysis,
  location,
}: DeterministicAnalyticsProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();
  if (analysis.findings.length === 0) return null;

  // The six a person reads: the temperatures, the rain and the wind that actually blew.
  const headline = analysis.findings.slice(0, 6);
  const rest = analysis.findings.slice(6);

  return (
    <ProvenanceSection
      dataClass="analytics"
      title="Computed figures"
      attribution={attributionOf({
        known,
        provider: analysis.provider,
        location: analysis.location ?? location,
        period: analysis.period,
        units: analysis.units,
        fromCache: analysis.from_cache,
      })}
    >
      {/*
        **Six figures, then the rest behind a control.** This rendered every statistic the analysis
        computed as a full-width matrix in the Dashboard's main column — the largest block on a
        screen whose subject is the weather, and the one that made the page read as a report about
        its own arithmetic. `01-dashboard.png` has no such region at all.

        Nothing is deleted and nothing moves to another screen: the same figures, the same
        provenance, the same `View analysis` on each. What changes is how many a person meets
        before they ask for them.
      */}
      <ul className={styles.findings}>
        {headline.map((result, index) => (
          <Finding key={`${result.statistic}-${result.measure}-${index}`} result={result} />
        ))}
      </ul>

      {rest.length > 0 ? (
        <details className={styles.moreFigures}>
          <summary className={styles.moreFiguresSummary}>
            View all {analysis.findings.length} metrics
          </summary>
          <ul className={styles.findings}>
            {rest.map((result, index) => (
              <Finding key={`${result.statistic}-${result.measure}-${index}`} result={result} />
            ))}
          </ul>
        </details>
      ) : null}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------ historical context */

export interface HistoricalContextProps {
  readonly baseline: Baseline;
}

/**
 * The multi-year baseline the current window sits against, badged HISTORICAL.
 *
 * It states the years actually used rather than citing a published climate normal, and says so when
 * fewer were available than were asked for — both are `specs/historical` requirements, and both are
 * the reason no figure here is described as a "30-year norm" unless thirty years were used.
 */
export function HistoricalContext({ baseline }: HistoricalContextProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  const years = baseline.years_used ?? [];
  const yearly = baseline.yearly_means ?? [];
  const mean = typeof baseline.mean?.value === "number" ? baseline.mean.value : null;
  const unit = baseline.mean?.unit ?? null;

  /*
   * **The band's own chart, from the figures it already had.** `01-dashboard.png` closes the
   * Dashboard on a wide band with an account on the left and a large plot on the right; ours
   * closed it on three labelled statistics and a sentence about how many years were available,
   * which is the same band with the picture taken out. The plot is each reference year's own mean
   * against the baseline those means average to — the multi-year record, drawn as the record.
   *
   * The artifact's own plot is a candlestick chart of invented financial data with a "2023
   * EXTREME" callout on it. That is not imitated: `screens.md` §5 refuses the mockup's filler
   * across the set, and there is no market in a climate baseline.
   */
  return (
    <ProvenanceSection
      /*
        **The artifact's own product name, because it is accurate.** `01-dashboard.png` closes on
        "HISTORICAL / Climate Baseline Comparison", and that is precisely what this band does: it
        puts the forecast window against the multi-year mean for the same calendar days. "Historical
        context" named the same thing more weakly. Where the artifact then invents — a 30-year norm
        nobody computed, a candlestick chart, a "2023 EXTREME" callout — this does not follow it;
        the years used are the years the archive actually returned, and they are stated.
      */
      dataClass="historical"
      title="Climate Baseline Comparison"
      eyebrow="This window against the years behind it"
      attribution={attributionOf({
        known,
        provider: baseline.provider,
        location: baseline.location,
        period: baseline.calendar_period,
        units: baseline.unit_system,
      })}
    >
      <div className={styles.baselineBand}>
        <div className={styles.baselineAccount}>
          <p className={styles.statement}>{baseline.labelling}</p>

          {/* The artifact's one framed figure under the prose: the number the band is about. */}
          {mean === null ? null : (
            <p className={styles.baselineDelta}>
              <span className={styles.baselineDeltaTerm}>
                {years.length}-year average, {statisticPhrase("mean", baseline.measure).toLowerCase()}
              </span>
              <span className={styles.baselineDeltaValue}>
                {formatReading({ value: mean, unit })}
              </span>
            </p>
          )}

          {/*
            **One line about the years, not three.** It read "Computed from 3 years: 2021, 2022,
            2023." on one line and "Fewer years were available than requested." on the next, under
            a statement that had already said the baseline was computed from the years listed.
            `specs/historical` requires the years actually used to be stated and requires it to be
            said when fewer were available than asked for — both still are, in one sentence, and
            the year-by-year figures are the plot beside it.
          */}
          <p className={styles.note}>
            {years.length > 0
              ? `Based on ${years.length} ${years.length === 1 ? "year" : "years"} of archive observations (${years.join(", ")}).`
              : "The archive reported no years for this window."}
            {/* The backend's own coverage caveat, verbatim and on the same line — it is a
                `specs/historical` requirement and is not this screen's to paraphrase. */}
            {baseline.coverage_note ? ` ${baseline.coverage_note}` : null}
          </p>

          <Link href="/historical">
            <Button variant="secondary" size="sm">
              Open Historical Analytics
            </Button>
          </Link>
        </div>

        <div className={styles.baselineChart}>
          <h3 className={styles.baselineChartTitle}>The reference years</h3>
          {yearly.length > 0 ? (
            <BaselineYearsChart
              years={yearly}
              baselineValue={mean}
              unit={unit}
              measureLabel={statisticPhrase("mean", baseline.measure)}
            />
          ) : (
            <EmptyChart
              title="The reference years behind this baseline"
              reason="The archive reported no per-year means for this window, so there is nothing to plot."
            />
          )}
        </div>
      </div>

      {/*
        The spread and the extremes, and the method behind each. They were three equal columns
        across the band; here they are the detail under the account, which is what they are.
      */}
      <details className={styles.baselineFigures}>
        <summary className={styles.baselineFiguresSummary}>View the figures and their methods</summary>
        <ul className={styles.findings}>
          {(
            [
              ["mean", baseline.mean],
              ["minimum", baseline.minimum],
              ["maximum", baseline.maximum],
              ["standard_deviation", baseline.standard_deviation],
            ] as const
          ).map(
            ([statistic, result]) =>
              result ? (
                <li className={styles.finding} key={statistic}>
                  {/* `Average temperature`, not `Mean · temperature mean`. The same phrasing the
                      computed figures use, so one screen does not name a figure two ways. */}
                  <span className={styles.findingLabel}>
                    {statisticPhrase(statistic, baseline.measure)}
                  </span>
                  {typeof result.value === "number" ? (
                    <span className={styles.findingValue}>
                      {formatReading({ value: result.value, unit: result.unit ?? null })}
                    </span>
                  ) : (
                    <span className={styles.note}>Not computable.</span>
                  )}
                  <MethodNote method={result.method} pointsUsed={result.points_used} />
                </li>
              ) : null,
          )}
        </ul>
      </details>
    </ProvenanceSection>
  );
}

/* ---------------------------------------------------------------- what changed */

export interface WhatChangedProps {
  /**
   * The comparison `GET /api/v1/weather/changes` returned, or null when none could be obtained.
   *
   * Null is the *unavailable* state — the request failed — and is not the same as a report whose
   * `comparison_available` is false, which is the backend saying there is nothing earlier on record.
   */
  readonly report?: WhatChangedReport | null;
}

/**
 * *What Changed?* — how the forecast moved since the last captured snapshot.
 *
 * Three states, and the distinction between the last two is the whole requirement:
 *
 * - **A comparison**, listing the days that moved materially.
 * - **No prior snapshot**: nothing earlier exists for this location and window, said plainly. It is
 *   never rendered as a zero delta, which would claim the forecast had not moved.
 * - **Not available**: no comparison could be obtained at all. Distinct from the above, because
 *   "nothing to compare against" and "we could not ask" are different facts.
 *
 * The section is badged FORECAST: a delta between two provider forecasts is a statement about
 * provider figures, and the backend labels it that way too.
 */
export function WhatChanged({ report }: WhatChangedProps): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  if (!report) {
    return (
      <ProvenanceSection dataClass="forecast" title="What Changed?" headingLevel={3}>
        <p className={styles.note}>No comparison could be retrieved for this briefing.</p>
      </ProvenanceSection>
    );
  }

  const material = (report.changes ?? []).filter((change) => change.material);

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="What Changed?"
      headingLevel={3}
      attribution={attributionOf({
        known,
        provider: report.provider,
        location: report.location,
        period: report.period,
        retrievedAt: report.current_retrieved_at,
        units: report.unit_system,
      })}
    >
      {!report.comparison_available ? (
        /*
          **The backend's sentence is not shown in this state, and that is the point.** It reads
          "No earlier forecast is on record for 51.5085, -0.1257 over this window" — a true
          sentence naming a customer's location as a coordinate pair, on the primary Dashboard.
          Finding 24 of the customer-level review of 2026-09-11 rules that out, so this state says
          the one thing it means. Never a zero delta either: no earlier snapshot is not no movement,
          and the two are different sentences.
        */
        <p className={styles.note}>No previous forecast to compare against yet.</p>
      ) : material.length === 0 ? (
        <>
          <p className={styles.statement}>{report.statement}</p>
          <p className={styles.note}>Nothing moved materially since the previous snapshot.</p>
        </>
      ) : (
        <>
          <p className={styles.statement}>{report.statement}</p>
          {/*
            One line per day that moved. Each row carried the backend's sentence about itself as
            well — "The maximum for 5 September is 1.4 °C higher than in the earlier retrieval" —
            which is the label and the delta beside it, said again in prose. Two moved days made
            this the tallest card in the column; `01-dashboard.png` draws it as a sub-card of three
            lines. The sentences are not lost: they are what the evidence record carries.
          */}
          <ul className={styles.findings}>
          {material.map((change) => (
            <li className={styles.finding} key={`${change.local_date}-${change.measure}`}>
              <span className={styles.findingLabel}>
                {/* `5 Sep`, not `2026-09-05`: a calendar stamp is for a log, and this is a card. */}
                {shortDate(`${change.local_date}T00:00`) ?? change.local_date} ·{" "}
                {measureLabel(change.measure)}
              </span>
              <span className={styles.findingValue}>
                {typeof change.change === "number"
                  ? `${change.change > 0 ? "+" : ""}${formatReading({ value: change.change, unit: change.unit })}`
                  : "Not comparable"}
              </span>
            </li>
          ))}
          </ul>
        </>
      )}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------- the right-hand rail panels */

/**
 * "Saved Snapshots" — the panel `01-dashboard.png` puts under the anomaly panel.
 *
 * The artifact lists four places with a temperature and a trend arrow beside each. The places are
 * real here; the temperatures are not rendered, and that is a deliberate refusal rather than an
 * omission. There is no endpoint that returns conditions for a *set* of locations: a temperature
 * per row means one weather request per saved place, on every load of the Dashboard, each with its
 * own loading and failure state — for figures the briefing already presents properly for the place
 * the person actually chose. `docs/design/screens.md` §8 records the same decision for the Saved
 * Locations cards, and this is the same trade in a smaller frame.
 *
 * What the rows do carry is what the artifact's arrow implies: following one briefs the Dashboard
 * on that place, through `?place=` and the backend's resolver.
 */
export function SavedSnapshots({
  state,
}: {
  readonly state: ViewState<SavedLocationsResponse>;
}): ReactNode {
  const records = state.kind === "ready" ? state.data.locations : [];

  return (
    <Card aria-labelledby="dashboard-snapshots">
      <CardHeader headingLevel={2}
        title="Saved snapshots"
        titleId="dashboard-snapshots"
        actions={
          <Link className={styles.panelLink} href="/locations">
            View all
          </Link>
        }
      />
      <CardBody>
        {state.kind === "loading" ? (
          <p className={styles.note}>Loading your saved places…</p>
        ) : state.kind === "error" ? (
          <p className={styles.note}>Your saved places could not be loaded.</p>
        ) : records.length === 0 ? (
          /*
            A small empty state, not an explanation. `01-dashboard.png` lists saved places in a
            short rail card; the state where there are none should be the same card with nothing in
            it and one thing to do, rather than a sentence about what the card would contain.
          */
          <div className={styles.snapshotsEmpty}>
            <p className={styles.note}>No saved places yet</p>
            <Link href="/locations">
              <Button variant="secondary" size="sm">
                Save a place
              </Button>
            </Link>
          </div>
        ) : (
          <ul className={styles.snapshots}>
            {records.map((record) => {
              const name = record.label?.trim() || record.location.display_name;
              return (
                <li key={record.id}>
                  <Link
                    className={styles.snapshot}
                    href={`/?place=${encodeURIComponent(name)}`}
                  >
                    <span className={styles.snapshotName}>{name}</span>
                    <span className={styles.snapshotMeta}>{record.location.timezone}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * "Climate Pulse Analytics" — the artifact's wide intra-day chart.
 *
 * It is drawn from the forecast's **hourly** series, which is the only intra-day data Weathra has;
 * the artifact's own version pairs a temperature curve with precipitation bars on a second axis,
 * and this draws the curve alone for the reason `screens.md` §8 already records for Historical
 * Analytics: a second y-axis makes any relationship between two series an artifact of where the
 * axes were put.
 *
 * **When the provider supplies no hourly series the panel stays and says so.** That is the state
 * the stub is in, and it is a real state — not every provider returns hourly data for every place.
 * A panel that vanished would make the Dashboard a different shape depending on the provider.
 */
/**
 * One group in a card's closing rule: a label over a figure, no frame around either.
 *
 * The frame is what made the old footer three cards. A KPI in the artifact is a label at the
 * `label` step over a value at the `card` step, separated from its neighbour by space and a
 * hairline — the same treatment the hero's metric block uses, which is how one screen ends up with
 * one way of stating a small figure instead of three.
 */
function FooterKpi({ term, value }: { readonly term: string; readonly value: string }): ReactNode {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiTerm}>{term}</span>
      <span className={styles.kpiValue}>{value}</span>
    </div>
  );
}

export function ClimatePulse({
  forecast,
  footer = null,
}: {
  readonly forecast: ForecastResponse;
  /**
   * The compact figure row along the bottom of the card.
   *
   * `01-dashboard.png` closes this panel on "PEAK HEAT 19°C @ 16:20 · MAX RISK 45% @ 08:00" — two
   * statements about the curve above them, on the card the curve is on. Ours had the equivalent
   * figures as a full-width band of its own between the intelligence row and the forecast strip,
   * which is a band the artifact does not have; passing them in here is how that band was closed
   * without losing anything it said.
   */
  readonly footer?: ReactNode;
}): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  const hours = intradayHours(forecast);
  const drawable = hours.some((hour) => hour.temperature !== null);
  const peakTemperature = peakOf(hours, "temperature");
  const peakChance = peakOf(hours, "chance");

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Climate Pulse Analytics"
      eyebrow="Next 24 reported hours"
      attribution={attributionOf({
        known,
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
      /*
        **The artifact's closing rule, compacted.** `01-dashboard.png` ends this card on
        "PEAK HEAT 19°C @ 16:20 · MAX RISK 45% @ 08:00" — two statements about the curve above
        them, set small, on one line, divided by space rather than by borders. Ours rendered the
        deterministic insights here as three bordered cards with display-step figures, which is
        90 pixels of card doing the work of one 18-pixel rule.
        Both peaks are read from the same 24 hours the chart plots, so a figure in the rule and the
        same figure on the curve cannot disagree.
      */
      footer={
        <div className={styles.kpiRule}>
          {peakTemperature ? (
            <FooterKpi
              term="Peak temp"
              value={`${formatReading({ value: peakTemperature.value, unit: forecast.hourly?.units?.temperature ?? null })} @ ${peakTemperature.at}`}
            />
          ) : null}
          {peakChance ? (
            <FooterKpi term="Max rain chance" value={`${Math.round(peakChance.value)}% @ ${peakChance.at}`} />
          ) : null}
          {/*
            **Two figures on the rule, the rest behind a control.** `01-dashboard.png` closes this
            card on exactly two — "PEAK HEAT" and "MAX RISK" — and ours closed it on five, all at
            the same weight, which is a KPI strip with no first item. The other three are computed
            by `insightsFor` and none of them is deleted or moved to another screen; they are one
            press away, under the two the artifact makes primary.
          */}
          {footer ? (
            <details className={styles.moreInsights}>
              <summary className={styles.moreInsightsSummary}>More insights</summary>
              {footer}
            </details>
          ) : null}
        </div>
      }
    >
      {/* The eyebrow above the card's name already says what window this is. */}
      {drawable ? (
        <IntradayChart hours={hours} unit={forecast.hourly?.units?.temperature ?? null} />
      ) : (
        <EmptyChart
          title="Temperature through the next 24 hours"
          reason="No hourly series reported for this window."
        />
      )}
    </ProvenanceSection>
  );
}

/**
 * "Precipitation Logic" — the artifact's narrow risk panel beside the pulse chart.
 *
 * The artifact states "42% Integrated Risk", a convective type and a millimetre-per-hour load. None
 * of the three is a figure Weathra's backend produces, and an "integrated risk" percentage in
 * particular is precisely the kind of invented confidence `screens.md` §5 refuses across the set.
 *
 * So the panel keeps its position and its shape and carries the two things that *are* true about
 * precipitation in this window: whatever the forecast reported for it, and the uncertainty
 * statement the backend supplies with every forecast — its basis, its provider, and whether that
 * provider gave a spread at all. Where the provider reported no precipitation, the panel says that
 * rather than showing a zero, because no reading and a reading of zero are different facts.
 *
 * **It draws the series where there is one.** The panel used to be a list of dates and figures
 * beside a full-width chart, which made the artifact's analytics row read as one graphic and one
 * paragraph. Where the provider reports an hourly precipitation series the panel plots it, using
 * the same bar chart Historical Analytics uses for the same measure — one chart, defined once. The
 * daily list remains for a forecast that carries daily precipitation but no hourly series, because
 * a list of real figures is still better than an empty frame.
 */
/** The measure key the provider reports precipitation under, in both the hourly and daily series. */
const PRECIPITATION = "precipitation";

export function PrecipitationOutlook({
  forecast,
}: {
  readonly forecast: ForecastResponse;
}): ReactNode {
  // The place this screen resolved, read before any early return so the hook order is fixed.
  const known = useResolvedPlace();

  const hours = intradayHours(forecast);
  const peak = peakOf(hours, "chance");
  const unit = forecast.hourly?.units?.[PRECIPITATION] ?? null;

  // What the window is actually expected to deliver, added up from the hours the provider
  // reported. Null — not zero — where it reported none, because an absent reading and a reading of
  // zero are different facts and this panel has always said so.
  const reported = (forecast.hourly?.entries ?? []).filter(
    (entry) => typeof entry.values?.[PRECIPITATION] === "number",
  );
  const expected =
    reported.length === 0
      ? null
      : reported.reduce((sum, entry) => sum + (entry.values[PRECIPITATION] as number), 0);

  // The wettest hour in the window, which is the "strongest rain window" a person plans around.
  const wettest = reported.reduce<{ at: string; value: number } | null>((best, entry) => {
    const value = entry.values[PRECIPITATION] as number;
    const at = /T(\d{2}:\d{2})/.exec(entry.time_local)?.[1] ?? entry.time_local;
    return best === null || value > best.value ? { at, value } : best;
  }, null);

  const uncertainty = forecast.uncertainty;

  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Precipitation Outlook"
      eyebrow="Next 24 reported hours"
      attribution={attributionOf({
        known,
        provider: forecast.attribution?.provider,
        location: forecast.attribution?.location,
        retrievedAt: forecast.attribution?.retrieved_at,
        period: forecast.period,
        units: forecast.attribution?.units,
        fromCache: forecast.attribution?.from_cache,
      })}
    >
      {/*
        **The artifact's graphic, with the artifact's number replaced.** `01-dashboard.png` fills
        this panel with a rain graphic over "42% Integrated Risk", a convective type and a
        millimetre-per-hour load. None of the three is a figure Weathra's backend produces, and an
        "integrated risk" in particular is exactly the invented confidence `screens.md` §5 refuses
        across the set — so the composition is reproduced and the figure in it is the provider's
        own hourly chance of rain, which is a real measure it reports and Historical Analytics
        already reads.
      */}
      {peak ? (
        <div className={styles.riskPanel}>
          {/*
            **The focal graphic the artifact builds this card around.** `01-dashboard.png` fills the
            top half of it with a large rendered rain cloud and a disc on its shoulder. That
            rendering is somebody else's and is not part of this project's asset set, so what is
            here is an original drawing at the same visual mass — a gradient-lit cloud with its own
            underside, a cast shadow and teardrops falling from it. It replaces a line glyph scaled
            to 104 pixels, which task 34.30 records as still visually weaker than the artifact.

            `PrecipitationMark` draws more drops for a wet window than a quiet one, from the same
            provider figure the percentage below it is rendered from. The drawing is decoration;
            every figure on this card is the provider's and is text.
          */}
          <span className={styles.riskGlyph} data-level={peak.value >= 50 ? "wet" : "possible"}>
            <PrecipitationMark level={peak.value >= 50 ? "wet" : "possible"} />
          </span>

          <p className={styles.riskReadout}>
            <span className={styles.riskFigure}>{Math.round(peak.value)}</span>
            <span className={styles.riskUnit}>%</span>
          </p>
          <p className={styles.riskCaption}>Highest chance of rain, at {peak.at}</p>

          <dl className={styles.riskStats}>
            <div className={styles.riskStat}>
              <dt className={styles.riskStatTerm}>Expected</dt>
              <dd className={styles.riskStatValue}>
                {expected === null
                  ? "Not reported"
                  : formatReading({ value: expected, unit })}
              </dd>
            </div>
            <div className={styles.riskStat}>
              <dt className={styles.riskStatTerm}>Wettest hour</dt>
              <dd className={styles.riskStatValue}>
                {wettest === null ? "Not reported" : `${wettest.at}`}
              </dd>
            </div>
          </dl>

          {/*
            **The basis, behind a control.** It closed the card as a paragraph — "Confidence
            decreases with horizon distance, from one provider's output and its supplied spread
            only." — under a large empty area, which is finding 18's second half. It is still on
            this card, in this region, one press away; `specs/web-ui` requires a forecast figure to
            carry its uncertainty, not to lead with it.
          */}
          {uncertainty ? (
            <details className={styles.riskBasisDetails}>
              <summary className={styles.riskBasisSummary}>How this is graded</summary>
              <p className={styles.riskBasis}>{uncertainty.basis}</p>
            </details>
          ) : null}
        </div>
      ) : (
        <>
          <EmptyChart
            title="Chance of rain through the next 24 hours"
            reason="This provider reported no chance of rain for this window. That is an absent reading, not a reading of zero."
          />
          {uncertainty ? <p className={styles.riskBasis}>{uncertainty.basis}</p> : null}
        </>
      )}
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------------------ why? */

export interface WhyProps {
  readonly analysis: AnalysisResponse | null;
}

/**
 * *Why?* — the artifact's second sub-card inside Weathra Intelligence, filled truthfully.
 *
 * `01-dashboard.png` answers it with "increased thermal instability in the upper troposphere
 * exacerbated convection along the leading edge of the low-pressure system", which is a sentence
 * about an atmosphere Weathra does not model. What Weathra *does* have for this slot is the shape
 * of the window itself: a Theil–Sen slope across it, and how many entries stood out against the
 * rest. Both are computed here, both carry their method, and together they are the deterministic
 * answer to why the days ahead read the way they do.
 *
 * It is an ANALYTICS region rather than part of the interpretation beside it, because that is what
 * it is — a computed statement, not the model's. The badge says so where a reader meets it.
 */
export function Why({ analysis }: WhyProps): ReactNode {
  const trend = analysis?.trend ?? null;
  const anomalies = analysis?.anomalies?.anomalies ?? [];
  if (!trend) return null;

  const measure = measureLabel(trend.measure);
  const standouts = anomalies.length;

  return (
    <ProvenanceSection dataClass="analytics" title="Why?" headingLevel={3}>
      <p className={styles.statement}>
        {/*
          The direction the backend classified, the size of the move it measured, and — where the
          same analysis found any — how many entries sat outside the window's own spread. Both
          clauses are figures from the response; neither is an explanation composed here.
        */}
        {measure} is {trend.direction} across this window, by{" "}
        {formatReading({ value: trend.magnitude, unit: trend.unit })} in total.
        {standouts > 0
          ? ` ${standouts} ${standouts === 1 ? "day sits" : "days sit"} outside its usual spread.`
          : " Nothing in it sits outside its usual spread."}
      </p>

      <MethodNote
        method={trend.method}
        pointsUsed={trend.points_used}
        pointsExcluded={trend.points_excluded}
        unit={trend.unit}
        compact
      />
    </ProvenanceSection>
  );
}

/* ------------------------------------------------------------ confidence matrix */

export interface ConfidenceMatrixProps {
  readonly forecast: ForecastResponse | null;
  readonly analysis: AnalysisResponse | null;
}

/**
 * "Confidence Matrix" — the bars beside Weathra Intelligence in `01-dashboard.png`.
 *
 * Two rows, and both carry a figure. Forecast confidence comes from the backend's own
 * `UncertaintyStatement` — a level per horizon distance, which is a real graded figure — and
 * coverage is the share of points the deterministic analytics actually used, which the statistics
 * report themselves.
 *
 * **The artifact's other two bars are gone rather than drawn empty.** It fills MODEL CONVERGENCE
 * with 94% and DATA RELIABILITY with 82%; Weathra computes neither, because it reads one provider
 * and no endpoint scores a provider. They were kept as unfilled bars, on the reasoning that the
 * artifact's geometry was worth preserving and the empty state said why. Photographing the result
 * settled it the other way: two permanent rows of "Weathra does not compute this" advertise a
 * capability to a customer in the act of denying it, and that is internal reasoning on a product
 * screen. `EmptyChart` still exists for the different case — a real figure the provider did not
 * report this time, where the frame is worth holding open.
 */
export function ConfidenceMatrix({ forecast, analysis }: ConfidenceMatrixProps): ReactNode {
  const horizon = forecast?.uncertainty?.horizon?.[0] ?? null;
  /*
   * The backend grades a horizon point as high/moderate/low. The bar shows that grade at a fixed
   * position rather than inventing a percentage between them — the figure being drawn is the
   * backend's own three-step grade, not a continuous score somebody computed.
   */
  const level = confidenceLevelFor(horizon?.confidence);
  const confidence =
    level === "high" ? 0.9 : level === "moderate" ? 0.6 : level === "low" ? 0.3 : null;

  const results: readonly StatisticResult[] = analysis?.findings ?? [];
  const used = results.reduce((total, result) => total + (result.points_used ?? 0), 0);
  const excluded = results.reduce((total, result) => total + (result.points_excluded ?? 0), 0);
  const coverage = used + excluded > 0 ? used / (used + excluded) : null;

  return (
    <section className={styles.matrix} aria-label="Confidence">
      <h3 className={styles.matrixTitle}>Confidence</h3>
      {/*
        **Two bars and two short notes.** The notes read "Graded from horizon distance — 6 h ahead."
        and "192 of 240 points usable." — two explanations of method where the artifact has a
        figure. The method has not gone anywhere: forecast confidence carries its basis under the
        strip below, and the coverage figure is the point count itself. What is left here is what
        the bar is measuring.
      */}
      <Meter
        label="Forecast confidence"
        value={confidence}
        unavailable="No horizon reported"
        note={horizon ? `${horizon.hours_ahead} h ahead` : "No horizon reported"}
      />
      <Meter
        label="Data coverage"
        value={coverage}
        unavailable="No statistics yet"
        note={
          coverage === null
            ? "Nothing computed for this window"
            : `${used} of ${used + excluded} points`
        }
      />
    </section>
  );
}
