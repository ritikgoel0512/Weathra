/**
 * `/create-account` through the page component.
 *
 * The form's behaviour is covered in `components/auth/create-account.test.tsx`. What is only
 * observable here is the page's own contribution: the shell it renders, and the two routes the
 * already-registered requirement says must be offered — sign in, and password reset — which have
 * to be present *before* anything is submitted, since a link that appeared only for a registered
 * address would be the disclosure the requirement forbids.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FORGOT_PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/routes";

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      signUp: () => Promise.resolve({ data: { user: null, session: null }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const { default: CreateAccountPage } = await import("./page");

describe("the create-account page", () => {
  it("renders the shared shell: the mark, the heading, and the product line", () => {
    render(<CreateAccountPage />);

    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByText(/Agentic weather intelligence/)).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
  });

  it("renders the form", () => {
    render(<CreateAccountPage />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("offers the way back to Sign In", () => {
    render(<CreateAccountPage />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_PATH);
  });

  it("offers the password-reset path the requirement asks for", () => {
    render(<CreateAccountPage />);
    expect(screen.getByRole("link", { name: "reset your password" })).toHaveAttribute(
      "href",
      FORGOT_PASSWORD_PATH,
    );
  });

  it("offers both paths before anything is submitted", () => {
    render(<CreateAccountPage />);
    // Present on arrival, so their presence says nothing about any address.
    expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(screen.getByRole("link", { name: "reset your password" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("states the password rules on arrival", () => {
    render(<CreateAccountPage />);
    const rules = screen.getByRole("list", { name: "Password requirements" });
    expect(rules).toBeInTheDocument();
    expect(rules.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
  });
});
