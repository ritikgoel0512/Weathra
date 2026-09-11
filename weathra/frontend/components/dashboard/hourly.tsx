"use client";

import type { ReactNode } from "react";

import { ScrollRegion } from "@/components/ui";
import { WeatherIcon } from "@/components/ui";
import type { ForecastResponse } from "@/lib/api/schema";
import { conditionFor } from "@/lib/weather/condition";

import styles from "./dashboard.module.css";

/**
 * The next hours, horizontally — the band `01-dashboard.png` has and Weathra did not.
 *
 * The provider returns 48 hourly points with temperature, precipitation, the chance of it and cloud
 * cover, and until now the Dashboard rendered none of them: the hourly series existed only inside
 * the Climate Pulse chart's line. A person asking "do I need a coat this afternoon" could read it
 * off a chart axis or not at all.
 *
 * **Twenty-four hours, not forty-eight.** The strip answers *today and tonight*; a second day of
 * hours is the forecast strip's job, and a scroll region twice as long is not twice as useful.
 *
 * Every figure is the provider's. The condition glyph is derived from the same row's cloud cover
 * and precipitation — see `lib/weather/condition` for why that derivation is sound and what it
 * deliberately refuses to claim.
 */
export function HourlyForecast({ forecast }: { readonly forecast: ForecastResponse }): ReactNode {
  const hours = hoursFrom(forecast);
  if (hours.length === 0) return null;

  return (
    <section className={styles.hourly} aria-label="Hourly forecast">
      <h2 className={styles.hourlyTitle}>Today, hour by hour</h2>
      <ScrollRegion label="Hourly forecast" className={styles.hourlyScroll}>
        <ol className={styles.hourlyList}>
          {hours.map((hour) => (
            <li className={styles.hour} key={hour.timeLocal}>
              <span className={styles.hourTime}>{hour.clock}</span>
              <span className={styles.hourIcon}>
                <WeatherIcon condition={hour.condition} size={22} />
              </span>
              <span className={styles.hourTemperature}>
                {hour.temperature === null ? "—" : `${Math.round(hour.temperature)}°`}
              </span>
              {/* Only where the provider reported a chance, and only when it is worth saying. */}
              {hour.chance !== null && hour.chance >= 5 ? (
                <span className={styles.hourChance}>{Math.round(hour.chance)}%</span>
              ) : (
                <span className={styles.hourChanceEmpty} aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      </ScrollRegion>
    </section>
  );
}

interface Hour {
  readonly timeLocal: string;
  readonly clock: string;
  readonly temperature: number | null;
  readonly chance: number | null;
  readonly condition: ReturnType<typeof conditionFor>;
}

/** The next 24 reported hours, in the location's own local time. */
export function hoursFrom(forecast: ForecastResponse): readonly Hour[] {
  const entries = forecast.hourly?.entries ?? [];
  return entries.slice(0, 24).map((entry) => {
    const values = (entry.values ?? {}) as Record<string, number | null>;
    return {
      timeLocal: entry.time_local,
      clock: clockOf(entry.time_local),
      temperature: numberOrNull(values.temperature),
      chance: numberOrNull(values.precipitation_probability),
      // The provider's own code, not a sky state inferred from cloud cover.
      condition: conditionFor(numberOrNull(values.weather_code)),
    };
  });
}

/**
 * `2026-09-11T14:00:00+02:00` → `14:00`, read off the string.
 *
 * Not parsed into a `Date` and reformatted: the stamp is already in the *location's* timezone, and
 * re-expressing it would show a person in London what Munich's afternoon looks like in London.
 * `formatLocalStamp` makes the same choice for the same reason.
 */
function clockOf(timeLocal: string): string {
  const match = /T(\d{2}:\d{2})/.exec(timeLocal ?? "");
  return match?.[1] ?? "";
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
