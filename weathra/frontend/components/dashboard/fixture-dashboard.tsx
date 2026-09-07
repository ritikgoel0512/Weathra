"use client";

/**
 * `01-dashboard.png`, rendered as the real page.
 *
 * This is the Dashboard driven by `DASHBOARD_FIXTURE` instead of by the backend, so the running
 * screen and the approved mockup can be put side by side and compared. It is reached only when
 * `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`, which is a build-time constant — a production build
 * eliminates this file entirely.
 *
 * **It is components, not a picture.** Real React, real CSS grid, real headings, real buttons, real
 * charts drawn as SVG. Nothing here is a slice of the mockup or a background image: the point is to
 * exercise the same layout system production uses, so that what is compared is the implementation
 * rather than a copy of the artifact.
 *
 * **Every figure is sample content**, transcribed from the mockup, and `FixtureBanner` says so at
 * the top of the viewport for as long as this mode is on.
 *
 * Where the artifact's own labels are static interface copy — "Current Interpretation", "What
 * Changed?", "Forecast Explorer", "Precipitation Logic" — they are reproduced verbatim, because
 * that copy is part of what the design specifies.
 */

import type { ReactNode } from "react";

import { DataClassBadge, LocationImage, Meter } from "@/components/ui";
import { DecadalField, Glyph } from "@/components/fidelity/chrome";
import { DASHBOARD_FIXTURE as F } from "@/lib/fixtures/visily";

import styles from "./fixture.module.css";

/** The artifact's day glyphs. Simple weather marks, drawn rather than imported. */
function DayIcon({ kind, size = 26 }: { readonly kind: string; readonly size?: number }): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
  };
  if (kind === "sun" || kind === "clear") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
      </svg>
    );
  }
  if (kind === "rain" || kind === "heavy-rain") {
    return (
      <svg {...common}>
        <path d="M7 15.5a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 8.6a3.5 3.5 0 0 1-.5 6.9H7z" />
        <path d="M9 18.5l-.8 2M13 18.5l-.8 2M17 18.5l-.8 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 17a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 10.1a3.5 3.5 0 0 1-.5 6.9H7z" />
    </svg>
  );
}

/**
 * The artifact's intra-day chart: a temperature curve over precipitation bars.
 *
 * Drawn as inline SVG from the fixture series, on the same two-axis geometry the mockup shows. It
 * is a real chart of sample numbers, not an image of one.
 */
function PulseChart(): ReactNode {
  const temps = F.pulseTemperature;
  const bars = F.pulsePrecipitation;
  const width = 640;
  const height = 220;
  const pad = { top: 12, right: 34, bottom: 26, left: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxTemp = 20;
  const maxBar = 20;

  const x = (index: number, count: number) =>
    pad.left + (count === 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const yTemp = (value: number) => pad.top + plotH - (value / maxTemp) * plotH;

  const curve = temps.map((value, index) => `${x(index, temps.length)},${yTemp(value)}`).join(" ");
  /* The artifact fills beneath the curve; a bare line read as an unfinished chart beside it. */
  const area = `${pad.left},${pad.top + plotH} ${curve} ${pad.left + plotW},${pad.top + plotH}`;

  return (
    <svg
      className={styles.pulseSvg}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Sample intra-day temperature and precipitation, from the design mockup."
    >
      {[0, 5, 10, 15, 20].map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yTemp(tick)}
            y2={yTemp(tick)}
            className={styles.pulseGrid}
          />
          <text x={pad.left - 6} y={yTemp(tick) + 3} className={styles.pulseTick} textAnchor="end">
            {tick}
          </text>
        </g>
      ))}

      <polygon className={styles.pulseArea} points={area} />

      {bars.map((value, index) => {
        const barX = x(index, bars.length);
        const barH = (value / maxBar) * plotH;
        return (
          <rect
            key={index}
            x={barX - 9}
            y={pad.top + plotH - barH}
            width={18}
            height={barH}
            className={styles.pulseBar}
          />
        );
      })}

      <polyline points={curve} className={styles.pulseCurve} />

      {/*
        The precipitation axis, on the right, as the artifact labels it. The bars were already drawn
        against `maxBar`; without these ticks the scale they use was invisible and the chart read as
        having one axis where the artifact plainly has two.
      */}
      {[0, 5, 10, 15, 20].map((tick) => (
        <text
          key={`p${tick}`}
          x={width - pad.right + 8}
          y={yTemp(tick) + 3}
          className={styles.pulseTick}
          textAnchor="start"
        >
          {tick * 3}
        </text>
      ))}

      {F.pulseHours.map((hour, index) => (
        <text
          key={hour}
          x={x(index, F.pulseHours.length)}
          y={height - 8}
          className={styles.pulseTick}
          textAnchor="middle"
        >
          {hour}
        </text>
      ))}
    </svg>
  );
}

/**
 * The artifact's precipitation illustration.
 *
 * `01-dashboard.png` draws a dimensional cloud with rainfall beneath it and a circular cyan mark at
 * its shoulder. The line glyph that stood here read as a placeholder beside it — same subject, a
 * fraction of the visual weight, in a panel that was correspondingly shallow.
 *
 * Built from filled, overlapping ellipses with a light-to-shadow gradient rather than from a stroke,
 * which is what gives it mass; the rain is tapered strokes at three lengths so it reads as falling
 * rather than as a row of ticks. Decorative, and `aria-hidden` — the figures on this panel are text.
 */
function RainCloud(): ReactNode {
  const drops = [
    { x: 34, y: 74, len: 15 },
    { x: 48, y: 80, len: 21 },
    { x: 62, y: 76, len: 17 },
    { x: 76, y: 82, len: 22 },
    { x: 90, y: 75, len: 14 },
  ];

  return (
    <svg
      className={styles.rainCloud}
      viewBox="0 0 132 120"
      role="img"
      aria-label="Sample precipitation, from the design mockup."
    >
      <defs>
        <linearGradient id="weathra-cloud-body" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#eef3f9" />
          <stop offset="52%" stopColor="#c3ccd8" />
          <stop offset="100%" stopColor="#8e9aa9" />
        </linearGradient>
        <linearGradient id="weathra-cloud-drop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.95" />
        </linearGradient>
      </defs>

      {/* the mass: four overlapping lobes plus a flat base, so the silhouette is a cloud not a blob */}
      <g fill="url(#weathra-cloud-body)">
        <ellipse cx="52" cy="44" rx="25" ry="20" />
        <ellipse cx="78" cy="48" rx="21" ry="17" />
        <ellipse cx="36" cy="52" rx="18" ry="14" />
        <ellipse cx="64" cy="34" rx="17" ry="14" />
        <rect x="18" y="50" width="78" height="17" rx="8.5" />
      </g>

      {/* the shadowed underside, which is what stops it reading as flat */}
      <ellipse cx="57" cy="63" rx="39" ry="7" fill="#6b7787" opacity="0.5" />

      {drops.map((drop) => (
        <line
          key={drop.x}
          x1={drop.x}
          y1={drop.y}
          x2={drop.x - 3}
          y2={drop.y + drop.len}
          stroke="url(#weathra-cloud-drop)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      ))}

      {/* the circular cyan mark the artifact puts at the cloud's shoulder */}
      <circle cx="108" cy="30" r="14" fill="#22d3ee" />
      <path
        d="M110 22l-7 10h5l-2 8 7-10h-5l2-8z"
        fill="#04121a"
        stroke="#04121a"
        strokeWidth="0.6"
      />
    </svg>
  );
}

export function FixtureDashboard(): ReactNode {
  return (
    <div className={styles.page}>
      {/* --- hero ------------------------------------------------------------------ */}
      <LocationImage displayName={F.place} latitude={52.52} longitude={13.405} variant="hero" scrim="soft">
        <div className={styles.hero}>
          <div className={styles.heroLeft}>
            <div className={styles.heroChips}>
              <DataClassBadge dataClass="observed" />
              <span className={styles.stationId}>STATION ID: {F.station}</span>
            </div>
            <div className={styles.heroPlaceRow}>
              <h2 className={styles.heroPlace}>{F.place}</h2>
              <span className={styles.gmt}>{F.timezone}</span>
            </div>
            <p className={styles.heroMeta}>
              <span>
                <Glyph name="clock" size={14} />
                {F.updated}
              </span>
              <span className={styles.heroAgent}>
                <Glyph name="spark" size={14} />
                {F.agentStatus}
              </span>
            </p>
          </div>

          <div className={styles.heroTemp}>
            <p className={styles.heroTempValue}>
              {F.temperature}
              <span className={styles.heroDegree}>°</span>
            </p>
            <p className={styles.heroCondition}>{F.condition}</p>
          </div>

          <dl className={styles.heroStats}>
            <div>
              <dt>Humidity</dt>
              <dd>{F.humidity}</dd>
            </div>
            <div>
              <dt>Wind ({F.windDirection})</dt>
              <dd>{F.wind}</dd>
            </div>
            <div>
              <dt>UV Index</dt>
              <dd>{F.uvIndex}</dd>
            </div>
            <div>
              <dt>Pressure</dt>
              <dd>{F.pressure}</dd>
            </div>
          </dl>
        </div>
      </LocationImage>

      {/* --- intelligence row ------------------------------------------------------ */}
      <div className={styles.intelRow}>
        <section className={styles.intelCard} aria-label="Weathra Intelligence">
          <header className={styles.intelHead}>
            <span className={styles.intelMark} aria-hidden="true" />
            <div>
              <h2 className={styles.intelTitle}>Weathra Intelligence</h2>
              <p className={styles.intelAgent}>{F.agentLine}</p>
            </div>
            <div className={styles.intelHeadAside}>
              <DataClassBadge dataClass="interpretation" />
              <p className={styles.grounding}>{F.grounding}</p>
            </div>
          </header>

          <div className={styles.intelBody}>
            <div className={styles.intelText}>
              <h3 className={styles.microTitle}>Current Interpretation</h3>
              <p className={styles.intelProse}>{F.currentInterpretation}</p>

              <div className={styles.subPanel}>
                <h4 className={styles.microTitle}>What Changed?</h4>
                <p>{F.whatChanged}</p>
              </div>
              <div className={styles.subPanel}>
                <h4 className={styles.microTitle}>Why?</h4>
                <p>{F.why}</p>
              </div>
            </div>

            <div className={styles.intelMatrix}>
              <h3 className={styles.microTitle}>Confidence Matrix</h3>
              <Meter label="Model convergence" value={F.modelConvergence} />
              <Meter label="Data reliability (provider)" value={F.dataReliability} />
              <p className={styles.footnote}>{F.confidenceFootnote}</p>
              <div className={styles.intelActions}>
                <button type="button" className={styles.ghostButton}>
                  Compare Models
                </button>
                <button type="button" className={styles.accentButton}>
                  View Agent Evidence
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.intelSide}>
          <section className={styles.panel} aria-label="Anomaly Detection">
            <header className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Anomaly Detection</h2>
              <DataClassBadge dataClass="analytics" />
            </header>
            <div className={styles.alert}>
              <span className={styles.alertIcon} aria-hidden="true">
                <Glyph name="alert" size={20} />
              </span>
              <div>
                <p className={styles.alertTitle}>{F.anomalyTitle}</p>
                <p className={styles.alertBody}>{F.anomalyDetail}</p>
              </div>
            </div>
            <dl className={styles.statRows}>
              <div>
                <dt>Historical Avg (Oct)</dt>
                <dd>{F.historicalAverage}</dd>
              </div>
              <div>
                <dt>Variance</dt>
                <dd className={styles.positive}>{F.variance}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.panel} aria-label="Saved Snapshots">
            <header className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Saved Snapshots</h2>
              <button type="button" className={styles.linkButton}>
                View All
              </button>
            </header>
            <ul className={styles.snapshotList}>
              {F.snapshots.map((snapshot) => (
                <li key={snapshot.place} className={styles.snapshotRow}>
                  <span className={styles.snapshotPin} aria-hidden="true">
                    <Glyph name="pin" size={14} />
                  </span>
                  <span className={styles.snapshotPlace}>{snapshot.place}</span>
                  <span className={styles.snapshotTemp}>{snapshot.temperature}</span>
                  <span
                    className={styles.snapshotTrend}
                    data-direction={snapshot.direction}
                    aria-hidden="true"
                  >
                    {snapshot.direction === "up" ? "↗" : "↘"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {/* --- forecast explorer ----------------------------------------------------- */}
      <section aria-label="Forecast Explorer">
        <header className={styles.bandHead}>
          <div className={styles.bandLabel}>
            <DataClassBadge dataClass="forecast" />
            <span className={styles.bandMeta}>{F.forecastLabel}</span>
          </div>
          <div className={styles.bandTitleRow}>
            <h2 className={styles.bandTitle}>Forecast Explorer</h2>
            <button type="button" className={styles.ghostButton}>
              Export Data (CSV)
            </button>
          </div>
        </header>

        <ol className={styles.days}>
          {F.days.map((day) => (
            <li className={styles.day} key={day.day}>
              <p className={styles.dayName}>{day.day}</p>
              <span className={styles.dayIcon}>
                <DayIcon kind={day.icon} />
              </span>
              <p className={styles.dayTemp}>{day.temperature}</p>
              <p className={styles.dayCondition}>{day.condition}</p>
              <div className={styles.dayRange}>
                <span>
                  <em>L</em>
                  {day.low}
                </span>
                <span>
                  <em>H</em>
                  {day.high}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* --- pulse + precipitation ------------------------------------------------- */}
      <div className={styles.pulseRow}>
        <section className={styles.panel} aria-label="Climate Pulse Analytics">
          <header className={styles.panelHead}>
            <div className={styles.bandLabel}>
              <DataClassBadge dataClass="analytics" />
              <span className={styles.bandMeta}>{F.pulseLabel}</span>
            </div>
            <div className={styles.legend}>
              <span className={styles.legendTemp}>Temp</span>
              <span className={styles.legendPrecip}>Precip %</span>
            </div>
          </header>
          <h2 className={styles.chartTitle}>{F.pulseTitle}</h2>
          <PulseChart />
          <footer className={styles.pulseFooter}>
            <div>
              <dt>Peak Heat</dt>
              <dd>{F.peakHeat}</dd>
            </div>
            <div>
              <dt>Max Risk</dt>
              <dd className={styles.positive}>{F.maxRisk}</dd>
            </div>
            <button type="button" className={styles.linkButton}>
              View Comparative Stations ›
            </button>
          </footer>
        </section>

        <section className={styles.panel} aria-label="Precipitation Logic">
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Precipitation Logic</h2>
            <DataClassBadge dataClass="analytics" />
          </header>
          <div className={styles.precipVisual}>
            <RainCloud />
          </div>
          <p className={styles.precipRisk}>{F.precipitationRisk}</p>
          <p className={styles.precipDetail}>{F.precipitationDetail}</p>
          <dl className={styles.precipStats}>
            <div>
              <dt>Type</dt>
              <dd>{F.precipitationType}</dd>
            </div>
            <div>
              <dt>Load</dt>
              <dd>{F.precipitationLoad}</dd>
            </div>
          </dl>
        </section>
      </div>

      {/* --- climate baseline ------------------------------------------------------ */}
      <section className={styles.baselineRow} aria-label="Climate Baseline Comparison">
        <div className={styles.baselineText}>
          <DataClassBadge dataClass="historical" />
          <h2 className={styles.baselineTitle}>{F.baselineTitle}</h2>
          <p className={styles.intelProse}>{F.baselineBody}</p>
          <div className={styles.deltaRow}>
            <span className={styles.deltaIcon} aria-hidden="true">
              <Glyph name="chart" size={18} />
            </span>
            <div className={styles.deltaBox}>
              <dt>Historical Delta</dt>
              <dd>{F.historicalDelta}</dd>
            </div>
          </div>
          <button type="button" className={styles.ghostButton}>
            Open Historical Explorer
          </button>
        </div>
        <div className={styles.baselineVisual}>
          <DecadalField />
          {/* The artifact's two readings, sitting on the field at its lower left. */}
          <dl className={styles.baselinePills}>
            <div>
              <dt>Decade Avg</dt>
              <dd>15.4°C</dd>
            </div>
            <div>
              <dt>Current</dt>
              <dd className={styles.positive}>18.0°C</dd>
            </div>
          </dl>
          <div className={styles.extremeCard}>
            <div className={styles.extremeHead}>
              <p className={styles.extremeLabel}>{F.extremeYear}</p>
              <DataClassBadge dataClass="analytics" />
            </div>
            <p className={styles.extremeValue}>{F.extremeValue}</p>
            <p className={styles.extremeNote}>{F.extremeNote}</p>
          </div>
        </div>
      </section>

      {/* --- status strip ---------------------------------------------------------- */}
      <p className={styles.statusStrip}>
        <span className={styles.statusOk}>{F.footerFlow}</span>
        <span>{F.footerSample}</span>
        <span className={styles.statusRight}>{F.footerHash}</span>
        <span className={styles.statusChip}>{F.footerVersion}</span>
      </p>
    </div>
  );
}
