/**
 * A stand-in for Weathra's own FastAPI backend, for the browser-level session verification of
 * task 18.10.
 *
 * The remaining half of 18.10 is a sentence about two systems disagreeing: *"a 401 from the API
 * produces the expired-session state rather than a data error"*. That needs a session Supabase
 * still recognises — so the middleware and the server-resolved layout let the protected screen
 * render — while Weathra's API refuses the bearer token the browser presents. No amount of driving
 * the Supabase stub produces that: expiring the session there makes the *middleware* redirect,
 * which is a different mechanism and is already covered.
 *
 * So the backend is stood in for as well, over HTTP, at the origin the built frontend was told to
 * call. Everything on the browser's side of that boundary is the real thing: the real production
 * build, the real `@supabase/ssr` cookie session, the real Dashboard, the real typed API client,
 * the real 401 interceptor and the real session boundary. What this replaces is only the process on
 * the far side of `NEXT_PUBLIC_API_BASE_URL` — which is the same substitution
 * `tests/e2e/supabase-stub.mjs` makes for the identity provider, and for the same reason: no
 * network, no credential, no shared live state between runs.
 *
 * Two control routes drive it:
 *
 *   POST /control/revoke    every /api/v1 call answers 401 in Weathra's error envelope
 *   POST /control/restore   back to serving, and the request log is cleared
 *
 * plus `GET /control/requests`, which is how a spec proves that a *real* authenticated request
 * actually crossed this boundary rather than the screen having failed for some other reason.
 *
 * **About the figures below.** They are a fixture, deliberately synthetic, and they exist only so
 * the Dashboard has something to render before the session is revoked — the same role the fixtures
 * in `components/dashboard/dashboard.test.tsx` play. None of them comes from the design artifact,
 * none is presented anywhere as a measurement, and nothing in the application imports this file.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.WEATHRA_API_STUB_PORT ?? 54322);

/**
 * Loopback by default. The manual pass of task 21.8 needs the app reachable from a physical
 * handset, and a stub bound to 127.0.0.1 is not — so `WEATHRA_STUB_HOST=0.0.0.0` opens it to the
 * local network for that one purpose. It stays loopback everywhere else, including in Playwright,
 * because nothing here checks a credential and it should not be reachable by default.
 */
const HOST = process.env.WEATHRA_STUB_HOST ?? "127.0.0.1";

/** Flipped by `/control/revoke`: the backend stops accepting the token the browser presents. */
let serving = true;

/**
 * Which of the runtime states the backend is standing in for — `POST /control/mode?value=…`.
 *
 * The runtime fidelity audit of 2026-09-08 produced these four by hand, with a throwaway harness,
 * and its own §2 records what that cost: a fixture that answered `me/locations` with `{saved: []}`
 * where the contract says `{locations: []}` crashed all seven signed-in screens, and the finding
 * looked exactly like a product defect until somebody noticed the seven screenshots were
 * byte-identical. Driving the states from *this* stub — the one whose shapes the rest of the suite
 * already holds to the contract — is what stops that from being rediscovered, and is what lets the
 * sweep run on every push rather than on the day somebody remembers to look.
 *
 *   populated  the fixtures, which is every other spec's world
 *   empty      a new account: no saved location, no default, no threads, no evidence
 *   failing    every call answered 503 in Weathra's own error envelope
 *   stalling   every call held open, so a screen is photographed mid-flight
 */
let mode = "populated";

const MODES = new Set(["populated", "empty", "failing", "stalling"]);

/** Every `/api/v1` call this boundary has seen, so a spec can assert one genuinely arrived. */
let seen = [];

/*
 * `display_name` is the bare settlement name, as the geocoder returns it.
 *
 * It was "Berlin, Germany" until the runtime fidelity audit of 2026-09-08, where the already-qualified
 * name made every card that composes display name + region + country read "Berlin, Germany, Berlin,
 * DE" — a fixture artefact that looked exactly like a product defect. A stand-in that misreports the
 * shape of the thing it stands in for costs more than it saves.
 */
const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  country: "Germany",
  country_code: "DE",
  region: "Berlin",
};

const PERIOD = {
  start_local: "2026-09-04T00:00:00+02:00",
  end_local: "2026-09-06T00:00:00+02:00",
  start_utc: "2026-09-03T22:00:00Z",
  end_utc: "2026-09-05T22:00:00Z",
  timezone: "Europe/Berlin",
};

const RETRIEVED_AT = "2026-09-04T06:15:00Z";

const ATTRIBUTION = {
  location: BERLIN,
  provider: "stub-provider",
  units: "metric",
  retrieved_at: RETRIEVED_AT,
  from_cache: false,
  data_class: "forecast",
  units_source: "preferences",
};

const PROVENANCE = {
  location: BERLIN,
  period: PERIOD,
  provider: "stub-provider",
  unit_system: "metric",
  source_data_class: "forecast",
  retrieved_at: RETRIEVED_AT,
};

const UNCERTAINTY = {
  basis:
    "Confidence decreases with horizon distance, from one provider's output and its supplied spread only.",
  provider: "stub-provider",
  reference_time_utc: RETRIEVED_AT,
  spread_available: false,
  multi_provider_consensus: false,
  /*
   * Three bands rather than one.
   *
   * `UncertaintyStatement.horizon` is confidence *by distance*, and a single entry cannot show
   * that: the report's confidence scale and the Dashboard's indicator both photographed as one
   * chip. Three is what the statement is for — the same band close in, and the decline the basis
   * sentence describes.
   */
  horizon: [
    {
      confidence: "high",
      hours_ahead: 6,
      time_utc: "2026-09-04T12:00:00Z",
      time_local: "2026-09-04T14:00:00+02:00",
    },
    {
      confidence: "moderate",
      hours_ahead: 72,
      time_utc: "2026-09-07T06:00:00Z",
      time_local: "2026-09-07T08:00:00+02:00",
    },
    {
      confidence: "low",
      hours_ahead: 144,
      time_utc: "2026-09-10T06:00:00Z",
      time_local: "2026-09-10T08:00:00+02:00",
    },
  ],
};

function statistic(name, measure, value, unit, method) {
  return {
    statistic: name,
    measure,
    value,
    unit,
    method,
    minimum_points: 1,
    points_used: 48,
    points_excluded: 0,
    status: "computed",
    data_class: "computed_statistic",
    provenance: PROVENANCE,
  };
}

/**
 * One day in a day-level ranking, shaped as `compare_days` returns it.
 *
 * The label is the ISO date, because that is what the service sends: a label in a ranking is an
 * identifier, and the screen is responsible for speaking it. Keeping that here is deliberate — a
 * fixture that handed the screen a pre-formatted "Fri 04 Sep" would hide exactly the bug that put
 * a raw timestamp in front of a customer.
 */
function dayCandidate(date, rank, score, { temperature, rain, wind }, tied) {
  const period = {
    start_local: `${date}T00:00:00+02:00`,
    end_local: `${date}T23:59:59+02:00`,
    start_utc: `${date}T22:00:00Z`,
    end_utc: `${date}T21:59:59Z`,
    timezone: "Europe/Berlin",
  };
  const supporting = [
    statistic("mean", "temperature_mean", temperature, "°C", "arithmetic mean of usable points"),
    statistic("total", "precipitation_sum", rain, "mm", "sum of usable points"),
    statistic("mean", "wind_speed_max", wind, "km/h", "arithmetic mean of usable points"),
  ];
  return {
    label: date,
    location: BERLIN,
    period,
    rank,
    score,
    tied,
    // The weighted parts of the score, summing to it, as `score_candidate` reports them.
    contributions: [
      { measure: "temperature_mean", value: temperature, unit: "°C", direction: "above", weight: 0.5, contribution: Math.round(score * 0.54 * 1000) / 1000, supporting: supporting[0] },
      { measure: "precipitation_sum", value: rain, unit: "mm", direction: "below", weight: 0.3, contribution: Math.round(score * 0.31 * 1000) / 1000, supporting: supporting[1] },
      { measure: "wind_speed_max", value: wind, unit: "km/h", direction: "below", weight: 0.2, contribution: Math.round(score * 0.15 * 1000) / 1000, supporting: supporting[2] },
    ],
    supporting,
  };
}

const BARCELONA = {
  display_name: "Barcelona",
  latitude: 41.3874,
  longitude: 2.1686,
  timezone: "Europe/Madrid",
  country: "Spain",
  country_code: "ES",
  region: "Catalonia",
};

/** One day of a trip, shaped as `DailyOutlookEntry` declares it. */
function travelDay(date, weekday, code, high, low, rain, chance, uv, viability, rank) {
  return {
    local_date: date,
    weekday,
    condition_code: code,
    temperature_max: high,
    temperature_min: low,
    apparent_temperature_max: high + 1.2,
    precipitation_sum: rain,
    precipitation_probability_max: chance,
    wind_speed_max: 17.2,
    wind_gust_max: 31.4,
    uv_index_max: uv,
    viability,
    rank,
    units: {
      temperature_max: "\u00b0C",
      temperature_min: "\u00b0C",
      precipitation_sum: "mm",
      precipitation_probability_max: "%",
      wind_speed_max: "km/h",
      uv_index_max: "index",
    },
  };
}

const MUNICH = {
  display_name: "Munich",
  latitude: 48.14,
  longitude: 11.58,
  timezone: "Europe/Berlin",
  country: "Germany",
  country_code: "DE",
  region: "Bavaria",
};

/** Two places of the same name, so the candidate chooser can be audited in a browser. */
const SPRINGFIELD_IL = {
  display_name: "Springfield",
  latitude: 39.8017,
  longitude: -89.6437,
  timezone: "America/Chicago",
  region: "Illinois",
  country: "United States",
  country_code: "US",
};

const SPRINGFIELD_MO = { ...SPRINGFIELD_IL, latitude: 37.2153, longitude: -93.2982, region: "Missouri" };

/*
 * A true hourly series, generated so it reconciles with the daily entries below.
 *
 * It used to be six points a day at six-hour spacing, described as "a real hourly series". It was
 * not one: `forecast_berlin_metric_7d.json` — the recorded response from the provider Weathra
 * actually reads — carries 168 entries, one an hour, and every consumer of this stub was therefore
 * drawn against a shape no provider returns. Two visible defects came from it and neither was the
 * screen's: the Dashboard's intra-day chart photographed as a six-point zigzag rather than a
 * curve, and the hero's UV slot was always absent, because UV is read from the hour the
 * observation belongs to (08:00) and the series jumped from 06:00 to 12:00.
 *
 * Each day's curve is built from that day's own daily entry — minimum before dawn, maximum
 * mid-afternoon, the precipitation total distributed across the hours that carry the day's
 * dominant code — so a figure read off the hourly chart and the same figure on the day card agree.
 * `precipitation_probability` is included because the provider reports it hourly and the
 * Dashboard's risk panel is drawn from it.
 *
 * The one deliberate gap survives: 5 September at midnight reports no temperature and no wind, so
 * the missing-point behaviour stays visible in every capture.
 */
const HOURLY_DAYS = [
  { date: "2026-09-04", min: 10.4, max: 19.6, precipitation: 1.6, code: 61, uvPeak: 4.6 },
  { date: "2026-09-05", min: 11.2, max: 20.8, precipitation: 2.1, code: 63, uvPeak: 4.2 },
  { date: "2026-09-06", min: 13.1, max: 24.5, precipitation: 0, code: 0, uvPeak: 6.1 },
  { date: "2026-09-07", min: 12.4, max: 22.8, precipitation: 0.2, code: 61, uvPeak: 5.4 },
  { date: "2026-09-08", min: 11.8, max: 19.1, precipitation: 3.4, code: 63, uvPeak: 3.5 },
  { date: "2026-09-09", min: 9.7, max: 16.5, precipitation: 5.2, code: 80, uvPeak: 2.4 },
];

/** Two decimal places, so the fixture reads like a provider's response rather than like floats. */
function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The share of a day's rain that falls in each hour — weighted to the afternoon, as the codes imply. */
function rainWeight(hour) {
  if (hour < 9 || hour > 21) return 0.1;
  return 1 + Math.sin((Math.PI * (hour - 9)) / 12) * 2.2;
}

function hourlySeries() {
  const entries = [];
  for (const day of HOURLY_DAYS) {
    const weights = Array.from({ length: 24 }, (_, hour) => rainWeight(hour));
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    const hourTotals = [];
    const dayStart = entries.length;

    for (let hour = 0; hour < 24; hour += 1) {
      // Coldest around 03:00, warmest around 15:00 — the diurnal shape, not a straight line.
      const phase = (((hour - 3) % 24) + 24) % 24 / 24;
      const warmth = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
      const temperature = day.min + (day.max - day.min) * warmth;

      const precipitation = day.precipitation === 0
        ? 0
        : round((day.precipitation * weights[hour]) / weightTotal, 2);
      // Two-decimal rounding loses a few hundredths across 24 hours; the residual is returned to
      // the wettest hour so the hourly series and the day card state the same total.
      hourTotals.push(precipitation);
      // A chance of rain, not a restatement of the total: high where the rain falls, never zero on
      // a day the provider gave a dominant rain code, and low but real on the clear day.
      const chance = day.precipitation === 0
        ? Math.round(4 + warmth * 8)
        : Math.min(96, Math.round(18 + (weights[hour] / Math.max(...weights)) * 72));

      // Daylight only, peaking at solar noon. Zero at night is a reported zero, not a gap.
      const daylight = hour >= 6 && hour <= 19
        ? Math.max(0, Math.sin((Math.PI * (hour - 6)) / 13))
        : 0;

      const gap = day.date === "2026-09-05" && hour === 0;
      const local = `${day.date}T${String(hour).padStart(2, "0")}:00:00+02:00`;
      const utc = new Date(Date.parse(local)).toISOString().replace(".000Z", "Z");

      entries.push({
        time_local: local,
        time_utc: utc,
        values: {
          uv_index: round(day.uvPeak * daylight, 1),
          weather_code: precipitation > 0.05 ? day.code : day.code === 0 ? 0 : 3,
          temperature: gap ? null : round(temperature, 1),
          precipitation,
          precipitation_probability: chance,
          relative_humidity: Math.round(88 - warmth * 30),
          wind_speed: gap ? null : round(22 + warmth * 14 + (day.precipitation > 2 ? 9 : 0), 1),
        },
      });
    }

    if (day.precipitation > 0) {
      const wettest = hourTotals.indexOf(Math.max(...hourTotals));
      const drift = round(day.precipitation - hourTotals.reduce((sum, value) => sum + value, 0), 2);
      entries[dayStart + wettest].values.precipitation = round(hourTotals[wettest] + drift, 2);
    }
  }
  return {
    granularity: "hourly",
    units: {
      // Empty, because that is what the provider sends for it: a UV index is a dimensionless
      // number and `hourly_units.uv_index` in `forecast_berlin_metric_7d.json` is "".
      uv_index: "",
      temperature: "°C",
      precipitation: "mm",
      precipitation_probability: "%",
      relative_humidity: "%",
      wind_speed: "km/h",
    },
    entries,
  };
}

function dailySeries(units) {
  const keys = Object.keys(units);
  return {
    granularity: "daily",
    units,
    entries: [
      {
        time_utc: "2026-09-03T22:00:00Z",
        time_local: "2026-09-04T00:00:00+02:00",
        values: Object.fromEntries(keys.map((key, index) => [key, 14 + index])),
      },
      {
        time_utc: "2026-09-04T22:00:00Z",
        time_local: "2026-09-05T00:00:00+02:00",
        values: Object.fromEntries(keys.map((key) => [key, null])),
      },
      {
        time_utc: "2026-09-05T22:00:00Z",
        time_local: "2026-09-06T00:00:00+02:00",
        values: Object.fromEntries(keys.map((key, index) => [key, 18 + index])),
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
  provider: "stub-provider",
  unit_system: "metric",
  labelling:
    "A historical statistic computed by Weathra from archive observations over 4 year(s). It is not an official climate normal.",
  coverage_note: "4 of the 10 requested years were available in the archive.",
  mean: statistic("mean", "temperature_mean", 16.2, "°C", "arithmetic mean of usable points"),
  standard_deviation: statistic("standard_deviation", "temperature_mean", 1.4, "°C", "population standard deviation"),
  minimum: statistic("minimum", "temperature_mean", 13.1, "°C", "minimum of usable points"),
  maximum: statistic("maximum", "temperature_mean", 19.4, "°C", "maximum of usable points"),
  /*
   * Each reference year's own mean for this window — the distribution a percentile rank is taken
   * against, and what the anomaly panel's number line is drawn from. Chosen to average to the
   * 16.2 stated above rather than to plausible-looking numbers, because a fixture whose parts do
   * not reconcile is a capture that proves the layout and hides the arithmetic.
   */
  yearly_means: [
    { year: 2021, value: 14.8, points_used: 3 },
    { year: 2022, value: 15.6, points_used: 3 },
    { year: 2023, value: 16.9, points_used: 3 },
    { year: 2024, value: 17.5, points_used: 3 },
  ],
};

const EVIDENCE_RECORD = {
  request_id: "req-stub",
  thread_id: "thread-stub",
  question: "How does this week compare with the same week last year?",
  routing_reason: "The question spans a forecast and an archive period.",
  routing_source: "model",
  /*
   * The whole graph, not a third of it.
   *
   * Three agents and one tool call left `05-agent-evidence.png`'s execution column — the screen's
   * subject — about a third the height of the record beside it. A question spanning a forecast and
   * an archive period routes to every retrieval agent the supervisor has, and this is what that
   * run records: the six members of `AgentName`, one of them skipped with the supervisor's reason
   * for skipping it, so a status that is neither success nor failure is in the capture too.
   */
  agents: [
    { sequence: 1, agent: "supervisor", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 120, reason: "Planned retrieval then comparison." },
    { sequence: 2, agent: "forecast", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 840, reason: "Retrieved the window." },
    { sequence: 3, agent: "historical", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 620, reason: "Loaded the same calendar week from the archive." },
    { sequence: 4, agent: "analytics", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 310, reason: "Computed the mean and the difference from the baseline." },
    /*
     * Succeeded, because this record carries a citation.
     *
     * It was `skipped` with a reason saying no context was needed, beside a `citations` list
     * holding the passage the knowledge agent retrieved — a record contradicting itself. The
     * Analyst's rail reads both (the agent's outcome in Agent status, the passage in Active data
     * sources), so the contradiction was photographable: a source listed as used beside the agent
     * that uses it marked as never run.
     */
    { sequence: 5, agent: "rag", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 140, reason: "Retrieved the passage on how forecast confidence falls with horizon distance." },
    { sequence: 6, agent: "synthesis", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 900 },
  ],
  tool_calls: [
    {
      sequence: 1,
      tool: "weather_forecast",
      agent: "forecast",
      arguments: { latitude: 52.52, longitude: 13.405, days: 7 },
      started_at: RETRIEVED_AT,
      duration_ms: 840,
    },
    {
      sequence: 2,
      tool: "weather_history",
      agent: "historical",
      arguments: { latitude: 52.52, longitude: 13.405, start: "2025-09-04", end: "2025-09-06" },
      started_at: RETRIEVED_AT,
      duration_ms: 620,
    },
    {
      sequence: 3,
      tool: "weather_baseline_comparison",
      agent: "analytics",
      arguments: { latitude: 52.52, longitude: 13.405, measure: "temperature_mean", years: 10 },
      started_at: RETRIEVED_AT,
      duration_ms: 310,
    },
  ],
  tool_results: [
    {
      sequence: 1,
      tool: "weather_forecast",
      ok: true,
      data_class: "forecast",
      attribution: { ...ATTRIBUTION, period: PERIOD },
      payload: { daily: 7, hourly: 24, units: { temperature: "°C" } },
    },
    {
      sequence: 2,
      tool: "weather_history",
      ok: true,
      data_class: "historical_observation",
      attribution: { ...ATTRIBUTION, data_class: "historical_observation", period: PERIOD },
      payload: { daily: 3, units: { temperature_mean: "°C" } },
    },
    {
      sequence: 3,
      tool: "weather_baseline_comparison",
      ok: true,
      data_class: "computed_statistic",
      attribution: { ...ATTRIBUTION, data_class: "computed_statistic", period: PERIOD },
      payload: { difference: 1.7, z_score: 1.21, years_used: 4 },
    },
  ],
  analytics_results: [
    statistic("mean", "temperature", 17.9, "°C", "arithmetic mean of usable points"),
    statistic("delta", "temperature_mean", 1.7, "°C", "the value being compared minus the baseline"),
    statistic("z_score", "temperature_mean", 1.21, "", "value minus reference mean, divided by the reference standard deviation"),
  ],
  anomaly_reports: [],
  trend_reports: [
    {
      measure: "temperature",
      direction: "rising",
      magnitude: 1.2,
      slope_per_day: 0.4,
      unit: "°C",
      method: "least-squares slope",
      minimum_points: 3,
      insignificance_margin_per_day: 0.1,
      points_used: 48,
      points_excluded: 0,
      provenance: PROVENANCE,
    },
  ],
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
  attributions: [
    { ...ATTRIBUTION, period: PERIOD },
    { ...ATTRIBUTION, data_class: "historical_observation", period: PERIOD },
    { ...ATTRIBUTION, data_class: "computed_statistic", period: PERIOD },
  ],
  data_classes: ["forecast", "historical_observation", "computed_statistic", "ai_interpretation"],
  llm_provider: "stub-gateway",
  llm_model: "stub-model",
  started_at: RETRIEVED_AT,
  completed_at: "2026-09-04T06:15:04Z",
  total_duration_ms: 4210,
  steps_used: 6,
  partial: false,
  partial_reason: null,
};

/**
 * What the MVP screens ask for, and what this answers with while the session is being honoured.
 *
 * Only the paths the screens actually call. Anything else is a 404 in Weathra's envelope rather
 * than a guess, so a screen reaching for something this stub does not model fails visibly.
 *
 * Task 21.8 widened this from the Dashboard's routes to every MVP screen's, because the
 * accessibility and responsiveness audit visits all of them in a browser and a screen stuck in its
 * error state is not the screen the audit is about.
 */
const FIXTURES = {
  "/api/v1/me/preferences": {
    unit_system: "metric",
    /*
     * Seven, which is the horizon `01-dashboard.png` and `12-weather-intelligence-report.png` are
     * drawn at. At three, the Dashboard's seven-day strip photographed as two figures and five
     * cards reading "Not forecast", and the report's outlook as two day cards — a picture of this
     * fixture's shape rather than of the screen. The screens' own thin-data behaviour is not lost
     * with it: `dashboard.test.tsx` and `report.test.tsx` both hold a window shorter than the
     * horizon, and the entry below that reports nothing still does.
     */
    forecast_horizon_days: 7,
    default_location: BERLIN,
    sources: { unit_system: "chosen", default_location: "chosen", forecast_horizon_days: "chosen" },
  },

  /*
   * The measures a current reading actually carries.
   *
   * It reported two, and every screen that lays out a metric grid — the Dashboard's readout, the
   * report's observed column — was photographed with two tiles where the artifacts draw six. That
   * made the capture evidence about this file rather than about the layout. The set below is the
   * one the provider supplies for a point; `uv_index` is deliberately absent, so a measure the
   * provider did not report is still part of the picture.
   */
  "/api/v1/weather/current": {
    attribution: { ...ATTRIBUTION, data_class: "current" },
    observed_at_utc: RETRIEVED_AT,
    observed_at_local: "2026-09-04T08:15:00+02:00",
    units: {
      temperature: "°C",
      apparent_temperature: "°C",
      relative_humidity: "%",
      precipitation: "mm",
      wind_speed: "km/h",
      surface_pressure: "hPa",
    },
    values: {
      weather_code: 61,
      temperature: 15.3,
      apparent_temperature: 14.1,
      relative_humidity: 68,
      precipitation: 0.4,
      wind_speed: 14.2,
      surface_pressure: 1012,
    },
  },

  /*
   * The scenario, so the Scenario Lab can be photographed with a result rather than with a stub
   * error. Both series carry the same instants and the same units — that is the contract — and the
   * scenario one is the baseline with the assumptions applied, exactly as `analytics/scenario.py`
   * would produce them. Everything here is labelled simulated, which is what the screen requires.
   */
  "/api/v1/weather/scenario": {
    simulated: true,
    disclaimer:
      "A hypothetical: your assumptions applied to a real forecast by arithmetic. It is not a forecast of what will happen, and no model was consulted.",
    attribution: ATTRIBUTION,
    period: PERIOD,
    horizon_days: 3,
    assumptions: {
      temperature_offset: 2.5,
      precipitation_scale: 1.15,
      relative_humidity_offset: null,
      wind_speed_offset: null,
    },
    baseline: {
      granularity: "hourly",
      units: { temperature: "°C", precipitation: "mm" },
      entries: [
        { time_local: "2026-09-04T06:00:00+02:00", time_utc: "2026-09-04T04:00:00Z", values: { uv_index: 1, weather_code: 0, temperature: 12.4, precipitation: 0 } },
        { time_local: "2026-09-04T12:00:00+02:00", time_utc: "2026-09-04T10:00:00Z", values: { uv_index: 5, weather_code: 61, temperature: 17.8, precipitation: 0.4 } },
        { time_local: "2026-09-04T18:00:00+02:00", time_utc: "2026-09-04T16:00:00Z", values: { uv_index: 2, weather_code: 61, temperature: 16.1, precipitation: 1.2 } },
        { time_local: "2026-09-05T06:00:00+02:00", time_utc: "2026-09-05T04:00:00Z", values: { uv_index: 1, weather_code: 0, temperature: 11.9, precipitation: 0 } },
        { time_local: "2026-09-05T12:00:00+02:00", time_utc: "2026-09-05T10:00:00Z", values: { uv_index: 5, weather_code: 0, temperature: 18.6, precipitation: 0 } },
        { time_local: "2026-09-05T18:00:00+02:00", time_utc: "2026-09-05T16:00:00Z", values: { uv_index: 2, weather_code: 63, temperature: 15.4, precipitation: 2.1 } },
      ],
    },
    scenario: {
      granularity: "hourly",
      units: { temperature: "°C", precipitation: "mm" },
      entries: [
        { time_local: "2026-09-04T06:00:00+02:00", time_utc: "2026-09-04T04:00:00Z", values: { uv_index: 1, weather_code: 0, temperature: 14.9, precipitation: 0 } },
        { time_local: "2026-09-04T12:00:00+02:00", time_utc: "2026-09-04T10:00:00Z", values: { uv_index: 5, weather_code: 61, temperature: 20.3, precipitation: 0.46 } },
        { time_local: "2026-09-04T18:00:00+02:00", time_utc: "2026-09-04T16:00:00Z", values: { uv_index: 2, weather_code: 61, temperature: 18.6, precipitation: 1.38 } },
        { time_local: "2026-09-05T06:00:00+02:00", time_utc: "2026-09-05T04:00:00Z", values: { uv_index: 1, weather_code: 0, temperature: 14.4, precipitation: 0 } },
        { time_local: "2026-09-05T12:00:00+02:00", time_utc: "2026-09-05T10:00:00Z", values: { uv_index: 5, weather_code: 0, temperature: 21.1, precipitation: 0 } },
        { time_local: "2026-09-05T18:00:00+02:00", time_utc: "2026-09-05T16:00:00Z", values: { uv_index: 2, weather_code: 63, temperature: 17.9, precipitation: 2.42 } },
      ],
    },
    measures: [
      {
        measure: "temperature",
        assumption: 2.5,
        method: "Each reported hour plus 2.5 °C.",
        baseline_mean: 15.4,
        scenario_mean: 17.9,
        difference: 2.5,
        unit: "°C",
        points_used: 6,
        points_excluded: 0,
        clipped: 0,
      },
      {
        measure: "precipitation",
        assumption: 1.15,
        method: "Each reported hour scaled by 1.15, floored at zero.",
        baseline_mean: 0.62,
        scenario_mean: 0.71,
        difference: 0.09,
        unit: "mm",
        points_used: 6,
        points_excluded: 0,
        clipped: 0,
      },
    ],
  },

  "/api/v1/weather/forecast": {
    attribution: ATTRIBUTION,
    period: PERIOD,
    // Seven, agreeing with the seven daily entries below and with the preference above. At three
    // the report's header read "3 DAYS" over a strip of seven day cards.
    horizon_days: 7,
    /*
     * A real hourly series, because an empty one is not a neutral fixture.
     *
     * Three screens draw their main chart from this — the Dashboard's climate pulse and
     * precipitation outlook, and Forecast Explorer's window and hour-by-hour matrix — and with no
     * entries all four photographed as empty frames. The frames were correct and the pictures were
     * evidence of nothing. Six days at six-hour resolution — the window the horizon actually covers,
     * so the report's timeline is a week rather than a corner of one — with one hour reporting no
     * temperature so the gap behaviour stays visible in every capture.
     */
    hourly: hourlySeries(),
    /*
     * A week of daily entries, because the horizon is a week.
     *
     * Two entries against a seven-day horizon photographed as five cards reading "Not forecast",
     * which is the fixture's shape and not the screen's. The last day still reports no maximum, so
     * a day the provider did not fully report stays in every capture — that behaviour is the point
     * of the strip and is not being tidied away.
     */
    daily: {
      granularity: "daily",
      /*
       * The two measures Travel's metric row and its guidance read, which the real provider sends
       * on every daily entry and this fixture did not. Without them the fourth metric card and the
       * sun-protection note were unreachable in a capture but reachable in production — a stub that
       * is *narrower* than the contract hides a populated region rather than inventing one, and is
       * still a fixture disagreeing with the route.
       */
      units: { temperature_max: "°C", temperature_min: "°C", precipitation_sum: "mm", precipitation_probability_max: "%", uv_index_max: "index", weather_code_dominant: "WMO code" },
      entries: [
        {
          time_utc: "2026-09-03T22:00:00Z",
          time_local: "2026-09-04T00:00:00+02:00",
          values: { temperature_max: 19.6, temperature_min: 10.4, precipitation_sum: 1.6, precipitation_probability_max: 62, uv_index_max: 3.1, weather_code_dominant: 61 },
        },
        {
          time_utc: "2026-09-04T22:00:00Z",
          time_local: "2026-09-05T00:00:00+02:00",
          values: { temperature_max: 20.8, temperature_min: 11.2, precipitation_sum: 2.1, precipitation_probability_max: 71, uv_index_max: 2.8, weather_code_dominant: 63 },
        },
        {
          time_utc: "2026-09-05T22:00:00Z",
          time_local: "2026-09-06T00:00:00+02:00",
          values: { temperature_max: 24.5, temperature_min: 13.1, precipitation_sum: 0, precipitation_probability_max: 6, uv_index_max: 6.4, weather_code_dominant: 0 },
        },
        {
          time_utc: "2026-09-06T22:00:00Z",
          time_local: "2026-09-07T00:00:00+02:00",
          values: { temperature_max: 22.8, temperature_min: 12.4, precipitation_sum: 0.2, precipitation_probability_max: 24, uv_index_max: 5.2, weather_code_dominant: 61 },
        },
        {
          time_utc: "2026-09-07T22:00:00Z",
          time_local: "2026-09-08T00:00:00+02:00",
          values: { temperature_max: 19.1, temperature_min: 11.8, precipitation_sum: 3.4, precipitation_probability_max: 78, uv_index_max: 2.4, weather_code_dominant: 63 },
        },
        {
          time_utc: "2026-09-08T22:00:00Z",
          time_local: "2026-09-09T00:00:00+02:00",
          values: { temperature_max: 16.5, temperature_min: 9.7, precipitation_sum: 5.2, precipitation_probability_max: 88, uv_index_max: 1.9, weather_code_dominant: 80 },
        },
        {
          // The provider reported a minimum for this day and no maximum. Not a zero.
          time_utc: "2026-09-09T22:00:00Z",
          time_local: "2026-09-10T00:00:00+02:00",
          values: { temperature_max: null, temperature_min: 10.2, precipitation_sum: null },
        },
      ],
    },
    uncertainty: UNCERTAINTY,
  },

  "/api/v1/weather/analysis": {
    location: BERLIN,
    provider: "stub-provider",
    units: "metric",
    data_class: "computed_statistic",
    period: PERIOD,
    horizon_days: 3,
    from_cache: false,
    summary: "Across the window the mean temperature is 15.1 °C.",
    /*
     * More than one statistic, because the endpoint returns more than one.
     *
     * A single finding photographed as a single tile in a grid built for several, on the report
     * and on Historical alike. These are the statistics `analytics/` computes for a forecast
     * window; the last is deliberately not computable, so the "stated reason rather than a zero"
     * path is in every capture.
     */
    findings: [
      statistic("mean", "temperature", 15.1, "°C", "arithmetic mean of usable points"),
      statistic("minimum", "temperature", 9.7, "°C", "minimum of usable points"),
      statistic("maximum", "temperature", 24.5, "°C", "maximum of usable points"),
      statistic("total", "precipitation", 12.5, "mm", "sum of usable points"),
      {
        ...statistic("mean_speed", "wind_speed", null, "km/h", "arithmetic mean of usable points"),
        status: "not_computable",
        reason: "The provider reported no wind speed for this window.",
        points_used: 0,
        points_excluded: 48,
      },
    ],
    anomalies: {
      measure: "temperature",
      method: "median absolute deviation, threshold 3.5",
      threshold: 3.5,
      median: 15.0,
      median_absolute_deviation: 1.1,
      points_used: 48,
      points_excluded: 0,
      unit: "°C",
      /*
       * Two entries past the threshold and one under it, so the deviation plot has a shape and its
       * threshold line has something to be a threshold *of*. An empty list is a real state and is
       * the one `report.test.tsx` holds; it is not the one worth photographing.
       */
      anomalies: [
        {
          time_utc: "2026-09-05T16:00:00Z",
          time_local: "2026-09-05T18:00:00+02:00",
          value: 24.5,
          deviation: 9.5,
          deviation_score: 5.8,
        },
        {
          time_utc: "2026-09-08T04:00:00Z",
          time_local: "2026-09-08T06:00:00+02:00",
          value: 8.1,
          deviation: -6.9,
          deviation_score: 4.2,
        },
        {
          time_utc: "2026-09-09T10:00:00Z",
          time_local: "2026-09-09T12:00:00+02:00",
          value: 18.4,
          deviation: 3.4,
          deviation_score: 2.1,
        },
      ],
      note: null,
      provenance: PROVENANCE,
      minimum: statistic("minimum", "temperature", 10.4, "°C", "minimum of usable points"),
      maximum: statistic("maximum", "temperature", 20.8, "°C", "maximum of usable points"),
    },
    trend: {
      measure: "temperature",
      direction: "rising",
      magnitude: 1.2,
      slope_per_day: 0.4,
      unit: "°C",
      method: "least-squares slope",
      minimum_points: 3,
      insignificance_margin_per_day: 0.1,
      points_used: 48,
      points_excluded: 0,
      provenance: PROVENANCE,
    },
    thresholds: [],
    uncertainty: UNCERTAINTY,
  },

  "/api/v1/weather/changes": {
    location: BERLIN,
    period: PERIOD,
    provider: "stub-provider",
    unit_system: "metric",
    data_class: "forecast",
    /*
     * An actual comparison, which is what this endpoint exists to return.
     *
     * With `comparison_available: false` the Dashboard's "What Changed?" band and the report's
     * panel both photographed as one sentence explaining that there was nothing to compare — a
     * true state, and the only one either had ever been seen in. The movements below include one
     * inside the measure's materiality margin, so the "shown as immaterial rather than dropped or
     * promoted" behaviour is in the picture too.
     */
    comparison_available: true,
    previous_retrieved_at: "2026-09-03T18:00:00Z",
    current_retrieved_at: RETRIEVED_AT,
    changes: [
      {
        local_date: "2026-09-05",
        measure: "temperature_max",
        previous: 19.4,
        current: 20.8,
        change: 1.4,
        unit: "°C",
        material: true,
        statement: "The maximum for 5 September is 1.4 °C higher than in the earlier retrieval.",
      },
      {
        local_date: "2026-09-07",
        measure: "temperature_max",
        previous: 23.9,
        current: 22.8,
        change: -1.1,
        unit: "°C",
        material: true,
        statement: "The maximum for 7 September is 1.1 °C lower than in the earlier retrieval.",
      },
      {
        local_date: "2026-09-08",
        measure: "precipitation_sum",
        previous: 3.3,
        current: 3.4,
        change: 0.1,
        unit: "mm",
        material: false,
        statement: "The total for 8 September moved by less than the reporting margin.",
      },
    ],
    statement:
      "Compared with the retrieval of 3 September, two days moved materially and one did not. This is a comparison of two forecasts, not a record of what happened.",
  },

  "/api/v1/weather/history/baseline": {
    location: BERLIN,
    calendar_period: PERIOD,
    provider: "stub-provider",
    unit_system: "metric",
    measure: "temperature_mean",
    data_class: "historical_observation",
    labelling: "Baseline for 4-6 September, computed from the years listed below.",
    years_requested: 10,
    years_used: [2021, 2022, 2023],
    coverage_note: "Fewer years were available than requested.",
    /*
     * Each reference year's own mean, which `history_service.build_baseline` returns for every
     * baseline it computes and this fixture did not carry. The omission was invisible until the
     * Dashboard's closing band gained the plot the artifact draws there: the band photographed as
     * "the archive reported no per-year means", which is a true sentence about the fixture and a
     * false one about the product.
     *
     * They average to the 14.7 stated below rather than to plausible-looking numbers, and both lie
     * inside the 12.2–17.4 the daily minimum and maximum allow, because a fixture whose parts do
     * not reconcile is a capture that proves the layout and hides the arithmetic.
     */
    yearly_means: [
      { year: 2021, value: 13.6, points_used: 3 },
      { year: 2022, value: 14.7, points_used: 3 },
      { year: 2023, value: 15.8, points_used: 3 },
    ],
    mean: statistic("mean", "temperature_mean", 14.7, "°C", "arithmetic mean of usable points"),
    minimum: statistic("minimum", "temperature_mean", 12.2, "°C", "minimum of usable points"),
    maximum: statistic("maximum", "temperature_mean", 17.4, "°C", "maximum of usable points"),
    standard_deviation: statistic(
      "standard_deviation",
      "temperature_mean",
      1.8,
      "°C",
      "population standard deviation of usable points",
    ),
  },

  "/api/v1/me": {
    user_id: "00000000-0000-4000-8000-000000000001",
    email: "sam@example.test",
    email_verified: true,
    profile_created_at: "2026-08-01T09:00:00Z",
    last_seen_at: RETRIEVED_AT,
    created_now: false,
    preferences: {
      unit_system: "metric",
      forecast_horizon_days: 3,
      default_location: BERLIN,
      sources: { unit_system: "chosen", default_location: "chosen", forecast_horizon_days: "chosen" },
    },
  },

  "/api/v1/me/locations": {
    count: 2,
    limit: 20,
    locations: [
      { id: "s-berlin", location: BERLIN, label: null },
      { id: "s-munich", location: MUNICH, label: "Office" },
    ],
  },

  /*
   * The account surfaces added in task 34.10 and 34.17. Modelled here so the capture harness can
   * photograph the screens that read them rather than photographing their error states — which is
   * what the first Plan & Usage capture showed, and what made it useless as fidelity evidence.
   */
  "/api/v1/me/usage": {
    user_id: "00000000-0000-4000-8000-000000000001",
    plan_code: "free",
    plan_name: "Free",
    internal: false,
    dimensions: [
      {
        dimension: "requests_per_day",
        window: "day",
        allowance: 30,
        consumed: 12,
        remaining: 18,
        resets_at: "2026-09-11T00:00:00Z",
      },
      {
        dimension: "tokens_per_month",
        window: "month",
        allowance: 200000,
        consumed: 84500,
        remaining: 115500,
        resets_at: "2026-10-01T00:00:00Z",
      },
      {
        dimension: "concurrent_runs",
        window: "concurrent",
        allowance: 2,
        consumed: 0,
        remaining: 2,
        resets_at: null,
      },
    ],
    /*
     * The window `SUMMARY_DAYS` actually is, with the totals summed from the series rather
     * than stated beside it — the two disagreeing is exactly the defect a chart drawn from one
     * and captioned from the other would hide. Thirty points, one zero day, and a rising last
     * week, so the capture exercises the empty-bucket case and the week-over-week delta.
     */
    recent: { days: 30, calls: 220, failures: 10, total_tokens: 291475,
    series: [
      { date: "2026-08-12", calls: 5, failures: 0, total_tokens: 7250 },
      { date: "2026-08-13", calls: 6, failures: 0, total_tokens: 8700 },
      { date: "2026-08-14", calls: 6, failures: 0, total_tokens: 8700 },
      { date: "2026-08-15", calls: 7, failures: 0, total_tokens: 10150 },
      { date: "2026-08-16", calls: 9, failures: 1, total_tokens: 13050 },
      { date: "2026-08-17", calls: 8, failures: 0, total_tokens: 11600 },
      { date: "2026-08-18", calls: 0, failures: 0, total_tokens: null },
      { date: "2026-08-19", calls: 9, failures: 1, total_tokens: 13050 },
      { date: "2026-08-20", calls: 7, failures: 0, total_tokens: 10150 },
      { date: "2026-08-21", calls: 7, failures: 0, total_tokens: 10150 },
      { date: "2026-08-22", calls: 5, failures: 0, total_tokens: 7250 },
      { date: "2026-08-23", calls: 3, failures: 0, total_tokens: 4350 },
      { date: "2026-08-24", calls: 2, failures: 0, total_tokens: 2900 },
      { date: "2026-08-25", calls: 0, failures: 0, total_tokens: null },
      { date: "2026-08-26", calls: 2, failures: 0, total_tokens: 2900 },
      { date: "2026-08-27", calls: 2, failures: 0, total_tokens: 2900 },
      { date: "2026-08-28", calls: 4, failures: 0, total_tokens: 5800 },
      { date: "2026-08-29", calls: 3, failures: 0, total_tokens: 4350 },
      { date: "2026-08-30", calls: 5, failures: 0, total_tokens: 7250 },
      { date: "2026-08-31", calls: 7, failures: 0, total_tokens: 10150 },
      { date: "2026-09-01", calls: 0, failures: 0, total_tokens: null },
      { date: "2026-09-02", calls: 8, failures: 0, total_tokens: 11600 },
      { date: "2026-09-03", calls: 9, failures: 1, total_tokens: 13050 },
      { date: "2026-09-04", calls: 12, failures: 1, total_tokens: 17400 },
      { date: "2026-09-05", calls: 13, failures: 1, total_tokens: 18850 },
      { date: "2026-09-06", calls: 11, failures: 1, total_tokens: 15950 },
      { date: "2026-09-07", calls: 13, failures: 1, total_tokens: 18850 },
      { date: "2026-09-08", calls: 0, failures: 0, total_tokens: null },
      { date: "2026-09-09", calls: 9, failures: 1, total_tokens: 13050 },
      { date: "2026-09-10", calls: 7, failures: 0, total_tokens: 10150 },
    ],
  },
  },

  "/api/v1/me/watches": {
    count: 2,
    watchable: ["precipitation", "relative_humidity", "temperature", "wind_gust", "wind_speed"],
    evaluation_note:
      "Checked when you open this screen or press refresh. Weathra does not monitor continuously and sends no alerts.",
    disclaimer:
      "Weather Watch is analytical assistance, not an official severe-weather or emergency warning service. Always follow your local meteorological agency.",
    watches: [
      {
        id: "w-wind",
        location: BERLIN,
        label: null,
        measure: "wind_speed",
        comparison: "above",
        threshold: 40,
        enabled: true,
        last_evaluated_at: "2026-09-04T06:15:00Z",
        last_value: 52.4,
        last_met: true,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-04T06:15:00Z",
      },
      {
        id: "w-frost",
        location: MUNICH,
        label: "Office",
        measure: "temperature",
        comparison: "below",
        threshold: 0,
        enabled: true,
        last_evaluated_at: null,
        last_value: null,
        last_met: null,
        created_at: "2026-09-02T00:00:00Z",
        updated_at: "2026-09-02T00:00:00Z",
      },
    ],
  },

  /**
   * The administrative reads, so the admin screen can be photographed rather than judged from
   * source. The catalog rows are the ones migration `0008` actually seeds — real gateway strings
   * through the one gateway Weathra reaches — because a fidelity screenshot showing invented model
   * names would be evidence of the wrong thing.
   *
   * The usage aggregate is shaped exactly as `GET /admin/usage` returns it, including the parts a
   * dashboard is most likely to get wrong: one group whose token and cost figures are null because
   * the gateway reported none, and one internal group, which is never counted against a plan.
   */
  /*
   * The trend `09-admin-model-ai-usage.png` leads with, shaped as `GET /admin/usage/series`
   * returns it: one entry per (bucket, internal) pair, dense across the window. The internal
   * side carries genuine zero days with null tokens, because that is the case a chart is most
   * likely to draw wrongly — a bucket with no calls has no token report to sum, and null is
   * not zero.
   */
  /*
   * The two administrative surfaces task 34.22 built. Modelled here because without them the
   * capture photographed two full-width refusal panels where the screen actually has a routing
   * table and a principals table — a picture of the stub rather than of the product.
   *
   * The plan rows carry the mapping a policy is reached through, which is the panel's whole point:
   * a plan resolves to a policy per call role, and the policy resolves to a model. No model string
   * is written here, because none is written in the frontend at all (task 34.22).
   */
  "/api/v1/plans": {
    default_plan: "free",
    self_service: false,
    assignment_note: "",
    count: 3,
    plans: [
      {
        plan_code: "free",
        display_name: "Free",
        rank: 1,
        model_tier: "economy",
        model_name: "Economy (free tier), primary",
        allowances: [
          { dimension: "requests_per_day", window: "day", allowance: 30 },
          { dimension: "tokens_per_month", window: "month", allowance: 200000 },
          { dimension: "concurrent_runs", window: "concurrent", allowance: 2 },
        ],
      },
      {
        plan_code: "pro",
        display_name: "Pro",
        rank: 2,
        model_tier: "standard",
        model_name: "Standard general-purpose",
        allowances: [
          { dimension: "requests_per_day", window: "day", allowance: 300 },
          { dimension: "tokens_per_month", window: "month", allowance: 2000000 },
          { dimension: "concurrent_runs", window: "concurrent", allowance: 5 },
        ],
      },
      {
        plan_code: "premium",
        display_name: "Premium",
        rank: 3,
        model_tier: "frontier",
        model_name: "Frontier structured reasoning",
        allowances: [
          { dimension: "requests_per_day", window: "day", allowance: 1000 },
          { dimension: "tokens_per_month", window: "month", allowance: 8000000 },
          { dimension: "concurrent_runs", window: "concurrent", allowance: 10 },
        ],
      },
    ],
  },

  "/api/v1/admin/plans": {
    count: 3,
    plans: [
      {
        plan_code: "free",
        display_name: "Free",
        rank: 1,
        external_subscription_ref: null,
        policy_by_call_role: { routing: "economy", synthesis: "economy", lab: "economy" },
      },
      {
        plan_code: "pro",
        display_name: "Pro",
        rank: 2,
        external_subscription_ref: null,
        policy_by_call_role: { routing: "balanced", synthesis: "balanced", lab: "economy" },
      },
      {
        plan_code: "premium",
        display_name: "Premium",
        rank: 3,
        external_subscription_ref: null,
        policy_by_call_role: { routing: "balanced", synthesis: "balanced", lab: "balanced" },
      },
    ],
  },

  /*
   * Principals and the tier each is on. No contact detail, because none is stored — the subject is
   * the Supabase id and nothing else, which is the property the panel exists to demonstrate.
   * `administrative` is a role and deliberately independent of the tier: the last row is an
   * administrator on the Free plan, which is exactly the pair a reader might assume cannot happen.
   */
  "/api/v1/admin/principals": {
    count: 4,
    principals: [
      {
        subject_id: "00000000-0000-4000-8000-000000000001",
        plan_code: "premium",
        plan_name: "Premium",
        administrative: false,
        assigned_at: "2026-09-02T10:14:00Z",
        assigned_by: "00000000-0000-4000-8000-0000000000ad",
      },
      {
        subject_id: "00000000-0000-4000-8000-000000000002",
        plan_code: "pro",
        plan_name: "Pro",
        administrative: false,
        assigned_at: "2026-08-28T16:40:00Z",
        assigned_by: "00000000-0000-4000-8000-0000000000ad",
      },
      {
        subject_id: "00000000-0000-4000-8000-000000000003",
        plan_code: null,
        plan_name: null,
        administrative: false,
        assigned_at: null,
        assigned_by: null,
      },
      {
        subject_id: "00000000-0000-4000-8000-0000000000ad",
        plan_code: "free",
        plan_name: "Free",
        administrative: true,
        assigned_at: "2026-08-01T09:00:00Z",
        assigned_by: null,
      },
    ],
  },

  "/api/v1/admin/usage/series": {
    bucket: "day",
    window: { start: "2026-08-12T00:00:00Z", end: "2026-09-10T09:00:00Z" },
    points: [
      { start: "2026-08-12T00:00:00Z", is_internal: false, calls: 35, failures: 1, total_tokens: 51800, estimated_cost_total: "0.0218", latency_p50_ms: 1359 },
      { start: "2026-08-12T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-08-13T00:00:00Z", is_internal: false, calls: 32, failures: 0, total_tokens: 47360, estimated_cost_total: "0.0199", latency_p50_ms: 1279 },
      { start: "2026-08-13T00:00:00Z", is_internal: true, calls: 0, failures: 0, total_tokens: null, estimated_cost_total: null, latency_p50_ms: null },
      { start: "2026-08-14T00:00:00Z", is_internal: false, calls: 39, failures: 0, total_tokens: 57720, estimated_cost_total: "0.0242", latency_p50_ms: 1138 },
      { start: "2026-08-14T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-15T00:00:00Z", is_internal: false, calls: 42, failures: 0, total_tokens: 62160, estimated_cost_total: "0.0261", latency_p50_ms: 1259 },
      { start: "2026-08-15T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-08-16T00:00:00Z", is_internal: false, calls: 41, failures: 0, total_tokens: 60680, estimated_cost_total: "0.0255", latency_p50_ms: 1179 },
      { start: "2026-08-16T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-08-17T00:00:00Z", is_internal: false, calls: 44, failures: 1, total_tokens: 65120, estimated_cost_total: "0.0274", latency_p50_ms: 1188 },
      { start: "2026-08-17T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-18T00:00:00Z", is_internal: false, calls: 40, failures: 0, total_tokens: 59200, estimated_cost_total: "0.0249", latency_p50_ms: 1273 },
      { start: "2026-08-18T00:00:00Z", is_internal: true, calls: 3, failures: 0, total_tokens: 6300, estimated_cost_total: "0.0026", latency_p50_ms: 1400 },
      { start: "2026-08-19T00:00:00Z", is_internal: false, calls: 40, failures: 0, total_tokens: 59200, estimated_cost_total: "0.0249", latency_p50_ms: 1353 },
      { start: "2026-08-19T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-20T00:00:00Z", is_internal: false, calls: 45, failures: 0, total_tokens: 66600, estimated_cost_total: "0.0280", latency_p50_ms: 1308 },
      { start: "2026-08-20T00:00:00Z", is_internal: true, calls: 3, failures: 0, total_tokens: 6300, estimated_cost_total: "0.0026", latency_p50_ms: 1400 },
      { start: "2026-08-21T00:00:00Z", is_internal: false, calls: 44, failures: 0, total_tokens: 65120, estimated_cost_total: "0.0274", latency_p50_ms: 1367 },
      { start: "2026-08-21T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-22T00:00:00Z", is_internal: false, calls: 42, failures: 1, total_tokens: 62160, estimated_cost_total: "0.0261", latency_p50_ms: 1421 },
      { start: "2026-08-22T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-23T00:00:00Z", is_internal: false, calls: 37, failures: 0, total_tokens: 54760, estimated_cost_total: "0.0230", latency_p50_ms: 1283 },
      { start: "2026-08-23T00:00:00Z", is_internal: true, calls: 0, failures: 0, total_tokens: null, estimated_cost_total: null, latency_p50_ms: null },
      { start: "2026-08-24T00:00:00Z", is_internal: false, calls: 35, failures: 0, total_tokens: 51800, estimated_cost_total: "0.0218", latency_p50_ms: 1372 },
      { start: "2026-08-24T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-08-25T00:00:00Z", is_internal: false, calls: 32, failures: 0, total_tokens: 47360, estimated_cost_total: "0.0199", latency_p50_ms: 1120 },
      { start: "2026-08-25T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-26T00:00:00Z", is_internal: false, calls: 30, failures: 0, total_tokens: 44400, estimated_cost_total: "0.0186", latency_p50_ms: 1062 },
      { start: "2026-08-26T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-08-27T00:00:00Z", is_internal: false, calls: 29, failures: 1, total_tokens: 42920, estimated_cost_total: "0.0180", latency_p50_ms: 1381 },
      { start: "2026-08-27T00:00:00Z", is_internal: true, calls: 0, failures: 0, total_tokens: null, estimated_cost_total: null, latency_p50_ms: null },
      { start: "2026-08-28T00:00:00Z", is_internal: false, calls: 26, failures: 0, total_tokens: 38480, estimated_cost_total: "0.0162", latency_p50_ms: 1170 },
      { start: "2026-08-28T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-08-29T00:00:00Z", is_internal: false, calls: 21, failures: 0, total_tokens: 31080, estimated_cost_total: "0.0131", latency_p50_ms: 1144 },
      { start: "2026-08-29T00:00:00Z", is_internal: true, calls: 0, failures: 0, total_tokens: null, estimated_cost_total: null, latency_p50_ms: null },
      { start: "2026-08-30T00:00:00Z", is_internal: false, calls: 24, failures: 0, total_tokens: 35520, estimated_cost_total: "0.0149", latency_p50_ms: 1363 },
      { start: "2026-08-30T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-08-31T00:00:00Z", is_internal: false, calls: 17, failures: 0, total_tokens: 25160, estimated_cost_total: "0.0106", latency_p50_ms: 1334 },
      { start: "2026-08-31T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-09-01T00:00:00Z", is_internal: false, calls: 22, failures: 1, total_tokens: 32560, estimated_cost_total: "0.0137", latency_p50_ms: 1295 },
      { start: "2026-09-01T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-09-02T00:00:00Z", is_internal: false, calls: 22, failures: 0, total_tokens: 32560, estimated_cost_total: "0.0137", latency_p50_ms: 1388 },
      { start: "2026-09-02T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-09-03T00:00:00Z", is_internal: false, calls: 24, failures: 0, total_tokens: 35520, estimated_cost_total: "0.0149", latency_p50_ms: 1401 },
      { start: "2026-09-03T00:00:00Z", is_internal: true, calls: 3, failures: 0, total_tokens: 6300, estimated_cost_total: "0.0026", latency_p50_ms: 1400 },
      { start: "2026-09-04T00:00:00Z", is_internal: false, calls: 25, failures: 0, total_tokens: 37000, estimated_cost_total: "0.0155", latency_p50_ms: 1390 },
      { start: "2026-09-04T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-09-05T00:00:00Z", is_internal: false, calls: 28, failures: 0, total_tokens: 41440, estimated_cost_total: "0.0174", latency_p50_ms: 1105 },
      { start: "2026-09-05T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-09-06T00:00:00Z", is_internal: false, calls: 31, failures: 1, total_tokens: 45880, estimated_cost_total: "0.0193", latency_p50_ms: 1342 },
      { start: "2026-09-06T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
      { start: "2026-09-07T00:00:00Z", is_internal: false, calls: 29, failures: 0, total_tokens: 42920, estimated_cost_total: "0.0180", latency_p50_ms: 1133 },
      { start: "2026-09-07T00:00:00Z", is_internal: true, calls: 3, failures: 0, total_tokens: 6300, estimated_cost_total: "0.0026", latency_p50_ms: 1400 },
      { start: "2026-09-08T00:00:00Z", is_internal: false, calls: 36, failures: 0, total_tokens: 53280, estimated_cost_total: "0.0224", latency_p50_ms: 1318 },
      { start: "2026-09-08T00:00:00Z", is_internal: true, calls: 4, failures: 0, total_tokens: 8400, estimated_cost_total: "0.0035", latency_p50_ms: 1400 },
      { start: "2026-09-09T00:00:00Z", is_internal: false, calls: 35, failures: 0, total_tokens: 51800, estimated_cost_total: "0.0218", latency_p50_ms: 1234 },
      { start: "2026-09-09T00:00:00Z", is_internal: true, calls: 1, failures: 0, total_tokens: 2100, estimated_cost_total: "0.0009", latency_p50_ms: 1400 },
      { start: "2026-09-10T00:00:00Z", is_internal: false, calls: 41, failures: 0, total_tokens: 60680, estimated_cost_total: "0.0255", latency_p50_ms: 1304 },
      { start: "2026-09-10T00:00:00Z", is_internal: true, calls: 2, failures: 0, total_tokens: 4200, estimated_cost_total: "0.0018", latency_p50_ms: 1400 },
    ],
  },
  "/api/v1/admin/usage": {
    grouped_by: "model",
    window: { start: "2026-08-11T00:00:00Z", end: "2026-09-10T09:00:00Z" },
    groups: [
      {
        group: "openai/gpt-oss-120b",
        is_internal: false,
        calls: 412,
        failures: 6,
        prompt_tokens: 486300,
        completion_tokens: 121400,
        total_tokens: 607700,
        estimated_cost_total: "1.8412",
        latency_p50_ms: 1180,
        latency_p95_ms: 3400,
      },
      {
        group: "nvidia/nemotron-3-super-120b-a12b:free",
        is_internal: false,
        calls: 268,
        failures: 11,
        prompt_tokens: 301200,
        completion_tokens: 78400,
        total_tokens: 379600,
        estimated_cost_total: "0.0000",
        latency_p50_ms: 1620,
        latency_p95_ms: 4900,
      },
      {
        group: "nex-agi/nex-n2.5-mini:free",
        is_internal: false,
        calls: 74,
        failures: 0,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        estimated_cost_total: null,
        latency_p50_ms: 940,
        latency_p95_ms: 2100,
      },
      {
        group: "openai/gpt-oss-120b",
        is_internal: true,
        calls: 96,
        failures: 1,
        prompt_tokens: 88100,
        completion_tokens: 24300,
        total_tokens: 112400,
        estimated_cost_total: "0.3390",
        latency_p50_ms: 1240,
        latency_p95_ms: 3100,
      },
    ],
  },

  "/api/v1/admin/policies": {
    count: 2,
    policies: [
      {
        policy_id: "balanced",
        display_name: "Balanced",
        candidate_catalog_keys: ["standard-general", "economy-free-primary"],
        applicable_call_roles: ["routing", "synthesis"],
        eligibility: "paid_and_free",
        failover_enabled: true,
        fallback_policy_id: "economy",
      },
      {
        policy_id: "economy",
        display_name: "Economy",
        candidate_catalog_keys: ["economy-free-primary", "economy-free-secondary"],
        applicable_call_roles: ["routing", "synthesis"],
        eligibility: "free_only",
        failover_enabled: true,
        fallback_policy_id: null,
      },
    ],
  },

  "/api/v1/admin/lab/comparisons": {
    count: 1,
    runs: [
      {
        id: "9b5849dd-b798-4dc8-b04f-a8e6c0874e1a",
        status: "completed",
        initiated_by: "00000000-0000-4000-8000-000000000001",
        candidate_catalog_keys: ["standard-general", "economy-free-primary"],
        dataset_version: "weathra-eval-v1",
        started_at: "2026-09-10T08:50:00Z",
        completed_at: "2026-09-10T09:12:00Z",
        commit_sha: null,
        question: null,
      },
    ],
  },

  /* The run the list above offers, so the confirmation surface photographs with its evidence
     rather than with a stub error where the criteria belong. */
  "/api/v1/admin/lab/comparisons/9b5849dd-b798-4dc8-b04f-a8e6c0874e1a": {
    partial: false,
    completed_cells: ["standard-general", "economy-free-primary"],
    run: {
      id: "9b5849dd-b798-4dc8-b04f-a8e6c0874e1a",
      status: "completed",
      initiated_by: "00000000-0000-4000-8000-000000000001",
      candidate_catalog_keys: ["standard-general", "economy-free-primary"],
      dataset_version: "weathra-eval-v1",
      started_at: "2026-09-10T08:50:00Z",
      completed_at: "2026-09-10T09:12:00Z",
      commit_sha: null,
      question: null,
      results: [
        {
          case_id: "berlin-forecast",
          catalog_key: "standard-general",
          gateway_model: "openai/gpt-oss-120b",
          policy_id: "balanced",
          succeeded: true,
          latency_ms: 1180,
          prompt_tokens: 1420,
          completion_tokens: 380,
          total_tokens: 1800,
          estimated_cost: "0.0012",
          failure_class: null,
          evaluation_id: "e-1",
          agent_run_id: null,
          usage_event_ids: [],
        },
        {
          case_id: "berlin-forecast",
          catalog_key: "economy-free-primary",
          gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
          policy_id: "economy",
          succeeded: true,
          latency_ms: 1620,
          prompt_tokens: 1420,
          completion_tokens: 410,
          total_tokens: 1830,
          estimated_cost: "0.0000",
          failure_class: null,
          evaluation_id: "e-2",
          agent_run_id: null,
          usage_event_ids: [],
        },
      ],
    },
  },

  "/api/v1/admin/models": {
    count: 4,
    entries: [
      {
        catalog_key: "economy-free-primary",
        display_name: "Economy (free tier), primary",
        gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
        gateway_provider: "openrouter",
        capability_roles: ["routing", "synthesis", "lab"],
        capability_tier: "economy",
        context_window: 262144,
        input_price_per_million: "0.0000",
        output_price_per_million: "0.0000",
        price_currency: "USD",
        pricing_recorded_on: "2026-09-01",
        is_free_tier: true,
        status: "enabled",
        supports_structured_output: true,
      },
      {
        catalog_key: "economy-free-secondary",
        display_name: "Economy (free tier), secondary",
        gateway_model: "nex-agi/nex-n2.5-mini:free",
        gateway_provider: "openrouter",
        capability_roles: ["routing", "synthesis", "lab"],
        capability_tier: "economy",
        context_window: 262144,
        input_price_per_million: "0.0000",
        output_price_per_million: "0.0000",
        price_currency: "USD",
        pricing_recorded_on: "2026-09-01",
        is_free_tier: true,
        status: "enabled",
        supports_structured_output: true,
      },
      {
        catalog_key: "standard-general",
        display_name: "Standard general-purpose",
        gateway_model: "openai/gpt-oss-120b",
        gateway_provider: "openrouter",
        capability_roles: ["routing", "synthesis", "lab"],
        capability_tier: "standard",
        context_window: 131072,
        input_price_per_million: "0.0720",
        output_price_per_million: "0.2800",
        price_currency: "USD",
        pricing_recorded_on: "2026-09-01",
        is_free_tier: false,
        status: "enabled",
        supports_structured_output: true,
      },
      {
        catalog_key: "standard-reasoning",
        display_name: "Standard reasoning",
        gateway_model: "qwen/qwen3-235b-a22b-thinking-2507",
        gateway_provider: "openrouter",
        capability_roles: ["synthesis", "lab"],
        capability_tier: "standard",
        context_window: 262144,
        input_price_per_million: "0.1100",
        output_price_per_million: "0.6000",
        price_currency: "USD",
        pricing_recorded_on: "2026-09-01",
        is_free_tier: false,
        status: "disabled",
        supports_structured_output: true,
      },
    ],
    observations: {
      "standard-general": {
        gateway_model: "openai/gpt-oss-120b",
        dataset_version: "weathra-eval-v1",
        passed: true,
        recorded_at: "2026-09-10T09:12:00Z",
      },
      "economy-free-primary": {
        gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
        dataset_version: "weathra-eval-v1",
        passed: false,
        recorded_at: "2026-09-10T09:12:00Z",
      },
    },
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

  /* Ambiguous on purpose: the candidate chooser is one of the surfaces task 21.8 audits. */
  "/api/v1/locations/resolve": {
    kind: "ambiguous",
    query: "Springfield",
    candidates: [SPRINGFIELD_IL, SPRINGFIELD_MO],
    message:
      "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US. Weathra does not pick one for you.",
  },

  "/api/v1/weather/history": {
    location: BERLIN,
    provider: "stub-provider",
    units: "metric",
    data_class: "historical_observation",
    requested_period: PERIOD,
    covered_period: PERIOD,
    retrieved_at: RETRIEVED_AT,
    partial: false,
    unavailable_note: null,
    daily: dailySeries({
      temperature_mean: "°C",
      temperature_min: "°C",
      temperature_max: "°C",
      precipitation_sum: "mm",
      wind_speed_max: "km/h",
      relative_humidity: "%",
    }),
    hourly: null,
  },

  "/api/v1/weather/history/comparison": {
    location: BERLIN,
    data_class: "historical_observation",
    earlier_period: PERIOD,
    later_period: PERIOD,
    provider: "stub-provider",
    unit_system: "metric",
    /*
     * All six statistics `03-historical-analytics.png` puts in its metric row, with a delta each
     * so every tile carries the artifact's "vs earlier" caption.
     *
     * This fixture used to carry `temperature_mean` alone, and the screen behaved correctly on it:
     * one tile, and a footnote naming the five the backend did not compute. That was a picture of
     * the *stub* rather than of the product — Open-Meteo's archive returns daily minima, maxima,
     * precipitation sums, wind maxima and humidity for every location, so production computes all
     * six. The capture now shows what production shows; the one-statistic case it used to show is
     * still exercised, by `historical.test.tsx`, where it belongs.
     */
    statistics_applied: [
      "temperature_mean: mean",
      "temperature_min: minimum",
      "temperature_max: maximum",
      "precipitation_sum: total",
      "wind_speed_max: mean",
      "relative_humidity: mean",
    ],
    earlier: [
      statistic("mean", "temperature_mean", 15.1, "°C", "arithmetic mean of usable points"),
      statistic("minimum", "temperature_min", 10.2, "°C", "minimum of usable points"),
      statistic("maximum", "temperature_max", 20.4, "°C", "maximum of usable points"),
      statistic("total", "precipitation_sum", 11.8, "mm", "sum of usable points"),
      statistic("mean", "wind_speed_max", 12.9, "km/h", "arithmetic mean of usable points"),
      statistic("mean", "relative_humidity", 71.5, "%", "arithmetic mean of usable points"),
    ],
    later: [
      statistic("mean", "temperature_mean", 17.9, "°C", "arithmetic mean of usable points"),
      statistic("minimum", "temperature_min", 11.4, "°C", "minimum of usable points"),
      statistic("maximum", "temperature_max", 24.1, "°C", "maximum of usable points"),
      statistic("total", "precipitation_sum", 9.6, "mm", "sum of usable points"),
      statistic("mean", "wind_speed_max", 14.2, "km/h", "arithmetic mean of usable points"),
      statistic("mean", "relative_humidity", 68.3, "%", "arithmetic mean of usable points"),
    ],
    deltas: [
      statistic("delta", "temperature_mean", 2.8, "°C", "later minus earlier"),
      statistic("delta", "temperature_min", 1.2, "°C", "later minus earlier"),
      statistic("delta", "temperature_max", 3.7, "°C", "later minus earlier"),
      statistic("delta", "precipitation_sum", -2.2, "mm", "later minus earlier"),
      statistic("delta", "wind_speed_max", 1.3, "km/h", "later minus earlier"),
      statistic("delta", "relative_humidity", -3.2, "%", "later minus earlier"),
    ],
    percentage_changes: { temperature_mean: 18.5 },
    lengths_differ: false,
    basis: "Both periods: archive observations, metric units, the same statistics.",
  },

  "/api/v1/weather/history/baseline/comparison": {
    location: BERLIN,
    measure: "temperature_mean",
    observed_or_forecast_value: 17.9,
    observed_data_class: "historical_observation",
    characterization: "Warmer than the 4-year baseline for this calendar period.",
    forecast_side_caveat: null,
    difference: statistic("delta", "temperature_mean", 1.7, "°C", "the value being compared minus the baseline"),
    z_score: statistic("z_score", "temperature_mean", 1.21, "", "value minus reference mean, divided by the reference standard deviation"),
    /*
     * 17.9 against 14.8, 15.6, 16.9 and 17.5: four years below it, none equal, so
     * (4 + 0) / 4 = 100th. The warmest such window in the archive Weathra has, which is the case
     * worth photographing — the mark sits past every reference year, which is exactly why the
     * track extends to include it rather than clamping it onto the last one.
     */
    percentile_rank: statistic("percentile_rank", "temperature_mean", 100, "percentile", "(years below + half the years equal) / years, as a percentage, against the per-year means of the 4-year baseline; 4 years, so the finest distinction is 25 points"),
    baseline: BASELINE,
  },

  /*
   * A day-level ranking, because that is the request the Travel screen actually makes.
   *
   * This fixture used to answer with `mode: "locations"` — Berlin ranked against Munich, scored on
   * raw temperature, carrying `correlation`, `data_density`, `basis`, `weights` and `retrieved_at`.
   * Travel asks `POST /weather/comparison` with a single `location` and a `days` horizon, which the
   * real service answers from `compare_days`: ISO-dated candidates, scores on 0–1, the two
   * cross-place statistics `null`, and no `basis`/`weights`/`retrieved_at` fields at all — the
   * model forbids them. So the capture was photographing a screen fed a shape production never
   * returns for that request, which is the one thing a fixture must not do. Verified against the
   * live service for London before it was written here; `travel-schema-parity.test.ts` holds the
   * two consumers to one view model so this cannot drift back.
   *
   * The values are the stub's own and deterministic. The *shape and capabilities* are the
   * contract's.
   */
  "/api/v1/weather/comparison": {
    mode: "days",
    criterion: "outdoor_suitability",
    data_class: "forecast",
    provider: "stub-provider",
    unit_system: "metric",
    period: PERIOD,
    local_time_basis: true,
    tie_tolerance: 0.05,
    /*
     * Both `null`, as `compare_days` returns them. Pearson's r describes a *pair of places* and
     * density counts instants every candidate reported; neither means anything when the candidates
     * are the days of one place, so the service leaves them unset and the screen must not rely on
     * them.
     */
    correlation: null,
    data_density: null,
    statistics_applied: [
      "temperature_mean: mean (weight 0.5)",
      "precipitation_sum: total (weight 0.3)",
      "wind_speed_max: mean (weight 0.2)",
    ],
    weighting_disclosure:
      "The outdoor-suitability score is Weathra's own heuristic, not an authoritative index. It combines temperature comfort (weight 0.5), precipitation (weight 0.3) and wind (weight 0.2).",
    candidates: [
      dayCandidate("2026-09-06", 1, 0.913, { temperature: 24.5, rain: 0, wind: 13.7 }, true),
      dayCandidate("2026-09-07", 1, 0.886, { temperature: 22.8, rain: 0.2, wind: 14.8 }, true),
      dayCandidate("2026-09-05", 3, 0.841, { temperature: 20.8, rain: 2.1, wind: 18.4 }, false),
      dayCandidate("2026-09-04", 4, 0.792, { temperature: 19.6, rain: 1.6, wind: 20.2 }, false),
      dayCandidate("2026-09-08", 5, 0.741, { temperature: 19.1, rain: 3.4, wind: 22.3 }, false),
      dayCandidate("2026-09-09", 6, 0.688, { temperature: 16.5, rain: 5.2, wind: 31.4 }, false),
    ],
    /*
     * One day left out, with its reason, as the real service excludes a day it cannot score. It is
     * the seventh daily entry above — the one reporting no maximum — so the fixture's own two
     * halves agree about which day the provider under-reported.
     */
    excluded: [
      {
        label: "2026-09-10",
        location: BERLIN,
        code: "insufficient_data",
        reason: "The provider reported too few values for this day to score it.",
      },
    ],
  },

  /*
   * Travel Intelligence, as `POST /travel/intelligence` answers it.
   *
   * One trip, one response. The screen no longer fans out to four endpoints, so the stub no longer
   * models Travel through the comparison fixture — that one answers Compare Cities' question and
   * is left to it. Values are deterministic; the shape and the capabilities are the contract's,
   * and `travel-schema-parity.test.ts` holds them to `backend/openapi.json`.
   */
  "/api/v1/travel/intelligence": {
    trip: {
      origin: BERLIN,
      destination: BARCELONA,
      start: "2026-09-14",
      end: "2026-09-18",
      nights: 4,
    },
    generated_at: "2026-09-04T06:15:02Z",
    hero_state: "Good",
    hero_summary:
      "14 Sep\u201318 Sep at Barcelona rates 71.4 out of 100 for outdoor conditions, which Weathra calls good. 9.3 mm of rain is expected across the trip, falling across 2 of 5 days. Settled weather is expected on 80% of the days. Temperatures range between 18.1 and 30.7\u00b0C across the trip.",
    viability: {
      score: 71.4,
      state: "Good",
      basis: "Computed over the trip's own days, from the same weighted components Weathra scores outdoor suitability with elsewhere.",
      disclosure: "The outdoor-suitability score is Weathra's own heuristic, not an authoritative index. It combines temperature comfort (weight 0.5), precipitation (weight 0.3) and wind (weight 0.2).",
      contributions: [
        { measure: "temperature_mean", value: 23.400000000000002, unit: "\u00b0C", direction: "above", weight: 0.5, contribution: 0.381, supporting: statistic("mean", "temperature_mean", 23.4, "\u00b0C", "arithmetic mean of usable points") },
        { measure: "precipitation_sum", value: 9.3, unit: "mm", direction: "below", weight: 0.3, contribution: 0.214, supporting: statistic("total", "precipitation_sum", 9.3, "mm", "sum of usable points") },
        { measure: "wind_speed_max", value: 17.2, unit: "km/h", direction: "below", weight: 0.2, contribution: 0.119, supporting: statistic("mean", "wind_speed_max", 17.2, "km/h", "arithmetic mean of usable points") },
      ],
    },
    metrics: [
      { key: "temperature_variance", label: "Temperature variance", value: 12.6, unit: "\u00b0C", detail: "Between 18.1 and 30.7\u00b0C across the trip", method: "the trip's highest reported maximum minus its lowest reported minimum", data_class: "computed_statistic" },
      { key: "transit_stability", label: "Travel weather stability", value: 80.0, unit: "%", detail: "1 of 5 days could see heavy rain, strong gusts or a storm", method: "the share of trip days reporting under 10.0 mm of rain, gusts under 45.0 km/h and no disruptive weather code. Weather only \u2014 Weathra holds no airline, airport or transport data.", data_class: "computed_statistic" },
      { key: "precipitation_cluster", label: "Precipitation cluster", value: 9.3, unit: "mm", detail: "Falling across 2 of 5 days", method: "sum of usable points", data_class: "computed_statistic" },
      { key: "sun_exposure", label: "Peak UV index", value: 6.1, unit: "index", detail: "Strong enough to need cover", method: "the highest daily peak UV index the provider reported across the trip. Weathra has no sunshine-duration measure and does not estimate hours in the sun.", data_class: "forecast" },
    ],
    daily_outlook: [
      travelDay("2026-09-14", "Mon", 1, 30.700000000000003, 20.7, 0, 5, 6.1, 77.4, 3),
      travelDay("2026-09-15", "Tue", 2, 28.7, 21.6, 0.2, 18, 5.8, 80.2, 2),
      travelDay("2026-09-16", "Wed", 3, 27.5, 19.3, 4.1, 64, 4.2, 73.0, 4),
      travelDay("2026-09-17", "Thu", 61, 25.5, 18.1, 5.0, 71, 3.6, 91.5, 1),
      travelDay("2026-09-18", "Fri", 3, 25.7, 18.5, 0, 12, 4.9, 90.6, 5),
    ],
    packing_strategy: [
      { item: "Waterproof outer layer", tier: "Essential", because: "2 of 5 days carry rain, 9.3 mm over the trip" },
      { item: "Breathable warm-weather clothing", tier: "Recommended", because: "the warmest day reaches 30.7 \u00b0C" },
      { item: "Sun protection", tier: "Recommended", because: "the peak UV index reaches 6.1" },
      { item: "Layers you can add and remove", tier: "Optional", because: "the trip spans 12.6 \u00b0C between its coldest night and warmest day" },
    ],
    packing_insight:
      "Daytime highs reach 30.7 \u00b0C but nights fall to 18.1 \u00b0C, so one layer carried through the day covers the difference.",
    temporal_comparison: [
      { start: "2026-09-14", end: "2026-09-18", label: "14\u201318 Sep", selected: true, viability: 71.4, state: "Good", temperature_mean: 23.4, precipitation_sum: 9.3, unavailable_reason: null },
      { start: "2026-09-19", end: "2026-09-23", label: "19\u201323 Sep", selected: false, viability: 80.1, state: "Excellent", temperature_mean: 22.1, precipitation_sum: 0.4, unavailable_reason: null },
      { start: "2026-09-24", end: "2026-09-28", label: "24\u201328 Sep", selected: false, viability: 64.8, state: "Good", temperature_mean: 20.3, precipitation_sum: 14.6, unavailable_reason: null },
    ],
    /*
     * No earlier snapshot, which is a real state and the one worth photographing: the band must be
     * present and truthful rather than quietly filled with invented model convergence.
     */
    forecast_changes: null,
    historical_baseline: null,
    synthesis:
      "The weather over 14 Sep\u201318 Sep at Barcelona rates 71.4 out of 100, which Weathra calls good. Thu 17 Sep is the strongest day and Mon 14 Sep the weakest. 19\u201323 Sep scores higher at 80.1. Weathra does not change your dates; this compares weather, not bookings.",
    synthesis_data_class: "computed_statistic",
    evidence: {
      forecast_provider: "stub-provider",
      forecast_retrieved_at: RETRIEVED_AT,
      forecast_from_cache: false,
      horizon_days: 16,
      unit_system: "metric",
      destination_resolved_as: "Barcelona",
      origin_resolved_as: "Berlin",
      archive_provider: null,
      archive_years_used: [],
      data_classes: ["forecast", "computed_statistic"],
    },
    partial_failures: [
      {
        section: "historical_baseline",
        reason: "Weathra holds no archive observations for this calendar period at this place.",
        code: "no_data_for_range",
      },
    ],
  },

  /*
   * The evidence log: the runs this account has, as `GET /evidence` returns them.
   *
   * Two records rather than one, because a list of one photographs as a card and says nothing
   * about how rows sit together — and one of them partial, because that badge is a real state the
   * capture should carry. Both ids resolve to records this stub also serves.
   */
  "/api/v1/evidence": {
    limit: 20,
    returned: 2,
    records: [
      {
        id: "run-stub",
        created_at: "2026-09-04T09:02:40Z",
        question: "Why does forecast confidence fall the further ahead you look?",
        answer_preview:
          "Forecast skill declines with lead time because small errors in the initial state grow, so a figure six hours out is firmer than the same figure six days out.",
        duration_ms: 1980,
        partial: false,
        weather_provider: null,
        llm_model: "stub-model",
        steps: 3,
        locations: [],
      },
      {
        id: "run-e2e-1",
        created_at: "2026-09-04T06:15:05Z",
        question: "What should I expect over the next few days?",
        answer_preview:
          "Berlin is running warmer than usual this week: the mean of 17.9 °C sits above the four-year baseline for the same week, by 1.5 °C.",
        duration_ms: 4210,
        partial: false,
        weather_provider: "stub-provider",
        llm_model: "stub-model",
        steps: 6,
        locations: ["Berlin, Germany"],
      },
    ],
  },

  /*
   * A *conceptual* run: a question answered from the knowledge corpus, with no weather retrieval.
   *
   * The shape production actually produces most often, and the one the layout has to handle well:
   * three agents, no tool calls, no providers, no statistics, and citations carrying the whole
   * answer. Photographing only the rich six-agent run hid how much space the empty categories were
   * taking on this one.
   */
  "/api/v1/evidence/run-stub": {
    id: "run-stub",
    request_id: "req-stub",
    thread_id: "thread-stub",
    question: "Why does forecast confidence fall the further ahead you look?",
    answer_prose:
      "Forecast skill declines with lead time because small errors in the initial state grow. A figure six hours out is firmer than the same figure six days out, which is why Weathra states a horizon beside a confidence rather than a single number for a whole window.",
    envelope: {
      request_id: "req-stub",
      answer_prose:
        "Forecast skill declines with lead time because small errors in the initial state grow. A figure six hours out is firmer than the same figure six days out, which is why Weathra states a horizon beside a confidence rather than a single number for a whole window.",
      prose_data_class: "ai_interpretation",
      findings: [],
      attribution: [],
      resolved: null,
      grounding: {
        verified: true,
        method: "figures extracted from the prose and matched within 0.05",
        figures_checked: 0,
        ungrounded_figures: [],
        prose_discarded: false,
      },
      unanswered_parts: [],
    },
    evidence: {
      question: "Why does forecast confidence fall the further ahead you look?",
      agents: [
        { sequence: 1, agent: "supervisor", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 90, reason: "Routed to knowledge: the question asks for an explanation, not a retrieval." },
        { sequence: 2, agent: "rag", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 210, reason: "Retrieved two passages on forecast skill and lead time." },
        { sequence: 3, agent: "synthesis", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 1680 },
      ],
      tool_calls: [],
      tool_results: [],
      analytics_results: [],
      anomaly_reports: [],
      trend_reports: [],
      citations: [
        {
          document_id: "forecast-uncertainty.md",
          title: "Why forecast confidence falls with horizon distance",
          topic: "uncertainty",
          chunk_position: 1,
          score: 0.88,
          text: "Forecast skill declines with lead time because small errors in the initial state grow. Two runs started from almost the same atmosphere diverge, slowly at first and then quickly, so the spread between plausible outcomes widens the further ahead the model is asked to look. This is a property of the atmosphere rather than a limitation of any one provider, and it is why a forecast for tomorrow afternoon is worth more than the same forecast issued for a fortnight away.",
        },
        {
          document_id: "ensemble-spread.md",
          title: "What an ensemble spread describes",
          topic: "uncertainty",
          chunk_position: 3,
          score: 0.74,
          text: "An ensemble runs the same model many times from slightly different starting states. The spread between those members is a measure of how sensitive the outcome is to what was not known precisely at the start. A narrow spread means the members agree; a wide one means small differences at the beginning led somewhere very different, and the single headline number deserves less weight.",
        },
      ],
      attributions: [],
      data_classes: ["ai_interpretation"],
      llm_provider: "stub-gateway",
      llm_model: "stub-model",
      started_at: RETRIEVED_AT,
      completed_at: "2026-09-04T09:02:42Z",
      total_duration_ms: 1980,
      steps_used: 3,
      partial: false,
      partial_reason: null,
    },
    llm_provider: "stub-gateway",
    llm_model: "stub-model",
    weather_provider: null,
    duration_ms: 1980,
    partial: false,
    created_at: "2026-09-04T09:02:40Z",
  }
};

/* ---------------------------------------- task 21.10: the streamed run and its record */

/** Where the streamed run's evidence is stored. The Analyst only ever links to what it is given. */
const STREAM_EVIDENCE_ID = "run-e2e-1";

/**
 * The answer, in the pieces the stream delivers it in.
 *
 * Split mid-sentence on purpose: `use-agent-stream.ts` accumulates `answer_delta` text, and pieces
 * that each happened to be a whole sentence would not show whether the accumulation is right.
 */
const ANSWER_PIECES = [
  "Berlin is running warmer than usual this week: the mean of 17.9 °C ",
  "sits above the four-year baseline for the same week, ",
  "by 1.5 °C. Daily highs reach 24.5 °C and lows hold at 11.2 °C, ",
  "so the warmth is steady rather than a single spike. ",
  "6.4 mm of rain is forecast across the window, and confidence is high ",
  "through the next 6 hours and lower further out.",
];

const STREAM_ANSWER_PROSE = ANSWER_PIECES.join("");

/**
 * The envelope the terminal `final` event carries, in the shape `AnswerEnvelope` declares —
 * `request_id`, `answer_prose`, `grounding` and `evidence` required, the rest optional.
 *
 * Grounded and verified, because the flow asserts that the provenance boundary is still legible on
 * the answer: prose badged as interpretation, figures attributed, and the grounding verdict stated.
 */
/**
 * The clarification the real backend produces when its resolution ladder reaches the bottom.
 *
 * `weathra/agents/context.py` asks — never guesses — when the question names no place, the caller
 * sent no focus, the thread has established nothing and no default is saved. Modelling that here
 * rather than always answering is what lets the harness photograph the state the 2026-09-12 review
 * rejected the screen for, and it is the same rule rather than a special case: clear the default
 * through the real `PUT /me/preferences`, ask a question that names nowhere, and this is what comes
 * back — nothing retrieved, nothing computed, no prose.
 */
function clarificationEnvelope(requestId, question) {
  return {
    request_id: requestId,
    thread_id: "thread-e2e",
    answer_prose: "",
    prose_data_class: "ai_interpretation",
    findings: [],
    attribution: [],
    citations: [],
    resolved: {
      locations: [],
      period: null,
      unit_system: "metric",
      location_source: "none",
      units_source: "preferences",
      statement: null,
    },
    grounding: {
      verified: false,
      method: "figures extracted from the prose and matched within 0.05",
      figures_checked: 0,
      ungrounded_figures: [],
      prose_discarded: false,
    },
    uncertainty: null,
    unanswered_parts: [],
    clarification_question:
      "Which place should Weathra look at? The question does not name one, there is no location established in this conversation, and no default location is saved.",
    llm_provider: "stub-gateway",
    llm_model: "stub-model",
    evidence: { ...EVIDENCE_RECORD, request_id: requestId, question, agents: [], tool_calls: [] },
  };
}

/**
 * Whether this run has any place at all to work with, in the backend's own order.
 *
 * A focus on the request, a place named in the question, or a saved default. None of the three is
 * the clarification case; any of them answers.
 */
/**
 * Whether this question asks what it is like *now* — the stub's model of the router's judgement.
 *
 * `Capability.CURRENT` joined the catalog in task 34.33, and with it the planner's decision about
 * when a reading of the present helps. A stub that returned current conditions for every question
 * would photograph a product that retrieves them unconditionally, which is precisely what the
 * capability was asked *not* to do; one that never returned them would photograph the gap it was
 * added to close. So it reads the question the way `plan.py`'s deterministic router reads it.
 */
function asksAboutNow(body) {
  const question = typeof body?.question === "string" ? body.question : "";
  return /\b(right now|now|currently|current|at the moment|outside)\b/i.test(question);
}

/** Whether this question asked to *see* something — the stub's model of the satellite router. */
function asksAboutSatellite(body) {
  const question = typeof body?.question === "string" ? body.question : "";
  return /\b(satellite|imagery|observational)\b/i.test(question);
}

function hasAPlace(body) {
  if (typeof body?.location === "string" && body.location.trim() !== "") return true;
  const question = typeof body?.question === "string" ? body.question : "";
  if (/berlin|munich|münchen|london|tokyo|new york|paris/i.test(question)) return true;
  return preferences?.default_location != null;
}

/**
 * The current-conditions block, as `findings_from_current` transcribes one.
 *
 * A value and a unit per measure the provider reported, each labelled and each of data class
 * `current`. The condition arrives as the provider's own WMO code with the unit the domain gives a
 * code, because the vocabulary that turns 3 into "Overcast" lives in `lib/weather/condition.ts` and
 * the backend deliberately has no second copy of it.
 */
const CURRENT_ATTRIBUTION = {
  ...ATTRIBUTION,
  data_class: "current",
  timestamp_utc: "2026-09-04T06:00:00Z",
};

const CURRENT_FINDINGS = [
  { label: "Temperature", value: 15.3, unit: "°C", data_class: "current", attribution: CURRENT_ATTRIBUTION },
  { label: "Condition", value: 3, unit: "WMO code", data_class: "current", attribution: CURRENT_ATTRIBUTION },
  { label: "Humidity", value: 68, unit: "%", data_class: "current", attribution: CURRENT_ATTRIBUTION },
  { label: "Wind speed", value: 12.4, unit: "km/h", data_class: "current", attribution: CURRENT_ATTRIBUTION },
  { label: "Feels like", value: 14.1, unit: "°C", data_class: "current", attribution: CURRENT_ATTRIBUTION },
  { label: "Precipitation", value: 0, unit: "mm", data_class: "current", attribution: CURRENT_ATTRIBUTION },
];

/** The briefing a run that read the present and the days ahead writes, in streamed pieces. */
const NOW_ANSWER_PIECES = [
  "Berlin is 15.3 °C right now, ",
  "with 68 % humidity and a 12.4 km/h wind. ",
  "The days ahead stay in that range: highs reach 24.5 °C and lows hold at 11.2 °C, ",
  "with 6.4 mm of rain forecast across the window. ",
  "Confidence is high through the next 6 hours and lower further out.",
];

const NOW_ANSWER_PROSE = NOW_ANSWER_PIECES.join("");

function answerEnvelope(requestId, question) {
  return {
    request_id: requestId,
    thread_id: "thread-e2e",
    answer_prose: STREAM_ANSWER_PROSE,
    prose_data_class: "ai_interpretation",
    /*
     * The figures the answer opens out into, in the shape a real run of this question produces.
     *
     * It was three findings — one "current" reading, one forecast figure and one computed mean —
     * and the first of those was the harness modelling a capability the graph does not have:
     * `agents/plan.py` closes the capability set at forecast, historical, analytics and rag, and
     * none of them calls `weather_current`. A stub that answers with an observation the backend
     * cannot retrieve makes every capture of the Observed panel a picture of something production
     * never shows, which is the fabrication this whole pass exists to keep out.
     *
     * What a run of this question genuinely produces: the forecast tool's own analysis of the
     * window — `weather/forecast_service.py` computes the extremes, the precipitation total, the
     * wind and the hourly humidity and pressure, each as a `StatisticResult` with its method — and
     * the analytics node's comparison against the archive baseline. Six forecast figures and three
     * computed ones, which is also what makes the panels' four-figure headline and their "2 more
     * figures" disclosure worth photographing.
     */
    findings: [
      {
        label: "Highest daily high temperature",
        value: 24.5,
        unit: "°C",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Lowest daily low temperature",
        value: 11.2,
        unit: "°C",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Total precipitation",
        value: 6.4,
        unit: "mm",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Highest peak wind gust",
        value: 38,
        unit: "km/h",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Average relative humidity",
        value: 71,
        unit: "%",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Average pressure",
        value: 1014,
        unit: "hPa",
        data_class: "forecast",
        attribution: { ...ATTRIBUTION, period: PERIOD },
      },
      {
        label: "Mean temperature this week",
        value: 17.9,
        unit: "°C",
        data_class: "computed_statistic",
        method: "arithmetic mean of usable points",
        points_used: 48,
        supporting: statistic("mean", "temperature", 17.9, "°C", "arithmetic mean of usable points"),
        attribution: { ...ATTRIBUTION, data_class: "computed_statistic", period: PERIOD },
      },
      {
        label: "Four-year mean for the same week",
        value: 16.4,
        unit: "°C",
        data_class: "computed_statistic",
        method: "arithmetic mean of the same calendar week across four archive years",
        points_used: 28,
        attribution: { ...ATTRIBUTION, data_class: "computed_statistic", period: PERIOD },
      },
      {
        label: "Difference from the baseline",
        value: 1.5,
        unit: "°C",
        data_class: "computed_statistic",
        method: "the value being compared minus the baseline",
        points_used: 76,
        attribution: { ...ATTRIBUTION, data_class: "computed_statistic", period: PERIOD },
      },
    ],
    /*
     * What the answer cites, by role. The archive row is here because the historical agent read it;
     * the computed figures rest on both and are credited to Weathra's analytics in the rail rather
     * than to a provider that did not do the arithmetic.
     */
    attribution: [
      { ...ATTRIBUTION, period: PERIOD },
      { ...ATTRIBUTION, data_class: "historical_observation", period: PERIOD },
    ],
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
      // The six figures the prose states: 17.9, 1.5, 24.5, 11.2, 6.4 and the 6-hour horizon.
      figures_checked: 6,
      ungrounded_figures: [],
      prose_discarded: false,
    },
    uncertainty: UNCERTAINTY,
    unanswered_parts: [],
    clarification_question: null,
    llm_provider: "stub-gateway",
    llm_model: "stub-model",
    evidence: { ...EVIDENCE_RECORD, request_id: requestId, question },
  };
}

/**
 * One retrieved satellite observation, in the shape `weather_satellite` returns.
 *
 * **The image is a data URI here, and in production it is the provider's own URL.** The capture
 * harness answers every request itself so a photograph of a screen does not depend on a third
 * party being up — pointing this at NASA would put a live fetch inside a deterministic capture.
 * Everything else is the real shape: the provider, the product, the instrument, the UTC day, the
 * box, the acknowledgement NASA asks for, and the sentence saying nothing interpreted it.
 */
const SATELLITE_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
       <rect width="640" height="640" fill="#0f1a24"/>
       <g fill="#dfe8f0" opacity="0.82">
         <ellipse cx="180" cy="150" rx="120" ry="60"/><ellipse cx="300" cy="120" rx="90" ry="44"/>
         <ellipse cx="470" cy="230" rx="140" ry="70"/><ellipse cx="250" cy="400" rx="110" ry="55"/>
         <ellipse cx="430" cy="470" rx="150" ry="72"/><ellipse cx="120" cy="520" rx="95" ry="48"/>
       </g>
       <g fill="#31502f" opacity="0.9">
         <rect x="0" y="300" width="120" height="80" rx="24"/>
         <rect x="520" y="60" width="120" height="90" rx="28"/>
       </g>
     </svg>`,
  );

const SATELLITE_ATTRIBUTION =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse " +
  "Services (GIBS), part of NASA's Earth Observing System Data and Information System (EOSDIS).";

const SATELLITE_ATTRIBUTION_BLOCK = {
  ...ATTRIBUTION,
  // The satellite source, not the weather one. `weather_satellite` builds its attribution from the
  // observation it retrieved, so the two agree by construction in production; a stub that spread the
  // weather provider's id over it made the rail unable to match the row to its observation, which is
  // exactly the defect a capture is for.
  provider: "nasa-gibs",
  data_class: "satellite_observation",
  period: null,
  timestamp_utc: "2026-09-12T07:59:23Z",
};

const SATELLITE_OBSERVATION = {
  data_class: "satellite_observation",
  location: BERLIN,
  coverage: { south: 50.52, west: 11.405, north: 54.52, east: 15.405 },
  provider: "nasa-gibs",
  product: "Corrected Reflectance (True Colour)",
  instrument: "VIIRS on NOAA-20",
  observed_date: "2026-09-11",
  retrieved_at: "2026-09-12T07:59:23Z",
  image_url: SATELLITE_IMAGE,
  image_media_type: "image/svg+xml",
  image_bytes: 91533,
  attribution: SATELLITE_ATTRIBUTION,
  source_url: "https://nasa-gibs.github.io/gibs-api-docs/",
  coverage_note:
    "Covers roughly 4° of latitude around Berlin, Germany — the region, not the place.",
  freshness_note:
    "A daily composite for 2026-09-11 (UTC). It is not a live view, and a true-colour composite shows nothing on the night side.",
  interpretation_note:
    "Weathra retrieves and displays this imagery. It does not interpret it: no image analysis was performed, and nothing in this answer is derived from the picture.",
};

/** The briefing a run that read imagery and the window ahead writes, in streamed pieces. */
const SATELLITE_ANSWER_PIECES = [
  "The latest satellite imagery available for Berlin is NASA's daily composite for ",
  "11 September, retrieved alongside this week's forecast. ",
  "The forecast itself puts daily highs at 24.5 °C and lows at 11.2 °C, ",
  "with 6.4 mm of rain across the window. ",
  "The imagery is observational context and has not been interpreted.",
];

const SATELLITE_ANSWER_PROSE = SATELLITE_ANSWER_PIECES.join("");

/**
 * The briefing a run that read the present, the window ahead *and* imagery writes.
 *
 * One question can ask for all three, and the router can truthfully plan all three — so the harness
 * has to be able to model that rather than picking one. Three exclusive envelopes could not
 * photograph the state the final composition is judged on.
 */
const ALL_THREE_PIECES = [
  "Berlin is 15.3 °C right now, with 68 % humidity and a 12.4 km/h wind. ",
  "The days ahead stay in that range: highs reach 24.5 °C and lows hold at 11.2 °C, ",
  "with 6.4 mm of rain forecast across the window. ",
  "The latest satellite imagery available for the region is NASA's daily composite for 11 September; ",
  "it is observational context and has not been interpreted.",
];

/**
 * The envelope for whatever combination of capabilities the question asked for.
 *
 * Composed from the forecast answer rather than written beside it, so the parts every run shares —
 * the resolution, the uncertainty, the window — cannot drift between the combinations.
 */
function composedEnvelope(requestId, question, { wantsNow, wantsImagery }) {
  const base = answerEnvelope(requestId, question);
  const forecastFindings = (base.findings ?? []).filter(
    (finding) => finding.data_class === "forecast",
  );

  const findings = [...(wantsNow ? CURRENT_FINDINGS : []), ...forecastFindings];
  const attribution = [
    ...(wantsNow ? [CURRENT_ATTRIBUTION] : []),
    { ...ATTRIBUTION, period: PERIOD },
    ...(wantsImagery ? [SATELLITE_ATTRIBUTION_BLOCK] : []),
  ];

  let sequence = 0;
  const step = (agent, duration, reason) => ({
    sequence: (sequence += 1),
    agent,
    status: "succeeded",
    started_at: RETRIEVED_AT,
    duration_ms: duration,
    reason,
  });

  let toolSequence = 0;
  const call = (tool, agent, args, duration) => ({
    sequence: (toolSequence += 1),
    tool,
    agent,
    arguments: args,
    started_at: RETRIEVED_AT,
    duration_ms: duration,
  });

  const place = { latitude: 52.52, longitude: 13.405 };

  return {
    ...base,
    answer_prose:
      wantsNow && wantsImagery
        ? ALL_THREE_PIECES.join("")
        : wantsImagery
          ? SATELLITE_ANSWER_PROSE
          : NOW_ANSWER_PROSE,
    findings,
    satellite: wantsImagery ? [SATELLITE_OBSERVATION] : [],
    attribution,
    resolved: {
      ...base.resolved,
      statement: "Berlin, Germany, for this week, from your saved default location.",
    },
    grounding: { ...base.grounding, figures_checked: wantsNow ? 7 : 4 },
    evidence: {
      ...base.evidence,
      agents: [
        step("supervisor", 110, "Planned what the question asked for."),
        ...(wantsNow ? [step("current", 240, "Read the current conditions.")] : []),
        step("forecast", 840, "Retrieved the window."),
        ...(wantsImagery
          ? [step("satellite", 640, "Retrieved the latest available imagery.")]
          : []),
        step("synthesis", 900),
      ],
      tool_calls: [
        ...(wantsNow ? [call("weather_current", "current", { ...place, units: "metric" }, 240)] : []),
        call("weather_forecast", "forecast", { ...place, days: 7 }, 840),
        ...(wantsImagery ? [call("weather_satellite", "satellite", place, 640)] : []),
      ],
      citations: [],
      attributions: attribution,
      data_classes: [
        ...(wantsNow ? ["current"] : []),
        "forecast",
        ...(wantsImagery ? ["satellite_observation"] : []),
        "ai_interpretation",
      ],
    },
  };
}

/** Read a JSON request body, or `{}` when there is none this stub can use. */
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, x-request-id",
  "Access-Control-Expose-Headers": "x-request-id",
  "Access-Control-Max-Age": "86400",
};

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", ...CORS });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

/** Weathra's error envelope, exactly as `api/errors.py` returns it. */
function envelope(response, status, code, message) {
  send(response, status, {
    error: { code, message, details: null, request_id: "e2e-request" },
  });
}

/* ------------------------------------------------ task 21.10: state a flow can change */

/**
 * The two durable things `specs/memory` calls long-term memory, held mutably.
 *
 * Task 21.10's third flow saves a location and then observes a unit preference being applied, so
 * a read-only fixture cannot answer it: the flow's whole point is that a write is visible in a
 * later read. Seeded from the same fixtures every other spec reads, and reset by
 * `/control/restore`, so no flow inherits another's writes.
 */
let savedLocations = null;
let preferences = null;

function resetState() {
  savedLocations = FIXTURES["/api/v1/me/locations"].locations.map((entry) => ({ ...entry }));
  preferences = { ...FIXTURES["/api/v1/me/preferences"] };
}
resetState();

/** The stored preference view, in the shape `PreferenceView` declares. */
function preferenceView() {
  return { ...preferences };
}

function savedLocationsView() {
  return { count: savedLocations.length, limit: 20, locations: savedLocations };
}

/* ------------------------------------------------ task 21.10: units actually applied */

/**
 * The unit system a request asked for, and the conversion that makes it observable.
 *
 * The real backend converts and states the unit it converted to; a stub that always answered in
 * Celsius would let the third flow "pass" with the preference saved and nothing applied. Only the
 * two measures the Dashboard shows a unit for are converted — this is a stand-in, not a units
 * library.
 */
function requestedUnits(url) {
  return url.searchParams.get("units") === "imperial" ? "imperial" : "metric";
}

function toFahrenheit(celsius) {
  // One decimal, because `Math.round` takes no precision argument and a silently integral
  // temperature would be a different claim from the one the backend makes.
  return Math.round(((celsius * 9) / 5 + 32) * 10) / 10;
}

/** Re-express a fixture's `units` map and `values`/`daily` figures in the requested system. */
function inUnits(fixture, units) {
  if (units !== "imperial") return fixture;

  const converted = JSON.parse(JSON.stringify(fixture));
  const relabel = (map) => {
    if (!map || typeof map !== "object") return map;
    for (const key of Object.keys(map)) {
      if (map[key] === "°C") map[key] = "°F";
      if (map[key] === "km/h") map[key] = "mph";
      if (map[key] === "mm") map[key] = "in";
    }
    return map;
  };
  const convertTemperatures = (values) => {
    if (!values || typeof values !== "object") return values;
    for (const key of Object.keys(values)) {
      if (/temperature/.test(key) && typeof values[key] === "number") {
        values[key] = toFahrenheit(values[key]);
      }
    }
    return values;
  };

  relabel(converted.units);
  convertTemperatures(converted.values);
  if (Array.isArray(converted.daily)) {
    for (const day of converted.daily) {
      relabel(day.units);
      convertTemperatures(day.values);
    }
  }
  if (Array.isArray(converted.periods)) {
    for (const period of converted.periods) {
      relabel(period.units);
      convertTemperatures(period.values);
    }
  }
  return converted;
}


/* --------------------------------------------------- one fixture, two places (task 34.31)
 *
 * Every weather fixture here is a single body served for any coordinate, which is right for the
 * screens that read one place and wrong for the one that reads two: Compare Cities photographed
 * with this stub showed Berlin and Munich agreeing to the decimal on every figure on the page, so
 * the capture said nothing about whether the screen renders a *difference*.
 *
 * This shifts a point read by a small amount derived from the coordinates themselves. It is
 * deterministic — the same place is the same shift on every run, so a capture is reproducible — and
 * it is confined to this stub. **No product code knows about it**, and nothing in the application
 * derives a figure from a coordinate; the shift exists so that two places look like two places in
 * a screenshot, which is the only thing it is for.
 */

/** A small signed offset for a point, stable across runs. Zero where no point was asked for. */
function placeOffset(url) {
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  // A hash of the rounded point, mapped to [-2.4, +2.4] in quarter steps.
  const seed = Math.abs(Math.round(latitude * 100) * 31 + Math.round(longitude * 100) * 17);
  return ((seed % 20) - 10) * 0.24;
}

/** The measures worth shifting: the ones two cities visibly differ on. */
const SHIFTED = new Set([
  "temperature",
  "temperature_max",
  "temperature_min",
  "temperature_mean",
  "apparent_temperature",
  "relative_humidity",
  "wind_speed",
]);

function shiftValues(values, offset) {
  if (values === null || typeof values !== "object") return values;
  const shifted = {};
  for (const [key, value] of Object.entries(values)) {
    shifted[key] =
      typeof value === "number" && SHIFTED.has(key)
        ? Math.round((value + offset) * 10) / 10
        : value;
  }
  return shifted;
}

/** The stub's own "today", so a window is ahead or behind the same instant in every run. */
const STUB_TODAY = RETRIEVED_AT.slice(0, 10);

/** Whether the requested window ends on or after the stub's today — the route's own branch. */
function windowIsAhead(url) {
  const end = url.searchParams.get("end");
  return typeof end === "string" && end >= STUB_TODAY;
}

/**
 * The same comparison, stated as the forecast-sided one it is for a window still ahead.
 *
 * Only the three things the real branch changes: which side supplied the value, the caveat that
 * travels with it, and a characterization that does not call a forecast an observation. The
 * baseline itself is untouched, because the archive side is the archive side either way.
 */
function forecastSided(fixture) {
  if (fixture === null || typeof fixture !== "object") return fixture;
  return {
    ...structuredClone(fixture),
    observed_data_class: "forecast",
    forecast_side_caveat:
      "One side of this comparison is a forecast and is therefore uncertain; the baseline side is built from observed archive data.",
  };
}

function byPlace(fixture, url) {
  const offset = placeOffset(url);
  if (offset === 0 || fixture === null || typeof fixture !== "object") return fixture;

  const shifted = structuredClone(fixture);

  if (shifted.values) shifted.values = shiftValues(shifted.values, offset);
  for (const key of ["hourly", "daily"]) {
    const series = shifted[key];
    if (!series?.entries) continue;
    series.entries = series.entries.map((entry) => ({
      ...entry,
      values: shiftValues(entry.values, offset),
    }));
  }
  // The baseline's own figures, so each place sits against its own archive rather than a shared one.
  for (const key of ["mean", "minimum", "maximum"]) {
    const statistic = shifted[key];
    if (statistic && typeof statistic.value === "number") {
      statistic.value = Math.round((statistic.value + offset) * 10) / 10;
    }
  }
  if (Array.isArray(shifted.yearly_means)) {
    shifted.yearly_means = shifted.yearly_means.map((point) => ({
      ...point,
      value:
        typeof point.value === "number" ? Math.round((point.value + offset) * 10) / 10 : point.value,
    }));
  }
  return shifted;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (path === "/control/health") {
    send(response, 200, { ok: true, serving, requests: seen.length });
    return;
  }
  if (path === "/control/revoke") {
    serving = false;
    send(response, 200, { serving });
    return;
  }
  if (path === "/control/restore") {
    serving = true;
    mode = "populated";
    seen = [];
    // Task 21.10: a flow's saved location and preference must not survive into the next flow.
    resetState();
    send(response, 200, { serving, mode });
    return;
  }
  if (path === "/control/mode") {
    const wanted = url.searchParams.get("value") ?? "populated";
    if (!MODES.has(wanted)) {
      envelope(response, 400, "unknown_mode", `No such stub mode: ${wanted}.`);
      return;
    }
    mode = wanted;
    send(response, 200, { serving, mode });
    return;
  }
  if (path === "/control/requests") {
    send(response, 200, { requests: seen });
    return;
  }

  if (!path.startsWith("/api/v1/")) {
    envelope(response, 404, "route_not_found", "No such stub route.");
    return;
  }

  // Recorded before the decision, so a refused call is logged as having arrived — which is what
  // makes "the browser really did present a token to the backend" assertable.
  seen.push({
    method: request.method ?? "GET",
    path,
    authenticated: /^Bearer\s+\S/i.test(request.headers.authorization ?? ""),
  });

  if (!serving) {
    // The code Weathra's own token validation returns for a session that is no longer valid, and
    // one of the codes `lib/api/errors.ts` recognises as an authentication failure.
    envelope(response, 401, "token_expired", "The access token has expired.");
    return;
  }

  /*
   * The two states that answer every call the same way, before any route is matched.
   *
   * `stalling` deliberately never responds and never closes: a screen photographed mid-flight is
   * the loading state, and a stub that answered slowly would be a race rather than a state. The
   * socket is left to the browser and to Playwright's own teardown.
   */
  if (mode === "stalling") return;
  if (mode === "failing") {
    envelope(
      response,
      503,
      "provider_unavailable",
      "The weather provider did not answer within the time allowed. Try again shortly.",
    );
    return;
  }

  /* --------------------------------------- task 21.10: the Analyst's streamed run */

  /**
   * `POST /api/v1/agent/stream` — the event stream the Analyst renders progress from.
   *
   * The framing is the production framing, taken from `backend/weathra/api/streaming.py`: a named
   * event and one JSON data line per block, every payload carrying `sequence` (monotonic from 1)
   * and `request_id`, and the vocabulary limited to the eight event types the backend emits. The
   * sequence matters as much as the names — `use-agent-stream.ts` reports a *gap* if the numbers
   * are not contiguous, so a stub that skipped one would show the interrupted state.
   *
   * Written a frame at a time with a small delay, because a stream delivered as one chunk would
   * never exercise the incremental rendering this flow is about.
   */
  if (path === "/api/v1/agent/stream" && (request.method ?? "GET") === "POST") {
    void (async () => {
      const body = await readJson(request);
      const requestId = "e2e-run-1";
      let sequence = 0;
      const frame = (type, data) => {
        sequence += 1;
        const payload = JSON.stringify({ sequence, request_id: requestId, ...data });
        response.write(`event: ${type}\ndata: ${payload}\n\n`);
      };

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        // The same directives the backend sends: an intermediary that buffered would hold every
        // event until the run finished, which defeats the endpoint.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...CORS,
      });

      const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

      /*
       * Two plans, because the router has two answers — task 34.33.
       *
       * A question about now routes to `current` and `forecast`; one comparing this week with the
       * archive routes to `forecast`, `historical` and `analytics` and to no current step at all.
       * Streaming one fixed plan for both would photograph a product that retrieves the present
       * unconditionally, which is the behaviour the capability was explicitly not to have.
       */
      const wantsImagery = asksAboutSatellite(body);
      const wantsNow = asksAboutNow(body);
      const composed = wantsImagery || wantsNow;
      const plan = composed
        ? [
            ...(wantsNow ? [["current", "weather_current"]] : []),
            ["forecast", "weather_forecast"],
            ...(wantsImagery ? [["satellite", "weather_satellite"]] : []),
          ]
        : [
            ["forecast", "weather_forecast"],
            ["historical", "weather_history"],
            ["analytics", "weather_baseline_comparison"],
          ];

      frame("routing", {
        capabilities: plan.map(([agent]) => agent),
        source: "model",
        reason: wantsImagery
          ? "The question asks to see observational imagery alongside the window ahead."
          : wantsNow
            ? "The question asks what it is like now and what is coming."
            : "The question asks for this week against the record.",
      });
      await pause();

      /*
       * No capability node runs when the ladder found no place, so none is announced.
       *
       * The backend refuses in resolution, *before* dispatch: a clarification run genuinely names
       * no agent and calls no tool. A stub that streamed them anyway would have the rail listing
       * four agents beside a reply that retrieved nothing — which is close to the defect the
       * review found, arrived at from the other side.
       */
      if (hasAPlace(body)) {
        for (const [agent, tool] of plan) {
          frame("agent_start", { agent, reason: null });
          await pause();
          frame("tool_start", { tool, agent });
          await pause();
          frame("tool_end", { tool, ok: true, duration_ms: 120 });
          frame("agent_end", { agent, status: "ok", duration_ms: 180 });
          await pause();
        }

        frame("agent_start", { agent: "synthesis", reason: null });
        const pieces =
          wantsNow && wantsImagery
            ? ALL_THREE_PIECES
            : wantsImagery
              ? SATELLITE_ANSWER_PIECES
              : wantsNow
                ? NOW_ANSWER_PIECES
                : ANSWER_PIECES;
        for (const piece of pieces) {
          frame("answer_delta", { text: piece });
          await pause();
        }
        frame("agent_end", { agent: "synthesis", status: "ok", duration_ms: 210 });
        await pause();
      }

      // The terminal event, carrying the envelope and the identifier the record is stored under.
      // The Analyst offers its evidence link from this identifier and nothing else, so the flow
      // cannot reach the record except through an id the run itself produced.
      frame("final", {
        answer: !hasAPlace(body)
          ? clarificationEnvelope(requestId, typeof body.question === "string" ? body.question : "")
          : composed
            ? composedEnvelope(
                requestId,
                typeof body.question === "string" ? body.question : "",
                { wantsNow, wantsImagery },
              )
            : answerEnvelope(requestId, typeof body.question === "string" ? body.question : ""),
        evidence_id: STREAM_EVIDENCE_ID,
      });
      response.end();
    })();
    return;
  }

  /** `POST /api/v1/agent/ask` — the same run, unstreamed, as the client interface declares. */
  if (path === "/api/v1/agent/ask" && (request.method ?? "GET") === "POST") {
    void (async () => {
      const body = await readJson(request);
      send(response, 200, {
        answer: answerEnvelope("e2e-run-1", typeof body.question === "string" ? body.question : ""),
        evidence_id: STREAM_EVIDENCE_ID,
      });
    })();
    return;
  }

  /* ------------------------------- task 21.10: the writes long-term memory needs */

  if (path === "/api/v1/me/locations" && (request.method ?? "GET") === "POST") {
    void (async () => {
      const body = await readJson(request);
      const place =
        body.location && typeof body.location === "object"
          ? body.location
          : { ...MUNICH, display_name: "Hamburg", region: "Hamburg", latitude: 53.55, longitude: 9.99 };
      const label = typeof body.label === "string" && body.label !== "" ? body.label : null;

      // A place already saved is updated rather than duplicated, and says so — which is what the
      // screen's "already saved; its label is updated" message reads.
      const existing = savedLocations.find(
        (entry) => entry.location?.display_name === place.display_name,
      );
      if (existing) {
        existing.label = label;
        send(response, 200, { ...existing, created_now: false });
        return;
      }

      const record = { id: `s-${savedLocations.length + 1}-e2e`, location: place, label };
      savedLocations.push(record);
      send(response, 201, { ...record, created_now: true });
    })();
    return;
  }

  if (/^\/api\/v1\/me\/locations\/[^/]+$/.test(path) && (request.method ?? "GET") === "DELETE") {
    const savedId = path.split("/").pop();
    savedLocations = savedLocations.filter((entry) => entry.id !== savedId);
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (path === "/api/v1/me/preferences" && (request.method ?? "GET") === "PUT") {
    void (async () => {
      const body = await readJson(request);
      if (typeof body.unit_system === "string") preferences.unit_system = body.unit_system;
      if (typeof body.forecast_horizon_days === "number") {
        preferences.forecast_horizon_days = body.forecast_horizon_days;
      }
      if (body.default_location && typeof body.default_location === "object") {
        preferences.default_location = body.default_location;
      }
      if (body.clear_default_location === true) preferences.default_location = null;
      send(response, 200, preferenceView());
    })();
    return;
  }

  if (path === "/api/v1/me/preferences" && (request.method ?? "GET") === "DELETE") {
    resetState();
    send(response, 200, preferenceView());
    return;
  }

  /*
   * A new account, in the shapes the contract declares.
   *
   * Field by field rather than a hand-written literal, because the audit's own throwaway fixture
   * got `{saved: []}` where the contract says `{locations: []}` and crashed all seven signed-in
   * screens — §2 of `docs/design/runtime-fidelity-audit.md`. Spreading the served view keeps the
   * shape correct by construction: only the emptied fields differ from what the app already
   * handles, so an empty state cannot fail for a reason the product does not have.
   */
  if (mode === "empty") {
    if (path === "/api/v1/me/preferences") {
      send(response, 200, { ...preferenceView(), default_location: null });
      return;
    }
    if (path === "/api/v1/me/locations") {
      send(response, 200, { ...savedLocationsView(), count: 0, locations: [] });
      return;
    }
    if (path === "/api/v1/me") {
      send(response, 200, {
        ...FIXTURES["/api/v1/me"],
        created_now: true,
        preferences: { ...FIXTURES["/api/v1/me"].preferences, default_location: null },
      });
      return;
    }
    if (path === "/api/v1/threads") {
      send(response, 200, { ...FIXTURES["/api/v1/threads"], count: 0, threads: [] });
      return;
    }
  }

  // The reads that must reflect the writes above rather than the seed fixture.
  if (path === "/api/v1/me/preferences") {
    send(response, 200, preferenceView());
    return;
  }
  if (path === "/api/v1/me/locations") {
    send(response, 200, savedLocationsView());
    return;
  }

  /**
   * The record the streamed run stored — task 21.10's second flow.
   *
   * Built from the same envelope the `final` event carried, so what the evidence screen renders is
   * the record of the run the browser actually watched rather than an unrelated fixture. Served
   * only at the identifier the stream returned.
   */
  if (path === `/api/v1/evidence/${STREAM_EVIDENCE_ID}`) {
    const envelope = answerEnvelope("e2e-run-1", EVIDENCE_RECORD.question);
    send(response, 200, {
      id: STREAM_EVIDENCE_ID,
      request_id: envelope.request_id,
      thread_id: envelope.thread_id,
      question: EVIDENCE_RECORD.question,
      answer_prose: envelope.answer_prose,
      envelope,
      evidence: envelope.evidence,
      llm_provider: "stub-gateway",
      llm_model: "stub-model",
      weather_provider: "stub-provider",
      duration_ms: 4210,
      partial: false,
      created_at: "2026-09-04T06:15:05Z",
    });
    return;
  }

  /**
   * `GET /api/v1/locations/resolve` — ambiguous only where the name really is.
   *
   * The fixture answers every query with the Springfield ambiguity, which is what the accessibility
   * and 21.7 specs drive the chooser with and is kept exactly. But a geocoder does not find two
   * places for every name, and a stub that did would make an unambiguous name untestable — task
   * 21.10's third flow saves a place and cannot do so if every name stops for a choice first. So
   * "Springfield" stays ambiguous and anything else resolves, which is the production behaviour.
   */
  if (path === "/api/v1/locations/resolve") {
    const query = (url.searchParams.get("query") ?? "").trim();
    if (/springfield/i.test(query) || query === "") {
      send(response, 200, FIXTURES[path]);
      return;
    }
    send(response, 200, {
      kind: "resolved",
      query,
      location: {
        ...BERLIN,
        display_name: query,
        region: query,
      },
    });
    return;
  }

  const fixture = FIXTURES[path];
  if (fixture === undefined) {
    /**
     * An evidence identifier the stub does not hold answers the way the *backend* would, rather
     * than the way an unmodelled route would.
     *
     * The distinction is the whole point of that screen. `components/evidence/evidence.tsx`
     * branches on `evidence_not_found` to show the record-not-found state — the one that says an
     * identifier Weathra never stored and one stored for somebody else are answered identically,
     * which is what keeps the screen from disclosing whose record an id belongs to. A generic
     * `route_not_found` renders the ordinary error card instead, so without this the state task
     * 21.5 specifies is simply unreachable and could not be verified by anybody, automated or not.
     */
    if (/^\/api\/v1\/evidence\/[^/]+$/.test(path)) {
      envelope(response, 404, "evidence_not_found", "No evidence record with that identifier.");
      return;
    }
    envelope(response, 404, "route_not_found", `This stub does not model ${path}.`);
    return;
  }
  /*
   * A baseline comparison for a window still ahead is forecast-sided, as the route now answers it.
   *
   * `GET /weather/history/baseline/comparison` branches on whether the period has happened: a past
   * window is observation on both sides, and a window ending in the future takes its value from the
   * forecast and says so in `forecast_side_caveat`. Historical Analytics asks the first question and
   * Travel asks the second, so one canned body could only be truthful for one of them — and it was
   * the observation-sided one, which is why Travel's historical band was photographed carrying a
   * caveat-free comparison that production cannot produce for a trip.
   */
  if (path === "/api/v1/weather/history/baseline/comparison" && windowIsAhead(url)) {
    send(response, 200, byPlace(inUnits(forecastSided(fixture), requestedUnits(url)), url));
    return;
  }

  // Weather reads are answered in the unit system the request asked for, which is what makes a
  // saved unit preference observable on screen rather than merely stored — task 21.10, flow 3.
  //
  // …and, for a point read, offset by the point. See `byPlace`.
  send(
    response,
    200,
    path.startsWith("/api/v1/weather/")
      ? byPlace(inUnits(fixture, requestedUnits(url)), url)
      : fixture,
  );
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`weathra api stub listening on http://${HOST}:${PORT}\n`);
});
