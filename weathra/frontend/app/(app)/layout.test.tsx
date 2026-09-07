/**
 * The protected layout and the sign-out action — the session half of task 20.12.
 *
 * Two properties, and they are the ones that would be invisible if they broke:
 *
 * 1. **The session is resolved server-side, before anything renders.** The layout is an async
 *    server component; these tests await it and assert what it produced — that an unauthenticated
 *    request never gets a shell at all, and an authenticated one gets a shell carrying that
 *    person's own identity.
 * 2. **Sign-out goes through Supabase.** Weathra revokes the session with the identity provider and
 *    then routes to sign-in. It does not clear a cookie itself, mint anything, or keep a second
 *    notion of who is signed in.
 *
 * `redirect` is mocked to throw, which is what Next's own `redirect` does — its return type is
 * `never`. A mock that returned normally would let the layout carry on past the gate in the test
 * while the real one stops, which is exactly the difference that would hide a bug.
 */

import type { User } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SIGN_IN_PATH } from "@/lib/routes";

const currentUser = vi.fn<() => Promise<User | null>>();
const signOutOfSupabase = vi.fn<(options?: { scope?: string }) => Promise<{ error: null }>>();
const redirect = vi.fn((destination: string) => {
  throw new Error(`REDIRECT:${destination}`);
});

vi.mock("@/lib/supabase/server", () => ({
  currentUser: () => currentUser(),
  supabaseServerClient: async () => ({
    auth: { signOut: (options?: { scope?: string }) => signOutOfSupabase(options) },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => redirect(destination),
  usePathname: () => "/",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: ProtectedLayout } = await import("./layout");
const { signOut } = await import("@/lib/auth/sign-out");

function person(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-03T00:00:00.000Z",
    email: "sam@example.test",
    ...overrides,
  } as User;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The shell now carries the session boundary (task 20.9), which builds the API client — so a
  // protected render needs the public configuration a protected render really does need.
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  signOutOfSupabase.mockResolvedValue({ error: null });
});

describe("the protected layout", () => {
  it("resolves the session before rendering anything", async () => {
    currentUser.mockResolvedValue(person());
    await ProtectedLayout({ children: <p>Screen</p> });
    expect(currentUser).toHaveBeenCalledOnce();
  });

  it("renders the shell around the screen for a signed-in person", async () => {
    currentUser.mockResolvedValue(person());
    render(await ProtectedLayout({ children: <p>Screen</p> }));

    expect(screen.getByRole("navigation", { name: "Weathra" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("Screen")).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("identifies the signed-in person from their own session", async () => {
    currentUser.mockResolvedValue(
      person({ email: "ada@example.test", user_metadata: { full_name: "Ada Lovelace" } }),
    );
    render(await ProtectedLayout({ children: <p>Screen</p> }));

    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(within(navigation).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(navigation).getByText("ada@example.test")).toBeInTheDocument();
  });

  it("offers a sign-out control inside the shell", async () => {
    currentUser.mockResolvedValue(person());
    render(await ProtectedLayout({ children: <p>Screen</p> }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("renders no shell at all without a session", async () => {
    currentUser.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <p>Screen</p> })).rejects.toThrow(
      `REDIRECT:${SIGN_IN_PATH}`,
    );
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("does not render protected content and then take it away", async () => {
    // The gate runs before the return, so there is no first paint to flash: an unauthenticated
    // request produces a rejection, never a tree.
    currentUser.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <p>Secret</p> })).rejects.toThrow(/^REDIRECT:/);
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });
});

describe("signing out", () => {
  it("revokes the session with Supabase and routes to sign-in", async () => {
    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);
    expect(signOutOfSupabase).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH);
  });

  it("revokes every refresh token for the account, not only this browser's", async () => {
    // Signing out is what a person does on a shared or a lost machine. A sign-out that left a
    // refresh token alive somewhere else would not be one.
    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);
    expect(signOutOfSupabase).toHaveBeenCalledWith({ scope: "global" });
  });

  it("routes to sign-in even when the identity provider is unreachable", async () => {
    // A person signing out because something is wrong must not be stranded on a protected screen
    // by the thing that is wrong.
    signOutOfSupabase.mockRejectedValue(new Error("gateway unavailable"));
    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH);
  });

  it("clears this browser's session anyway when the provider cannot be told", async () => {
    signOutOfSupabase.mockRejectedValueOnce(new Error("gateway unavailable"));
    signOutOfSupabase.mockResolvedValueOnce({ error: null });

    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);

    expect(signOutOfSupabase).toHaveBeenNthCalledWith(1, { scope: "global" });
    // Still through Supabase, which owns the cookies. Weathra writes no session state of its own.
    expect(signOutOfSupabase).toHaveBeenNthCalledWith(2, { scope: "local" });
  });

  it("exposes nothing of the provider's when both attempts fail", async () => {
    signOutOfSupabase.mockRejectedValue(new Error("gateway unavailable"));

    // The only thing that reaches the person is the sign-in screen.
    await expect(signOut()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`);
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH);
    expect(redirect).toHaveBeenCalledOnce();
  });

  it("leaves no protected shell behind: the next request has no session to render one from", async () => {
    await expect(signOut()).rejects.toThrow(/^REDIRECT:/);

    currentUser.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <p>Secret</p> })).rejects.toThrow(/^REDIRECT:/);
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
