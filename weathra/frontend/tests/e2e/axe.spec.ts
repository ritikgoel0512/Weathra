/**
 * axe-core over every MVP screen — task 21.8's rule-based half.
 *
 * `tests/accessibility.test.tsx` asserts the things Weathra *decided*: that this input has a label,
 * that this chooser is a named group, that headings descend a level at a time. Those are assertions
 * somebody wrote because they knew what to look for, and their blind spot is by definition the
 * things nobody thought to check.
 *
 * axe-core is the other direction: a corpus of rules maintained by people who audit for a living,
 * run against the rendered page, which finds the classes of defect this project has not thought of
 * yet. The two overlap on some rules and neither subsumes the other — a rule engine cannot know that
 * Weathra must not preselect a location candidate, and a hand-written assertion would not have
 * thought to check that a `<select>`'s accessible name survives the appearance change.
 *
 * Run against the **real production build** through the same harness as `accessibility.spec.ts`,
 * on both engines the config declares, at the 360-pixel floor and at desktop width, in both
 * appearances — because a contrast rule and a target-size rule give different answers at different
 * widths and in different palettes, and checking one combination would be checking a quarter of it.
 *
 * **Tags.** WCAG 2.0 and 2.1 at A and AA, which is what `specs/web-ui` requires, plus WCAG 2.2 AA
 * — that last one is where `target-size` lives, and target size is the part of "usable at 360
 * pixels" that a viewport measurement cannot see. `best-practice` is deliberately not included:
 * those rules are advice rather than the standard, and folding them in would mean this suite failed
 * for reasons the spec does not ask for.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const STUB_URL = "http://127.0.0.1:54321";
const API_STUB_URL = "http://127.0.0.1:54322";

const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The floor `docs/design/design-system.md` §13 names, and the width most people use. */
const WIDTHS = [360, 1440] as const;

const PRODUCT_SCREENS = [
  { name: "Dashboard", path: "/", marker: "Current conditions" },
  { name: "AI Weather Analyst", path: "/analyst", marker: "Your weather question" },
  { name: "Historical Analytics", path: "/historical", marker: "Recorded observations" },
  { name: "Compare Cities", path: "/compare", marker: "Location 1" },
  { name: "Agent Evidence", path: "/evidence/run-stub", marker: "Execution flow" },
  { name: "Saved Locations", path: "/locations", marker: "Add a location" },
  { name: "Settings", path: "/settings", marker: "Weather preferences" },
] as const;

const AUTH_SCREENS = [
  { name: "Sign In", path: "/sign-in", marker: "Sign in" },
  { name: "Create Account", path: "/create-account", marker: "Create account" },
  { name: "Verify Email", path: "/verify-email", marker: "Verify" },
  { name: "Forgot Password", path: "/forgot-password", marker: "Send" },
  { name: "Reset Password", path: "/reset-password", marker: "password" },
] as const;

test.beforeEach(async ({ request, context }) => {
  await context.clearCookies();
  await request.post(`${STUB_URL}/control/restore`);
  await request.post(`${API_STUB_URL}/control/restore`);
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Every violation, said in enough detail to fix without re-running.
 *
 * A bare rule id is not actionable — `color-contrast` on a screen with two hundred elements could
 * be any of them. So each violation reports its rule, its impact, the help text, and the specific
 * elements, which is what turns a failure into a defect somebody can act on.
 */
function describeViolations(
  violations: readonly {
    id: string;
    impact?: string | null;
    help: string;
    nodes: readonly { target: unknown[]; failureSummary?: string }[];
  }[],
): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .slice(0, 5)
        .map(
          (node) =>
            `      - ${node.target.join(" ")}\n        ${(node.failureSummary ?? "").replace(/\n/g, "\n        ")}`,
        )
        .join("\n");
      const extra =
        violation.nodes.length > 5 ? `\n      …and ${violation.nodes.length - 5} more` : "";
      return `  ${violation.id} (${violation.impact ?? "unknown"}) — ${violation.help}\n${nodes}${extra}`;
    })
    .join("\n");
}

async function audit(page: Page): Promise<string> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.length === 0 ? "" : describeViolations(results.violations);
}

for (const scheme of ["dark", "light"] as const) {
  for (const width of WIDTHS) {
    test.describe(`axe-core, ${scheme} appearance at ${width} pixels`, () => {
      test("the authentication screens have no violations", async ({ browser }) => {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport: { width, height: 900 },
        });
        const page = await context.newPage();

        const problems: string[] = [];
        for (const screen of AUTH_SCREENS) {
          await page.goto(screen.path);
          await expect(page.getByText(screen.marker).first()).toBeVisible();

          const found = await audit(page);
          if (found) problems.push(`${screen.name} — ${scheme}, ${width}px:\n${found}`);
        }

        await context.close();
        // Every screen, not only as far as the first one that fails — one run should say what the
        // whole set needs.
        expect(problems.join("\n\n"), problems.join("\n\n")).toBe("");
      });

      test("the product screens have no violations", async ({ browser }) => {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport: { width, height: 900 },
        });
        const page = await context.newPage();
        await signIn(page);

        const problems: string[] = [];
        for (const screen of PRODUCT_SCREENS) {
          await page.goto(screen.path);
          await expect(page.getByText(screen.marker).first()).toBeVisible();

          const found = await audit(page);
          if (found) problems.push(`${screen.name} — ${scheme}, ${width}px:\n${found}`);
        }

        await context.close();
        expect(problems.join("\n\n"), problems.join("\n\n")).toBe("");
      });
    });
  }
}

/**
 * The states a person reaches by doing something.
 *
 * A screen audited only as it first paints is audited in the one state that has no interaction in
 * it. These three are where Weathra's own markup does the most work — a group of candidate buttons
 * built from a response, a confirmation gated on typed text, and a drawer that takes the navigation
 * in and out of the tab order — so they are audited in the state a person actually meets.
 */
test.describe("axe-core, the interactive states", () => {
  test("the location candidate chooser has no violations", async ({ page }) => {
    await signIn(page);
    await page.goto("/locations");

    // The add form is a disclosure now — `06-saved-locations.png` shows one "Add New Node"
    // control in the header, not a form owning the page. Opening it is the real first step.
    await page.locator("summary", { hasText: "Add a location" }).click();
    await page.getByLabel("Place").fill("Springfield");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(
      page.getByRole("group", { name: "Places matching what you entered" }),
    ).toBeVisible();

    const found = await audit(page);
    expect(found, `the candidate chooser:\n${found}`).toBe("");
  });

  test("the destructive confirmation has no violations", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");

    await page.getByRole("tab", { name: "Account" }).click();
    await page.getByRole("button", { name: "Delete my Weathra data" }).click();
    await expect(
      page.getByRole("group", { name: "Delete every Weathra record belonging to you?" }),
    ).toBeVisible();

    const found = await audit(page);
    expect(found, `the destructive confirmation:\n${found}`).toBe("");
  });

  test("the open navigation drawer has no violations", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();

    const found = await audit(page);
    expect(found, `the open drawer:\n${found}`).toBe("");
  });
});
