// @vitest-environment node

/**
 * `/auth/confirm` — task 20.6's verification.
 *
 * The three the task names — a valid link, an expired link, and an already-used link — then the
 * cases that are security properties rather than behaviour: a malformed link, a link naming a flow
 * the handler will not complete, an exchange that succeeds without a confirmed address, a session
 * that fails to establish, an unsafe destination, and the token never travelling onward.
 *
 * These drive the real handler with a real `NextRequest` and only Supabase mocked, because what is
 * under test is almost entirely the response — where `Location` points and what it carries. A test
 * that mocked `next/server` would assert its own fake.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPLETED_PARAMETER,
  COMPLETED_RECOVERY,
  COMPLETED_VERIFICATION,
  RESET_PASSWORD_PATH,
  VERIFY_EMAIL_PATH,
} from "@/lib/routes";

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();
const getUser = vi.fn();
const signOutOfSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServerClient: async () => ({
    auth: {
      verifyOtp: (parameters: unknown) => verifyOtp(parameters),
      exchangeCodeForSession: (code: unknown) => exchangeCodeForSession(code),
      getUser: () => getUser(),
      signOut: () => signOutOfSupabase(),
    },
  }),
}));

const { GET } = await import("./route");

const TOKEN_HASH = "pkce_2f8c1d6e5b4a3908";
const CODE = "a1b2c3d4-0000-4000-8000-abcdefabcdef";

const CONFIRMED = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "sam@example.test",
  email_confirmed_at: "2026-09-04T00:00:00.000Z",
};

const UNCONFIRMED = { ...CONFIRMED, email_confirmed_at: null, confirmed_at: null };

function request(query: string): NextRequest {
  return new NextRequest(new URL(`https://weathra.test/auth/confirm${query}`));
}

/** The `Location` header as a path, so an assertion cannot pass on the origin alone. */
function location(response: Response): string | null {
  const value = response.headers.get("location");
  return value === null ? null : `${new URL(value).pathname}${new URL(value).search}`;
}

function exchanged(user: Record<string, unknown> | null = CONFIRMED, session = true) {
  return {
    data: { session: session ? { access_token: "test-access-token" } : null, user },
    error: null,
  };
}

function refusal(error: { code?: string; message?: string; status?: number }) {
  return { data: { session: null, user: null }, error };
}

/** The provider's single answer for a token it does not recognise — expired *or* already used. */
const EXPIRED_OR_USED = {
  code: "otp_expired",
  message: "Token has expired or is invalid",
  status: 403,
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyOtp.mockResolvedValue(exchanged());
  exchangeCodeForSession.mockResolvedValue(exchanged());
  getUser.mockResolvedValue({ data: { user: CONFIRMED }, error: null });
  signOutOfSupabase.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a valid verification link", () => {
  it("completes verification server-side, with no further entry", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "signup" });
    expect(response.status).toBe(307);
  });

  it("lands on the Verify Email screen's own success state", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?${COMPLETED_PARAMETER}=${COMPLETED_VERIFICATION}`,
    );
  });

  it("validates the session it just established with Supabase", async () => {
    await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    // Not "the exchange returned no error", but "Supabase says this session belongs to somebody".
    expect(getUser).toHaveBeenCalledOnce();
    expect(signOutOfSupabase).not.toHaveBeenCalled();
  });

  it("accepts the email-confirmation type as well as the signup one", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=email`));

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "email" });
    expect(location(response)).toContain(COMPLETED_VERIFICATION);
  });

  it("completes the authorization-code form of the same link", async () => {
    const response = await GET(request(`?code=${CODE}`));

    expect(exchangeCodeForSession).toHaveBeenCalledWith(CODE);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(location(response)).toContain(COMPLETED_VERIFICATION);
  });

  it("keeps a destination that is a path on this origin", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup&next=%2Fhistorical`));
    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?${COMPLETED_PARAMETER}=${COMPLETED_VERIFICATION}&next=%2Fhistorical`,
    );
  });
});

describe("a link the provider will not accept", () => {
  it("reports an expired link as expired", async () => {
    verifyOtp.mockResolvedValue(refusal(EXPIRED_OR_USED));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?error=access_denied&error_code=otp_expired`,
    );
  });

  it("sends an already-used link to the same safe state", async () => {
    // A consumed token is gone, and the provider answers for it exactly as it answers for an
    // expired one. Both offer the same way forward: enter the code, or ask for a new one.
    verifyOtp.mockResolvedValue(refusal(EXPIRED_OR_USED));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toContain(VERIFY_EMAIL_PATH);
    expect(location(response)).toContain("error_code=otp_expired");
    expect(location(response)).not.toContain(TOKEN_HASH);
  });

  it("reports any other refusal as an invalid link", async () => {
    verifyOtp.mockResolvedValue(refusal({ code: "bad_jwt", message: "invalid claim", status: 401 }));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?error=access_denied&error_code=invalid_link`,
    );
  });

  it("passes on a refusal the provider made before the link reached us", async () => {
    const response = await GET(
      request("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid"),
    );

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?error=access_denied&error_code=otp_expired`,
    );
    // The provider's own description does not travel onward.
    expect(location(response)).not.toContain("Email+link+is+invalid");
  });

  it("says nothing to the provider when a transport failure is what answered", async () => {
    verifyOtp.mockRejectedValue(new Error("network down"));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toContain("error_code=invalid_link");
    expect(location(response)).not.toContain("network");
  });
});

describe("a malformed link", () => {
  it("refuses a link carrying nothing to exchange", async () => {
    const response = await GET(request(""));

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(response)).toBe(
      `${VERIFY_EMAIL_PATH}?error=access_denied&error_code=invalid_link`,
    );
  });

  it("refuses a token with no type, and a type with no token", async () => {
    for (const query of [`?token_hash=${TOKEN_HASH}`, "?type=signup"]) {
      const response = await GET(request(query));
      expect(location(response), query).toContain("error_code=invalid_link");
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses a link naming a flow this handler does not complete", async () => {
    // The allow-list is the point: an unchecked `type` would let a link choose which flow the
    // handler thinks it is finishing.
    for (const type of ["email_change", "invite", "magiclink", "../signup"]) {
      const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=${type}`));
      expect(location(response), type).toContain("error_code=invalid_link");
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("an exchange that is not yet a success", () => {
  it("refuses an outcome carrying no session", async () => {
    verifyOtp.mockResolvedValue(exchanged(CONFIRMED, false));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toContain("error_code=invalid_link");
    expect(location(response)).not.toContain(COMPLETED_VERIFICATION);
  });

  it("refuses when the session did not establish", async () => {
    // `getUser()` reads the cookies the exchange just wrote. No user means the session Weathra
    // would be relying on is not there — a success now would be one the next request disagrees with.
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(location(response)).toContain("error_code=invalid_link");
  });

  it("signs out a session for an address the provider has not confirmed", async () => {
    verifyOtp.mockResolvedValue(exchanged(UNCONFIRMED));
    getUser.mockResolvedValue({ data: { user: UNCONFIRMED }, error: null });

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));

    expect(signOutOfSupabase).toHaveBeenCalledOnce();
    expect(location(response)).toContain("error_code=invalid_link");
    expect(location(response)).not.toContain(COMPLETED_VERIFICATION);
  });
});

describe("the returning recovery link", () => {
  it("completes through the same handler and lands on Reset Password", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=recovery`));

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "recovery" });
    expect(location(response)).toBe(
      `${RESET_PASSWORD_PATH}?${COMPLETED_PARAMETER}=${COMPLETED_RECOVERY}`,
    );
  });

  it("sends a refused recovery link to Reset Password, not to verification", async () => {
    verifyOtp.mockResolvedValue(refusal(EXPIRED_OR_USED));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=recovery`));

    expect(location(response)).toBe(
      `${RESET_PASSWORD_PATH}?error=access_denied&error_code=otp_expired`,
    );
  });

  it("still requires a session Supabase agrees with", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=recovery`));

    expect(location(response)).toContain("error_code=invalid_link");
  });
});

describe("what never leaves this route", () => {
  it("redirects to this origin whatever the link's destination claims", async () => {
    for (const hostile of ["//evil.example", "https://evil.example/x", "/\\evil.example"]) {
      const response = await GET(
        request(`?token_hash=${TOKEN_HASH}&type=signup&next=${encodeURIComponent(hostile)}`),
      );
      const value = response.headers.get("location") ?? "";
      expect(new URL(value).origin, hostile).toBe("https://weathra.test");
      expect(value, hostile).not.toContain("evil.example");
    }
  });

  it("carries no token, code, or provider detail onward", async () => {
    const response = await GET(
      request(`?token_hash=${TOKEN_HASH}&code=${CODE}&type=signup&secret=shh`),
    );

    const value = response.headers.get("location") ?? "";
    for (const leak of [TOKEN_HASH, CODE, "token_hash", "secret", "shh"]) {
      expect(value, leak).not.toContain(leak);
    }
  });

  it("carries no provider wording, status, or error identifier onward", async () => {
    verifyOtp.mockResolvedValue(refusal(EXPIRED_OR_USED));

    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));
    const value = response.headers.get("location") ?? "";

    for (const leak of ["Token has expired", "403", "supabase"]) {
      expect(value.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });

  it("logs neither the token, the code, nor the session", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));
    verifyOtp.mockResolvedValue(refusal(EXPIRED_OR_USED));
    await GET(request(`?code=${CODE}`));

    for (const spy of [log, warn, error]) {
      const written = spy.mock.calls.flat().join(" ");
      expect(written).not.toContain(TOKEN_HASH);
      expect(written).not.toContain(CODE);
      expect(written).not.toContain("test-access-token");
    }
  });

  it("renders nothing at all", async () => {
    const response = await GET(request(`?token_hash=${TOKEN_HASH}&type=signup`));
    expect(await response.text()).toBe("");
  });
});
