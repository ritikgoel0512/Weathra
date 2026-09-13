/**
 * The report's curation, checked where it is decided.
 *
 * The screen test renders the whole report and asserts what a reader sees. These are the rules
 * underneath it, and they are the ones that would rot quietly: a cap that silently drops instead of
 * handing back its overflow, an order that stops matching the artifact's, a figure reconstructed
 * from something nearby when the backend did not return it.
 */

import { describe, expect, it } from "vitest";

import type {
  AnalysisResponse,
  Baseline,
  BaselineComparison,
  CurrentResponse,
  StatisticResult,
  WhatChanged,
} from "@/lib/api/schema";
import {
  CHANGE_NOTE_LIMIT,
  CHART_STAT_LIMIT,
  CURRENT_TILE_LIMIT,
  HERO_FIGURE_LIMIT,
  anomalyAttentionFrom,
  changedFrom,
  chartStatsFrom,
  currentTilesFrom,
  evidenceChipsFrom,
  groundingFrom,
  heroFiguresFrom,
  historicalContextFrom,
  isReportHorizon,
  synthesisFrom,
} from "./view-model";

function statistic(
  measure: string,
  name: string,
  value: number | null,
  unit = "°C",
): StatisticResult {
  return {
    measure,
    statistic: name,
    value,
    unit,
    method: `${name} of usable points`,
    minimum_points: 1,
    points_used: 4,
    provenance: {},
  } as unknown as StatisticResult;
}

const BASELINE = {
  labelling: "Baseline for 10-17 September",
  measure: "temperature_mean",
  provider: "open-meteo",
  mean: statistic("temperature_mean", "mean", 14.7),
  minimum: statistic("temperature_mean", "minimum", 12.2),
  maximum: statistic("temperature_mean", "maximum", 17.4),
  standard_deviation: statistic("temperature_mean", "standard_deviation", 1.8),
  years_requested: 10,
  years_used: [2021, 2022, 2023],
} as unknown as Baseline;

const COMPARISON = {
  characterization: "Warmer than the 3-year baseline for this calendar period.",
  difference: statistic("temperature_mean", "delta", 1.7),
  z_score: statistic("temperature_mean", "z_score", 1.21, ""),
} as unknown as BaselineComparison;

describe("the headline", () => {
  it("promotes the comparison's own sentence and keeps the summary under it", () => {
    const synthesis = synthesisFrom({
      analysis: { summary: "The mean temperature is 15.1 °C." } as AnalysisResponse,
      comparison: COMPARISON,
    });

    expect(synthesis.headline).toBe(COMPARISON.characterization);
    expect(synthesis.lead).toBe("The mean temperature is 15.1 °C.");
  });

  it("never prints one backend sentence in both weights", () => {
    const synthesis = synthesisFrom({
      analysis: { summary: "The mean temperature is 15.1 °C." } as AnalysisResponse,
      comparison: null,
    });

    expect(synthesis.headline).toBe("The mean temperature is 15.1 °C.");
    expect(synthesis.lead).toBeNull();
  });

  it("composes nothing when the backend wrote nothing", () => {
    expect(synthesisFrom({ analysis: null, comparison: null })).toEqual({
      headline: null,
      lead: null,
    });
  });
});

describe("the hero figures", () => {
  it("are the three Weathra computes, and never more than three", () => {
    const figures = heroFiguresFrom({
      forecast: {
        uncertainty: { horizon: [{ confidence: "high", hours_ahead: 6 }] },
      } as never,
      comparison: COMPARISON,
      analysis: {
        trend: {
          direction: "rising",
          magnitude: 1.2,
          slope_per_day: 0.4,
          unit: "°C",
          method: "least-squares slope",
        },
      } as AnalysisResponse,
    });

    expect(figures).toHaveLength(HERO_FIGURE_LIMIT);
    expect(figures.map((figure) => figure.value)).toEqual(["high", "+1.7 °C", "+1.2 °C"]);
    expect(figures[1]?.delta?.text).toBe("1.21 σ from the mean");
  });

  it("draw fewer rather than filling a slot the backend did not answer", () => {
    const figures = heroFiguresFrom({ forecast: null, comparison: null, analysis: null });
    expect(figures).toEqual([]);
  });
});

describe("the condition tiles", () => {
  const current = {
    units: { temperature: "°C", dew_point: "°C", uv_index: "", wind_speed: "km/h" },
    values: {
      dew_point: 11.1,
      temperature: 18.4,
      uv_index: 2,
      wind_speed: 14.2,
      cloud_cover: 60,
      relative_humidity: 72,
      surface_pressure: 1012,
      precipitation: 4.2,
      // A code identifies a condition; it is not a figure and takes no tile.
      weather_code: 61,
    },
  } as unknown as CurrentResponse;

  it("lead with the artifact's order rather than the provider's", () => {
    const tiles = currentTilesFrom(current);
    expect(tiles.shown.map((reading) => reading.key)).toEqual([
      "temperature",
      "precipitation",
      "relative_humidity",
      "wind_speed",
      "surface_pressure",
      "uv_index",
    ]);
  });

  it("hand back what the cap dropped rather than losing it", () => {
    const tiles = currentTilesFrom(current);
    expect(tiles.shown).toHaveLength(CURRENT_TILE_LIMIT);
    expect(tiles.rest.map((reading) => reading.key)).toEqual(["cloud_cover", "dew_point"]);
    expect(tiles.shown.some((reading) => reading.key === "weather_code")).toBe(false);
  });
});

describe("what changed", () => {
  const changes = {
    statement: "Two days moved materially.",
    changes: [
      { local_date: "d1", measure: "temperature_max", change: 0.1, material: false, unit: "°C" },
      { local_date: "d2", measure: "temperature_max", change: 1.4, material: true, unit: "°C" },
      { local_date: "d3", measure: "temperature_min", change: -1.1, material: true, unit: "°C" },
      { local_date: "d4", measure: "precipitation_sum", change: 0.2, material: false, unit: "mm" },
      // Never a zero for an absent movement: a null change is not a day that did not move.
      { local_date: "d5", measure: "temperature_max", change: null, material: false, unit: "°C" },
    ],
  } as unknown as WhatChanged;

  it("shows material movements first and counts what it is not showing", () => {
    const changed = changedFrom(changes);
    expect(changed?.notes.map((note) => note.date)).toEqual(["d2", "d3", "d1"]);
    expect(changed?.notes).toHaveLength(CHANGE_NOTE_LIMIT);
    expect(changed?.hidden).toBe(1);
  });

  it("is absent, rather than empty, when no comparison was reported", () => {
    expect(changedFrom(null)).toBeNull();
  });
});

describe("the chart's figures", () => {
  const analysis = {
    findings: [
      statistic("temperature", "mean", 15.1),
      statistic("temperature", "maximum", 24.5),
      statistic("temperature", "minimum", 9.7),
      statistic("precipitation", "total", 12.5, "mm"),
    ],
  } as unknown as AnalysisResponse;

  it("are four, read off the responses rather than off the plotted series", () => {
    const stats = chartStatsFrom({ analysis, baseline: BASELINE, comparison: COMPARISON });
    expect(stats).toHaveLength(CHART_STAT_LIMIT);
    expect(stats.map((stat) => stat.value)).toEqual(["24.5 °C", "15.1 °C", "14.7 °C", "1.21 σ"]);
  });

  it("shorten to what exists when the archive answered with nothing", () => {
    const stats = chartStatsFrom({ analysis, baseline: null, comparison: null });
    expect(stats.map((stat) => stat.key)).toEqual(["window-maximum", "window-mean"]);
  });
});

describe("the historical card", () => {
  it("gives the hero the characterization and keeps the labelling for itself", () => {
    const context = historicalContextFrom({
      baseline: BASELINE,
      comparison: COMPARISON,
      headline: COMPARISON.characterization,
    });

    expect(context?.paragraph).toBe(BASELINE.labelling);
    expect(context?.figures.map((figure) => figure.value)).toEqual([
      "14.7 °C",
      "17.4 °C",
      "1.8 °C",
    ]);
    expect(context?.coverage).toBeCloseTo(0.3);
  });

  it("is absent when the archive computed no baseline", () => {
    expect(
      historicalContextFrom({ baseline: null, comparison: COMPARISON, headline: null }),
    ).toBeNull();
  });
});

describe("the attention card", () => {
  it("names the entry that stood out furthest, by the backend's own score", () => {
    const attention = anomalyAttentionFrom({
      anomalies: {
        method: "median absolute deviation, threshold 3.5",
        threshold: 3.5,
        unit: "°C",
        anomalies: [
          { time_local: "t1", deviation: 2.8, deviation_score: 3.9 },
          { time_local: "t2", deviation: -5.9, deviation_score: 5.4 },
        ],
      },
    } as unknown as AnalysisResponse);

    expect(attention?.count).toBe(2);
    expect(attention?.strongest).toEqual({ stamp: "t2", deviation: "-5.9 °C", score: 5.4 });
  });

  it("is nothing at all when the window was unremarkable", () => {
    expect(
      anomalyAttentionFrom({ anomalies: { anomalies: [] } } as unknown as AnalysisResponse),
    ).toBeNull();
    expect(anomalyAttentionFrom(null)).toBeNull();
  });
});

describe("the grounding", () => {
  it("names one row per class of figure, and no latency for any of them", () => {
    const rows = groundingFrom({
      current: { attribution: { provider: "open-meteo", retrieved_at: "x" } } as never,
      forecast: { attribution: { provider: "open-meteo", retrieved_at: "y" } } as never,
      baseline: BASELINE,
      analysis: { provider: "open-meteo" } as AnalysisResponse,
      formatStamp: (value) => (value ? `at ${value}` : null),
    });

    expect(rows.map((row) => row.role)).toEqual([
      "Conditions now",
      "Outlook",
      "Archive record",
      "Statistics",
    ]);
    expect(rows[3]?.provider).toBe("Computed by Weathra");
  });

  it("omits a row for a read that reported no attribution", () => {
    const rows = groundingFrom({
      current: null,
      forecast: null,
      baseline: BASELINE,
      analysis: null,
      formatStamp: () => null,
    });
    expect(rows.map((row) => row.role)).toEqual(["Archive record"]);
  });
});

describe("the evidence chips", () => {
  it("name what the reading was read from and what wrote it", () => {
    expect(
      evidenceChipsFrom({
        answer: {
          attribution: [
            { provider: "open-meteo" },
            // The same provider twice is one chip, not two.
            { provider: "open-meteo" },
          ],
          llm_provider: "openrouter",
          llm_model: "a-model",
        } as never,
        baseline: BASELINE,
      }),
    ).toEqual(["Read from open-meteo", BASELINE.labelling, "openrouter · a-model"]);
  });

  it("are empty before anything has been asked", () => {
    expect(evidenceChipsFrom({ answer: null, baseline: null })).toEqual([]);
  });
});

describe("the window control", () => {
  it("accepts only the four horizons it draws", () => {
    expect(isReportHorizon("7")).toBe(true);
    expect(isReportHorizon("10")).toBe(false);
  });
});
