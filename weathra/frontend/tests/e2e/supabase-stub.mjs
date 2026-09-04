/**
 * A stand-in for Supabase Auth, for the browser-level protected-route verification (task 18.10).
 *
 * The point of these tests is Weathra's boundary — the middleware gate, the server-resolved
 * session, the cookie the SSR helpers write, and what a person actually sees. Every one of those is
 * Weathra's own code. What is *not* Weathra's code is the identity provider, and pointing the tests
 * at a real Supabase project would make them need a network, a credential in CI, and a live account
 * whose state other runs could change.
 *
 * So the provider is stood in for and **nothing else is**. The application under test is the real
 * build, running the real `@supabase/ssr` clients against this over HTTP: the browser signs in
 * through the real form, the library writes the real cookies with its own names, the real
 * middleware calls `getUser()` on every request. Supabase Auth remains the sole identity provider
 * in the architecture — this is the same protocol, answered locally.
 *
 * It implements only what those flows touch:
 *
 *   POST /auth/v1/token?grant_type=password         sign in
 *   POST /auth/v1/token?grant_type=refresh_token    refresh
 *   GET  /auth/v1/user                              who the token belongs to
 *   POST /auth/v1/logout                            revoke
 *
 * plus two control routes the spec drives it with. `/control/expire` is the one that matters: it
 * makes the provider start refusing the session the browser is holding, which is exactly what an
 * expired session is, and lets the spec verify that Weathra treats it as an authentication event.
 *
 * No credential is real, no token is signed, and nothing here is imported by the application.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.WEATHRA_STUB_PORT ?? 54321);

/**
 * Loopback by default. The manual pass of task 21.8 needs the app reachable from a physical
 * handset, and a stub bound to 127.0.0.1 is not — so `WEATHRA_STUB_HOST=0.0.0.0` opens it to the
 * local network for that one purpose. It stays loopback everywhere else, including in Playwright,
 * because nothing here checks a credential and it should not be reachable by default.
 */
const HOST = process.env.WEATHRA_STUB_HOST ?? "127.0.0.1";

const ACCESS_TOKEN = "stub-access-token";
const REFRESH_TOKEN = "stub-refresh-token";

const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "sam@example.test",
  email_confirmed_at: "2026-09-01T00:00:00.000Z",
  confirmed_at: "2026-09-01T00:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Sam Rivers" },
  identities: [],
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  is_anonymous: false,
};

/** Flipped by `/control/expire`: the provider stops recognising the session the browser holds. */
let sessionValid = true;

/**
 * The verification code this stub accepts — task 21.10.
 *
 * A real project mails a six-digit code; a stub has nowhere to mail one, so it accepts a fixed one
 * and refuses every other with the error GoTrue actually returns. Fixed rather than random because
 * the flow has to be repeatable, and six digits rather than a shorter token because
 * `verificationCodeFormatError` refuses anything else in the browser before it is ever sent.
 */
const VERIFICATION_CODE = "424242";

/**
 * Signing up leaves an account that exists and is not yet confirmed, which is what a project
 * requiring email confirmation does: `signUp` answers with a user and **no session**, and only
 * `verify` hands one over. Modelling it any other way would let the sign-up flow pass without the
 * verification step it is named after.
 */
let awaitingVerification = null;

/** The unconfirmed form of the account, as GoTrue reports it between signup and verification. */
function unconfirmedUser(email) {
  return {
    ...USER,
    email,
    email_confirmed_at: null,
    confirmed_at: null,
    user_metadata: {},
  };
}

/** Read a JSON request body, or `{}` when there is none this stub can use. */
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function session() {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: REFRESH_TOKEN,
    user: USER,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile",
  "Access-Control-Max-Age": "86400",
};

function send(response, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", ...CORS });
  response.end(payload);
}

/** The shape GoTrue refuses with. The application never shows any of it. */
function refuse(response, status, code, message) {
  send(response, status, { code: status, error_code: code, msg: message, message });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (path === "/control/health") {
    send(response, 200, { ok: true, sessionValid });
    return;
  }

  if (path === "/control/expire") {
    sessionValid = false;
    send(response, 200, { sessionValid });
    return;
  }

  if (path === "/control/restore") {
    sessionValid = true;
    // So one flow's half-finished sign-up cannot make another flow's verification pass.
    awaitingVerification = null;
    send(response, 200, { sessionValid });
    return;
  }

  /**
   * `POST /auth/v1/signup` — task 21.10's first flow.
   *
   * Answers the way a project requiring email confirmation does: the user, and `session: null`.
   * The browser discards a session if one arrives (`create-account-form.tsx`), so returning none is
   * both the faithful answer and the one that keeps an unverified account out of the product.
   *
   * It does not disclose whether the address was already registered — neither does GoTrue with
   * confirmations on, and `specs/authentication` requires the non-disclosing response. So a repeat
   * sign-up looks exactly like a first one.
   */
  if (path === "/auth/v1/signup") {
    void (async () => {
      const body = await readJson(request);
      const email = typeof body.email === "string" ? body.email : USER.email;
      awaitingVerification = email;
      send(response, 200, { user: unconfirmedUser(email), session: null });
    })();
    return;
  }

  /**
   * `POST /auth/v1/verify` — the code entry and the returning link land here alike.
   *
   * On the right code: the account becomes confirmed and a session is issued, which is what lets
   * `admit()` in `verify-email-form.tsx` show the success state. On a wrong one: `otp_expired`,
   * the code GoTrue returns, so the screen's own classification of expired-versus-incorrect is
   * exercised rather than bypassed.
   */
  if (path === "/auth/v1/verify") {
    void (async () => {
      const body = await readJson(request);
      const token = typeof body.token === "string" ? body.token : null;
      const tokenHash = typeof body.token_hash === "string" ? body.token_hash : null;
      const email = typeof body.email === "string" ? body.email : (awaitingVerification ?? USER.email);

      // A link carries a hash rather than a code; either is accepted, and neither is guessed at.
      const accepted = token === VERIFICATION_CODE || tokenHash === `hash-${VERIFICATION_CODE}`;
      if (!accepted) {
        refuse(response, 403, "otp_expired", "Email link is invalid or has expired");
        return;
      }

      awaitingVerification = null;
      sessionValid = true;
      const confirmed = { ...USER, email };
      send(response, 200, { ...session(), user: confirmed });
    })();
    return;
  }

  /** `POST /auth/v1/resend` — the resend path, so its three states are reachable. */
  if (path === "/auth/v1/resend") {
    send(response, 200, {});
    return;
  }

  if (path === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "refresh_token" && !sessionValid) {
      // The refresh token is no longer accepted: the session cannot be renewed.
      refuse(response, 400, "refresh_token_not_found", "Invalid Refresh Token");
      return;
    }
    if (grant === "password" || grant === "refresh_token") {
      sessionValid = true;
      send(response, 200, session());
      return;
    }
    refuse(response, 400, "unsupported_grant_type", "Unsupported grant type");
    return;
  }

  if (path === "/auth/v1/user") {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!sessionValid || bearer !== ACCESS_TOKEN) {
      refuse(response, 401, "bad_jwt", "invalid claim: missing sub claim");
      return;
    }
    send(response, 200, USER);
    return;
  }

  if (path === "/auth/v1/logout") {
    sessionValid = false;
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (path === "/auth/v1/settings") {
    send(response, 200, { external: {}, disable_signup: false, mailer_autoconfirm: false });
    return;
  }

  refuse(response, 404, "not_found", "No such stub route");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`supabase stub listening on http://${HOST}:${PORT}\n`);
});
