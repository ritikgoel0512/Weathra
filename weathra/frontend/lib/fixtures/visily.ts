/**
 * The approved Visily sample state, for visual fidelity review only.
 *
 * # What this is
 *
 * `docs/design/screens/*.png` are populated mockups. Comparing a rendered screen against one means
 * rendering the same *content*, because a layout tuned against two forecast days and four
 * "Unavailable" slots is not the layout the artifact specifies — every previous fidelity pass drifted
 * for exactly that reason. This module holds the sample content those artifacts show, so the real
 * components can be driven with it and the two images put side by side.
 *
 * # What this is not
 *
 * **It is not weather.** Every figure below is transcribed from a mockup. None of it was measured,
 * forecast, retrieved or computed, and none of it may ever be presented as though it were. It exists
 * to make a screenshot comparable and for no other purpose.
 *
 * # How it is kept away from production
 *
 * Four separate mechanisms, because one would not be enough for data shaped like this:
 *
 * 1. **A build-time flag.** `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES` is fixed when the bundle is
 *    built. It is not a runtime toggle: there is no query parameter, no header and no cookie that
 *    turns fixtures on in a deployed build, because there is nothing a request can do to change
 *    what the bundle was built with. `fixtures.test.ts` asserts the real screen renders when the
 *    flag is unset.
 *
 *    **What ships, precisely.** Two earlier versions of this comment overstated this and both were
 *    wrong, so here is what a real `npm run build` with the flag unset actually produces, checked
 *    in the emitted chunks rather than assumed:
 *
 *    - `usingVisilyFixtures()` compiles to `"true" === <lookup>` against an environment object
 *      baked into the bundle — a *runtime* comparison, not a folded constant.
 *    - Because it is not folded, the `if (usingVisilyFixtures())` branches are not eliminated, and
 *      every fixture screen and every string below ships in the client bundle.
 *    - The comparison is nonetheless always false in that build, because the baked object has no
 *      such key and nothing served over HTTP can add one.
 *
 *    So the honest guarantee is: **fixture content cannot render in a build that was not built for
 *    it** — not that it is absent from the bundle. It is unreachable, which is a weaker claim than
 *    absent, and the difference is exactly the kind of thing this file should not paper over. If
 *    absence is ever required rather than unreachability, the fix is a dynamic `import()` behind the
 *    flag so the bundler can split the fixtures into a chunk a production build never requests.
 * 2. **It never reaches the network.** Nothing here is written, posted or sent anywhere. The API
 *    client, the Supabase clients and the backend are untouched; fixtures are substituted at the
 *    point a *screen* asks for its data, not at the point the data is fetched. A real API never
 *    returns a fake value.
 * 3. **It never reaches a database.** No fixture is persisted. Fixture mode performs no writes.
 * 4. **It says so on screen.** `FixtureBanner` renders a fixed, unmissable marker whenever this
 *    mode is on. A screenshot of sample weather in a product whose entire design asserts that every
 *    figure is attributed could otherwise be mistaken later for real output — by a reviewer, in a
 *    deck, in a bug report. The banner makes that mistake impossible to make silently.
 *
 * The last one is deliberately not optional and not subtle. This product's whole claim is that you
 * can tell where a number came from; sample data that looked real would undermine the thing the
 * screenshots exist to review.
 */

/** Whether the Visily fidelity fixtures are active. Fixed when the bundle is built. */
export function usingVisilyFixtures(): boolean {
  return process.env.NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES === "true";
}

/**
 * Whether the fixture banner is shown.
 *
 * It is on whenever fixture mode is, and the *only* way to turn it off is to set
 * `NEXT_PUBLIC_VISILY_FIDELITY_BANNER=false` on the build — which the automated capture run does
 * and a person reviewing in a browser does not.
 *
 * **Why this exists.** The banner is a fixed strip across the top of the viewport, so it shifts
 * every screen down by its own height and changes the geometry of the thing being measured. A
 * comparison against an artifact that has no such strip is measuring the banner as much as the
 * layout. Turning it off for a capture makes the measurement honest.
 *
 * **Why it is opt-out rather than opt-in.** The default is disclosed: forget to set anything and
 * you get the banner. Hiding it takes a second deliberate flag on top of the first one, and neither
 * is set anywhere a deployed build would see. The disclosure mechanism is not removed by this — a
 * build with the banner suppressed is still a build nobody but a capture script asks for, and the
 * captures it produces are filed under `docs/design/` as fidelity comparisons rather than shown as
 * product screenshots.
 */
export function showingFixtureBanner(): boolean {
  return usingVisilyFixtures() && process.env.NEXT_PUBLIC_VISILY_FIDELITY_BANNER !== "false";
}

/** A day in the artifact's Forecast Explorer strip. Sample content, not a forecast. */
export interface FixtureDay {
  readonly day: string;
  readonly icon: "rain" | "cloud" | "sun" | "clear" | "overcast" | "heavy-rain" | "partly";
  readonly temperature: string;
  readonly condition: string;
  readonly low: string;
  readonly high: string;
}

/**
 * `01-dashboard.png`, transcribed.
 *
 * Field names follow the artifact's own labels so a reviewer can match them to the image. Values
 * are strings, not numbers: they are copy from a picture, and typing them as measurements would
 * invite somebody to compute with them.
 */
export const DASHBOARD_FIXTURE = {
  station: "BER-CENTRAL-09",
  place: "Berlin, Germany",
  timezone: "GMT +1",
  updated: "Updated 2m ago",
  agentStatus: "Agent Ready",
  temperature: "18",
  condition: "Light Rain",
  humidity: "72%",
  uvIndex: "2 Low",
  wind: "14 km/h",
  windDirection: "NW",
  pressure: "1012 hPa",

  agentLine: "NEURAL AGENT V4.2 · PROCESSING BERLIN LOCAL STATION",
  grounding: "Grounded by Weather provider via Weathra MCP",
  currentInterpretation:
    "Localized atmospheric pressure dropped by 2.4 hPa over the last 90 minutes, triggering unexpected light precipitation. While the radar shows low intensity, the micro-climate convergence over Central Berlin suggests rain will persist until 18:45 CEST.",
  whatChanged: "Convergence zone shifted 4km Eastward from previous model predictions.",
  why: "Increased thermal instability in the upper troposphere exacerbated convection along the leading edge of the low-pressure system.",
  modelConvergence: 0.94,
  dataReliability: 0.82,
  confidenceFootnote: "Sample data · Weather provider via Weathra MCP",

  anomalyTitle: "THERMAL DRIFT DETECTED",
  anomalyDetail: "Berlin-Mitte is 1.4°C above predicted trend.",
  historicalAverage: "14.2°C",
  variance: "+3.8°C",

  snapshots: [
    { place: "Tokyo", temperature: "22°", direction: "up" as const },
    { place: "New York", temperature: "14°", direction: "down" as const },
    { place: "London", temperature: "16°", direction: "up" as const },
  ],

  forecastLabel: "7-DAY ANALYSIS · SAMPLE DATA · WEATHER PROVIDER VIA WEATHRA MCP",
  days: [
    { day: "MON", icon: "rain", temperature: "18°", condition: "LIGHT RAIN", low: "12°", high: "18°" },
    { day: "TUE", icon: "cloud", temperature: "21°", condition: "PARTLY CLOUDY", low: "14°", high: "21°" },
    { day: "WED", icon: "sun", temperature: "24°", condition: "SUNNY", low: "16°", high: "24°" },
    { day: "THU", icon: "clear", temperature: "22°", condition: "CLEAR", low: "15°", high: "22°" },
    { day: "FRI", icon: "overcast", temperature: "19°", condition: "OVERCAST", low: "13°", high: "19°" },
    { day: "SAT", icon: "heavy-rain", temperature: "17°", condition: "HEAVY RAIN", low: "11°", high: "17°" },
    { day: "SUN", icon: "partly", temperature: "20°", condition: "PARTLY CLOUDY", low: "14°", high: "20°" },
  ] satisfies readonly FixtureDay[],

  pulseTitle: "Climate Pulse Analytics",
  pulseLabel: "24H INTRA-DAY PROJECTION",
  /** The artifact's curve and bars, by eye. Shape only — these are not measurements. */
  pulseTemperature: [11, 12, 13, 17, 19, 19, 18, 16, 15],
  pulsePrecipitation: [2, 8, 16, 6, 1, 0, 0, 5, 0],
  pulseHours: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "23:59"],
  peakHeat: "19°C @ 16:20",
  maxRisk: "45% @ 08:00",

  precipitationRisk: "42% Integrated Risk",
  precipitationDetail:
    "Current atmospheric instability index (AII) suggests localized convection cells.",
  precipitationType: "Convective",
  precipitationLoad: "4.2mm/h",

  baselineTitle: "Climate Baseline Comparison",
  baselineBody:
    "Berlin's current autumnal phase shows significant deviation from the 30-year climate norm (1991-2020). Intelligence identifies a steady +1.2°C decade-over-decade shift for the Q4 period.",
  historicalDelta: "+3.2°C vs 1995",
  extremeYear: "2023 EXTREME",
  extremeValue: "22.1°C",
  extremeNote: "Highest recorded temperature for mid-October in Berlin station history.",

  footerFlow: "DATA FLOW: ACTIVE",
  footerSample: "SAMPLE DATA · WEATHER PROVIDER VIA WEATHRA MCP",
  footerHash: "SYSTEM HASH: B882-X90A-BERL",
  footerVersion: "v4.8.2-STABLE",
} as const;

/** The sidebar as `01-dashboard.png` draws it: four entries, then the saved list. */
export const SHELL_FIXTURE = {
  navigation: [
    { label: "Dashboard", href: "/", icon: "dashboard" as const },
    { label: "Analytics", href: "/historical", icon: "report" as const },
    { label: "Historical Data", href: "/historical", icon: "historical" as const },
    { label: "Settings", href: "/settings", icon: "settings" as const },
  ],
  savedLocations: ["Berlin, Germany", "Tokyo, Japan", "New York, USA", "London, UK"],
  person: "Dr. Aris Thorne",
  breadcrumb: ["Dashboard", "Meteorology Analytics"],
} as const;

/* ===================================================================================
 * The remaining seven artifacts.
 *
 * Same rules as `DASHBOARD_FIXTURE` above: every value is transcribed from a mockup, none of it was
 * measured or retrieved, and none of it renders without the build-time flag. Field names follow the
 * artifacts' own labels so a reviewer can match them to the image, and figures are strings because
 * they are copy from a picture rather than quantities to compute with.
 * =================================================================================== */

/** `02-ai-weather-analyst.png`, transcribed. */
export const ANALYST_FIXTURE = {
  workspace: "Climate Intelligence Workspace",
  session: "Active Session",
  thread: "Thread ID: WXA-7729-ALPHA",
  historyAction: "History",
  newAction: "New Analysis",
  contextNotePrefix: "Using context from this conversation and your",
  contextNoteEmphasis: "Advanced Analyst",
  contextNoteSuffix: "preferences.",

  askerRole: "Lead Meteorologist",
  askerTime: "14:02",
  question:
    "Perform a deep dive on Berlin Central's current precipitation trends. Why is it raining when the morning model predicted clear skies?",

  agentRole: "Weathra Intelligence Agent",
  agentTime: "14:03",
  grounding: "Grounding analysis via Weathra MCP…",
  leadPrefix: "I've completed the synthesis for",
  leadStation: "Berlin Central (Station BER-09)",
  leadSuffix:
    ". The current atmospheric setup indicates a high probability of localized convection.",

  observedTitle: "Observed Data",
  observed: [
    { label: "Pressure Drop", value: "-2.4 hPa/90m", tone: "accent" as const },
    { label: "Current Humidity", value: "72.4%", tone: "plain" as const },
  ],
  forecastTitle: "Forecast Vector",
  forecast: [
    { label: "Precip Window", value: "Until 18:45 CEST", tone: "plain" as const },
    { label: "Confidence", value: "94%", tone: "accent" as const },
  ],

  interpretationTitle: "Agent Interpretation",
  interpretationLead: "Convergence zones have shifted",
  interpretationEmphasis: "4km Eastward",
  interpretationRest:
    "from standard ECMWF models. This suggests the thermal instability in the upper troposphere is exacerbating convection along the leading edge of the current low-pressure system earlier than predicted.",

  turnSources: "Sources: 124 Nodes",
  turnContext: "Context: 48h Window",
  turnProvenance: "Sample data • Weather provider via Weathra MCP",

  suggestions: [
    "Analyze precipitation delta for Berlin last 48h",
    "Predict thermal drift for Tokyo next week",
    "Identify anomalies in New York wind patterns",
    "Correlate UV index with humidity in London",
  ],

  focusLabel: "Focus:",
  focusValue: "Berlin, DE",
  depthLabel: "Depth:",
  depthValue: "Full Synthesis",
  composerPlaceholder: "Ask about weather anomalies, historical trends, or agent interpretations…",

  statusTitle: "Agent Status",
  statusChip: "Synced",
  agentName: "Neural Agent v4.8",
  agentProcess: "Process: Active Inference",
  computeLabel: "Compute Load",
  computeValue: "14.2%",
  computeFraction: 0.142,

  sourcesTitle: "Active Data Sources",
  sourceChips: ["GLOBAL_SAT", "L_RADAR"],
  sources: [
    { name: "Weathra MCP Core", role: "Primary Provider" },
    { name: "ECMWF Reanalysis", role: "Historical/Baselines" },
    { name: "Berlin-Mitte Station", role: "Observed/Ground" },
  ],

  contextTitle: "Analyst Context",
  memoryTitle: "Long-Term Memory",
  memory: [
    { lead: "Prioritizing", emphasis: "B2B City Planning", rest: "impacts for infrastructure." },
    { lead: "Alert threshold set for", emphasis: "Thermal Drift > 1.5°C", rest: "." },
  ],
  synthesisLabel: "Synthesis Confidence",
  synthesisValue: "98.2%",
  synthesisFraction: 0.982,
  evidenceAction: "View Full Agent Evidence",

  calibrationNote:
    "Station BER-09 reporting minor calibration lag. Auto-compensating via neighbor interpolation.",
  footerStatus: "SYSTEM STABLE",
  footerVersion: "v4.8.2-STABLE",
} as const;

/** `03-historical-analytics.png`, transcribed. */
export const HISTORICAL_FIXTURE = {
  title: "Historical Analytics",
  place: "Berlin, Germany",
  station: "STATION BER-09",
  range: "oct 01, 2023 - oct 31, 2023",
  units: ["°C", "°F"] as const,
  exportAction: "Export Data",

  metrics: [
    { label: "Mean Temperature", value: "15.6", unit: "°c", note: "+3.2°C vs Normal", tone: "warn" as const, icon: "thermometer" as const },
    { label: "Min / Max Range", value: "9.2 - 22.1", unit: "°c", note: "12.9° Spread", tone: "plain" as const, icon: "scale" as const },
    { label: "Precipitation", value: "14.6", unit: "mm", note: "4 Rain Days", tone: "plain" as const, icon: "rain" as const },
    { label: "Avg Humidity", value: "72.4", unit: "%", note: "Stable Range", tone: "plain" as const, icon: "drop" as const },
    { label: "Wind Speed", value: "14.2", unit: "km/h", note: "Max Gust 42km/h", tone: "warn" as const, icon: "wind" as const },
    { label: "Pressure Avg", value: "1012", unit: "hpa", note: "-2 hPa Trend", tone: "good" as const, icon: "layers" as const },
  ],

  chartTitle: "Historical data + deterministic analytics",
  chartSubtitle: "metric synthesis for selected period • grounded via weathra mcp",
  chartLegend: ["Recorded", "Normal", "Precip"] as const,
  /** The artifact's curve, by eye. Shape only — not measurements. */
  recorded: [13.4, 14.2, 15.6, 17.4, 19.2, 20.1, 20.4, 19.6, 17.9, 16.1, 14.8, 13.9],
  normal: [12.4, 12.2, 12.0, 11.8, 11.6, 11.4, 11.2, 11.0, 10.8, 10.6, 10.4, 10.2],
  precip: [0.4, 0, 5.2, 0, 0, 0, 0, 12.0, 0, 2.6, 0, 0.7],
  chartDays: ["Oct 01", "Oct 05", "Oct 10", "Oct 15", "Oct 20", "Oct 25", "Oct 30"],
  confidenceLabel: "Confidence Score",
  confidenceValue: "98.4%",
  sourceLabel: "Source Count",
  sourceValue: "14 Nodes",
  metadataAction: "View Detailed Metadata",

  comparisonTitle: "Selected Period vs Historical Normal",
  comparisonSubtitle:
    "comparing oct 2023 against the 1991-2020 wmo baseline for berlin station.",
  comparisonStats: [
    { label: "Thermal Delta", chip: "Extreme", chipTone: "critical" as const, value: "+3.2°C" },
    { label: "Z-Score", chip: "Anomaly", chipTone: "warn" as const, value: "2.84 σ" },
    { label: "Percentile", chip: "Historic", chipTone: "info" as const, value: "98.2th" },
  ],
  deviationTitle: "Deviation Analysis",
  deviations: [
    { label: "Temperature Drift", value: "+24%", fraction: 0.72, tone: "critical" as const },
    { label: "Precipitation Lag", value: "-12%", fraction: 0.38, tone: "good" as const },
    { label: "Atmospheric Instability", value: "+18%", fraction: 0.56, tone: "accent" as const },
  ],

  anomalyTitle: "Anomaly Intelligence",
  anomalyAgent: "Neural Agent v4.8 • Baseline: 30Y Normal",
  surgeTitle: "Thermal Surge Detected",
  surgeLead: "Berlin Central is currently observing a sustained thermal anomaly of",
  surgeEmphasis: "+3.2°C above normal",
  surgeRest:
    ". The deviation is non-linear and correlates with a weakening of the North Atlantic Jet Stream, allowing unseasonably warm air masses to persist over Central Europe.",
  insightsTitle: "Key Insights",
  insights: [
    { lead: "Oct 15 was the hottest recorded day for this station since", emphasis: "1995", rest: "." },
    {
      lead: "Persistence of high-pressure blocking suggests the anomaly will carry into early November.",
      emphasis: "",
      rest: "",
    },
  ],
  anomalyAction: "View Agent Evidence",
  recalibrateAction: "Recalibrate Baseline Models",

  footerPipeline: "ANALYTICS PIPELINE: SYNCED",
  footerData: "DATA: ERA5 REANALYSIS + LOCAL OBSERVATIONS",
  footerRef: "Ref: WMO-1991-2020-NORMAL",
  footerVersion: "v4.8.2-STABLE",
} as const;

/** `04-compare-cities.png`, transcribed. */
export const COMPARE_FIXTURE = {
  workspace: "Workspace: WX-CMP-9021",
  title: "Compare Cities",
  left: "Berlin",
  right: "Munich",
  window: "24H Window",

  cities: [
    {
      name: "Berlin",
      country: "germany",
      dataClass: "observed" as const,
      station: "BER-CENTRAL-09",
      temperature: "18",
      condition: "Light Rain",
      humidity: "72%",
      wind: "14 km/h",
      windDirection: "NW",
      latitude: 52.52,
      longitude: 13.405,
    },
    {
      name: "Munich",
      country: "germany",
      dataClass: "forecast" as const,
      station: "MUC-SOUTH-21",
      temperature: "16",
      condition: "Partly Cloudy",
      humidity: "64%",
      wind: "11 km/h",
      windDirection: "W",
      latitude: 48.137,
      longitude: 11.575,
    },
  ],
  cityBadges: ["Live Sync", "Validated"] as const,

  intelligenceTitle: "Comparison Intelligence",
  intelligenceAgent: "Neural Agent v4.8 • Multi-node Synthesis",
  varianceTitle: "Regional Variance Interpretation",
  varianceLead: "Analysis reveals a",
  varianceEmphasis: "2.4°C thermal gradient",
  varianceRest:
    "between Berlin and Munich, driven by a localized low-pressure system stalling over the Brandenburg region. While Berlin experiences immediate convective precipitation, Munich maintains atmospheric stability due to the Alpine Foehn effect, resulting in clearer conditions despite higher humidity levels.",
  whatChangedTitle: "What Changed?",
  whatChanged:
    "Convergence zones in the North-East shifted 12km closer to metropolitan Berlin, accelerating the rain start-time by 45 minutes relative to the 06:00 model run.",
  whyTitle: "Why?",
  why:
    "Upper-tropospheric wind shear in the southern corridor was insufficient to break the high-pressure block protecting Munich's center.",
  synthesisTitle: "Synthesis Confidence",
  synthesisMeters: [
    { label: "Correlation Score", value: "96.4%", fraction: 0.964 },
    { label: "Data Density", value: "88.1%", fraction: 0.881 },
  ],
  evidenceAction: "View Agent Evidence",

  matrixLabel: "7-Day Differential Matrix",
  matrixTitle: "Forecast Delta Explorer",
  matrix: [
    { day: "MON", left: { icon: "rain", temperature: "18°" }, right: { icon: "cloud", temperature: "16°" } },
    { day: "TUE", left: { icon: "cloud", temperature: "21°" }, right: { icon: "sun", temperature: "19°" } },
    { day: "WED", left: { icon: "sun", temperature: "24°" }, right: { icon: "sun", temperature: "23°" } },
    { day: "THU", left: { icon: "sun", temperature: "22°" }, right: { icon: "cloud", temperature: "20°" } },
    { day: "FRI", left: { icon: "cloud", temperature: "19°" }, right: { icon: "rain", temperature: "17°" } },
    { day: "SAT", left: { icon: "rain", temperature: "17°" }, right: { icon: "rain", temperature: "15°" } },
    { day: "SUN", left: { icon: "cloud", temperature: "20°" }, right: { icon: "sun", temperature: "21°" } },
  ],

  pulseTitle: "Climate Pulse Differential",
  pulseSubtitle: "24-hour intra-day temperature & precipitation comparison",
  pulseLegend: ["BER", "MUC"] as const,
  pulseHours: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
  /** Two curves and a bar series, by eye. Shape only. */
  pulseLeftLine: [13, 17, 20, 20.5, 18, 14],
  pulseRightLine: [11.5, 15, 18.5, 19, 16.5, 13],
  pulseBars: [5, 20, 10, 0, 40, 15],

  metricsTitle: "Deterministic Metrics",
  metrics: [
    { label: "Mean Variance", value: "+2.4°C", icon: "scale" as const },
    { label: "Precip Delta", value: "+14.2mm", icon: "rain" as const },
    { label: "Gust Intensity", value: "12% Peak", icon: "wind" as const },
  ],
  criticalTitle: "Critical Anomaly",
  criticalBody:
    "High-pressure drift in MUC-SOUTH-21 exceeds historical seasonal norms by 2.8σ.",

  baselineTitle: "Decadal Climate Baseline",
  baselineLead:
    "Comparing current autumnal phases in Berlin and Munich against the 30-year WMO climate normal (1991-2020). Berlin shows a sustained thermal drift of",
  baselineEmphasis: "+1.2°C/decade",
  baselineRest:
    ", while Munich demonstrates increasing precipitation volatility due to Alpine oscillation shifts.",
  baselineDeltas: [
    { label: "BER Delta", value: "+3.2°C" },
    { label: "MUC Delta", value: "+1.4°C" },
  ],
  baselineAction: "Open Historical Explorer",
  zScoreLabel: "Model Z-Score",
  zScoreValue: "2.84σ",
  zScoreNote: "Berlin extreme deviation from mean 30Y normal.",

  summaryTitle: "Comparison Synthesis Summary",
  summaryBody:
    "The primary divergence in this session is rooted in the decoupling of the North Atlantic Jet Stream, causing sustained high-pressure blocking over Southern Germany (Munich) while exposing the Northern corridor (Berlin) to convective instability. Recommendations for city planners include heightened monitoring of drainage infrastructure in Berlin Mitte and thermal regulation focus for Munich residential zones over the next 48 hours.",
  exportAction: "Export PDF",
  recalibrateAction: "Recalibrate Models",

  footerStream: "DATA STREAM: ACTIVE",
  footerHash: "NODE HASH: WX-901-DELTA",
  footerNormal: "WMO-NORMAL-2023",
  footerProduct: "WEATHRA V4.8.2-PRO",
  footerRelease: "STABLE_REL",
} as const;

/** `05-agent-evidence.png`, transcribed. */
export const EVIDENCE_FIXTURE = {
  auditId: "Audit ID: WX-EVD-992-ALPHA",
  title: "Agent Evidence Log",
  subtitle: "Full trace of multi-agent synthesis and grounding for Berlin Station (BER-09).",
  stats: [
    { label: "Status", value: "COMPLETE", tone: "good" as const },
    { label: "Execution", value: "4.2s", tone: "plain" as const },
    { label: "Timestamp", value: "14:03:12", tone: "plain" as const },
    { label: "Confidence", value: "98.4%", tone: "accent" as const },
  ],

  flowTitle: "Execution Flow",
  flow: [
    {
      name: "Supervisor Agent",
      tool: "LOGIC-ROUTER-V4",
      duration: "120MS",
      note: "Analyzed user intent: requested root cause analysis for precipitation anomaly in Berlin Central.",
    },
    {
      name: "Forecast Agent",
      tool: "ECMWF-GROUNDED-API",
      duration: "850MS",
      note: "Retrieved latest 24h vector projections. Identified 4km shift in convergence zone.",
    },
    {
      name: "Historical Agent",
      tool: "HISTORICAL-DB-QUERY",
      duration: "420MS",
      note: "Loaded 30-year October baseline for BER-09. Calculated current anomaly as +2.84σ.",
    },
    {
      name: "Analytics Agent",
      tool: "DETERMINISTIC-KERNEL",
      duration: "610MS",
      note: "Calculated precipitation delta and thermal drift relative to localized pressure drop.",
    },
    {
      name: "RAG Agent",
      tool: "VECTOR-KNOWLEDGE-RETRIEVER",
      duration: "940MS",
      note: "Retrieved 3 context chunks regarding Alpine Foehn influence on Northern block patterns.",
    },
    {
      name: "Final Synthesis",
      tool: "REASONING-ENGINE",
      duration: "1.2S",
      note: "Merged agent outputs into grounded natural language interpretation with evidence mapping.",
    },
  ],
  flowState: "Completed",

  mcpTitle: "MCP Evidence",
  mcpChip: "Active Tool",
  mcpName: "Weathra MCP Weather Layer",
  mcpLead: "Protocol: MCP v1.0. Connected to",
  mcpProvider: "Provider: GlobalWeatherOS",
  mcpRest: ". Full-duplex telemetry established for station BER-09.",
  mcpLatency: "Latency: 42MS",
  mcpAction: "View Raw Logs",

  sourcesTitle: "Grounded Data Sources",
  sourcesSubtitle: "Full lineage of retrieved meteorological payloads.",
  inspectAction: "Inspect Payloads",
  sourceColumns: ["Provider", "Resolved Location", "Retrieval Period", "Data Class"] as const,
  sourceRows: [
    { provider: "GlobalWeatherOS", location: "52.5200° N, 13.4050° E", period: "Live Sync (0s delay)", dataClass: "observed" as const },
    { provider: "ECMWF Core", location: "Berlin Metropolitan Area", period: "+24h Vector Window", dataClass: "forecast" as const },
    { provider: "WMO Historical", location: "STATION BER-09", period: "30-Year Normal (1991-2020)", dataClass: "historical" as const },
    { provider: "Local Hydro-Met", location: "Berlin-Mitte District", period: "Current 90m Interval", dataClass: "observed" as const },
    { provider: "NASA POWER", location: "Global Grid Overlay", period: "Solar Irradiance Baseline", dataClass: "analytics" as const },
  ],

  analyticsTitle: "Deterministic Analytics",
  analytics: [
    { label: "Temp Difference", value: "+1.4°C", flag: "Drift Detected", flagTone: "critical" as const, note: "Variance from morning ECMWF run at 06:00 UTC." },
    { label: "Historical Anomaly", value: "2.84 σ", flag: "Outlier", flagTone: "warn" as const, note: "Statistical deviation from 30-year seasonal October mean." },
    { label: "Precip Trend", value: "+42%", flag: "Accelerating", flagTone: "accent" as const, note: "Local convective cell intensity growth over 90 mins." },
  ],
  analyticsNote:
    "Calculated deterministically from retrieved weather data via Weathra Analysis Kernel.",

  ragTitle: "RAG Knowledge Evidence",
  ragEntries: [
    {
      reference: "Reference R-442",
      title: "Atmospheric Convection Dynamics in Urban Heat Islands",
      similarity: "Similarity: 0.942",
      quote:
        "“Precipitation anomalies in metropolitan Berlin (STATION BER-09) are frequently correlated with sudden localized pressure drops exceeding 2.0 hPa within a 2-hour window, particularly during transitional autumnal phases…”",
      source: "Source: Internal PDF Lib",
      indexed: "Indexed 2d ago",
    },
    {
      reference: "Reference S-109",
      title: "Alpine Foehn Blocking Patterns (Central Europe)",
      similarity: "Similarity: 0.811",
      quote:
        "“The stalling of low-pressure corridors over the Brandenburg region is often exacerbated by high-pressure blocking in the southern corridor…”",
      source: "",
      indexed: "",
    },
  ],
  ragAction: "Explore All Knowledge Fragments (12)",

  synthesisConfidence: "Confidence: 98.4%",
  synthesisTitle: "Final Grounded Synthesis",
  validateAction: "Validate Conclusion",
  exportAction: "Export Trace",
  synthesisLead: "The precipitation anomaly in Berlin (14:03 CEST) is directly caused by a localized pressure drop of",
  synthesisEmphasis: "-2.4 hPa",
  synthesisRest:
    ", which was missed by the 06:00 global model. Grounded station data from BER-09 indicates a thermal drift of +1.4°C, triggered by a convergence zone shift that RAG context identifies as a common urban heat island convective trigger.",
  synthesisChips: ["WX-CHUNK-882", "OBS-TELEMETRY-09", "ANLY-DRIFT-LOG"],

  memoryTitle: "Context Used (Agent Memory)",
  conversationTitle: "Conversation Context",
  conversation: [
    "User requested “Deep dive on Berlin Central precipitation” in current thread.",
    "Previous query regarding “Morning model clearing” identified as baseline anchor.",
  ],
  preferencesTitle: "Analyst Preferences",
  preferences: [
    { label: "Priority set to", emphasis: "Infrastructure Impacts", note: "(B2B City Planning Profile)." },
    { label: "Alert Threshold:", emphasis: "Thermal Drift > 1.5°C", note: "(Long-Term Memory)." },
  ],

  stabilityTitle: "Audit Stability Index",
  stabilityChip: "Optimal",
  stabilityNote:
    "This execution log is cryptographically signed and immutable for compliance auditing.",
  stabilityAction: "View Chain of Custody",
  versionLabel: "Agent Version",
  versionValue: "v4.8.2-STABLE",
  signatureLabel: "Signature Hash",
  signatureValue: "WX-901-DELTA-AF89",

  footerStream: "AUDIT STREAM: PERSISTED",
  footerNode: "LINUX-MET-NODE-772",
  footerCompliance: "ISO-MET-COMPLIANT",
  footerProduct: "WEATHRA V4.8.2-PRO",
  footerLock: "AUDIT_LOCK",
} as const;

/** `06-saved-locations.png`, transcribed. Deliberately without imagery: the artifact has none. */
export const LOCATIONS_FIXTURE = {
  workspace: "Workspace ID: WX-LOC-772",
  title: "Saved Locations",
  subtitle: "Manage multi-node weather sync and regional intelligence nodes.",
  searchPlaceholder: "Quick search nodes…",
  addAction: "Add New Node",

  alertTitle: "Atmospheric Attention Required",
  alertBody:
    "Berlin station reporting unseasonable pressure drop (-2.4 hPa/90m). Intelligence triggered.",
  dismissAction: "Dismiss",
  analyzeAction: "Analyze Anomaly",

  nodes: [
    {
      name: "Berlin",
      country: "germany",
      since: "2m ago",
      freshness: "stale" as const,
      temperature: "18",
      condition: "Light Rain",
      high: "21°",
      low: "12°",
      precipitation: "72%",
      humidity: "68%",
      wind: "14 km/h",
    },
    {
      name: "Tokyo",
      country: "japan",
      since: "5m ago",
      freshness: "fresh" as const,
      temperature: "24",
      condition: "Clear Sky",
      high: "27°",
      low: "19°",
      precipitation: "5%",
      humidity: "52%",
      wind: "8 km/h",
    },
    {
      name: "London",
      country: "united kingdom",
      since: "12m ago",
      freshness: "fresh" as const,
      temperature: "15",
      condition: "Overcast",
      high: "17°",
      low: "11°",
      precipitation: "30%",
      humidity: "78%",
      wind: "12 km/h",
    },
    {
      name: "Munich",
      country: "germany",
      since: "8m ago",
      freshness: "fresh" as const,
      temperature: "16",
      condition: "Partly Cloudy",
      high: "19°",
      low: "10°",
      precipitation: "15%",
      humidity: "64%",
      wind: "11 km/h",
    },
  ],
  nodeAction: "Analytics",

  synthesisTitle: "Workspace Intelligence Synthesis",
  synthesisAgent: "Neural Agent v4.8 • Multi-node Aggregator",
  vectorTitle: "Global Vector Analysis",
  vectorLead: "Synoptic monitoring indicates a decoupling of the North Atlantic corridor, directly impacting",
  vectorFirst: "Berlin",
  vectorMiddle: "and",
  vectorSecond: "London",
  vectorRest:
    "nodes. While London remains stabilized by the current high-pressure block, Berlin is experiencing convective instability due to the localized thermal drift detected at 12:45 UTC.",
  driftTitle: "Drift Correlation",
  driftLabel: "BER-LON Gradient",
  driftValue: "+2.84σ",
  driftFraction: 0.72,
  driftNote: "Variance exceeds historical seasonal norms for mid-October.",

  healthTitle: "Node Health Index",
  health: [
    { label: "Telemetery Sync", value: "98%", fraction: 0.98 },
    { label: "Sensor Calibration", value: "92%", fraction: 0.92 },
    { label: "Grounding Precision", value: "84%", fraction: 0.84 },
  ],
  evidenceAction: "Explore Grounded Evidence",

  comparisonTitle: "Node Comparison",
  comparisonNodes: [
    { initial: "B", name: "Berlin Node", value: "18.4°C" },
    { initial: "T", name: "Tokyo Node", value: "22.6°C" },
  ],
  comparisonDelta: "Delta: 4.2°C",
  consensusTitle: "Model Consensus",
  consensusBody:
    "Both nodes confirm atmospheric stabilization in upper troposphere within ±0.2% variance.",
  matrixAction: "Full Differential Matrix",

  metadataTitle: "Live Metadata",
  metadataChip: "Stable",
  metadata: [
    { label: "System Latency", value: "42ms" },
    { label: "Grounding Nodes", value: "124 Active" },
    { label: "Last Global Sync", value: "14:32:01 UTC" },
  ],

  footerNetwork: "NETWORK: PERSISTED",
  footerNode: "NODE-WX-ALPHA-09",
  footerRelease: "STABLE_REL_4.8",
  footerProduct: "WEATHRA V4.8.2-PRO",
  footerLock: "COMPLIANCE_LOCK",
} as const;

/** `07-settings.png`, transcribed. */
export const SETTINGS_FIXTURE = {
  title: "Account Settings",
  subtitle:
    "Configure your meteorological workspace preferences, AI Analyst parameters, and data governance.",
  tabs: [
    { label: "General", icon: "globe" as const },
    { label: "AI Intelligence", icon: "spark" as const },
    { label: "Account", icon: "person" as const },
    { label: "Transparency", icon: "shield" as const },
  ],

  groups: [
    {
      title: "Weather Preferences",
      icon: "thermometer" as const,
      description:
        "Define how meteorological data is presented across your dashboards and analytics reports.",
      rows: [
        {
          label: "Measurement Units",
          description:
            "Choose between Metric (Celsius, km/h, mm) and Imperial (Fahrenheit, mph, in) standards.",
          control: "segmented" as const,
          options: ["Metric", "Imperial"],
          value: "Metric",
          chip: "",
        },
        {
          label: "Time Format",
          description:
            "Synchronize station timestamps using 24-hour military format or 12-hour civilian format.",
          control: "select" as const,
          options: ["24-Hour (ISO)", "12-Hour (Civilian)"],
          value: "24-Hour (ISO)",
          chip: "",
        },
        {
          label: "Forecast Horizon",
          description: "The default temporal range displayed for standard prediction modules.",
          control: "select" as const,
          options: ["7 Days", "14 Days"],
          value: "7 Days",
          chip: "",
        },
      ],
    },
    {
      title: "Location Preferences",
      icon: "globe" as const,
      description:
        "Manage your primary node for global synthesis and time zone synchronization.",
      rows: [
        {
          label: "Default Station Node",
          description: "The station used for primary hero dashboard context and AI local grounding.",
          control: "select" as const,
          options: ["STATION BER-09 (Berlin Mitte)", "STATION MUC-21 (Munich South)"],
          value: "STATION BER-09 (Berlin Mitte)",
          chip: "",
        },
        {
          label: "Primary Timezone",
          description: "Used for all deterministic analytics and historical normalization logs.",
          control: "select" as const,
          options: ["Central European Time (CET)", "Coordinated Universal Time (UTC)"],
          value: "Central European Time (CET)",
          chip: "GMT +01:00",
        },
      ],
    },
  ],

  syncedLabel: "Configuration Synced",
  lastSave: "Last save: 14:32:01 UTC",
  discardAction: "Discard Changes",
  saveAction: "Save Preferences",
  license: "WEATHRA V4.8.2-PRO • ENTERPRISE LICENSE",
  legalLinks: ["Service Status", "Legal & Compliance", "API Docs"] as const,
} as const;

/**
 * `08-authentication.png`, transcribed.
 *
 * The artifact is the only one rendered light, and its card is narrower than the one production
 * ships. Fixture mode reproduces its copy and proportions; the form underneath is the real one.
 *
 * `rememberMe` is the one control here with no production counterpart — Weathra has no
 * remember-me. It is rendered in fixture mode because the artifact draws it, and it is inert.
 */
export const AUTH_FIXTURE = {
  title: "Welcome back",
  subtitle: "Agentic Weather Intelligence & Analytics",
  emailLabel: "Email",
  emailPlaceholder: "name@weathra.ai",
  passwordLabel: "Password",
  rememberMe: "Remember me",
  forgot: "Forgot password?",
  submit: "Sign In",
  footerLead: "Don't have an account?",
  footerLink: "Create account",
} as const;

/**
 * The fixture mode's city images — a fixed table, so a capture is reproducible.
 *
 * Fixture mode resolves nothing: `LocationImage` reads this and stops. That is the point. A
 * screenshot comparison against an approved artifact is only meaningful if the picture is the same
 * on every run, and a provider is free to return a different photograph tomorrow — so a capture run
 * makes no third-party request at all, and works offline.
 *
 * Each entry points at whichever tier is actually present for that place: a photograph committed to
 * `public/locations/photos/<key>.jpg` if the owner has put one there, and otherwise the generated
 * artwork. `locationImageForFixture()` decides which, once, from the manifest below — so adding a
 * photograph to that directory and listing it here is the whole change needed to upgrade a screen
 * from artwork to a photograph, with no component touched.
 *
 * The five cities are the ones the approved screens need: Berlin and Munich for
 * `04-compare-cities.png`, Berlin for `01-dashboard.png`, and Tokyo, New York and London for the
 * Dashboard's snapshots and the saved rail.
 */
const FIXTURE_PHOTO_MANIFEST: readonly string[] = [
  /*
   * Keys with a committed photograph under `public/locations/photos/`.
   *
   * **Empty, deliberately.** No photograph is committed here, because a city photograph carries a
   * licence and this repository is not the place to assert one is cleared for the owner's use.
   * Configure `CITY_IMAGE_PROVIDER` for production, or drop licensed files into that directory and
   * add their keys here for the fixtures. Until then every entry below resolves to tier 3, and
   * `lib/images/locations.test.ts` asserts this list and that directory agree.
   */
];

/** One fixture image: a committed photograph if the manifest lists one, else the drawn artwork. */
function locationImageForFixture(key: string, displayName: string): FixtureLocationImage {
  if (FIXTURE_PHOTO_MANIFEST.includes(key)) {
    return {
      url: `/locations/photos/${key}.jpg`,
      description: `${displayName}, photographed`,
      source: "local",
    };
  }
  const asset = FIXTURE_DRAWN.includes(key) ? key : "generic";
  return {
    url: `/locations/${asset}.svg`,
    description: `${displayName}, shown as generated decorative artwork`,
    source: "generated",
  };
}

/** Shaped to match `ResolvedLocationImage`, without importing it — this module stays dependency-free. */
export interface FixtureLocationImage {
  readonly url: string;
  readonly description: string;
  readonly source: "provider" | "local" | "generated";
}

/** The keys `scripts/generate-location-art.mjs` draws. */
const FIXTURE_DRAWN: readonly string[] = [
  "berlin",
  "munich",
  "hamburg",
  "tokyo",
  "london",
  "new-york",
  "paris",
  "springfield",
];

/** The table `LocationImage` reads in fixture mode, keyed by `locationKey()`. */
export const FIXTURE_LOCATION_IMAGES: Readonly<Record<string, FixtureLocationImage>> = {
  berlin: locationImageForFixture("berlin", "Berlin, Germany"),
  munich: locationImageForFixture("munich", "Munich, Germany"),
  tokyo: locationImageForFixture("tokyo", "Tokyo, Japan"),
  "new-york": locationImageForFixture("new-york", "New York, USA"),
  london: locationImageForFixture("london", "London, UK"),
};
