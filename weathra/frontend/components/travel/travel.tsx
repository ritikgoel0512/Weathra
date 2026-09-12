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
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  ErrorState,
  LoadingState,
  LocationImage,
  Meter,
} from "@/components/ui";
import type {
  ComparisonCandidate,
  ComparisonResult,
  Criterion,
  Location,
  PreferenceView,
  StatisticResult,
} from "@/lib/api/schema";
import {
  briefingLocationFrom,
  formatReading,
  measureLabel,
} from "@/lib/dashboard/briefing";
import { localLabel } from "@/lib/explorer/reading";
import { friendlyName } from "@/lib/locations/place";
import { useApiQuery } from "@/lib/query/hooks";
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

/** The four compact cards the artifact sets under the hero, from the best day's own statistics. */
function TravelMetrics({ best }: { readonly best: ComparisonCandidate | null }): ReactNode {
  const cards = [
    { key: "temperature", label: "Best-day temperature", stat: statOf(best, ["temperature_max", "temperature_mean", "temperature"]) },
    { key: "precipitation", label: "Rain in the window", stat: statOf(best, ["precipitation_sum", "precipitation"]) },
    { key: "wind", label: "Wind", stat: statOf(best, ["wind_gust_max", "wind_speed_max", "wind_speed"]) },
    { key: "humidity", label: "Humidity", stat: statOf(best, ["relative_humidity_mean", "relative_humidity", "cloud_cover_mean"]) },
  ].filter((card) => card.stat !== null);

  if (cards.length === 0) return null;

  return (
    <section className={styles.metrics} aria-label="Figures for the best-ranked day">
      {cards.map((card) => (
        <div className={styles.metric} key={card.key}>
          <DataClassBadge dataClass="analytics" />
          <p className={styles.metricLabel}>{card.label}</p>
          <p className={styles.metricValue}>{reading(card.stat)}</p>
          <p className={styles.metricNote}>{card.stat!.method}</p>
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
  best,
}: {
  readonly candidate: ComparisonCandidate;
  readonly best: number;
}): ReactNode {
  const { weekday, date } = dayLabel(candidate);
  const temperature = statOf(candidate, ["temperature_max", "temperature_mean", "temperature"]);
  const rain = statOf(candidate, ["precipitation_sum", "precipitation"]);

  return (
    <li className={styles.day} data-best={candidate.rank === 1 ? "true" : undefined}>
      <p className={styles.dayWeekday}>{weekday}</p>
      <p className={styles.dayDate}>{date}</p>
      <p className={styles.dayFigure}>{reading(temperature) ?? "—"}</p>
      <p className={styles.dayRain}>{reading(rain) ?? "No rain reported"}</p>
      {candidate.rank === 1 ? <Badge tone="ok">Best</Badge> : null}
      {candidate.tied ? <Badge tone="neutral">Tied</Badge> : null}

      <Meter
        label={`Score for ${candidate.label}`}
        value={best === 0 ? null : Math.max(0, Math.min(1, candidate.score / best))}
      />

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
function TripGuidance({ best }: { readonly best: ComparisonCandidate | null }): ReactNode {
  const rain = statOf(best, ["precipitation_sum", "precipitation"]);
  const wind = statOf(best, ["wind_gust_max", "wind_speed_max", "wind_speed"]);
  const temperature = statOf(best, ["temperature_max", "temperature_mean", "temperature"]);
  const low = statOf(best, ["temperature_min"]);

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
  const lowValue = (low?.value ?? temperature?.value) as number | undefined;
  if (typeof lowValue === "number" && lowValue <= 12) {
    notes.push({
      key: "cool",
      text: "A warmer layer",
      because: `${reading(low ?? temperature)} at the low end`,
    });
  }
  if (temperature && (temperature.value as number) >= 25) {
    notes.push({
      key: "warm",
      text: "Sun and heat protection",
      because: `${reading(temperature)} at the high end`,
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
  const bestScore = best?.score ?? 0;

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

      {ranking.state.kind === "error" ? (
        <ErrorState failure={ranking.state.failure} title="Those days were not ranked" />
      ) : null}

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
          <TravelMetrics best={best} />

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
                    <DayCard key={candidate.label} candidate={candidate} best={bestScore} />
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

            <TripGuidance best={best} />
          </div>

          <p className={styles.advisory}>
            This ranks days by the weather forecast for one place. It is not advice about flights,
            airlines, transport or bookings — Weathra has no information about any of them — and a
            forecast further out is less certain than one nearby.
          </p>
        </>
      ) : null}
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
