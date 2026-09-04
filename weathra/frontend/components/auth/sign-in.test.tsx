/**
 * The Sign In screen — task 20.7's verification.
 *
 * The three the task names first: a successful sign-in, an *identical* message for an unknown
 * address and a wrong password, and an unverified account routed to verification. Then the ones
 * that are security properties rather than behaviour — the destination honoured only when it is
 * safe, the provider's own error never shown, nothing logged — and the accessible semantics the
 * form is required to have.
 *
 * Supabase is mocked at `lib/supabase/browser`, which is the seam the locked architecture already
 * defines: the test replaces the provider, never the pattern. There is no second sign-in path to
 * test, because there is no second sign-in path.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PROTECTED_PATH, VERIFY_EMAIL_PATH } from "@/lib/routes";

import { AuthShell } from "./auth-shell";
import { SignInForm } from "./sign-in-form";

const signInWithPassword = vi.fn();
const signOutOfSupabase = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: (credentials: unknown) => signInWithPassword(credentials),
      signOut: () => signOutOfSupabase(),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

/** A session, shaped as Supabase returns one. No real token: nothing here needs a real one. */
function session(overrides: { confirmed?: boolean } = {}) {
  return {
    data: {
      session: { access_token: "test-access-token" },
      user: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "sam@example.test",
        email_confirmed_at: overrides.confirmed === false ? null : "2026-09-01T00:00:00.000Z",
      },
    },
    error: null,
  };
}

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { session: null, user: null }, error };
}

async function signIn(email = "sam@example.test", password = "correct-horse-battery") {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  signOutOfSupabase.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the screen", () => {
  it("renders the approved authentication shell around the form", () => {
    render(
      <AuthShell title="Welcome back" subtitle="Agentic weather intelligence.">
        <SignInForm />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByText("Agentic weather intelligence.")).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    // The card is a region named by its own heading.
    expect(screen.getByRole("region", { name: "Welcome back" })).toBeInTheDocument();
  });

  it("asks for an email and a password, and nothing else", () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1); // the password input is not a textbox
  });

  it("offers one primary action", () => {
    render(<SignInForm />);
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toHaveAttribute("type", "submit");
    expect(submit).toHaveAttribute("data-variant", "primary");
  });

  it("routes to password recovery without implementing it here", () => {
    render(<SignInForm />);
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("shows no control it cannot honour", () => {
    render(<SignInForm />);
    // "Remember me" appears in the approved artifact and is recorded as mockup content in
    // docs/design/screens.md §5: the cookie session persists without it, so a checkbox would be
    // a control that does nothing.
    expect(screen.queryByLabelText(/remember me/i)).not.toBeInTheDocument();
  });
});

describe("the fields", () => {
  it("carries the autocomplete attributes a password manager needs", () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  it("hides the password until asked, and says which way the control moves it", async () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("does not submit the form when the password is revealed", async () => {
    render(<SignInForm />);
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("names a missing field and does not call the provider", async () => {
    render(<SignInForm />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Enter your password.");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("marks an empty field invalid", async () => {
    render(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "sam@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("treats whitespace as no address", async () => {
    render(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "   ");
    await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("a successful sign-in", () => {
  it("signs in through Supabase with the submitted credentials", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm />);
    await signIn();

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledOnce());
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "sam@example.test",
      password: "correct-horse-battery",
    });
  });

  it("reaches the protected area and refreshes so the server sees the session", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("trims the address before sending it", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm />);
    await signIn("  sam@example.test  ");

    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "sam@example.test",
        password: "correct-horse-battery",
      }),
    );
  });
});

describe("the preserved destination", () => {
  it("returns the person to where they were going", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm destination="/evidence/run-1" />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/evidence/run-1"));
  });

  it("falls back to the protected entry route when there is none", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm destination={null} />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
  });

  it.each([
    ["another origin", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash-escaped path", "/\\evil.example"],
    ["a scheme", "javascript:alert(1)"],
    ["a bare word", "evil.example"],
  ])("refuses %s and goes to the protected entry route instead", async (_case, unsafe) => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm destination={unsafe} />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
    expect(replace).not.toHaveBeenCalledWith(unsafe);
  });
});

describe("a failed sign-in", () => {
  const UNKNOWN_EMAIL = { code: "invalid_credentials", message: "Invalid login credentials" };
  const WRONG_PASSWORD = { code: "invalid_credentials", message: "Invalid login credentials" };

  it("says the same thing for an unknown address and a wrong password", async () => {
    signInWithPassword.mockResolvedValue(refusal(UNKNOWN_EMAIL));
    const { unmount } = render(<SignInForm />);
    await signIn("nobody@example.test");
    const forUnknown = (await screen.findByRole("alert")).textContent;
    unmount();

    signInWithPassword.mockResolvedValue(refusal(WRONG_PASSWORD));
    render(<SignInForm />);
    await signIn("sam@example.test", "wrong-password");
    const forWrongPassword = (await screen.findByRole("alert")).textContent;

    expect(forUnknown).toBe(forWrongPassword);
    expect(forUnknown).toMatch(/could not sign you in/i);
  });

  it("does not say which half was wrong", async () => {
    signInWithPassword.mockResolvedValue(refusal(WRONG_PASSWORD));
    render(<SignInForm />);
    await signIn();

    const message = (await screen.findByRole("alert")).textContent ?? "";
    expect(message).not.toMatch(/no account|not found|unknown|does not exist|incorrect password/i);
  });

  it("never shows the provider's own message", async () => {
    signInWithPassword.mockResolvedValue(
      refusal({ code: "invalid_credentials", message: "Invalid login credentials" }),
    );
    render(<SignInForm />);
    await signIn();

    await screen.findByRole("alert");
    expect(screen.queryByText(/Invalid login credentials/)).not.toBeInTheDocument();
    expect(screen.queryByText(/supabase/i)).not.toBeInTheDocument();
  });

  it("stays on the screen and lets them try again", async () => {
    signInWithPassword.mockResolvedValue(refusal(WRONG_PASSWORD));
    render(<SignInForm />);
    await signIn();

    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("distinguishes a rate limit, which discloses nothing about the account", async () => {
    signInWithPassword.mockResolvedValue(
      refusal({ code: "over_request_rate_limit", status: 429, message: "Too many requests" }),
    );
    render(<SignInForm />);
    await signIn();

    expect((await screen.findByRole("alert")).textContent).toMatch(/too many attempts/i);
  });

  it("shows the same generic failure when the request itself fails", async () => {
    signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignInForm />);
    await signIn();

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not sign you in/i);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it("announces the failure to a screen reader", async () => {
    signInWithPassword.mockResolvedValue(refusal(WRONG_PASSWORD));
    render(<SignInForm />);
    await signIn();
    // `role="alert"` is an assertive live region: it is read without the person going looking.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("an unverified account", () => {
  it("is sent to the verification step rather than signed in", async () => {
    signInWithPassword.mockResolvedValue(
      refusal({ code: "email_not_confirmed", message: "Email not confirmed" }),
    );
    render(<SignInForm />);
    await signIn();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `${VERIFY_EMAIL_PATH}?email=${encodeURIComponent("sam@example.test")}`,
      ),
    );
    expect(replace).not.toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
  });

  it("is not shown a generic failure", async () => {
    signInWithPassword.mockResolvedValue(
      refusal({ code: "email_not_confirmed", message: "Email not confirmed" }),
    );
    render(<SignInForm />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is recognised from the message when the provider sends no code", async () => {
    signInWithPassword.mockResolvedValue(refusal({ message: "Email not confirmed" }));
    render(<SignInForm />);
    await signIn();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining(VERIFY_EMAIL_PATH)));
  });

  it("has any session it was somehow given discarded rather than used", async () => {
    // Defence in depth: with confirmation required the provider refuses, so this should be
    // unreachable — and if it ever is reached, an unconfirmed address must not hold a session.
    signInWithPassword.mockResolvedValue(session({ confirmed: false }));
    render(<SignInForm />);
    await signIn();

    await waitFor(() => expect(signOutOfSupabase).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith(expect.stringContaining(VERIFY_EMAIL_PATH));
    expect(replace).not.toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("while the request is in flight", () => {
  it("disables the action and says what is happening", async () => {
    let release: (value: unknown) => void = () => {};
    signInWithPassword.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<SignInForm />);
    await signIn();

    const submit = await screen.findByRole("button", { name: "Signing in…" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    release(session());
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it("does not issue the request twice", async () => {
    let release: (value: unknown) => void = () => {};
    signInWithPassword.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<SignInForm />);
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Signing in…" }));

    expect(signInWithPassword).toHaveBeenCalledOnce();
    release(session());
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });
});

describe("what is never written down", () => {
  it("logs neither the password nor the session", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm />);
    await signIn();
    await waitFor(() => expect(replace).toHaveBeenCalled());

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain("correct-horse-battery");
      expect(written).not.toContain("test-access-token");
    }
  });

  it("keeps the password out of the rendered page, including out of the failure message", async () => {
    signInWithPassword.mockResolvedValue(
      refusal({ code: "invalid_credentials", message: "Invalid login credentials" }),
    );
    render(<SignInForm />);
    await signIn();

    await screen.findByRole("alert");
    // Masked in the field, and echoed nowhere: a failure message assembled from the submission is
    // how a password ends up in a screenshot or a bug report.
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(document.body.textContent ?? "").not.toContain("correct-horse-battery");
  });
});

describe("keyboard operation", () => {
  it("reaches every control in order", async () => {
    render(<SignInForm />);

    // The email field takes focus on arrival, so a person can start typing immediately.
    expect(screen.getByLabelText("Email")).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Show password" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveFocus();
  });

  it("submits from the keyboard alone", async () => {
    signInWithPassword.mockResolvedValue(session());
    render(<SignInForm />);

    await userEvent.type(screen.getByLabelText("Email"), "sam@example.test");
    await userEvent.tab();
    await userEvent.keyboard("correct-horse-battery{Enter}");

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledOnce());
  });
});
