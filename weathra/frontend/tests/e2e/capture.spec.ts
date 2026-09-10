/**
 * Screenshots of the real build, for the fidelity work — not an assertion suite.
 *
 * The 2026-09-08 runtime audit was produced this way and recorded why: a component test cannot see
 * layout, density or hierarchy, so a fidelity judgement made without looking at the running screen
 * is a judgement about source code. This spec exists so that judgement can be made from pictures
 * again, at the two widths the design system names.
 *
 * It is skipped unless `WEATHRA_CAPTURE` is set, so it costs nothing in CI.
 */

import { expect, test } from "@playwright/test";

import { API_STUB_URL, STUB_URL } from "../../playwright.config";

/** The stub accepts any credentials; these are the ones the other specs use. */
const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

const CAPTURING = process.env.WEATHRA_CAPTURE === "true";

const SCREENS = [
  { name: "01-dashboard", path: "/" },
  { name: "02-analyst", path: "/analyst" },
  { name: "03-historical", path: "/historical" },
  { name: "04-compare", path: "/compare" },
  { name: "06-locations", path: "/locations" },
  { name: "07-settings", path: "/settings" },
  { name: "10-plan", path: "/plan" },
  { name: "11-explorer", path: "/explorer" },
  { name: "12-report", path: "/report" },
  { name: "13-scenarios", path: "/scenarios" },
  { name: "14-watch", path: "/watch" },
  { name: "15-travel", path: "/travel" },
  { name: "05-evidence", path: "/evidence" },
] as const;

test.describe("capture", () => {
  test.skip(!CAPTURING, "set WEATHRA_CAPTURE=true to write screenshots");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    // Both stubs start in whatever state the previous spec left them.
    await request.post(`${STUB_URL}/control/restore`);
    await request.post(`${API_STUB_URL}/control/restore`);
  });

  for (const screen of SCREENS) {
    test(`captures ${screen.name}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });

      // Every screen here is protected, so the run signs in first and the cookie carries.
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();

      await page.goto(screen.path);
      // The shell resolves the session server-side; wait for the rail rather than a timer.
      await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();
      // Give the screen's own reads a moment to settle into their populated or empty states.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.screenshot({
        path: `capture/${screen.name}-1440.png`,
        fullPage: true,
      });
    });
  }
});
