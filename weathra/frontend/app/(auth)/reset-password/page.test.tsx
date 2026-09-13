/**
 * `/reset-password` through the page component — task 20.8's recovery gate.
 *
 * This is where the security property of the screen lives: **a password can be changed only when
 * Supabase says there is a session to change it for.** The page resolves that against the provider
 * before rendering, so these tests are about which of two things gets rendered — the form, or the
 * state that says the reset can no longer be completed — and never about the form's behaviour,
 * which is covered in `components/auth/reset-password.test.tsx`.
 *
 * The other half is that a URL grants nothing: a marker saying a recovery completed, an `error` the
 * provider reported, and an address in the query string are all read, and none of them produces a
 * form on its own.
 */

import type { User } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMPLETED_PARAMETER, COMPLETED_RECOVERY, SIGN_IN_PATH } from "@/lib/routes";

const currentUser = vi.fn<() => Promise<User | null>>();
const updateUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  currentUser: () => currentUser(),
}));

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: { updateUser: (attributes: unknown) => updateUser(attributes) },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const { default: ResetPasswordPage } = await import("./page");

const EMAIL = "sam@example.test";

function person(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: EMAIL,
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as User;
}

async function renderPage(query: Record<string, string | string[]> = {}) {
  render(await ResetPasswordPage({ searchParams: Promise.resolve(query) }));
}

const RECOVERED = { [COMPLETED_PARAMETER]: COMPLETED_RECOVERY };

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue(null);
  updateUser.mockResolvedValue({ data: { user: person() }, error: null });
});

describe("with a recovery session Supabase confirms", () => {
  beforeEach(() => {
    currentUser.mockResolvedValue(person());
  });

  it("renders the shared shell and the form", async () => {
    await renderPage(RECOVERED);

    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_PATH);
  });

  it("asks Supabase who the session belongs to rather than reading the URL", async () => {
    // The address the rules are checked against comes from the session, and an address supplied in
    // the query string is not it.
    await renderPage({ ...RECOVERED, email: "someone-else@example.test" });

    expect(currentUser).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByLabelText("New password"), "sam-and-more-characters");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "sam-and-more-characters");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(
      await screen.findByText(/Not your email address\. Your password does not meet this rule yet\./),
    ).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("states the rules on arrival", async () => {
    await renderPage(RECOVERED);
    const rules = screen.getByRole("list", { name: "Password requirements" });
    expect(rules.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
  });
});

describe("without one", () => {
  /*
   * No session is no longer a dead end.
   *
   * Supabase's recovery template decides whether the email carries a link or a six-digit code, and
   * under a code-only template no link ever arrives to create a session — so insisting on one made
   * recovery impossible to finish. The password form still requires the session; what changed is
   * that the screen now offers the other door to it rather than closing.
   */
  it("offers the code entry rather than the password form when there is no session", async () => {
    await renderPage(RECOVERED);

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reset code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("offers the code entry for a bare visit carrying nothing", async () => {
    await renderPage();

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reset code")).toBeInTheDocument();
    // Nothing to send a new code to, so it says which address it needs rather than echoing one.
    expect(screen.getByText(/which account to reset/i)).toBeInTheDocument();
  });

  it("still states a refused link, above the code entry rather than instead of it", async () => {
    // A link that expired and a code that still works arrive in the same email.
    await renderPage({ error: "access_denied", error_code: "otp_expired" });

    expect(screen.getByRole("alert")).toHaveTextContent(/expired/i);
    expect(screen.getByLabelText("Reset code")).toBeInTheDocument();
  });

  it("does not take a marker as authorization", async () => {
    // The marker's only power is over the route gate. It grants nothing here.
    await renderPage({ [COMPLETED_PARAMETER]: COMPLETED_RECOVERY, recovered: "true", authorized: "1" });

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
  });

  it("reports an expired link as expired, without asking for a session it knows is gone", async () => {
    currentUser.mockResolvedValue(person());

    await renderPage({ error: "access_denied", error_code: "otp_expired" });

    expect(currentUser).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/that reset link has expired/i);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("reports a link refused for any other reason as no longer valid", async () => {
    currentUser.mockResolvedValue(person());

    await renderPage({ error: "access_denied", error_code: "invalid_link" });

    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("renders no provider wording from the URL", async () => {
    await renderPage({
      error: "access_denied",
      error_code: "otp_expired",
      error_description: "Email link is invalid or has expired",
    });

    expect(document.body.textContent ?? "").not.toContain("Email link is invalid");
    expect(document.body.textContent ?? "").not.toContain("otp_expired");
  });
});
