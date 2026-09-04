/**
 * The Create Account screen — task 20.4's verification.
 *
 * The three the task names: a successful submission, a password failing the rules *with the rule
 * named*, and the already-registered case not confirming existence. Then mandatory verification —
 * which is the one that would be a security bug rather than a defect if it broke — and the
 * accessible semantics.
 *
 * Supabase is mocked at `lib/supabase/browser`, the seam the locked architecture already defines.
 * The test replaces the provider, never the pattern: there is no second signup path to cover
 * because there is no second signup path.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PROTECTED_PATH, VERIFY_EMAIL_PATH } from "@/lib/routes";

import { AuthShell } from "./auth-shell";
import { CreateAccountForm } from "./create-account-form";

const signUp = vi.fn();
const signOutOfSupabase = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      signUp: (credentials: unknown) => signUp(credentials),
      signOut: () => signOutOfSupabase(),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const EMAIL = "sam@example.test";
const PASSWORD = "correct-horse-battery-staple";

/** What `signUp` returns with confirmations required: a user, and deliberately no session. */
function created() {
  return {
    data: {
      user: { id: "00000000-0000-0000-0000-000000000001", email: EMAIL, identities: [] },
      session: null,
    },
    error: null,
  };
}

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { user: null, session: null }, error };
}

async function fill(email = EMAIL, password = PASSWORD) {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
}

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

const VERIFICATION_DESTINATION = `${VERIFY_EMAIL_PATH}?email=${encodeURIComponent(EMAIL)}`;

beforeEach(() => {
  vi.clearAllMocks();
  signOutOfSupabase.mockResolvedValue({ error: null });
  signUp.mockResolvedValue(created());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the screen", () => {
  it("renders inside the same shell Sign In uses", () => {
    render(
      <AuthShell title="Create your account" subtitle="Agentic weather intelligence.">
        <CreateAccountForm />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Create your account" })).toBeInTheDocument();
  });

  it("asks for an address and a password, and nothing else", () => {
    render(<CreateAccountForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();

    // No name, no company, no marketing consent, and no confirm-password field: the specs ask for
    // an address and a password, the artifact shows two fields, and the visibility control is what
    // lets a person check what they typed.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText(/confirm/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/name|company|organisation|organization/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("offers one primary action", () => {
    render(<CreateAccountForm />);
    const submitButton = screen.getByRole("button", { name: "Create account" });
    expect(submitButton).toHaveAttribute("type", "submit");
    expect(submitButton).toHaveAttribute("data-variant", "primary");
  });

  it("asks the browser to offer a new password rather than a saved one", () => {
    render(<CreateAccountForm />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("hides the password until asked, and names which way the control moves it", async () => {
    render(<CreateAccountForm />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(signUp).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });
});

describe("the password rules", () => {
  it("states every rule before anything is submitted", () => {
    render(<CreateAccountForm />);
    const rules = screen.getByRole("list", { name: "Password requirements" });

    expect(within(rules).getByText("At least 12 characters")).toBeInTheDocument();
    expect(within(rules).getByText("No more than 72 characters")).toBeInTheDocument();
    expect(within(rules).getByText("Not your email address")).toBeInTheDocument();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("marks a rule met as it is met, in words as well as in colour", async () => {
    render(<CreateAccountForm />);
    const rules = screen.getByRole("list", { name: "Password requirements" });

    const lengthRule = () => within(rules).getByText("At least 12 characters").closest("li");
    expect(lengthRule()).not.toHaveAttribute("data-met");
    expect(lengthRule()).toHaveTextContent("not met yet");

    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    expect(lengthRule()).toHaveAttribute("data-met", "true");
    expect(lengthRule()).toHaveTextContent("met");
  });

  it("marks the address rule unmet once the password contains the address", async () => {
    render(<CreateAccountForm />);
    await userEvent.type(screen.getByLabelText("Email"), "samantha@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "samantha-and-more");

    const rules = screen.getByRole("list", { name: "Password requirements" });
    const addressRule = within(rules).getByText("Not your email address").closest("li");
    expect(addressRule).not.toHaveAttribute("data-met");
  });
});

describe("validation before submission", () => {
  it("names the rule a password failed, and creates no account", async () => {
    render(<CreateAccountForm />);
    await fill(EMAIL, "too-short");
    await submit();

    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      expect.stringContaining("At least 12 characters"),
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(signUp).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("names the address rule when that is the one that failed", async () => {
    render(<CreateAccountForm />);
    await fill("samantha@example.test", "samantha-and-more-here");
    await submit();

    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      expect.stringContaining("Not your email address"),
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it("asks for a missing address and a missing password", async () => {
    render(<CreateAccountForm />);
    await submit();

    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
      expect.stringContaining("Enter your email address."),
    );
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      expect.stringContaining("Choose a password."),
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it("refuses something that is not an address", async () => {
    render(<CreateAccountForm />);
    await fill("not-an-address", PASSWORD);
    await submit();

    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
      expect.stringContaining("Enter a valid email address."),
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it("accepts an address it has no business second-guessing", async () => {
    render(<CreateAccountForm />);
    await fill("sam+weather@sub.example.test", PASSWORD);
    await submit();

    await waitFor(() => expect(signUp).toHaveBeenCalledOnce());
  });
});

describe("a successful submission", () => {
  it("creates the account through Supabase with what was submitted", async () => {
    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(signUp).toHaveBeenCalledOnce());
    expect(signUp).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });

  it("trims the address before sending it", async () => {
    render(<CreateAccountForm />);
    await fill(`  ${EMAIL}  `, PASSWORD);
    await submit();

    await waitFor(() => expect(signUp).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD }));
  });
});

describe("mandatory verification", () => {
  it("sends the person to verify their email, not into the product", async () => {
    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(VERIFICATION_DESTINATION));
    expect(replace).not.toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
    // Nothing to refresh: `signUp` with confirmations required returns no session.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("discards a session if the provider ever returns one", async () => {
    // A project with confirmations switched off. Weathra does not use the session either way —
    // an unverified account holding one would be the verification requirement bypassed.
    signUp.mockResolvedValue({
      data: { user: { id: "1", email: EMAIL }, session: { access_token: "test-access-token" } },
      error: null,
    });

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(signOutOfSupabase).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith(VERIFICATION_DESTINATION);
    expect(replace).not.toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
  });

  it("marks nobody verified locally and stores nothing", async () => {
    render(<CreateAccountForm />);
    await fill();
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalled());

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("an address that already has an account", () => {
  it("gets the response a new address gets", async () => {
    // The look-alike response recent provider versions return with confirmations on: a user
    // object with no identities and no session. Indistinguishable by construction.
    signUp.mockResolvedValue({
      data: { user: { id: "1", email: EMAIL, identities: [] }, session: null },
      error: null,
    });

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(VERIFICATION_DESTINATION));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not confirm existence even when the provider says so outright", async () => {
    signUp.mockResolvedValue(
      refusal({ code: "user_already_exists", message: "User already registered" }),
    );

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(VERIFICATION_DESTINATION));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/already/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/taken|exists|registered/i)).not.toBeInTheDocument();
  });

  it("is recognised from the message when the provider sends no code", async () => {
    signUp.mockResolvedValue(refusal({ message: "User already registered" }));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(VERIFICATION_DESTINATION));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a failed submission", () => {
  it("shows a generic failure and stays on the screen", async () => {
    signUp.mockResolvedValue(refusal({ code: "unexpected_failure", message: "Database error" }));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not create your account/i);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("never shows the provider's own message", async () => {
    signUp.mockResolvedValue(refusal({ code: "unexpected_failure", message: "Database error saving new user" }));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await screen.findByRole("alert");
    expect(screen.queryByText(/Database error/)).not.toBeInTheDocument();
    expect(screen.queryByText(/supabase/i)).not.toBeInTheDocument();
  });

  it("distinguishes a rate limit, which discloses nothing about the address", async () => {
    signUp.mockResolvedValue(
      refusal({ code: "over_request_rate_limit", status: 429, message: "Email rate limit exceeded" }),
    );

    render(<CreateAccountForm />);
    await fill();
    await submit();

    expect((await screen.findByRole("alert")).textContent).toMatch(/too many attempts/i);
  });

  it("answers a provider password rejection with Weathra's own stated rule", async () => {
    // Only reachable when the project's policy is stricter than the rules this screen stated,
    // which is a configuration mismatch rather than something the person did wrong.
    signUp.mockResolvedValue(
      refusal({ code: "weak_password", message: "Password should contain at least one symbol" }),
    );

    render(<CreateAccountForm />);
    await fill();
    await submit();

    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
        expect.stringContaining("at least 12 characters"),
      ),
    );
    expect(screen.queryByText(/symbol/i)).not.toBeInTheDocument();
  });

  it("shows the same generic failure when the request itself fails", async () => {
    signUp.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not create your account/i);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it("announces the failure to a screen reader", async () => {
    signUp.mockResolvedValue(refusal({ code: "unexpected_failure", message: "Database error" }));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("while the request is in flight", () => {
  it("disables the action and says what is happening", async () => {
    let release: (value: unknown) => void = () => {};
    signUp.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<CreateAccountForm />);
    await fill();
    await submit();

    const submitButton = await screen.findByRole("button", { name: "Creating your account…" });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    release(created());
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it("does not create the account twice", async () => {
    let release: (value: unknown) => void = () => {};
    signUp.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<CreateAccountForm />);
    await fill();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Creating your account…" }));

    expect(signUp).toHaveBeenCalledOnce();
    release(created());
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });
});

describe("what is never written down", () => {
  it("logs neither the password nor anything the provider returned", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    signUp.mockResolvedValue(refusal({ code: "unexpected_failure", message: "Database error" }));
    render(<CreateAccountForm />);
    await fill();
    await submit();
    await screen.findByRole("alert");

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain(PASSWORD);
      expect(written).not.toContain("Database error");
    }
  });

  it("keeps the password out of the rendered page, including out of a failure message", async () => {
    signUp.mockResolvedValue(refusal({ code: "unexpected_failure", message: "Database error" }));
    render(<CreateAccountForm />);
    await fill();
    await submit();
    await screen.findByRole("alert");

    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(document.body.textContent ?? "").not.toContain(PASSWORD);
  });
});

describe("keyboard operation", () => {
  it("reaches every control in order", async () => {
    render(<CreateAccountForm />);

    expect(screen.getByLabelText("Email")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Show password" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Create account" })).toHaveFocus();
  });

  it("submits from the keyboard alone", async () => {
    render(<CreateAccountForm />);

    await userEvent.type(screen.getByLabelText("Email"), EMAIL);
    await userEvent.tab();
    await userEvent.keyboard(`${PASSWORD}{Enter}`);

    await waitFor(() => expect(signUp).toHaveBeenCalledOnce());
  });
});
