/**
 * The protected-route boundary, in a browser — task 18.10.
 *
 * Group 18 proves the identity boundary as a whole rather than slice by slice, and this is its
 * frontend half. Everything here drives the real production build: the real middleware, the real
 * server-resolved layout, the real `@supabase/ssr` cookie session, the real Sign In form, the real
 * typed API client with its 401 interceptor, and the real sign-out action. Only the two processes
 * on the far side of Weathra's boundaries are stood in for — the identity provider
 * (`supabase-stub.mjs`) and the FastAPI backend (`weathra-api-stub.mjs`) — so the suite is offline
 * and repeatable.
 *
 * The four behaviours the task names, plus the ones that only a browser can settle: that nobody was
 * ever *sent* protected content on the way past the gate, that the session lives in cookies and not
 * in `localStorage`, and that a session the provider stops recognising is treated as an
 * authentication event rather than a broken screen.
 *
 * The last of the four is the one that needs both stubs at once. "A 401 from the API produces the
 * expired-session state rather than a data error" is a statement about the two systems
 * *disagreeing*: Supabase still recognises the session — so the middleware waves the request
 * through and the layout renders the screen — while Weathra's API refuses the bearer token the
 * browser presents. Expiring the Supabase session instead produces a middleware redirect, which is
 * the mechanism the block above this one covers, and proves something different.
 */

import { expect, test, type Page, type Response } from "@playwright/test";

const STUB_URL = "http://127.0.0.1:54321";
const API_STUB_URL = "http://127.0.0.1:54322";

const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

/**
 * A protected screen, and a string that appears only when one has actually rendered.
 *
 * The composer's own label rather than the screen's title: the title is also a navigation entry,
 * present on every protected page, and a marker that appears in the shell would prove nothing about
 * whether the screen behind it rendered.
 */
const PROTECTED_PATH = "/analyst";
const PROTECTED_MARKER = "Your weather question";

/** Recorded document responses, so "no flash" can be asserted at the network rather than by eye. */
function recordDocuments(page: Page): { bodies: Promise<string>[] } {
  const bodies: Promise<string>[] = [];
  page.on("response", (response: Response) => {
    if (response.request().resourceType() !== "document") return;
    bodies.push(response.text().catch(() => ""));
  });
  return { bodies };
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  // Exact: the field's visibility control is named "Show password", which a loose label match
  // would find as well.
  await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeEach(async ({ request, context }) => {
  await request.post(`${STUB_URL}/control/restore`);
  // Also clears the backend stub's request log, so each spec asserts only its own traffic.
  await request.post(`${API_STUB_URL}/control/restore`);
  await context.clearCookies();
});

test.describe("an unauthenticated visitor", () => {
  test("is redirected to sign-in from a protected route, with the destination preserved", async ({
    page,
  }) => {
    await page.goto(PROTECTED_PATH);

    await expect(page).toHaveURL(
      `/sign-in?next=${encodeURIComponent(PROTECTED_PATH)}`,
    );
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("keeps the query string of the screen they were trying to reach", async ({ page }) => {
    await page.goto("/compare?a=Berlin&b=Lisbon");

    await expect(page).toHaveURL(
      `/sign-in?next=${encodeURIComponent("/compare?a=Berlin&b=Lisbon")}`,
    );
  });

  test("is never sent the protected screen at all, so there is nothing to flash", async ({
    page,
  }) => {
    const recorded = recordDocuments(page);

    await page.goto(PROTECTED_PATH);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    // The gate runs before anything renders: no document the browser received carried the screen,
    // and no shell was ever in the DOM to be taken away.
    for (const body of await Promise.all(recorded.bodies)) {
      expect(body).not.toContain(PROTECTED_MARKER);
    }
    await expect(page.getByRole("navigation", { name: "Weathra" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("reaches the unauthenticated screens without a redirect", async ({ page }) => {
    for (const path of ["/sign-in", "/create-account", "/forgot-password", "/verify-email"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(path);
    }
  });
});

test.describe("signing in", () => {
  test("returns the person to the destination they were originally sent from", async ({ page }) => {
    await page.goto(PROTECTED_PATH);
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(PROTECTED_PATH)}`);

    await signIn(page);

    await expect(page).toHaveURL(PROTECTED_PATH);
    await expect(page.getByText(PROTECTED_MARKER)).toBeVisible();
  });

  test("renders the protected shell, identified as the person who signed in", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page);

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();
    await expect(page.getByText("Sam Rivers")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("puts nothing authentication-shaped in browser storage", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");

    // The session is in cookies so the server can read it before a protected screen renders.
    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored.local.join(" ")).not.toMatch(/auth|token|supabase|sb-/i);
    expect(stored.session.join(" ")).not.toMatch(/auth|token|supabase|sb-/i);

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name.includes("auth-token"))).toBe(true);
  });
});

test.describe("an authenticated person", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");
  });

  test("stays signed in across a reload", async ({ page }) => {
    await page.reload();

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();
  });

  test("navigates between protected routes without being asked again", async ({ page }) => {
    for (const path of ["/analyst", "/historical", "/compare", "/settings"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(path);
      await expect(page.getByRole("navigation", { name: "Weathra" }), path).toBeVisible();
    }
  });

  test("is kept off the authentication screens", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveURL("/");
  });
});

test.describe("a session the provider stops recognising", () => {
  test("is an authentication event: back to sign-in, with the place kept", async ({
    page,
    request,
  }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");

    // The session can no longer be validated and can no longer be refreshed.
    await request.post(`${STUB_URL}/control/expire`);

    await page.goto(PROTECTED_PATH);

    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(PROTECTED_PATH)}`);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    // Not a data error, not a server fault, and not a blank screen.
    await expect(page.getByText(/could not be reached|server error|failed to fetch/i)).toHaveCount(0);
  });

  test("shows no protected content on the way out", async ({ page, request }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");

    await request.post(`${STUB_URL}/control/expire`);
    const recorded = recordDocuments(page);

    await page.goto(PROTECTED_PATH);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    for (const body of await Promise.all(recorded.bodies)) {
      expect(body).not.toContain(PROTECTED_MARKER);
    }
  });
});

test.describe("signing out", () => {
  test("ends protected access", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");

    await page.goto(PROTECTED_PATH);
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(PROTECTED_PATH)}`);
    await expect(page.getByRole("navigation", { name: "Weathra" })).toHaveCount(0);
  });

  test("cannot be undone by the back button", async ({ page }) => {
    await page.goto(PROTECTED_PATH);
    await signIn(page);
    await expect(page).toHaveURL(PROTECTED_PATH);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");

    // The protected response is `no-store`, so going back re-asks the gate rather than re-showing
    // a rendered screen to whoever is at the machine now.
    await page.goBack();
    await expect(page.getByText(PROTECTED_MARKER)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Weathra" })).toHaveCount(0);
  });
});

test.describe("a 401 from Weathra's API while the identity provider still recognises the session", () => {
  /** A protected screen that makes authenticated backend calls, and something only its data shows. */
  const DASHBOARD_PATH = "/?city=Berlin";
  const DASHBOARD_FIGURE = "15.3 °C";

  /** Where the expired state must send somebody who was on `DASHBOARD_PATH`. */
  const EXPIRED_SIGN_IN = `/sign-in?next=${encodeURIComponent("/?city=Berlin")}&expired=1`;

  /** Text that would mean Weathra had presented the refusal as a data or server failure. */
  const DATA_ERROR_LANGUAGE =
    /could not be reached|weather provider is unavailable|access token has expired|something went wrong/i;

  /**
   * The expired-session panel.
   *
   * Filtered rather than taken as the only alert on the page: Next's route announcer is also
   * `role="alert"`, and it is part of the framework rather than of what is being asserted.
   */
  const expiredPanel = (page: Page) =>
    page.getByRole("alert").filter({ hasText: "Your session has expired" });

  async function signInAndOpenDashboard(page: Page): Promise<void> {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");

    await page.goto(DASHBOARD_PATH);
    // The screen genuinely renders first: this figure exists only in the backend stub's response,
    // so seeing it proves a real authenticated request crossed the boundary and was rendered.
    await expect(page.getByRole("region", { name: "Current conditions" })).toBeVisible();
    await expect(page.getByText(DASHBOARD_FIGURE)).toBeVisible();
  }

  test("the authenticated screen renders from a real request that carried the bearer token", async ({
    page,
    request,
  }) => {
    await signInAndOpenDashboard(page);

    const { requests } = await (await request.get(`${API_STUB_URL}/control/requests`)).json();
    const preferences = requests.filter(
      (entry: { path: string }) => entry.path === "/api/v1/me/preferences",
    );

    expect(preferences.length, "the Dashboard must call the backend").toBeGreaterThan(0);
    // The token travels in the header, on every call, as `specs/http-api` requires.
    expect(preferences.every((entry: { authenticated: boolean }) => entry.authenticated)).toBe(true);
    expect(
      requests.every((entry: { authenticated: boolean }) => entry.authenticated),
      "every call the Dashboard made presented a bearer token",
    ).toBe(true);
  });

  test("mid-use, a refused call replaces the screen with the expired state and not an error card", async ({
    page,
    request,
  }) => {
    await signInAndOpenDashboard(page);

    // The identity provider is untouched: the cookie session is still perfectly valid, and the
    // middleware would let this request through again. Only Weathra's API stops accepting the token.
    await request.post(`${API_STUB_URL}/control/revoke`);
    expect((await (await request.get(`${STUB_URL}/control/health`)).json()).sessionValid).toBe(true);

    // One ordinary action on the screen already in front of them, and nothing else.
    await page.getByRole("button", { name: "Generate interpretation" }).click();

    const alert = expiredPanel(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Sign in again to carry on where you left off");

    // The refusal reached the shared interceptor: the call was made, and it was refused.
    const { requests } = await (await request.get(`${API_STUB_URL}/control/requests`)).json();
    expect(requests.some((entry: { path: string }) => entry.path === "/api/v1/agent/ask")).toBe(true);

    // Not a data error. The panel that made the call has an error branch of its own, and the
    // boundary replaces it before it can render: nothing quotes the backend, and nothing offers a
    // retry of a request that will never succeed.
    await expect(page.getByText(DATA_ERROR_LANGUAGE)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

    // And the protected content is gone rather than left behind the message.
    await expect(page.getByText(DASHBOARD_FIGURE)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Current conditions" })).toHaveCount(0);

    // Nobody was navigated anywhere: this is the in-place state, and the place is still theirs.
    await expect(page).toHaveURL(DASHBOARD_PATH);
  });

  test("returns them to sign-in at the screen they were on, said as an expiry", async ({
    page,
    request,
  }) => {
    await signInAndOpenDashboard(page);
    await request.post(`${API_STUB_URL}/control/revoke`);

    await page.reload();

    await expect(expiredPanel(page)).toBeVisible();

    // The destination travels in the same `next` parameter the middleware uses, query string and
    // all — that query is often the whole of the place worth keeping.
    const back = page.getByRole("link", { name: "Sign in again" });
    await expect(back).toHaveAttribute("href", EXPIRED_SIGN_IN);

    // Following it lands on the sign-in screen once the provider has stopped honouring the session
    // as well — which is the state somebody returning here is actually in. While Supabase still
    // recognises them, task 20.10 deliberately keeps an authenticated person off the authentication
    // screens, and that rule is not suspended because the backend refused a call.
    await request.post(`${STUB_URL}/control/expire`);

    await back.click();
    await expect(page).toHaveURL(EXPIRED_SIGN_IN);
    // Said, rather than presented as a fresh sign-in they asked for.
    await expect(
      page.getByRole("status").filter({ hasText: "Your session expired" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("carries no destination when the screen was already the default one", async ({
    page,
    request,
  }) => {
    await page.goto("/sign-in");
    await signIn(page);
    await expect(page).toHaveURL("/");
    await expect(page.getByText(DASHBOARD_FIGURE)).toBeVisible();

    await request.post(`${API_STUB_URL}/control/revoke`);
    await page.reload();

    await expect(expiredPanel(page)).toBeVisible();
    // `/` is where an authenticated person lands anyway, so there is nothing to preserve and no
    // `next` is added — the marker still is.
    await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/sign-in?expired=1",
    );
  });

  test("the expired state is produced by the API's answer, not served by the page", async ({
    page,
    request,
  }) => {
    await signInAndOpenDashboard(page);
    await request.post(`${API_STUB_URL}/control/revoke`);

    const recorded = recordDocuments(page);
    await page.reload();
    await expect(expiredPanel(page)).toBeVisible();

    const documents = await Promise.all(recorded.bodies);
    expect(documents.length).toBeGreaterThan(0);
    for (const body of documents) {
      // The server still resolved the session and still sent the protected shell — which is what
      // keeps the pending state, and any flash of it, off this screen.
      expect(body).toContain("Sam Rivers");
      // And the expired state was not in it: nothing was pre-rendered, so what a person saw was the
      // shared 401 interceptor acting on the backend's refusal in the browser.
      expect(body).not.toContain("Your session has expired");
    }
  });
});
