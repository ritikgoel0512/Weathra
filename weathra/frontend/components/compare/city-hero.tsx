"use client";

/**
 * The two city cards `04-compare-cities.png` opens on — task 34.31.
 *
 * The artifact's first product region is two equal cards side by side: a photograph of the place
 * with a data-class badge and the city's name on it, and beneath the image a dominant temperature
 * with its condition, then humidity and wind on one rule. That is a weather summary, and it is the
 * thing a person comparing two cities actually came to look at.
 *
 * Production's version was a ranking card: the place's image, `#1` before its name, the *ranked
 * statistic* as the headline figure, and the sentence "Mean temperature (mean) · ranked by warmest"
 * underneath it. Every word of that is true and none of it is what the artifact puts there — the
 * customer-level review of 2026-09-11 recorded the whole screen as reading like a report for
 * exactly this kind of reason.
 *
 * **What is real here, and where it comes from.** The photograph is the shared
 * `LocationImage` chain — provider, committed file, Wikimedia, drawn artwork — the same one the
 * frozen Dashboard uses. The temperature, the condition, the humidity and the wind are
 * `GET /weather/current` for that place's own coordinates, retrieved by the screen. The rank is a
 * small pill rather than the card's subject, and the statistic that decided it has moved to the
 * ranking disclosure further down.
 *
 * **What is refused.** The artifact's `BER-CENTRAL-09` station pill, its `LIVE SYNC` and its
 * `VALIDATED` marks are instrumentation Weathra does not have; `screens.md` §5 records the refusal
 * and this card carries the truthful equivalent instead — the data class of the figures shown, and
 * the observation's own local hour.
 */

import type { ReactNode } from "react";

import { DataClassBadge, LocationImage, WeatherIcon } from "@/components/ui";
import type { ComparisonCandidate, CurrentResponse } from "@/lib/api/schema";
import { formatFigure, formatReading, readingFor } from "@/lib/dashboard/briefing";
import { placeLabel } from "@/lib/locations/place";
import { conditionFor } from "@/lib/weather/condition";

import styles from "./compare.module.css";

/** `2026-09-04T08:15` → `08:15`, read as text so no timezone is re-applied to it. */
function observedAt(timeLocal: string | null | undefined): string | null {
  if (!timeLocal) return null;
  return /T(\d{2}:\d{2})/.exec(timeLocal)?.[1] ?? null;
}

/** Everything after the first comma of the backend's own name: `Germany`, `Bavaria, Germany`. */
function regionOf(displayName: string): string | null {
  const parts = displayName.split(",").slice(1).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export interface CityHeroProps {
  readonly candidate: ComparisonCandidate;
  /** This place's own current conditions, or null while they are in flight or unavailable. */
  readonly current: CurrentResponse | null;
  /** True when another candidate shares this rank, so a tie is stated rather than inferred. */
  readonly sharesRank: boolean;
}

export function CityHero({ candidate, current, sharesRank }: CityHeroProps): ReactNode {
  const name = placeLabel(candidate.location) ?? candidate.label;
  const city = name.split(",")[0]?.trim() || name;
  const region = regionOf(name);

  const temperature = readingFor("temperature", current?.values, current?.units);
  const condition = conditionFor(
    typeof current?.values?.weather_code === "number" ? current.values.weather_code : null,
  );
  const humidity = readingFor("relative_humidity", current?.values, current?.units);
  const wind = readingFor("wind_speed", current?.values, current?.units);
  const observed = observedAt(current?.observed_at_local);

  return (
    <article className={styles.cityHero} data-candidate="true" data-rank={candidate.rank}>
      <LocationImage
        displayName={name}
        latitude={candidate.location.latitude}
        longitude={candidate.location.longitude}
        variant="banner"
      >
        <div className={styles.cityHeroOverlay}>
          {/*
            The artifact puts OBSERVED over one city and FORECAST over the other, then a station
            identifier under each. The class is real and is the one the figures below actually
            carry; the station is not, and is not drawn.
          */}
          <span className={styles.cityHeroBadges}>
            <DataClassBadge dataClass={current ? "observed" : "forecast"} />
            {sharesRank || candidate.tied ? (
              <span className={styles.cityHeroTie}>Tied</span>
            ) : null}
            {/* Small, and last. The ranking is a fact about this card, not its subject. */}
            <span className={styles.cityHeroRank} aria-label={`Rank ${candidate.rank}`}>
              #{candidate.rank}
            </span>
          </span>

          <span className={styles.cityHeroIdentity}>
            <h3 className={styles.cityHeroName}>{city}</h3>
            {region ? <p className={styles.cityHeroRegion}>{region}</p> : null}
          </span>
        </div>
      </LocationImage>

      <div className={styles.cityHeroBody}>
        <div className={styles.cityHeroReadout}>
          {temperature ? (
            <p className={styles.cityHeroTemperature}>
              <span className={styles.cityHeroFigure}>{formatFigure(temperature)}</span>
              <span className={styles.cityHeroUnit}>{temperature.unit ?? ""}</span>
            </p>
          ) : (
            <p className={styles.note}>No current temperature reported</p>
          )}
          {condition ? (
            <p className={styles.cityHeroCondition}>
              <WeatherIcon condition={condition} size={20} />
              <span>{condition.label}</span>
            </p>
          ) : null}
        </div>

        {/*
          The artifact's right-hand pair is `LIVE SYNC` over `VALIDATED`. Weathra has neither a
          stream nor a validator; what it has is when the provider observed this and which zone that
          hour is in, which is the same reassurance told truthfully.
        */}
        <dl className={styles.cityHeroContext}>
          {observed ? (
            <div className={styles.cityHeroContextItem}>
              <dt>Observed</dt>
              <dd>{observed}</dd>
            </div>
          ) : null}
          {candidate.location.timezone ? (
            <div className={styles.cityHeroContextItem}>
              <dt>Zone</dt>
              <dd>{candidate.location.timezone}</dd>
            </div>
          ) : null}
        </dl>

        {/* The artifact's own two metrics, under a hairline, with their own glyphs. */}
        <dl className={styles.cityHeroMetrics}>
          <div className={styles.cityHeroMetric}>
            <dt className={styles.cityHeroMetricTerm}>Humidity</dt>
            <dd className={styles.cityHeroMetricValue}>
              {humidity ? formatReading(humidity) : "Not reported"}
            </dd>
          </div>
          <div className={styles.cityHeroMetric}>
            <dt className={styles.cityHeroMetricTerm}>Wind</dt>
            <dd className={styles.cityHeroMetricValue}>
              {wind ? formatReading(wind) : "Not reported"}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
