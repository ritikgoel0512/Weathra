/**
 * The Visily chrome, as components.
 *
 * The seven product artifacts repeat a handful of shapes — a page heading, a panel with a heading
 * strip, the tinted intelligence header, a labelled meter, a status strip, a small set of glyphs.
 * They are defined once here so the fidelity screens compose them rather than re-deriving them, and
 * so a correction pass fixes a shape in one place instead of seven.
 *
 * Presentational only, and reached only from `components/*\/fixture-*.tsx`, which render only when
 * `NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES=true`. Nothing in the production path imports this file.
 *
 * **The controls are inert.** Every button and field the artifacts draw is reproduced for its
 * geometry; none of them does anything, because there is nothing truthful for them to do against
 * fixture content. They are rendered as `type="button"` and disabled fields rather than as links or
 * live inputs, so a reviewer cannot be led somewhere by a control that only exists for the picture.
 */

import type { ReactNode } from "react";

import styles from "./fidelity.module.css";

/* ---------------------------------------------------------------- glyphs
 *
 * Drawn rather than imported: the artifacts use a line-icon set at a consistent 1.6 stroke, and a
 * handful of marks is smaller than a dependency.
 */

export type GlyphName =
  | "thermometer"
  | "scale"
  | "rain"
  | "drop"
  | "wind"
  | "layers"
  | "globe"
  | "spark"
  | "person"
  | "shield"
  | "gear"
  | "clock"
  | "database"
  | "search"
  | "download"
  | "calendar"
  | "pin"
  | "check"
  | "alert"
  | "info"
  | "chart"
  | "sun"
  | "cloud"
  | "bolt"
  | "swap"
  | "plus"
  | "link"
  | "file"
  | "chevron"
  | "eye";

const PATHS: Readonly<Record<GlyphName, string>> = {
  thermometer: "M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z",
  scale: "M12 3v18M5 7h14M7 7l-3 6h6zM17 7l-3 6h6z",
  rain: "M7 14.5a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 7.6a3.5 3.5 0 0 1-.5 6.9H7zM9 17.5l-.8 2M13 17.5l-.8 2M17 17.5l-.8 2",
  drop: "M12 3.5s5.5 6 5.5 9.5a5.5 5.5 0 1 1-11 0C6.5 9.5 12 3.5 12 3.5z",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h9",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  gear: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM12 2.6v2.6M12 18.8v2.6M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M2.6 12h2.6M18.8 12h2.6M4.9 19.1l1.9-1.9M17.2 6.8l1.9-1.9",
  shield: "M12 3l7.5 3v5.4c0 4.4-3 8.2-7.5 9.6-4.5-1.4-7.5-5.2-7.5-9.6V6L12 3z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 1.8",
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  download: "M12 3.5v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15",
  calendar: "M4.5 6.5h15v14h-15zM4.5 10.5h15M8.5 3.5v4M15.5 3.5v4",
  pin: "M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  check: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.2l2.7 2.7L16 9.6",
  alert: "M12 3.5l9.5 17h-19L12 3.5zM12 9.5v5M12 17.2v.1",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.5M12 7.8v.1",
  chart: "M4 20V9M10 20V4M16 20v-7M22 20H2",
  sun: "M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
  cloud: "M7 17a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 10.1a3.5 3.5 0 0 1-.5 6.9H7z",
  bolt: "M13.5 3L6 13.5h5L10.5 21 18 10.5h-5L13.5 3z",
  swap: "M4 8h13l-3.5-3.5M20 16H7l3.5 3.5",
  plus: "M12 5v14M5 12h14",
  link: "M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1.2 1.2M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1.2-1.2",
  file: "M6 3.5h7l5 5v12H6zM13 3.5v5h5",
  chevron: "M9 6l6 6-6 6",
  eye: "M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z",
};

export interface GlyphProps {
  readonly name: GlyphName;
  readonly size?: number;
}

/** One line glyph, decorative. Every use in the fidelity screens sits beside its own text. */
export function Glyph({ name, size = 16 }: GlyphProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ---------------------------------------------------------------- page heading */

export interface PageHeadProps {
  /** The badge-and-meta line above the title, when the artifact draws one. */
  readonly label?: ReactNode;
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}

export function PageHead({ label, title, subtitle, actions }: PageHeadProps): ReactNode {
  return (
    <div className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {label ? <div className={styles.sectionLabel}>{label}</div> : null}
        <h1 className={styles.displayTitle}>{title}</h1>
        {subtitle ? <p className={styles.pageSubtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- panels */

export interface PanelProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A bordered region. Named for the accessibility tree, since the artifacts' headings vary. */
export function Panel({ label, children, className }: PanelProps): ReactNode {
  return (
    <section
      className={className ? `${styles.panel} ${className}` : styles.panel}
      aria-label={label}
    >
      {children}
    </section>
  );
}

export interface PanelHeadProps {
  readonly children: ReactNode;
}

export function PanelHead({ children }: PanelHeadProps): ReactNode {
  return <header className={styles.panelHead}>{children}</header>;
}

export interface PanelBodyProps {
  readonly children: ReactNode;
  readonly tight?: boolean;
}

export function PanelBody({ children, tight = false }: PanelBodyProps): ReactNode {
  return (
    <div className={tight ? `${styles.panelBody} ${styles.panelBodyTight}` : styles.panelBody}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- intelligence header */

export interface IntelHeadProps {
  readonly title: string;
  readonly agent: string;
  readonly aside?: ReactNode;
}

/** The tinted strip with the agent orb, as four of the artifacts open their synthesis panels. */
export function IntelHead({ title, agent, aside }: IntelHeadProps): ReactNode {
  return (
    <header className={styles.intelHead}>
      <span className={styles.intelMark} aria-hidden="true" />
      <div className={styles.intelHeadText}>
        <h2 className={styles.intelTitle}>{title}</h2>
        <p className={styles.intelAgent}>{agent}</p>
      </div>
      {aside}
    </header>
  );
}

/* ---------------------------------------------------------------- meters */

export interface FidelityMeterProps {
  readonly label: string;
  readonly value: string;
  /** 0 to 1. The artifacts' bars are drawn to a proportion, not computed from the label. */
  readonly fraction: number;
  readonly tone?: "accent" | "good" | "critical";
}

export function FidelityMeter({
  label,
  value,
  fraction,
  tone = "accent",
}: FidelityMeterProps): ReactNode {
  const percent = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>{label}</span>
        <span className={styles.meterValue} data-tone={tone}>
          {value}
        </span>
      </div>
      <div
        className={styles.meterTrack}
        role="img"
        aria-label={`${label}: ${value}. Sample value from the design mockup.`}
      >
        <span className={styles.meterFill} data-tone={tone} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- status strip */

export interface StatusStripProps {
  /** The left-hand facts, in the artifact's order. The first is drawn with the live dot. */
  readonly facts: readonly string[];
  readonly right?: string;
  readonly chip?: string;
}

export function StatusStrip({ facts, right, chip }: StatusStripProps): ReactNode {
  const [first, ...rest] = facts;
  return (
    <p className={styles.statusStrip}>
      {first ? <span className={styles.statusOk}>{first}</span> : null}
      {rest.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
      {right ? <span className={styles.statusRight}>{right}</span> : null}
      {chip ? (
        <span className={right ? styles.statusChip : `${styles.statusRight} ${styles.statusChip}`}>
          {chip}
        </span>
      ) : null}
    </p>
  );
}

/* ---------------------------------------------------------------- buttons
 *
 * Inert by construction, and typed so a caller cannot accidentally make one live.
 */

export interface FidelityButtonProps {
  readonly children: ReactNode;
  readonly icon?: GlyphName;
  readonly variant?: "accent" | "ghost" | "danger";
  readonly fullWidth?: boolean;
  /**
   * Set the label in tracked-out capitals.
   *
   * The artifacts are not consistent about this — "View Agent Evidence" is sentence case and
   * "EXPORT DATA" is not — so it is per-call rather than global, and each use is set to whatever
   * its own artifact shows.
   */
  readonly caps?: boolean;
}

export function FidelityButton({
  children,
  icon,
  variant = "ghost",
  fullWidth = false,
  caps = false,
}: FidelityButtonProps): ReactNode {
  const base =
    variant === "accent"
      ? styles.accentButton
      : variant === "danger"
        ? styles.dangerButton
        : styles.ghostButton;
  const classes = [base, fullWidth ? styles.fullWidth : "", caps ? styles.buttonCaps : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes}>
      {icon ? <Glyph name={icon} /> : null}
      {children}
    </button>
  );
}

export function LinkAction({
  children,
  icon,
  caps = false,
}: {
  readonly children: ReactNode;
  readonly icon?: GlyphName;
  readonly caps?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={caps ? `${styles.linkButton} ${styles.buttonCaps}` : styles.linkButton}
    >
      {children}
      {icon ? <Glyph name={icon} /> : null}
    </button>
  );
}

/* ---------------------------------------------------------------- the decadal field */

/**
 * The dense long-run field the Dashboard's and Compare's baseline bands sit on.
 *
 * Both artifacts fill that region with a trading-terminal panel — a fine grid, a long run of
 * candles, three long-period curves. It was the largest remaining visual gap on both screens: three
 * faint polylines on an empty ground read as an unfinished chart rather than as the artifact's
 * field. Deterministic, drawn from a fixed sequence, and encoding nothing: it is decoration, and
 * its `aria-label` says so.
 */
export function DecadalField(): ReactNode {
  /*
   * The candles fill the band.
   *
   * The first version put them in a strip through the middle — bodies spanning 88 to 212 of a
   * 300-unit field, 41% of it — so the panel read as a chart still loading, with dead space above
   * and below where both artifacts have a dense field edge to edge. The wave amplitude and the body
   * span are both widened here, and each candle gains a wick, which is what makes a run of them
   * read as a market panel rather than as a bar chart.
   */
  const bars = Array.from({ length: 88 }, (_, index) => {
    const wave = Math.sin(index / 6.5) * 52 + Math.sin(index / 2.3) * 20;
    const mid = 150 + wave;
    const span = 20 + ((index * 17) % 60);
    return {
      index,
      mid,
      span,
      wick: span + 18 + ((index * 11) % 26),
      up: (index * 13) % 5 > 2,
    };
  });

  const curve = (phase: number, amplitude: number) =>
    Array.from({ length: 44 }, (_, i) => {
      const px = (i / 43) * 720;
      const py = 120 + Math.sin(i / 5 + phase) * amplitude + i * 0.7;
      return `${px},${py}`;
    }).join(" ");

  return (
    <svg
      className={styles.decadalSvg}
      viewBox="0 0 720 300"
      preserveAspectRatio="none"
      role="img"
      aria-label="Decorative long-run field from the design mockup. It encodes no measurement."
    >
      <rect width="720" height="300" className={styles.decadalGround} />
      {[60, 120, 180, 240].map((y) => (
        <line key={y} x1={0} x2={720} y1={y} y2={y} className={styles.decadalGrid} />
      ))}
      {[120, 240, 360, 480, 600].map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={300} className={styles.decadalGrid} />
      ))}
      {bars.map((bar) => (
        <g key={bar.index} className={bar.up ? styles.decadalUp : styles.decadalDown}>
          {/* the wick first, so the body sits over it */}
          <rect x={bar.index * 8 + 3.4} y={bar.mid - bar.wick / 2} width={1.2} height={bar.wick} />
          <rect x={bar.index * 8 + 2} y={bar.mid - bar.span / 2} width={4} height={bar.span} />
        </g>
      ))}
      <polyline className={styles.decadalCurveA} points={curve(0, 22)} />
      <polyline className={styles.decadalCurveB} points={curve(1.6, 16)} />
      <polyline className={styles.decadalCurveC} points={curve(3.1, 10)} />
    </svg>
  );
}
