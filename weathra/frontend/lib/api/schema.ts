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
  readonly usage_counters?: number;
  readonly usage_events?: number;
  readonly user_id: string;
}

/** What an administrative write did. The verb half of an audit row. */
export type AdminAction = "catalog_create" | "catalog_edit" | "catalog_enable" | "catalog_disable" | "policy_create" | "policy_edit" | "plan_mapping_edit" | "allowance_set" | "plan_assign" | "role_grant" | "role_revoke";

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

export interface AllowanceListResponse {
  readonly allowances: AllowanceRecord[];
  readonly count: number;
}

/** One allowance: a subject, a dimension, a window, a number. */
export interface AllowanceRecord {
  readonly allowance: number;
  readonly dimension: QuotaDimension;
  readonly internal_subject?: string | null;
  readonly plan_code?: PlanCode | null;
  readonly window_kind: QuotaWindow;
}

/** One allowance, for a plan or for the internal subject. */
export interface AllowanceRequest {
  readonly allowance: number;
  readonly dimension: QuotaDimension;
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
  readonly latitude?: number | null;
  /** The place this conversation is pointed at — the Analyst's FOCUS. A place name, resolved server-side. It applies when the question names no place of its own, and takes precedence over the thread's context and your saved default. Send the coordinates you already resolved alongside it to pin which candidate you meant. */
  readonly location?: string | null;
  readonly longitude?: number | null;
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

/** One administrative change, as it is recorded. */
export interface AuditEntry {
  readonly acting_principal: string;
  readonly action: AdminAction;
  readonly after?: Record<string, unknown> | null;
  readonly before?: Record<string, unknown> | null;
  readonly cited_comparison_run_ids?: string[];
  readonly created_at?: string | null;
  readonly subject_id: string;
  /** Which kind of record changed. */
  readonly subject_kind: string;
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
  /** Each reference year's own mean for this window, ascending by year. */
  readonly yearly_means?: YearlyMean[];
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
  /** Where the compared value sits among the baseline's per-year means, as a percentile. Not computable, with its reason, where too few years are available to rank against. */
  readonly percentile_rank: StatisticResult;
  readonly z_score: StatisticResult;
}

/** The role a language model call serves, which is what a policy maps against. */
export type CallRole = "routing" | "synthesis" | "lab";

/** What a policy orders candidates by. Weathra's own judgement, never a vendor's marketing. */
export type CapabilityTier = "economy" | "standard" | "frontier";

/** A new catalog entry, with every field the resolver and the cost estimator need. */
export interface CatalogCreateRequest {
  readonly capability_roles: CallRole[];
  readonly capability_tier: CapabilityTier;
  readonly catalog_key: string;
  readonly context_window: number;
  readonly display_name: string;
  readonly gateway_model: string;
  readonly gateway_provider: string;
  readonly input_price_per_million: number | string;
  readonly is_free_tier: boolean;
  readonly output_price_per_million: number | string;
  readonly price_currency?: string;
  readonly pricing_recorded_on: string;
  readonly status?: CatalogStatus;
  readonly supports_structured_output: boolean;
}

/** The editable half of an entry. ``status`` is deliberately absent. */
export interface CatalogEditRequest {
  readonly capability_roles?: CallRole[] | null;
  readonly capability_tier?: CapabilityTier | null;
  readonly context_window?: number | null;
  readonly display_name?: string | null;
  readonly gateway_model?: string | null;
  readonly gateway_provider?: string | null;
  readonly input_price_per_million?: number | string | null;
  readonly is_free_tier?: boolean | null;
  readonly output_price_per_million?: number | string | null;
  readonly price_currency?: string | null;
  readonly pricing_recorded_on?: string | null;
  readonly supports_structured_output?: boolean | null;
}

/** One model Weathra is allowed to use, as the stores hand it out. */
export interface CatalogEntry {
  readonly capability_roles: CallRole[];
  readonly capability_tier: CapabilityTier;
  /** The stable internal handle. Never a vendor name. */
  readonly catalog_key: string;
  readonly context_window: number;
  readonly display_name: string;
  /** The vendor string. Mutable; a rename is one row. */
  readonly gateway_model: string;
  readonly gateway_provider: string;
  readonly input_price_per_million: string;
  readonly is_free_tier: boolean;
  readonly output_price_per_million: string;
  readonly price_currency: string;
  readonly pricing_recorded_on: string;
  readonly status: CatalogStatus;
  readonly supports_structured_output: boolean;
}

export interface CatalogListResponse {
  readonly count: number;
  readonly entries: CatalogEntry[];
  /** The most recent evaluation outcome per catalog entry, where one exists. */
  readonly observations?: Record<string, CatalogObservation>;
}

/** What the lab last recorded about one model. */
export interface CatalogObservation {
  readonly criteria?: Record<string, unknown>;
  readonly dataset_version: string;
  readonly gateway_model: string;
  readonly passed?: boolean | null;
  readonly recorded_at?: string | null;
}

/** Whether an entry may be resolved at all. */
export type CatalogStatus = "enabled" | "disabled";

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
  /** How the two compared places' trajectories moved together, as Pearson's r over the instants both reported. Present only for a two-candidate comparison: a single coefficient describes one pair, and N places have N(N-1)/2 of them. Not computable, with its reason, where the pair shares too few instants or either side was flat. */
  readonly correlation?: StatisticResult | null;
  readonly criterion: Criterion;
  /** Which class every candidate was evaluated from. Never mixed. */
  readonly data_class: DataClass;
  /** How much of the window every candidate actually reported, as a percentage. Counts only instants every candidate carries a value for, because a slot one place reported and another did not is a slot the comparison could not use. */
  readonly data_density?: StatisticResult | null;
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

/** One model's outcome for one case. Every measure `specs/model-lab` names, or a null. */
export interface ComparisonResultRecord {
  /** Where the agent path ran, the run whose evidence explains it. */
  readonly agent_run_id?: string | null;
  readonly case_id: string;
  readonly catalog_key: string;
  readonly completion_tokens?: number | null;
  readonly estimated_cost?: string | null;
  readonly evaluation_id?: string | null;
  readonly failure_class?: FailureClass | null;
  readonly gateway_model: string;
  readonly latency_ms?: number | null;
  readonly policy_id?: string | null;
  readonly prompt_tokens?: number | null;
  readonly succeeded: boolean;
  readonly total_tokens?: number | null;
  /** The telemetry this cell produced, so the two records agree. */
  readonly usage_event_ids?: string[];
}

/** A whole comparison, as it is read back. */
export interface ComparisonRunRecord {
  readonly candidate_catalog_keys: string[];
  readonly catalog_state?: Record<string, unknown>;
  readonly commit_sha?: string | null;
  readonly completed_at?: string | null;
  readonly dataset_version?: string | null;
  readonly id: string;
  readonly initiated_by: string;
  readonly question?: string | null;
  readonly results?: ComparisonResultRecord[];
  readonly started_at: string;
  readonly status: string;
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

/** One allowance dimension as the caller sees it. */
export interface DimensionView {
  /** What the plan permits. Null means this plan does not limit it. */
  readonly allowance?: number | null;
  /** What has been used in the current window. */
  readonly consumed: number;
  /** The allowance dimension, such as 'requests_per_day'. */
  readonly dimension: string;
  /** What is left. Null where the dimension is unlimited. */
  readonly remaining?: number | null;
  /** When the window turns over. Null for concurrency, which has no boundary — it falls as soon as a run finishes. */
  readonly resets_at?: string | null;
  /** The period it is counted over: 'day', 'month', 'concurrent'. */
  readonly window: string;
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
  /** Every language model call attempt this run made, in order. Empty on a run that needed no inference. */
  readonly inference_attempts?: InferenceAttempt[];
  /** The *configured* model, on the same terms as ``llm_provider``. */
  readonly llm_model?: string | null;
  /** The *configured* provider. Null when no inference was configured at all. This is not evidence that it answered — read ``inference_attempts`` for that. */
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

/** Why a call failed, classified at the coarseness decisions can actually be made at. */
export type FailureClass = "transport" | "timeout" | "gateway_rate_limit" | "auth_config" | "schema_validation" | "unclassified";

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

/** One language model call attempt, and what became of it. */
export interface InferenceAttempt {
  /** 1-based, within the stage. */
  readonly attempt_number?: number;
  /** Filled by the model policy layer. */
  readonly catalog_key?: string | null;
  /** The ``WeathraError`` code, so the existing hierarchy is reused. */
  readonly error_code?: string | null;
  /** Why the run continued as it did, in a reader's words. */
  readonly fallback_reason?: string | null;
  /** Present where the failure carried one; a 404 is not a 500. */
  readonly http_status?: number | null;
  readonly latency_ms?: number | null;
  /** Filled by the model policy layer. */
  readonly plan?: string | null;
  /** Filled by the model policy layer. */
  readonly policy_id?: string | null;
  readonly provider?: string | null;
  readonly resolution_reason?: string | null;
  /** What was asked for, before the gateway had a say. */
  readonly selected_model?: string | null;
  /** As the gateway reported it. Differs from ``selected_model`` when a route substituted one, which is a fact worth seeing rather than smoothing over. */
  readonly served_model?: string | null;
  readonly stage: InferenceStage;
  readonly status: InferenceStatus;
}

/** Which call a language model was asked to make. */
export type InferenceStage = "routing" | "synthesis";

/** How one language model call attempt ended. */
export type InferenceStatus = "served" | "invalid_output" | "rate_limited" | "model_unavailable" | "provider_error" | "timeout" | "not_configured" | "provider_auth_failed";

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

export interface LabRunListResponse {
  readonly count: number;
  readonly runs: ComparisonRunRecord[];
}

/** What to compare, and over what. */
export interface LabRunRequest {
  readonly case_id?: string | null;
  readonly catalog_keys: string[];
  readonly category?: string | null;
  readonly question?: string | null;
}

/** A run and its results, as an administrator reads them. */
export interface LabRunResponse {
  readonly completed_cells?: string[];
  /** Whether a bound stopped the run before every cell completed. The completed cells are the results below; nothing is estimated for the rest. */
  readonly partial?: boolean;
  readonly run: ComparisonRunRecord;
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
export type Measure = "temperature" | "apparent_temperature" | "precipitation" | "precipitation_probability" | "wind_speed" | "wind_gust" | "wind_direction" | "relative_humidity" | "dew_point" | "surface_pressure" | "cloud_cover" | "uv_index" | "weather_code" | "temperature_max" | "temperature_min" | "temperature_mean" | "apparent_temperature_max" | "apparent_temperature_min" | "precipitation_sum" | "precipitation_hours" | "precipitation_probability_max" | "precipitation_probability_mean" | "wind_speed_max" | "wind_gust_max" | "wind_direction_dominant" | "relative_humidity_mean" | "dew_point_mean" | "surface_pressure_mean" | "cloud_cover_mean" | "uv_index_max" | "weather_code_dominant";

/** Who you are, as far as Weathra is concerned. No credential material. */
export interface MeResponse {
  /** Whether you hold Weathra's administrative role, read from backend state keyed by your token subject. Advisory, and only for deciding what to offer you: every administrative endpoint checks the same state itself and refuses regardless of what any client believes. */
  readonly administrative?: boolean;
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

/** One allowance, as a customer reads it rather than as the limiter stores it. */
export interface PlanAllowanceView {
  /** Null is unlimited. A dimension with no row is not capped. */
  readonly allowance?: number | null;
  readonly dimension: string;
  readonly window: string;
}

/** Which tier a person is on. */
export interface PlanAssignmentRequest {
  readonly plan_code: PlanCode;
}

/** The canonical subscription plan codes. */
export type PlanCode = "free" | "pro" | "premium";

export interface PlanListResponse {
  readonly count: number;
  readonly plans: PlanRecord[];
}

/** Which policy a plan resolves to, per call role. */
export interface PlanMappingRequest {
  readonly policy_by_call_role: Record<string, string>;
}

/** A tier, its standing, what it allows, and which class of model answers on it. */
export interface PlanOfferView {
  readonly allowances: PlanAllowanceView[];
  readonly display_name: string;
  /** That model's display name, so a comparison can say what actually differs. */
  readonly model_name?: string | null;
  /** The capability tier of the first model this plan's synthesis policy would resolve — economy, standard or frontier. Null where the plan maps no synthesis policy, or where its policy names no enabled candidate. Read from the catalog, never asserted. */
  readonly model_tier?: string | null;
  readonly plan_code: string;
  /** Ascending entitlement. Free is the lowest. */
  readonly rank: number;
}

/** A product tier, its rank, and the policy it maps each call role to. */
export interface PlanRecord {
  readonly display_name: string;
  /** Unused. Where a billing provider's id would later land. */
  readonly external_subscription_ref?: string | null;
  readonly plan_code: PlanCode;
  readonly policy_by_call_role?: Record<string, string>;
  /** Ascending entitlement. What 'never escalate above' compares. */
  readonly rank: number;
}

/** The tiers Weathra offers, and how somebody moves between them. */
export interface PlansResponse {
  readonly assignment_note: string;
  readonly count: number;
  /** What a new account is on before anybody assigns a tier. */
  readonly default_plan: string;
  readonly plans: PlanOfferView[];
  /** Whether a caller can move themselves between tiers. False: no payment exists. */
  readonly self_service?: boolean;
}

/** One timestamped value in a series-shaped result: a per-day total, a rolling mean. */
export interface PointValue {
  readonly time_local: string;
  readonly time_utc: string;
  /** Null where the window had nothing usable. */
  readonly value: number | null;
}

/** One policy's audit trail, and no other record's. */
export interface PolicyAuditResponse {
  /** Entries returned, newest first. */
  readonly count: number;
  readonly entries: AuditEntry[];
  readonly policy_id: string;
}

/** A re-pointed candidate list — a model promotion, in practice. */
export interface PolicyCandidatesRequest {
  /** Promote a candidate that failed a gating criterion anyway. Recorded as such. */
  readonly acknowledge_criteria_failure?: boolean;
  readonly candidate_catalog_keys: string[];
  readonly cited_comparison_run_ids?: string[];
}

/** A new policy: a name, an ordered candidate list, and who may resolve it. */
export interface PolicyCreateRequest {
  readonly applicable_call_roles: CallRole[];
  readonly candidate_catalog_keys: string[];
  readonly display_name: string;
  readonly eligibility: PolicyEligibility;
  readonly failover_enabled?: boolean;
  readonly fallback_policy_id?: string | null;
  readonly policy_id: string;
}

/** Who may resolve a policy at all — checked before a plan mapping is even consulted. */
export type PolicyEligibility = "public" | "plan" | "administrative" | "internal_evaluation";

/** The declared fallback, or null to clear it. */
export interface PolicyFallbackRequest {
  readonly fallback_policy_id?: string | null;
}

export interface PolicyListResponse {
  readonly count: number;
  readonly policies: PolicyRecord[];
}

/** A named, ordered candidate list, as stored. */
export interface PolicyRecord {
  readonly applicable_call_roles: CallRole[];
  /** Ordered. The first enabled catalog entry wins. */
  readonly candidate_catalog_keys: string[];
  readonly display_name: string;
  readonly eligibility: PolicyEligibility;
  readonly failover_enabled?: boolean;
  readonly fallback_policy_id?: string | null;
  readonly policy_id: string;
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
  readonly latitude?: number | null;
  readonly longitude?: number | null;
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

export interface PrincipalListResponse {
  readonly count: number;
  readonly principals: PrincipalRecord[];
}

/** One principal, as an administrator needs to see them. */
export interface PrincipalRecord {
  /** Whether this principal holds the administrative role. A role, not a tier. */
  readonly administrative?: boolean;
  readonly assigned_at?: string | null;
  readonly assigned_by?: string | null;
  /** Null where nobody has assigned one. */
  readonly plan_code?: string | null;
  readonly plan_name?: string | null;
  readonly subject_id: string;
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

/** An allowance dimension, each enforceable independently (``specs/usage-limits``). */
export type QuotaDimension = "requests_per_day" | "requests_per_month" | "tokens_per_month" | "concurrent_runs" | "estimated_cost_per_month";

/** The period an allowance is counted over. */
export type QuotaWindow = "day" | "month" | "concurrent";

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

/** A bounded look back over the caller's own calls. Counts, never content and never cost. */
export interface RecentUsage {
  /** Language model calls, counting each retry separately. */
  readonly calls: number;
  /** How far back this summary looks. */
  readonly days: number;
  /** How many of them failed. */
  readonly failures: number;
  /** The same window, one point per day, oldest first and dense — a day with no calls is a zero rather than a missing point, because this table records every call. This is what a usage chart is drawn from; the totals above are its sum. */
  readonly series?: UsageDay[];
  /** Tokens across those calls, or null where the gateway reported none. Null is not zero: zero would claim the calls used nothing. */
  readonly total_tokens?: number | null;
}

/** What the run decided the question was actually about. */
export interface ResolvedContext {
  readonly criterion?: string | null;
  readonly location_source?: "request" | "focus" | "thread" | "preferences" | "none";
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

/** One role grant, as an administrator sees it. No contact detail, because none is stored. */
export interface RoleGrantResponse {
  readonly granted_at: string;
  /** Null for the bootstrap grant, which has no granter to name. */
  readonly granted_by?: string | null;
  readonly role: string;
  readonly subject_id: string;
}

export interface RoleListResponse {
  readonly count: number;
  readonly grants: RoleGrantResponse[];
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

/** What a person supposed. Every field optional; an omitted one changes nothing. */
export interface ScenarioAssumptions {
  /** Scales every reported precipitation figure. -100 removes it entirely. */
  readonly precipitation_percent?: number | null;
  /** Added to every reported humidity, in points. */
  readonly relative_humidity_delta?: number | null;
  /** Added to every reported temperature. */
  readonly temperature_delta?: number | null;
  /** Added to every reported wind speed. */
  readonly wind_speed_delta?: number | null;
}

/** One measure, before and after, with the arithmetic that produced the after. */
export interface ScenarioMeasure {
  readonly assumption: number;
  /** Mean of the reported values. Null where none were reported. */
  readonly baseline_mean?: number | null;
  /** Hours where the assumption would have crossed a physical bound and was applied up to it instead. Counted rather than absorbed. */
  readonly clipped?: number;
  /** Scenario mean less baseline mean, where both exist. */
  readonly difference?: number | null;
  readonly measure: Measure;
  readonly method: string;
  /** Hours the provider reported nothing for this measure. */
  readonly points_excluded?: number;
  readonly points_used?: number;
  readonly scenario_mean?: number | null;
  readonly unit?: string | null;
}

/** A place, a horizon, and what to suppose about it. */
export interface ScenarioRequest {
  /** Every field optional. An omitted assumption changes nothing, and a request with none returns the forecast unchanged — which is a legitimate baseline to draw. */
  readonly assumptions?: ScenarioAssumptions;
  readonly days?: number | null;
  readonly latitude?: number | null;
  readonly location?: string | null;
  readonly longitude?: number | null;
  readonly provider?: string | null;
  readonly units?: UnitSystem | null;
}

/** A stated assumption applied to a real forecast, and the arithmetic that did it. */
export interface ScenarioResponse {
  readonly assumptions: ScenarioAssumptions;
  readonly attribution: WeatherAttribution;
  /** Exactly what the provider returned. Unmodified. */
  readonly baseline: Series;
  /** What the result is and is not, in one sentence, for any surface that shows it. */
  readonly disclaimer: string;
  readonly horizon_days: number;
  /** Per adjusted measure: the arithmetic used, the means either side, and the hours excluded or clipped. */
  readonly measures: ScenarioMeasure[];
  readonly period: Period;
  /** The same instants and units, with the assumptions applied. */
  readonly scenario: Series;
  /** Always true. This is a hypothetical, not a forecast and not an observation. */
  readonly simulated?: true;
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
export type Statistic = "minimum" | "maximum" | "mean" | "range" | "total" | "daily_totals" | "wet_entry_count" | "probability_maximum" | "probability_mean" | "probability_exceedance" | "mean_speed" | "maximum_sustained_speed" | "maximum_gust" | "prevailing_direction" | "rolling_mean" | "percentile" | "percentile_rank" | "delta" | "z_score" | "correlation" | "data_density" | "standard_deviation" | "anomalies" | "trend" | "baseline";

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

/** One group's measures. */
export interface UsageAggregate {
  readonly calls: number;
  readonly completion_tokens?: number | null;
  readonly estimated_cost_total?: string | null;
  readonly failures: number;
  /** The grouping value. Null where the column was null. */
  readonly group: string | null;
  /** Internal usage is reported separately and never counted against a plan. */
  readonly is_internal: boolean;
  readonly latency_p50_ms?: number | null;
  readonly latency_p95_ms?: number | null;
  readonly prompt_tokens?: number | null;
  readonly total_tokens?: number | null;
}

/** One point on a usage trend. The same measures as `UsageAggregate`, cut by time instead. */
export interface UsageBucket {
  readonly calls: number;
  readonly estimated_cost_total?: string | null;
  readonly failures: number;
  /** Internal usage stays separate here too, so a trend cannot blend the two. */
  readonly is_internal: boolean;
  readonly latency_p50_ms?: number | null;
  /** The bucket's inclusive start, truncated to its width. */
  readonly start: string;
  readonly total_tokens?: number | null;
}

/** One day of the caller's own usage. The shape a trend is drawn from. */
export interface UsageDay {
  readonly calls: number;
  /** The day this point covers, as an ISO date in UTC. */
  readonly date: string;
  readonly failures: number;
  /** Tokens that day, or null where no gateway reported any. */
  readonly total_tokens?: number | null;
}

/** The caller's plan, their standing in every dimension, and a bounded recent summary. */
export interface UsageResponse {
  /** Every dimension, unlimited ones too. */
  readonly dimensions: DimensionView[];
  /** Whether this caller's traffic is accounted against the internal allowance rather than a product plan, which is the case for an administrative principal. */
  readonly internal?: boolean;
  /** The plan in effect, from backend state. */
  readonly plan_code: string;
  /** Its display name. */
  readonly plan_name: string;
  readonly recent: RecentUsage;
  /** The token subject. Never a value the request supplied. */
  readonly user_id: string;
}

/** The same measures as `/admin/usage`, cut by time rather than by dimension. */
export interface UsageSeriesResponse {
  /** The width of one point: 'hour' or 'day'. */
  readonly bucket: string;
  /** One entry per (bucket, internal) pair, dense across the window. A bucket with no calls is a zero rather than a gap: this table records every call, so an empty hour is an idle hour rather than an unobserved one. */
  readonly points: UsageBucket[];
  readonly window: UsageWindow;
}

/** Aggregate usage over one period, grouped one way, split internal from product. */
export interface UsageSummaryResponse {
  /** The dimension the measures are grouped by. */
  readonly grouped_by: string;
  /** One entry per (group, internal) pair. Never a row, and never a subject. */
  readonly groups: UsageAggregate[];
  readonly window: UsageWindow;
}

/** The period an aggregate covers. Both bounds explicit, because "recent" is not a period. */
export interface UsageWindow {
  readonly end: string;
  readonly start: string;
}

export interface ValidationError {
  readonly ctx?: Record<string, unknown>;
  readonly input?: unknown;
  readonly loc: (string | number)[];
  readonly msg: string;
  readonly type: string;
}

/** What may be changed about a watch. The place and the measure are its identity. */
export interface WatchEdit {
  readonly comparison?: string | null;
  readonly enabled?: boolean | null;
  readonly label?: string | null;
  readonly threshold?: number | null;
}

/** Your watches, and how they came to be evaluated. */
export interface WatchesResponse {
  readonly count: number;
  readonly disclaimer?: string;
  readonly evaluation_note?: string;
  /** The measures a watch may name — the ones the provider actually reports. */
  readonly watchable: string[];
  readonly watches: WatchRecord[];
}

/** One watch, as it is read back. */
export interface WatchRecord {
  readonly comparison: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly label?: string | null;
  readonly last_evaluated_at?: string | null;
  readonly last_met?: boolean | null;
  readonly last_value?: number | null;
  readonly location: Location;
  readonly measure: Measure;
  readonly threshold: number;
  readonly updated_at: string;
}

/** A place, a measure, a direction and a number. */
export interface WatchRequest {
  /** 'above' or 'below'. */
  readonly comparison: string;
  readonly label?: string | null;
  readonly latitude?: number | null;
  readonly location?: string | null;
  readonly longitude?: number | null;
  readonly measure: Measure;
  readonly threshold: number;
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

/** One reference year's mean for the baseline's calendar window. */
export interface YearlyMean {
  /** Days from that year that carried the measure. */
  readonly points_used: number;
  readonly value: number;
  readonly year: number;
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
  /** Whether the operation additionally requires the backend-held administrative role. */
  readonly administrative: boolean;
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
    operationId: "list_allowances_api_v1_admin_allowances_get",
    method: "GET",
    path: "/api/v1/admin/allowances",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "AllowanceListResponse",
    parameters: [
      { name: "plan_code", in: "query", required: false },
      { name: "internal", in: "query", required: false },
    ],
  },
  {
    operationId: "set_internal_allowance_api_v1_admin_allowances_internal_put",
    method: "PUT",
    path: "/api/v1/admin/allowances/internal",
    requiresToken: true,
    administrative: true,
    request: "AllowanceRequest",
    successStatus: 200,
    response: "AllowanceRecord",
    parameters: [],
  },
  {
    operationId: "list_comparisons_api_v1_admin_lab_comparisons_get",
    method: "GET",
    path: "/api/v1/admin/lab/comparisons",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "LabRunListResponse",
    parameters: [
      { name: "limit", in: "query", required: false },
    ],
  },
  {
    operationId: "start_comparison_api_v1_admin_lab_comparisons_post",
    method: "POST",
    path: "/api/v1/admin/lab/comparisons",
    requiresToken: true,
    administrative: true,
    request: "LabRunRequest",
    successStatus: 201,
    response: "LabRunResponse",
    parameters: [],
  },
  {
    operationId: "read_comparison_api_v1_admin_lab_comparisons__run_id__get",
    method: "GET",
    path: "/api/v1/admin/lab/comparisons/{run_id}",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "LabRunResponse",
    parameters: [
      { name: "run_id", in: "path", required: true },
    ],
  },
  {
    operationId: "list_catalog_api_v1_admin_models_get",
    method: "GET",
    path: "/api/v1/admin/models",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "CatalogListResponse",
    parameters: [
      { name: "status", in: "query", required: false },
      { name: "capability_role", in: "query", required: false },
    ],
  },
  {
    operationId: "create_catalog_entry_api_v1_admin_models_post",
    method: "POST",
    path: "/api/v1/admin/models",
    requiresToken: true,
    administrative: true,
    request: "CatalogCreateRequest",
    successStatus: 201,
    response: "CatalogEntry",
    parameters: [],
  },
  {
    operationId: "edit_catalog_entry_api_v1_admin_models__catalog_key__patch",
    method: "PATCH",
    path: "/api/v1/admin/models/{catalog_key}",
    requiresToken: true,
    administrative: true,
    request: "CatalogEditRequest",
    successStatus: 200,
    response: "CatalogEntry",
    parameters: [
      { name: "catalog_key", in: "path", required: true },
    ],
  },
  {
    operationId: "disable_catalog_entry_api_v1_admin_models__catalog_key__disable_post",
    method: "POST",
    path: "/api/v1/admin/models/{catalog_key}/disable",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "CatalogEntry",
    parameters: [
      { name: "catalog_key", in: "path", required: true },
    ],
  },
  {
    operationId: "enable_catalog_entry_api_v1_admin_models__catalog_key__enable_post",
    method: "POST",
    path: "/api/v1/admin/models/{catalog_key}/enable",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "CatalogEntry",
    parameters: [
      { name: "catalog_key", in: "path", required: true },
    ],
  },
  {
    operationId: "list_plans_api_v1_admin_plans_get",
    method: "GET",
    path: "/api/v1/admin/plans",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "PlanListResponse",
    parameters: [],
  },
  {
    operationId: "set_plan_allowance_api_v1_admin_plans__plan_code__allowances_put",
    method: "PUT",
    path: "/api/v1/admin/plans/{plan_code}/allowances",
    requiresToken: true,
    administrative: true,
    request: "AllowanceRequest",
    successStatus: 200,
    response: "AllowanceRecord",
    parameters: [
      { name: "plan_code", in: "path", required: true },
    ],
  },
  {
    operationId: "set_plan_policy_mapping_api_v1_admin_plans__plan_code__policies_put",
    method: "PUT",
    path: "/api/v1/admin/plans/{plan_code}/policies",
    requiresToken: true,
    administrative: true,
    request: "PlanMappingRequest",
    successStatus: 200,
    response: null,
    parameters: [
      { name: "plan_code", in: "path", required: true },
    ],
  },
  {
    operationId: "list_policies_api_v1_admin_policies_get",
    method: "GET",
    path: "/api/v1/admin/policies",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "PolicyListResponse",
    parameters: [],
  },
  {
    operationId: "create_policy_api_v1_admin_policies_post",
    method: "POST",
    path: "/api/v1/admin/policies",
    requiresToken: true,
    administrative: true,
    request: "PolicyCreateRequest",
    successStatus: 201,
    response: "PolicyRecord",
    parameters: [],
  },
  {
    operationId: "read_policy_audit_api_v1_admin_policies__policy_id__audit_get",
    method: "GET",
    path: "/api/v1/admin/policies/{policy_id}/audit",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "PolicyAuditResponse",
    parameters: [
      { name: "policy_id", in: "path", required: true },
      { name: "limit", in: "query", required: false },
    ],
  },
  {
    operationId: "set_policy_candidates_api_v1_admin_policies__policy_id__candidates_put",
    method: "PUT",
    path: "/api/v1/admin/policies/{policy_id}/candidates",
    requiresToken: true,
    administrative: true,
    request: "PolicyCandidatesRequest",
    successStatus: 200,
    response: "PolicyRecord",
    parameters: [
      { name: "policy_id", in: "path", required: true },
    ],
  },
  {
    operationId: "set_policy_fallback_api_v1_admin_policies__policy_id__fallback_put",
    method: "PUT",
    path: "/api/v1/admin/policies/{policy_id}/fallback",
    requiresToken: true,
    administrative: true,
    request: "PolicyFallbackRequest",
    successStatus: 200,
    response: "PolicyRecord",
    parameters: [
      { name: "policy_id", in: "path", required: true },
    ],
  },
  {
    operationId: "list_principals_api_v1_admin_principals_get",
    method: "GET",
    path: "/api/v1/admin/principals",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "PrincipalListResponse",
    parameters: [
      { name: "limit", in: "query", required: false },
    ],
  },
  {
    operationId: "list_administrators_api_v1_admin_principals_administrators_get",
    method: "GET",
    path: "/api/v1/admin/principals/administrators",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "RoleListResponse",
    parameters: [],
  },
  {
    operationId: "assign_plan_api_v1_admin_principals__subject_id__plan_put",
    method: "PUT",
    path: "/api/v1/admin/principals/{subject_id}/plan",
    requiresToken: true,
    administrative: true,
    request: "PlanAssignmentRequest",
    successStatus: 200,
    response: "PlanRecord",
    parameters: [
      { name: "subject_id", in: "path", required: true },
    ],
  },
  {
    operationId: "grant_role_api_v1_admin_principals__subject_id__role_put",
    method: "PUT",
    path: "/api/v1/admin/principals/{subject_id}/role",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "RoleGrantResponse",
    parameters: [
      { name: "subject_id", in: "path", required: true },
    ],
  },
  {
    operationId: "revoke_role_api_v1_admin_principals__subject_id__role_delete",
    method: "DELETE",
    path: "/api/v1/admin/principals/{subject_id}/role",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 204,
    response: null,
    parameters: [
      { name: "subject_id", in: "path", required: true },
    ],
  },
  {
    operationId: "read_usage_api_v1_admin_usage_get",
    method: "GET",
    path: "/api/v1/admin/usage",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "UsageSummaryResponse",
    parameters: [
      { name: "by", in: "query", required: false },
      { name: "days", in: "query", required: false },
    ],
  },
  {
    operationId: "read_usage_series_api_v1_admin_usage_series_get",
    method: "GET",
    path: "/api/v1/admin/usage/series",
    requiresToken: true,
    administrative: true,
    request: null,
    successStatus: 200,
    response: "UsageSeriesResponse",
    parameters: [
      { name: "days", in: "query", required: false },
      { name: "bucket", in: "query", required: false },
    ],
  },
  {
    operationId: "ask_api_v1_agent_ask_post",
    method: "POST",
    path: "/api/v1/agent/ask",
    requiresToken: true,
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
    request: null,
    successStatus: 200,
    response: "PreferenceView",
    parameters: [],
  },
  {
    operationId: "read_usage_api_v1_me_usage_get",
    method: "GET",
    path: "/api/v1/me/usage",
    requiresToken: true,
    administrative: false,
    request: null,
    successStatus: 200,
    response: "UsageResponse",
    parameters: [],
  },
  {
    operationId: "list_watches_api_v1_me_watches_get",
    method: "GET",
    path: "/api/v1/me/watches",
    requiresToken: true,
    administrative: false,
    request: null,
    successStatus: 200,
    response: "WatchesResponse",
    parameters: [
      { name: "evaluate", in: "query", required: false },
    ],
  },
  {
    operationId: "create_watch_api_v1_me_watches_post",
    method: "POST",
    path: "/api/v1/me/watches",
    requiresToken: true,
    administrative: false,
    request: "WatchRequest",
    successStatus: 201,
    response: "WatchRecord",
    parameters: [],
  },
  {
    operationId: "update_watch_api_v1_me_watches__watch_id__patch",
    method: "PATCH",
    path: "/api/v1/me/watches/{watch_id}",
    requiresToken: true,
    administrative: false,
    request: "WatchEdit",
    successStatus: 200,
    response: "WatchRecord",
    parameters: [
      { name: "watch_id", in: "path", required: true },
    ],
  },
  {
    operationId: "remove_watch_api_v1_me_watches__watch_id__delete",
    method: "DELETE",
    path: "/api/v1/me/watches/{watch_id}",
    requiresToken: true,
    administrative: false,
    request: null,
    successStatus: 204,
    response: null,
    parameters: [
      { name: "watch_id", in: "path", required: true },
    ],
  },
  {
    operationId: "evaluate_one_api_v1_me_watches__watch_id__evaluate_post",
    method: "POST",
    path: "/api/v1/me/watches/{watch_id}/evaluate",
    requiresToken: true,
    administrative: false,
    request: null,
    successStatus: 200,
    response: "WatchRecord",
    parameters: [
      { name: "watch_id", in: "path", required: true },
    ],
  },
  {
    operationId: "list_offered_plans_api_v1_plans_get",
    method: "GET",
    path: "/api/v1/plans",
    requiresToken: false,
    administrative: false,
    request: null,
    successStatus: 200,
    response: "PlansResponse",
    parameters: [],
  },
  {
    operationId: "ready_api_v1_ready_get",
    method: "GET",
    path: "/api/v1/ready",
    requiresToken: false,
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
    administrative: false,
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
  {
    operationId: "scenario_api_v1_weather_scenario_post",
    method: "POST",
    path: "/api/v1/weather/scenario",
    requiresToken: false,
    administrative: false,
    request: "ScenarioRequest",
    successStatus: 200,
    response: "ScenarioResponse",
    parameters: [],
  },
];
