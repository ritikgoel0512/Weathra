/**
 * The Forgot Password screen — half of task 20.8's verification.
 *
 * The requirement that carries the most weight is the one that is invisible when it works: a reset
 * request for an address with an account and one for an address without must be *indistinguishable*.
 * That is asserted here by comparing the rendered result of both, character for character, rather
 * than by checking each against a message — a test that reads the two separately is a test that
 * would still pass if they drifted apart.
 *
 * Supabase is mocked at `lib/supabase/browser`, the seam the locked architecture already defines.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_CONFIRM_PATH } from "@/lib/routes";

import { AuthShell } from "./auth-shell";
import { ForgotPasswordForm } from "./forgot-password-form";

const resetPasswordForEmail = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      resetPasswordForEmail: (email: unknown, options: unknown) =>
        resetPasswordForEmail(email, options),
    },
  }),
}));

const EMAIL = "sam@example.test";

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: null, error };
}

async function request(email = EMAIL) {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the screen", () => {
  it("renders inside the same shell every other authentication screen uses", () => {
    render(
      <AuthShell title="Reset your password" subtitle="We will email you a link.">
        <ForgotPasswordForm />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Reset your password" })).toBeInTheDocument();
  });

  it("asks for an address and offers one primary action", () => {
    render(<ForgotPasswordForm />);

    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    const action = screen.getByRole("button", { name: "Send reset link" });
    expect(action).toHaveAttribute("type", "submit");
    expect(action).toHaveAttribute("data-variant", "primary");
    // No password here, and nothing else to fill in.
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});

describe("requesting a link", () => {
  it("asks Supabase to send it, and nobody else", async () => {
    render(<ForgotPasswordForm />);
    await request();

    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledOnce());
    expect(resetPasswordForEmail).toHaveBeenCalledWith(EMAIL, expect.anything());
  });

  it("points the returning link at the existing callback handler", async () => {
    render(<ForgotPasswordForm />);
    await request();

    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledOnce());
    const [, options] = resetPasswordForEmail.mock.calls[0] as [string, { redirectTo: string }];
    // Task 20.6's handler, named the flow it is completing — one returning-link architecture.
    expect(options.redirectTo).toBe(`${window.location.origin}${AUTH_CONFIRM_PATH}?type=recovery`);
    expect(new URL(options.redirectTo).origin).toBe(window.location.origin);
  });

  it("disables the action and says what is happening while it is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    resetPasswordForEmail.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<ForgotPasswordForm />);
    await request();

    const action = await screen.findByRole("button", { name: "Sending reset link…" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Email")).toBeDisabled();

    release({ data: {}, error: null });
    await screen.findByText("Check your email");
  });

  it("does not issue the request twice", async () => {
    let release: (value: unknown) => void = () => {};
    resetPasswordForEmail.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<ForgotPasswordForm />);
    await request();
    await userEvent.click(await screen.findByRole("button", { name: "Sending reset link…" }));

    expect(resetPasswordForEmail).toHaveBeenCalledOnce();
    release({ data: {}, error: null });
    await screen.findByText("Check your email");
  });

  it("shows the completion state, announced, and offers another address", async () => {
    render(<ForgotPasswordForm />);
    await request();

    const completion = await screen.findByRole("status");
    expect(completion).toHaveTextContent("Check your email");
    expect(completion).toHaveTextContent(/if that address has a Weathra account/i);
    expect(completion).toHaveAttribute("aria-live", "polite");

    const again = screen.getByRole("button", { name: "Use a different address" });
    expect(again).toHaveFocus();
    await userEvent.click(again);
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });
});

describe("what the answer does not reveal", () => {
  it("answers a known and an unknown address identically", async () => {
    // The provider succeeds for an address it has no account for; this covers the configuration
    // where it does not, which is the one that could tell them apart.
    const first = render(<ForgotPasswordForm />);
    await request();
    await screen.findByText("Check your email");
    const known = document.body.textContent;
    first.unmount();

    resetPasswordForEmail.mockResolvedValue(
      refusal({ code: "user_not_found", message: "User not found", status: 404 }),
    );
    render(<ForgotPasswordForm />);
    await request("nobody@example.test");
    await screen.findByText("Check your email");
    const unknown = document.body.textContent;

    expect(unknown).toBe(known);
  });

  it("takes the same time to say it — no provider call is skipped for one and made for the other", async () => {
    resetPasswordForEmail.mockResolvedValue(
      refusal({ code: "user_not_found", message: "User not found", status: 404 }),
    );

    render(<ForgotPasswordForm />);
    await request("nobody@example.test");

    // The request is made for an unknown address exactly as it is for a known one.
    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("echoes nothing about the address back into the completion", async () => {
    render(<ForgotPasswordForm />);
    await request();
    await screen.findByText("Check your email");

    expect(document.body.textContent ?? "").not.toContain(EMAIL);
  });
});

describe("when it cannot be sent", () => {
  it("rejects something that is not an address without troubling the provider", async () => {
    render(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText("Email"), "not-an-address");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });

  it("asks for an address when there is none", async () => {
    render(<ForgotPasswordForm />);
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("says something generic when the provider fails", async () => {
    resetPasswordForEmail.mockResolvedValue(
      refusal({ code: "unexpected_failure", message: "Internal server error", status: 500 }),
    );

    render(<ForgotPasswordForm />);
    await request();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not send a reset link/i);
    expect(alert).not.toHaveTextContent(/internal server error/i);
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  it("says so when the provider is rate limiting, which discloses nothing", async () => {
    resetPasswordForEmail.mockResolvedValue(
      refusal({ code: "over_email_send_rate_limit", message: "rate limited", status: 429 }),
    );

    render(<ForgotPasswordForm />);
    await request();

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many attempts/i);
  });

  it("says something generic when the request never reaches the provider", async () => {
    resetPasswordForEmail.mockRejectedValue(new Error("network down"));

    render(<ForgotPasswordForm />);
    await request();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not send a reset link/i);
    expect(alert).not.toHaveTextContent(/network down/i);
  });
});

describe("what is never written down", () => {
  it("logs neither the address nor the provider's refusal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    resetPasswordForEmail.mockResolvedValue(
      refusal({ code: "user_not_found", message: "User not found", status: 404 }),
    );
    render(<ForgotPasswordForm />);
    await request();
    await screen.findByText("Check your email");

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain(EMAIL);
      expect(written).not.toContain("User not found");
    }
  });
});

describe("accessible semantics", () => {
  it("is a form with an explicitly labelled field and its guidance wired to it", () => {
    const { container } = render(<ForgotPasswordForm />);

    expect(container.querySelector("form")).toBeInTheDocument();
    const field = screen.getByLabelText("Email");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy.split(" ")[0] ?? "")).toHaveTextContent(
      /if it has a Weathra account/i,
    );
  });

  it("reaches its controls from the keyboard and submits without a mouse", async () => {
    render(<ForgotPasswordForm />);

    expect(screen.getByLabelText("Email")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Send reset link" })).toHaveFocus();

    await userEvent.click(screen.getByLabelText("Email"));
    await userEvent.keyboard(`${EMAIL}{Enter}`);
    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledOnce());
  });
});
