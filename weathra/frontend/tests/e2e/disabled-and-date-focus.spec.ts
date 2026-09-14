/**
 * Two measurements task 21.8 would otherwise have taken on trust — the Travel Intelligence date
 * fields' focus indicator, and the Dashboard's disabled "Show briefing" control.
 *
 * Both were reported as defects from reading the source, and neither can be settled that way. A
 * focus ring on `input[type=date]` is the engine's decision about a composite control whose segments
 * live in a shadow tree; a disabled control's distinctness is a computed colour against a computed
 * background. So this spec measures what the browser actually painted, in both engines, and asserts
 * against the measurement. Where the measurement says the behaviour is already correct, the
 * assertion is what keeps it correct.
 *
 * `docs/design/accessibility.md` §13 records what these two returned.
 */

import { expect, test, type Page } from "@playwright/test";

import { contrastRatio, roundRatio } from "../../lib/design/contrast";

import { API_STUB_URL, STUB_URL } from "../../playwright.config";

const CREDENTIALS = { email: "person@example.com", password: "correct-horse" };

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

/** Tab forward until the locator holds focus, so the focus is keyboard focus and not script focus. */
async function tabTo(page: Page, locator: ReturnType<Page["getByLabel"]>): Promise<boolean> {
  for (let step = 0; step < 80; step += 1) {
    if (await locator.evaluate((node) => node === document.activeElement)) return true;
    await page.keyboard.press("Tab");
  }
  return locator.evaluate((node) => node === document.activeElement);
}

/* ------------------------------------------------- D: the Travel date fields */

test.describe("the Travel Intelligence date fields show keyboard focus", () => {
  for (const field of ["Departure", "Return"] as const) {
    test(`${field} is indicated when the keyboard reaches it`, async ({ page }) => {
      await signIn(page);
      await page.goto("/travel");

      // The trip strip is collapsed once a destination is known; the dates live in its editor.
      await page.getByRole("button", { name: "Adjust trip" }).click();

      const input = page.getByLabel(field);
      await expect(input).toBeVisible();

      const reached = await tabTo(page, input);
      expect(reached, `${field} was never reached by Tab`).toBe(true);

      const measured = await input.evaluate((node) => {
        const style = getComputedStyle(node as HTMLElement);
        let focusVisible = false;
        try {
          focusVisible = (node as HTMLElement).matches(":focus-visible");
        } catch {
          focusVisible = false;
        }
        return {
          focusVisible,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
          outlineColor: style.outlineColor,
          outlineOffset: style.outlineOffset,
          boxShadow: style.boxShadow,
          borderColor: style.borderColor,
        };
      });

      const outlined = measured.outlineStyle !== "none" && measured.outlineWidth > 0;
      const shadowed = measured.boxShadow !== "none" && measured.boxShadow.trim() !== "";

      // The requirement is an indicator a person can see, by either of the two treatments the
      // design system declares. Reported with the measurement, so a failure says what was painted.
      expect(
        outlined || shadowed,
        `${field}: no focus indicator — outline ${measured.outlineStyle} ${measured.outlineWidth}px ${measured.outlineColor}, box-shadow ${measured.boxShadow}, :focus-visible ${measured.focusVisible}`,
      ).toBe(true);

      // The global rule is what draws it, so the ring is the accent at the declared width and is
      // not suppressed for this control. A screen-level override would show up here.
      expect(measured.outlineStyle, `${field}: outline style`).toBe("solid");
      expect(measured.outlineWidth, `${field}: outline width`).toBeGreaterThanOrEqual(2);

      console.log(`[21.8 D] ${field}: ${JSON.stringify(measured)}`);
    });
  }
});

/* ------------------------------- G: the Dashboard's disabled Show briefing */

test.describe("the Dashboard's disabled Show briefing is distinct and inert", () => {
  test("differs from its enabled self, and is out of the keyboard's reach", async ({ page }) => {
    await signIn(page);
    await page.goto("/");

    // On a Dashboard that already has a place, the entry is a closed disclosure on the heading line.
    await page.getByText("Brief on another place").click();

    const entry = page.getByPlaceholder("A city, or a city and its region or country").first();
    await expect(entry).toBeVisible();

    const control = page
      .getByRole("button", { name: "Show briefing", includeHidden: true })
      .first();

    /**
     * Everything that distinguishes the control in whichever state it is in.
     *
     * The colours come back *composited*, not as the computed values. The disabled treatment is
     * `opacity: 0.55`, which does not change the computed `color` at all — reading that would
     * measure a contrast nobody is looking at. So the label and the fill are each blended over the
     * nearest opaque backdrop at the element's own opacity, which is what the screen shows.
     */
    const read = () =>
      control.evaluate((node) => {
        const element = node as HTMLButtonElement;
        const style = getComputedStyle(element);

        const channels = (colour: string): [number, number, number, number] => {
          const parts = colour.match(/[\d.]+/g) ?? [];
          return [
            Number(parts[0] ?? 0),
            Number(parts[1] ?? 0),
            Number(parts[2] ?? 0),
            parts[3] === undefined ? 1 : Number(parts[3]),
          ];
        };
        const hex = (rgb: [number, number, number]): string =>
          `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
        const over = (
          front: [number, number, number, number],
          back: [number, number, number],
          extra = 1,
        ): [number, number, number] => {
          const alpha = front[3] * extra;
          return [
            front[0] * alpha + back[0] * (1 - alpha),
            front[1] * alpha + back[1] * (1 - alpha),
            front[2] * alpha + back[2] * (1 - alpha),
          ];
        };

        // The nearest ancestor that actually paints something, which is what the control sits on.
        let backdrop: [number, number, number] = [255, 255, 255];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const parentColour = channels(getComputedStyle(parent).backgroundColor);
          if (parentColour[3] > 0) {
            backdrop = [parentColour[0], parentColour[1], parentColour[2]];
            break;
          }
        }

        const opacity = Number.parseFloat(style.opacity);
        const fill = over(channels(style.backgroundColor), backdrop, opacity);
        const label = over(channels(style.color), fill, opacity);

        return {
          disabled: element.disabled,
          ariaDisabled: element.getAttribute("aria-disabled"),
          tabIndex: element.tabIndex,
          opacity,
          cursor: style.cursor,
          color: style.color,
          background: style.backgroundColor,
          borderColor: style.borderColor,
          paintedLabel: hex(label),
          paintedFill: hex(fill),
        };
      });

    // Empty entry: the control is disabled.
    await entry.fill("");
    const off = await read();

    // With something to resolve, the same control is enabled.
    await entry.fill("Berlin");
    const on = await read();

    console.log(`[21.8 G] disabled=${JSON.stringify(off)} enabled=${JSON.stringify(on)}`);

    // **Semantics.** Natively disabled, so assistive technology reports it and nothing needs to
    // carry `aria-disabled` beside it — the two together are the anti-pattern, not the fix.
    expect(off.disabled, "the empty-entry control is not natively disabled").toBe(true);
    expect(on.disabled, "the filled-entry control is still disabled").toBe(false);
    expect(off.ariaDisabled, "aria-disabled beside a native disabled attribute").toBeNull();

    // **Out of the keyboard's reach**, which is what native `disabled` buys and what an
    // `aria-disabled`-only treatment would not. Measured by actually pressing Tab rather than by
    // reading `tabIndex`, which reflects the content attribute and stays 0 on a disabled button in
    // both engines — it says nothing about whether focus can land there.
    // Back to the empty entry, so the control under the keyboard is the disabled one, and Tab from
    // the field itself — the stop immediately before it — so this is the press that would reach it.
    await entry.fill("");
    await entry.focus();
    await page.keyboard.press("Tab");
    expect(
      await control.evaluate((node) => node === document.activeElement),
      "Tab reached a disabled control",
    ).toBe(false);

    // **Visually distinct.** Not a claim about which treatment: whichever of the three the design
    // system uses, the disabled state must not be mistakable for the enabled one.
    const distinct =
      off.paintedLabel !== on.paintedLabel || off.paintedFill !== on.paintedFill;
    expect(
      distinct,
      `disabled and enabled are indistinguishable: ${JSON.stringify(off)} vs ${JSON.stringify(on)}`,
    ).toBe(true);

    /**
     * **How distinct, in numbers.**
     *
     * The two states differ by more than a name: measured as a contrast ratio between the two
     * painted fills, the gap is recorded here so a change that quietly narrowed it — a lighter
     * disabled opacity, say — fails rather than passes. 1.5:1 is a floor on the *difference*, not a
     * text-contrast threshold, and the measurement below says what it actually is.
     *
     * The disabled label's own contrast against its own fill is measured and reported too, and
     * deliberately not asserted against 4.5:1 or 3:1: WCAG 1.4.3 exempts inactive user interface
     * components from the contrast minimum, and asserting a threshold the standard does not set —
     * and this control does not meet — would be inventing a requirement. `docs/design/
     * accessibility.md` §13 carries the figure so it is on the record rather than in a test only.
     */
    const separation = roundRatio(contrastRatio(off.paintedFill, on.paintedFill));
    const labelRatio = roundRatio(contrastRatio(off.paintedLabel, off.paintedFill));
    console.log(
      `[21.8 G] state separation ${separation}:1 · disabled label ${labelRatio}:1 · enabled label ${roundRatio(contrastRatio(on.paintedLabel, on.paintedFill))}:1`,
    );
    expect(
      separation,
      `disabled fill ${off.paintedFill} against enabled fill ${on.paintedFill} measured ${separation}:1`,
    ).toBeGreaterThanOrEqual(1.5);
  });
});
