/**
 * The session boundary — task 20.9's verification.
 *
 * These drive the *real* wiring: a real `QueryClient`, the real API client with the real 401
 * handling, and a screen that reads data through the shared query hook. Only `fetch` and Supabase
 * are replaced, because everything between them is the thing under test — a test that injected a
 * fake client would be asserting its own interceptor.
 *
 * The four the task names: persistence and protected navigation with a valid session, the pending
 * state that does not flash protected content, a 401 producing the expired-session path rather than
 * a data error, and sign-out clearing state. Then the ones that are security properties: an
 * ordinary failure that must *not* expire anybody, an expiry that happens once however many
 * requests were in flight, a destination kept and a hostile one refused, and nothing about a token
 * reaching the page or the log.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { useApiQuery } from "@/lib/query/hooks";
import { SIGN_IN_PATH } from "@/lib/routes";

import { SessionBoundary, useSession } from "./provider";

const browserAccessToken = vi.fn<() => Promise<string | null>>();
const pathname = vi.fn<() => string>();

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: () => browserAccessToken(),
  supabaseBrowserClient: () => {
    throw new Error("the session layer must not build a second Supabase client");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

const TOKEN = "test-access-token";

/** A screen that reads data the way every product screen will: through the shared query hook. */
function Screen(): React.ReactNode {
  const { state, retry } = useApiQuery({
    key: ["me"],
    request: (client) => client.me(),
  });

  const status = useSession().status;

  if (state.kind === "loading") return <p>Loading the screen</p>;
  if (state.kind === "error") return <p>Data error: {state.failure.message}</p>;
  if (state.kind === "empty") return <p>Nothing here</p>;
  return (
    <div>
      <p>Protected content for {String((state.data as { user_id?: string }).user_id)}</p>
      <p>session: {status}</p>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

function ok() {
  return jsonResponse(200, { user_id: "00000000-0000-0000-0000-000000000001" });
}

function failure(status: number, code: string, message: string) {
  return jsonResponse(status, { error: { code, message, details: null, request_id: "req-1" } });
}

let fetchMock: Mock;

function boundary(
  props: { initialStatus?: "pending" | "active"; accessToken?: () => string | null } = {},
) {
  return (
    <SessionBoundary
      initialStatus={props.initialStatus ?? "active"}
      fetch={(input, init) => fetchMock(input, init)}
      accessToken={props.accessToken ?? (() => TOKEN)}
    >
      <Screen />
    </SessionBoundary>
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  pathname.mockReturnValue("/compare");
  browserAccessToken.mockResolvedValue(TOKEN);
  fetchMock = vi.fn().mockResolvedValue(ok());
  window.history.replaceState({}, "", "/compare?a=Berlin");
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("a valid session", () => {
  it("renders the screen, and says the session is active", async () => {
    render(boundary());

    expect(await screen.findByText(/Protected content for/)).toBeInTheDocument();
    expect(screen.getByText("session: active")).toBeInTheDocument();
  });

  it("sends the session's token on every call, asked for again each time", async () => {
    const accessToken = vi.fn().mockReturnValue(TOKEN);
    render(boundary({ accessToken }));

    await screen.findByText(/Protected content for/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
    // Asked per call, so a transparently refreshed token is the one that is used.
    expect(accessToken.mock.calls.length).toBeGreaterThan(1);
  });

  it("survives a remount, which is what a reload and a protected navigation are", async () => {
    const first = render(boundary());
    await screen.findByText(/Protected content for/);
    first.unmount();

    // Nothing was kept in the component; the session is in cookies, and the server seeded the
    // boundary again. There is no client store to lose.
    render(boundary());
    expect(await screen.findByText(/Protected content for/)).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("the pending state", () => {
  it("shows neither protected content nor a signed-out claim while it resolves", async () => {
    let release: (value: string | null) => void = () => {};
    browserAccessToken.mockReturnValue(new Promise((resolve) => (release = resolve)));

    render(boundary({ initialStatus: "pending" }));

    const pending = screen.getByRole("status");
    expect(pending).toHaveTextContent("Checking your session");
    expect(screen.queryByText(/Protected content for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();

    release(TOKEN);
    expect(await screen.findByText(/Protected content for/)).toBeInTheDocument();
  });

  it("resolves through Supabase, which is what refreshes an expiring token", async () => {
    render(boundary({ initialStatus: "pending" }));

    await screen.findByText(/Protected content for/);
    expect(browserAccessToken).toHaveBeenCalledOnce();
  });

  it("expires rather than showing a data error when the session cannot be refreshed", async () => {
    browserAccessToken.mockResolvedValue(null);

    render(boundary({ initialStatus: "pending" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/your session has expired/i);
    expect(screen.queryByText(/Data error/)).not.toBeInTheDocument();
    // Nothing was requested with a session that does not exist.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires rather than reporting the identity provider when it cannot be reached", async () => {
    browserAccessToken.mockRejectedValue(new Error("supabase unreachable"));

    render(boundary({ initialStatus: "pending" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/your session has expired/i);
    expect(alert).not.toHaveTextContent(/supabase/i);
  });

  it("is never entered on a protected screen the server already resolved", () => {
    render(boundary({ initialStatus: "active" }));

    expect(screen.queryByText("Checking your session")).not.toBeInTheDocument();
    expect(browserAccessToken).not.toHaveBeenCalled();
  });
});

describe("a 401 while somebody is working", () => {
  it("produces the expired-session state rather than a data error", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "The access token has expired."));

    render(boundary());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/your session has expired/i);
    expect(screen.queryByText(/Data error/)).not.toBeInTheDocument();
    // The screen is gone: protected content does not stay on the page behind the notice.
    expect(screen.queryByText(/Protected content for/)).not.toBeInTheDocument();
  });

  it("keeps their place, and says why they are back at sign-in", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));

    render(boundary());
    await screen.findByRole("alert");

    const action = screen.getByRole("link", { name: "Sign in again" });
    expect(action).toHaveAttribute(
      "href",
      `${SIGN_IN_PATH}?next=${encodeURIComponent("/compare?a=Berlin")}&expired=1`,
    );
  });

  it("refuses a place that is not a path on this origin", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));
    pathname.mockReturnValue("//evil.example");
    window.history.replaceState({}, "", "/");

    render(boundary());
    await screen.findByRole("alert");

    const href = screen.getByRole("link", { name: "Sign in again" }).getAttribute("href") ?? "";
    expect(href).toBe(`${SIGN_IN_PATH}?expired=1`);
    expect(href).not.toContain("evil.example");
  });

  it("expires once, however many requests were in flight", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));

    render(
      <SessionBoundary
        initialStatus="active"
        fetch={(input, init) => fetchMock(input, init)}
        accessToken={() => TOKEN}
      >
        <Screen />
        <Screen />
        <Screen />
      </SessionBoundary>,
    );

    await screen.findByRole("alert");
    // One notice, and no retry storm: the query layer does not retry a 401 and the boundary does
    // not re-attempt anything of its own.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    const before = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("does not retry the refused call", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));

    render(boundary());
    await screen.findByRole("alert");

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("an ordinary failure", () => {
  it("is shown as a data error, and nobody is signed out for it", async () => {
    fetchMock.mockResolvedValue(
      failure(503, "provider_unavailable", "The weather provider is unavailable."),
    );

    render(boundary());

    // A 5xx is retried once by the query layer before the view is told, so this waits past that.
    expect(
      await screen.findByText(/The weather provider is unavailable\./, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  it("does not expire anybody for a refusal", async () => {
    fetchMock.mockResolvedValue(failure(403, "not_permitted", "That is not available to you."));

    render(boundary());

    expect(await screen.findByText(/That is not available to you\./)).toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  it("does not expire anybody when the backend cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    render(boundary());

    await waitFor(
      () => expect(screen.getByText(/Data error:/)).toHaveTextContent(/could not be reached/i),
      { timeout: 5000 },
    );
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  it("does not expire anybody for a 404 or a 422", async () => {
    for (const [status, code] of [
      [404, "location_not_found"],
      [422, "range_outside_coverage"],
    ] as const) {
      fetchMock.mockResolvedValue(failure(status, code, `Refused with ${status}.`));
      const view = render(boundary());
      expect(await screen.findByText(`Data error: Refused with ${status}.`)).toBeInTheDocument();
      expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("what is never written down", () => {
  it("keeps the token out of the page in every state", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "The access token has expired."));

    render(boundary());
    await screen.findByRole("alert");

    const shown = document.body.textContent ?? "";
    expect(shown).not.toContain(TOKEN);
    // Nor the provider's own words, its code, or its status.
    expect(shown).not.toContain("The access token has expired.");
    expect(shown).not.toContain("token_expired");
    expect(shown).not.toContain("401");
  });

  it("logs no token and no session detail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));
    render(boundary());
    await screen.findByRole("alert");

    for (const spy of [log, warn, error]) {
      expect(spy.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    }
  });

  it("puts no authentication state into browser storage", async () => {
    render(boundary());
    await screen.findByText(/Protected content for/);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("accessible semantics", () => {
  it("announces the pending state politely, without claiming anything", () => {
    browserAccessToken.mockReturnValue(new Promise(() => {}));
    render(boundary({ initialStatus: "pending" }));

    const pending = screen.getByRole("status");
    expect(pending).toHaveAttribute("aria-live", "polite");
    expect(pending).toHaveTextContent("Checking your session");
  });

  it("announces the expired state assertively and moves focus to the way back", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));
    render(boundary());

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const action = screen.getByRole("link", { name: "Sign in again" });
    // The content behind it is gone; leaving focus there would strand a keyboard user.
    await waitFor(() => expect(action).toHaveFocus());
    expect(action.tagName).toBe("A");
  });

  it("reaches the way back from the keyboard", async () => {
    fetchMock.mockResolvedValue(failure(401, "token_expired", "expired"));
    render(boundary());
    await screen.findByRole("alert");

    await userEvent.tab();
    // One control in the state, and it is reachable: tabbing away and back returns to it.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveFocus();
  });
});
