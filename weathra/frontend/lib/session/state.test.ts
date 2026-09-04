/**
 * The session layer's pure logic — task 20.9.
 *
 * Two properties are worth asserting directly rather than through a component, because both are the
 * kind that fail silently: **which failures count as an authentication failure** (getting this
 * wrong signs people out for a weather outage, or leaves an expired session showing a data error),
 * and **that `expired` is terminal** (which is what makes an expire/refresh/retry loop
 * unrepresentable rather than merely unlikely).
 */

import { describe, expect, it } from "vitest";

import { ApiError, BackendUnreachable, SessionExpired } from "@/lib/api/client";
import { AUTHENTICATION_ERROR_CODES } from "@/lib/api/errors";
import { DEFAULT_PROTECTED_PATH, SIGN_IN_PATH, expiredSignInPath } from "@/lib/routes";

import { isAuthenticationFailure, mayRenderProtectedContent, nextStatus } from "./state";

function body(code: string, message = "Refused.") {
  return { code, message, details: null, request_id: "req-1" };
}

describe("what counts as an authentication failure", () => {
  it("recognises the client's own expired-session error", () => {
    expect(isAuthenticationFailure(new SessionExpired(body("token_expired")))).toBe(true);
  });

  it("recognises a 401 whatever shape it arrives in", () => {
    expect(isAuthenticationFailure(new ApiError(401, body("authentication_failed")))).toBe(true);
    // Through a cache, a serialization boundary, or a test's fake: the same failure, described.
    expect(isAuthenticationFailure({ status: 401, code: "token_missing" })).toBe(true);
    expect(isAuthenticationFailure({ name: "SessionExpired" })).toBe(true);
  });

  it("recognises every authentication code the backend can send, including mid-stream", () => {
    // A stream's terminal event carries a code and no status, which is the case a status check
    // would miss entirely.
    for (const code of AUTHENTICATION_ERROR_CODES) {
      expect(isAuthenticationFailure({ code }), code).toBe(true);
    }
  });
});

describe("what does not", () => {
  it("leaves an ordinary data failure alone", () => {
    for (const status of [400, 404, 409, 422, 429, 500, 502, 503]) {
      expect(isAuthenticationFailure(new ApiError(status, body("provider_unavailable"))), String(status))
        .toBe(false);
    }
  });

  it("does not read a refusal as an expiry", () => {
    // Being refused something is not the same as having no session, and treating it as one would
    // sign a person out for opening a screen they are not entitled to.
    expect(isAuthenticationFailure(new ApiError(403, body("not_permitted")))).toBe(false);
  });

  it("leaves an unreachable backend alone", () => {
    expect(isAuthenticationFailure(new BackendUnreachable(new Error("dns")))).toBe(false);
  });

  it("is not fooled by anything that merely failed", () => {
    for (const value of [null, undefined, "401", 401, new Error("boom"), {}]) {
      expect(isAuthenticationFailure(value), String(value)).toBe(false);
    }
  });
});

describe("the status transitions", () => {
  it("resolves a pending boundary", () => {
    expect(nextStatus("pending", "resolved")).toBe("active");
  });

  it("expires on an authentication failure, from either live status", () => {
    expect(nextStatus("pending", "authentication-failed")).toBe("expired");
    expect(nextStatus("active", "authentication-failed")).toBe("expired");
  });

  it("leaves the status alone for an ordinary request failure", () => {
    expect(nextStatus("active", "request-failed")).toBe("active");
    expect(nextStatus("pending", "request-failed")).toBe("pending");
  });

  it("makes expired terminal, which is what forbids a loop", () => {
    // A late success, a second 401, a retry that lands after the person has been told: none of
    // them can talk the layer back into rendering protected content.
    for (const event of ["resolved", "authentication-failed", "request-failed"] as const) {
      expect(nextStatus("expired", event), event).toBe("expired");
    }
  });

  it("renders protected content in exactly one status", () => {
    expect(mayRenderProtectedContent("active")).toBe(true);
    expect(mayRenderProtectedContent("pending")).toBe(false);
    expect(mayRenderProtectedContent("expired")).toBe(false);
  });
});

describe("where an expired session sends somebody", () => {
  it("keeps their place, and says why they are back", () => {
    expect(expiredSignInPath("/compare", "?a=Berlin")).toBe(
      `${SIGN_IN_PATH}?next=${encodeURIComponent("/compare?a=Berlin")}&expired=1`,
    );
  });

  it("carries no destination when there was nowhere in particular to keep", () => {
    expect(expiredSignInPath(DEFAULT_PROTECTED_PATH)).toBe(`${SIGN_IN_PATH}?expired=1`);
  });

  it("refuses a destination that is not a path on this origin", () => {
    for (const hostile of ["//evil.example", "https://evil.example/x", "/\\evil.example"]) {
      expect(expiredSignInPath(hostile), hostile).toBe(`${SIGN_IN_PATH}?expired=1`);
    }
  });
});
