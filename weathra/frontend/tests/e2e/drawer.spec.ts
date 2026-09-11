/**
 * The navigation drawer at 375, photographed and checked.
 *
 * `docs/design/production-fidelity-review.md` records the drawer as never having been
 * photographed. This is that one narrow pass: open it, assert what the review asks for — every
 * group reachable, long names unclipped, no horizontal overflow, a close control, the account and
 * sign-out reachable, the intelligence routes reachable, and ADMIN only for an administrator — and
 * write the picture beside the other captures.
 */

import { expect, test } from "@playwright/test";

import { API_STUB_URL, STUB_URL } from "../../playwright.config";

const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

test.describe("the navigation drawer at 375", () => {
  test.skip(process.env.WEATHRA_CAPTURE !== "true", "set WEATHRA_CAPTURE=true");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await request.post(`${STUB_URL}/control/restore`);
    await request.post(`${API_STUB_URL}/control/restore`);
  });

  test("opens, and every destination in it is reachable and readable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(CREDENTIALS.email);
    await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main")).toBeAttached();
    await page.waitForLoadState("networkidle").catch(() => {});

    // Exact: once the drawer is open the scrim is also a button, labelled "Close menu".
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    await menu.click();

    const nav = page.getByRole("navigation", { name: "Weathra" });
    await expect(nav).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");

    /*
     * A *visible* way out, which is what this pass was here to check.
     *
     * The open drawer covers the header's Menu toggle at this width, so the toggle cannot be the
     * answer; the scrim is a labelled control with no visible affordance, so it cannot be either.
     * The drawer carries its own close control, and it is the one asserted visible here.
     */
    const close = nav.getByRole("button", { name: "Close menu" });
    await expect(close).toBeVisible();

    // Every destination the rail carries, by its full name — nothing abbreviated by the drawer.
    for (const name of [
      "Dashboard",
      "AI Weather Analyst",
      "Historical Analytics",
      "Compare Cities",
      "Agent Evidence",
      "Saved Locations",
      "Settings",
      "Forecast Explorer",
      "Weather Intelligence Report",
      "Weather Scenario Lab",
      "Weather Watch",
      "Travel Intelligence",
      "Plan & Usage",
    ]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }

    // No name is ellipsis-clipped: every link renders at its full intrinsic width.
    const clipped = await nav.evaluate((root) =>
      [...root.querySelectorAll("a")]
        .filter((link) => link.scrollWidth > link.clientWidth + 1)
        .map((link) => `${link.textContent?.trim()} (${link.scrollWidth} > ${link.clientWidth})`),
    );
    expect(clipped, "a destination is clipped in the drawer").toEqual([]);

    // The account and the way out.
    await expect(page.getByText(CREDENTIALS.email)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // ADMIN is not shown: this account is not an administrator.
    await expect(nav.getByRole("link", { name: /Model & AI Usage/ })).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`DRAWER OVERFLOW @375: ${overflow}px`);
    expect(overflow, "the drawer pushes the document sideways").toBeLessThanOrEqual(1);

    /*
     * The viewport, not the full page: the drawer is `position: fixed`, so a full-page shot
     * photographs it as a band at the top of a long scroll of the page underneath — a picture of
     * the screenshotter rather than of the drawer.
     */
    await page.screenshot({ path: "capture/00-drawer-375.png" });

    // And it closes, returning focus to the control that opened the drawer.
    await close.click();
    await expect(nav).not.toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
  });
});
