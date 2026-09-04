/**
 * `/verify-email` through the page component — task 20.5's route.
 *
 * The form's behaviour is covered in `components/auth/verify-email.test.tsx`. What is only
 * observable here is the page's own contribution, which is entirely about reading a URL that came
 * from outside: the address it will echo back, the destination it will honour, the returning link
 * it will act on, and the refusal it will show instead of a blank form.
 */

import type { User } from "@supabase/supabase-js";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMPLETED_PARAMETER, COMPLETED_VERIFICATION, SIGN_IN_PATH } from "@/lib/routes";

const verifyOtp = vi.fn((_parameters: unknown) =>
  Promise.resolve({ data: { session: null, user: null }, error: null }),
);

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      verifyOtp: (parameters: unknown) => verifyOtp(parameters),
      resend: () => Promise.resolve({ data: {}, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
}));

const currentUser = vi.fn<() => Promise<User | null>>();

vi.mock("@/lib/supabase/server", () => ({
  currentUser: () => currentUser(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

/** A user as Supabase returns one. Confirmed unless the test says otherwise. */
function person(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: "sam@example.test",
    email_confirmed_at: "2026-09-04T00:00:00.000Z",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as User;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue(null);
});

const { default: VerifyEmailPage } = await import("./page");

/** Render the server component the way Next.js calls it: with a promise of search parameters. */
async function renderPage(query: Record<string, string | string[]> = {}) {
  render(await VerifyEmailPage({ searchParams: Promise.resolve(query) }));
}

describe("the verify-email page", () => {
  it("renders the shared shell: the mark, the heading, and the way back to Sign In", async () => {
    await renderPage({ email: "sam@example.test" });

    expect(screen.getByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_PATH);
  });

  it("renders the code entry and the resend", async () => {
    await renderPage({ email: "sam@example.test" });

    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend code" })).toBeInTheDocument();
  });

  it("echoes back the address the flow carried here", async () => {
    await renderPage({ email: "sam@example.test" });
    expect(screen.getByText("sam@example.test")).toBeInTheDocument();
  });

  it("refuses to render a value that is not an address at all", async () => {
    // A query parameter is a query parameter even when it is only being shown back to the person
    // who supplied it.
    await renderPage({ email: "<script>alert(1)</script>" });

    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("script");
  });

  it("acts on a returning verification link", async () => {
    await renderPage({ token_hash: "pkce_abc", type: "signup" });

    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "pkce_abc", type: "signup" }),
    );
  });

  it("will not complete a link asking for anything but email confirmation", async () => {
    verifyOtp.mockClear();
    await renderPage({ token_hash: "pkce_abc", type: "recovery", email: "sam@example.test" });

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
  });

  it("shows the refusal the provider redirected back with, rather than a blank form", async () => {
    await renderPage({
      email: "sam@example.test",
      error: "access_denied",
      error_code: "otp_expired",
      error_description: "Email link is invalid or has expired",
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/verification link has expired/i);
    expect(alert).not.toHaveTextContent(/Email link is invalid/);
  });

  it("reads a repeated parameter as its first occurrence", async () => {
    await renderPage({ email: ["sam@example.test", "attacker@example.test"] });

    expect(screen.getByText("sam@example.test")).toBeInTheDocument();
    expect(screen.queryByText("attacker@example.test")).not.toBeInTheDocument();
  });
});

describe("the returning link's landing", () => {
  it("shows the success state when Supabase confirms the session the callback established", async () => {
    currentUser.mockResolvedValue(person());

    await renderPage({ [COMPLETED_PARAMETER]: COMPLETED_VERIFICATION });

    expect(currentUser).toHaveBeenCalledOnce();
    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Weathra" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not take the marker's word for it when there is no session", async () => {
    // A stale bookmark, or a URL somebody typed. The marker decides nothing on its own.
    await renderPage({ [COMPLETED_PARAMETER]: COMPLETED_VERIFICATION });

    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("does not take it for an address Supabase has not confirmed", async () => {
    currentUser.mockResolvedValue(person({ email_confirmed_at: undefined, confirmed_at: undefined }));

    await renderPage({ [COMPLETED_PARAMETER]: COMPLETED_VERIFICATION, email: "sam@example.test" });

    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
    // The way forward is still there: enter the code, or ask for a new one.
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
  });

  it("resolves no session at all when no callback marker is present", async () => {
    await renderPage({ email: "sam@example.test" });
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("ignores a marker naming a flow this screen does not show", async () => {
    currentUser.mockResolvedValue(person());

    await renderPage({ [COMPLETED_PARAMETER]: "recovery", email: "sam@example.test" });

    expect(currentUser).not.toHaveBeenCalled();
    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
  });
});
