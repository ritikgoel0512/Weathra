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
  horizon: [
    {
      confidence: "high",
      hours_ahead: 6,
      time_utc: "2026-09-04T12:00:00Z",
      time_local: "2026-09-04T14:00:00+02:00",
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
};

const EVIDENCE_RECORD = {
  request_id: "req-stub",
  thread_id: "thread-stub",
  question: "How does this week compare with the same week last year?",
  routing_reason: "The question spans a forecast and an archive period.",
  routing_source: "model",
  agents: [
    { sequence: 1, agent: "supervisor", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 120, reason: "Planned retrieval then comparison." },
    { sequence: 2, agent: "forecast", status: "succeeded", started_at: RETRIEVED_AT, duration_ms: 840, reason: "Retrieved the window." },
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
      attribution: { ...ATTRIBUTION, period: PERIOD },
      payload: { daily: [1, 2, 3], units: { temperature: "°C" } },
    },
  ],
  analytics_results: [statistic("mean", "temperature", 17.9, "°C", "arithmetic mean of usable points")],
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
  attributions: [{ ...ATTRIBUTION, period: PERIOD }],
  data_classes: ["forecast", "computed_statistic", "ai_interpretation"],
  llm_provider: "stub-gateway",
  llm_model: "stub-model",
  started_at: RETRIEVED_AT,
  completed_at: "2026-09-04T06:15:04Z",
  total_duration_ms: 4210,
  steps_used: 3,
  partial: false,
  partial_reason: null,
};

const EVIDENCE_PROSE =
  "The provider's forecast puts this week's mean at 17.9 °C, which the archive comparison places above the four-year baseline.";

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
    forecast_horizon_days: 3,
    default_location: BERLIN,
    sources: { unit_system: "chosen", default_location: "chosen", forecast_horizon_days: "chosen" },
  },

  "/api/v1/weather/current": {
    attribution: { ...ATTRIBUTION, data_class: "current" },
    observed_at_utc: RETRIEVED_AT,
    observed_at_local: "2026-09-04T08:15:00+02:00",
    units: { temperature: "°C", relative_humidity: "%" },
    values: { temperature: 15.3, relative_humidity: 68 },
  },

  "/api/v1/weather/forecast": {
    attribution: ATTRIBUTION,
    period: PERIOD,
    horizon_days: 3,
    hourly: { granularity: "hourly", units: {}, entries: [] },
    daily: {
      granularity: "daily",
      units: { temperature_max: "°C", temperature_min: "°C" },
      entries: [
        {
          time_utc: "2026-09-03T22:00:00Z",
          time_local: "2026-09-04T00:00:00+02:00",
          values: { temperature_max: 19.6, temperature_min: 10.4 },
        },
        {
          time_utc: "2026-09-04T22:00:00Z",
          time_local: "2026-09-05T00:00:00+02:00",
          values: { temperature_max: 20.8, temperature_min: 11.2 },
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
    findings: [
      statistic("mean", "temperature", 15.1, "°C", "arithmetic mean of usable points"),
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
      anomalies: [],
      note: "No entry stood out from the window by this method.",
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
    comparison_available: false,
    previous_retrieved_at: null,
    current_retrieved_at: RETRIEVED_AT,
    changes: [],
    statement:
      "No earlier forecast is on record for Berlin, Germany over this window, so there is nothing to compare against yet. This is the current forecast, not a change.",
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
    daily: dailySeries({ temperature_mean: "°C", precipitation_sum: "mm" }),
    hourly: null,
  },

  "/api/v1/weather/history/comparison": {
    location: BERLIN,
    data_class: "historical_observation",
    earlier_period: PERIOD,
    later_period: PERIOD,
    provider: "stub-provider",
    unit_system: "metric",
    statistics_applied: ["temperature_mean: mean"],
    earlier: [statistic("mean", "temperature_mean", 15.1, "°C", "arithmetic mean of usable points")],
    later: [statistic("mean", "temperature_mean", 17.9, "°C", "arithmetic mean of usable points")],
    deltas: [statistic("delta", "temperature_mean", 2.8, "°C", "later minus earlier")],
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
    baseline: BASELINE,
  },

  "/api/v1/weather/comparison": {
    criterion: "warmest",
    mode: "locations",
    data_class: "forecast",
    provider: "stub-provider",
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
        supporting: [statistic("mean", "temperature", 18.4, "°C", "arithmetic mean of usable points")],
      },
      {
        label: "Munich, Germany",
        location: MUNICH,
        period: PERIOD,
        rank: 2,
        score: 16.1,
        supporting: [statistic("mean", "temperature", 16.1, "°C", "arithmetic mean of usable points")],
      },
    ],
    excluded: [
      { label: "Nowhere", location: null, code: "location_not_found", reason: "No location matches that name." },
    ],
  },

  "/api/v1/evidence/run-stub": {
    id: "run-stub",
    request_id: "req-stub",
    thread_id: "thread-stub",
    question: EVIDENCE_RECORD.question,
    answer_prose: EVIDENCE_PROSE,
    envelope: {
      request_id: "req-stub",
      answer_prose: EVIDENCE_PROSE,
      prose_data_class: "ai_interpretation",
      findings: [],
      attribution: [{ ...ATTRIBUTION, period: PERIOD }],
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
    llm_provider: "stub-gateway",
    llm_model: "stub-model",
    weather_provider: "stub-provider",
    duration_ms: 4210,
    partial: false,
    created_at: "2026-09-04T06:15:05Z",
  },
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
  "This week's mean of 17.9 °C ",
  "sits above the four-year baseline for the same week, ",
  "by the margin the archive comparison reports.",
];

const STREAM_ANSWER_PROSE = ANSWER_PIECES.join("");

/**
 * The envelope the terminal `final` event carries, in the shape `AnswerEnvelope` declares —
 * `request_id`, `answer_prose`, `grounding` and `evidence` required, the rest optional.
 *
 * Grounded and verified, because the flow asserts that the provenance boundary is still legible on
 * the answer: prose badged as interpretation, figures attributed, and the grounding verdict stated.
 */
function answerEnvelope(requestId, question) {
  return {
    request_id: requestId,
    thread_id: "thread-e2e",
    answer_prose: STREAM_ANSWER_PROSE,
    prose_data_class: "ai_interpretation",
    findings: [],
    attribution: [{ ...ATTRIBUTION, period: PERIOD }],
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
    clarification_question: null,
    llm_provider: "stub-gateway",
    llm_model: "stub-model",
    evidence: { ...EVIDENCE_RECORD, request_id: requestId, question },
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

      frame("routing", {
        capabilities: ["forecast", "historical", "analytics"],
        source: "model",
        reason: "The question asks for this week against the record.",
      });
      await pause();

      for (const [agent, tool] of [
        ["forecast", "weather.forecast"],
        ["historical", "weather.history"],
        ["analytics", "analytics.baseline_comparison"],
      ]) {
        frame("agent_start", { agent, reason: null });
        await pause();
        frame("tool_start", { tool, agent });
        await pause();
        frame("tool_end", { tool, ok: true, duration_ms: 120 });
        frame("agent_end", { agent, status: "ok", duration_ms: 180 });
        await pause();
      }

      frame("agent_start", { agent: "synthesis", reason: null });
      for (const piece of ANSWER_PIECES) {
        frame("answer_delta", { text: piece });
        await pause();
      }
      frame("agent_end", { agent: "synthesis", status: "ok", duration_ms: 210 });
      await pause();

      // The terminal event, carrying the envelope and the identifier the record is stored under.
      // The Analyst offers its evidence link from this identifier and nothing else, so the flow
      // cannot reach the record except through an id the run itself produced.
      frame("final", {
        answer: answerEnvelope(requestId, typeof body.question === "string" ? body.question : ""),
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
  // Weather reads are answered in the unit system the request asked for, which is what makes a
  // saved unit preference observable on screen rather than merely stored — task 21.10, flow 3.
  send(response, 200, path.startsWith("/api/v1/weather/") ? inUnits(fixture, requestedUnits(url)) : fixture);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`weathra api stub listening on http://${HOST}:${PORT}\n`);
});
