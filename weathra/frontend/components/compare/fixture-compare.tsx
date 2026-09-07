"use client";

/**
 * `04-compare-cities.png`, rendered as the real page.
 *
 * The tallest of the artifacts, and the one the production screen diverged from most: it is a
 * two-node comparison workspace with photographic city banners, a synthesis panel, a seven-day
 * differential matrix, an intra-day differential chart, a decadal baseline band and a closing
 * summary. The production screen renders a ranking of candidates. This renders the artifact's own
 * comparison from `COMPARE_FIXTURE`.
 *
 * Charts are real SVG from the fixture series. Every figure is sample content, and `FixtureBanner`
 * says so for as long as this mode is on.
 *
 * Reached only when `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, a build-time constant.
 */

import type { ReactNode } from "react";

import { DataClassBadge, LocationImage } from "@/components/ui";
import {
  DecadalField,
  FidelityButton,
  FidelityMeter,
  Glyph,
  IntelHead,
  Panel,
  PanelBody,
  PanelHead,
  StatusStrip,
} from "@/components/fidelity/chrome";
import { COMPARE_FIXTURE as F } from "@/lib/fixtures/visily";

import shared from "@/components/fidelity/fidelity.module.css";
import styles from "./fixture-compare.module.css";

/** The matrix's day glyphs, mapped onto the shared line set. */
function DayGlyph({ kind }: { readonly kind: string }): ReactNode {
  const name = kind === "sun" ? "sun" : kind === "rain" ? "rain" : "cloud";
  return <Glyph name={name} size={20} />;
}

/**
 * The artifact's intra-day differential: two temperature curves — the compared cities — over a bar
 * series, on one shared scale as the artifact draws it.
 */
function DifferentialChart(): ReactNode {
  const width = 720;
  const height = 320;
  const pad = { top: 20, right: 30, bottom: 34, left: 46 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = 40;

  const count = F.pulseLeftLine.length;
  const x = (index: number) => pad.left + (index / (count - 1)) * plotW;
  const y = (value: number) => pad.top + plotH - (value / max) * plotH;

  const line = (series: readonly number[]) =>
    series.map((value, index) => `${x(index)},${y(value)}`).join(" ");

  return (
    <svg
      className={styles.pulseSvg}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Sample intra-day temperature and precipitation for the two compared cities. From the design mockup."
    >
      {[0, 10, 20, 30, 40].map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(tick)}
            y2={y(tick)}
            className={shared.chartGrid}
          />
          <text x={pad.left - 10} y={y(tick) + 4} className={shared.chartTick} textAnchor="end">
            {tick}
          </text>
        </g>
      ))}

      {F.pulseBars.map((value, index) =>
        value === 0 ? null : (
          <rect
            key={index}
            className={styles.pulseBar}
            x={x(index) - 9}
            y={y(value)}
            width={18}
            height={pad.top + plotH - y(value)}
            rx={1}
          />
        ),
      )}

      <polyline className={shared.chartLineMuted} points={line(F.pulseRightLine)} />
      <polyline className={shared.chartLine} points={line(F.pulseLeftLine)} />

      {F.pulseHours.map((hour, index) => (
        <text
          key={hour}
          x={x(index)}
          y={height - 10}
          className={shared.chartTick}
          textAnchor="middle"
        >
          {hour}
        </text>
      ))}
    </svg>
  );
}

export function FixtureCompare(): ReactNode {
  return (
    <div className={`${shared.page} ${styles.comparePage}`}>
      {/* --- head ------------------------------------------------------------------ */}
      <div className={shared.pageHead}>
        <div className={shared.pageHeadText}>
          <div className={shared.sectionLabel}>
            <DataClassBadge dataClass="analytics" />
            <span className={shared.sectionMeta}>{F.workspace}</span>
          </div>
          <h1 className={shared.displayTitle}>{F.title}</h1>
        </div>
        <div className={styles.selector}>
          <span className={styles.selectorNode}>
            <Glyph name="pin" />
            {F.left}
          </span>
          <span className={styles.selectorSwap} aria-hidden="true">
            <Glyph name="swap" />
          </span>
          <span className={styles.selectorNode}>
            <Glyph name="pin" />
            {F.right}
          </span>
          <span className={styles.selectorDivider} aria-hidden="true" />
          <span className={styles.selectorWindow}>
            <Glyph name="calendar" />
            {F.window}
          </span>
        </div>
      </div>

      {/* --- city cards ------------------------------------------------------------ */}
      <div className={styles.cities}>
        {F.cities.map((city) => (
          <section className={styles.cityCard} key={city.name} aria-label={city.name}>
            <LocationImage
              displayName={`${city.name}, ${city.country}`}
              latitude={city.latitude}
              longitude={city.longitude}
              variant="banner"
              scrim="soft"
            >
              <div className={styles.cityBanner}>
                <div className={styles.cityChips}>
                  <DataClassBadge dataClass={city.dataClass} />
                  <span className={styles.cityStation}>
                    <Glyph name="pin" size={12} />
                    {city.station}
                  </span>
                </div>
                <div className={styles.cityNames}>
                  <h2 className={styles.cityName}>{city.name}</h2>
                  <p className={styles.cityCountry}>{city.country}</p>
                </div>
              </div>
            </LocationImage>

            <div className={styles.cityReading}>
              <div>
                <p className={styles.cityTemp}>
                  {city.temperature}
                  <span className={styles.cityDegree}>°</span>
                </p>
                <p className={styles.cityCondition}>{city.condition}</p>
              </div>
              <ul className={styles.cityFlags}>
                {F.cityBadges.map((badge, index) => (
                  <li key={badge}>
                    <Glyph name={index === 0 ? "clock" : "bolt"} size={14} />
                    {badge}
                  </li>
                ))}
              </ul>
            </div>

            <dl className={styles.cityStats}>
              <div>
                <dt>Humidity</dt>
                <dd>
                  <Glyph name="drop" size={14} />
                  {city.humidity}
                </dd>
              </div>
              <div>
                <dt>Wind</dt>
                <dd>
                  <Glyph name="wind" size={14} />
                  {city.wind} {city.windDirection}
                </dd>
              </div>
            </dl>
          </section>
        ))}
      </div>

      {/* --- comparison intelligence ----------------------------------------------- */}
      <Panel label={F.intelligenceTitle}>
        <IntelHead
          title={F.intelligenceTitle}
          agent={F.intelligenceAgent}
          aside={<DataClassBadge dataClass="interpretation" />}
        />
        <div className={styles.intelBody}>
          <div className={styles.intelMain}>
            <h3 className={shared.microTitle}>
              <Glyph name="info" />
              {F.varianceTitle}
            </h3>
            <p className={shared.prose}>
              {F.varianceLead} <b className={shared.emphasis}>{F.varianceEmphasis}</b>{" "}
              {F.varianceRest}
            </p>

            <div className={styles.reasonPair}>
              <div className={`${shared.callout} ${styles.reasonAccent}`}>
                <div className={styles.reasonHead}>
                  <h4 className={shared.microTitle}>{F.whatChangedTitle}</h4>
                  <Glyph name="chart" />
                </div>
                <p className={shared.calloutBody}>{F.whatChanged}</p>
              </div>
              <div className={shared.callout}>
                <div className={styles.reasonHead}>
                  <h4 className={`${shared.microTitle} ${shared.microTitleMuted}`}>{F.whyTitle}</h4>
                  <Glyph name="layers" />
                </div>
                <p className={shared.calloutBody}>{F.why}</p>
              </div>
            </div>
          </div>

          <div className={styles.intelAside}>
            <h3 className={`${shared.microTitle} ${shared.microTitleMuted}`}>
              {F.synthesisTitle}
            </h3>
            {F.synthesisMeters.map((meter) => (
              <FidelityMeter
                key={meter.label}
                label={meter.label}
                value={meter.value}
                fraction={meter.fraction}
                tone={meter.label === "Data Density" ? "good" : "accent"}
              />
            ))}
            <FidelityButton icon="chart" variant="accent" fullWidth>
              {F.evidenceAction}
            </FidelityButton>
          </div>
        </div>
      </Panel>

      {/* --- differential matrix --------------------------------------------------- */}
      <section aria-label={F.matrixTitle}>
        <header className={styles.bandHead}>
          <div className={styles.bandHeadText}>
            <div className={shared.sectionLabel}>
              <DataClassBadge dataClass="forecast" />
              <span className={shared.sectionMeta}>{F.matrixLabel}</span>
            </div>
            <h2 className={styles.bandTitle}>{F.matrixTitle}</h2>
          </div>
          <div className={shared.legend}>
            <span>
              <span className={shared.legendSwatch} style={{ borderRadius: "999px" }} />
              {F.left.toUpperCase()}
            </span>
            <span>
              <span
                className={`${shared.legendSwatch} ${shared.legendSwatchMuted}`}
                style={{ borderRadius: "999px" }}
              />
              {F.right.toUpperCase()}
            </span>
          </div>
        </header>

        <ol className={styles.matrix}>
          {F.matrix.map((row) => (
            <li className={styles.matrixRow} key={row.day}>
              <span className={styles.matrixDay}>{row.day}</span>
              <span className={styles.matrixCell}>
                <span className={styles.matrixIcon}>
                  <DayGlyph kind={row.left.icon} />
                </span>
                <span className={styles.matrixTemp}>{row.left.temperature}</span>
              </span>
              <span className={`${styles.matrixCell} ${styles.matrixCellRight}`}>
                <span className={styles.matrixIcon}>
                  <DayGlyph kind={row.right.icon} />
                </span>
                <span className={styles.matrixTemp}>{row.right.temperature}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* --- pulse differential + deterministic metrics ---------------------------- */}
      <div className={styles.pulseRow}>
        <Panel label={F.pulseTitle}>
          <PanelHead>
            <div className={styles.pulseHeadText}>
              <h2 className={shared.panelTitle}>{F.pulseTitle}</h2>
              <p className={shared.panelSubtitle}>{F.pulseSubtitle}</p>
            </div>
            <div className={shared.legend}>
              <span>
                <span className={shared.legendSwatch} style={{ borderRadius: "999px" }} />
                {F.pulseLegend[0]}
              </span>
              <span>
                <span
                  className={`${shared.legendSwatch} ${shared.legendSwatchMuted}`}
                  style={{ borderRadius: "999px" }}
                />
                {F.pulseLegend[1]}
              </span>
            </div>
          </PanelHead>
          <div className={styles.pulseWrap}>
            <DifferentialChart />
          </div>
        </Panel>

        <Panel label={F.metricsTitle} className={styles.metricsPanel}>
          <PanelHead>
            <span className={styles.regionTitleWrap}>
              <h2 className={shared.regionTitle}>{F.metricsTitle}</h2>
            </span>
          </PanelHead>
          <PanelBody>
            <ul className={styles.metricList}>
              {F.metrics.map((metric) => (
                <li className={styles.metricRow} key={metric.label}>
                  <span className={styles.metricIcon} aria-hidden="true">
                    <Glyph name={metric.icon} />
                  </span>
                  <span className={styles.metricName}>{metric.label}</span>
                  <span className={styles.metricValue}>{metric.value}</span>
                </li>
              ))}
            </ul>
            <div className={`${shared.callout} ${shared.calloutCritical}`}>
              <p className={`${shared.calloutTitle} ${shared.calloutTitleCritical}`}>
                <Glyph name="alert" /> {F.criticalTitle}
              </p>
              <p className={shared.calloutBody}>{F.criticalBody}</p>
            </div>
          </PanelBody>
        </Panel>
      </div>

      {/* --- decadal baseline ------------------------------------------------------ */}
      <section className={styles.baseline} aria-label={F.baselineTitle}>
        <div className={styles.baselineText}>
          <DataClassBadge dataClass="historical" />
          <h2 className={styles.baselineTitle}>{F.baselineTitle}</h2>
          <p className={shared.prose}>
            {F.baselineLead} <b className={shared.emphasis}>{F.baselineEmphasis}</b>
            {F.baselineRest}
          </p>
          <div className={styles.baselineDeltas}>
            {F.baselineDeltas.map((delta) => (
              <div className={styles.deltaCard} key={delta.label}>
                <dt>{delta.label}</dt>
                <dd>{delta.value}</dd>
              </div>
            ))}
          </div>
          <FidelityButton fullWidth caps>
            {F.baselineAction}
          </FidelityButton>
        </div>
        <div className={styles.baselineVisual}>
          <DecadalField />
          <div className={styles.zScoreCard}>
            <div className={styles.zScoreHead}>
              <p className={styles.zScoreLabel}>{F.zScoreLabel}</p>
              <DataClassBadge dataClass="analytics" />
            </div>
            <p className={styles.zScoreValue}>{F.zScoreValue}</p>
            <p className={shared.calloutBody}>{F.zScoreNote}</p>
          </div>
        </div>
      </section>

      {/* --- synthesis summary ----------------------------------------------------- */}
      <Panel label={F.summaryTitle}>
        <PanelBody>
          <div className={styles.summary}>
            <div className={styles.summaryText}>
              <h2 className={shared.panelTitle}>{F.summaryTitle}</h2>
              <p className={shared.prose}>{F.summaryBody}</p>
            </div>
            <div className={styles.summaryActions}>
              <FidelityButton icon="download" caps>
                {F.exportAction}
              </FidelityButton>
              <FidelityButton icon="database" variant="accent" caps>
                {F.recalibrateAction}
              </FidelityButton>
            </div>
          </div>
        </PanelBody>
      </Panel>

      <StatusStrip
        facts={[F.footerStream, F.footerHash, F.footerNormal]}
        right={F.footerProduct}
        chip={F.footerRelease}
      />
    </div>
  );
}
