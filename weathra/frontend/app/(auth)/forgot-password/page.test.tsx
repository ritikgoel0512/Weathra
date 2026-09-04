/**
 * `/forgot-password` through the page component.
 *
 * The form's behaviour is covered in `components/auth/forgot-password.test.tsx`. What is only
 * observable here is the page's own contribution: the shared shell, and the two routes out that
 * every other authentication screen also offers permanently rather than in response to anything.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CREATE_ACCOUNT_PATH, SIGN_IN_PATH } from "@/lib/routes";

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: { resetPasswordForEmail: () => Promise.resolve({ data: {}, error: null }) },
  }),
}));

const { default: ForgotPasswordPage } = await import("./page");

describe("the forgot-password page", () => {
  it("renders the shared shell: the mark, the heading, and the product line", () => {
    render(<ForgotPasswordPage />);

    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
    expect(screen.getByText(/We will email you a link/)).toBeInTheDocument();
  });

  it("renders the form", () => {
    render(<ForgotPasswordPage />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });

  it("offers the ways out, before anything is submitted", () => {
    render(<ForgotPasswordPage />);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_PATH);
    expect(screen.getByRole("link", { name: "create an account" })).toHaveAttribute(
      "href",
      CREATE_ACCOUNT_PATH,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
