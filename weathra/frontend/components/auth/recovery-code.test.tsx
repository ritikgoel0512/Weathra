/**
 * The recovery **code** entry — the door that was missing.
 *
 * The flow these cover is the one that could not be finished at all: Supabase's recovery template
 * may send a six-digit `{{ .Token }}` rather than a `{{ .ConfirmationURL }}`, and every part of
 * Weathra's recovery assumed the link. The person held a working code and the product had nowhere
 * to type it, so what is asserted here is mostly *that the code reaches the provider at all* — and
 * then that the thing it produces is the ordinary password form rather than a second one.
 *
 * Nothing here asserts on wording the provider chose. Refusals are Weathra's own sentences.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecoveryCodeForm } from "./recovery-code-form";

const verifyOtp = vi.fn();
const resetPasswordForEmail = vi.fn();
const updateUser = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      verifyOtp: (parameters: unknown) => verifyOtp(parameters),
      resetPasswordForEmail: (email: unknown, options: unknown) =>
        resetPasswordForEmail(email, options),
      updateUser: (attributes: unknown) => updateUser(attributes),
    },
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

const EMAIL = "person@example.com";

/** A session, which is the only thing that lets the password form appear. */
function accepted() {
  return { data: { session: { access_token: "t" }, user: { email: EMAIL } }, error: null };
}

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { session: null, user: null }, error };
}

function enterCode(code: string) {
  fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  verifyOtp.mockReset();
  resetPasswordForEmail.mockReset();
  updateUser.mockReset();
  verifyOtp.mockResolvedValue(accepted());
  resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});

afterEach(cleanup);

describe("entering a reset code", () => {
  it("sends the code and the address to the provider as a recovery verification", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    enterCode("123456");

    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({
        email: EMAIL,
        token: "123456",
        type: "recovery",
      }),
    );
  });

  it("hands over to the ordinary password form once the provider returns a session", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    enterCode("123456");

    // The same form the link path reaches. There is no second way to set a password.
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
  });

  it("never troubles the provider with a code of the wrong shape", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    enterCode("12");

    await waitFor(() => expect(screen.getByLabelText("Reset code")).toBeInvalid());
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("keeps digits only, so a pasted code with spaces still submits", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: "12 34-56" } });

    expect(screen.getByLabelText("Reset code")).toHaveValue("123456");
  });

  it("shows no password form when the provider refuses the code", async () => {
    verifyOtp.mockResolvedValue(refusal({ code: "otp_expired", message: "expired", status: 401 }));
    render(<RecoveryCodeForm email={EMAIL} />);
    enterCode("123456");

    await waitFor(() => expect(screen.getByLabelText("Reset code")).toBeInvalid());
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("treats an accepted code that produced no session as a failure, not a pass", async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    render(<RecoveryCodeForm email={EMAIL} />);
    enterCode("123456");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
});

describe("asking for another code", () => {
  it("makes the same request Forgot Password makes, through the same callback", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalledTimes(1));
    const [address, options] = resetPasswordForEmail.mock.calls[0] as [string, { redirectTo: string }];
    expect(address).toBe(EMAIL);
    expect(options.redirectTo).toContain("type=recovery");
  });

  it("confirms without revealing whether the address has an account", async () => {
    render(<RecoveryCodeForm email={EMAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/if that address has a weathra account/i);
    expect(notice.textContent).not.toMatch(/we sent|does not exist|no account/i);
  });
});

describe("what it will not do", () => {
  it("asks for the address when it arrived without one, rather than guessing", async () => {
    render(<RecoveryCodeForm email={null} />);
    enterCode("123456");

    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInvalid());
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("states a refused link above the code entry instead of closing the screen", () => {
    // Both can arrive in one email; a dead link is no reason to refuse a live code.
    render(<RecoveryCodeForm email={EMAIL} initialProblem="That reset link has expired." />);

    expect(screen.getByRole("alert")).toHaveTextContent(/expired/i);
    expect(screen.getByLabelText("Reset code")).toBeInTheDocument();
  });
});
