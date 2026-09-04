/**
 * One backend fixture map, for the surface-wide audits — task 21.8.
 *
 * The per-screen suites each carry their own fixtures, deliberately: a test that asserts what the
 * Dashboard renders should be readable beside the data it renders. The accessibility and
 * responsiveness audit is the opposite case — it asserts a property of *every* screen and needs all
 * of them populated at once, and duplicating seven fixture sets into it would make the audit about
 * its fixtures rather than about the screens.
 *
 * Everything here is synthetic and exists only so each screen has something real-shaped to render.
 * None of it comes from the design artifacts, none is presented anywhere as a measurement, and the
 * application does not import this file.
 */

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
};

const MUNICH = {
  display_name: "Munich",
  latitude: 48.14,
  longitude: 11.58,
  timezone: "Europe/Berlin",
  region: "Bavaria",
  country: "Germany",
  country_code: "DE",
};

export const SPRINGFIELD_IL = {
  display_name: "Springfield",
  latitude: 39.8017,
  longitude: -89.6437,
  timezone: "America/Chicago",
  region: "Illinois",
  country: "United States",
  country_code: "US",
};

export const SPRINGFIELD_MO = {
  ...SPRINGFIELD_IL,
  latitude: 37.2153,
  longitude: -93.2982,
  region: "Missouri",
};

const PERIOD = {
  start_local: "2026-09-04T00:00:00+02:00",
  end_local: "2026-09-07T00:00:00+02:00",
  start_utc: "2026-09-03T22:00:00Z",
  end_utc: "2026-09-06T22:00:00Z",
  timezone: "Europe/Berlin",
};

const RETRIEVED_AT = "2026-09-04T06:15:00Z";

const ATTRIBUTION = {
  data_class: "current",
  from_cache: false,
  location: BERLIN,
  provider: "open-meteo",
  retrieved_at: RETRIEVED_AT,
  units: "metric",
  units_source: "preferences",
};

const UNCERTAINTY = {
  basis: "Confidence decreases with horizon distance, from one provider's output only.",
  provider: "open-meteo",
  reference_time_utc: RETRIEVED_AT,
  spread_available: false,
  horizon: [
    { confidence: "high", hours_ahead: 6, time_utc: RETRIEVED_AT, time_local: "2026-09-04T08:15:00+02:00" },
  ],
};

function statistic(overrides: Record<string, unknown> = {}) {
  return {
    statistic: "mean",
    measure: "temperature",
    value: 17.9,
    unit: "°C",
    method: "arithmetic mean of usable points",
    minimum_points: 1,
    points_used: 24,
    points_excluded: 1,
    status: "computed",
    provenance: {
      location: BERLIN,
      period: PERIOD,
      provider: "open-meteo",
      retrieved_at: RETRIEVED_AT,
      source_data_class: "forecast",
      unit_system: "metric",
    },
    ...overrides,
  };
}

function dailySeries(measures: Record<string, string>) {
  return {
    granularity: "daily",
    units: measures,
    entries: [
      {
        time_utc: "2026-09-03T22:00:00Z",
        time_local: "2026-09-04T00:00:00+02:00",
        values: Object.fromEntries(Object.keys(measures).map((key, index) => [key, 14 + index])),
      },
      {
        time_utc: "2026-09-04T22:00:00Z",
        time_local: "2026-09-05T00:00:00+02:00",
        values: Object.fromEntries(Object.keys(measures).map((key) => [key, null])),
      },
      {
        time_utc: "2026-09-05T22:00:00Z",
        time_local: "2026-09-06T00:00:00+02:00",
        values: Object.fromEntries(Object.keys(measures).map((key, index) => [key, 18 + index])),
      },
    ],
  };
}

const BASELINE = {
  location: BERLIN,
  data_class: "computed_statistic",
  measure: "temperature_mean",
  calendar_period: PERIOD,
  years_requested: 10,
  years_used: [2021, 2022, 2023, 2024],
  provider: "open-meteo",
  unit_system: "metric",
  labelling:
    "A historical statistic computed by Weathra from open-meteo archive observations over 4 year(s).",
  coverage_note: "4 of the 10 requested years were available in the archive.",
  mean: statistic({ measure: "temperature_mean", value: 16.2 }),
  standard_deviation: statistic({ statistic: "standard_deviation", measure: "temperature_mean", value: 1.4 }),
  minimum: statistic({ statistic: "minimum", measure: "temperature_mean", value: 13.1 }),
  maximum: statistic({ statistic: "maximum", measure: "temperature_mean", value: 19.4 }),
};

const EVIDENCE_RECORD = {
  request_id: "req-audit",
  thread_id: "thread-audit",
  question: "How does this week compare with the same week last year?",
  routing_reason: "The question spans a forecast and an archive period.",
  routing_source: "model",
  agents: [
    {
      sequence: 1,
      agent: "supervisor",
      status: "succeeded",
      started_at: RETRIEVED_AT,
      duration_ms: 120,
      reason: "Planned retrieval then deterministic comparison.",
    },
    {
      sequence: 2,
      agent: "forecast",
      status: "succeeded",
      started_at: RETRIEVED_AT,
      duration_ms: 840,
      reason: "Retrieved the window.",
    },
    { sequence: 3, agent: "synthesis", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 900 },
  ],
  tool_calls: [
    {
      sequence: 1,
      tool: "weather_forecast",
      agent: "forecast",
      arguments: { latitude: 52.52, longitude: 13.405, days: 3 },
      started_at: RETRIEVED_AT,
      duration_ms: 840,
    },
  ],
  tool_results: [
    {
      sequence: 1,
      tool: "weather_forecast",
      ok: true,
      data_class: "forecast",
      attribution: { ...ATTRIBUTION, data_class: "forecast", period: PERIOD },
      payload: { daily: [1, 2, 3], units: { temperature: "°C" } },
    },
  ],
  analytics_results: [statistic()],
  anomaly_reports: [],
  trend_reports: [],
  citations: [
    {
      document_id: "forecast-uncertainty.md",
      title: "Why forecast confidence falls with horizon distance",
      topic: "uncertainty",
      chunk_position: 1,
      score: 0.81,
      text: "Forecast skill declines with lead time because small errors in the initial state grow.",
    },
  ],
  attributions: [{ ...ATTRIBUTION, data_class: "forecast", period: PERIOD }],
  data_classes: ["forecast", "computed_statistic", "ai_interpretation"],
  llm_provider: "openrouter",
  llm_model: "a-configured-model",
  started_at: RETRIEVED_AT,
  completed_at: "2026-09-04T06:15:04Z",
  total_duration_ms: 4210,
  steps_used: 3,
  partial: false,
  partial_reason: null,
};

const ANSWER_PROSE =
  "The provider's forecast puts this week's mean at 17.9 °C, which the archive comparison places above the four-year baseline.";

/** Every route the MVP screens read, keyed by pathname. */
export const BACKEND_FIXTURES: Readonly<Record<string, unknown>> = {
  "/api/v1/me": {
    user_id: "00000000-0000-4000-8000-000000000001",
    email: "person@example.test",
    email_verified: true,
    profile_created_at: "2026-08-01T09:00:00Z",
    last_seen_at: RETRIEVED_AT,
    created_now: false,
    preferences: {
      unit_system: "metric",
      forecast_horizon_days: 3,
      default_location: BERLIN,
      sources: { unit_system: "chosen", forecast_horizon_days: "default", default_location: "chosen" },
    },
  },

  "/api/v1/me/preferences": {
    unit_system: "metric",
    forecast_horizon_days: 3,
    default_location: BERLIN,
    sources: { unit_system: "chosen", forecast_horizon_days: "default", default_location: "chosen" },
  },

  "/api/v1/me/locations": {
    count: 2,
    limit: 20,
    locations: [
      { id: "s-berlin", location: BERLIN, label: null },
      { id: "s-munich", location: MUNICH, label: "Office" },
    ],
  },

  "/api/v1/threads": {
    count: 1,
    threads: [
      {
        id: "t-1",
        title: "Berlin this week",
        created_at: "2026-09-03T09:00:00Z",
        last_activity_at: "2026-09-04T08:40:00Z",
        expires_at: "2026-09-11T08:40:00Z",
        locations: ["Berlin, Berlin, DE"],
      },
    ],
  },

  /** Ambiguous on purpose: the candidate chooser is one of the surfaces under audit. */
  "/api/v1/locations/resolve": {
    kind: "ambiguous",
    query: "Springfield",
    candidates: [SPRINGFIELD_IL, SPRINGFIELD_MO],
    message:
      "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US. Weathra does not pick one for you.",
  },

  "/api/v1/weather/current": {
    attribution: ATTRIBUTION,
    observed_at_utc: RETRIEVED_AT,
    observed_at_local: "2026-09-04T08:15:00+02:00",
    units: { temperature: "°C", relative_humidity: "%", precipitation: "mm" },
    values: { temperature: 18.2, relative_humidity: 72, precipitation: null },
  },

  "/api/v1/weather/forecast": {
    attribution: { ...ATTRIBUTION, data_class: "forecast" },
    horizon_days: 3,
    period: PERIOD,
    hourly: { granularity: "hourly", units: {}, entries: [] },
    daily: dailySeries({ temperature_max: "°C", temperature_min: "°C" }),
    uncertainty: UNCERTAINTY,
  },

  "/api/v1/weather/analysis": {
    data_class: "computed_statistic",
    findings: [statistic()],
    from_cache: false,
    horizon_days: 3,
    location: BERLIN,
    period: PERIOD,
    provider: "open-meteo",
    summary: "Across the window the mean temperature is 17.9 °C.",
    units: "metric",
    uncertainty: UNCERTAINTY,
    anomalies: {
      measure: "temperature",
      method: "median absolute deviation, threshold 3.5",
      median: 17.4,
      median_absolute_deviation: 1.1,
      threshold: 3.5,
      unit: "°C",
      points_used: 24,
      points_excluded: 0,
      anomalies: [],
      minimum: statistic({ statistic: "minimum", value: 12.4 }),
      maximum: statistic({ statistic: "maximum", value: 21.4 }),
      provenance: statistic().provenance,
    },
    trend: {
      measure: "temperature",
      direction: "rising",
      method: "least-squares slope over the window",
      slope_per_day: 0.6,
      magnitude: 1.8,
      unit: "°C",
      minimum_points: 3,
      points_used: 24,
      points_excluded: 0,
      insignificance_margin_per_day: 0.1,
      provenance: statistic().provenance,
    },
  },

  "/api/v1/weather/changes": {
    location: BERLIN,
    provider: "open-meteo",
    units: "metric",
    data_class: "forecast",
    window: PERIOD,
    previous_retrieved_at: "2026-09-03T06:15:00Z",
    current_retrieved_at: RETRIEVED_AT,
    has_previous: true,
    note: null,
    changes: [
      {
        measure: "temperature_max",
        unit: "°C",
        previous: 20.1,
        current: 21.4,
        delta: 1.3,
        material: true,
        threshold: 1,
        time_local: "2026-09-04T00:00:00+02:00",
        time_utc: "2026-09-03T22:00:00Z",
      },
    ],
  },

  "/api/v1/weather/history": {
    location: BERLIN,
    provider: "open-meteo",
    units: "metric",
    data_class: "historical_observation",
    requested_period: PERIOD,
    covered_period: PERIOD,
    retrieved_at: RETRIEVED_AT,
    partial: false,
    unavailable_note: null,
    daily: dailySeries({ temperature_mean: "°C", precipitation_sum: "mm" }),
    hourly: null,
  },

  "/api/v1/weather/history/comparison": {
    location: BERLIN,
    data_class: "historical_observation",
    earlier_period: PERIOD,
    later_period: PERIOD,
    provider: "open-meteo",
    unit_system: "metric",
    statistics_applied: ["temperature_mean: mean"],
    earlier: [statistic({ measure: "temperature_mean", value: 15.1 })],
    later: [statistic({ measure: "temperature_mean", value: 17.9 })],
    deltas: [statistic({ statistic: "delta", measure: "temperature_mean", value: 2.8, method: "later minus earlier" })],
    percentage_changes: { temperature_mean: 18.5 },
    lengths_differ: false,
    basis: "Both periods: open-meteo archive observations, metric units, the same statistics.",
  },

  "/api/v1/weather/history/baseline": BASELINE,

  "/api/v1/weather/history/baseline/comparison": {
    location: BERLIN,
    measure: "temperature_mean",
    observed_or_forecast_value: 17.9,
    observed_data_class: "historical_observation",
    characterization: "Warmer than the 4-year baseline for this calendar period.",
    forecast_side_caveat: null,
    difference: statistic({
      statistic: "delta",
      measure: "temperature_mean",
      value: 1.7,
      method: "the value being compared minus the 4-year baseline",
    }),
    z_score: statistic({
      statistic: "z_score",
      measure: "temperature_mean",
      value: 1.21,
      unit: "",
      method: "value minus reference mean, divided by the reference standard deviation",
    }),
    baseline: BASELINE,
  },

  "/api/v1/weather/comparison": {
    criterion: "warmest",
    mode: "locations",
    data_class: "forecast",
    provider: "open-meteo",
    unit_system: "metric",
    period: PERIOD,
    retrieved_at: RETRIEVED_AT,
    basis: "Every place measured over the same window in its own local time.",
    weights: {},
    candidates: [
      {
        label: "Berlin, Germany",
        location: BERLIN,
        period: PERIOD,
        rank: 1,
        score: 18.4,
        supporting: [statistic({ value: 18.4 })],
      },
      {
        label: "Munich, Germany",
        location: MUNICH,
        period: PERIOD,
        rank: 2,
        score: 16.1,
        supporting: [statistic({ value: 16.1 })],
      },
    ],
    excluded: [
      {
        label: "Nowhere",
        location: null,
        code: "location_not_found",
        reason: "No location matches that name.",
      },
    ],
  },

  "/api/v1/evidence/run-audit": {
    id: "run-audit",
    request_id: "req-audit",
    thread_id: "thread-audit",
    question: EVIDENCE_RECORD.question,
    answer_prose: ANSWER_PROSE,
    envelope: {
      request_id: "req-audit",
      answer_prose: ANSWER_PROSE,
      prose_data_class: "ai_interpretation",
      findings: [],
      attribution: [{ ...ATTRIBUTION, data_class: "forecast", period: PERIOD }],
      resolved: {
        locations: [BERLIN],
        period: PERIOD,
        unit_system: "metric",
        location_source: "preferences",
        units_source: "preferences",
        statement: "Berlin, Germany, for this week, from your saved default location.",
      },
      grounding: {
        verified: true,
        method: "figures extracted from the prose and matched within 0.05",
        figures_checked: 1,
        ungrounded_figures: [],
        prose_discarded: false,
      },
      uncertainty: UNCERTAINTY,
      unanswered_parts: [],
    },
    evidence: EVIDENCE_RECORD,
    llm_provider: "openrouter",
    llm_model: "a-configured-model",
    weather_provider: "open-meteo",
    duration_ms: 4210,
    partial: false,
    created_at: "2026-09-04T06:15:05Z",
  },
};

/** The fixture for a path, or undefined when this map does not model it. */
export function fixtureFor(pathname: string): unknown {
  return BACKEND_FIXTURES[pathname];
}
