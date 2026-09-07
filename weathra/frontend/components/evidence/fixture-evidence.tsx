"use client";

/**
 * `05-agent-evidence.png`, rendered as the real page.
 *
 * The artifact is a *populated* audit trace: a six-node execution timeline down the left, the MCP
 * tool it called, the grounded sources it retrieved with their data classes, the deterministic
 * figures it computed, the RAG fragments it matched, the synthesis it produced, and the memory it
 * used. The production route renders an empty workspace skeleton until a run id is opened, so the
 * two did not read as the same screen. This renders the artifact's own trace from
 * `EVIDENCE_FIXTURE`.
 *
 * Every figure is sample content transcribed from the picture, and `FixtureBanner` says so.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { DataClassBadge } from "@/components/ui";
import {
  FidelityButton,
  Glyph,
  LinkAction,
  Panel,
  PanelBody,
  PanelHead,
  StatusStrip,
} from "@/components/fidelity/chrome";
import { EVIDENCE_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-evidence.module.css";

export function FixtureEvidence(): ReactNode {
  return (
    <div className={shared.page}>
      {/* --- audit header ---------------------------------------------------------- */}
      <Panel label={F.title}>
        <div className={styles.auditHead}>
          <div className={styles.auditText}>
            <div className={shared.sectionLabel}>
              <DataClassBadge dataClass="interpretation" />
              <span className={styles.auditId}>{F.auditId}</span>
            </div>
            <h1 className={shared.displayTitle}>{F.title}</h1>
            <p className={shared.pageSubtitle}>{F.subtitle}</p>
          </div>
          <dl className={styles.auditStats}>
            {F.stats.map((stat) => (
              <div key={stat.label}>
                <dt>{stat.label}</dt>
                <dd data-tone={stat.tone}>
                  {stat.tone === "good" ? <span className={styles.auditDot} aria-hidden="true" /> : null}
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Panel>

      <div className={styles.columns}>
        {/* --- left column: execution flow and MCP ----------------------------- */}
        <div className={styles.leftColumn}>
          <Panel label={F.flowTitle}>
            <PanelHead>
              <h2 className={shared.regionTitle}>
                <Glyph name="link" size={20} />
                {F.flowTitle}
              </h2>
            </PanelHead>
            <PanelBody>
              <ol className={styles.flow}>
                {F.flow.map((node) => (
                  <li className={styles.flowNode} key={node.name}>
                    <span className={styles.flowMark} aria-hidden="true">
                      <Glyph name="check" size={18} />
                    </span>
                    <div className={styles.flowCard}>
                      <header className={styles.flowCardHead}>
                        <h3 className={styles.flowName}>{node.name}</h3>
                        <span className={`${shared.chip} ${styles.flowState}`}>{F.flowState}</span>
                      </header>
                      <p className={styles.flowMeta}>
                        <span>
                          <Glyph name="database" size={12} />
                          {node.tool}
                        </span>
                        <span>
                          <Glyph name="clock" size={12} />
                          {node.duration}
                        </span>
                      </p>
                      <p className={styles.flowNote}>{node.note}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </PanelBody>
          </Panel>

          <Panel label={F.mcpTitle}>
            <PanelHead>
              <h2 className={shared.regionTitle}>
                <Glyph name="layers" size={20} />
                {F.mcpTitle}
              </h2>
            </PanelHead>
            <PanelBody>
              <div className={styles.mcpCard}>
                <header className={styles.mcpHead}>
                  <span className={`${shared.chip} ${shared.chipAccent}`}>{F.mcpChip}</span>
                  <span className={styles.mcpName}>{F.mcpName}</span>
                  <span className={styles.mcpBolt} aria-hidden="true">
                    <Glyph name="bolt" />
                  </span>
                </header>
                <p className={shared.calloutBody}>
                  {F.mcpLead} <b className={shared.strong}>{F.mcpProvider}</b>
                  {F.mcpRest}
                </p>
                <footer className={styles.mcpFooter}>
                  <span className={styles.mcpLatency}>{F.mcpLatency}</span>
                  <LinkAction>{F.mcpAction} ›</LinkAction>
                </footer>
              </div>
            </PanelBody>
          </Panel>
        </div>

        {/* --- right column ---------------------------------------------------- */}
        <div className={styles.rightColumn}>
          <Panel label={F.sourcesTitle}>
            <PanelHead>
              <div className={styles.sourcesHeadText}>
                <h2 className={shared.regionTitle}>{F.sourcesTitle}</h2>
                <p className={styles.sourcesSubtitle}>{F.sourcesSubtitle}</p>
              </div>
              <FidelityButton icon="search">{F.inspectAction}</FidelityButton>
            </PanelHead>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {F.sourceColumns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {F.sourceRows.map((row) => (
                    <tr key={row.provider}>
                      <th scope="row">{row.provider}</th>
                      <td className={shared.mono}>{row.location}</td>
                      <td>{row.period}</td>
                      <td>
                        <DataClassBadge dataClass={row.dataClass} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PanelBody>
              <div className={styles.analyticsHead}>
                <h3 className={styles.analyticsTitle}>
                  <Glyph name="chart" />
                  {F.analyticsTitle}
                </h3>
                <DataClassBadge dataClass="analytics" />
              </div>
              <ol className={styles.analytics}>
                {F.analytics.map((entry) => (
                  <li className={shared.statCard} key={entry.label}>
                    <span className={shared.statCardLabel}>{entry.label}</span>
                    <p className={styles.analyticsValue}>
                      {entry.value}
                      <span className={styles.analyticsFlag} data-tone={entry.flagTone}>
                        {entry.flag}
                      </span>
                    </p>
                    <p className={shared.statCardNote}>{entry.note}</p>
                  </li>
                ))}
              </ol>
              <p className={styles.analyticsNote}>
                <Glyph name="info" />
                <span>{F.analyticsNote}</span>
              </p>
            </PanelBody>
          </Panel>

          <Panel label={F.ragTitle}>
            <PanelHead>
              <h2 className={shared.regionTitle}>
                <Glyph name="file" size={20} />
                {F.ragTitle}
              </h2>
            </PanelHead>
            <PanelBody>
              {F.ragEntries.map((entry) => (
                <article className={styles.ragCard} key={entry.reference}>
                  <header className={styles.ragHead}>
                    <span className={`${shared.chip} ${styles.ragReference}`}>{entry.reference}</span>
                    <h3 className={styles.ragTitle}>{entry.title}</h3>
                    <span className={styles.ragSimilarity}>{entry.similarity}</span>
                  </header>
                  <p className={styles.ragQuote}>{entry.quote}</p>
                  {entry.source ? (
                    <footer className={styles.ragFooter}>
                      <span className={styles.ragSource}>
                        <Glyph name="link" size={12} />
                        {entry.source}
                      </span>
                      <span className={styles.ragIndexed}>
                        <Glyph name="clock" size={12} />
                        {entry.indexed}
                      </span>
                    </footer>
                  ) : null}
                </article>
              ))}
              <FidelityButton icon="link" fullWidth>
                {F.ragAction}
              </FidelityButton>
            </PanelBody>
          </Panel>

          <Panel label={F.synthesisTitle} className={styles.synthesisPanel}>
            <div className={styles.synthesisHead}>
              <span className={styles.synthesisMark} aria-hidden="true">
                <Glyph name="bolt" size={20} />
              </span>
              <div className={styles.synthesisHeadText}>
                <div className={shared.sectionLabel}>
                  <DataClassBadge dataClass="interpretation" />
                  <span className={styles.synthesisConfidence}>{F.synthesisConfidence}</span>
                </div>
                <h2 className={shared.panelTitle}>{F.synthesisTitle}</h2>
              </div>
              <div className={styles.synthesisActions}>
                <FidelityButton icon="shield" variant="accent">
                  {F.validateAction}
                </FidelityButton>
                <FidelityButton>{F.exportAction}</FidelityButton>
              </div>
            </div>
            <PanelBody>
              <div className={styles.synthesisBody}>
                <p className={styles.synthesisProse}>
                  {F.synthesisLead} <b className={shared.emphasis}>{F.synthesisEmphasis}</b>
                  {F.synthesisRest}
                </p>
              </div>
              <ul className={styles.evidenceChips}>
                {F.synthesisChips.map((chip) => (
                  <li key={chip} className={shared.chip}>
                    <Glyph name="link" size={12} />
                    <span className={styles.evidenceChipLabel}>Evidence:</span>
                    <b>{chip}</b>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </div>
      </div>

      {/* --- memory + stability ---------------------------------------------------- */}
      <div className={styles.lower}>
        <Panel label={F.memoryTitle}>
          <PanelHead>
            <h2 className={shared.regionTitle}>
              <Glyph name="database" size={20} />
              {F.memoryTitle}
            </h2>
          </PanelHead>
          <PanelBody>
            <div className={styles.memoryGrid}>
              <div>
                <h3 className={shared.microTitle}>
                  <Glyph name="clock" />
                  {F.conversationTitle}
                </h3>
                <ul className={styles.memoryList}>
                  {F.conversation.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className={shared.microTitle}>
                  <Glyph name="check" />
                  {F.preferencesTitle}
                </h3>
                <ul className={styles.memoryList}>
                  {F.preferences.map((entry) => (
                    <li key={entry.emphasis}>
                      {entry.label} <b className={shared.strong}>{entry.emphasis}</b>{" "}
                      <span className={styles.memoryNote}>{entry.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </PanelBody>
        </Panel>

        <Panel label={F.stabilityTitle}>
          <PanelBody>
            <div className={styles.stabilityHead}>
              <span className={shared.statCardLabel}>{F.stabilityTitle}</span>
              <span className={styles.stabilityChip}>{F.stabilityChip}</span>
            </div>
            <div
              className={shared.meterTrack}
              role="img"
              aria-label={`${F.stabilityTitle}: ${F.stabilityChip}. Sample value from the design mockup.`}
            >
              <span className={shared.meterFill} data-tone="good" style={{ width: "100%" }} />
            </div>

            <div className={`${shared.callout} ${styles.stabilityNote}`}>
              <p className={shared.calloutBody}>
                <Glyph name="alert" size={14} />{" "}
                <i>
                  {F.stabilityNote} <LinkAction>{F.stabilityAction}</LinkAction>
                </i>
              </p>
            </div>

            <dl className={styles.signature}>
              <div>
                <dt>{F.versionLabel}</dt>
                <dd>{F.versionValue}</dd>
              </div>
              <div className={styles.signatureRight}>
                <dt>{F.signatureLabel}</dt>
                <dd className={styles.signatureHash}>{F.signatureValue}</dd>
              </div>
            </dl>
          </PanelBody>
        </Panel>
      </div>

      <StatusStrip
        facts={[F.footerStream, F.footerNode, F.footerCompliance]}
        right={F.footerProduct}
        chip={F.footerLock}
      />
    </div>
  );
}
