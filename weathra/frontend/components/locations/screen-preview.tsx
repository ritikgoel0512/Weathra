"use client";

/**
 * What an Intelligence screen shows before it has a place — the counterpart of the Dashboard's
 * `GettingStarted`, for the five screens that open on one location.
 *
 * `PlaceChooser` already removed the dead end: every one of these screens can resolve a name on the
 * screen itself rather than sending somebody to Settings first. What it did not fix is what sits
 * *under* the chooser, which was one `EmptyState` — a title, a sentence, a link — and then nothing.
 * A customer pressing *Weather Scenario Lab* for the first time got a screen that looked broken
 * rather than a screen that was waiting.
 *
 * So this draws the screen's own regions in their own geometry, with a description of what each
 * will hold. It is the same decision the Dashboard's onboarding state makes, and the same
 * restriction applies: **no region is filled with a weather figure**. There is no place yet, so
 * there is nothing measured, and a placeholder temperature would be an invented observation shown
 * to precisely the person least able to recognise it as one.
 */

import type { ReactNode } from "react";

import { EmptyChart } from "@/components/ui";

import styles from "./screen-preview.module.css";

/** One region of the screen, and what will be in it. */
export interface PreviewRegion {
  readonly title: string;
  readonly blurb: string;
  /** Regions the screen draws as a plot keep their plot frame, at roughly this height. */
  readonly chart?: number;
}

export interface ScreenPreviewProps {
  /** What the screen does, in one line. Not a heading for the page — the page has one already. */
  readonly title: string;
  readonly lead: string;
  readonly regions: readonly PreviewRegion[];
}

export function ScreenPreview({ title, lead, regions }: ScreenPreviewProps): ReactNode {
  return (
    <section className={styles.preview} aria-labelledby="screen-preview-title">
      <div className={styles.head}>
        <h2 className={styles.title} id="screen-preview-title">
          {title}
        </h2>
        <p className={styles.lead}>{lead}</p>
      </div>

      <ul className={styles.grid}>
        {regions.map((region) => (
          <li className={styles.card} key={region.title}>
            <h3 className={styles.cardTitle}>{region.title}</h3>
            <p className={styles.cardBlurb}>{region.blurb}</p>
            {region.chart === undefined ? (
              <div className={styles.rule} aria-hidden="true" />
            ) : (
              <EmptyChart
                title={region.title}
                reason="Name a place and this is plotted from what the provider returns."
                height={region.chart}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
