// @vitest-environment node

/**
 * Tasks 20.2 and 20.10: the route gate, in both directions.
 *
 * These drive the real `middleware` with a real `NextRequest` and only Supabase mocked, because
 * the behaviour under test is almost entirely about `NextResponse` — which cookies survive a
 * redirect, what status a gate returns, where the `Location` header points. A test that mocked
 * `next/server` would assert its own fake.
 */

import { createServerClient } from "@supabase/ssr";
import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { middleware } from "./middleware";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const SIGNED_IN = { id: "3f1e0b2c-0000-4000-8000-000000000001", email: "person@example.com" };

const original = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:8000";
});

afterEach(() => {
  process.env = { ...original };
  vi.clearAllMocks();
});

/**
 * Stand in for Supabase's session resolution.
 *
 * `refreshed` simulates the library issuing new cookies during `getUser()` — which is exactly when
 * it happens, and the case that catches a middleware dropping them.
 */
function session(
  user: typeof SIGNED_IN | null,
  refreshed: { name: string; value: string }[] = [],
): void {
  (createServerClient as Mock).mockImplementation(
    (
      _url: string,
      _key: string,
      options: {
        cookies: {
          setAll: (updates: { name: string; value: string; options: object }[]) => void;
        };
      },
    ) => ({
      auth: {
        getUser: async () => {
          if (refreshed.length > 0) {
            options.cookies.setAll(
              refreshed.map(({ name, value }) => ({ name, value, options: { path: "/" } })),
            );
          }
          return { data: { user } };
        },
      },
    }),
  );
}

function request(path: string, cookie: { name: string; value: string } | null = null): NextRequest {
  const nextRequest = new NextRequest(new URL(path, "https://weathra.app"));
  if (cookie !== null) nextRequest.cookies.set(cookie.name, cookie.value);
  return nextRequest;
}

function location(response: NextResponse): string | null {
  const header = response.headers.get("location");
  return header === null ? null : new URL(header).pathname + new URL(header).search;
}

describe("an unauthenticated visitor", () => {
  beforeEach(() => session(null));

  it("is routed to sign-in from a protected screen, with the destination preserved", async () => {
    const response = await middleware(request("/historical?place=Berlin"));

    expect(response.status).toBe(307);
    expect(location(response)).toBe("/sign-in?next=%2Fhistorical%3Fplace%3DBerlin");
  });

  it("is routed to sign-in from the dashboard without a redundant destination", async () => {
    // The dashboard is where sign-in lands anyway, so carrying `next=/` would only make the URL
    // people see on the screen they distrust most look more like a phishing link.
    expect(location(await middleware(request("/")))).toBe("/sign-in");
  });

  it("is routed to sign-in from a route nobody remembered to list", async () => {
    // Protected by default: a screen added later is gated before anyone thinks to gate it.
    expect(location(await middleware(request("/some-future-screen")))).toBe(
      "/sign-in?next=%2Fsome-future-screen",
    );
  });

  it("reaches the authentication screens", async () => {
    const response = await middleware(request("/sign-in"));

    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it("reaches the email-link callback, which is how they get a session at all", async () => {
    expect((await middleware(request("/auth/confirm?token_hash=abc"))).status).toBe(200);
  });

  it("renders no protected content on the way past", async () => {
    const response = await middleware(request("/settings"));

    // A redirect, not a rewrite: nothing of the protected screen is rendered or streamed.
    expect(response.status).toBe(307);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(await response.text()).toBe("");
  });
});

describe("an authenticated person", () => {
  it("passes through to a protected screen", async () => {
    session(SIGNED_IN);

    const response = await middleware(request("/analyst", { name: "sb-auth", value: "session" }));

    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it("is redirected out of the sign-in screen into the product", async () => {
    session(SIGNED_IN);

    expect(location(await middleware(request("/sign-in")))).toBe("/");
  });

  it("is redirected out of every authentication screen", async () => {
    session(SIGNED_IN);

    for (const path of ["/create-account", "/verify-email", "/forgot-password"]) {
      expect(location(await middleware(request(path))), path).toBe("/");
    }
  });

  it("lands on the destination they were originally sent to sign-in from", async () => {
    session(SIGNED_IN);

    const response = await middleware(request("/sign-in?next=%2Fcompare%3Fa%3DBerlin"));

    expect(location(response)).toBe("/compare?a=Berlin");
  });

  it("is never redirected to another origin, whatever the destination claims", async () => {
    session(SIGNED_IN);

    // `//evil.example` is protocol-relative: a browser reads it as another origin. Echoing it
    // back would make sign-in an open redirect.
    for (const hostile of ["//evil.example", "https://evil.example/x", "/\\evil.example"]) {
      const response = await middleware(
        request(`/sign-in?next=${encodeURIComponent(hostile)}`),
      );
      expect(location(response), hostile).toBe("/");
    }
  });
});

describe("a refreshed session", () => {
  it("is carried on the response so the browser keeps it", async () => {
    session(SIGNED_IN, [{ name: "sb-auth", value: "refreshed" }]);

    const response = await middleware(request("/analyst", { name: "sb-auth", value: "expiring" }));

    expect(response.cookies.get("sb-auth")?.value).toBe("refreshed");
  });

  it("is visible to the server components rendering this very response", async () => {
    // Written to the request as well as the response. Without this, the render that triggered the
    // refresh still reads the old token — an intermittent sign-out nobody can reproduce.
    session(SIGNED_IN, [{ name: "sb-auth", value: "refreshed" }]);
    const incoming = request("/analyst", { name: "sb-auth", value: "expiring" });

    await middleware(incoming);

    expect(incoming.cookies.get("sb-auth")?.value).toBe("refreshed");
  });

  it("survives the redirect that gates the request", async () => {
    // A bare NextResponse.redirect drops them, signing the person out on the request that renewed
    // their session.
    session(null, [{ name: "sb-auth", value: "refreshed" }]);

    const response = await middleware(request("/settings"));

    expect(response.status).toBe(307);
    expect(response.cookies.get("sb-auth")?.value).toBe("refreshed");
  });
});
