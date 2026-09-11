"use client";

/**
 * "Forecast Delta Explorer" — the seven-row differential matrix `04-compare-cities.png` draws.
 * Task 34.31.
 *
 * The artifact's version is a row per day: the weekday on the left, then one cell per city holding
 * a condition glyph and that day's temperature. It is the most scannable region on that screen —
 * you read down two columns of icons and see where the two places diverge.
 *
 * Production's version was a `<table>` with `2026-09-04` down the side and `19.6 °C` in each cell,
 * with no glyph anywhere in it. Every figure was right and the region read as a spreadsheet, which
 * is the difference the customer-level review of 2026-09-11 was recording.
 *
 * **Nothing about the data changed.** Each cell is still that place's own provider's forecast for
 * that day, retrieved by the screen. What is added is the condition, which comes from the same
 * day's `weather_code` — the provider's own dominant code, translated by `lib/weather/condition`,
 * never inferred from the temperature beside it. A day a provider did not forecast keeps its row
 * and says so; a day it forecast without a code gets the temperature and no glyph.
 *
 * **Seven rows only where there are seven days.** The artifact has seven because its window is
 * seven; the horizon here is what the person asked for, so the rows are the days the providers
 * actually answered with and no more. Inventing the difference would be the one thing this screen
 * exists not to do.
 */

import type { ReactNode } from "react";

import { ProvenanceSection, ScrollRegion, WeatherIcon } from "@/components/ui";
import { conditionFor } from "@/lib/weather/condition";

import styles from "./compare.module.css";

/** One place's answer for one day: what it will be, and how warm. */
export interface DeltaCell {
  readonly date: string;
  /** The provider's dominant code for the day, or null where it reported none. */
  readonly conditionCode: number | null;
  /** Already formatted by the caller, from the reading the provider returned. */
  readonly high: string | null;
}

export interface DeltaRow {
  readonly label: string;
  readonly days: readonly DeltaCell[];
}

export interface ForecastDeltaProps {
  /** One entry per compared place, in rank order. */
  readonly rows: readonly DeltaRow[];
  /** Every local date any place reported, ascending. */
  readonly dates: readonly string[];
}

/** `2026-09-04` → `Thu`. The artifact's own day label, and the one a person scans by. */
function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { weekday: "short" });
}

/** `2026-09-04` → `4 Sep`, from the string's own parts so no locale reorders them. */
function shortDateOf(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] ?? match[2]}`;
}

export function ForecastDeltaExplorer({ rows, dates }: ForecastDeltaProps): ReactNode {
  return (
    <ProvenanceSection
      dataClass="forecast"
      title="Forecast Delta Explorer"
      eyebrow={`${dates.length}-day differential matrix`}
      attribution={null}
      action={
        rows.length > 0 ? (
          <span className={styles.deltaLegend}>
            {rows.map((row, index) => (
              <span className={styles.deltaLegendItem} key={row.label} data-series={index}>
                {row.label.split(",")[0]}
              </span>
            ))}
          </span>
        ) : null
      }
    >
      {rows.length === 0 || dates.length === 0 ? (
        <p className={styles.note}>No forecast was retrieved for the compared places.</p>
      ) : (
        <ScrollRegion label="Forecast by day and place">
          {/*
            A grid of rows rather than a table. It is still one cell per place per day with a row
            header, and it is still read as a matrix by a screen reader — the `<table>` is kept for
            exactly that, and the appearance is what changed.
          */}
          <table className={styles.delta}>
            <caption className="weathra-visually-hidden">
              Each place&rsquo;s forecast high and condition, by day, over the shared horizon.
            </caption>
            <thead className="weathra-visually-hidden">
              <tr>
                <th scope="col">Day</th>
                {rows.map((row) => (
                  <th scope="col" key={row.label}>
                    {row.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => (
                <tr className={styles.deltaRow} key={date}>
                  <th scope="row" className={styles.deltaDay}>
                    <span className={styles.deltaWeekday}>{weekdayOf(date)}</span>
                    <span className={styles.deltaDate}>{shortDateOf(date)}</span>
                  </th>
                  {rows.map((row) => {
                    const cell = row.days.find((day) => day.date === date);
                    const condition = conditionFor(cell?.conditionCode ?? null);
                    return (
                      <td className={styles.deltaCell} key={`${row.label}-${date}`}>
                        {cell?.high ? (
                          <>
                            <span className={styles.deltaIcon}>
                              {condition ? (
                                <WeatherIcon condition={condition} size={26} />
                              ) : (
                                <span
                                  className={styles.deltaIconEmpty}
                                  title="The provider reported no condition for this day."
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                              )}
                            </span>
                            <span className={styles.deltaValue}>{cell.high}</span>
                            {condition ? (
                              <span className="weathra-visually-hidden">{condition.label}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className={styles.deltaAbsent}>Not forecast</span>
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
