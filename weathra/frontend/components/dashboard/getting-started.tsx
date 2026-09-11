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

import { Badge, Button, EmptyChart } from "@/components/ui";
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
interface Preview {
  readonly title: string;
  readonly blurb: string;
  /** Regions the artifact draws as a plot keep their plot. */
  readonly chart?: number;
}

const PREVIEWS: readonly Preview[] = [
  {
    title: "Current conditions",
    blurb:
      "Temperature, wind, humidity and pressure as the provider reported them, with the time they were observed.",
  },
  {
    title: "Forecast",
    blurb: "The days ahead, each with its range and its expected conditions.",
    chart: 150,
  },
  {
    title: "What changed?",
    blurb:
      "How this forecast differs from the one before it, so a revision is something you are told about rather than something you have to notice.",
  },
  {
    title: "Historical context",
    blurb: "Today measured against the climate record for the same place and time of year.",
    chart: 150,
  },
  {
    title: "Weathra Intelligence",
    blurb:
      "The model's reading of the figures above, asked for when you want it — never on arrival, because it spends part of your allowance.",
  },
];

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
    <div className={styles.start}>
      {/*
        The hero band the populated Dashboard opens on, holding the thing to do instead of a
        readout. It keeps the artifact's composition — full-width, dark, one dominant line — so the
        screen is recognisably the Dashboard before there is anything to brief on.
      */}
      <section className={styles.startHero} aria-labelledby="start-hero-title">
        <div className={styles.startHeroBody}>
          <Badge tone="neutral">Getting started</Badge>
          <h2 className={styles.startTitle} id="start-hero-title">
            Name a place, and the briefing fills in
          </h2>
          <p className={styles.startLead}>
            Weathra briefs you on one place at a time: what it is doing now, what the days ahead
            hold, and how that sits against its own record. Nothing below is filled in yet because
            no place has been chosen — not because there is nothing to show.
          </p>
          <div className={styles.startEntry}>{children}</div>
        </div>
      </section>

      <section className={styles.startSuggestions} aria-labelledby="start-suggestions-title">
        <h3 className={styles.startSectionTitle} id="start-suggestions-title">
          Or start with one of these
        </h3>
        <ul className={styles.startChips}>
          {SUGGESTIONS.map((name) => (
            <li key={name}>
              <Link className={styles.startChip} href={placeHref(name)}>
                {name}
              </Link>
            </li>
          ))}
        </ul>
        <p className={styles.startNote}>
          Each one is resolved by Weathra the same way a name you type is. Choosing one briefs
          you on it; it changes nothing about your account.
        </p>
      </section>

      <section className={styles.startPreviews} aria-labelledby="start-previews-title">
        <h3 className={styles.startSectionTitle} id="start-previews-title">
          What a briefing contains
        </h3>
        <ul className={styles.startGrid}>
          {PREVIEWS.map((preview) => (
            <li className={styles.startCard} key={preview.title}>
              <h4 className={styles.startCardTitle}>{preview.title}</h4>
              <p className={styles.startCardBlurb}>{preview.blurb}</p>
              {preview.chart === undefined ? (
                <div className={styles.startCardRule} aria-hidden="true" />
              ) : (
                <EmptyChart
                  title={preview.title}
                  reason="Choose a place and this is plotted from what the provider returns."
                  height={preview.chart}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.startNext} aria-labelledby="start-next-title">
        <h3 className={styles.startSectionTitle} id="start-next-title">
          Two things worth doing once you have one
        </h3>
        <div className={styles.startActions}>
          <div className={styles.startAction}>
            <h4 className={styles.startCardTitle}>Save it, and make it your default</h4>
            <p className={styles.startCardBlurb}>
              A default location is what the Dashboard opens on, and saved places fill the rail on
              the left so they are one press away on every screen.
            </p>
            <Link href="/locations">
              <Button variant="secondary" size="sm">
                Saved locations
              </Button>
            </Link>
          </div>
          <div className={styles.startAction}>
            <h4 className={styles.startCardTitle}>Ask the Analyst a question</h4>
            <p className={styles.startCardBlurb}>
              A question in your own words, answered from retrieved figures — and every figure in the
              answer is traceable to the evidence behind it.
            </p>
            <Link href="/analyst">
              <Button variant="secondary" size="sm">
                AI Weather Analyst
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
