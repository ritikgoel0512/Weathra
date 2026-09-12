/**
 * Screenshots of the real build, for the fidelity work — not an assertion suite.
 *
 * The 2026-09-08 runtime audit was produced this way and recorded why: a component test cannot see
 * layout, density or hierarchy, so a fidelity judgement made without looking at the running screen
 * is a judgement about source code. This spec exists so that judgement can be made from pictures
 * again, at the four widths the design system names.
 *
 * It is skipped unless `WEATHRA_CAPTURE` is set, so it costs nothing in CI.
 */

import { expect, test } from "@playwright/test";

import { API_STUB_URL, STUB_URL } from "../../playwright.config";

/** The stub accepts any credentials; these are the ones the other specs use. */
const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

const CAPTURING = process.env.WEATHRA_CAPTURE === "true";

/**
 * The widths `design-system.md` §13 names, and the reason each is here.
 *
 * 1440 is the width the artifacts are drawn at, so it is the one fidelity is judged against. 1024
 * is the tablet breakpoint the two-column bands collapse at. 768 is below it, where the shell's
 * rail gives way. 375 is a phone, and it is the width that finds the defects the others cannot: a
 * table that widens its container, a KPI row that will not fold, a number that cannot wrap.
 *
 * Set `WEATHRA_WIDTHS=1440` to photograph one of them.
 */
const WIDTHS = (process.env.WEATHRA_WIDTHS ?? "1440,1024,768,375")
  .split(",")
  .map((width) => Number(width.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);

/**
 * `WEATHRA_SCREENS=01-dashboard,09-admin` photographs only those, so a targeted check after one
 * change does not re-run the whole matrix.
 */
const ONLY = (process.env.WEATHRA_SCREENS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const ALL_SCREENS = [
  { name: "01-dashboard", path: "/" },
  /*
   * The Analyst, photographed with an answer in it.
   *
   * The production fidelity review of 2026-09-10 graded this screen NOT CLOSE and said why: "ours
   * cannot be photographed populated without a live model call, and a screen that has only ever
   * been seen empty is not close to one that is full." The first half of that was wrong about this
   * harness. `weathra-api-stub.mjs` models `POST /agent/stream` — it is what `flows.spec.ts` drives
   * — so the shipping bundle can be photographed with a real streamed answer rendered by the real
   * components, with no inference provider and no allowance spent. Not asking was the omission.
   *
   * The empty state is not lost with it: it is the state every width was photographed in until
   * now, `analyst.test.tsx` holds it, and the composition either way is the point of the rebuild.
   */
  /*
   * The question is one that uses two retrieval capabilities, and that is the point of it.
   *
   * It was the archive comparison, which is a real successful answer and could not populate the
   * Current conditions panel — until task 34.33 nothing in the graph could, because the catalog was
   * forecast, historical, analytics and rag. This asks what it is like now *and* what is coming, so
   * the capture shows the two retrieval panels side by side with a run behind each of them.
   */
  {
    name: "02-analyst",
    path: "/analyst",
    ask: "What's it like in Berlin right now, and what should I expect over the next few days?",
  },
  /*
   * The Analyst with no place to work from — task 34.33.
   *
   * The 2026-09-12 review rejected this screen on the *clarification*, not on the answer: a run
   * that correctly refused to guess a city was drawn as a completed report with empty panels, and
   * the screen offered no way to supply the place it was asking for. So the state has its own
   * picture now, and it is reached the way a customer reaches it — the saved default cleared
   * through the real preferences endpoint, then a question that names nowhere.
   */
  {
    name: "02-analyst-clarify",
    path: "/analyst",
    clearDefault: true,
    ask: "What should I expect over the next few days?",
  },
  /*
   * The Analyst with satellite evidence in the answer — task 34.35.
   *
   * Its own picture rather than a change to `02-analyst`, because the two states are both real and
   * a screen has to be judged in each: a run that retrieved imagery draws a panel a run that did
   * not must not draw, and only a photograph of both settles whether that reads.
   */
  {
    name: "02-analyst-satellite",
    path: "/analyst",
    ask: "Show me the latest satellite imagery for Berlin alongside the forecast.",
  },
  { name: "03-historical", path: "/historical" },
  { name: "04-compare", path: "/compare", prepare: "Compare" },
  { name: "06-locations", path: "/locations" },
  { name: "07-settings", path: "/settings" },
  { name: "10-plan", path: "/plan" },
  { name: "11-explorer", path: "/explorer" },
  { name: "12-report", path: "/report" },
  { name: "13-scenarios", path: "/scenarios", prepare: "Run this scenario" },
  { name: "14-watch", path: "/watch" },
  {
    name: "15-travel",
    path: "/travel",
    // The ranking is on demand, so an unprepared capture photographs the empty state and says
    // nothing about the screen. Pressing the control the screen exists for is what the picture is
    // supposed to show; the figures behind it are the stub's, shaped as the endpoint returns them.
    prepare: "Rank these days",
  },
  /*
   * Agent Evidence, photographed as a populated record.
   *
   * `05-agent-evidence.png` is a populated execution trace, and `/evidence` with no run id is
   * deliberately the empty workspace — so photographing that route compared an empty screen with a
   * full one and graded the difference as the screen's. The record the stub stores for the streamed
   * run is the right comparison; the empty workspace is still photographed beside it, under its own
   * name, because it is a real state this pass also rebuilt.
   */
  { name: "05-evidence", path: "/evidence/run-e2e-1" },
  { name: "05-evidence-empty", path: "/evidence" },
  // Task 34.18 built it, and the stub now models the administrative reads, so it is photographed
  // rather than judged from source as it was in the first fidelity review.
  { name: "09-admin", path: "/admin/model-usage" },
] as const;

const SCREENS = ONLY.length === 0 ? ALL_SCREENS : ALL_SCREENS.filter((screen) => ONLY.includes(screen.name));

test.describe("capture", () => {
  test.skip(!CAPTURING, "set WEATHRA_CAPTURE=true to write screenshots");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    // Both stubs start in whatever state the previous spec left them.
    await request.post(`${STUB_URL}/control/restore`);
    await request.post(`${API_STUB_URL}/control/restore`);
  });

  /**
   * The one screen a signed-in session cannot photograph.
   *
   * `08-authentication.png` was the review's other NOT REVIEWED row, and for a duller reason than
   * the administrative one: every other capture signs in first, and after that the sign-in screen
   * redirects. So it is taken before the session exists, in its own test.
   */
  test("captures 08-authentication", async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/sign-in");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) {
        console.log(`OVERFLOW 08-authentication @${width}: ${overflow}px wider than the viewport`);
      }

      await page.screenshot({ path: `capture/08-authentication-${width}.png`, fullPage: true });
    }
  });

  for (const screen of SCREENS) {
    test(`captures ${screen.name}`, async ({ page }) => {

      // Every screen here is protected, so the run signs in first and the cookie carries.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(screen.path);
        // The shell resolves the session server-side, so the wait is on rendered structure rather
        // than on a timer.
        // The main landmark, not the navigation: below 768 the rail is a drawer that does not
        // exist until its Menu control is pressed, so waiting on it would hang at the two narrow
        // widths this pass was added to photograph.
        await expect(page.getByRole("main")).toBeAttached();
        // Give the screen's own reads a moment to settle into their populated or empty states.
        await page.waitForLoadState("networkidle").catch(() => {});

        /*
         * A screen photographed as an account with no saved default location.
         *
         * Through `PUT /me/preferences`, which is the endpoint Settings uses — so what is
         * photographed is a real account state rather than a fixture the harness invented, and the
         * resolution ladder reaches its bottom step for the ordinary reason.
         */
        const clearDefault =
          "clearDefault" in screen ? (screen as { clearDefault?: boolean }).clearDefault : false;
        if (clearDefault === true) {
          await page.request.put(`${API_STUB_URL}/api/v1/me/preferences`, {
            data: { clear_default_location: true },
            headers: { "content-type": "application/json" },
          });
          await page.reload();
          await expect(page.getByRole("main")).toBeAttached();
          await page.waitForLoadState("networkidle").catch(() => {});
        }

        // A screen whose content is behind a control is photographed with the control pressed.
        const prepare = "prepare" in screen ? (screen as { prepare?: string }).prepare : undefined;
        if (prepare !== undefined) {
          const control = page.getByRole("button", { name: prepare, exact: true }).first();
          if (await control.isVisible().catch(() => false)) {
            await control.click();
            await page.waitForLoadState("networkidle").catch(() => {});
          }
        }

        /*
         * A screen whose content is behind a *question* is photographed with one asked.
         *
         * The composer, then the submit, then the answer — waited on by its rendered region rather
         * than by a timer, because the stream settles when it settles. A failure to produce one is
         * not fatal here: this spec is evidence, and a screenshot of the run that did not finish is
         * still the picture of what the build does.
         */
        const question = "ask" in screen ? (screen as { ask?: string }).ask : undefined;
        if (question !== undefined) {
          const composer = page.getByLabel("Your weather question");
          if (await composer.isVisible().catch(() => false)) {
            await composer.fill(question);
            await page.getByRole("button", { name: "Ask Weathra" }).click();
            await Promise.race([
              page
                .getByRole("region", { name: "AI interpretation" })
                .waitFor({ state: "visible", timeout: 15_000 }),
              // A run that asked for a place renders no interpretation region at all — waiting only
              // on that one would spend the whole timeout on the state this entry exists to
              // photograph.
              page
                .getByText(/Which place should Weathra look at/)
                .waitFor({ state: "visible", timeout: 15_000 }),
            ]).catch(() => {});
            await page.waitForLoadState("networkidle").catch(() => {});
          }
        }

        /*
         * **Wait for the location-image chain to settle.**
         *
         * `LocationImage` paints the drawn artwork immediately and replaces it when the resolver
         * answers, which is what keeps the frame from being empty — and it means a screenshot taken
         * the instant the network goes quiet can catch the artwork on one card and the photograph on
         * the other. The first Compare Cities capture of task 34.31 did exactly that.
         *
         * This waits for no frame to be on the generated tier any more, and gives up quietly when
         * one genuinely is: a place with no photograph anywhere in the chain is a real state, and
         * photographing it is the point of the harness rather than a failure of it.
         */
        await page
          .waitForFunction(
            () => document.querySelectorAll('[data-source="generated"]').length === 0,
            undefined,
            /*
              Long enough for a cold chain. A place resolves through up to two Wikimedia calls with
              a six-second timeout each, and two places resolve in parallel — so six seconds is
              under the worst case and the first correction capture of task 34.31 caught exactly
              that: one card photographed with its photograph and the other with its drawing.
            */
            { timeout: 15_000 },
          )
          .catch(() => {});

        /*
         * …and then for the bytes. The tier flips the moment the *resolver* answers; the `<img>`
         * then has a photograph to fetch and decode, and a screenshot taken between the two catches
         * the token-built field behind it — a teal wash where a city should be, which is what the
         * second Compare Cities capture of task 34.31 shows on one of its two cards.
         */
        await page
          .evaluate(
            () =>
              Promise.race([
                Promise.all(
                  Array.from(document.images)
                    .filter((image) => !image.complete)
                    .map(
                      (image) =>
                        new Promise((settle) => {
                          image.addEventListener("load", settle, { once: true });
                          image.addEventListener("error", settle, { once: true });
                        }),
                    ),
                ),
                /*
                  Capped, because a `loading="lazy"` image below the fold fires neither event until
                  it is scrolled to — and waiting on one of those waits forever, which is what took
                  this spec past its own timeout the first time it was written without the race.
                */
                new Promise((settle) => setTimeout(settle, 4000)),
              ]),
          )
          .catch(() => {});

        // A horizontal scrollbar on the document is the defect this pass exists to find: a screen
        // that pushes the page sideways rather than scrolling its own wide table. Recorded beside
        // the screenshot rather than failed on, because this spec is evidence and not a gate.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 1) {
          console.log(`OVERFLOW ${screen.name} @${width}: ${overflow}px wider than the viewport`);
        }

        await page.screenshot({
          path: `capture/${screen.name}-${width}.png`,
          fullPage: true,
        });
      }
    });
  }
});
