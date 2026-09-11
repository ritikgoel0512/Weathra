/**
 * Photograph the **deployed** screens, signed in as a real production account.
 *
 * # Why this exists separately from `capture.spec.ts`
 *
 * Every capture in `capture/` is of the real shipping bundle driven against the two offline stubs.
 * That is honest evidence about *composition* — the components, the layout, the states — and no
 * evidence at all about production data: the stub's archive window is three days long, its provider
 * is called `stub-provider`, and its agent stream never reaches a model. §16 of the parity brief
 * asks for production screenshots of populated states, and the fifth revision of the fidelity
 * review had to record that as blocked, because every product screen is behind `/sign-in`.
 *
 * This spec is the harness for unblocking it **without** the thing that made it blocked: no account
 * is created here, no password is committed, and nothing is added to CI. It reads an existing
 * production account from the environment, and **skips, naming the variables, when they are
 * absent** — which is the normal case and must stay costless.
 *
 * # Running it
 *
 * In a shell, for one command, never in a file and never in Actions:
 *
 *     WEATHRA_LIVE_USER_A_EMAIL=… WEATHRA_LIVE_USER_A_PASSWORD=… \
 *       npx playwright test tests/e2e/production-capture.spec.ts --project=chromium
 *
 * The variable names are the ones `backend/tests/live_support.py` already uses for the deployed
 * acceptance suite, so one export serves both and there is no second convention to remember.
 * `WEATHRA_LIVE_FRONTEND` overrides the target, which is how a preview deployment gets
 * photographed without editing this file.
 *
 * # What it will not do
 *
 * * **It writes nowhere near `capture/`.** Production shots land in `capture/production/`, which
 *   `.gitignore` excludes: a screenshot of a real account's screens may carry that person's saved
 *   places and their plan, and those are not repository contents. The reviewer looks at them
 *   locally and commits nothing.
 * * **It prints no value.** The skip message names the variables it wants and never their
 *   contents, and the sign-in fills the fields without logging them.
 * * **It reads only.** Every screen here is a GET. Nothing presses a control that creates, changes
 *   or removes anything — no watch is created, no plan is assigned, and the Analyst is not asked a
 *   question, because that would spend a real allowance against a real model.
 * * **It is not part of any suite.** `capture.spec.ts` is gated on `WEATHRA_CAPTURE`; this is gated
 *   on credentials being present, so a plain `npx playwright test` skips it.
 */

import { existsSync, mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

/** The deployed frontend. Overridable so a preview deployment can be photographed instead. */
const TARGET = (process.env.WEATHRA_LIVE_FRONTEND ?? "https://weathra-bice.vercel.app").replace(
  /\/+$/,
  "",
);

/**
 * The variables this spec needs, by name.
 *
 * The same two `backend/tests/live_support.py` names in `CREDENTIAL_VARIABLES`, deliberately: the
 * deployed acceptance suite already asks for these, so somebody exporting them once can run both.
 * The Supabase project URL and anon key that suite also wants are **not** needed here — the browser
 * signs in through the deployed frontend's own form, which already knows where its project is.
 */
const REQUIRED = ["WEATHRA_LIVE_USER_A_EMAIL", "WEATHRA_LIVE_USER_A_PASSWORD"] as const;

const missing = REQUIRED.filter((name) => !(process.env[name] ?? "").trim());

/** The four widths the review grades at. One is enough for evidence; four is what §13 records. */
const WIDTHS = (process.env.WEATHRA_LIVE_WIDTHS ?? "1440")
  .split(",")
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry) && entry > 0);

/**
 * The screens worth photographing against production, and only the ones a GET can reach.
 *
 * Ordered as the review's table is, so the output directory sorts into the same reading order. The
 * Analyst is present but deliberately *not* asked anything: its empty populated-by-a-question state
 * is what a person sees on opening it, and asking would spend a real model call.
 */
const SCREENS = [
  { name: "01-dashboard", path: "/" },
  { name: "02-analyst", path: "/analyst" },
  { name: "03-historical", path: "/historical" },
  { name: "04-compare", path: "/compare" },
  { name: "05-evidence", path: "/evidence" },
  { name: "06-locations", path: "/locations" },
  { name: "07-settings", path: "/settings" },
  { name: "10-plan", path: "/plan" },
  { name: "11-explorer", path: "/explorer" },
  { name: "12-report", path: "/report" },
  { name: "13-scenarios", path: "/scenarios" },
  { name: "14-watch", path: "/watch" },
  { name: "15-travel", path: "/travel" },
] as const;

const OUTPUT = "capture/production";

test.describe("production capture", () => {
  test.skip(
    missing.length > 0,
    `set ${missing.join(" and ")} in the shell to photograph the deployed screens. ` +
      "No account is created by this spec and nothing is written to CI.",
  );
  test.describe.configure({ mode: "serial" });
  // A real deployment on a cold instance is slower than a local build, and a timeout here is a
  // failed capture rather than a finding.
  test.setTimeout(120_000);

  test.beforeAll(() => {
    if (!existsSync(OUTPUT)) mkdirSync(OUTPUT, { recursive: true });
  });

  test("photographs the deployed screens signed in", async ({ page }) => {
    await page.setViewportSize({ width: WIDTHS[0] ?? 1440, height: 900 });
    await page.goto(`${TARGET}/sign-in`);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    // Filled, never logged. Playwright does not echo `fill` values into the report.
    await page.getByLabel("Email").fill(process.env.WEATHRA_LIVE_USER_A_EMAIL!);
    await page
      .getByLabel("Password", { exact: true })
      .fill(process.env.WEATHRA_LIVE_USER_A_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The shell, not a URL: the frontend resolves the session server-side and may land anywhere.
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible({
      timeout: 45_000,
    });

    const report: string[] = [];
    for (const width of WIDTHS) {
      for (const screen of SCREENS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${TARGET}${screen.path}`);
        await expect(page.getByRole("main")).toBeAttached();
        // Production reads a real provider, so the settle is longer than the stub run's.
        await page.waitForLoadState("networkidle").catch(() => {});

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 1) {
          report.push(`OVERFLOW ${screen.name} @${width}: ${overflow}px wider than the viewport`);
        }

        await page.screenshot({
          path: `${OUTPUT}/${screen.name}-${width}.png`,
          fullPage: true,
        });
      }
    }

    // Printed together at the end so one run's findings are one block rather than interleaved.
    for (const line of report) console.log(line);
    console.log(
      `Wrote ${SCREENS.length * WIDTHS.length} production screenshots to ${OUTPUT}/ ` +
        "(gitignored — review locally, commit nothing).",
    );
  });
});
