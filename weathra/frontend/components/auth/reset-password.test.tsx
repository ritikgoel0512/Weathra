/**
 * The Reset Password screen — the other half of task 20.8's verification.
 *
 * The full reset path, a new password failing the rules with the rule named, the confirmation that
 * does not match, and the expired reset — the four the task names — then the ones that are security
 * properties rather than behaviour: the provider never called for a submission that fails a stated
 * rule, a spent recovery that cannot be spent again, an expired reset arriving mid-flow, and
 * nothing about the password reaching the page, the message, or the log.
 *
 * Whether a recovery session exists is resolved *server-side* by the page above this form; its
 * tests are in `app/(auth)/reset-password/page.test.tsx`. What is covered here is what happens once
 * Supabase has said there is one.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_MINIMUM_LENGTH } from "@/lib/auth/password";
import { DEFAULT_PROTECTED_PATH, FORGOT_PASSWORD_PATH } from "@/lib/routes";

import { AuthShell } from "./auth-shell";
import { ResetPasswordForm } from "./reset-password-form";

const updateUser = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: { updateUser: (attributes: unknown) => updateUser(attributes) },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const EMAIL = "sam@example.test";
const PASSWORD = "correct-horse-battery-staple";

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { user: null }, error };
}

async function fill(password = PASSWORD, confirmation = password) {
  await userEvent.type(screen.getByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Confirm new password"), confirmation);
}

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue({ data: { user: { id: "1", email: EMAIL } }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the screen", () => {
  it("renders inside the same shell every other authentication screen uses", () => {
    render(
      <AuthShell title="Set a new password" subtitle="Choose a password you have not used here.">
        <ResetPasswordForm email={EMAIL} />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Set a new password" })).toBeInTheDocument();
  });

  it("asks for the new password twice, and asks the browser to offer a new one", () => {
    render(<ResetPasswordForm email={EMAIL} />);

    for (const label of ["New password", "Confirm new password"]) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveAttribute("autocomplete", "new-password");
    }
    const action = screen.getByRole("button", { name: "Reset password" });
    expect(action).toHaveAttribute("type", "submit");
    expect(action).toHaveAttribute("data-variant", "primary");
  });

  it("states the same rules Create Account states, before anything is submitted", () => {
    render(<ResetPasswordForm email={EMAIL} />);

    const rules = screen.getByRole("list", { name: "Password requirements" });
    expect(rules.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
    expect(rules).toHaveTextContent(`At least ${PASSWORD_MINIMUM_LENGTH} characters`);
    expect(rules).toHaveTextContent("Not your email address");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("marks a rule met as it is met, in words as well as in colour", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    const rules = screen.getByRole("list", { name: "Password requirements" });

    expect(rules).toHaveTextContent("At least 12 characters — not met yet");
    await userEvent.type(screen.getByLabelText("New password"), PASSWORD);
    expect(rules).toHaveTextContent("At least 12 characters — met");
  });

  it("hides both passwords until asked, and names which way the control moves them", async () => {
    render(<ResetPasswordForm email={EMAIL} />);

    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
  });
});

describe("the full reset path", () => {
  it("updates the password through Supabase and nowhere else", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    await waitFor(() => expect(updateUser).toHaveBeenCalledOnce());
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
  });

  it("shows the success state only once Supabase has confirmed it", async () => {
    let release: (value: unknown) => void = () => {};
    updateUser.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    // In flight: no claim of success yet.
    const action = await screen.findByRole("button", { name: "Updating your password…" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("New password")).toBeDisabled();
    expect(screen.queryByText("Password updated")).not.toBeInTheDocument();

    release({ data: { user: { id: "1" } }, error: null });
    const success = await screen.findByRole("status");
    expect(success).toHaveTextContent("Password updated");
    expect(success).toHaveAttribute("aria-live", "polite");
  });

  it("continues into the product when the person asks to", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    const onward = await screen.findByRole("button", { name: "Continue to Weathra" });
    expect(onward).toHaveFocus();
    await userEvent.click(onward);

    expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("honours a safe destination and refuses one pointing off this origin", async () => {
    const safe = render(<ResetPasswordForm email={EMAIL} destination="/historical" />);
    await fill();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith("/historical");
    safe.unmount();

    replace.mockClear();
    render(<ResetPasswordForm email={EMAIL} destination="//evil.example" />);
    await fill();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Continue to Weathra" }));
    expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH);
  });

  it("leaves no form behind, so a spent recovery cannot be spent again", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();
    await screen.findByText("Password updated");

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    expect(updateUser).toHaveBeenCalledOnce();
  });

  it("does not submit the same password twice", async () => {
    let release: (value: unknown) => void = () => {};
    updateUser.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();
    await userEvent.click(await screen.findByRole("button", { name: "Updating your password…" }));

    expect(updateUser).toHaveBeenCalledOnce();
    release({ data: { user: { id: "1" } }, error: null });
    await screen.findByText("Password updated");
  });
});

describe("a password the rules refuse", () => {
  it("names the rule, and the existing password stays in force", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill("short");
    await submit();

    expect(
      await screen.findByText(/At least 12 characters\. Your password does not meet this rule yet\./),
    ).toBeInTheDocument();
    // Nothing was sent, so there is nothing to undo.
    expect(updateUser).not.toHaveBeenCalled();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
  });

  it("names the rule about the address, checked against the account being changed", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill("sam-and-more-characters");
    await submit();

    expect(
      await screen.findByText(/Not your email address\. Your password does not meet this rule yet\./),
    ).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("asks for a password when there is none", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await submit();

    expect(await screen.findByText("Choose a new password.")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe("a confirmation that does not match", () => {
  it("says so, on the confirmation field, and sends nothing", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await fill(PASSWORD, `${PASSWORD}-typo`);
    await submit();

    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("aria-invalid", "true");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("asks for the confirmation when it is empty", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await userEvent.type(screen.getByLabelText("New password"), PASSWORD);
    await submit();

    expect(await screen.findByText("Repeat your new password.")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe("a reset that has expired", () => {
  it("shows the expired state when the session is gone by the time it is submitted", async () => {
    updateUser.mockResolvedValue(
      refusal({ code: "session_not_found", message: "Auth session missing!", status: 401 }),
    );

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/that reset link has expired/i);
    expect(alert).not.toHaveTextContent(/auth session missing/i);
  });

  it("offers another link, and takes the form away with it", async () => {
    updateUser.mockResolvedValue(refusal({ code: "session_not_found", status: 401 }));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();
    await screen.findByRole("alert");

    expect(screen.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute(
      "href",
      FORGOT_PASSWORD_PATH,
    );
    // A stale recovery cannot authorise another attempt: there is nothing left to submit with.
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
  });
});

describe("when the provider refuses for another reason", () => {
  it("says something generic, in Weathra's words", async () => {
    updateUser.mockResolvedValue(
      refusal({ code: "unexpected_failure", message: "Internal server error", status: 500 }),
    );

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not update your password/i);
    expect(alert).not.toHaveTextContent(/internal server error/i);
    expect(screen.queryByText("Password updated")).not.toBeInTheDocument();
  });

  it("says so when it is rate limiting", async () => {
    updateUser.mockResolvedValue(refusal({ code: "over_request_rate_limit", status: 429 }));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many attempts/i);
  });

  it("answers a reused password with a rule rather than the provider's wording", async () => {
    updateUser.mockResolvedValue(
      refusal({ code: "same_password", message: "New password should be different", status: 422 }),
    );

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    expect(await screen.findByText(/different from your current one/i)).toBeInTheDocument();
    expect(screen.queryByText("Password updated")).not.toBeInTheDocument();
  });

  it("says something generic when the request never reaches the provider", async () => {
    updateUser.mockRejectedValue(new Error("network down"));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not update your password/i);
    expect(alert).not.toHaveTextContent(/network down/i);
  });
});

describe("what is never written down", () => {
  it("logs neither password nor the provider's refusal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    updateUser.mockResolvedValue(refusal({ code: "session_not_found", status: 401 }));
    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();
    await screen.findByRole("alert");

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain(PASSWORD);
      expect(written).not.toContain("session_not_found");
    }
  });

  it("keeps the password out of the page, including out of a failure message", async () => {
    updateUser.mockResolvedValue(refusal({ code: "unexpected_failure", status: 500 }));

    render(<ResetPasswordForm email={EMAIL} />);
    await fill();
    await submit();
    await screen.findByRole("alert");

    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
    expect(document.body.textContent ?? "").not.toContain(PASSWORD);
  });
});

describe("accessible semantics", () => {
  it("is a form whose fields carry their guidance and their errors", async () => {
    const { container } = render(<ResetPasswordForm email={EMAIL} />);
    expect(container.querySelector("form")).toBeInTheDocument();

    const field = screen.getByLabelText("New password");
    const described = field.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described.split(" ")[0] ?? "")).toHaveTextContent(
      /checked against the rules below/i,
    );

    await fill("short");
    await submit();
    await screen.findByText(/At least 12 characters\. Your password does not meet this rule yet\./);
    expect((screen.getByLabelText("New password").getAttribute("aria-describedby") ?? "").split(" ").length)
      .toBeGreaterThan(1);
  });

  it("reaches every control from the keyboard, in order", async () => {
    render(<ResetPasswordForm email={EMAIL} />);

    expect(screen.getByLabelText("New password")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Show password" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText("Confirm new password")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Reset password" })).toHaveFocus();
  });

  it("submits from the keyboard alone", async () => {
    render(<ResetPasswordForm email={EMAIL} />);
    await userEvent.keyboard(PASSWORD);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard(`${PASSWORD}{Enter}`);

    await waitFor(() => expect(updateUser).toHaveBeenCalledOnce());
  });
});
