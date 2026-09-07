"use client";

/**
 * `06-saved-locations.png`, rendered as the real page.
 *
 * The artifact is a populated node workspace: an attention strip, four node cards in one row, a
 * multi-node synthesis panel and a comparison rail. The production screen is an add-a-place form
 * with a list, so the two did not read as the same screen. This renders the artifact's own nodes
 * from `LOCATIONS_FIXTURE`.
 *
 * **No imagery, deliberately.** Every other product artifact puts a city photograph on its cards;
 * this one does not, and adding one because the set does elsewhere would be reinterpreting the
 * design rather than reproducing it. The cards are flat panels, as drawn.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { DataClassBadge } from "@/components/ui";
import {
  FidelityButton,
  FidelityMeter,
  Glyph,
  IntelHead,
  LinkAction,
  Panel,
  PanelBody,
  PanelHead,
  StatusStrip,
} from "@/components/fidelity/chrome";
import { LOCATIONS_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-locations.module.css";

export function FixtureLocations(): ReactNode {
  return (
    <div className={shared.page}>
      {/* --- head ------------------------------------------------------------------ */}
      <div className={shared.pageHead}>
        <div className={shared.pageHeadText}>
          <div className={shared.sectionLabel}>
            <DataClassBadge dataClass="analytics" />
            <span className={shared.sectionMeta}>{F.workspace}</span>
          </div>
          <h1 className={shared.displayTitle}>{F.title}</h1>
          <p className={shared.pageSubtitle}>{F.subtitle}</p>
        </div>
        <div className={shared.pageActions}>
          <span className={styles.search}>
            <Glyph name="search" />
            <span className={styles.searchPlaceholder}>{F.searchPlaceholder}</span>
          </span>
          <FidelityButton icon="plus" variant="accent">
            {F.addAction}
          </FidelityButton>
        </div>
      </div>

      {/* --- attention strip -------------------------------------------------------- */}
      <div className={styles.attention} role="alert">
        <span className={styles.attentionMark} aria-hidden="true">
          <Glyph name="alert" size={22} />
        </span>
        <div className={styles.attentionText}>
          <p className={styles.attentionTitle}>{F.alertTitle}</p>
          <p className={styles.attentionBody}>{F.alertBody}</p>
        </div>
        <div className={styles.attentionActions}>
          <FidelityButton caps>{F.dismissAction}</FidelityButton>
          <FidelityButton variant="danger" caps>
            {F.analyzeAction}
          </FidelityButton>
        </div>
      </div>

      {/* --- node cards ------------------------------------------------------------- */}
      <ol className={styles.nodes}>
        {F.nodes.map((node) => (
          <li className={styles.node} key={node.name}>
            <header className={styles.nodeHead}>
              <span className={styles.nodeSince} data-freshness={node.freshness}>
                {node.since}
              </span>
              <span className={styles.nodeMenu} aria-hidden="true">
                ⋮
              </span>
            </header>

            <div className={styles.nodeNames}>
              <h2 className={styles.nodeName}>{node.name}</h2>
              <p className={styles.nodeCountry}>{node.country}</p>
            </div>

            <div className={styles.nodeReading}>
              <p className={styles.nodeTemp}>
                {node.temperature}
                <span className={styles.nodeDegree}>°</span>
              </p>
              <p className={styles.nodeCondition}>{node.condition}</p>
              <dl className={styles.nodeRange}>
                <div>
                  <dt>H:</dt>
                  <dd>{node.high}</dd>
                </div>
                <div>
                  <dt>L:</dt>
                  <dd>{node.low}</dd>
                </div>
              </dl>
            </div>

            <dl className={styles.nodeStats}>
              <div>
                <dt>Precip</dt>
                <dd>
                  <Glyph name="drop" size={13} />
                  {node.precipitation}
                </dd>
              </div>
              <div>
                <dt>Humidity</dt>
                <dd>
                  <Glyph name="chart" size={13} />
                  {node.humidity}
                </dd>
              </div>
              <div>
                <dt>Wind</dt>
                <dd>
                  <Glyph name="wind" size={13} />
                  {node.wind}
                </dd>
              </div>
            </dl>

            <footer className={styles.nodeFooter}>
              <DataClassBadge dataClass="observed" />
              <LinkAction icon="chevron" caps>
                {F.nodeAction}
              </LinkAction>
            </footer>
          </li>
        ))}
      </ol>

      {/* --- synthesis + comparison ------------------------------------------------- */}
      <div className={styles.lower}>
        <Panel label={F.synthesisTitle}>
          <IntelHead
            title={F.synthesisTitle}
            agent={F.synthesisAgent}
            aside={<DataClassBadge dataClass="interpretation" />}
          />
          <div className={styles.synthesisBody}>
            <div className={styles.synthesisMain}>
              <h3 className={shared.microTitle}>
                <Glyph name="info" />
                {F.vectorTitle}
              </h3>
              <p className={shared.prose}>
                {F.vectorLead} <b className={shared.emphasis}>{F.vectorFirst}</b> {F.vectorMiddle}{" "}
                <b className={shared.emphasis}>{F.vectorSecond}</b> {F.vectorRest}
              </p>

              <div className={shared.callout}>
                <h4 className={shared.microTitle}>
                  <Glyph name="chart" />
                  {F.driftTitle}
                </h4>
                <div className={styles.driftRow}>
                  <span className={styles.driftLabel}>{F.driftLabel}</span>
                  <span className={styles.driftValue}>{F.driftValue}</span>
                </div>
                <div
                  className={shared.meterTrack}
                  role="img"
                  aria-label={`${F.driftLabel}: ${F.driftValue}. Sample value from the design mockup.`}
                >
                  <span
                    className={shared.meterFill}
                    style={{ width: `${F.driftFraction * 100}%` }}
                  />
                </div>
                <p className={styles.driftNote}>{F.driftNote}</p>
              </div>
            </div>

            <div className={`${styles.synthesisAside} ${styles.healthMeters}`}>
              <h3 className={`${shared.microTitle} ${shared.microTitleMuted}`}>{F.healthTitle}</h3>
              {F.health.map((row) => (
                <FidelityMeter
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  fraction={row.fraction}
                  tone="good"
                />
              ))}
              <FidelityButton icon="database" variant="accent" fullWidth>
                {F.evidenceAction}
              </FidelityButton>
            </div>
          </div>
        </Panel>

        <div className={styles.rail}>
          <Panel label={F.comparisonTitle}>
            <PanelHead>
              <h2 className={shared.regionTitle}>{F.comparisonTitle}</h2>
              <span className={styles.comparisonSwap} aria-hidden="true">
                <Glyph name="swap" />
              </span>
            </PanelHead>
            <PanelBody>
              <div className={styles.comparisonNodes}>
                <div className={styles.comparisonNode}>
                  <span className={styles.comparisonInitial} aria-hidden="true">
                    {F.comparisonNodes[0]?.initial}
                  </span>
                  <span className={styles.comparisonName}>{F.comparisonNodes[0]?.name}</span>
                  <span className={styles.comparisonValue}>{F.comparisonNodes[0]?.value}</span>
                </div>
                <p className={styles.comparisonDelta}>{F.comparisonDelta}</p>
                <div className={styles.comparisonNode}>
                  <span className={styles.comparisonInitial} aria-hidden="true">
                    {F.comparisonNodes[1]?.initial}
                  </span>
                  <span className={styles.comparisonName}>{F.comparisonNodes[1]?.name}</span>
                  <span className={styles.comparisonValue}>{F.comparisonNodes[1]?.value}</span>
                </div>
              </div>

              <div className={`${shared.callout} ${styles.consensus}`}>
                <h3 className={shared.microTitle}>{F.consensusTitle}</h3>
                <p className={shared.calloutBody}>{F.consensusBody}</p>
                <span className={styles.consensusBolt} aria-hidden="true">
                  <Glyph name="bolt" size={40} />
                </span>
              </div>

              <FidelityButton fullWidth>{F.matrixAction}</FidelityButton>
            </PanelBody>
          </Panel>

          <Panel label={F.metadataTitle}>
            <PanelHead>
              <h2 className={shared.sectionMeta}>{F.metadataTitle}</h2>
              <span className={`${shared.chip} ${shared.chipOk}`}>{F.metadataChip}</span>
            </PanelHead>
            <PanelBody tight>
              <dl className={shared.statRows}>
                {F.metadata.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <StatusStrip
        facts={[F.footerNetwork, F.footerNode, F.footerRelease]}
        right={F.footerProduct}
        chip={F.footerLock}
      />
    </div>
  );
}
