/**
 * The Verify Email screen — task 20.5's verification.
 *
 * The states the task names, each as its own test: the default screen, verification in progress,
 * success, an incorrect code, an expired code, the three resend states, and the returning link in
 * both its good and its refused form. Then the ones that are security properties rather than
 * behaviour — nothing marked verified locally, no navigation before the provider confirms a
 * session, the provider's own words never shown, nothing logged — and the accessible semantics.
 *
 * Supabase is mocked at `lib/supabase/browser`, the seam the locked architecture already defines.
 * The test replaces the provider, never the pattern: there is no second verification path to cover,
 * because there is no verification mechanism outside the provider's.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VERIFICATION_CODE_LIFETIME_MS } from "@/lib/auth/verification";
import { CREATE_ACCOUNT_PATH, DEFAULT_PROTECTED_PATH } from "@/lib/routes";

import { AuthShell } from "./auth-shell";
import { VerifyEmailForm } from "./verify-email-form";

const verifyOtp = vi.fn();
const resend = vi.fn();
const signOutOfSupabase = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      verifyOtp: (parameters: unknown) => verifyOtp(parameters),
      resend: (parameters: unknown) => resend(parameters),
      signOut: () => signOutOfSupabase(),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const EMAIL = "sam@example.test";
const CODE = "123456";
const TOKEN_HASH = "pkce_0123456789abcdef";

/** What `verifyOtp` returns on success: a session, and a user the provider has confirmed. */
function verified(overrides: { confirmed?: boolean; session?: boolean } = {}) {
  return {
    data: {
      session: overrides.session === false ? null : { access_token: "test-access-token" },
      user: {
        id: "00000000-0000-0000-0000-000000000001",
        email: EMAIL,
        email_confirmed_at: overrides.confirmed === false ? null : "2026-09-04T00:00:00.000Z",
      },
    },
    error: null,
  };
}

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { session: null, user: null }, error };
}

/** A deferred provider response, for the states that only exist while a request is in flight. */
function deferred() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release: (value: unknown) => release(value) };
}

async function enterCode(code = CODE) {
  await userEvent.type(screen.getByLabelText("Verification code"), code);
}

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: "Verify email" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  verifyOtp.mockResolvedValue(verified());
  resend.mockResolvedValue({ data: {}, error: null });
  signOutOfSupabase.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the default state", () => {
  it("renders inside the same shell Sign In and Create Account use", () => {
    render(
      <AuthShell title="Verify your email" subtitle="One more step.">
        <VerifyEmailForm email={EMAIL} />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Verify your email" })).toBeInTheDocument();
  });

  it("says a code was sent, and to which address", () => {
    render(<VerifyEmailForm email={EMAIL} />);
    expect(screen.getByText(/we sent a 6-digit verification code to/i)).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it("offers code entry, a verify action, and a resend", () => {
    render(<VerifyEmailForm email={EMAIL} />);

    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
    const verify = screen.getByRole("button", { name: "Verify email" });
    expect(verify).toHaveAttribute("type", "submit");
    expect(verify).toHaveAttribute("data-variant", "primary");
    expect(screen.getByRole("button", { name: "Resend code" })).toBeInTheDocument();
  });

  it("offers the way back to a different address", () => {
    render(<VerifyEmailForm email={EMAIL} />);
    expect(screen.getByRole("link", { name: "Use a different email address" })).toHaveAttribute(
      "href",
      CREATE_ACCOUNT_PATH,
    );
  });

  it("asks for nothing else — no password, and no second address", () => {
    render(<VerifyEmailForm email={EMAIL} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("shows no address it was not given, and asks the person to start again", () => {
    render(<VerifyEmailForm email={null} />);

    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(screen.getByText(/we don’t know which address to verify/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Use a different email address" })).toBeInTheDocument();
  });
});

describe("code entry", () => {
  it("keeps the six digits out of a pasted code and drops everything else", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.type(screen.getByLabelText("Verification code"), "Code: 12 34-56 789");
    expect(screen.getByLabelText("Verification code")).toHaveValue("123456");
  });

  it("names the rule rather than troubling the provider with a short code", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode("123");
    await submit();

    expect(await screen.findByText(/the code is 6 digits/i)).toBeInTheDocument();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("submits the code to Supabase and nothing else", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    await waitFor(() => expect(verifyOtp).toHaveBeenCalledOnce());
    expect(verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: CODE, type: "signup" });
  });
});

describe("verification in progress", () => {
  it("disables the conflicting actions and says what is happening", async () => {
    const pending = deferred();
    verifyOtp.mockReturnValue(pending.promise);

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    const verify = await screen.findByRole("button", { name: "Verifying…" });
    expect(verify).toBeDisabled();
    expect(verify).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Verification code")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resend code" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying your code…");

    pending.release(verified());
    await screen.findByText("Email verified");
  });

  it("does not submit the same code twice", async () => {
    const pending = deferred();
    verifyOtp.mockReturnValue(pending.promise);

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Verifying…" }));

    expect(verifyOtp).toHaveBeenCalledOnce();
    pending.release(verified());
    await screen.findByText("Email verified");
  });
});

describe("verification successful", () => {
  it("shows the success state before going anywhere", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    // Announced, and the destination is offered rather than taken.
    expect(screen.getByRole("status")).toHaveTextContent("Email verified");
    expect(replace).not.toHaveBeenCalled();
  });

  it("routes into the product when the person continues", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    await userEvent.click(await screen.findByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
    // The session now exists in cookies; this is what makes the server see it.
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("honours a safe destination and refuses an unsafe one", async () => {
    const { unmount } = render(<VerifyEmailForm email={EMAIL} destination="/historical" />);
    await enterCode();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith("/historical");
    unmount();

    replace.mockClear();
    render(<VerifyEmailForm email={EMAIL} destination="//evil.example" />);
    await enterCode();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
  });

  it("treats an outcome without a session as unverified rather than as success", async () => {
    verifyOtp.mockResolvedValue(verified({ session: false }));

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not verify your email/i);
    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("discards a session for an address the provider has not confirmed", async () => {
    // Defence in depth: verification is a fact held by Supabase, and a session without it is not
    // one Weathra will use.
    verifyOtp.mockResolvedValue(verified({ confirmed: false }));

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    await waitFor(() => expect(signOutOfSupabase).toHaveBeenCalledOnce());
    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("an incorrect code", () => {
  it("says the code is wrong, and leaves the entry ready for another try", async () => {
    verifyOtp.mockResolvedValue(
      refusal({ code: "otp_expired", message: "Token has expired or is invalid", status: 403 }),
    );

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/that code is not right/i);
    expect(alert).not.toHaveTextContent(/expired/i);
    expect(screen.getByLabelText("Verification code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Verify email" })).toBeEnabled();
  });

  it("says the same for a refusal that is not about expiry at all", async () => {
    verifyOtp.mockResolvedValue(
      refusal({ code: "validation_failed", message: "Invalid token", status: 422 }),
    );

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/that code is not right/i);
  });
});

describe("an expired code", () => {
  it("explains the expiry, distinguishably from an incorrect code, and offers a resend", async () => {
    verifyOtp.mockResolvedValue(
      refusal({ code: "otp_expired", message: "Token has expired or is invalid", status: 403 }),
    );

    render(
      <VerifyEmailForm
        email={EMAIL}
        codeSentAt={Date.now() - VERIFICATION_CODE_LIFETIME_MS - 1_000}
      />,
    );
    await enterCode();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/that code has expired/i);
    expect(alert).not.toHaveTextContent(/not right/i);
    expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
  });
});

describe("resending", () => {
  it("shows the in-progress state and disables the conflicting actions", async () => {
    const pending = deferred();
    resend.mockReturnValue(pending.promise);

    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    const resendButton = await screen.findByRole("button", { name: "Sending…" });
    expect(resendButton).toBeDisabled();
    expect(resendButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Verify email" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Sending a new code…");

    pending.release({ data: {}, error: null });
    await screen.findByRole("button", { name: "Resend code" });
  });

  it("confirms the new code without confirming that an account exists", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/a new code is on its way/i),
    );
    expect(resend).toHaveBeenCalledWith({ type: "signup", email: EMAIL });
    // The old code is no longer the one to enter.
    expect(screen.getByLabelText("Verification code")).toHaveValue("");
  });

  it("states how long to wait when the provider refuses for rate limiting", async () => {
    resend.mockResolvedValue({
      data: {},
      error: {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "For security purposes, you can only request this after 55 seconds.",
      },
    });

    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You can ask for a new code in 55 seconds.");
    // The wait is stated in Weathra's words; the provider's are not shown.
    expect(alert).not.toHaveTextContent(/security purposes/i);
  });

  it("still states a wait when the provider does not say how long", async () => {
    resend.mockResolvedValue({
      data: {},
      error: { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" },
    });

    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/wait a moment/i);
  });

  it("says something generic when the provider fails for any other reason", async () => {
    resend.mockResolvedValue({
      data: {},
      error: { status: 500, code: "unexpected_failure", message: "Internal server error" },
    });

    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not send a new code/i);
    expect(alert).not.toHaveTextContent(/internal server error/i);
  });

  it("says something generic when the request never reaches the provider", async () => {
    resend.mockRejectedValue(new Error("network down"));

    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend code" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not send a new code/i);
    expect(alert).not.toHaveTextContent(/network down/i);
  });
});

describe("the returning verification link", () => {
  const link = { tokenHash: TOKEN_HASH, type: "signup" as const };

  it("completes verification without any further entry", async () => {
    render(<VerifyEmailForm email={EMAIL} link={link} />);

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "signup" });
    // Nothing was typed: the token came in the URL.
    expect(verifyOtp).toHaveBeenCalledOnce();
  });

  it("announces that it is completing the link while it is in flight", async () => {
    const pending = deferred();
    verifyOtp.mockReturnValue(pending.promise);

    render(<VerifyEmailForm email={EMAIL} link={link} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/completing verification/i),
    );
    expect(screen.getByRole("button", { name: "Verify email" })).toBeDisabled();

    pending.release(verified());
    await screen.findByText("Email verified");
  });

  it("reports an expired link and leaves the code entry as the way forward", async () => {
    verifyOtp.mockResolvedValue(
      refusal({ code: "otp_expired", message: "Token has expired or is invalid", status: 403 }),
    );

    render(<VerifyEmailForm email={EMAIL} link={link} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/verification link has expired/i);
    expect(screen.getByLabelText("Verification code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("reports a link the provider refuses for any other reason as no longer valid", async () => {
    verifyOtp.mockResolvedValue(refusal({ code: "bad_jwt", message: "invalid claim", status: 401 }));

    render(<VerifyEmailForm email={EMAIL} link={link} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("never treats a link outcome without a confirmed session as verified", async () => {
    verifyOtp.mockResolvedValue(verified({ confirmed: false }));

    render(<VerifyEmailForm email={EMAIL} link={link} />);

    await waitFor(() => expect(signOutOfSupabase).toHaveBeenCalledOnce());
    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("opens in the one success state when the server has already confirmed the completion", async () => {
    // Task 20.6's handler completes the link server-side; the screen does not verify a second time,
    // and there is no second success state for it to show.
    render(<VerifyEmailForm email={EMAIL} confirmed />);

    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(verifyOtp).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows the refusal the provider reported by redirecting back with it", () => {
    render(<VerifyEmailForm email={EMAIL} linkRefusal="expired" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/verification link has expired/i);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("reads a refusal the provider put in the URL fragment, which no server can see", async () => {
    window.location.hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

    render(<VerifyEmailForm email={EMAIL} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/verification link has expired/i);
    // The provider's own description is in the URL; it is not what the screen says.
    expect(document.body.textContent ?? "").not.toContain("Email link is invalid");
  });
});

describe("what is never written down", () => {
  it("logs neither the code, the link token, nor the session", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<VerifyEmailForm email={EMAIL} link={{ tokenHash: TOKEN_HASH, type: "signup" }} />);
    await screen.findByText("Email verified");

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain(TOKEN_HASH);
      expect(written).not.toContain("test-access-token");
      expect(written).not.toContain(CODE);
    }
  });

  it("shows no provider wording, status code, or error identifier", async () => {
    verifyOtp.mockResolvedValue(
      refusal({ code: "otp_expired", message: "Token has expired or is invalid", status: 403 }),
    );

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();
    await screen.findByRole("alert");

    const shown = document.body.textContent ?? "";
    for (const leak of ["otp_expired", "Token has expired or is invalid", "403", "supabase"]) {
      expect(shown.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("accessible semantics", () => {
  it("is a form with an explicitly labelled code field", () => {
    const { container } = render(<VerifyEmailForm email={EMAIL} />);

    expect(container.querySelector("form")).toBeInTheDocument();
    const field = screen.getByLabelText("Verification code");
    expect(field.tagName).toBe("INPUT");
    // The label is a real one, wired by `for`/`id` rather than sitting next to the control.
    expect(field).toHaveAttribute("id");
  });

  it("asks the browser for a numeric keypad and the one-time-code autofill", () => {
    render(<VerifyEmailForm email={EMAIL} />);
    const field = screen.getByLabelText("Verification code");
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    expect(field).toHaveAttribute("maxlength", "6");
  });

  it("states the rule before submission rather than revealing it by rejection", () => {
    render(<VerifyEmailForm email={EMAIL} />);
    const field = screen.getByLabelText("Verification code");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy.split(" ")[0] ?? "")).toHaveTextContent(
      /enter the 6-digit code/i,
    );
  });

  it("marks the field invalid, and wires the message to it, when the code is refused", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode("12");
    await submit();

    const field = await screen.findByLabelText("Verification code");
    expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ").length).toBeGreaterThan(1);
  });

  it("announces progress politely and failures assertively", async () => {
    const pending = deferred();
    verifyOtp.mockReturnValue(pending.promise);

    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    const live = await screen.findByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");

    pending.release(refusal({ code: "validation_failed", message: "Invalid token", status: 422 }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("reaches every control from the keyboard, in order", async () => {
    render(<VerifyEmailForm email={EMAIL} />);

    // The code field takes focus on arrival, so a person can start typing immediately.
    expect(screen.getByLabelText("Verification code")).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Verify email" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Resend code" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Use a different email address" })).toHaveFocus();
  });

  it("submits from the keyboard alone", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await userEvent.keyboard(`${CODE}{Enter}`);
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledOnce());
  });

  it("puts focus on the way forward once verification succeeds", async () => {
    render(<VerifyEmailForm email={EMAIL} />);
    await enterCode();
    await submit();

    expect(await screen.findByRole("button", { name: "Continue to Weathra" })).toHaveFocus();
  });
});
