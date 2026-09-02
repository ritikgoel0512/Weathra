/**
 * Task 20.1: the client layer holds the session in cookies, and reads nothing but public
 * configuration.
 *
 * `@supabase/ssr` is mocked at its boundary — the point of these tests is *how Weathra configures*
 * a Supabase client, not what the library does with the configuration.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { SECRET_NAMES } from "@/scripts/secret-containment";

import { supabaseBrowserClient } from "./browser";
import { currentUser, supabaseServerClient } from "./server";

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: vi.fn(() => ({ auth: {} })),
  createServerClient: vi.fn(() => ({ auth: { getUser: vi.fn() } })),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const PUBLIC_URL = "https://project.supabase.co";
const PUBLIC_KEY = "public-anon-key";

const original = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = PUBLIC_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = PUBLIC_KEY;
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:8000";
});

afterEach(() => {
  process.env = { ...original };
  vi.clearAllMocks();
});

/** A cookie store standing in for `next/headers`. */
function cookieStore(initial: { name: string; value: string }[] = []) {
  const held = [...initial];
  return {
    store: {
      getAll: () => held,
      set: vi.fn((name: string, value: string) => {
        held.push({ name, value });
      }),
    },
    held,
  };
}

describe("the browser client", () => {
  it("is built by the cookie-based SSR factory, not the localStorage one", () => {
    supabaseBrowserClient();

    // `createBrowserClient` from @supabase/ssr keeps the session in cookies so the server can read
    // it; `createClient` from @supabase/supabase-js would keep it in localStorage, where Next.js
    // middleware cannot see it and a protected route could only be gated after it rendered.
    expect(createBrowserClient).toHaveBeenCalledWith(PUBLIC_URL, PUBLIC_KEY);
  });

  it("passes the public configuration and nothing else", () => {
    supabaseBrowserClient();

    const call = (createBrowserClient as Mock).mock.calls[0];
    expect(call).toHaveLength(2);
  });
});

describe("the server client", () => {
  it("reads the request's cookies through next/headers", async () => {
    const { store } = cookieStore([{ name: "sb-project-auth-token", value: "session" }]);
    (cookies as Mock).mockResolvedValue(store);

    await supabaseServerClient();

    const options = (createServerClient as Mock).mock.calls[0]?.[2];
    expect(options.cookies.getAll()).toEqual([
      { name: "sb-project-auth-token", value: "session" },
    ]);
  });

  it("writes refreshed cookies back to the store", async () => {
    const { store, held } = cookieStore();
    (cookies as Mock).mockResolvedValue(store);

    await supabaseServerClient();
    const options = (createServerClient as Mock).mock.calls[0]?.[2];
    options.cookies.setAll([
      { name: "sb-project-auth-token", value: "refreshed", options: { path: "/" } },
    ]);

    expect(held).toEqual([{ name: "sb-project-auth-token", value: "refreshed" }]);
  });

  it("tolerates a server component's read-only cookie store", async () => {
    // Rendering a server component happens after the response headers are settled, so `set`
    // throws. The middleware has already written the refreshed cookie, so this must not become an
    // error every server component has to catch for itself.
    (cookies as Mock).mockResolvedValue({
      getAll: () => [],
      set: () => {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler");
      },
    });

    await supabaseServerClient();
    const options = (createServerClient as Mock).mock.calls[0]?.[2];

    expect(() =>
      options.cookies.setAll([{ name: "sb-project-auth-token", value: "x", options: {} }]),
    ).not.toThrow();
  });

  it("resolves the user by validating the token, not by decoding the cookie", async () => {
    const { store } = cookieStore();
    (cookies as Mock).mockResolvedValue(store);
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } });
    (createServerClient as Mock).mockReturnValue({ auth: { getUser } });

    const user = await currentUser();

    expect(getUser).toHaveBeenCalledOnce();
    expect(user).toEqual({ id: "user-1" });
  });

  it("reports no user rather than throwing when there is no session", async () => {
    const { store } = cookieStore();
    (cookies as Mock).mockResolvedValue(store);
    (createServerClient as Mock).mockReturnValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });

    expect(await currentUser()).toBeNull();
  });
});

describe("the client layer's configuration surface", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = ["browser.ts", "server.ts", "middleware.ts"].map((name) => ({
    name,
    text: readFileSync(join(here, name), "utf8"),
  }));

  it("references no server-side secret", () => {
    for (const { name, text } of sources) {
      // The comments explain *why* a secret must not be here, so only assignments and reads count.
      const code = text
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .join("\n");

      for (const secret of SECRET_NAMES) {
        expect(code, `${name} must not name ${secret}`).not.toContain(secret);
      }
    }
  });

  it("reads its configuration only through publicEnv", () => {
    for (const { name, text } of sources) {
      expect(text, `${name} must not touch process.env directly`).not.toContain("process.env");
      expect(text).toContain("publicEnv");
    }
  });
});
