/**
 * Playwright, for the browser-level half of task 18.10.
 *
 * The protected-route boundary is the one part of Weathra whose behaviour is a *browser's*
 * behaviour: a redirect that happens before a paint, a cookie the server can read on the very next
 * request, a back button that must not restore a rendered dashboard. Component tests can assert the
 * middleware returns a `Location` header; only a browser can assert nobody ever saw the screen.
 *
 * So this runs the **real production build** — `next build` then `next start` — rather than the dev
 * server, because the thing under test is server-rendered output and middleware, and dev-mode
 * rendering is not what ships. Its only stand-ins are the two processes on the far side of
 * Weathra's own boundaries — the identity provider (`tests/e2e/supabase-stub.mjs`) and the FastAPI
 * backend (`tests/e2e/weathra-api-stub.mjs`) — which keep the suite offline and repeatable; every
 * line of Weathra in the path is the real one.
 *
 * The backend stub is what makes the last of task 18.10's four behaviours reachable in a browser.
 * "A 401 from the API produces the expired-session state rather than a data error" is a statement
 * about the two systems *disagreeing*: Supabase still recognises the session, so the middleware and
 * the server-resolved layout let the screen render, and the backend refuses the bearer token
 * anyway. Expiring the Supabase session instead produces a middleware redirect, which is a
 * different mechanism and is covered separately.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so they are set on the build command rather
 * than only on the server.
 */

import { defineConfig, devices } from "@playwright/test";

const STUB_PORT = 54321;
const API_STUB_PORT = 54322;
const APP_PORT = 3100;

export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
export const API_STUB_URL = `http://127.0.0.1:${API_STUB_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

const publicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: STUB_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key",
  // The Dashboard (task 21.1) makes authenticated calls, so this points at the backend stub rather
  // than at a dead port. It is inlined at build time, which is why it is set on the build command.
  NEXT_PUBLIC_API_BASE_URL: API_STUB_URL,
};

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  // Each stub holds one session's validity, so the specs share state and must not race for it.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_500 },

  use: {
    baseURL: APP_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  /**
   * Two engines, because a focus ring, a `:focus-visible` decision and a reflow are all the
   * engine's behaviour rather than Weathra's, and task 21.8's audit recorded "one browser engine"
   * as a genuine limitation of its first pass. Chromium (Blink) and Firefox (Gecko) both run the
   * whole browser suite.
   *
   * WebKit is downloaded by `npx playwright install webkit` but will not launch without a set of
   * system libraries that only root can install (`sudo npx playwright install-deps webkit`), so it
   * is a third project behind an opt-in rather than a project that fails for everyone who has not
   * done that. Once the libraries are present, `WEATHRA_E2E_WEBKIT=1 npx playwright test` runs it
   * with no further change.
   */
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    ...(process.env.WEATHRA_E2E_WEBKIT
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
      : []),
  ],

  webServer: [
    {
      command: "node tests/e2e/supabase-stub.mjs",
      url: `${STUB_URL}/control/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: "node tests/e2e/weathra-api-stub.mjs",
      url: `${API_STUB_URL}/control/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: `npm run build && npx next start --port ${APP_PORT}`,
      url: `${APP_URL}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: publicEnv,
      stdout: "pipe",
    },
  ],
});
