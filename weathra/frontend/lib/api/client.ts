/**
 * The typed client for Weathra's backend.
 *
 * Every response type here comes from `./schema`, generated from the backend's OpenAPI document,
 * so the client cannot describe a payload the API does not send (task 20.11). What this module adds
 * on top is the three things a screen should never have to think about:
 *
 * **The token, fetched per call.** `accessToken()` is asked on every request rather than captured
 * once. A token lives for minutes and Supabase refreshes it underneath; a client that closed over
 * the first one would start failing partway through a session, and the failure would look like the
 * backend rejecting a valid user.
 *
 * **A 401 is an authentication event, never a data error.** `specs/web-ui` is explicit: an expired
 * session shows an expired-session state and returns the person to sign-in, and is not presented as
 * a data or server failure. So a 401 becomes `SessionExpired` — a distinct type a view can branch
 * on without inspecting status codes — and `onSessionExpired` fires once for the session layer to
 * act on.
 *
 * **The error envelope, unwrapped.** The backend answers every failure with
 * `{"error": {code, message, details, request_id}}` (design.md decision 16). The `code` is the
 * stable part and the `message` is the part a person reads; both reach the view, along with the
 * request id, which is what makes a report about one failure findable in the logs.
 */

import { publicEnv } from "@/lib/env";

import type {
  AmbiguousResponse,
  AnalysisResponse,
  AskRequest,
  AskResponse,
  Baseline,
  BaselineComparison,
  CatalogListResponse,
  ComparisonRequest,
  ComparisonResult,
  CurrentResponse,
  DeletionResponse,
  EvidenceResponse,
  ForecastResponse,
  HealthResponse,
  HistoryResponse,
  LabRunListResponse,
  LabRunResponse,
  MeResponse,
  Measure,
  PeriodComparison,
  PolicyAuditResponse,
  PolicyCandidatesRequest,
  PolicyListResponse,
  PolicyRecord,
  PreferenceUpdate,
  PreferenceView,
  ReadinessResponse,
  ResolvedResponse,
  ScenarioRequest,
  ScenarioResponse,
  SavedLocationRecord,
  SavedLocationRequest,
  SavedLocationsResponse,
  SearchResponse,
  ThreadSummary,
  ThreadsResponse,
  UnitSystem,
  UsageResponse,
  UsageSummaryResponse,
  WatchEdit,
  WatchRecord,
  WatchRequest,
  WatchesResponse,
  WhatChanged,
} from "./schema";

/** The error body every failure carries. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | null;
  readonly request_id?: string | null;
}

/** A failure the backend described. */
export class ApiError extends Error {
  readonly status: number;
  /** The backend's stable error code, e.g. `location_not_found`. */
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  /** The request id, which ties this failure to the backend's logs. */
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? null;
    this.requestId = body.request_id ?? null;
  }
}

/**
 * The session is gone or was never valid.
 *
 * A separate type rather than a status check, so a view branches on meaning: this is the one
 * failure that is never about the data the person asked for.
 */
export class SessionExpired extends ApiError {
  constructor(body: ApiErrorBody) {
    super(401, body);
    this.name = "SessionExpired";
  }
}

/**
 * The request never reached the backend.
 *
 * `fetch` rejects for a dropped connection, DNS failure, or CORS refusal, and none of those have a
 * status or an error envelope. Distinguishing them matters: "Weathra could not be reached" is a
 * different sentence from anything the backend would have said, and offering a retry is right for
 * this one where it is often wrong for a 4xx.
 */
export class BackendUnreachable extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Weathra's backend could not be reached.");
    this.name = "BackendUnreachable";
    this.cause = cause;
  }
}

/** Asked before every request, so a refreshed token is the one that gets used. */
export type AccessTokenSource = () => Promise<string | null> | string | null;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to `NEXT_PUBLIC_API_BASE_URL`. */
  readonly baseUrl?: string;
  /** The access token for protected calls. Return null when there is no session. */
  readonly accessToken?: AccessTokenSource;
  /** Injected in tests; the global `fetch` otherwise. */
  readonly fetch?: FetchLike;
  /** Called when a call fails with 401, for the session layer to clear state and route to sign-in. */
  readonly onSessionExpired?: (error: SessionExpired) => void;
  /** Forwarded to `fetch`, so a view can cancel a request it no longer needs. */
  readonly signal?: AbortSignal;
}

/** A place, named or given as coordinates, plus how to render it. */
export interface PlaceQuery {
  readonly location?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly units?: UnitSystem;
  readonly provider?: string;
}

export interface ForecastQuery extends PlaceQuery {
  readonly days?: number;
}

export interface AnalysisQuery extends ForecastQuery {
  readonly above?: number;
  readonly below?: number;
}

export interface HistoryQuery extends PlaceQuery {
  readonly start: string;
  readonly end: string;
}

export interface BaselineQuery extends HistoryQuery {
  readonly years?: number;
  readonly measure?: Measure;
}

/** A past period, and how many years before it to build the baseline from. */
export type BaselineComparisonQuery = BaselineQuery;

export interface PeriodComparisonQuery extends PlaceQuery {
  readonly earlier_start: string;
  readonly earlier_end: string;
  readonly later_start: string;
  readonly later_end: string;
}

/** Values a query string can carry. `undefined` is omitted rather than sent as "undefined". */
type QueryValues = Record<string, string | number | boolean | undefined>;

const NO_BODY = Symbol("no body");

/** The SSE endpoint. Exported so the stream hook and the client cannot disagree about it. */
export const AGENT_STREAM_PATH = "/api/v1/agent/stream";

export interface ApiClient {
  health(): Promise<HealthResponse>;
  readiness(): Promise<ReadinessResponse>;

  searchLocations(query: string, limit?: number): Promise<SearchResponse>;
  resolveLocation(query: PlaceQuery & { query?: string }): Promise<
    ResolvedResponse | AmbiguousResponse
  >;

  current(query: PlaceQuery): Promise<CurrentResponse>;
  forecast(query: ForecastQuery): Promise<ForecastResponse>;
  /**
   * *What Changed?* — how the forecast for this window has moved since the last snapshot of it.
   *
   * Protected, unlike the other weather calls: the comparison reads and appends to the shared
   * snapshot history, and `specs/http-api` does not admit it to the public surface. So a 401 here
   * is an expired session and reaches the session layer as one, not a weather failure.
   */
  changes(query: ForecastQuery): Promise<WhatChanged>;
  analysis(query: AnalysisQuery): Promise<AnalysisResponse>;
  history(query: HistoryQuery): Promise<HistoryResponse>;
  baseline(query: BaselineQuery): Promise<Baseline>;
  /**
   * A past period placed against the baseline of the years before it.
   *
   * The signed difference and the z-score come back computed: `specs/deterministic-analytics`
   * puts that arithmetic in the analytics layer, so a screen renders the result rather than
   * subtracting a baseline from a period itself.
   */
  baselineComparison(query: BaselineComparisonQuery): Promise<BaselineComparison>;
  periodComparison(query: PeriodComparisonQuery): Promise<PeriodComparison>;
  compareLocations(request: ComparisonRequest): Promise<ComparisonResult>;
  /**
   * A stated assumption applied to a real forecast.
   *
   * Hypothetical by construction and labelled so by the backend: the response carries `simulated`
   * and a disclaimer before it carries a number. No model is called to produce it.
   */
  scenario(request: ScenarioRequest): Promise<ScenarioResponse>;

  ask(request: AskRequest): Promise<AskResponse>;
  /**
   * Open the SSE stream for a question.
   *
   * Returns the raw `Response` for the caller to read, because the body is an event stream rather
   * than a payload — `useAgentStream` (task 20.14) reads it with a body reader. The failures are
   * mapped here all the same, so a 401 on the stream is the same `SessionExpired` a REST call
   * produces rather than a stall the hook would have to interpret.
   */
  openAgentStream(request: AskRequest, signal?: AbortSignal): Promise<Response>;
  evidence(evidenceId: string): Promise<EvidenceResponse>;

  me(): Promise<MeResponse>;

  /**
   * The signed-in person's plan, what they have used, and when each window resets.
   *
   * Takes no identifier: the backend answers for the token subject and ignores anything a caller
   * supplies, so there is no argument here that could ask about somebody else.
   */
  usage(): Promise<UsageResponse>;
  preferences(): Promise<PreferenceView>;
  updatePreferences(update: PreferenceUpdate): Promise<PreferenceView>;
  resetPreferences(): Promise<PreferenceView>;

  savedLocations(): Promise<SavedLocationsResponse>;
  saveLocation(request: SavedLocationRequest): Promise<SavedLocationRecord>;
  removeSavedLocation(savedId: string): Promise<void>;

  threads(): Promise<ThreadsResponse>;
  thread(threadId: string): Promise<ThreadSummary>;
  deleteThread(threadId: string): Promise<void>;

  /**
   * Your weather watches.
   *
   * `evaluate` checks each enabled watch against the current forecast before returning, which costs
   * a provider call per watched place — so it is opt-in rather than what a listing does by default.
   */
  watches(evaluate?: boolean): Promise<WatchesResponse>;
  createWatch(request: WatchRequest): Promise<WatchRecord>;
  updateWatch(watchId: string, edit: WatchEdit): Promise<WatchRecord>;
  removeWatch(watchId: string): Promise<void>;
  evaluateWatch(watchId: string): Promise<WatchRecord>;

  deleteMyData(): Promise<DeletionResponse>;

  /* --------------------------------------------------------- administrative
   *
   * Every one of these is refused by the backend for a principal without the administrative role,
   * and none of them is reachable by a client-asserted anything: the role is a row in
   * `admin_roles` keyed by the validated token subject (`docs/authentication.md`). So a screen
   * calling them is not deciding it may — it is asking, and being answered 403 when it may not.
   */

  /**
   * Aggregate language model usage, grouped and split between product and internal traffic.
   *
   * Never a row and never a subject — the endpoint aggregates, so there is nothing here that could
   * name whose call a figure came from.
   */
  adminUsage(by?: string, days?: number): Promise<UsageSummaryResponse>;
  /** The model policies, each with its ordered candidate list. */
  adminPolicies(): Promise<PolicyListResponse>;
  /** The catalog, with the most recent evaluation recorded per entry where there is one. */
  adminCatalog(): Promise<CatalogListResponse>;
  /** Recent comparison runs, newest first. */
  adminComparisons(limit?: number): Promise<LabRunListResponse>;
  /** One comparison run and its per-model, per-case cells. */
  adminComparison(runId: string): Promise<LabRunResponse>;
  /**
   * Re-point — or confirm in place — a policy's ordered candidate list.
   *
   * `cited_comparison_run_ids` is the evidence the change rests on, and the backend writes it into
   * the audit row. Nothing here decides whether the candidates are permitted: the promotion gate
   * is the backend's, and its refusal arrives as an `ApiError` with the failed criteria in
   * `details`.
   */
  confirmPolicyCandidates(
    policyId: string,
    request: PolicyCandidatesRequest,
  ): Promise<PolicyRecord>;
  /** One policy's audit trail, newest first, with the comparison runs each change cited. */
  adminPolicyAudit(policyId: string, limit?: number): Promise<PolicyAuditResponse>;
}

/** The base URL with any trailing slash removed, so path joining is unambiguous. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The absolute URL for an API path, with its query string. */
export function apiUrl(baseUrl: string, path: string, query: QueryValues = {}): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  const search = parameters.toString();
  return `${normalizeBaseUrl(baseUrl)}${path}${search === "" ? "" : `?${search}`}`;
}

/**
 * The headers a protected call carries.
 *
 * Exported because the SSE hook (task 20.14) authenticates the same way and must not grow its own
 * idea of how: `EventSource` cannot set a header, so the stream is a `fetch` with these headers and
 * a streamed body reader (design.md decision 18).
 */
export function bearerHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * What a person is told when a failure did not come from Weathra's own handlers.
 *
 * Weathra's sentence rather than the gateway's. The status number is kept because it is the one
 * part of an unrecognised failure worth repeating — it is what a person can quote when asking.
 */
export const UNEXPECTED_RESPONSE_MESSAGE = (status: number): string =>
  `Weathra could not complete that request. The service answered ${status}.`;

function errorBodyFrom(status: number, payload: unknown, statusText: string): ApiErrorBody {
  const envelope = payload as { error?: Partial<ApiErrorBody> } | null;
  const error = envelope?.error;

  if (error?.code !== undefined && error.message !== undefined) {
    return {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
      request_id: error.request_id ?? null,
    };
  }

  // A failure with no envelope did not come from Weathra's handlers — a proxy, a gateway, or a
  // crash before the middleware. Say so plainly rather than inventing a code that looks stable.
  //
  // The message is Weathra's own, not the upstream's. `statusText` is written for whoever operates
  // the proxy: the runtime audit of 2026-09-08 photographed a signed-in visitor being told "Internal
  // Server Error" under Weathra's own heading, which is an implementation detail wearing the
  // product's voice. The status still reaches the reader, as a number they can quote.
  return {
    code: "unexpected_response",
    message: UNEXPECTED_RESPONSE_MESSAGE(status),
    details: statusText === "" ? null : { status_text: statusText },
    request_id: null,
  };
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? publicEnv.apiBaseUrl);
  const performFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function token(): Promise<string | null> {
    if (options.accessToken === undefined) return null;
    return (await options.accessToken()) ?? null;
  }

  async function call<Result>(
    method: string,
    path: string,
    query: QueryValues,
    body: unknown | typeof NO_BODY,
    expectsBody: boolean,
  ): Promise<Result> {
    const bearer = await token();

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...bearerHeaders(bearer),
    };
    if (body !== NO_BODY) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await performFetch(apiUrl(baseUrl, path, query), {
        method,
        headers,
        body: body === NO_BODY ? undefined : JSON.stringify(body),
        signal: options.signal,
        // The session lives in cookies for Supabase's benefit, but Weathra's own API is
        // authenticated by the bearer header alone. Sending no credentials keeps it that way and
        // keeps the backend free of cookie-based CSRF exposure.
        credentials: "omit",
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new BackendUnreachable(cause);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const errorBody = errorBodyFrom(response.status, payload, response.statusText);

      if (response.status === 401) {
        const expired = new SessionExpired(errorBody);
        options.onSessionExpired?.(expired);
        throw expired;
      }
      throw new ApiError(response.status, errorBody);
    }

    // 204 carries no body at all; parsing one as JSON throws on an empty string and would surface
    // a successful deletion as a server fault.
    if (!expectsBody || response.status === 204) return undefined as Result;
    return (await response.json()) as Result;
  }

  const get = <Result>(path: string, query: QueryValues = {}) =>
    call<Result>("GET", path, query, NO_BODY, true);

  async function openStream(request: AskRequest, signal?: AbortSignal): Promise<Response> {
    const bearer = await token();

    let response: Response;
    try {
      response = await performFetch(apiUrl(baseUrl, AGENT_STREAM_PATH), {
        method: "POST",
        headers: {
          // `EventSource` cannot set a header, so the stream is a POST read with a body reader
          // (design.md decision 18). The Accept header is what asks for the event stream.
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...bearerHeaders(bearer),
        },
        body: JSON.stringify(request),
        signal: signal ?? options.signal,
        credentials: "omit",
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new BackendUnreachable(cause);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const errorBody = errorBodyFrom(response.status, payload, response.statusText);
      if (response.status === 401) {
        const expired = new SessionExpired(errorBody);
        options.onSessionExpired?.(expired);
        throw expired;
      }
      throw new ApiError(response.status, errorBody);
    }

    return response;
  }

  return {
    health: () => get<HealthResponse>("/api/v1/health"),
    readiness: () => get<ReadinessResponse>("/api/v1/ready"),

    searchLocations: (query, limit) =>
      get<SearchResponse>("/api/v1/locations/search", { query, limit }),
    resolveLocation: ({ query, location, latitude, longitude }) =>
      get<ResolvedResponse | AmbiguousResponse>("/api/v1/locations/resolve", {
        query: query ?? location,
        latitude,
        longitude,
      }),

    current: (query) => get<CurrentResponse>("/api/v1/weather/current", { ...query }),
    forecast: (query) => get<ForecastResponse>("/api/v1/weather/forecast", { ...query }),
    changes: (query) => get<WhatChanged>("/api/v1/weather/changes", { ...query }),
    analysis: (query) => get<AnalysisResponse>("/api/v1/weather/analysis", { ...query }),
    history: (query) => get<HistoryResponse>("/api/v1/weather/history", { ...query }),
    baseline: (query) => get<Baseline>("/api/v1/weather/history/baseline", { ...query }),
    baselineComparison: (query) =>
      get<BaselineComparison>("/api/v1/weather/history/baseline/comparison", { ...query }),
    periodComparison: (query) =>
      get<PeriodComparison>("/api/v1/weather/history/comparison", { ...query }),
    compareLocations: (request) =>
      call<ComparisonResult>("POST", "/api/v1/weather/comparison", {}, request, true),
    scenario: (request) =>
      call<ScenarioResponse>("POST", "/api/v1/weather/scenario", {}, request, true),

    ask: (request) => call<AskResponse>("POST", "/api/v1/agent/ask", {}, request, true),
    openAgentStream: (request, signal) => openStream(request, signal),
    evidence: (evidenceId) =>
      get<EvidenceResponse>(`/api/v1/evidence/${encodeURIComponent(evidenceId)}`),

    me: () => get<MeResponse>("/api/v1/me"),
    usage: () => get<UsageResponse>("/api/v1/me/usage"),
    preferences: () => get<PreferenceView>("/api/v1/me/preferences"),
    updatePreferences: (update) =>
      call<PreferenceView>("PUT", "/api/v1/me/preferences", {}, update, true),
    resetPreferences: () =>
      call<PreferenceView>("DELETE", "/api/v1/me/preferences", {}, NO_BODY, true),

    savedLocations: () => get<SavedLocationsResponse>("/api/v1/me/locations"),
    saveLocation: (request) =>
      call<SavedLocationRecord>("POST", "/api/v1/me/locations", {}, request, true),
    removeSavedLocation: (savedId) =>
      call<void>(
        "DELETE",
        `/api/v1/me/locations/${encodeURIComponent(savedId)}`,
        {},
        NO_BODY,
        false,
      ),

    threads: () => get<ThreadsResponse>("/api/v1/threads"),
    thread: (threadId) => get<ThreadSummary>(`/api/v1/threads/${encodeURIComponent(threadId)}`),
    deleteThread: (threadId) =>
      call<void>(
        "DELETE",
        `/api/v1/threads/${encodeURIComponent(threadId)}`,
        {},
        NO_BODY,
        false,
      ),

    watches: (evaluate) => get<WatchesResponse>("/api/v1/me/watches", { evaluate }),
    createWatch: (request) =>
      call<WatchRecord>("POST", "/api/v1/me/watches", {}, request, true),
    updateWatch: (watchId, edit) =>
      call<WatchRecord>(
        "PATCH",
        `/api/v1/me/watches/${encodeURIComponent(watchId)}`,
        {},
        edit,
        true,
      ),
    removeWatch: (watchId) =>
      call<void>(
        "DELETE",
        `/api/v1/me/watches/${encodeURIComponent(watchId)}`,
        {},
        NO_BODY,
        false,
      ),
    evaluateWatch: (watchId) =>
      call<WatchRecord>(
        "POST",
        `/api/v1/me/watches/${encodeURIComponent(watchId)}/evaluate`,
        {},
        NO_BODY,
        true,
      ),

    deleteMyData: () => call<DeletionResponse>("DELETE", "/api/v1/me/data", {}, NO_BODY, true),

    adminUsage: (by, days) => get<UsageSummaryResponse>("/api/v1/admin/usage", { by, days }),
    adminPolicies: () => get<PolicyListResponse>("/api/v1/admin/policies"),
    adminCatalog: () => get<CatalogListResponse>("/api/v1/admin/models"),
    adminComparisons: (limit) => get<LabRunListResponse>("/api/v1/admin/lab/comparisons", { limit }),
    adminComparison: (runId) =>
      get<LabRunResponse>(`/api/v1/admin/lab/comparisons/${encodeURIComponent(runId)}`),
    confirmPolicyCandidates: (policyId, request) =>
      call<PolicyRecord>(
        "PUT",
        `/api/v1/admin/policies/${encodeURIComponent(policyId)}/candidates`,
        {},
        request,
        true,
      ),
    adminPolicyAudit: (policyId, limit) =>
      get<PolicyAuditResponse>(
        `/api/v1/admin/policies/${encodeURIComponent(policyId)}/audit`,
        { limit },
      ),
  };
}
