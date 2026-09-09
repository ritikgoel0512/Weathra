/**
 * Accessibility and responsiveness in a real browser — task 21.8's browser half.
 *
 * Three of the task's criteria cannot be settled anywhere else. Whether a page scrolls sideways at
 * 360 pixels is a fact about layout; whether a focus ring is visible is a fact about the cascade;
 * whether wide content scrolls inside its own container rather than moving the page is a fact about
 * both. jsdom has neither, so a component test that claimed any of them would be claiming something
 * it cannot see. `tests/accessibility.test.tsx` asserts the markup, `lib/design/contrast.test.ts`
 * the token arithmetic, `tests/design-rules.test.ts` the stylesheets — and this asserts what
 * Chromium actually did with all three.
 *
 * It drives the **real production build** through the same harness task 18.10 established: the real
 * middleware, the real server-resolved layout, the real `@supabase/ssr` cookie session and the real
 * screens, with only the two processes beyond Weathra's boundaries stood in for. Every MVP screen is
 * visited at the three widths `docs/design/design-system.md` §13 records, and at the 360-pixel floor
 * it names.
 *
 * **What it does not do.** No screenshot comparison. A pixel diff would fail on a font hint and pass
 * on a keyboard trap, which is the wrong instrument for every one of these requirements.
 */

import { expect, test, type Page } from "@playwright/test";

const STUB_URL = "http://127.0.0.1:54321";
const API_STUB_URL = "http://127.0.0.1:54322";

const CREDENTIALS = { email: "sam@example.test", password: "correct-horse-battery-staple" };

/** The three tiers §13 records, plus the floor it names. */
const VIEWPORTS = [
  { name: "360-pixel floor", width: 360, height: 780, tier: "drawer" },
  { name: "intermediate", width: 900, height: 900, tier: "collapsed" },
  { name: "desktop", width: 1440, height: 1000, tier: "full" },
] as const;

/** Every MVP screen, with something that appears only once the screen itself has rendered. */
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

/* --------------------------------------------------------------------- harness */

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
 * Whether the page itself scrolls sideways.
 *
 * `documentElement.scrollWidth` against its `clientWidth`, with one pixel of tolerance for
 * sub-pixel rounding in the layout engine. `body` is measured as well, because a page can overflow
 * through either.
 */
async function horizontalOverflow(page: Page): Promise<{ document: number; body: number }> {
  return page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }));
}

/** Tab forward until the locator holds focus, so the focus is keyboard focus and not script focus. */
async function tabTo(
  page: Page,
  target: ReturnType<Page["locator"]>,
  limit = 40,
): Promise<boolean> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return true;
  }
  return false;
}

/** Every element wider than the viewport that is not inside something scrollable — for a message. */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const box = element.getBoundingClientRect();
      if (box.width <= limit + 1 && box.right <= limit + 1) continue;
      // Inside a container that scrolls its own overflow is exactly what the spec asks for.
      let scrollable = false;
      for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          scrollable = true;
          break;
        }
      }
      if (scrollable) continue;
      offenders.push(
        `${element.tagName.toLowerCase()}.${element.className?.toString().slice(0, 40)} — ` +
          `${Math.round(box.width)}px wide, right edge ${Math.round(box.right)}px`,
      );
    }
    return offenders.slice(0, 12);
  });
}

/* ------------------------------------------------------ the 360-pixel floor */

test.describe("no page scrolls sideways, at any recorded width", () => {
  for (const viewport of VIEWPORTS) {
    test(`the authentication screens fit at the ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const screen of AUTH_SCREENS) {
        await page.goto(screen.path);
        await expect(page.getByText(screen.marker).first()).toBeVisible();

        const overflow = await horizontalOverflow(page);
        const offenders = await overflowingElements(page);
        expect(
          overflow.document,
          `${screen.name} at ${viewport.width}px overflows by ${overflow.document}px:\n${offenders.join("\n")}`,
        ).toBeLessThanOrEqual(1);
        expect(overflow.body).toBeLessThanOrEqual(1);
      }
    });

    test(`the product screens fit at the ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page);

      for (const screen of PRODUCT_SCREENS) {
        await page.goto(screen.path);
        await expect(page.getByText(screen.marker).first()).toBeVisible();

        const overflow = await horizontalOverflow(page);
        const offenders = await overflowingElements(page);
        expect(
          overflow.document,
          `${screen.name} at ${viewport.width}px overflows by ${overflow.document}px:\n${offenders.join("\n")}`,
        ).toBeLessThanOrEqual(1);
        expect(overflow.body).toBeLessThanOrEqual(1);
      }
    });
  }

  test("the candidate chooser fits at 360 pixels, and is not hidden to make it fit", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);
    await page.goto("/locations");

    // The add form is a disclosure now — `06-saved-locations.png` shows one "Add New Node"
    // control in the header, not a form owning the page. Opening it is the real first step.
    await page.locator("summary", { hasText: "Add a location" }).click();
    await page.getByLabel("Place").fill("Springfield");
    await page.getByRole("button", { name: "Save location" }).click();

    const chooser = page.getByRole("group", { name: "Places matching what you entered" });
    await expect(chooser).toBeVisible();
    // Both candidates are on screen with their distinguishing detail, not collapsed away.
    await expect(chooser.getByRole("button")).toHaveCount(2);
    await expect(chooser.getByText("Illinois, United States")).toBeVisible();
    await expect(chooser.getByText("Missouri, United States")).toBeVisible();

    const overflow = await horizontalOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(1);
  });
});

/* --------------------------------------------------------- wide content */

test.describe("wide content scrolls inside its own container", () => {
  test("the evidence record's sources table scrolls itself, not the page", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);
    await page.goto("/evidence/run-stub");

    const region = page.getByRole("region", { name: "Grounded data sources" });
    await expect(region).toBeVisible();

    // The table is wider than the phone, and its own container is what scrolls.
    const measurement = await region.evaluate((element) => {
      const table = element.querySelector("table");
      const container = table?.parentElement;
      if (!table || !container) return null;
      return {
        overflowX: getComputedStyle(container).overflowX,
        tableWidth: table.scrollWidth,
        containerWidth: container.clientWidth,
      };
    });

    expect(measurement).not.toBeNull();
    expect(measurement?.overflowX).toBe("auto");
    expect(measurement!.tableWidth).toBeGreaterThan(measurement!.containerWidth);
    // And the page still does not move.
    expect((await horizontalOverflow(page)).document).toBeLessThanOrEqual(1);
  });

  /**
   * Containment is only half of it: the container has to be reachable.
   *
   * A container that scrolls its own overflow satisfies "wide content scrolls in its own container"
   * and, on its own, breaks "keyboard-only operation of every action" — a pointer can drag it and a
   * keyboard cannot reach it, so the columns past the right edge are unavailable to anybody not
   * using a mouse. axe-core's `scrollable-region-focusable` is the rule, and this is the behaviour
   * under it: reached by a real `Tab`, named when focused, and scrolled with an arrow key.
   */
  test("the sources table can be scrolled from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);
    await page.goto("/evidence/run-stub");

    const region = page.getByRole("group", { name: "Grounded data sources table" });
    await expect(region).toBeVisible();

    // Reached by Tab, not focused by script.
    expect(await tabTo(page, region, 60), "the scroll region was not reachable by Tab").toBe(true);

    // And an arrow key moves it, which is the whole point of it being a tab stop.
    const before = await region.evaluate((element) => element.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => region.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(before);
  });

  /**
   * And the stop exists exactly when the overflow does.
   *
   * The same table overflows at 360 pixels and fits at 1440. A permanently focusable container
   * would put an empty stop between the heading and the content on every screen that fits, so the
   * region measures instead of deciding once — this is that measurement, in a browser that really
   * does the layout.
   */
  test("is a tab stop only while there is something to scroll", async ({ page }) => {
    await signIn(page);

    /**
     * Historical Analytics' charts are the case that changes, which is why they are the case
     * measured here. The plot has a 320-pixel floor, so at 360 pixels its container really does
     * scroll and really does need reaching; at 1440 it fits and an extra stop would buy nobody
     * anything. The evidence sources table, by contrast, has five columns and sits in a column of a
     * two-column layout, so it overflows at *both* widths — correct, and useless as a test of the
     * condition, because it never changes.
     */
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/historical");
    await expect(page.getByText("Recorded observations").first()).toBeVisible();

    const scroll = page.locator("figure[data-chart] > [data-scrollable]").first();
    await expect(scroll).toHaveAttribute("data-scrollable", "true");
    await expect(scroll).toHaveAttribute("tabindex", "0");
    await expect(scroll).toHaveAttribute("role", "group");

    // Wide enough for the plot, and the stop goes away.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(scroll).toHaveAttribute("data-scrollable", "false");
    expect(await scroll.getAttribute("tabindex")).toBeNull();
    expect(await scroll.getAttribute("aria-label")).toBeNull();
  });

  /**
   * The vertical half of the same requirement.
   *
   * `overflow-x: auto` computes the other axis from `visible` to `auto`, so a container asked only
   * to scroll sideways will scroll *down* as soon as its content is a few pixels too tall — and
   * those pixels are then unreachable in exactly the same way. The charts were in that state: an
   * inline `<svg>` kept a line box's descender space below itself and overflowed the plot's fixed
   * height by six pixels. Nothing should be clipped at the width the plot was sized for.
   */
  test("the charts do not overflow their own height at desktop width", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/historical");
    await expect(page.getByText("Recorded observations").first()).toBeVisible();

    const overflow = await page.locator("figure[data-chart] > [data-scrollable]").evaluateAll(
      (elements) =>
        elements.map((element) => ({
          vertical: element.scrollHeight - element.clientHeight,
          horizontal: element.scrollWidth - element.clientWidth,
        })),
    );

    expect(overflow.length).toBeGreaterThan(0);
    for (const measurement of overflow) {
      expect(measurement.vertical, "a chart is clipped vertically").toBeLessThanOrEqual(1);
      expect(measurement.horizontal, "a chart is clipped horizontally at 1440px").toBeLessThanOrEqual(1);
    }
  });
});

/* ------------------------------------------------------- the responsive tiers */

test.describe("the shell keeps the three recorded tiers", () => {
  test("hides the navigation behind a labelled control below 768 pixels", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);

    const control = page.getByRole("button", { name: "Menu", exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("aria-expanded", "false");

    // Closed, the twelve entries are out of the tab order rather than focusable off-screen.
    const reachable = await page.evaluate(() => {
      const nav = document.getElementById("weathra-navigation");
      if (!nav) return null;
      return getComputedStyle(nav).visibility;
    });
    expect(reachable).toBe("hidden");

    await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();

    // Escape closes it, and the control that opened it is where focus can return to.
    await page.keyboard.press("Escape");
    await expect(control).toHaveAttribute("aria-expanded", "false");
  });

  test("shows the navigation without a drawer control from 768 pixels up", async ({ page }) => {
    await signIn(page);

    for (const width of [900, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Weathra" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeHidden();
    }
  });

  /**
   * The collapsed rail's labels, which are the only thing naming its twelve icons.
   *
   * They were invisible: `.navigation` carried `overflow-y: auto`, and CSS has no way to scroll one
   * axis while leaving the other visible — the horizontal overflow computed to `auto` too, so every
   * label, drawn beside the 64px rail, was clipped away. The scroll moved to an inner wrapper whose
   * clip box is widened by `--layout-navigation-label-room` to hold them.
   *
   * Asserted as geometry rather than as a screenshot: what matters is that the painted label lies
   * inside the box that clips it and outside the rail, which is checkable without pinning a pixel.
   */
  test("paints the collapsed rail's labels beside it, on hover and on focus", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await signIn(page);

    // The rail is icon-only: the widest entry's name is not laid out in the rail's own width.
    const rail = await page.getByRole("navigation", { name: "Weathra" }).boundingBox();
    expect(rail).not.toBeNull();
    expect(rail!.width).toBeLessThan(100);

    const longest = page.getByRole("link", { name: /Weather Intelligence Report/ });
    // The name is in the accessibility tree whether or not anything is painted — the icons are not
    // the accessible name, the label is.
    await expect(longest).toHaveAccessibleName(/Weather Intelligence Report/);

    const geometry = async () =>
      page.evaluate(() => {
        const nav = document.getElementById("weathra-navigation")!;
        const scroller = nav.querySelector("div")!;
        const link = Array.from(nav.querySelectorAll("a")).find((element) =>
          (element.textContent ?? "").includes("Weather Intelligence Report"),
        )!;
        const label = link.querySelector("span")!;
        const labelBox = label.getBoundingClientRect();
        const clipBox = scroller.getBoundingClientRect();
        return {
          opacity: Number(getComputedStyle(label).opacity),
          labelLeft: labelBox.left,
          labelRight: labelBox.right,
          labelWidth: labelBox.width,
          clipRight: clipBox.right,
          railRight: nav.getBoundingClientRect().right,
          // A label that blocks the screen beneath it would be worse than one that is clipped.
          pointerEvents: getComputedStyle(label).pointerEvents,
          scrollerHorizontalOverflow: scroller.scrollWidth - scroller.clientWidth,
        };
      });

    for (const reveal of [
      async () => longest.hover(),
      async () => {
        await page.mouse.move(0, 0);
        // Reached with Tab rather than `.focus()`: `:focus-visible` is a heuristic about how focus
        // arrived, and programmatic focus on a link does not satisfy it in either engine. Tabbing
        // from the entry before it is what a keyboard user actually does.
        // The entry immediately before the longest one. The rail now lists the six built
        // destinations first and the six not-yet-built ones under their own heading, so the
        // predecessor of "Weather Intelligence Report" is the first planned entry rather than the
        // last built one. Tabbing from whatever precedes it is the point; which entry that is, is
        // not.
        await page.getByRole("link", { name: /^Forecast Explorer/ }).focus();
        await page.keyboard.press("Tab");
        await expect(longest).toBeFocused();
      },
    ]) {
      await reveal();
      const seen = await geometry();

      expect(seen.opacity, "the label did not become visible").toBe(1);
      // Drawn beside the rail, not inside it...
      expect(seen.labelLeft).toBeGreaterThanOrEqual(seen.railRight - 1);
      expect(seen.labelWidth).toBeGreaterThan(120);
      // ...and inside the box that clips it, which is the defect this test exists for.
      expect(seen.labelRight, "the label is clipped by the navigation scroll container").toBeLessThanOrEqual(
        seen.clipRight + 1,
      );
      // The widened clip box must not itself start scrolling sideways.
      expect(seen.scrollerHorizontalOverflow).toBeLessThanOrEqual(1);
      expect(seen.pointerEvents).toBe("none");
    }

    // And none of that pushed the page open.
    const overflow = await horizontalOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.body).toBeLessThanOrEqual(1);
  });

  /**
   * The other half of the same change: moving the scroll off `.navigation` must not cost the last
   * entry on a viewport too short to show twelve of them.
   */
  test("keeps the last navigation entry reachable when the rail cannot show them all", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 480 });
    await signIn(page);
    await page.getByRole("button", { name: "Menu", exact: true }).click();

    // The *last* entry in the rail, whichever it is. It used to be Settings; the rail now ends
    // with the not-yet-built group, and this test is about the final entry being reachable rather
    // than about which destination happens to sit there.
    const settings = page
      .getByRole("navigation", { name: "Weathra" })
      .getByRole("link")
      .last();
    await expect(settings).toBeVisible();

    // Scrolling it into view is the browser's own affordance; that it *can* be scrolled to is the
    // assertion. `scrollIntoViewIfNeeded` fails outright if no ancestor can bring it in.
    await settings.scrollIntoViewIfNeeded();
    await expect(settings).toBeInViewport();

    const scrolled = await page.evaluate(() => {
      const scroller = document.getElementById("weathra-navigation")!.querySelector("div")!;
      return {
        canScroll: scroller.scrollHeight > scroller.clientHeight,
        scrollTop: scroller.scrollTop,
      };
    });
    expect(scrolled.canScroll, "the navigation entries cannot scroll on a short viewport").toBe(true);
    expect(scrolled.scrollTop).toBeGreaterThan(0);
  });

  /**
   * Dismissing the drawer must not drop focus — found by the manual pass for task 21.8.
   *
   * Closing it hides the navigation with `visibility`; a focused element inside something hidden
   * loses focus to the document, so Escape from inside the drawer left `document.activeElement`
   * as `body` and the next Tab restarted at the top of the page. The existing tier test checks
   * `aria-expanded` flips, which it did — the flag was right and the focus was gone.
   */
  test("returns focus to the drawer control when the drawer is dismissed", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page);

    const control = page.getByRole("button", { name: "Menu", exact: true });
    await control.focus();
    await page.keyboard.press("Enter");
    await expect(control).toHaveAttribute("aria-expanded", "true");

    // Move focus inside the drawer, as somebody who opened it to look would.
    const inside = page.getByRole("navigation", { name: "Weathra" }).getByRole("link").first();
    await inside.focus();
    await expect(inside).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(control).toHaveAttribute("aria-expanded", "false");
    await expect(control, "focus was dropped when the drawer closed").toBeFocused();
  });

  test("reflows the content rather than shrinking the desktop layout", async ({ page }) => {
    await signIn(page);
    await page.goto("/evidence/run-stub");

    // Two columns at desktop width; one at the floor. The same content either way.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const wide = await page.getByRole("region", { name: "Execution flow" }).boundingBox();

    await page.setViewportSize({ width: 360, height: 780 });
    const narrow = await page.getByRole("region", { name: "Execution flow" }).boundingBox();

    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    // The column is narrower than half the desktop width, and nearly the whole phone width — which
    // is reflow rather than a scaled-down desktop.
    expect(wide!.width).toBeLessThan(1440 / 2);
    expect(narrow!.width).toBeGreaterThan(300);

    // And the type did not shrink to make it fit: §13 forbids dropping below the body size.
    const bodySize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.body).fontSize),
    );
    expect(bodySize).toBeGreaterThanOrEqual(14);
  });
});

/* ------------------------------------------------------------ keyboard and focus */

test.describe("keyboard operation and visible focus", () => {
  /**
   * Whether the focused element actually shows a focus indicator, and which one.
   *
   * The design system declares two legitimate treatments: the global `:focus-visible` outline, and
   * — for a control that must draw the ring inside its own frame — `outline: none` replaced by
   * `box-shadow: var(--shadow-focus)`. `tests/design-rules.test.ts` proves every `outline: none` is
   * paired with a replacement; this proves the replacement is what the browser painted. Asserting
   * only the outline would fail the disclosure rows, the candidate buttons and the fields, all of
   * which are correctly indicated.
   */
  async function focusIndicator(page: Page): Promise<{
    visible: boolean;
    /**
     * Whether the browser itself considers this focus "visible focus".
     *
     * The gate on the assertion, and not a way around it. `:focus-visible` is the browser's own
     * decision — it does not match a focus moved by script, and for a composite control such as
     * `input[type=date]` it applies to the segment inside the control's shadow tree rather than to
     * the host element a test can see. In neither case is Weathra's stylesheet what decides whether
     * a ring is drawn, so requiring one of *our* rules there would be asserting the wrong thing.
     * Where the browser does say the focus is visible, an indicator is required.
     */
    focusVisible: boolean;
    outline: string;
    shadow: string;
    element: string;
  }> {
    return page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) {
        return {
          visible: false,
          focusVisible: false,
          outline: "none",
          shadow: "none",
          element: "body",
        };
      }
      const style = getComputedStyle(active);
      const outlined = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const shadowed = style.boxShadow !== "none" && style.boxShadow.trim() !== "";
      let focusVisible = false;
      try {
        focusVisible = active.matches(":focus-visible");
      } catch {
        focusVisible = false;
      }
      return {
        visible: outlined || shadowed,
        focusVisible,
        outline: `${style.outlineStyle} ${style.outlineWidth}`,
        shadow: style.boxShadow.slice(0, 60),
        element: `${active.tagName}#${active.id}.${active.className}`.slice(0, 80),
      };
    });
  }

  test("signs in using the keyboard alone, with a visible ring on every stop", async ({ page }) => {
    await page.goto("/sign-in");

    /**
     * The keyboard entry point is the email field itself, which the form autofocuses — so a person
     * arriving with a keyboard types straight into it and needs no `Tab` to begin.
     *
     * Asserting that is the point, and it is also what makes this test engine-agnostic. An earlier
     * version pressed `Tab` first and walked until it found the email field, which meant tabbing
     * *away* from the already-focused field and relying on the walk wrapping around the end of the
     * document to come back to it. Headless Blink wraps (through `body`); headless Gecko keeps
     * focus on the last element, because in a real Firefox the wrap goes out through the browser's
     * own chrome, which a headless browser does not have. So the walk found the email field in one
     * engine and the trailing link in the other. The wrap-around was never the requirement.
     */
    const email = page.getByLabel("Email");
    await expect(email).toBeFocused();

    // Forward from there, every stop the browser calls visible focus shows its indicator.
    let rings = 0;
    for (let index = 0; index < 6; index += 1) {
      const indicator = await focusIndicator(page);
      if (indicator.focusVisible) {
        expect(
          indicator.visible,
          `no focus indicator on ${indicator.element} (outline ${indicator.outline}, shadow ${indicator.shadow})`,
        ).toBe(true);
        rings += 1;
      }
      await page.keyboard.press("Tab");
    }

    // Not satisfiable by an empty walk: at least one stop was measured and did show its ring.
    expect(rings).toBeGreaterThan(0);

    // And the sign-in itself, from the field the form put the keyboard in.
    await page.goto("/sign-in");
    await expect(email).toBeFocused();
    await page.keyboard.type(CREDENTIALS.email);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.keyboard.type(CREDENTIALS.password);
    // Enter submits the form from within a field, which is what a person actually does.
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Current conditions")).toBeVisible();
  });

  test("reaches every control on every product screen with Tab, and never traps focus", async ({ page }) => {
    await signIn(page);

    for (const screen of PRODUCT_SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByText(screen.marker).first()).toBeVisible();

      /**
       * Stamp every control a keyboard can reach, so the walk below can be checked against the
       * whole set by identity rather than by a count.
       *
       * Counting distinct stops is not enough: two candidate buttons, or two rows of the same
       * disclosure, are indistinguishable by tag, id and class, so a walk that reached one of them
       * twice and the other never would look complete. The stamp gives each one a name the walk can
       * report back, which is what turns "more than one stop" into "every control".
       */
      const expected = await page.evaluate(() => {
        const selector =
          "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), summary, [tabindex='0']";
        const reachable = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
          if (element.getAttribute("tabindex") === "-1") return false;
          // Rendered at all. `getComputedStyle(element).display` is the element's *own* computed
          // value, which a `display: none` ancestor does not change — so reading it would count the
          // responsive shell's hidden half as controls a keyboard ought to reach. Above 768 pixels
          // the mobile header is `display: none`, and its drawer control and brand link generate no
          // boxes and are correctly not tab stops. A box is the thing that actually distinguishes
          // them; `visibility` is still read separately, because it inherits and hides in place.
          if (element.getClientRects().length === 0) return false;
          if (getComputedStyle(element).visibility !== "visible") return false;
          /**
           * Inside a collapsed disclosure.
           *
           * Saved Locations' "Add a location" form is a `<details>`, so its fields are not tab
           * stops until it is opened — and a closed `<details>` still reports client rects for its
           * contents in Blink, so the box test above does not catch them. This is not a control the
           * walk is owed: the `<summary>` that reveals them *is* in the walk, is keyboard-operable,
           * and opening it puts every field in the tab order. The requirement is unchanged — every
           * control a person can currently reach must be reachable by Tab — and a field behind a
           * disclosure is not currently one of them.
           */
          if (element.closest("details:not([open])") !== null) return false;
          /**
           * A radio group is one tab stop, not one per option.
           *
           * The browser does this natively: `Tab` enters the group at the checked radio — or the
           * first, when none is checked — and the arrow keys move between the options from there.
           * Settings' unit choice is the case in point, and counting its second radio as a stop the
           * walk owed would report the correct behaviour as a defect. The tablist beside it needs
           * no special case because its unselected tabs carry `tabindex="-1"` explicitly, which is
           * the same rule written by hand.
           */
          if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
            const group = [...document.querySelectorAll<HTMLInputElement>("input[type=radio]")].filter(
              (radio) => radio.name === element.name && radio.form === element.form,
            );
            const stop = group.find((radio) => radio.checked) ?? group[0];
            if (element !== stop) return false;
          }
          return true;
        });
        reachable.forEach((element, index) => {
          element.dataset.a11yWalk = String(index);
        });
        return reachable.map(
          (element, index) =>
            `${index}:${element.tagName.toLowerCase()}` +
            `[${(element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 24)}]`,
        );
      });
      expect(expected.length, `${screen.name} offers nothing to do`).toBeGreaterThan(0);

      /**
       * Walk forward through the document from the top.
       *
       * The walk is given the number of controls plus a margin, and must have visited every stamped
       * control by the end of it. Both engines walk in document order; where they differ is only
       * what happens after the last control — headless Blink wraps around through `body`, headless
       * Gecko holds the last element, because a real Firefox wraps out through browser chrome that
       * a headless one does not have. Neither is a trap, and neither changes what this asserts:
       * a walk that starts at the top and goes forward reaches all of them either way.
       */
      const visited = new Set<string>();
      let stops = 0;
      let indicated = 0;
      /**
       * More presses than controls, because a composite control is several stops.
       *
       * `input[type=date]` is the case that matters here: Blink gives it an internal segment per
       * date part, so tabbing *through* one date field costs three presses while
       * `document.activeElement` stays the same input throughout. Historical Analytics has four of
       * them, which is enough to exhaust a budget of one press per control before the walk reaches
       * the controls that follow. The walk stops as soon as every stamped control has been visited,
       * so the headroom costs nothing on the screens that do not need it.
       */
      const budget = expected.length * 4 + 12;
      for (let index = 0; index < budget && visited.size < expected.length; index += 1) {
        await page.keyboard.press("Tab");
        const here = await focusIndicator(page);
        if (here.element === "body") continue;
        stops += 1;
        const stamp = await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset?.a11yWalk ?? null,
        );
        if (stamp !== null) visited.add(stamp);
        // Wherever the browser calls this visible focus, Weathra draws an indicator — the global
        // outline, or the shadow a control substitutes for it inside its own frame.
        if (here.focusVisible) {
          expect(
            here.visible,
            `no focus indicator at ${here.element} on ${screen.name} ` +
              `(outline ${here.outline}, shadow ${here.shadow})`,
          ).toBe(true);
          indicated += 1;
        }
      }

      expect(stops, `${screen.name} took no tab stops`).toBeGreaterThan(0);
      expect(indicated, `${screen.name} showed no focus indicator on any stop`).toBeGreaterThan(0);
      // Every control the screen offers, and not merely more than one of them.
      const missed = expected.filter((_, index) => !visited.has(String(index)));
      expect(
        missed,
        `${screen.name} has ${missed.length} control(s) a forward Tab walk never reached`,
      ).toEqual([]);
    }
  });

  /**
   * A system asking for light gets Midnight Intelligence, and still gets a focus ring.
   *
   * This test used to assert the opposite half: that a `colorScheme: "light"` context was served a
   * light ground, so the ring it measured was the light appearance's. That appearance is gone — it
   * was a palette no product artifact depicts, and serving it meant an operator on a light system
   * saw a product matching none of them. What is worth holding on to is the part that was never
   * about a second palette: the preference must not be able to take the ring away, and now it must
   * not be able to take the *direction* away either. Both are asserted here rather than trusted.
   */
  test("serves Midnight Intelligence, with its focus ring, to a system asking for light", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();

    await page.goto("/sign-in");
    await page.getByLabel("Email").focus();

    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as HTMLElement);
      const outlined = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const shadowed = style.boxShadow !== "none" && style.boxShadow.trim() !== "";
      return { visible: outlined || shadowed, detail: `${style.outlineStyle} / ${style.boxShadow}` };
    });
    expect(
      ring.visible,
      `no focus indicator under a light system preference: ${ring.detail}`,
    ).toBe(true);

    // `surface-base`, the Midnight Intelligence ground — not a derived light one.
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(ground, "a light system preference changed the appearance").toBe("rgb(5, 8, 12)");

    await context.close();
  });

  test("chooses a location candidate with the keyboard alone", async ({ page }) => {
    await signIn(page);
    await page.goto("/locations");

    // The add form is a disclosure now — `06-saved-locations.png` shows one "Add New Node"
    // control in the header, not a form owning the page. Opening it is the real first step.
    await page.locator("summary", { hasText: "Add a location" }).click();
    await page.getByLabel("Place").fill("Springfield");
    await page.getByRole("button", { name: "Save location" }).click();

    const chooser = page.getByRole("group", { name: "Places matching what you entered" });
    await expect(chooser).toBeVisible();

    // Reached by Tab, not by script, so the ring under test is the one a keyboard user sees.
    const candidate = chooser.getByRole("button").nth(1);
    await page.getByLabel("Place").focus();
    expect(await tabTo(page, candidate), "the candidate was not reachable by Tab").toBe(true);

    const indicator = await focusIndicator(page);
    expect(indicator.focusVisible, "Tab did not produce visible focus on the candidate").toBe(true);
    expect(
      indicator.visible,
      `the candidate shows no focus indicator (outline ${indicator.outline}, shadow ${indicator.shadow})`,
    ).toBe(true);

    await page.keyboard.press("Enter");
    // The save went through: the list re-read, and the chooser is gone.
    await expect(chooser).toBeHidden();
  });

  test("operates the destructive confirmation in Settings from the keyboard", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");

    // Tabs move with the arrow keys, as a tablist must.
    await page.getByRole("tab", { name: "General" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("button", { name: "Delete my Weathra data" }).click();
    const confirmation = page.getByRole("group", {
      name: "Delete every Weathra record belonging to you?",
    });
    await expect(confirmation).toBeVisible();

    // The confirm control is unreachable-by-accident: it stays disabled until the word is typed.
    const confirm = confirmation.getByRole("button", { name: "Delete my Weathra data permanently" });
    await expect(confirm).toBeDisabled();
    await confirmation.getByRole("textbox").fill("DELETE");
    await expect(confirm).toBeEnabled();

    // Cancel is reachable and gets out of it without deleting anything.
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toBeHidden();
  });

  test("changes the unit system from the keyboard, with the arrow keys a radio group expects", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/settings");

    /**
     * The counterpart to the walk's radio-group rule.
     *
     * The walk treats the group as the single tab stop the browser makes it, which is only correct
     * if the other option is reachable the way a radio group is meant to be reached. So: `Tab` to
     * the group, then an arrow key, and the other unit system is selected — no pointer involved.
     */
    const metric = page.getByRole("radio", { name: /Metric/ });
    const imperial = page.getByRole("radio", { name: /Imperial/ });
    await expect(metric).toBeChecked();

    expect(await tabTo(page, metric), "the unit group was not reachable by Tab").toBe(true);
    await page.keyboard.press("ArrowRight");

    await expect(imperial).toBeChecked();
    await expect(metric).not.toBeChecked();
    // And the choice was actually taken, rather than only moving the selection ring.
    await expect(page.getByText(/Fahrenheit/).first()).toBeVisible();
  });

  test("moves focus into the content with the skip link", async ({ page }) => {
    await signIn(page);

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();

    await page.keyboard.press("Enter");
    const landed = await page.evaluate(() => document.activeElement?.id);
    expect(landed).toBe("weathra-main");
  });
});

/* --------------------------------------------------- the brand mark, as rendered */

/**
 * The brand mark renders in its accent tile — task 21.9's one correction.
 *
 * Asserted as *painted* rather than as markup, because the point of the correction is what it looks
 * like: all eight approved artifacts show the mark inside a filled accent square, and the
 * implementation drew the glyph alone. A structural test would pass on a tile that had no ground.
 */
test.describe("the brand mark", () => {
  test("sits in a filled accent tile on the authentication shell", async ({ page }) => {
    await page.goto("/sign-in");

    const tile = page.locator("span").filter({ has: page.locator("svg") }).first();
    const painted = await tile.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });

    // A real ground, not transparent, and a square tile with a rounded corner.
    expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(painted.width).toBe(painted.height);
    expect(Number.parseFloat(painted.radius)).toBeGreaterThan(0);
  });

  test("sits in a filled accent tile on the application shell", async ({ page }) => {
    await signIn(page);

    const painted = await page
      .locator("nav a span")
      .filter({ has: page.locator("svg") })
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          background: style.backgroundColor,
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      });

    expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(painted.width).toBe(painted.height);
  });
});

/* ------------------------------------------- the chooser's heading, as rendered */

/**
 * The candidate chooser's question is a heading, and looks exactly as it did as a paragraph.
 *
 * Two separate claims, and only a browser can settle the second. `docs/design/screens.md` records
 * the chooser as a divergence no artifact depicts, its appearance governed by `design-system.md`
 * §11 — so what has to be preserved is the type role it renders with, not a pixel comparison
 * against a mockup that does not contain it. `candidate-choice.module.css` declares that role on
 * `.title` (the display family at the section size, line height and weight), and a class outranks
 * the `h2`/`h3` element selectors in `globals.css` that would otherwise size the two levels
 * differently. This asserts the cascade actually resolved that way, at both levels, rather than
 * trusting the reasoning.
 */
test.describe("the candidate chooser's question", () => {
  /** The section type role, read from the tokens rather than hard-coded. */
  async function sectionRole(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        size: root.getPropertyValue("--type-section-size").trim(),
        line: root.getPropertyValue("--type-section-line").trim(),
        weight: root.getPropertyValue("--type-section-weight").trim(),
      };
    });
  }

  /** What a probe element measures when given a declaration, so tokens compare as used pixels. */
  async function asUsed(page: Page, declaration: string): Promise<string> {
    return page.evaluate((value) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:absolute;visibility:hidden;font-size:${value}`;
      document.body.append(probe);
      const used = getComputedStyle(probe).fontSize;
      probe.remove();
      return used;
    }, declaration);
  }

  test("is a level-3 heading on Saved Locations, in the section type role", async ({ page }) => {
    await signIn(page);
    await page.goto("/locations");

    // The add form is a disclosure now — `06-saved-locations.png` shows one "Add New Node"
    // control in the header, not a form owning the page. Opening it is the real first step.
    await page.locator("summary", { hasText: "Add a location" }).click();
    await page.getByLabel("Place").fill("Springfield");
    await page.getByRole("button", { name: "Save location" }).click();

    // Nested inside this screen's own "Add a location" h2.
    const heading = page.getByRole("heading", { name: "Which place did you mean?", level: 3 });
    await expect(heading).toBeVisible();

    const role = await sectionRole(page);
    const expected = await asUsed(page, role.size);
    const painted = await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, weight: style.fontWeight, family: style.fontFamily };
    });

    // The section size, not the smaller card size `globals.css` gives a bare h3.
    expect(painted.size).toBe(expected);
    expect(painted.weight).toBe(role.weight);
    expect(painted.family).not.toBe("");
  });

  test("is a level-2 heading on the Dashboard, painted identically", async ({ page }) => {
    await signIn(page);

    // The place entry folds away once there is a briefing to read — finding 1.7 of the runtime
    // fidelity audit — so this account, which has a default location, opens onto the hero. The
    // form is one press away and is the same form; the disclosure is opened here rather than the
    // control being reached some other way, because that is what a person does.
    await page.getByText("Brief on another place").click();
    await page.getByLabel("Brief me on a place").fill("Springfield");
    await page.getByRole("button", { name: "Show briefing" }).click();

    // Directly under the screen's h1, so a third level here would skip one.
    const heading = page.getByRole("heading", { name: "Which place did you mean?", level: 2 });
    await expect(heading).toBeVisible();

    const role = await sectionRole(page);
    const expected = await asUsed(page, role.size);
    const painted = await heading.evaluate((element) => getComputedStyle(element).fontSize);
    expect(painted).toBe(expected);
  });
});

/* ------------------------------------------------------- body-text contrast */

test.describe("body text meets 4.5:1 as rendered, in both appearances", () => {
  /**
   * The measured ratio of a rendered element against the ground behind it.
   *
   * The token arithmetic is asserted in `lib/design/contrast.test.ts`; this is the check that the
   * tokens are the values the browser actually resolved, in the appearance it actually chose. Only
   * elements whose own background is opaque are measured, because a ratio against a transparent
   * background is a ratio against nothing.
   */
  async function measure(page: Page, selector: string): Promise<number | null> {
    return page.evaluate((target) => {
      const element = document.querySelector<HTMLElement>(target);
      if (!element) return null;

      const luminance = (colour: string): number => {
        const [red, green, blue] = colour.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number) as [
          number,
          number,
          number,
        ];
        const channel = (value: number) => {
          const proportion = value / 255;
          return proportion <= 0.03928
            ? proportion / 12.92
            : Math.pow((proportion + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };

      const opaqueGround = (from: HTMLElement): string => {
        for (let node: HTMLElement | null = from; node; node = node.parentElement) {
          const background = getComputedStyle(node).backgroundColor;
          if (background && !background.includes("rgba(0, 0, 0, 0)") && background !== "transparent") {
            return background;
          }
        }
        return getComputedStyle(document.body).backgroundColor;
      };

      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(opaqueGround(element));
      const lighter = Math.max(foreground, background);
      const darker = Math.min(foreground, background);
      return (lighter + 0.05) / (darker + 0.05);
    }, selector);
  }

  for (const scheme of ["dark", "light"] as const) {
    test(`the signed-in briefing's body text passes in the ${scheme} appearance`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();

      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByLabel("Password", { exact: true }).fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Current conditions")).toBeVisible();

      // The screen's own heading, its subtitle — which is the muted role, the hardest of the three —
      // and the navigation's current entry.
      for (const selector of ["main h1", "main h1 + p", "nav a[aria-current='page']"]) {
        const ratio = await measure(page, selector);
        expect(ratio, `${selector} was not found in the ${scheme} appearance`).not.toBeNull();
        expect(ratio!, `${selector} measured ${ratio?.toFixed(2)}:1 in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }

      await context.close();
    });
  }
});
