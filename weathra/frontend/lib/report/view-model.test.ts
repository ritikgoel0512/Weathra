/**
 * The report's curation and its arithmetic-free headline, checked where they are decided.
 *
 * The screen test renders the whole report and asserts what a reader sees. These are the rules
 * underneath it, and they are the ones that would rot quietly: a cap that silently drops instead of
 * handing back its overflow, an order that stops matching the artifact's, a figure printed at the
 * precision it was computed at, or a headline that starts asserting something the backend did not.
 */

import { describe, expect, it } from "vitest";

import type {
  AnalysisResponse,
  AnswerEnvelope,
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
  footerFrom,
  formatSigma,
  groundingFrom,
  headlineFrom,
  heroFiguresFrom,
  historicalContextFrom,
  isReportHorizon,
  outlookFrom,
  reportReferenceFrom,
  roundTo,
  type OutlookDay,
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

/** The real shape: a z-score arrives at full float precision and a characterization is arithmetic. */
const COMPARISON = {
  characterization:
    "17.2 °C is 1.6 °C above the 9-year baseline temperature mean of 15.6 °C (+0.67 standard deviations).",
  difference: statistic("temperature_mean", "delta", 1.6),
  z_score: statistic("temperature_mean", "z_score", 0.6706849412785952, ""),
} as unknown as BaselineComparison;

function day(level: "wet" | "possible" | "dry" | null): OutlookDay {
  return {
    date: `2026-09-1${level === null ? 0 : 1}`,
    weekday: "Thu",
    condition: null,
    high: null,
    low: null,
    precipitation: level === null ? null : { level, caption: "", description: "" },
    leading: false,
  };
}

describe("the precision", () => {
  it("rounds a figure down to the places it is read at, and never up", () => {
    expect(roundTo(0.6706849412785952, 2)).toBe("0.67");
    expect(roundTo(7.250775664373425, 2)).toBe("7.25");
    expect(roundTo(2.2, 2)).toBe("2.2");
    expect(roundTo(18.44, 1)).toBe("18.4");
  });

  it("states a standard-deviation figure at two places, with its symbol", () => {
    expect(formatSigma(0.6706849412785952)).toBe("0.67σ");
    expect(formatSigma(-2.219209)).toBe("-2.22σ");
  });
});

describe("the headline", () => {
  it("states where the window sits, which way it moves, and whether rain is in it", () => {
    const { headline } = headlineFrom({
      comparison: COMPARISON,
      analysis: { trend: { direction: "rising" } } as AnalysisResponse,
      outlook: [day("wet"), day("dry"), day("possible")],
    });

    // "Slightly" is licensed by the z-score's magnitude band, not by any new arithmetic.
    expect(headline).toBe(
      "Slightly above the seasonal record, warming through the window, with rain on 2 of 3 days.",
    );
  });

  it("says nothing about a trend the backend called steady, and no number anywhere", () => {
    const { headline } = headlineFrom({
      comparison: COMPARISON,
      analysis: { trend: { direction: "steady" } } as AnalysisResponse,
      outlook: [],
    });

    expect(headline).toBe("Slightly above the seasonal record, steady through the window.");
    expect(headline).not.toMatch(/\d/);
  });

  it("drops the qualifier once the window is a standard deviation out", () => {
    const { headline } = headlineFrom({
      comparison: {
        ...COMPARISON,
        difference: statistic("temperature_mean", "delta", -3.2),
        z_score: statistic("temperature_mean", "z_score", -2.4, ""),
      } as unknown as BaselineComparison,
      analysis: null,
      outlook: [],
    });

    expect(headline).toBe("Markedly below the seasonal record.");
  });

  it("keeps the backend's exact sentences as the support, never as the headline", () => {
    const { headline, support } = headlineFrom({
      comparison: COMPARISON,
      analysis: { summary: "The mean temperature is 17.2 °C." } as AnalysisResponse,
      outlook: [],
    });

    expect(headline).not.toContain("standard deviations");
    expect(support).toEqual([
      "The mean temperature is 17.2 °C.",
      COMPARISON.characterization,
    ]);
  });

  it("composes nothing at all when the backend classified nothing", () => {
    expect(headlineFrom({ comparison: null, analysis: null, outlook: [] }).headline).toBe(
      "Retrieved and computed for this window",
    );
  });
});

describe("the hero figures", () => {
  it("are three, and the middle one counts rows rather than inventing a node total", () => {
    const figures = heroFiguresFrom({
      forecast: { uncertainty: { horizon: [{ confidence: "high", hours_ahead: 6 }] } } as never,
      comparison: COMPARISON,
      analysis: null,
      groundingRows: 4,
      answer: { grounding: { figures_checked: 9, verified: true } } as AnswerEnvelope,
    });

    expect(figures).toHaveLength(HERO_FIGURE_LIMIT);
    expect(figures.map((figure) => figure.value)).toEqual(["High", "4", "0.67σ"]);
    expect(figures[1]?.note).toBe("9 figures checked");
  });

  it("count the flagged entries beside the window's own distance from the record", () => {
    const figures = heroFiguresFrom({
      forecast: null,
      comparison: COMPARISON,
      analysis: {
        anomalies: {
          method: "m",
          threshold: 3.5,
          unit: "°C",
          anomalies: [{ time_local: "2026-09-11T06:00", deviation: -5.9, deviation_score: 5.4 }],
        },
      } as unknown as AnalysisResponse,
      groundingRows: 4,
      answer: null,
    });

    // The window's distance leads; which entry was worst is the attention card's figure, and one
    // number in two places is the duplication this composition exists to remove.
    expect(figures.at(-1)?.value).toBe("0.67σ");
    expect(figures.at(-1)?.note).toBe("1 entry flagged");
  });

  it("fall back to the flagged entry only where there is no comparison to state", () => {
    const figures = heroFiguresFrom({
      forecast: null,
      comparison: null,
      analysis: {
        anomalies: {
          method: "m",
          threshold: 3.5,
          unit: "°C",
          anomalies: [{ time_local: "2026-09-11T06:00", deviation: -5.9, deviation_score: 5.4 }],
        },
      } as unknown as AnalysisResponse,
      groundingRows: 4,
      answer: null,
    });

    expect(figures.at(-1)?.value).toBe("-5.9 °C");
  });

  it("draw fewer rather than filling a slot the backend did not answer", () => {
    expect(
      heroFiguresFrom({
        forecast: null,
        comparison: null,
        analysis: null,
        groundingRows: 0,
        answer: null,
      }),
    ).toEqual([]);
  });
});

describe("the condition tiles", () => {
  const current = {
    units: { temperature: "°C", dew_point: "°C", uv_index: "", wind_speed: "km/h" },
    values: {
      dew_point: 11.1,
      temperature: 18.44,
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

  it("lead with the artifact's order, carry its glyph, and round the figure", () => {
    const tiles = currentTilesFrom(current);
    expect(tiles.shown.map((tile) => tile.key)).toEqual([
      "temperature",
      "precipitation",
      "relative_humidity",
      "wind_speed",
      "surface_pressure",
      "uv_index",
    ]);
    expect(tiles.shown[0]).toMatchObject({ value: "18.4", unit: "°C", icon: "temperature" });
  });

  it("hand back what the cap dropped rather than losing it", () => {
    const tiles = currentTilesFrom(current);
    expect(tiles.shown).toHaveLength(CURRENT_TILE_LIMIT);
    expect(tiles.rest.map((reading) => reading.key)).toEqual(["cloud_cover", "dew_point"]);
  });
});

describe("the outlook", () => {
  it("accents the leading day and caps the strip at the artifact's week", () => {
    const days = outlookFrom({
      daily: {
        units: { temperature_max: "°C" },
        entries: Array.from({ length: 9 }, (_, index) => ({
          time_local: `2026-09-${10 + index}T00:00:00+02:00`,
          time_utc: String(index),
          values: { temperature_max: 20 },
        })),
      },
    } as never);

    expect(days).toHaveLength(7);
    expect(days[0]?.leading).toBe(true);
    expect(days[1]?.leading).toBe(false);
  });
});

describe("what changed", () => {
  const changes = {
    statement: "Two days moved materially.",
    comparison_available: true,
    changes: [
      { local_date: "d1", measure: "temperature_max", change: 0.1, material: false, unit: "°C", statement: "s1" },
      { local_date: "d2", measure: "temperature_max", change: 1.4, material: true, unit: "°C", statement: "s2" },
      { local_date: "d3", measure: "precipitation_sum", change: -1.1, material: true, unit: "mm", statement: "s3" },
      { local_date: "d4", measure: "wind_speed_max", change: 0.2, material: false, unit: "km/h", statement: "s4" },
      // Never a zero for an absent movement: a null change is not a day that did not move.
      { local_date: "d5", measure: "temperature_max", change: null, material: false, unit: "°C", statement: "s5" },
    ],
  } as unknown as WhatChanged;

  it("names each movement's subject, material ones first, and counts what it hides", () => {
    const changed = changedFrom(changes);
    expect(changed?.notes.map((note) => note.title)).toEqual([
      "Temperature shift",
      "Precipitation shift",
      "Temperature shift",
    ]);
    expect(changed?.notes).toHaveLength(CHANGE_NOTE_LIMIT);
    expect(changed?.notes[1]?.icon).toBe("precipitation");
    expect(changed?.hidden).toBe(1);
  });

  it("reports a first retrieval as a state rather than as agreement", () => {
    const changed = changedFrom({
      statement: "s",
      comparison_available: false,
    } as unknown as WhatChanged);
    expect(changed?.comparable).toBe(false);
    expect(changed?.notes).toEqual([]);
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

  it("are four, read off the responses, with the z-score rounded", () => {
    const stats = chartStatsFrom({ analysis, baseline: BASELINE, comparison: COMPARISON });
    expect(stats).toHaveLength(CHART_STAT_LIMIT);
    expect(stats.map((stat) => stat.value)).toEqual(["24.5 °C", "15.1 °C", "14.7 °C", "+1.6 °C"]);
    // The z-score is the hero's figure, not this row's.
    expect(stats[3]?.delta).toBeUndefined();
  });

  it("shorten to what exists when the archive answered with nothing", () => {
    const stats = chartStatsFrom({ analysis, baseline: null, comparison: null });
    expect(stats.map((stat) => stat.key)).toEqual(["window-maximum", "window-mean"]);
  });
});

describe("the historical card", () => {
  it("carries three figures and the record's own labelling, not the hero's sentence", () => {
    const context = historicalContextFrom({ baseline: BASELINE });

    expect(context?.paragraph).toBe(BASELINE.labelling);
    expect(context?.paragraph).not.toContain("standard deviations");
    expect(context?.figures.map((figure) => figure.value)).toEqual([
      "14.7 °C",
      "17.4 °C",
      "1.8 °C",
    ]);
    expect(context?.coverage).toBeCloseTo(0.3);
    expect(context?.coverageNote).toBe("3 of 10 requested years");
  });

  it("is absent when the archive computed no baseline", () => {
    expect(historicalContextFrom({ baseline: null })).toBeNull();
  });
});

describe("the attention card", () => {
  it("names the furthest entry and rounds every figure on it", () => {
    const attention = anomalyAttentionFrom({
      anomalies: {
        method: "median absolute deviation, threshold 3.5",
        threshold: 3.5000001,
        unit: "°C",
        anomalies: [
          { time_local: "2026-09-11T06:00:00+02:00", deviation: 2.8, deviation_score: 3.9 },
          {
            time_local: "2026-09-12T06:00:00+02:00",
            deviation: -5.9,
            deviation_score: 7.250775664373425,
          },
        ],
      },
    } as unknown as AnalysisResponse);

    expect(attention?.count).toBe(2);
    expect(attention?.threshold).toBe("3.5");
    expect(attention?.strongest).toEqual({
      stamp: "2026-09-12 06:00",
      deviation: "-5.9 °C",
      score: "7.25",
    });
  });

  it("is nothing at all when the window was unremarkable", () => {
    expect(
      anomalyAttentionFrom({ anomalies: { anomalies: [] } } as unknown as AnalysisResponse),
    ).toBeNull();
    expect(anomalyAttentionFrom(null)).toBeNull();
  });
});

describe("the grounding", () => {
  it("names one row per class of figure, the model included once it has written", () => {
    const rows = groundingFrom({
      current: { attribution: { provider: "open-meteo" } } as never,
      forecast: { attribution: { provider: "open-meteo" } } as never,
      baseline: BASELINE,
      analysis: { provider: "open-meteo" } as AnalysisResponse,
      answer: { llm_provider: "openrouter", llm_model: "a-model" } as AnswerEnvelope,
    });

    expect(rows.map((row) => row.role)).toEqual([
      "Conditions now",
      "Forecast",
      "Archive record",
      "Analytics",
      "Synthesis",
    ]);
    expect(rows[3]?.provider).toBe("Weathra");
    expect(rows[4]?.dataClass).toBe("interpretation");
  });

  it("omits a row for a read that reported no attribution", () => {
    expect(
      groundingFrom({
        current: null,
        forecast: null,
        baseline: BASELINE,
        analysis: null,
        answer: null,
      }).map((row) => row.role),
    ).toEqual(["Archive record"]);
  });
});

describe("the status strip", () => {
  it("states the reads that returned and the grounding check that ran", () => {
    expect(
      footerFrom({
        reads: 6,
        returned: 6,
        answer: { grounding: { verified: true, figures_checked: 9 } } as AnswerEnvelope,
      }),
    ).toEqual([
      { key: "retrieval", label: "Retrieval complete", tone: "ok" },
      { key: "grounding", label: "Grounding verified", tone: "ok" },
    ]);
  });

  it("says so when a read did not return, and when the check did not pass", () => {
    const states = footerFrom({
      reads: 6,
      returned: 4,
      answer: { grounding: { verified: false, figures_checked: 9 } } as AnswerEnvelope,
    });
    expect(states[0]).toEqual({
      key: "retrieval",
      label: "4 of 6 reads returned",
      tone: "warning",
    });
    expect(states[1]?.label).toBe("Grounding not verified");
  });

  it("claims no grounding state at all before the synthesis has run", () => {
    expect(footerFrom({ reads: 6, returned: 6, answer: null })).toHaveLength(1);
  });
});

describe("the report reference", () => {
  it("is the stored run, and nothing at all before one exists", () => {
    expect(reportReferenceFrom("run-9b5849dd-1a2b")).toBe("9B5849DD");
    expect(reportReferenceFrom(null)).toBeNull();
  });
});

describe("the window control", () => {
  it("accepts only the four horizons it draws", () => {
    expect(isReportHorizon("7")).toBe(true);
    expect(isReportHorizon("10")).toBe(false);
  });
});
