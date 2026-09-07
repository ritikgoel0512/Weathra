"use client";

/**
 * `07-settings.png`, rendered as the real page.
 *
 * The artifact is one tab of four, laid out on a three-track grid: the group's name and blurb on
 * the left, each preference's label and description in the middle, its control on the right. The
 * production screen stacks its groups in a single column, so the two did not read as the same
 * screen. This renders the artifact's own General tab from `SETTINGS_FIXTURE`.
 *
 * **The controls are inert, and that is the honest choice.** `PreferenceUpdate` carries units, time
 * format and a default place; it has no forecast horizon, no station node and no timezone field,
 * and wiring the artifact's controls to nothing — or inventing backend fields to receive them —
 * would be worse than showing them as the picture shows them. So they are reproduced for geometry
 * and do nothing, and the production Settings screen keeps every control it actually honours.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { FidelityButton, Glyph, LinkAction } from "@/components/fidelity/chrome";
import { SETTINGS_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-settings.module.css";

/** The artifact's chevron-closed select. Inert: it opens nothing. */
function SelectControl({
  value,
  wide = false,
}: {
  readonly value: string;
  readonly wide?: boolean;
}): ReactNode {
  return (
    <span className={wide ? `${styles.select} ${styles.selectWide}` : styles.select}>
      <span className={styles.selectValue}>{value}</span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M6 9.5l6 6 6-6" />
      </svg>
    </span>
  );
}

export function FixtureSettings(): ReactNode {
  return (
    <div className={shared.page}>
      {/* --- head ------------------------------------------------------------------ */}
      <div className={styles.head}>
        <span className={styles.headMark} aria-hidden="true">
          {/* The artifact's mark is a cog. `shield` stood in for it and read as a different idea. */}
          <Glyph name="gear" size={22} />
        </span>
        <div className={styles.headText}>
          <h1 className={shared.displayTitle}>{F.title}</h1>
          <p className={shared.pageSubtitle}>{F.subtitle}</p>
        </div>
      </div>

      {/* --- tabs ------------------------------------------------------------------ */}
      <div className={styles.tabs} role="tablist" aria-label="Settings sections">
        {F.tabs.map((tab, index) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={index === 0}
            className={styles.tab}
            data-active={index === 0 ? "true" : undefined}
          >
            <Glyph name={tab.icon} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* --- groups ---------------------------------------------------------------- */}
      {F.groups.map((group, groupIndex) => (
        <section
          className={styles.group}
          key={group.title}
          aria-label={group.title}
          data-first={groupIndex === 0 ? "true" : undefined}
        >
          <div className={styles.groupIntro}>
            <h2 className={styles.groupTitle}>
              <span className={styles.groupIcon} aria-hidden="true">
                <Glyph name={group.icon} size={20} />
              </span>
              {group.title}
            </h2>
            <p className={styles.groupBlurb}>{group.description}</p>
          </div>

          <div className={styles.rows}>
            {group.rows.map((row) => (
              <div className={styles.row} key={row.label}>
                <div className={styles.rowText}>
                  <p className={styles.rowLabel}>{row.label}</p>
                  <p className={styles.rowDescription}>{row.description}</p>
                </div>
                <div className={styles.rowControl}>
                  {row.chip ? <span className={styles.rowChip}>{row.chip}</span> : null}
                  {row.control === "segmented" ? (
                    <span className={styles.segmented} role="group" aria-label={row.label}>
                      {row.options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={styles.segment}
                          data-active={option === row.value ? "true" : undefined}
                        >
                          {option}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <SelectControl
                      value={row.value}
                      /* Both of these carry a long value the artifact shows in full. */
                      wide={
                        row.label === "Default Station Node" || row.label === "Primary Timezone"
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* --- save strip ------------------------------------------------------------ */}
      <footer className={styles.saveStrip}>
        <span className={shared.statusOk}>{F.syncedLabel}</span>
        <span className={styles.saveDivider} aria-hidden="true" />
        <span className={`${styles.saveTime} ${shared.mono}`}>{F.lastSave}</span>
        <span className={styles.saveActions}>
          <LinkAction caps>{F.discardAction}</LinkAction>
          <FidelityButton icon="download" variant="accent" caps>
            {F.saveAction}
          </FidelityButton>
        </span>
      </footer>

      <p className={styles.finePrint}>
        <span>{F.license}</span>
        <span className={styles.legalLinks}>
          {F.legalLinks.map((link) => (
            <span key={link}>{link}</span>
          ))}
        </span>
      </p>
    </div>
  );
}
