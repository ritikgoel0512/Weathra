"use client";

/**
 * The Dashboard a person sees before they have chosen a place — a first-class product state.
 *
 * What stood here was an `EmptyState`: a title, one sentence, a link to Settings, and then most of
 * the viewport left black. Every new account met it, so it was the first screen Weathra showed
 * anybody, and it showed nothing. `01-dashboard.png` is a dense briefing; the screen before it read
 * as a broken version of that rather than as the step before it.
 *
 * So this is built out of the same visual system as the populated Dashboard — the hero band, the
 * section grid, the chart geometry — with the *product* in each region instead of measurements.
 *
 * **Nothing here is a weather figure.** No temperature, no condition, no forecast: a placeholder
 * that filled the hero with 18° would be inventing an observation, which `screens.md` §5 forbids
 * and which would be a worse failure than the blank screen it replaced. What fills the regions is a
 * description of what each one will hold, drawn in that region's own geometry — `EmptyChart` keeps
 * the plot frame and says why it is empty, which is exactly this problem already solved once.
 *
 * **The city suggestions are navigation, not data.** Each is a link carrying `?place=` — the same
 * parameter the shell's search field writes — so choosing one goes through the backend's resolver
 * like any other name. They are a way to start, not places Weathra claims to know anything about
 * yet.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui";
import { PLACE_PARAM } from "@/components/shell/top-bar";
import { DEFAULT_PROTECTED_PATH } from "@/lib/routes";

import styles from "./dashboard.module.css";

/**
 * Somewhere to start, for somebody who has not thought of a city yet.
 *
 * Chosen to span the globe rather than to be a ranking, and deliberately written the way the
 * resolver wants them — a name with its country — so the first thing a new account does is not
 * land on a disambiguation list.
 */
const SUGGESTIONS: readonly string[] = [
  "London, United Kingdom",
  "New York, United States",
  "Tokyo, Japan",
  "Berlin, Germany",
  "Sydney, Australia",
  "Nairobi, Kenya",
];

function placeHref(name: string): string {
  return `${DEFAULT_PROTECTED_PATH}?${PLACE_PARAM}=${encodeURIComponent(name)}`;
}

/** What each region of the briefing will hold, in that region's own shape. */
export interface GettingStartedProps {
  /**
   * The location form, rendered by the Dashboard and placed here.
   *
   * Passed in rather than rebuilt: it is the same single field, the same resolver and the same
   * candidate chooser the populated Dashboard uses. A second form on this screen would be a second
   * thing to keep correct, and the one that is already right is the one that already works.
   */
  readonly children: ReactNode;
}

export function GettingStarted({ children }: GettingStartedProps): ReactNode {
  return (
    /*
     * **One band, not one screen.** This used to be the whole Dashboard for an account with no
     * default place: a hero-sized title, a lead paragraph, a chip row, three preview cards and two
     * next-step cards — roughly two viewports of explanation standing in front of a product whose
     * job is to show weather. `01-dashboard.png` has no such state, and the shape of the screen is
     * what makes it recognisable as the Dashboard, so the shell stays and the onboarding shrinks
     * to the one band the hero would occupy.
     *
     * What is gone is the explaining, not the helping: the field, the starter places and the way
     * to save a default are all still here, in the space the hero will take once a place is
     * chosen. The preview and next-step cards went with it — they described features the person
     * can see in the rail beside them.
     */
    <section className={styles.start} aria-labelledby="start-hero-title">
      <div className={styles.startBody}>
        <Badge tone="neutral">Getting started</Badge>
        <h2 className={styles.startTitle} id="start-hero-title">
          Choose a place to brief on
        </h2>
        <p className={styles.startLead}>
          Weathra briefs one place at a time: conditions now, the days ahead, and how they sit
          against its own record.
        </p>
        <div className={styles.startEntry}>{children}</div>

        <div className={styles.startChipRow}>
          <span className={styles.startChipLabel}>Or start with</span>
          <ul className={styles.startChips}>
            {SUGGESTIONS.map((name) => (
              <li key={name}>
                <Link className={styles.startChip} href={placeHref(name)}>
                  {name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
