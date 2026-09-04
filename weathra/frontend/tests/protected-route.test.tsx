/**
 * The protected-route boundary as one chain — task 18.10.
 *
 * Group 18 exists to prove the identity boundary *as a whole*: the groups above test their own
 * slices, and a slice passing says nothing about whether the piece next to it agrees. This is the
 * frontend's consolidated proof, and what it adds over the slice tests is the **handoffs** — the
 * places where one component produces a value another consumes, and where a mismatch would leave
 * every existing test green:
 *
 *   middleware writes the destination  →  the sign-in page reads it back
 *   the sign-in page hands it to the form  →  the form navigates to the original path
 *   the layout resolves the session  →  the boundary is seeded from that answer
 *   the API answers 401  →  the boundary's expired state points back to the same place
 *   sign-out revokes  →  the layout refuses again
 *
 * Each link is asserted against the value the previous one actually produced rather than against a
 * string retyped here, so a rename on either side fails this file.
 *
 * The gate's own end of the first handoff is `signInPathFor` — the function `middleware.ts` calls to
 * build the sign-in URL — rather than the middleware object itself. `next/server` needs Node's
 * `Headers`, and a rendering environment substitutes jsdom's, so the middleware's response-level
 * behaviour (its status, its `Location`, its `Cache-Control`, its cookie handling) is verified in
 * `middleware.test.ts`, which runs under the node environment for exactly that reason. What is
 * asserted here is the half that file cannot reach: that what the gate writes is what the screens
 * read.
 *
 * The browser-level half is `tests/e2e/protected-route.spec.ts`, which runs the same journey
 * against the real production build in Chromium.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApiQuery } from "@/lib/query/hooks";
import {
  DEFAULT_PROTECTED_PATH,
  DESTINATION_PARAMETER,
  EXPIRED_PARAMETER,
  SIGN_IN_PATH,
  safeDestination,
  signInPathFor,
} from "@/lib/routes";
import { SessionBoundary } from "@/lib/session/provider";

/* ------------------------------------------------------------------ test doubles */

const currentUser = vi.fn<() => Promise<User | null>>();
const serverSignOut = vi.fn<(options?: { scope?: string }) => Promise<{ error: null }>>();
const signInWithPassword = vi.fn();
const browserSignOut = vi.fn();
const browserAccessToken = vi.fn<() => Promise<string | null>>();
const replace = vi.fn();
const refresh = vi.fn();
const redirect = vi.fn((destination: string) => {
  throw new Error(`REDIRECT:${destination}`);
});

vi.mock("@/lib/supabase/server", () => ({
  currentUser: () => currentUser(),
  supabaseServerClient: async () => ({
    auth: { signOut: (options?: { scope?: string }) => serverSignOut(options) },
  }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: () => browserAccessToken(),
  supabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: (credentials: unknown) => signInWithPassword(credentials),
      signOut: () => browserSignOut(),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  redirect: (destination: string) => redirect(destination),
  usePathname: () => window.location.pathname,
}));

const { default: ProtectedLayout } = await import("@/app/(app)/layout");
const { default: SignInPage } = await import("@/app/(auth)/sign-in/page");
const { signOut } = await import("@/lib/auth/sign-out");

/* ----------------------------------------------------------------------- fixtures */

const PROTECTED = "/compare";
const QUERY = "?a=Berlin";
const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

function person(): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: CREDENTIALS.email,
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-01T00:00:00.000Z",
  } as User;
}

/** The search parameters of a path, in the shape a Next.js page receives them. */
function searchParamsOf(path: string): Record<string, string> {
  return Object.fromEntries(new URL(path, "https://weathra.test").searchParams);
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body } as unknown as Response;
}

/** A screen that reads data the way every group 21 screen will. */
function Screen(): React.ReactNode {
  const { state } = useApiQuery({ key: ["me"], request: (client) => client.me() });
  if (state.kind === "loading") return <p>Loading</p>;
  if (state.kind === "error") return <p>Data error: {state.failure.message}</p>;
  if (state.kind === "empty") return <p>Empty</p>;
  return <p>Protected content</p>;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  browserAccessToken.mockResolvedValue("test-access-token");
  serverSignOut.mockResolvedValue({ error: null });
  window.history.replaceState({}, "", `${PROTECTED}${QUERY}`);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------- chain */

describe("the chain: an unauthenticated visit, through sign-in, back to the destination", () => {
  it("carries the destination intact from the gate to the navigation that honours it", async () => {
    // 1. The gate turns a protected request into a sign-in URL.
    const gated = signInPathFor(PROTECTED, QUERY);
    expect(gated).toBe(`${SIGN_IN_PATH}?${DESTINATION_PARAMETER}=${encodeURIComponent(`${PROTECTED}${QUERY}`)}`);

    // 2. The sign-in screen reads back exactly what the gate wrote — not a value retyped here.
    const parameters = searchParamsOf(gated);
    expect(safeDestination(parameters[DESTINATION_PARAMETER])).toBe(`${PROTECTED}${QUERY}`);

    render(await SignInPage({ searchParams: Promise.resolve(parameters) }));
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();

    // 3. Signing in navigates to the path the gate recorded, and nowhere else.
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "test-access-token" }, user: person() },
      error: null,
    });

    await userEvent.type(screen.getByLabelText("Email"), CREDENTIALS.email);
    await userEvent.type(screen.getByLabelText("Password"), CREDENTIALS.password);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${PROTECTED}${QUERY}`));
    // The refresh is what makes the server see the session the sign-in just created.
    expect(refresh).toHaveBeenCalled();
  });

  it("sends somebody who asked for nothing in particular to the default, not to a stray parameter", async () => {
    const gated = signInPathFor(DEFAULT_PROTECTED_PATH);
    expect(gated).toBe(SIGN_IN_PATH);

    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "t" }, user: person() },
      error: null,
    });
    render(await SignInPage({ searchParams: Promise.resolve(searchParamsOf(gated)) }));
    await userEvent.type(screen.getByLabelText("Email"), CREDENTIALS.email);
    await userEvent.type(screen.getByLabelText("Password"), CREDENTIALS.password);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
  });

  it("refuses a destination that is not a path on this origin, however it arrives", async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "t" }, user: person() },
      error: null,
    });

    for (const hostile of ["//evil.example", "https://evil.example/x", "/\\evil.example"]) {
      expect(safeDestination(hostile), hostile).toBeNull();

      // And a screen handed one anyway navigates to the default rather than off this origin.
      replace.mockClear();
      const view = render(
        await SignInPage({ searchParams: Promise.resolve({ [DESTINATION_PARAMETER]: hostile }) }),
      );
      await userEvent.type(screen.getByLabelText("Email"), CREDENTIALS.email);
      await userEvent.type(screen.getByLabelText("Password"), CREDENTIALS.password);
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
      expect(replace, hostile).not.toHaveBeenCalledWith(expect.stringContaining("evil.example"));
      view.unmount();
    }
  });
});

describe("the chain: an authenticated visit renders, without a flash", () => {
  it("renders the shell around the screen once the session resolves", async () => {
    currentUser.mockResolvedValue(person());
    render(await ProtectedLayout({ children: <p>Screen</p> }));

    expect(screen.getByRole("navigation", { name: "Weathra" })).toBeInTheDocument();
    expect(screen.getByText("Screen")).toBeInTheDocument();
  });

  it("produces no tree at all without a session, so there is nothing to take away", async () => {
    // The layout gate runs before a first paint exists.
    currentUser.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <p>Secret</p> })).rejects.toThrow(/^REDIRECT:/);

    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("never renders the pending state on a screen the server already resolved", async () => {
    // The layout seeds the boundary from the session it validated, so the client half has nothing
    // to wait for and shows no resolution state.
    render(
      <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={async () => jsonResponse(200, {})}>
        <p>Protected content</p>
      </SessionBoundary>,
    );

    expect(screen.getByText("Protected content")).toBeInTheDocument();
    expect(screen.queryByText("Checking your session")).not.toBeInTheDocument();
    expect(browserAccessToken).not.toHaveBeenCalled();
  });

  it("shows the resolution state, and never protected content, while it genuinely does not know", () => {
    browserAccessToken.mockReturnValue(new Promise(() => {}));

    render(
      <SessionBoundary initialStatus="pending" fetch={async () => jsonResponse(200, {})}>
        <p>Protected content</p>
      </SessionBoundary>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    // And it does not claim they are signed out while it is still asking.
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });
});

describe("the chain: a 401 from the API becomes the expired session, not a data error", () => {
  it("replaces the screen with the expired state and points back to where they were", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: "token_expired", message: "The access token has expired.", details: null, request_id: "r1" },
      }),
    );

    render(
      <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input, init) => fetchMock(input, init)}>
        <Screen />
      </SessionBoundary>,
    );

    const expired = await screen.findByRole("alert");
    expect(expired).toHaveTextContent(/your session has expired/i);
    expect(screen.queryByText(/Data error/)).not.toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();

    // The way back keeps the place, and says why they are there — the same two parameters the gate
    // uses, read by the same sign-in screen.
    const href = screen.getByRole("link", { name: "Sign in again" }).getAttribute("href") ?? "";
    expect(href).toBe(
      `${SIGN_IN_PATH}?${DESTINATION_PARAMETER}=${encodeURIComponent(`${PROTECTED}${QUERY}`)}&${EXPIRED_PARAMETER}=1`,
    );

    render(await SignInPage({ searchParams: Promise.resolve(searchParamsOf(href)) }));
    expect(screen.getByRole("status")).toHaveTextContent(/your session expired/i);

    // Nothing of the provider's reaches the page.
    const shown = document.body.textContent ?? "";
    expect(shown).not.toContain("The access token has expired.");
    expect(shown).not.toContain("token_expired");
  });

  it("leaves an ordinary weather or API failure as a data error, with nobody signed out", async () => {
    for (const [status, code, message] of [
      [503, "provider_unavailable", "The weather provider is unavailable."],
      [404, "location_not_found", "No such place."],
      [403, "not_permitted", "That is not available to you."],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(status, { error: { code, message, details: null, request_id: "r1" } }),
      );

      const view = render(
        <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(i, n) => fetchMock(i, n)}>
          <Screen />
        </SessionBoundary>,
      );

      expect(await screen.findByText(`Data error: ${message}`, undefined, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByText(/session has expired/i), String(status)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("does not sign anybody out because the backend could not be reached", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(i, n) => fetchMock(i, n)}>
        <Screen />
      </SessionBoundary>,
    );

    await waitFor(
      () => expect(screen.getByText(/Data error:/)).toHaveTextContent(/could not be reached/i),
      { timeout: 5000 },
    );
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });
});

describe("the chain: sign-out ends protected access", () => {
  it("revokes with Supabase, and the gate and the layout both refuse afterwards", async () => {
    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);
    expect(serverSignOut).toHaveBeenCalledWith({ scope: "global" });

    // What the next request sees: no session, so the server-side gate refuses again.
    currentUser.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <p>Secret</p> })).rejects.toThrow(/^REDIRECT:/);
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });

});

describe("what the boundary never does", () => {
  it("keeps no authentication state in browser storage at any point", async () => {
    render(
      <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={async () => jsonResponse(200, {})}>
        <Screen />
      </SessionBoundary>,
    );
    await screen.findByText("Protected content");

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("resolves identity through Supabase on the server, on every render", async () => {
    currentUser.mockResolvedValue(person());
    await ProtectedLayout({ children: <p>Screen</p> });
    await ProtectedLayout({ children: <p>Screen</p> });

    // `currentUser` is `getUser()`: the token is validated with the provider rather than decoded
    // from a cookie, and it is asked again for every render rather than remembered.
    expect(currentUser).toHaveBeenCalledTimes(2);
  });
});
