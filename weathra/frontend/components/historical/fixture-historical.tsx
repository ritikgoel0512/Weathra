"use client";

/**
 * `03-historical-analytics.png`, rendered as the real page.
 *
 * The artifact is a populated analytics screen: six metric cards, a recorded-against-normal chart
 * with a precipitation series over it, a deviation panel and an anomaly-intelligence rail. The
 * production screen shows prose panels and an empty chart until a period is chosen and retrieved,
 * so the two did not read as the same screen. This renders the artifact's own period from
 * `HISTORICAL_FIXTURE`.
 *
 * Charts are real SVG drawn from the fixture series on the artifact's own two-axis geometry — not
 * an image of a chart. Every figure is sample content, and `FixtureBanner` says so.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { DataClassBadge } from "@/components/ui";
import {
  FidelityButton,
  Glyph,
  IntelHead,
  LinkAction,
  Panel,
  PanelBody,
  PanelHead,
  StatusStrip,
} from "@/components/fidelity/chrome";
import { HISTORICAL_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-historical.module.css";

/**
 * The artifact's period chart: the recorded curve with its filled area, the dashed 30-year normal
 * beneath it, and the precipitation bars on their own right-hand scale.
 *
 * Two axes because the artifact draws two — degrees on the left, millimetres on the right — and a
 * single scale would flatten the bars into the curve.
 */
function PeriodChart(): ReactNode {
  const width = 1120;
  const height = 400;
  const pad = { top: 24, right: 46, bottom: 38, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const tempMax = 22;
  const tempMin = 8;
  const precipMax = 12;

  const count = F.recorded.length;
  const x = (index: number) => pad.left + (index / (count - 1)) * plotW;
  const yTemp = (value: number) =>
    pad.top + plotH - ((value - tempMin) / (tempMax - tempMin)) * plotH;
  const yPrecip = (value: number) => pad.top + plotH - (value / precipMax) * plotH;

  const line = (series: readonly number[]) =>
    series.map((value, index) => `${x(index)},${yTemp(value)}`).join(" ");

  const area = `${pad.left},${pad.top + plotH} ${line(F.recorded)} ${pad.left + plotW},${
    pad.top + plotH
  }`;

  return (
    <svg
      className={styles.chartSvg}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Sample recorded temperature against the 30-year normal, with precipitation. From the design mockup."
    >
      {[10, 15, 20].map((tick) => (
        <g key={`t${tick}`}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yTemp(tick)}
            y2={yTemp(tick)}
            className={shared.chartGrid}
          />
          <text
            x={pad.left - 10}
            y={yTemp(tick) + 4}
            className={shared.chartTick}
            textAnchor="end"
          >
            {tick}
          </text>
        </g>
      ))}

      {[0, 3, 6, 9, 12].map((tick) => (
        <text
          key={`p${tick}`}
          x={width - pad.right + 12}
          y={yPrecip(tick) + 4}
          className={shared.chartTick}
          textAnchor="start"
        >
          {tick}
        </text>
      ))}

      <polygon className={shared.chartArea} points={area} />
      <polyline className={shared.chartLineDashed} points={line(F.normal)} />
      <polyline className={shared.chartLine} points={line(F.recorded)} />

      {F.precip.map((value, index) =>
        value === 0 ? null : (
          <rect
            key={index}
            className={shared.chartBar}
            x={x(index) - 8}
            y={yPrecip(value)}
            width={22}
            height={pad.top + plotH - yPrecip(value)}
            rx={1}
          />
        ),
      )}

      {F.chartDays.map((day, index) => (
        <text
          key={day}
          x={pad.left + (index / (F.chartDays.length - 1)) * plotW}
          y={height - 8}
          className={shared.chartTick}
          textAnchor="middle"
        >
          {day}
        </text>
      ))}
    </svg>
  );
}

export function FixtureHistorical(): ReactNode {
  return (
    <div className={shared.page}>
      {/* --- page head ------------------------------------------------------------- */}
      <div className={styles.head}>
        <span className={styles.headMark} aria-hidden="true" />
        <div className={styles.headText}>
          <h1 className={shared.displayTitle}>{F.title}</h1>
          <p className={styles.headMeta}>
            <span className={styles.headPlace}>
              <Glyph name="pin" />
              {F.place}
            </span>
            <span className={styles.headSeparator} aria-hidden="true" />
            <span className={`${shared.chip} ${styles.stationChip}`}>{F.station}</span>
          </p>
        </div>
        <div className={styles.headActions}>
          <span className={styles.rangeControl}>
            <Glyph name="calendar" />
            <span className={shared.mono}>{F.range}</span>
          </span>
          <span className={styles.unitToggle} role="group" aria-label="Temperature unit">
            {F.units.map((unit, index) => (
              <button
                key={unit}
                type="button"
                className={styles.unitOption}
                data-active={index === 0 ? "true" : undefined}
              >
                {unit}
              </button>
            ))}
          </span>
          <FidelityButton icon="download" caps>
            {F.exportAction}
          </FidelityButton>
        </div>
      </div>

      {/* --- metric cards ---------------------------------------------------------- */}
      <ol className={styles.metrics}>
        {F.metrics.map((metric) => (
          <li className={styles.metric} key={metric.label}>
            <header className={styles.metricHead}>
              <span className={styles.metricIcon} aria-hidden="true">
                <Glyph name={metric.icon} />
              </span>
              <DataClassBadge dataClass="analytics" />
            </header>
            <p className={styles.metricLabel}>{metric.label}</p>
            <p className={styles.metricValue}>
              {metric.value}
              <span className={styles.metricUnit}>{metric.unit}</span>
            </p>
            <p className={styles.metricNote} data-tone={metric.tone}>
              {metric.tone === "warn" ? (
                <Glyph name="chart" size={12} />
              ) : metric.tone === "good" ? (
                <Glyph name="chart" size={12} />
              ) : null}
              {metric.note}
            </p>
          </li>
        ))}
      </ol>

      {/* --- period chart ---------------------------------------------------------- */}
      <Panel label={F.chartTitle}>
        <PanelHead>
          <div className={styles.chartHeadText}>
            <div className={shared.sectionLabel}>
              <DataClassBadge dataClass="historical" />
              <DataClassBadge dataClass="analytics" />
            </div>
            <h2 className={styles.chartTitle}>{F.chartTitle}</h2>
            <p className={shared.panelSubtitle}>{F.chartSubtitle}</p>
          </div>
          <div className={shared.legend}>
            <span>
              <span className={`${shared.legendSwatch} ${shared.legendSwatchLine}`} />
              {F.chartLegend[0]}
            </span>
            <span>
              <span className={`${shared.legendSwatch} ${shared.legendSwatchLine} ${shared.legendSwatchMuted}`} />
              {F.chartLegend[1]}
            </span>
            <span>
              <span className={`${shared.legendSwatch} ${shared.legendSwatchBar}`} />
              {F.chartLegend[2]}
            </span>
          </div>
        </PanelHead>
        <div className={styles.chartWrap}>
          <PeriodChart />
        </div>
        <footer className={styles.chartFooter}>
          <div className={styles.chartFact}>
            <dt>{F.confidenceLabel}</dt>
            <dd className={styles.chartFactAccent}>{F.confidenceValue}</dd>
          </div>
          <div className={styles.chartFact}>
            <dt>{F.sourceLabel}</dt>
            <dd>{F.sourceValue}</dd>
          </div>
          <span className={styles.chartFooterAction}>
            <LinkAction icon="link">{F.metadataAction}</LinkAction>
          </span>
        </footer>
      </Panel>

      {/* --- comparison + anomaly -------------------------------------------------- */}
      <div className={styles.lower}>
        <Panel label={F.comparisonTitle}>
          <PanelBody>
            <div className={styles.comparisonHead}>
              <h2 className={styles.comparisonTitle}>{F.comparisonTitle}</h2>
              <p className={shared.panelSubtitle}>{F.comparisonSubtitle}</p>
            </div>

            <ol className={styles.comparisonStats}>
              {F.comparisonStats.map((stat) => (
                <li className={shared.statCard} key={stat.label}>
                  <div className={shared.statCardHead}>
                    <span className={shared.statCardLabel}>{stat.label}</span>
                    <span
                      className={`${shared.chip} ${
                        stat.chipTone === "critical"
                          ? shared.chipCritical
                          : stat.chipTone === "warn"
                            ? shared.chipWarn
                            : shared.chipAccent
                      }`}
                    >
                      {stat.chip}
                    </span>
                  </div>
                  <p className={shared.statCardValue}>{stat.value}</p>
                </li>
              ))}
            </ol>

            <div className={styles.deviation}>
              <h3 className={`${shared.microTitle} ${shared.microTitleMuted}`}>
                {F.deviationTitle}
              </h3>
              {F.deviations.map((row) => (
                <div className={shared.meter} key={row.label}>
                  <div className={shared.meterHead}>
                    <span className={shared.meterLabel}>{row.label}</span>
                    <span className={shared.meterValue} data-tone={row.tone}>
                      {row.value}
                    </span>
                  </div>
                  <div
                    className={shared.meterTrack}
                    role="img"
                    aria-label={`${row.label}: ${row.value}. Sample value from the design mockup.`}
                  >
                    <span
                      className={shared.meterFill}
                      data-tone={row.tone}
                      style={{ width: `${row.fraction * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </PanelBody>
        </Panel>

        <Panel label={F.anomalyTitle} className={styles.anomalyPanel}>
          <IntelHead
            title={F.anomalyTitle}
            agent={F.anomalyAgent}
            aside={<DataClassBadge dataClass="interpretation" />}
          />
          <PanelBody>
            <div className={styles.surge}>
              <h3 className={shared.microTitle}>
                <Glyph name="chart" />
                {F.surgeTitle}
              </h3>
              <p className={shared.prose}>
                {F.surgeLead} <b className={shared.emphasis}>{F.surgeEmphasis}</b>
                {F.surgeRest}
              </p>
            </div>

            <div>
              <h3 className={`${shared.microTitle} ${shared.microTitleMuted}`}>
                {F.insightsTitle}
              </h3>
              <ul className={styles.insights}>
                {F.insights.map((insight) => (
                  <li key={insight.lead}>
                    {insight.lead}
                    {insight.emphasis ? (
                      <>
                        {" "}
                        <b className={shared.strong}>{insight.emphasis}</b>
                        {insight.rest}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            <div className={styles.anomalyActions}>
              <FidelityButton icon="chart" variant="accent" fullWidth>
                {F.anomalyAction}
              </FidelityButton>
              <span className={styles.recalibrate}>
                <LinkAction>{F.recalibrateAction}</LinkAction>
              </span>
            </div>
          </PanelBody>
        </Panel>
      </div>

      <StatusStrip
        facts={[F.footerPipeline, F.footerData]}
        right={F.footerRef}
        chip={F.footerVersion}
      />
    </div>
  );
}
