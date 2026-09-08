/**
 * The four product flows task 21.10 requires, end to end in a real browser.
 *
 * The task names them precisely, and they are implemented as named, not as approximations:
 *
 *   1. sign up through verification into the product
 *   2. ask a question then open its evidence
 *   3. save a location then see the unit preference applied
 *   4. an expired session routed to sign-in
 *
 * Each drives the **real production build** through the harness `playwright.config.ts` establishes:
 * the real middleware, the real server-resolved layout, the real `@supabase/ssr` cookie session, the
 * real API client with its bearer-only `credentials: "omit"`, the real SSE reader, and the real
 * screens. The only stand-ins are the two processes beyond Weathra's own boundaries — the identity
 * provider (`supabase-stub.mjs`) and the FastAPI backend with its inference provider
 * (`weathra-api-stub.mjs`) — which keep the suite offline, deterministic, and free of any real
 * credential or real inference call.
 *
 * **The stubs model the production contracts**, not a convenience API: the GoTrue paths and error
 * codes for sign-up and verification, the eight-event SSE vocabulary and framing of
 * `backend/weathra/api/streaming.py` with its monotonic sequence, the evidence-by-identifier
 * lookup, the saved-location and preference contracts with their real methods, and the 401 envelope
 * that drives session expiry. Nothing here is asserted through a test-only endpoint.
 *
 * **What the assertions are about.** User-visible outcomes: text a person would read, controls they
 * would press, and figures rendered in the units they chose. A URL or a status code is checked only
 * where the requirement is itself about routing — flow 4's destination, for instance — and never as
 * a substitute for having seen the screen change.
 */

import { expect, test, type Page } from "@playwright/test";

const STUB_URL = "http://127.0.0.1:54321";
const API_STUB_URL = "http://127.0.0.1:54322";

/** The account the identity stub holds, and the code it accepts. Neither is a real credential. */
const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };
const NEW_ACCOUNT = { email: "avery@example.test", password: "correct-horse-battery-staple" };
const VERIFICATION_CODE = "424242";

/**
 * Every flow starts from the same state — task 21.10's isolation requirement.
 *
 * Both stubs are restored and the browser's cookies cleared, which resets the provider's session
 * validity and its half-finished sign-up, and the backend's saved locations, preferences and
 * request log. Without this, flow 3's saved location would still be there for flow 2 to find and
 * flow 1's verification could be satisfied by a sign-up another flow left pending.
 */
test.beforeEach(async ({ request, context }) => {
  await context.clearCookies();
  await request.post(`${STUB_URL}/control/restore`);
  await request.post(`${API_STUB_URL}/control/restore`);
});

/** Sign in through the real form, as a person would. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Current conditions")).toBeVisible();
}

/* ============================================================ flow 1 */

test.describe("flow 1 — sign up through verification into the product", () => {
  test("a new account creates, verifies with a code, and lands inside the product", async ({
    page,
  }) => {
    // --- create the account, through the real form ---
    await page.goto("/create-account");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

    await page.getByLabel("Email").fill(NEW_ACCOUNT.email);
    await page.getByLabel("Password", { exact: true }).fill(NEW_ACCOUNT.password);
    await page.getByRole("button", { name: /Create account/i }).click();

    // --- the screen sends them to verification, carrying the address ---
    // Signing up returns no session, because the account is not yet confirmed: this is the step the
    // flow is named after, and it is not skippable.
    await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
    await expect(page.getByText(NEW_ACCOUNT.email)).toBeVisible();

    // --- a wrong code is refused, and says so, without admitting anybody ---
    const codeField = page.getByLabel(/code/i).first();
    await codeField.fill("000000");
    await page.getByRole("button", { name: /Verify|Confirm/i }).first().click();
    // Scoped rather than `getByRole("alert")`: this screen carries more than one live region, and a
    // bare role match would be ambiguous about which one spoke.
    await expect(page.getByRole("alert").filter({ hasText: /code|expired|incorrect/i }).first()).toBeVisible();
    // Still outside: no session was issued by a refused code.
    await expect(page.getByRole("button", { name: "Continue to Weathra" })).toBeHidden();

    // --- the right code verifies, and the success state offers the way in ---
    await codeField.fill(VERIFICATION_CODE);
    await page.getByRole("button", { name: /Verify|Confirm/i }).first().click();

    const proceed = page.getByRole("button", { name: "Continue to Weathra" });
    await expect(proceed).toBeVisible();
    await proceed.click();

    // --- inside the product, on a screen only a session can render ---
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Current conditions")).toBeVisible();
    // And the shell is the authenticated one: its navigation exists only for a signed-in person.
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();
  });
});

/* ============================================================ flow 2 */

test.describe("flow 2 — ask a question then open its evidence", () => {
  test("streams a run, shows the grounded answer, and opens the record it produced", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/analyst");
    await expect(page.getByLabel("Your weather question")).toBeVisible();

    // --- ask, through the real composer ---
    await page
      .getByLabel("Your weather question")
      .fill("How does this week compare with the same week last year?");
    await page.getByRole("button", { name: "Ask Weathra" }).click();

    // --- the run's progress is rendered from the stream's own events ---
    // The region exists only once events have arrived, and each row came from one of them: routing,
    // three retrieval agents with their tool calls, then synthesis.
    const progress = page.getByRole("region", { name: "Run progress" });
    await expect(progress).toBeVisible();
    await expect(progress.locator("li[data-step]").first()).toBeVisible();
    await expect
      .poll(async () => progress.locator("li[data-step]").count(), { timeout: 20_000 })
      .toBeGreaterThan(3);
    // A tool call is reported as a tool call, with the agent that made it.
    await expect(progress.locator('li[data-step="tool"]').first()).toBeVisible();

    // --- the answer arrives, assembled from the streamed deltas ---
    // The pieces are split mid-sentence in the stub, so seeing the whole sentence proves the
    // accumulation rather than one lucky frame.
    await expect(
      page.getByText("sits above the four-year baseline for the same week", { exact: false }),
    ).toBeVisible();

    // --- the provenance boundary is still legible on the answer ---
    // The prose is badged as interpretation, the answer states what it resolved to, and no
    // ungrounded-figure warning is raised. The Analyst deliberately says nothing when grounding
    // *succeeded* — it warns only on failure — so a positive "verified" string is asserted on the
    // record below, where it is rendered, rather than invented here.
    await expect(page.getByText("AI INTERPRETATION").first()).toBeVisible();
    /*
     * The resolved context is a disclosure on the answer, not a landmark region.
     *
     * The rail beside the conversation states the same place, window and unit system plainly, and
     * the runtime audit of 2026-09-08 photographed both copies on one screen. The copy that travels
     * with an individual answer opens on request — so this asserts the affordance is there and that
     * opening it shows what the run resolved to, which is the behaviour the flow cares about.
     */
    const resolved = page.locator('details[aria-label="What this answer resolved to"]');
    await expect(resolved).toBeVisible();
    await resolved.getByText("What this answer resolved to").click();
    await expect(resolved.getByText(/from your saved default/)).toBeVisible();
    await expect(page.getByText(/could not be matched to the evidence/i)).toHaveCount(0);

    // --- the evidence affordance came from the run, and is followed through the UI ---
    // The rail offers the same action, as `02-ai-weather-analyst.png` does. This flow is about
    // following it from the answer, so it asks the answer's own region.
    const evidenceLink = page
      .getByRole("article")
      .getByRole("link", { name: "View full agent evidence" });
    await expect(evidenceLink).toBeVisible();
    // The identifier is the backend's, carried by the stream's terminal event — this flow never
    // constructs one. Read it off the link to prove that, then follow the link itself.
    const href = await evidenceLink.getAttribute("href");
    expect(href).toMatch(/^\/evidence\/[^/]+$/);
    await evidenceLink.click();

    // --- the record for that run is rendered ---
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("heading", { name: "Agent evidence", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Execution flow" })).toBeVisible();

    // --- and the three provenance tiers remain distinguishable on the record ---
    // Retrieved sources, figures Weathra computed, and the model's prose are each labelled, which
    // is the distinction `specs/safety-grounding` exists to keep.
    await expect(page.getByRole("region", { name: "Grounded data sources" })).toBeVisible();
    await expect(page.getByText("AI INTERPRETATION").first()).toBeVisible();
    /*
     * The claim is on the face of the provenance line; the arithmetic behind it is one disclosure
     * deep. Both halves are asserted, because the runtime fidelity pass moved the second half and
     * the point of this line is that neither half was lost.
     */
    const method = page.locator("[data-method-note] details").first();
    const summary = method.locator("summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Computed by Weathra");
    await summary.click();
    await expect(method.getByText(/Computed by Weathra, deterministically/i)).toBeVisible();
    // The grounding verdict, stated on the record.
    await expect(page.getByText(/Grounding verified/i).first()).toBeVisible();
  });
});

/* ============================================================ flow 3 */

test.describe("flow 3 — save a location then see the unit preference applied", () => {
  test("saves a place, chooses imperial, and the briefing renders in Fahrenheit", async ({
    page,
  }) => {
    await signIn(page);

    // --- save a location, through the real screen ---
    await page.goto("/locations");
    await expect(page.getByRole("region", { name: "Your saved locations" })).toBeVisible();

    // The add form is a disclosure now — `06-saved-locations.png` shows one "Add New Node"
    // control in the header, not a form owning the page. Opening it is the real first step.
    await page.locator("summary", { hasText: "Add a location" }).click();
    await page.getByLabel("Place").fill("Hamburg");
    await page.getByRole("button", { name: "Save location" }).click();

    // The save is confirmed by the *resolved* name, and the list re-read from the backend now holds
    // it — so what is asserted is the stored record rather than the text that was typed.
    await expect(page.getByRole("status").filter({ hasText: /Saved/i }).first()).toBeVisible();
    await expect(page.getByText(/Hamburg/).first()).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your saved locations" }).getByText(/Hamburg/).first(),
    ).toBeVisible();

    // --- the briefing is in Celsius to begin with ---
    await page.goto("/");
    await expect(page.getByText("Current conditions")).toBeVisible();
    await expect(page.getByText("°C").first()).toBeVisible();

    // --- choose imperial in Settings, which is where the preference lives ---
    await page.goto("/settings");
    await expect(page.getByText("Weather preferences")).toBeVisible();

    await page.getByRole("radio", { name: /Imperial/ }).check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText(/Saved|No unsaved changes/i).first()).toBeVisible();

    // --- and the preference is applied to the figures, not merely stored ---
    await page.goto("/");
    await expect(page.getByText("Current conditions")).toBeVisible();

    // Scoped to the region the figure is actually read in. The whole screen is not asserted free of
    // "°C" because this stub converts the endpoints the briefing's readout uses and not every
    // fixture on the page — a units library is not what a test double should grow into. What
    // matters is the claim: the readout the person came for is in the system they chose.
    const conditions = page.getByRole("region", { name: "Current conditions" });
    await expect(conditions.getByText("°F").first()).toBeVisible();
    await expect(conditions.getByText("°C")).toHaveCount(0);

    // --- it survives a reload, which is what makes it a durable preference ---
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Current conditions" }).getByText("°F").first(),
    ).toBeVisible();

    // --- and the location saved earlier is still saved ---
    await page.goto("/locations");
    await expect(
      page.getByRole("region", { name: "Your saved locations" }).getByText(/Hamburg/).first(),
    ).toBeVisible();
  });
});

/* ============================================================ flow 4 */

test.describe("flow 4 — an expired session routed to sign-in", () => {
  test("an authenticated person whose token is refused is returned to sign-in, told why", async ({
    page,
    request,
  }) => {
    // --- authenticated first, on a screen that required a session to render ---
    await signIn(page);
    await page.goto("/historical");
    await expect(page.getByText("Recorded observations").first()).toBeVisible();

    // --- expiry is triggered in the test doubles, not simulated in the browser ---
    // Both halves, in the order a real expiry happens. First the backend stops accepting the bearer
    // token the browser holds, which is what the *next authenticated call* discovers; then the
    // identity provider stops recognising the session, which is what makes it genuinely expired
    // rather than merely refused.
    //
    // Both are needed, and finding that out was the point of running this. With only the API
    // revoked the person still holds a valid provider session, so `middleware.ts` correctly
    // redirects them *off* `/sign-in` and back to their destination — an expired session that the
    // provider still honours is not an expired session.
    await request.post(`${API_STUB_URL}/control/revoke`);

    // --- the shared session boundary handles it in place, on the next authenticated call ---
    await page.goto("/compare");

    // Said as an expiry, in an alert — not dressed as a weather or data failure. This is the
    // distinction `specs/web-ui` draws: an expired session is an authentication event.
    await expect(
      page.getByRole("alert").filter({ hasText: /session has expired/i }).first(),
    ).toBeVisible();
    // And explicitly not the ordinary failure treatment, which would offer a retry.
    await expect(page.getByText(/That request did not complete/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Try again|Retry/i })).toHaveCount(0);

    // --- the session is now gone at the provider too ---
    await request.post(`${STUB_URL}/control/expire`);

    // --- following the control routes to sign-in, keeping where they were ---
    const back = page.getByRole("link", { name: "Sign in again" });
    await expect(back).toBeVisible();
    await back.click();

    await expect(page).toHaveURL(/\/sign-in\?/);
    // The destination is preserved, so signing in again returns them to the screen they were on.
    expect(new URL(page.url()).searchParams.get("next")).toBe("/compare");
    // And the sign-in screen says why they are back, rather than presenting an unexplained form.
    await expect(page.getByText(/Your session expired/i)).toBeVisible();
    // The form is there to be used again — this is a route onward, not a dead end.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
