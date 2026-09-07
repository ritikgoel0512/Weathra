"use client";

/**
 * `02-ai-weather-analyst.png`, rendered as the real page.
 *
 * The artifact is a *populated* analyst session: one question answered, with the answer opened out
 * into observed data, a forecast vector and an agent interpretation, and a right rail carrying the
 * agent's status, its data sources and its long-term memory. The production screen renders an empty
 * composer until somebody asks something, so a side-by-side against the artifact compared an empty
 * screen with a full one. This renders the artifact's own session from `ANALYST_FIXTURE`.
 *
 * Real components, real CSS grid, real headings — nothing here is a slice of the mockup. Every
 * figure is sample content transcribed from the picture, and `FixtureBanner` says so at the top of
 * the viewport for as long as this mode is on.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { DataClassBadge } from "@/components/ui";
import {
  FidelityButton,
  FidelityMeter,
  Glyph,
  Panel,
  PanelBody,
  PanelHead,
} from "@/components/fidelity/chrome";
import { ANALYST_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-analyst.module.css";

/**
 * The rail's "Active Data Sources" panel opens on a dark striated field.
 *
 * Originated here as an SVG rather than sourced: the artifact's own tile is generated imagery, and
 * a downloaded photograph would carry a licence question this pass has no standing to answer. What
 * is reproduced is its visual role — a dark technical field the source chips sit on — and nothing
 * in it encodes a measurement.
 */
function SourceField(): ReactNode {
  const strands = Array.from({ length: 34 }, (_, index) => index);
  return (
    <svg
      className={styles.sourceField}
      viewBox="0 0 320 150"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="320" height="150" className={styles.sourceFieldGround} />
      {strands.map((index) => {
        const x = (index / (strands.length - 1)) * 320;
        const lean = ((index % 7) - 3) * 6;
        const top = 8 + ((index * 13) % 26);
        return (
          <path
            key={index}
            className={styles.sourceStrand}
            d={`M${x} 150 C ${x + lean} 104, ${x - lean} 58, ${x + lean / 2} ${top}`}
            style={{ opacity: 0.16 + ((index * 7) % 10) / 26 }}
          />
        );
      })}
    </svg>
  );
}

export function FixtureAnalyst(): ReactNode {
  return (
    <div className={shared.page}>
      {/* --- workspace header ------------------------------------------------------ */}
      <header className={styles.workspaceBar}>
        <span className={styles.workspaceMark} aria-hidden="true">
          <Glyph name="spark" size={20} />
        </span>
        <div className={styles.workspaceText}>
          <h1 className={styles.workspaceTitle}>{F.workspace}</h1>
          <p className={styles.workspaceMeta}>
            <span className={styles.liveDot}>{F.session}</span>
            <span className={shared.mono}>{F.thread}</span>
          </p>
        </div>
        <div className={styles.workspaceActions}>
          <FidelityButton icon="clock">{F.historyAction}</FidelityButton>
          <FidelityButton icon="plus">{F.newAction}</FidelityButton>
        </div>
      </header>

      <div className={styles.columns}>
        {/* --- conversation ------------------------------------------------------- */}
        <section className={styles.thread} aria-label="Analyst conversation">
          <p className={styles.contextNote}>
            <Glyph name="info" />
            <span>
              {F.contextNotePrefix} <b>{F.contextNoteEmphasis}</b> {F.contextNoteSuffix}
            </span>
          </p>

          {/* the person's turn, right-aligned as the artifact draws it */}
          <article className={styles.askTurn} aria-label="Question">
            <p className={styles.turnByline}>
              <span className={styles.turnRole}>{F.askerRole}</span>
              <span className={`${styles.turnTime} ${shared.mono}`}>{F.askerTime}</span>
            </p>
            <div className={styles.askRow}>
              <p className={styles.askBubble}>{F.question}</p>
              <span className={styles.askAvatar} aria-hidden="true">
                <Glyph name="person" size={18} />
              </span>
            </div>
          </article>

          {/* the agent's turn */}
          <article className={styles.answerTurn} aria-label="Answer">
            <span className={styles.answerAvatar} aria-hidden="true">
              <Glyph name="spark" size={18} />
            </span>
            <div className={styles.answerCard}>
              <header className={styles.answerHead}>
                <span className={styles.turnRole}>{F.agentRole}</span>
                <span className={`${styles.turnTime} ${shared.mono}`}>{F.agentTime}</span>
              </header>

              <div className={styles.answerBand}>
                <DataClassBadge dataClass="interpretation" />
                <span className={styles.grounding}>{F.grounding}</span>
              </div>

              <div className={styles.answerBody}>
                <p className={shared.prose}>
                  {F.leadPrefix} <b className={shared.emphasis}>{F.leadStation}</b>
                  {F.leadSuffix}
                </p>

                <div className={styles.dataPair}>
                  <div className={styles.dataPanel}>
                    <header className={styles.dataPanelHead}>
                      <h3 className={shared.microTitle}>{F.observedTitle}</h3>
                      <DataClassBadge dataClass="observed" />
                    </header>
                    <dl className={`${shared.statRows} ${shared.statRowsPlain}`}>
                      {F.observed.map((row) => (
                        <div key={row.label}>
                          <dt>{row.label}</dt>
                          <dd data-tone={row.tone}>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>

                  <div className={styles.dataPanel}>
                    <header className={styles.dataPanelHead}>
                      <h3 className={shared.microTitle}>{F.forecastTitle}</h3>
                      <DataClassBadge dataClass="forecast" />
                    </header>
                    <dl className={`${shared.statRows} ${shared.statRowsPlain}`}>
                      {F.forecast.map((row) => (
                        <div key={row.label}>
                          <dt>{row.label}</dt>
                          <dd data-tone={row.tone}>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>

                <div className={styles.interpretation}>
                  <h3 className={shared.microTitle}>
                    <Glyph name="spark" />
                    {F.interpretationTitle}
                  </h3>
                  <p className={shared.prose}>
                    {F.interpretationLead}{" "}
                    <b className={shared.emphasis}>{F.interpretationEmphasis}</b>{" "}
                    {F.interpretationRest}
                  </p>
                </div>
              </div>

              <footer className={styles.answerFooter}>
                <span>
                  <Glyph name="database" />
                  {F.turnSources}
                </span>
                <span>
                  <Glyph name="clock" />
                  {F.turnContext}
                </span>
                <span className={styles.answerProvenance}>{F.turnProvenance}</span>
              </footer>
            </div>
          </article>

          {/* --- suggestions and composer --------------------------------------- */}
          <div className={styles.composerZone}>
            <ul className={styles.suggestions}>
              {F.suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" className={styles.suggestion}>
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>

            <div className={styles.composer}>
              <div className={styles.composerBar}>
                <span className={styles.composerFacet}>
                  <Glyph name="pin" />
                  <span className={styles.composerFacetLabel}>{F.focusLabel}</span>
                  <b>{F.focusValue}</b>
                </span>
                <span className={styles.composerFacet}>
                  <Glyph name="database" />
                  <span className={styles.composerFacetLabel}>{F.depthLabel}</span>
                  <b>{F.depthValue}</b>
                </span>
              </div>
              <div className={styles.composerField}>
                <p className={styles.composerPlaceholder}>{F.composerPlaceholder}</p>
                <div className={styles.composerActions}>
                  <span className={styles.composerIcon} aria-hidden="true">
                    <Glyph name="chart" size={18} />
                  </span>
                  <span className={styles.composerSend} aria-hidden="true">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 3L10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7z" />
                    </svg>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* --- right rail --------------------------------------------------------- */}
        <aside className={styles.rail} aria-label="Analyst context">
          <Panel label={F.statusTitle}>
            <PanelHead>
              <h2 className={shared.sectionMeta}>{F.statusTitle}</h2>
              <span className={`${shared.chip} ${shared.chipOk}`}>{F.statusChip}</span>
            </PanelHead>
            <PanelBody tight>
              <div className={styles.agentRow}>
                <span className={styles.agentOrb} aria-hidden="true" />
                <div>
                  <p className={styles.agentName}>{F.agentName}</p>
                  <p className={`${styles.agentProcess} ${shared.mono}`}>{F.agentProcess}</p>
                </div>
              </div>
              <FidelityMeter
                label={F.computeLabel}
                value={F.computeValue}
                fraction={F.computeFraction}
              />
            </PanelBody>
          </Panel>

          <Panel label={F.sourcesTitle}>
            <PanelHead>
              <h2 className={shared.sectionMeta}>{F.sourcesTitle}</h2>
            </PanelHead>
            <PanelBody tight>
              <div className={styles.sourceTile}>
                <SourceField />
                <div className={styles.sourceChips}>
                  {F.sourceChips.map((chip) => (
                    <span key={chip} className={`${shared.chip} ${shared.chipOk}`}>
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
              <ul className={styles.sourceList}>
                {F.sources.map((source) => (
                  <li key={source.name} className={styles.sourceRow}>
                    <span className={styles.sourceDot} aria-hidden="true" />
                    <span className={styles.sourceText}>
                      <b>{source.name}</b>
                      <span>{source.role}</span>
                    </span>
                    <span className={styles.sourceCheck} aria-hidden="true">
                      <Glyph name="check" />
                    </span>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>

          <Panel label={F.contextTitle}>
            <PanelHead>
              <h2 className={shared.sectionMeta}>{F.contextTitle}</h2>
            </PanelHead>
            <PanelBody tight>
              <div className={`${shared.callout} ${shared.calloutAccent}`}>
                <h3 className={shared.microTitle}>
                  <Glyph name="spark" />
                  {F.memoryTitle}
                </h3>
                <ul className={styles.memoryList}>
                  {F.memory.map((entry) => (
                    <li key={entry.emphasis}>
                      {entry.lead} <b className={shared.strong}>{entry.emphasis}</b> {entry.rest}
                    </li>
                  ))}
                </ul>
              </div>
              <FidelityMeter
                label={F.synthesisLabel}
                value={F.synthesisValue}
                fraction={F.synthesisFraction}
              />
              <FidelityButton icon="chart" variant="accent" fullWidth>
                {F.evidenceAction}
              </FidelityButton>
            </PanelBody>
          </Panel>

          <div className={`${shared.callout} ${shared.calloutWarn}`}>
            <p className={styles.calibration}>
              <Glyph name="alert" />
              <span>{F.calibrationNote}</span>
            </p>
          </div>

          <p className={styles.railStatus}>
            <span className={shared.statusOk}>{F.footerStatus}</span>
            <span className={shared.mono}>{F.footerVersion}</span>
          </p>
        </aside>
      </div>
    </div>
  );
}
