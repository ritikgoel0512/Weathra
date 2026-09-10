// @vitest-environment node

/**
 * Task 20.11: the client attaches the token to every protected call, uses a refreshed one, and its
 * response types match the contract.
 *
 * The first of those is asserted against the generated operations table rather than against a list
 * written here: every operation the backend marks `security` is exercised through the client and
 * checked for the header. A protected endpoint added to the backend therefore arrives with a test
 * already asking whether the client authenticates it — which is the only version of this test that
 * stays true a year from now.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiUrl,
  BackendUnreachable,
  bearerHeaders,
  createApiClient,
  normalizeBaseUrl,
  SessionExpired,
  UNEXPECTED_RESPONSE_MESSAGE,
  type ApiClient,
} from "./client";
import { API_OPERATIONS, type ApiOperation } from "./schema";

const BASE = "https://api.weathra.test";
const original = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});

afterEach(() => {
  process.env = { ...original };
});

/** A fetch that records what it was asked for and answers with a fixed payload. */
function recording(payload: unknown = {}, status = 200, statusText = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      statusText,
      headers: status === 204 ? {} : { "content-type": "application/json" },
    });
  });
  return { calls, fetcher };
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe("the request the client makes", () => {
  it("targets the configured backend, which is configuration and not code", async () => {
    const { calls, fetcher } = recording({ status: "ok" });
    const client = createApiClient({ baseUrl: "https://elsewhere.example/", fetch: fetcher });

    await client.health();

    expect(calls[0]?.url).toBe("https://elsewhere.example/api/v1/health");
  });

  it("defaults to the public base URL", async () => {
    const { calls, fetcher } = recording();
    await createApiClient({ fetch: fetcher }).health();

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/health`);
  });

  it("omits parameters that were not given, rather than sending them empty", async () => {
    const { calls, fetcher } = recording();

    await createApiClient({ fetch: fetcher }).forecast({ location: "Berlin", days: 7 });

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/weather/forecast?location=Berlin&days=7`);
  });

  it("sends no cookies, because the bearer token is the whole of the authorization", async () => {
    const { calls, fetcher } = recording();

    await createApiClient({ fetch: fetcher, accessToken: () => "token" }).me();

    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("escapes a path parameter", async () => {
    const { calls, fetcher } = recording(null, 204);

    await createApiClient({ fetch: fetcher, accessToken: () => "t" }).deleteThread("a b/c");

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/threads/a%20b%2Fc`);
  });
});

describe("the access token", () => {
  it("is attached to every operation the contract marks protected", async () => {
    // Driven off the generated table: the assertion covers whatever the backend protects today.
    // Administrative operations are protected too, and are excluded here for the same dated
    // reason as above: there is no client method to invoke, because there is no screen yet.
    const protectedOperations = API_OPERATIONS.filter(
      (operation) => operation.requiresToken && !operation.administrative,
    );
    expect(protectedOperations.length).toBeGreaterThan(8);

    for (const operation of protectedOperations) {
      const { calls, fetcher } = recording(
        {},
        operation.successStatus === 204 ? 204 : operation.successStatus,
      );
      const client = createApiClient({ fetch: fetcher, accessToken: () => "the-token" });

      await invoke(client, operation);

      expect(header(calls[0]?.init ?? {}, "Authorization"), operation.operationId).toBe(
        "Bearer the-token",
      );
      expect(calls[0]?.init.method, operation.operationId).toBe(operation.method);
    }
  });

  it("is asked for again on every call, so a refreshed token is the one that is used", async () => {
    // Supabase refreshes underneath the application. A client that captured the first token would
    // start failing mid-session, and it would look like the backend rejecting a valid user.
    const { calls, fetcher } = recording();
    const tokens = ["first", "second", "third"];
    const client = createApiClient({ fetch: fetcher, accessToken: () => tokens.shift() ?? null });

    await client.me();
    await client.preferences();
    await client.threads();

    expect(calls.map(({ init }) => header(init, "Authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
      "Bearer third",
    ]);
  });

  it("accepts an asynchronous source, which is what a session lookup is", async () => {
    const { calls, fetcher } = recording();
    const client = createApiClient({
      fetch: fetcher,
      accessToken: async () => "awaited-token",
    });

    await client.me();

    expect(header(calls[0]?.init ?? {}, "Authorization")).toBe("Bearer awaited-token");
  });

  it("is absent from a public call made without a session", async () => {
    const { calls, fetcher } = recording();

    await createApiClient({ fetch: fetcher, accessToken: () => null }).current({
      location: "Berlin",
    });

    expect(header(calls[0]?.init ?? {}, "Authorization")).toBeUndefined();
  });
});

describe("a failure the backend described", () => {
  const envelope = {
    error: {
      code: "location_not_found",
      message: "No place matched “Atlantis”.",
      details: { query: "Atlantis" },
      request_id: "req-42",
    },
  };

  it("arrives as an ApiError carrying the code, the message, and the request id", async () => {
    const { fetcher } = recording(envelope, 404);
    const client = createApiClient({ fetch: fetcher });

    const error = await client.current({ location: "Atlantis" }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("location_not_found");
    expect(error.message).toBe("No place matched “Atlantis”.");
    expect(error.details).toEqual({ query: "Atlantis" });
    expect(error.requestId).toBe("req-42");
  });

  it("shows the backend's own message, which is what the view is required to display", async () => {
    const { fetcher } = recording(envelope, 422);

    const error = await createApiClient({ fetch: fetcher })
      .current({ location: "Atlantis" })
      .catch((thrown) => thrown);

    expect(error.message).toBe(envelope.error.message);
  });

  it("does not invent a stable code for a response that carried no envelope", async () => {
    // A bare 502 from a proxy never reached Weathra's handlers. Pretending it has a Weathra error
    // code would let a view branch on something that is not a contract.
    const { fetcher } = recording("<html>gateway</html>", 502);

    const error = await createApiClient({ fetch: fetcher }).health().catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe(UNEXPECTED_RESPONSE_MESSAGE(502));
  });

  it("speaks in Weathra's words rather than the gateway's", async () => {
    /*
     * `statusText` is written for whoever operates the proxy. The runtime audit of 2026-09-08
     * photographed a signed-in visitor being told "Internal Server Error" under Weathra's own
     * heading — an implementation detail wearing the product's voice. The status number survives,
     * because it is the part of an unrecognised failure worth quoting.
     */
    const { fetcher } = recording("<html>gateway</html>", 500, "Internal Server Error");

    const error = await createApiClient({ fetch: fetcher }).health().catch((thrown) => thrown);

    expect(error.message).not.toMatch(/internal server error/i);
    expect(error.message).toContain("500");
    expect(error.details).toEqual({ status_text: "Internal Server Error" });
  });
});

describe("an expired session", () => {
  const unauthorized = {
    error: { code: "unauthenticated", message: "No valid access token was presented." },
  };

  it("is a SessionExpired, not a data error", async () => {
    const { fetcher } = recording(unauthorized, 401);

    const error = await createApiClient({ fetch: fetcher, accessToken: () => "stale" })
      .me()
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(SessionExpired);
    expect(error.status).toBe(401);
  });

  it("notifies the session layer once so it can clear state and route to sign-in", async () => {
    const onSessionExpired = vi.fn();
    const { fetcher } = recording(unauthorized, 401);

    await createApiClient({ fetch: fetcher, accessToken: () => "stale", onSessionExpired })
      .threads()
      .catch(() => undefined);

    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(onSessionExpired.mock.calls[0]?.[0]).toBeInstanceOf(SessionExpired);
  });

  it("is distinguishable from a forbidden call, which is not an authentication event", async () => {
    const { fetcher } = recording(
      { error: { code: "forbidden", message: "Not yours." } },
      403,
    );

    const error = await createApiClient({ fetch: fetcher, accessToken: () => "t" })
      .evidence("abc")
      .catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionExpired);
  });
});

describe("a backend that could not be reached", () => {
  it("is reported as unreachable rather than as a backend error", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = await createApiClient({ fetch: fetcher }).health().catch((thrown) => thrown);

    expect(error).toBeInstanceOf(BackendUnreachable);
    expect(error.message).toContain("could not be reached");
  });

  it("lets a deliberate cancellation through untouched", async () => {
    // A view that abandoned a request must not be told the backend is down.
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = await createApiClient({ fetch: fetcher }).health().catch((thrown) => thrown);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("a call that returns no content", () => {
  it("resolves rather than failing to parse an empty body as JSON", async () => {
    const { fetcher } = recording(null, 204);
    const client = createApiClient({ fetch: fetcher, accessToken: () => "t" });

    await expect(client.removeSavedLocation("abc")).resolves.toBeUndefined();
    await expect(client.deleteThread("def")).resolves.toBeUndefined();
  });
});

describe("the client's coverage of the contract", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "client.ts"),
    "utf8",
  );

  it("calls every non-administrative path the backend serves", () => {
    // A screen that needed an endpoint the client had no method for would reach for `fetch`
    // directly, and the token handling and the 401 interception would be missing from that call.
    //
    // Administrative operations are excluded, and the exclusion is dated rather than permanent:
    // the administrative screens are task 33.1–33.4 and are gated on a design that does not exist
    // yet, so a client method for them would be a method nothing calls. The check below keeps them
    // from being forgotten — every operation is either covered here or marked administrative, and
    // there is no third category to hide in.
    for (const { path, administrative } of API_OPERATIONS) {
      if (administrative) continue;
      // Split on the parameters rather than blanking them: a path whose parameter is *followed* by
      // a segment — `/me/watches/{watch_id}/evaluate` — leaves `//evaluate`, which no source
      // contains, and the check would fail on a method that is present.
      for (const literal of path.split(/\{[^}]+\}/).filter((part) => part.length > 1)) {
        expect(source, `${path} (${literal})`).toContain(literal);
      }
    }
  });

  it("serves exactly the administrative paths the one built administrative surface needs", () => {
    // Until task 34.8 this read "and this client does not yet serve": no administrative path
    // reached the client, because the administrative screens were designed and not built. One
    // panel of one of them is now built — `specs/web-ui`'s *Administrative model policy
    // confirmation* — so the assertion is no longer "none" but "these, and nothing else".
    //
    // Stated as a set rather than as a per-path substring check, because the client builds these
    // as template literals and a substring test either misses one or accidentally matches a
    // different path's prefix. Set equality catches both directions: an administrative endpoint
    // that quietly joined the client, and one of these six silently dropped.
    const NEEDED = new Set([
      "/api/v1/admin/models",
      "/api/v1/admin/usage",
      "/api/v1/admin/policies",
      "/api/v1/admin/policies/{}/audit",
      "/api/v1/admin/policies/{}/candidates",
      "/api/v1/admin/lab/comparisons",
      "/api/v1/admin/lab/comparisons/{}",
      // Task 34.22: the two management surfaces that previously needed a script. The plans and
      // principals the administrative screen lists, the audited assignment, and the two mappings
      // the routing panel changes — a plan's policy per call role, and a policy's fallback.
      "/api/v1/admin/plans",
      "/api/v1/admin/plans/{}/policies",
      "/api/v1/admin/principals",
      "/api/v1/admin/principals/{}/plan",
      "/api/v1/admin/policies/{}/fallback",
    ]);

    const administrative = API_OPERATIONS.filter(({ administrative }) => administrative);
    expect(administrative.length).toBeGreaterThan(8);
    for (const { path } of administrative) expect(path, path).toMatch(/^\/api\/v1\/admin\//);

    // Every administrative path the contract declares, and every one the client reaches, in one
    // shape: a parameter is `{}` however it was written.
    const shape = (path: string) => path.replace(/\{[^}]*\}/g, "{}");
    const declared = new Set(administrative.map(({ path }) => shape(path)));
    const reached = new Set(
      [...source.matchAll(/\/api\/v1\/admin\/[^"'`]*/g)].map((match) =>
        shape(match[0].replace(/\$\{[^}]*\}/g, "{}")),
      ),
    );

    expect([...reached].sort()).toEqual([...NEEDED].sort());
    expect([...NEEDED].filter((path) => !declared.has(path))).toEqual([]);

    const uncovered = API_OPERATIONS.filter(({ path, administrative }) => {
      if (administrative) return false;
      return path
        .split(/\{[^}]+\}/)
        .filter((part) => part.length > 1)
        .some((literal) => !source.includes(literal));
    });
    expect(uncovered.map(({ path }) => path)).toEqual([]);
  });

  it("sends no parameter the contract does not declare", () => {
    // Every query key the client builds must be one the backend accepts, or the value is silently
    // ignored and a screen shows unfiltered data believing it filtered.
    const declared = new Set(
      API_OPERATIONS.flatMap(({ parameters }) =>
        parameters.filter(({ in: where }) => where === "query").map(({ name }) => name),
      ),
    );

    for (const key of ["query", "limit", "location", "latitude", "longitude", "units", "provider", "days", "above", "below", "start", "end", "years", "measure", "earlier_start", "earlier_end", "later_start", "later_end"]) {
      expect(declared, key).toContain(key);
    }
  });
});

describe("the URL and header helpers", () => {
  it("joins a base URL with a trailing slash unambiguously", () => {
    expect(normalizeBaseUrl("https://x.test///")).toBe("https://x.test");
    expect(apiUrl("https://x.test/", "/api/v1/health")).toBe("https://x.test/api/v1/health");
  });

  it("encodes query values", () => {
    expect(apiUrl(BASE, "/api/v1/locations/search", { query: "São Paulo" })).toBe(
      `${BASE}/api/v1/locations/search?query=S%C3%A3o+Paulo`,
    );
  });

  it("produces no Authorization header without a token", () => {
    expect(bearerHeaders(null)).toEqual({});
    expect(bearerHeaders("t")).toEqual({ Authorization: "Bearer t" });
  });
});

/** Call the client method for one operation, with placeholder arguments. */
async function invoke(client: ApiClient, operation: ApiOperation): Promise<unknown> {
  const identifier = "00000000-0000-4000-8000-000000000000";
  const byOperation: Record<string, () => Promise<unknown>> = {
    ask_api_v1_agent_ask_post: () => client.ask({ question: "Will it rain?" }),
    changes_api_v1_weather_changes_get: () => client.changes({ location: "Berlin" }),
    evidence_api_v1_evidence__evidence_id__get: () => client.evidence(identifier),
    me_api_v1_me_get: () => client.me(),
    read_usage_api_v1_me_usage_get: () => client.usage(),
    read_preferences_api_v1_me_preferences_get: () => client.preferences(),
    update_preferences_api_v1_me_preferences_put: () =>
      client.updatePreferences({ unit_system: "metric" }),
    delete_preferences_api_v1_me_preferences_delete: () => client.resetPreferences(),
    list_locations_api_v1_me_locations_get: () => client.savedLocations(),
    save_location_api_v1_me_locations_post: () => client.saveLocation({ location: "Berlin" }),
    remove_location_api_v1_me_locations__saved_id__delete: () =>
      client.removeSavedLocation(identifier),
    list_watches_api_v1_me_watches_get: () => client.watches(),
    create_watch_api_v1_me_watches_post: () =>
      client.createWatch({ location: "Berlin", measure: "temperature", comparison: "above", threshold: 20 }),
    update_watch_api_v1_me_watches__watch_id__patch: () =>
      client.updateWatch(identifier, { threshold: 25 }),
    remove_watch_api_v1_me_watches__watch_id__delete: () => client.removeWatch(identifier),
    evaluate_one_api_v1_me_watches__watch_id__evaluate_post: () =>
      client.evaluateWatch(identifier),
    delete_my_data_api_v1_me_data_delete: () => client.deleteMyData(),
    threads_api_v1_threads_get: () => client.threads(),
    thread_api_v1_threads__thread_id__get: () => client.thread(identifier),
    remove_thread_api_v1_threads__thread_id__delete: () => client.deleteThread(identifier),
    baseline_comparison_api_v1_weather_history_baseline_comparison_get: () =>
      client.baselineComparison({ location: "Berlin", start: "2025-06-01", end: "2025-06-07" }),
    search_api_v1_locations_search_get: () => client.searchLocations("Berlin"),
    resolve_api_v1_locations_resolve_get: () => client.resolveLocation({ query: "Berlin" }),
    stream_api_v1_agent_stream_post: () => client.openAgentStream({ question: "Rain?" }),
  };

  const invocation = byOperation[operation.operationId];
  if (invocation === undefined) {
    throw new Error(
      `No client call is exercised for the protected operation ${operation.operationId}. ` +
        "Add one here, or add the method to the client.",
    );
  }
  return invocation();
}
