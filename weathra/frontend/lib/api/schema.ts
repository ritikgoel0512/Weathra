/**
 * The backend's API contract, in TypeScript.
 *
 * GENERATED FILE — do not edit. Regenerate with `npm run api:types` after the backend's
 * `openapi.json` changes (which `python scripts/dump_openapi.py` in backend/ produces).
 *
 * Property names are the wire format's, so they stay snake_case: this describes what the API
 * sends, not how the frontend would have named it. A property is optional here exactly when the
 * contract permits the payload to omit it.
 */

/** What a whole-account deletion removed, per table. */
export interface AccountDeletionReport {
  readonly agent_runs: number;
  readonly preferences: number;
  readonly profile: number;
  readonly saved_locations: number;
  readonly thread_checkpoints_cleared: number;
  readonly threads: number;
  readonly user_id: string;
}

/** The four specialized agents, plus the two nodes that frame a run. */
export type AgentName = "supervisor" | "forecast" | "historical" | "analytics" | "rag" | "synthesis";

/** One agent's turn in the run, in order, with what it cost. */
export interface AgentStep {
  readonly agent: AgentName;
  readonly duration_ms: number;
  /** Why the supervisor selected it, or why it failed or was skipped. */
  readonly reason?: string | null;
  readonly sequence: number;
  readonly started_at: string;
  readonly status: StepStatus;
}

/** Several places matched and no qualifier chose between them. */
export interface AmbiguousResponse {
  readonly candidates: Location[];
  readonly kind?: "ambiguous";
  readonly message: string;
  readonly query: string;
}

/** A composed, self-describing analysis of one forecast window. */
export interface AnalysisResponse {
  readonly anomalies?: AnomalyReport | null;
  readonly data_class: DataClass;
  /** Every computed figure, each with its method, unit, and point count. */
  readonly findings: StatisticResult[];
  readonly from_cache: boolean;
  readonly horizon_days: number;
  readonly location: Location;
  readonly period: Period;
  readonly provider: string;
  /** Written by code, from the findings only. No model involved. */
  readonly summary: string;
  readonly thresholds?: ThresholdReport[];
  readonly trend?: TrendReport | null;
  readonly uncertainty: UncertaintyStatement;
  readonly units: UnitSystem;
}

/** One entry that stood out, with how far out it stood. */
export interface AnomalyPoint {
  /** Signed distance from the series median, in the measure's own unit. */
  readonly deviation: number;
  /** Deviation in median-absolute-deviations — what the threshold is compared to. */
  readonly deviation_score: number;
  readonly time_local: string;
  readonly time_utc: string;
  readonly value: number;
}

/** What stood out in a window, by a stated method, with the extremes always reported. */
export interface AnomalyReport {
  readonly anomalies?: AnomalyPoint[];
  readonly data_class?: "computed_statistic";
  /** Always reported, anomalies or not. */
  readonly maximum: StatisticResult;
  readonly measure: Measure;
  readonly median: number;
  readonly median_absolute_deviation: number;
  readonly method: string;
  /** Always reported, anomalies or not. */
  readonly minimum: StatisticResult;
  /** Stated when the method could not run — a flat window, for instance. */
  readonly note?: string | null;
  readonly points_excluded?: number;
  readonly points_used: number;
  readonly provenance: Provenance;
  /** Deviation score beyond which an entry is anomalous. */
  readonly threshold: number;
  /** Empty when the measure was not supplied at all; `note` then says so. */
  readonly unit: string;
}

/** The response an answer-bearing endpoint returns. */
export interface AnswerEnvelope {
  /** Model-written interpretation of results it did not compute. Empty when the hard grounding guard withheld it. */
  readonly answer_prose: string;
  readonly attribution?: EvidenceAttribution[];
  /** Set instead of an answer when a reference could not be resolved — asked rather than assumed. */
  readonly clarification_question?: string | null;
  readonly evidence: EvidenceRecord;
  readonly findings?: Finding[];
  readonly grounding: GroundingReport;
  readonly llm_model?: string | null;
  readonly llm_provider?: string | null;
  readonly prose_data_class?: "ai_interpretation";
  readonly request_id: string;
  readonly resolved?: ResolvedContext | null;
  readonly thread_id?: string | null;
  /** Parts of a multi-part question that could not be answered, named explicitly rather than silently dropped. */
  readonly unanswered_parts?: string[];
  /** Present whenever the answer contains a forecast figure. */
  readonly uncertainty?: UncertaintyStatement | null;
}

/** A question, and optionally the conversation it belongs to. */
export interface AskRequest {
  /** Start a new thread for this question and return its id in the response. */
  readonly create_thread?: boolean;
  readonly question: string;
  /** One of *your* threads, to resolve a follow-up against. A thread you do not own is refused as not found. */
  readonly thread_id?: string | null;
  /** Overrides your saved preference for this question only. */
  readonly units?: UnitSystem | null;
}

/** The answer envelope, plus where the evidence was stored. */
export interface AskResponse {
  readonly answer: AnswerEnvelope;
  /** The stored record's identifier, for /evidence/{id}. Null when the record could not be stored — the answer is still complete and its evidence travels inside it. */
  readonly evidence_id?: string | null;
  /** False when conversation memory was unreachable for this run. */
  readonly memory_available: boolean;
  readonly memory_note?: string | null;
  readonly thread_id?: string | null;
}

/** A multi-year baseline for one location and calendar period, computed by Weathra. */
export interface Baseline {
  /** The calendar window the baseline describes. */
  readonly calendar_period: Period;
  /** Set when fewer years were available than requested. */
  readonly coverage_note?: string | null;
  readonly data_class?: DataClass;
  readonly labelling: string;
  readonly location: Location;
  readonly maximum: StatisticResult;
  readonly mean: StatisticResult;
  readonly measure: Measure;
  readonly minimum: StatisticResult;
  readonly provider: string;
  readonly standard_deviation: StatisticResult;
  readonly unit_system: UnitSystem;
  readonly years_requested: number;
  readonly years_used: number[];
}

/** A current or forecast value placed against a baseline. */
export interface BaselineComparison {
  readonly baseline: Baseline;
  readonly characterization: string;
  readonly difference: StatisticResult;
  /** Present when one side is a forecast: that side is uncertain, and it says so. */
  readonly forecast_side_caveat?: string | null;
  readonly location: Location;
  readonly measure: Measure;
  readonly observed_data_class: DataClass;
  readonly observed_or_forecast_value: number;
  readonly z_score: StatisticResult;
}

/** One ranked candidate — a location, or a day at one location — with its evidence. */
export interface ComparisonCandidate {
  /** Populated for the composite criterion; empty for a single-measure one. */
  readonly contributions?: ComponentContribution[];
  /** What to call it: a place name, or a local date. */
  readonly label: string;
  readonly location: Location;
  /** Evaluated in this candidate's own local time, which the result states. */
  readonly period: Period;
  /** Shared by tied candidates rather than broken arbitrarily. */
  readonly rank: number;
  readonly score: number;
  /** The analytics results that produced the score. */
  readonly supporting: StatisticResult[];
  readonly tied?: boolean;
}

/** What is being compared. */
export type ComparisonMode = "locations" | "days";

/** What to compare, on what criterion, over what window. */
export interface ComparisonRequest {
  /** What 'best' means for this comparison. */
  readonly criterion: Criterion;
  /** Forecast horizon. */
  readonly days?: number | null;
  readonly end?: string | null;
  /** One place, for a day-level comparison within its window. */
  readonly location?: string | null;
  /** Two or more place names, for a comparison across places. Omit and supply one location to compare the days within a single place's window instead. */
  readonly locations?: string[];
  /** A registered provider. The configured default if omitted. */
  readonly provider?: string | null;
  /** With `end`, compares archive observations instead. */
  readonly start?: string | null;
  /** Overrides your saved preference for this request only. */
  readonly units?: UnitSystem | null;
}

/** A completed comparison: the ranking, the shared basis, and what was left out. */
export interface ComparisonResult {
  readonly candidates: ComparisonCandidate[];
  readonly criterion: Criterion;
  /** Which class every candidate was evaluated from. Never mixed. */
  readonly data_class: DataClass;
  readonly excluded?: ExcludedCandidate[];
  /** Whether the window was applied in each candidate's own local time. */
  readonly local_time_basis?: boolean;
  readonly mode: ComparisonMode;
  /** The shared window, applied in each candidate's local time. */
  readonly period: Period;
  readonly provider: string;
  /** The same statistics were applied to every candidate. */
  readonly statistics_applied: string[];
  /** Scores within this are reported tied at the same rank. */
  readonly tie_tolerance: number;
  readonly unit_system: UnitSystem;
  /** Required for the composite criterion: whose heuristic the weights are. */
  readonly weighting_disclosure?: string | null;
}

/** One measure's part in a composite score: which way it counts, how much, and to what effect. */
export interface ComponentContribution {
  /** Weighted points this component added to the score. */
  readonly contribution: number;
  /** ABOVE when a higher value scores better, BELOW when a lower one does. */
  readonly direction: Direction;
  readonly measure: Measure;
  /** The analytics result the value came from. */
  readonly supporting: StatisticResult;
  readonly unit: string;
  /** The measured input, in `unit`. */
  readonly value: number;
  /** This component's share of the score. */
  readonly weight: number;
}

/** How much assurance a forecast figure deserves, by distance into the horizon. */
export type ConfidenceBand = "high" | "moderate" | "low";

/** The supported ways to rank. Anything else is rejected with this list. */
export type Criterion = "warmest" | "coolest" | "driest" | "wettest" | "least_windy" | "outdoor_suitability";

/** One transition into the condition, with the reading at that point. */
export interface Crossing {
  readonly time_local: string;
  readonly time_utc: string;
  readonly value: number;
}

/** Current conditions. Labelled ``current`` and never as a forecast. */
export interface CurrentResponse {
  readonly attribution: WeatherAttribution;
  /** The same instant, at the location. */
  readonly observed_at_local: string;
  /** The instant these values describe. */
  readonly observed_at_utc: string;
  readonly units: Record<string, string>;
  /** Per measure. Null means 'not reported' and is never a zero. */
  readonly values: Record<string, number | null>;
}

/** What kind of thing a reported value is. */
export type DataClass = "current" | "forecast" | "historical_observation" | "computed_statistic" | "ai_interpretation";

/** How one day's figures moved between two retrievals of the same window. */
export interface DayChange {
  /** Current minus previous. Null when either side is absent. */
  readonly change?: number | null;
  readonly current: number | null;
  /** The local calendar date, ISO-8601. */
  readonly local_date: string;
  /** False when the movement is inside the measure's materiality margin. */
  readonly material: boolean;
  readonly measure: Measure;
  readonly previous: number | null;
  readonly statement: string;
  readonly unit: string;
}

/** What the deletion removed, per table, and what it deliberately did not. */
export interface DeletionResponse {
  readonly note: string;
  readonly removed: AccountDeletionReport;
  readonly total: number;
}

/** One dependency: what it is, whether it is configured, and whether it answered. */
export interface DependencyStatus {
  /** Whether the deployment supplies what it needs. */
  readonly configured: boolean;
  /** What an operator needs to act. Never a credential. */
  readonly detail?: string | null;
  readonly name: string;
  /** Whether it answered just now. Null when not checked — either because it is not configured, or because checking it would cost more than the report is worth. */
  readonly reachable?: boolean | null;
  /** False for a dependency whose absence leaves the service usable. */
  readonly required?: boolean;
}

/** Which way is "better" for a measure under a criterion, and which way a threshold points. */
export type Direction = "above" | "below";

/** Who supplied a piece of data, for where, for when, and when it was fetched. */
export interface EvidenceAttribution {
  readonly data_class: DataClass;
  readonly location: Location;
  /** For a window. Null when the datum is a single instant. */
  readonly period?: Period | null;
  readonly provider: string;
  readonly retrieved_at: string;
  /** For a single instant, such as current conditions. */
  readonly timestamp_utc?: string | null;
}

/** Everything the run did, sufficient to check every figure without re-running it. */
export interface EvidenceRecord {
  readonly agents?: AgentStep[];
  readonly analytics_results?: StatisticResult[];
  readonly anomaly_reports?: AnomalyReport[];
  readonly attributions?: EvidenceAttribution[];
  readonly citations?: KnowledgeCitation[];
  readonly completed_at: string;
  readonly data_classes?: DataClass[];
  readonly llm_model?: string | null;
  /** Null when the run answered without a model. */
  readonly llm_provider?: string | null;
  /** True when a budget was exhausted before a complete answer. */
  readonly partial?: boolean;
  readonly partial_reason?: string | null;
  readonly question: string;
  readonly request_id: string;
  /** Why the supervisor chose the agents it chose. */
  readonly routing_reason?: string | null;
  readonly routing_source?: "model" | "deterministic_fallback";
  readonly started_at: string;
  readonly steps_used?: number;
  readonly thread_id?: string | null;
  readonly tool_calls?: ToolCall[];
  readonly tool_results?: ToolResult[];
  readonly total_duration_ms: number;
  readonly trend_reports?: TrendReport[];
}

/** One stored run: the question, the answer, and everything behind it. */
export interface EvidenceResponse {
  readonly answer_prose?: string | null;
  readonly created_at: string;
  readonly duration_ms: number;
  /** The response as it was returned. */
  readonly envelope: Record<string, unknown>;
  /** The full audit trail: agents, tool calls and results, analytics, citations. */
  readonly evidence: Record<string, unknown>;
  readonly id: string;
  readonly llm_model?: string | null;
  readonly llm_provider?: string | null;
  readonly partial: boolean;
  readonly question: string;
  readonly request_id: string;
  readonly thread_id?: string | null;
  readonly weather_provider?: string | null;
}

/** A candidate whose data could not be retrieved, listed with why. */
export interface ExcludedCandidate {
  /** The stable error code behind the exclusion. */
  readonly code: string;
  readonly label: string;
  /** Absent when the exclusion was a resolution failure. */
  readonly location?: Location | null;
  /** Stated plainly, with no raw upstream payload. */
  readonly reason: string;
}

/** One structured value the answer rests on, with everything needed to check it. */
export interface Finding {
  readonly attribution: EvidenceAttribution;
  readonly data_class: DataClass;
  /** What this figure is, in plain words. */
  readonly label: string;
  /** Set for a computed statistic; null for a retrieved reading. */
  readonly method?: string | null;
  readonly points_used?: number | null;
  /** The analytics result this finding was taken from, verbatim. */
  readonly supporting?: StatisticResult | null;
  /** For a non-numeric finding: a direction sector, a trend. */
  readonly text_value?: string | null;
  /** Why there is no value. Required when there is none. */
  readonly unavailable_reason?: string | null;
  readonly unit?: string | null;
  /** Null states 'unavailable' — never a filled-in estimate. */
  readonly value?: number | null;
}

/** A forecast, with its horizon, its series, and its uncertainty. */
export interface ForecastResponse {
  readonly attribution: WeatherAttribution;
  readonly daily: Series;
  readonly horizon_days: number;
  readonly hourly: Series;
  readonly period: Period;
  /** Required on every forecast: confidence by horizon distance, and the basis. */
  readonly uncertainty: UncertaintyStatement;
}

/** The time resolution of a series. */
export type Granularity = "hourly" | "daily";

/** What the grounding layers found (design.md decision 15). */
export interface GroundingReport {
  readonly figures_checked: number;
  /** How figures were extracted and matched, including the rounding tolerance. */
  readonly method: string;
  readonly note?: string | null;
  /** True when the hard zero-retrieval guard fired and the prose was withheld. */
  readonly prose_discarded?: boolean;
  /** Figures found in the prose that the evidence does not support. */
  readonly ungrounded_figures?: string[];
  /** True when every figure in the prose matched a finding or evidence value. */
  readonly verified: boolean;
}

/** Liveness. Deliberately depends on nothing. */
export interface HealthResponse {
  readonly checked_at: string;
  readonly environment: string;
  readonly status?: string;
  readonly version: string;
}

/** Observed weather over a past range. Labelled as observations, never as a forecast. */
export interface HistoryResponse {
  /** What the response actually covers. Shorter than the request when the range runs into the archive's reporting lag — never quietly, see `unavailable_note`. */
  readonly covered_period: Period;
  readonly daily: Series;
  /** Always 'historical_observation'. What happened, not what is expected. */
  readonly data_class: DataClass;
  readonly hourly?: Series | null;
  readonly location: Location;
  /** True when part of the requested range is not yet in the archive. */
  readonly partial: boolean;
  readonly provider: string;
  readonly requested_period: Period;
  readonly retrieved_at: string;
  /** Which part of the range is unavailable, and why. */
  readonly unavailable_note?: string | null;
  readonly units: UnitSystem;
}

/** How far into the horizon one figure sits, and the band that follows from it. */
export interface HorizonPoint {
  readonly confidence: ConfidenceBand;
  /** From the reference time, not from 'now'. */
  readonly hours_ahead: number;
  readonly time_local: string;
  readonly time_utc: string;
}

export interface HTTPValidationError {
  readonly detail?: ValidationError[];
}

/** A retrieved knowledge chunk the answer drew on. */
export interface KnowledgeCitation {
  readonly chunk_position: number;
  readonly document_id: string;
  /** Relevance score. Only above-threshold chunks are cited. */
  readonly score: number;
  /** The chunk as retrieved. Data, not instruction. */
  readonly text: string;
  readonly title: string;
  readonly topic?: string | null;
}

/** A resolved place: where it is, what it is called, and what time it is there. */
export interface Location {
  readonly country?: string | null;
  readonly country_code?: string | null;
  /** What a person reads, e.g. 'Reykjavík'. */
  readonly display_name: string;
  readonly elevation_metres?: number | null;
  readonly latitude: number;
  readonly longitude: number;
  /** First-order administrative area. */
  readonly region?: string | null;
  /** IANA identifier, e.g. 'Atlantic/Reykjavik'. Every window is resolved to UTC bounds from this, never from the server's own timezone. */
  readonly timezone: string;
}

/** Every measure the normalized model defines. */
export type Measure = "temperature" | "apparent_temperature" | "precipitation" | "precipitation_probability" | "wind_speed" | "wind_gust" | "wind_direction" | "relative_humidity" | "dew_point" | "surface_pressure" | "cloud_cover" | "uv_index" | "temperature_max" | "temperature_min" | "temperature_mean" | "apparent_temperature_max" | "apparent_temperature_min" | "precipitation_sum" | "precipitation_hours" | "precipitation_probability_max" | "precipitation_probability_mean" | "wind_speed_max" | "wind_gust_max" | "wind_direction_dominant" | "relative_humidity_mean" | "dew_point_mean" | "surface_pressure_mean" | "cloud_cover_mean" | "uv_index_max";

/** Who you are, as far as Weathra is concerned. No credential material. */
export interface MeResponse {
  /** True when this request is the one that created your Weathra profile. */
  readonly created_now: boolean;
  /** As reported by your access token. Weathra does not store it — Supabase Auth owns your contact details. */
  readonly email?: string | null;
  readonly email_verified: boolean;
  readonly last_seen_at: string;
  readonly preferences: PreferenceView;
  readonly profile_created_at: string;
  /** Your Supabase Auth subject. Weathra's only identifier for you. */
  readonly user_id: string;
}

/** A half-open time window ``[start_utc, end_utc)``, resolved from a location's timezone. */
export interface Period {
  readonly end_local: string;
  readonly end_utc: string;
  readonly start_local: string;
  readonly start_utc: string;
  /** IANA identifier the local bounds are in. */
  readonly timezone: string;
}

/** Two past periods, their aggregates, and the signed differences between them. */
export interface PeriodComparison {
  /** The shared basis, stated in the result. */
  readonly basis: string;
  readonly data_class?: DataClass;
  readonly deltas?: StatisticResult[];
  readonly earlier: StatisticResult[];
  readonly earlier_period: Period;
  readonly later: StatisticResult[];
  readonly later_period: Period;
  readonly lengths_differ: boolean;
  readonly location: Location;
  readonly percentage_changes?: Record<string, number | null>;
  readonly provider: string;
  readonly statistics_applied: string[];
  readonly unit_system: UnitSystem;
}

/** One timestamped value in a series-shaped result: a per-day total, a rolling mean. */
export interface PointValue {
  readonly time_local: string;
  readonly time_utc: string;
  /** Null where the window had nothing usable. */
  readonly value: number | null;
}

/** Where a reported preference value came from. Half the point of the response. */
export type PreferenceSource = "chosen" | "default";

/** A preference change. Every field is an explicit choice you are making. */
export interface PreferenceUpdate {
  readonly clear_default_location?: boolean;
  readonly clear_forecast_horizon?: boolean;
  /** Clear the unit preference back to the documented default. */
  readonly clear_unit_system?: boolean;
  /** A place name. Resolved and stored canonically. */
  readonly default_location?: string | null;
  readonly forecast_horizon_days?: number | null;
  readonly unit_system?: UnitSystem | null;
}

/** The acting user's effective preferences, each labelled chosen or default. */
export interface PreferenceView {
  readonly default_location?: Location | null;
  readonly forecast_horizon_days: number;
  /** Per field: whether the person chose this value or Weathra assumed it. */
  readonly sources: Record<string, PreferenceSource>;
  readonly unit_system: UnitSystem;
}

/** Where the numbers behind a result came from. */
export interface Provenance {
  readonly location: Location;
  readonly period: Period;
  /** Whose data was analysed. */
  readonly provider: string;
  /** When that series was obtained from upstream. */
  readonly retrieved_at: string;
  /** What the analysed series was — a forecast, or a historical observation. */
  readonly source_data_class: DataClass;
  readonly unit_system: UnitSystem;
}

/** What is configured, what is reachable, and whether the service can serve. */
export interface ReadinessResponse {
  readonly checked_at: string;
  readonly dependencies: DependencyStatus[];
  readonly environment: string;
  readonly note?: string | null;
  /** True when every *required* dependency is reachable. An unconfigured inference provider does not make the service unready: every other capability still works. */
  readonly ready: boolean;
  readonly version: string;
}

/** What the run decided the question was actually about. */
export interface ResolvedContext {
  readonly criterion?: string | null;
  readonly location_source?: "request" | "thread" | "preferences" | "none";
  readonly locations?: Location[];
  readonly period?: Period | null;
  /** The plain sentence shown to the reader. */
  readonly statement?: string | null;
  readonly unit_system?: string | null;
  readonly units_source?: "request" | "thread" | "preferences" | "default";
}

/** Exactly one place matched. */
export interface ResolvedResponse {
  readonly kind?: "resolved";
  readonly location: Location;
  readonly query: string;
}

/** One saved location as a caller sees it. */
export interface SavedLocationRecord {
  /** Whether this save created the entry or matched one already there. */
  readonly created_now?: boolean;
  readonly id: string;
  /** The person's own name for it, if any. */
  readonly label?: string | null;
  /** The canonical resolved location. */
  readonly location: Location;
}

/** A place to save, by name or by coordinates, with an optional label of your own. */
export interface SavedLocationRequest {
  readonly label?: string | null;
  readonly latitude?: number | null;
  readonly location?: string | null;
  readonly longitude?: number | null;
}

/** Your saved locations, and the limit they count against. */
export interface SavedLocationsResponse {
  readonly count: number;
  readonly limit: number;
  readonly locations: SavedLocationRecord[];
}

/** Ranked candidates for a partial query. An empty list is a real answer. */
export interface SearchResponse {
  readonly count: number;
  readonly note?: string | null;
  readonly query: string;
  readonly results: Location[];
}

/** An ordered run of entries at one granularity, with one units map for the whole series. */
export interface Series {
  readonly entries?: SeriesEntry[];
  readonly granularity: Granularity;
  /** Every measure the series declares, and the unit it is expressed in. */
  readonly units: Record<string, string>;
}

/** One point in a series: the instant, in both forms, and its measured values. */
export interface SeriesEntry {
  /** What a person reads. Carries the offset. */
  readonly time_local: string;
  /** Used by every window, threshold, and comparison. */
  readonly time_utc: string;
  /** A null means the provider did not supply the measure — never zero. */
  readonly values: Record<string, number | null>;
}

/** A provider-supplied range around a figure, where the provider supplies one. */
export interface SpreadPoint {
  readonly lower: number;
  readonly measure: Measure;
  readonly time_utc: string;
  readonly upper: number;
}

/** Every statistic the deterministic engine produces. */
export type Statistic = "minimum" | "maximum" | "mean" | "range" | "total" | "daily_totals" | "wet_entry_count" | "probability_maximum" | "probability_mean" | "probability_exceedance" | "mean_speed" | "maximum_sustained_speed" | "maximum_gust" | "prevailing_direction" | "rolling_mean" | "percentile" | "delta" | "z_score" | "standard_deviation" | "anomalies" | "trend" | "baseline";

/** One computed — or explicitly not-computable — statistic, fully self-describing. */
export interface StatisticResult {
  readonly data_class?: "computed_statistic";
  readonly measure: Measure;
  /** How it was computed, stated rather than implied — 'arithmetic mean of usable points', 'linear interpolation (numpy default)', 'least-squares slope'. */
  readonly method: string;
  /** The declared minimum this statistic needs to be computable. */
  readonly minimum_points: number;
  readonly occurred_at_local?: string | null;
  /** When an extreme occurred. Set for minima, maxima, and gusts. */
  readonly occurred_at_utc?: string | null;
  /** What the caller asked for: window length, level, k. */
  readonly parameters?: Record<string, unknown>;
  /** Points excluded because the value was absent — never zeroed. */
  readonly points_excluded?: number;
  /** Usable points that went into the value. */
  readonly points_used: number;
  readonly provenance: Provenance;
  /** Why it was not computable. Required when it was not. */
  readonly reason?: string | null;
  readonly statistic: Statistic;
  readonly status?: "computed" | "not_computable";
  /** Whether the extreme was shared by more than one entry. */
  readonly tied?: boolean;
  /** Every tied timestamp, earliest first, when an extreme was tied. */
  readonly tied_at?: string[];
  /** The unit the value is expressed in. Empty only for a not-computable result whose measure the series never declared — there is no unit to state for a measure the provider does not supply. */
  readonly unit: string;
  /** The scalar result, for scalar statistics. */
  readonly value?: number | null;
  /** The sequence, for series-shaped statistics. */
  readonly values?: PointValue[] | null;
}

/** How a step ended. ``skipped`` covers a step a budget cut short. */
export type StepStatus = "succeeded" | "failed" | "skipped";

export interface ThreadsResponse {
  readonly count: number;
  readonly threads: ThreadSummary[];
}

/** One of your conversation threads, as a sidebar lists it. */
export interface ThreadSummary {
  readonly created_at: string;
  /** When bounded retention will remove it, unless it is used again. */
  readonly expires_at: string;
  readonly id: string;
  readonly last_activity_at: string;
  /** The places this conversation has established. */
  readonly locations?: string[];
  readonly title?: string | null;
}

/** What the caller wants to know about: a measure, a direction, and a value. */
export interface ThresholdCondition {
  readonly direction: Direction;
  readonly measure: Measure;
  readonly value: number;
}

/** Whether and when a condition was met across the window. */
export interface ThresholdReport {
  readonly condition: ThresholdCondition;
  readonly crossed: boolean;
  readonly crossings?: Crossing[];
  readonly data_class: DataClass;
  readonly method: string;
  readonly points_excluded?: number;
  readonly points_used: number;
  readonly provenance: Provenance;
  /** The plain sentence a reader sees. */
  readonly statement: string;
  readonly unit: string;
}

/** A tool invocation as it was actually made. */
export interface ToolCall {
  readonly agent: AgentName;
  /** What was passed. Never a credential. */
  readonly arguments?: Record<string, unknown>;
  readonly duration_ms: number;
  /** Execution order within the run. */
  readonly sequence: number;
  readonly started_at: string;
  readonly tool: string;
}

/** What a tool returned, or the coded reason it did not. */
export interface ToolResult {
  readonly attribution?: EvidenceAttribution | null;
  /** What the result was. Null for an error. */
  readonly data_class?: DataClass | null;
  readonly error_code?: string | null;
  readonly error_message?: string | null;
  readonly ok: boolean;
  /** The normalized result. Never a raw upstream payload. */
  readonly payload?: Record<string, unknown> | null;
  /** Matches the ToolCall it answers. */
  readonly sequence: number;
  readonly tool: string;
}

/** The classification a trend slope falls into, against its insignificance margin. */
export type TrendDirection = "rising" | "falling" | "steady";

/** Which way a measure moved across a window, by least-squares slope. */
export interface TrendReport {
  readonly data_class?: "computed_statistic";
  readonly direction: TrendDirection;
  /** Below this slope the movement is reported as steady. */
  readonly insignificance_margin_per_day: number;
  /** Total modelled change across the window, in the measure's unit. */
  readonly magnitude: number;
  readonly measure: Measure;
  readonly method: string;
  readonly minimum_points: number;
  readonly points_excluded?: number;
  readonly points_used: number;
  readonly provenance: Provenance;
  readonly slope_per_day: number;
  readonly unit: string;
}

/** What a forecast figure's confidence rests on, disclosed rather than implied. */
export interface UncertaintyStatement {
  /** The disclosure a reader sees: confidence decreases with horizon distance, and the signal is derived from one provider's output and its supplied spread only. */
  readonly basis: string;
  readonly horizon?: HorizonPoint[];
  readonly multi_provider_consensus?: false;
  readonly provider: string;
  readonly provider_spread?: SpreadPoint[];
  /** The instant horizon distances are measured from. */
  readonly reference_time_utc: string;
  /** False when the provider supplies no spread, stated rather than inferred. */
  readonly spread_available: boolean;
}

/** The unit system a result is expressed in. Metric unless a caller says otherwise. */
export type UnitSystem = "metric" | "imperial";

export interface ValidationError {
  readonly ctx?: Record<string, unknown>;
  readonly input?: unknown;
  readonly loc: (string | number)[];
  readonly msg: string;
  readonly type: string;
}

/** Where a figure came from, in the structured fields a reader needs. */
export interface WeatherAttribution {
  readonly data_class: DataClass;
  /** Whether this came from Weathra's cache rather than the provider just now. */
  readonly from_cache: boolean;
  readonly location: Location;
  readonly provider: string;
  readonly retrieved_at: string;
  readonly units: UnitSystem;
  /** 'request', 'preferences', or 'default' — what decided the units. */
  readonly units_source: string;
}

/** How the forecast for a location and window has moved since the last earlier snapshot. */
export interface WhatChanged {
  readonly changes?: DayChange[];
  readonly comparison_available: boolean;
  readonly current_retrieved_at: string;
  readonly data_class?: DataClass;
  readonly location: Location;
  readonly period: Period;
  readonly previous_retrieved_at?: string | null;
  readonly provider: string;
  readonly statement: string;
  readonly unit_system: UnitSystem;
}

/** A parameter an operation accepts, as the contract declares it. */
export interface ApiParameter {
  readonly name: string;
  readonly in: "query" | "path" | "header";
  readonly required: boolean;
}

/** One operation the backend serves. */
export interface ApiOperation {
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** Whether the call carries the access token as a bearer header. */
  readonly requiresToken: boolean;
  /** The request body's schema, or null when the operation takes no body. */
  readonly request: string | null;
  /** The status a successful call returns: 200, 201, or 204 for no content. */
  readonly successStatus: number;
  /** The success response's schema, or null when the call returns no JSON body. */
  readonly response: string | null;
  readonly parameters: readonly ApiParameter[];
}

/**
 * Every operation the backend serves, read off its OpenAPI document.
 *
 * The client's tests iterate this, so a protected operation added to the backend is one the
 * frontend's tests immediately have an opinion about.
 */
export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    operationId: "ask_api_v1_agent_ask_post",
    method: "POST",
    path: "/api/v1/agent/ask",
    requiresToken: true,
    request: "AskRequest",
    successStatus: 200,
    response: "AskResponse",
    parameters: [],
  },
  {
    operationId: "stream_api_v1_agent_stream_post",
    method: "POST",
    path: "/api/v1/agent/stream",
    requiresToken: true,
    request: "AskRequest",
    successStatus: 200,
    response: null,
    parameters: [],
  },
  {
    operationId: "evidence_api_v1_evidence__evidence_id__get",
    method: "GET",
    path: "/api/v1/evidence/{evidence_id}",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "EvidenceResponse",
    parameters: [
      { name: "evidence_id", in: "path", required: true },
    ],
  },
  {
    operationId: "health_api_v1_health_get",
    method: "GET",
    path: "/api/v1/health",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "HealthResponse",
    parameters: [],
  },
  {
    operationId: "resolve_api_v1_locations_resolve_get",
    method: "GET",
    path: "/api/v1/locations/resolve",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "ResolvedResponse | AmbiguousResponse",
    parameters: [
      { name: "query", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
    ],
  },
  {
    operationId: "search_api_v1_locations_search_get",
    method: "GET",
    path: "/api/v1/locations/search",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "SearchResponse",
    parameters: [
      { name: "query", in: "query", required: true },
      { name: "limit", in: "query", required: false },
    ],
  },
  {
    operationId: "me_api_v1_me_get",
    method: "GET",
    path: "/api/v1/me",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "MeResponse",
    parameters: [],
  },
  {
    operationId: "delete_my_data_api_v1_me_data_delete",
    method: "DELETE",
    path: "/api/v1/me/data",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "DeletionResponse",
    parameters: [],
  },
  {
    operationId: "list_locations_api_v1_me_locations_get",
    method: "GET",
    path: "/api/v1/me/locations",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "SavedLocationsResponse",
    parameters: [],
  },
  {
    operationId: "save_location_api_v1_me_locations_post",
    method: "POST",
    path: "/api/v1/me/locations",
    requiresToken: true,
    request: "SavedLocationRequest",
    successStatus: 201,
    response: "SavedLocationRecord",
    parameters: [],
  },
  {
    operationId: "remove_location_api_v1_me_locations__saved_id__delete",
    method: "DELETE",
    path: "/api/v1/me/locations/{saved_id}",
    requiresToken: true,
    request: null,
    successStatus: 204,
    response: null,
    parameters: [
      { name: "saved_id", in: "path", required: true },
    ],
  },
  {
    operationId: "read_preferences_api_v1_me_preferences_get",
    method: "GET",
    path: "/api/v1/me/preferences",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "PreferenceView",
    parameters: [],
  },
  {
    operationId: "update_preferences_api_v1_me_preferences_put",
    method: "PUT",
    path: "/api/v1/me/preferences",
    requiresToken: true,
    request: "PreferenceUpdate",
    successStatus: 200,
    response: "PreferenceView",
    parameters: [],
  },
  {
    operationId: "delete_preferences_api_v1_me_preferences_delete",
    method: "DELETE",
    path: "/api/v1/me/preferences",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "PreferenceView",
    parameters: [],
  },
  {
    operationId: "ready_api_v1_ready_get",
    method: "GET",
    path: "/api/v1/ready",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "ReadinessResponse",
    parameters: [],
  },
  {
    operationId: "threads_api_v1_threads_get",
    method: "GET",
    path: "/api/v1/threads",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "ThreadsResponse",
    parameters: [],
  },
  {
    operationId: "thread_api_v1_threads__thread_id__get",
    method: "GET",
    path: "/api/v1/threads/{thread_id}",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "ThreadSummary",
    parameters: [
      { name: "thread_id", in: "path", required: true },
    ],
  },
  {
    operationId: "remove_thread_api_v1_threads__thread_id__delete",
    method: "DELETE",
    path: "/api/v1/threads/{thread_id}",
    requiresToken: true,
    request: null,
    successStatus: 204,
    response: null,
    parameters: [
      { name: "thread_id", in: "path", required: true },
    ],
  },
  {
    operationId: "analysis_api_v1_weather_analysis_get",
    method: "GET",
    path: "/api/v1/weather/analysis",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "AnalysisResponse",
    parameters: [
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
      { name: "days", in: "query", required: false },
      { name: "above", in: "query", required: false },
      { name: "below", in: "query", required: false },
    ],
  },
  {
    operationId: "changes_api_v1_weather_changes_get",
    method: "GET",
    path: "/api/v1/weather/changes",
    requiresToken: true,
    request: null,
    successStatus: 200,
    response: "WhatChanged",
    parameters: [
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
      { name: "days", in: "query", required: false },
    ],
  },
  {
    operationId: "comparison_api_v1_weather_comparison_post",
    method: "POST",
    path: "/api/v1/weather/comparison",
    requiresToken: false,
    request: "ComparisonRequest",
    successStatus: 200,
    response: "ComparisonResult",
    parameters: [],
  },
  {
    operationId: "current_api_v1_weather_current_get",
    method: "GET",
    path: "/api/v1/weather/current",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "CurrentResponse",
    parameters: [
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
    ],
  },
  {
    operationId: "forecast_api_v1_weather_forecast_get",
    method: "GET",
    path: "/api/v1/weather/forecast",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "ForecastResponse",
    parameters: [
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
      { name: "days", in: "query", required: false },
    ],
  },
  {
    operationId: "history_api_v1_weather_history_get",
    method: "GET",
    path: "/api/v1/weather/history",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "HistoryResponse",
    parameters: [
      { name: "start", in: "query", required: true },
      { name: "end", in: "query", required: true },
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
    ],
  },
  {
    operationId: "baseline_api_v1_weather_history_baseline_get",
    method: "GET",
    path: "/api/v1/weather/history/baseline",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "Baseline",
    parameters: [
      { name: "start", in: "query", required: true },
      { name: "end", in: "query", required: true },
      { name: "years", in: "query", required: false },
      { name: "measure", in: "query", required: false },
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
    ],
  },
  {
    operationId: "baseline_comparison_api_v1_weather_history_baseline_comparison_get",
    method: "GET",
    path: "/api/v1/weather/history/baseline/comparison",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "BaselineComparison",
    parameters: [
      { name: "start", in: "query", required: true },
      { name: "end", in: "query", required: true },
      { name: "years", in: "query", required: false },
      { name: "measure", in: "query", required: false },
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
    ],
  },
  {
    operationId: "comparison_api_v1_weather_history_comparison_get",
    method: "GET",
    path: "/api/v1/weather/history/comparison",
    requiresToken: false,
    request: null,
    successStatus: 200,
    response: "PeriodComparison",
    parameters: [
      { name: "earlier_start", in: "query", required: true },
      { name: "earlier_end", in: "query", required: true },
      { name: "later_start", in: "query", required: true },
      { name: "later_end", in: "query", required: true },
      { name: "location", in: "query", required: false },
      { name: "latitude", in: "query", required: false },
      { name: "longitude", in: "query", required: false },
      { name: "units", in: "query", required: false },
      { name: "provider", in: "query", required: false },
    ],
  },
];
