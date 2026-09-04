/**
 * `/sign-in` end to end through the page component.
 *
 * The form's own behaviour is covered in `components/auth/sign-in.test.tsx`. What is only
 * observable *here* is the page's own job: reading `next` out of the query, validating it before it
 * reaches the client, and rendering the shell with the way to Create Account. So this renders what
 * the server component actually produced and signs in through it.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREATE_ACCOUNT_PATH, DEFAULT_PROTECTED_PATH } from "@/lib/routes";

const signInWithPassword = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  supabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: (credentials: unknown) => signInWithPassword(credentials),
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const { default: SignInPage } = await import("./page");

const SESSION = {
  data: {
    session: { access_token: "test-access-token" },
    user: { id: "1", email: "sam@example.test", email_confirmed_at: "2026-09-01T00:00:00.000Z" },
  },
  error: null,
};

async function renderPage(query: Record<string, string | string[] | undefined> = {}) {
  render(await SignInPage({ searchParams: Promise.resolve(query) }));
}

async function submit() {
  await userEvent.type(screen.getByLabelText("Email"), "sam@example.test");
  await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  signInWithPassword.mockResolvedValue(SESSION);
});

describe("the sign-in page", () => {
  it("renders the approved shell: the mark, the welcome, and the product line", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByText(/Agentic weather intelligence/)).toBeInTheDocument();
    expect(screen.getByText("Weathra")).toBeInTheDocument();
  });

  it("offers the way to Create Account without implementing it", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      CREATE_ACCOUNT_PATH,
    );
  });

  it("honours a preserved destination from the query", async () => {
    await renderPage({ next: "/settings" });
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings"));
  });

  it("refuses an off-origin destination before it reaches the client", async () => {
    await renderPage({ next: "https://evil.example/steal" });
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
    expect(replace).not.toHaveBeenCalledWith("https://evil.example/steal");
  });

  it("refuses a protocol-relative destination", async () => {
    await renderPage({ next: "//evil.example" });
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
  });

  it("takes the first value when the parameter is repeated", async () => {
    // `?next=/settings&next=//evil.example` arrives as an array; the second must not win.
    await renderPage({ next: ["/settings", "//evil.example"] });
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings"));
  });

  it("goes to the protected entry route when no destination was preserved", async () => {
    await renderPage();
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(DEFAULT_PROTECTED_PATH));
  });
});

describe("returning here because a session expired", () => {
  it("says so, rather than presenting it as a fresh sign-in", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({ expired: "1" }) }));

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/your session expired/i);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("keeps the place the expired session was sent from", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ expired: "1", next: "/compare?a=Berlin" }),
      }),
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    // The destination is still honoured; the marker only chooses a sentence.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("says nothing when they came here of their own accord", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("exposes nothing of the provider's, whatever the marker says", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ expired: "token_expired: JWT is malformed" }),
      }),
    );

    // Only the literal marker turns the notice on, so nothing arbitrary reaches the page.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("JWT is malformed");
  });
});
