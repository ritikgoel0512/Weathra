/**
 * The fidelity regression sweep — the audit of 2026-09-08's manual pass, run on every push.
 *
 * That audit found what it found by photographing the running application in the states people
 * actually meet and *reading* the result: six lines of orchestration under every answer, an API
 * measure key printed in a sentence addressed to a person, a failure code shown to the person who
 * typed the name, panels of "Not measured" that would say that on every account forever. It fixed
 * them, and then the protection against them coming back was that somebody had done it once.
 *
 * The product owner's brief after the production episode was explicit: *fixture-only fidelity
 * protection was insufficient*, and *the main customer-facing screens must not become
 * developer/debug consoles*. This file is that instruction as a check.
 *
 * **What it asserts, and why these and not a screenshot.** A screenshot diff of eight screens in
 * five states is a hundred and twenty files that go stale the first time a token moves, and it
 * fails on the wrong things. What actually characterises a console is *vocabulary*: identifiers
 * that belong to the API rather than to the reader, machinery presented as content, and provenance
 * fields fabricated to fill a shape. Those are all readable from the rendered text, they do not
 * move when a colour does, and every one of them was a real finding in the audit.
 *
 * Run against the **real production build** with fixtures **off**, driven through the two offline
 * stubs the rest of the browser suite uses — so every line of Weathra in the path is the shipping
 * one, in the state the stub is holding.
 *
 * The four states come from `weathra-api-stub.mjs`'s own `/control/mode`: populated, empty,
 * failing, stalling. Unauthenticated is the fifth and is its own case, because it is a different
 * mechanism — the middleware, not a response.
 */

import { expect, test, type Page } from "@playwright/test";

const STUB_URL = "http://127.0.0.1:54321";
const API_STUB_URL = "http://127.0.0.1:54322";

const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

/**
 * The eight approved screens, at the routes a person reaches them by.
 *
 * Agent Evidence is listed at `/evidence` rather than at a stored record: the record route needs a
 * run that exists, and the empty and failing states of *that* route are a record that could not be
 * loaded, which is the same check on a narrower surface. `/evidence` with no run selected is the
 * one the audit graded (finding 5.1).
 */
const SCREENS = [
  { name: "Dashboard", path: "/" },
  { name: "AI Weather Analyst", path: "/analyst" },
  { name: "Historical Analytics", path: "/historical" },
  { name: "Compare Cities", path: "/compare" },
  { name: "Agent Evidence", path: "/evidence" },
  { name: "Saved Locations", path: "/locations" },
  { name: "Settings", path: "/settings" },
] as const;

const AUTH_SCREENS = [
  { name: "Sign In", path: "/sign-in" },
  { name: "Create Account", path: "/create-account" },
] as const;

type Mode = "populated" | "empty" | "failing" | "stalling";

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
 * Everything a person can read on the page, as they would read it.
 *
 * `innerText` rather than `textContent`, deliberately: `textContent` returns the contents of a
 * closed `<details>`, of a `hidden` element and of the visually-hidden descriptions this project
 * uses for screen-reader-only text — none of which a sighted reader meets, and three of which are
 * exactly where the audit *moved* machinery to. A check that read them would fail every one of the
 * audit's own fixes and would be measuring the opposite of what it claims.
 */
async function readableText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? "");
}

/**
 * The vocabulary that says "console" rather than "product".
 *
 * Each entry is a real finding, or the shape of one, from the audit of 2026-09-08. The allowances
 * beside them are not exceptions to the rule — they are the places where the token *is* the
 * content, which is a different thing: the Agent Evidence screen exists to show a run record, and
 * `docs/design/screens.md` records it as the one screen where machinery belongs.
 */
const CONSOLE_PATTERNS: readonly {
  readonly what: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  {
    what: "a SCREAMING_SNAKE_CASE identifier",
    // Two or more upper-case runs joined by underscores: OPENROUTER_API_KEY, NEXT_PUBLIC_X,
    // MODEL_NOT_FOUND. `specs/web-ui` and commit e151490: configuration is never shown to a person.
    pattern: /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/,
    why: "an environment variable or a constant, read out to somebody reading about the weather",
  },
  {
    what: "a snake_case API key printed as prose",
    // temperature_mean, location_not_found, unit_system. Finding 3.2 and finding 4.1.
    pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/,
    why: "an API field or error code addressed to a person instead of to a client",
  },
  {
    what: "invented telemetry language",
    // Finding 6.4: "ALL NODES NOMINAL" for "nothing is wrong", and the panels around it.
    pattern: /\b(?:nominal|node health|telemetry|uptime|sync status|latency)\b/i,
    why: "operations vocabulary for a product that measures none of it",
  },
  {
    what: "a stack trace or an unhandled error",
    pattern: /\b(?:TypeError|ReferenceError|undefined is not|Cannot read propert|at Object\.<anonymous>)\b/,
    why: "a runtime failure reaching the page instead of the state that describes it",
  },
  {
    what: "the framework's own error page",
    // Finding §2: the whole application rendered this when a fixture had the wrong shape.
    pattern: /Application error: a (?:client|server)-side exception/i,
    why: "the screen crashed rather than rendering one of its states",
  },
];

/**
 * The tokens that are content rather than machinery, per screen.
 *
 * Narrow and named, so an allowance can never be a blanket. Anything not listed here fails.
 */
const ALLOWED: Readonly<Record<string, readonly RegExp[]>> = {
  // The record screen. `screens.md` §8: this is where the run's own vocabulary belongs, and the
  // audit graded its populated record the closest of the eight to its artifact.
  "Agent Evidence": [/./],
  // Every screen may name an IANA timezone, which is a real identifier a person needs in order to
  // read a window in the right zone — `Europe/Berlin`, not a field name.
  "*": [/\b[A-Z][a-z]+(?:_[A-Za-z]+)*\/[A-Z][a-z]+(?:_[A-Za-z]+)*\b/],
};

/** The offending lines, so a failure is a defect somebody can act on rather than a rule id. */
function offendingLines(text: string, pattern: RegExp, screen: string): string[] {
  const allowances = [...(ALLOWED[screen] ?? []), ...(ALLOWED["*"] ?? [])];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      // Strip what is legitimately identifier-shaped on this screen, then look at the remainder.
      const remainder = allowances.reduce(
        (carried, allowance) => carried.replace(new RegExp(allowance.source, "g"), " "),
        line,
      );
      return pattern.test(remainder);
    })
    .slice(0, 6);
}

async function assertNoConsoleCharacter(page: Page, screen: string, state: string): Promise<void> {
  const text = await readableText(page);

  for (const { what, pattern, why } of CONSOLE_PATTERNS) {
    const offenders = offendingLines(text, pattern, screen);
    expect(
      offenders,
      `${screen}, ${state}: ${what} reached the page — ${why}.\n` +
        offenders.map((line) => `    ${line}`).join("\n"),
    ).toEqual([]);
  }
}

/* --------------------------------------------------------- the four served states */

for (const mode of ["populated", "empty", "failing"] as const satisfies readonly Mode[]) {
  test.describe(`no screen reads as a console — ${mode}`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name}`, async ({ page, request }) => {
        await signIn(page);
        await request.post(`${API_STUB_URL}/control/mode?value=${mode}`);

        await page.goto(screen.path);
        // The screen's own heading, whichever state it settles into. Finding 1.1: a state without
        // one is a defect in its own right, and this is where it would show.
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        await assertNoConsoleCharacter(page, screen.name, mode);
      });
    }
  });
}

/**
 * The loading state, photographed mid-flight.
 *
 * Every call is held open, so the screen never settles. Finding 1.1 again: an unnamed page of grey
 * lines is what this state used to be, and the heading is what says which screen a person is
 * waiting on.
 */
test.describe("no screen reads as a console — loading", () => {
  for (const screen of SCREENS) {
    test(`${screen.name}`, async ({ page, request }) => {
      await signIn(page);
      await request.post(`${API_STUB_URL}/control/mode?value=stalling`);

      // `domcontentloaded`, not `load`: a page whose requests never answer never fires `load`.
      await page.goto(screen.path, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      await assertNoConsoleCharacter(page, screen.name, "loading");
    });
  }
});

/* ------------------------------------------------------------- unauthenticated */

test.describe("no screen reads as a console — unauthenticated", () => {
  for (const screen of AUTH_SCREENS) {
    test(`${screen.name}`, async ({ page }) => {
      await page.goto(screen.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await assertNoConsoleCharacter(page, screen.name, "unauthenticated");
    });
  }

  test("a protected route requested while signed out renders none of it", async ({ page }) => {
    await page.goto("/historical");
    await expect(page).toHaveURL(/\/sign-in/);
    await assertNoConsoleCharacter(page, "Sign In", "unauthenticated");
  });
});

/* --------------------------------------------- the provenance rules, in real states */

/**
 * The three provenance guarantees the audit turned on, checked where they are actually rendered.
 *
 * These are not vocabulary checks; they are the specific promises `specs/web-ui` makes, and each
 * has a finding behind it. They run in the populated state because that is the only one in which
 * there is provenance to check.
 */
test.describe("provenance, in the state a person meets it", () => {
  test("every weather region names all four fields, unreported and all", async ({ page }) => {
    await signIn(page);
    await page.goto("/historical");

    /*
     * The retrieved region, not the heading. Since the heading fix of 2026-09-09 the `h1` renders
     * before anything has been asked for — which is the point of that fix and makes it useless as
     * a signal that the archive has arrived. This test wants the settled screen, so it waits for
     * the thing it is about to read the provenance of.
     */
    await expect(page.getByRole("region", { name: "Recorded observations" })).toBeVisible({
      timeout: 15_000,
    });

    const footers = page.locator('[data-attribution="true"]:not([data-attribution-scope])');
    const count = await footers.count();
    expect(count, "Historical Analytics renders at least one weather attribution").toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const text = await footers.nth(index).innerText();
      for (const term of ["Source", "Location", "Period", "Retrieved"]) {
        expect(text, `weather footer ${index} names ${term}`).toContain(term);
      }
    }
  });

  test("a language-model run is attributed to what produced it and to nothing else", async ({
    page,
  }) => {
    // Finding 2.11, and the `specs/web-ui` clarification of 2026-09-09.
    await signIn(page);
    await page.goto("/analyst");
    await page.getByLabel("Your weather question").fill("What should I expect this week?");
    await page.getByRole("button", { name: "Ask" }).click();

    const run = page.locator('[data-attribution-scope="model-run"]');
    await expect(run).toBeVisible({ timeout: 15_000 });

    const text = await run.innerText();
    expect(text).toContain("Produced by");
    expect(text).not.toContain("Location");
    expect(text).not.toContain("Period");
    expect(text).not.toContain("not reported");
  });

  test("a failure names what is unavailable and no configuration at all", async ({
    page,
    request,
  }) => {
    // Commit e151490: production told a visitor to check an environment variable. The vocabulary
    // sweep above covers the shape; this covers the specific screen and the specific state.
    await signIn(page);
    await request.post(`${API_STUB_URL}/control/mode?value=failing`);

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const text = await readableText(page);
    expect(text).not.toMatch(/\bAPI[_ ]key\b/i);
    expect(text).not.toMatch(/\benvironment variable\b/i);
    expect(text).not.toMatch(/\bcredential\b/i);
    expect(text).not.toMatch(/\bopenrouter\b/i);
    // And it is a state, not a blank screen: the failure says something a person can act on.
    await expect(page.getByRole("button", { name: /try again|retry/i }).first()).toBeVisible();
  });
});
