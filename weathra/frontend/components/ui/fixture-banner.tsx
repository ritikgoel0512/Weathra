/**
 * The marker that says the figures on screen are sample content.
 *
 * `lib/fixtures/visily.ts` exists so a rendered screen can be compared against its mockup, which
 * means rendering the mockup's own weather: 18°, Light Rain, 72%, a 94% convergence bar. In a
 * product whose entire design asserts that every figure is attributed and grounded, a screenshot of
 * those numbers is indistinguishable from real output once it leaves the reviewer's screen — in a
 * deck, a bug report, a status update.
 *
 * So fixture mode says so, fixed to the viewport, in the error tone, above everything. It is
 * deliberately not subtle and deliberately not dismissible: its whole job is to survive being
 * screenshotted. It costs a strip at the top of the frame, which is a much smaller price than a
 * fabricated temperature being taken for a measurement.
 *
 * Renders nothing at all when the flag is off, and the flag is fixed when the bundle is built, so
 * a deployed build can never show it. It is not stripped from the bundle, though — see
 * `lib/fixtures/visily.ts` for what that does and does not mean.
 *
 * `NEXT_PUBLIC_VISILY_FIDELITY_BANNER=false` suppresses it *within* fixture mode, for one reason
 * only: the strip shifts every screen down by its own height, so an automated comparison against an
 * artifact that has no strip is measuring the banner. `showingFixtureBanner()` records the whole
 * argument, including why this is opt-out rather than opt-in.
 */

import type { ReactNode } from "react";

import { showingFixtureBanner } from "@/lib/fixtures/visily";

import styles from "./primitives.module.css";

export function FixtureBanner(): ReactNode {
  if (!showingFixtureBanner()) return null;

  return (
    <div className={styles.fixtureBanner} role="alert">
      <strong>Visily fidelity fixtures</strong>
      <span>
        Every weather figure on screen is sample content transcribed from the design mockups. Nothing
        here was measured, forecast or retrieved.
      </span>
    </div>
  );
}
