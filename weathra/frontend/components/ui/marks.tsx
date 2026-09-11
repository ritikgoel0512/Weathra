"use client";

/**
 * The drawings the product owns — task 34.30, moved into the primitive layer by task 34.31.
 *
 * Both are **decorative**, both are `aria-hidden`, and neither encodes a figure. Every number on
 * the cards they sit in is text the backend supplied, drawn beside them where the provenance
 * machinery can label it. That separation is the rule `components/ui/weather-icon.tsx` already
 * states for the condition glyphs, and these follow it.
 *
 * They are inline SVG built from the task 20.3 tokens rather than assets, for the reason the icon
 * set gives: they must take the theme's accent and surface colours in both appearances, and a
 * weather product should not fetch a picture to draw a cloud. Nothing here was traced from, copied
 * out of, or downloaded for the design artifact — `01-dashboard.png`'s own rain graphic is somebody
 * else's rendering and is not part of this project's asset set.
 *
 * **Why they are primitives now.** They were the Dashboard's until Compare Cities needed the same
 * two: `04-compare-cities.png` heads its Comparison Intelligence card with the same circular mark
 * and states an anomaly with the same status treatment, and two screens drawing the same mark from
 * two files is how a design system stops being one. The drawings themselves are unchanged — the
 * frozen Dashboard renders exactly what it rendered before this move.
 */

import { useId, type ReactNode } from "react";

import styles from "./primitives.module.css";

/**
 * The circular mark on the Weathra Intelligence header band.
 *
 * `01-dashboard.png` puts a small glowing sphere in a ring there. This is the same *shape language*
 * drawn from this project's own vocabulary: a ringed disc with a core and three satellites on arcs
 * around it — a reading assembled from several sources, which is what the card below it does.
 *
 * It carries no version string, no agent name and no claim about what produced anything. The card
 * states its model attribution in words, from the backend's own record, or states nothing.
 */
export function IntelligenceMark({ size = 34 }: { readonly size?: number }): ReactNode {
  const core = useId().replace(/:/g, "");
  const ring = useId().replace(/:/g, "");

  return (
    <svg
      className={styles.markSvg}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={core} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="var(--color-accent-strong)" stopOpacity="0.95" />
          <stop offset="55%" stopColor="var(--color-accent)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--color-accent-muted)" stopOpacity="0.15" />
        </radialGradient>
        <linearGradient id={ring} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-strong)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.25" />
        </linearGradient>
      </defs>

      {/* The ring, and the disc it holds. */}
      <circle cx="20" cy="20" r="18.2" stroke={`url(#${ring})`} strokeWidth="1.4" />
      <circle cx="20" cy="20" r="11.6" fill={`url(#${core})`} />

      {/* Two arcs across the disc: a reading drawn over a body of figures. */}
      <path
        d="M9.4 16.6c6.6 3.4 14.6 3.4 21.2 0"
        stroke="var(--color-surface-base)"
        strokeOpacity="0.55"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M11.2 25.2c5.6-2.8 12-2.8 17.6 0"
        stroke="var(--color-surface-base)"
        strokeOpacity="0.4"
        strokeWidth="1.2"
        strokeLinecap="round"
      />

      {/* Three satellites on the ring — the several sources one reading is assembled from. */}
      <circle cx="20" cy="1.8" r="2.1" fill="var(--color-accent-strong)" />
      <circle cx="35.8" cy="29" r="1.7" fill="var(--color-accent)" fillOpacity="0.75" />
      <circle cx="4.2" cy="29" r="1.7" fill="var(--color-accent)" fillOpacity="0.45" />
    </svg>
  );
}

/**
 * The Precipitation Outlook card's graphic: a cloud with rain falling from it.
 *
 * `01-dashboard.png` fills the top of that card with a large rendered cloud and a cyan disc on its
 * shoulder. The rendering is not ours to use, so this is an original drawing at the same visual
 * mass, built the way everything else on these screens is built — token colours, soft gradients, a
 * cast shadow and a highlight, so it reads as a dimensional object rather than as a line icon
 * scaled up. The line glyph it replaces was the honest fallback and looked like one.
 *
 * **`level` changes the drawing, never a number.** It is derived by the caller from the provider's
 * own highest hourly chance of rain, so a wet window is drawn wetter — more drops, a heavier cast —
 * and a quieter one is drawn lighter. The percentage itself is rendered as text underneath by the
 * card, from the same figure. Nothing here is a measurement and nothing here is legible as one.
 */
export function PrecipitationMark({
  level,
  size = 168,
}: {
  readonly level: "wet" | "possible";
  readonly size?: number;
}): ReactNode {
  const body = useId().replace(/:/g, "");
  const shade = useId().replace(/:/g, "");
  const drop = useId().replace(/:/g, "");
  const glow = useId().replace(/:/g, "");
  const cloud = useId().replace(/:/g, "");

  const wet = level === "wet";
  /* Eight drops on a wet window, five on a quieter one — the drawing's only variable. */
  const drops = wet
    ? [
        { x: 50, y: 103, s: 1 },
        { x: 68, y: 118, s: 0.82 },
        { x: 86, y: 101, s: 1.08 },
        { x: 104, y: 120, s: 0.9 },
        { x: 122, y: 103, s: 1 },
        { x: 58, y: 135, s: 0.72 },
        { x: 94, y: 139, s: 0.86 },
        { x: 128, y: 130, s: 0.7 },
      ]
    : [
        { x: 60, y: 104, s: 0.9 },
        { x: 84, y: 119, s: 0.78 },
        { x: 108, y: 103, s: 0.94 },
        { x: 74, y: 136, s: 0.66 },
        { x: 118, y: 131, s: 0.72 },
      ];

  return (
    <svg
      className={styles.markSvg}
      width={size}
      height={size * 0.86}
      viewBox="0 0 176 152"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The cloud's body: lit from the upper left, falling away to the underside. */}
        <linearGradient id={body} gradientUnits="userSpaceOnUse" x1="46" y1="26" x2="120" y2="96">
          <stop offset="0%" stopColor="var(--color-text-primary)" stopOpacity="0.95" />
          <stop offset="48%" stopColor="var(--color-text-secondary)" stopOpacity="0.78" />
          <stop offset="100%" stopColor="var(--color-border-strong)" stopOpacity="0.62" />
        </linearGradient>
        {/* The underside, which is what makes it read as a volume rather than as a silhouette. */}
        <linearGradient id={shade} gradientUnits="userSpaceOnUse" x1="88" y1="58" x2="88" y2="96">
          <stop offset="0%" stopColor="var(--color-surface-base)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--color-surface-base)" stopOpacity="0.42" />
        </linearGradient>
        <linearGradient id={drop} x1="0.3" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-strong)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.5" />
        </linearGradient>
        <radialGradient id={glow} cx="50%" cy="40%" r="58%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={wet ? 0.28 : 0.16} />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>

        {/* Three lobes over a rounded base. A clip path is the union of its children. */}
        <clipPath id={cloud}>
          <circle cx="52" cy="74" r="22" />
          <circle cx="84" cy="57" r="32" />
          <circle cx="118" cy="74" r="24" />
          <rect x="30" y="74" width="112" height="22" rx="11" />
        </clipPath>
      </defs>

      {/* The wash the whole graphic sits in, so it is an object on a surface and not a cut-out. */}
      <ellipse cx="88" cy="64" rx="80" ry="60" fill={`url(#${glow})`} />

      {/*
        **The cloud is a clip, not a stack of shapes.** Three lobes over a rounded base is the right
        silhouette, and drawing them as three filled circles paints the overlaps twice — every stop
        here carries an opacity, so the lenses where the lobes cross came out visibly lighter and
        the cloud read as three balls rather than as one volume. Clipping to their union and laying
        one rectangle of gradient through it paints every pixel exactly once.
      */}
      <g clipPath={`url(#${cloud})`}>
        <rect x="24" y="20" width="128" height="82" fill={`url(#${body})`} />
        <rect x="24" y="20" width="128" height="82" fill={`url(#${shade})`} />
        {/*
          The sheen on the crown. A lit *edge* was tried first and read as a dark outline, because
          the only stroke light enough to sit on a near-white crown is the crown's own colour — so
          it is a soft highlight inside the top lobe instead, which is where light would land
          anyway. Clipped with everything else, so it cannot spill past the silhouette.
        */}
        <ellipse
          cx="58"
          cy="63"
          rx="17"
          ry="8"
          fill="var(--color-text-primary)"
          fillOpacity="0.3"
          transform="rotate(-20 58 63)"
        />
      </g>

      {/* The rain. Teardrops rather than dashes, so the fall reads as water. */}
      {drops.map((mark) => (
        <path
          key={`${mark.x}-${mark.y}`}
          d="M0 0c0 0 5.6 6.7 5.6 10.6A5.6 5.6 0 0 1 0 16.2a5.6 5.6 0 0 1-5.6-5.6C-5.6 6.7 0 0 0 0Z"
          transform={`translate(${mark.x} ${mark.y}) scale(${mark.s})`}
          fill={`url(#${drop})`}
        />
      ))}

      {/*
        The disc on the cloud's shoulder. The artifact's carries a lightning bolt, which would be a
        claim about thunder the provider never made; this carries a drop, which is the measure the
        card is about, and it is still only a drawing.
      */}
      <circle cx="147" cy="38" r="17" fill="var(--color-accent)" />
      <path
        d="M0 0c0 0 6.4 7.6 6.4 12.1A6.4 6.4 0 0 1 0 18.5a6.4 6.4 0 0 1-6.4-6.4C-6.4 7.6 0 0 0 0Z"
        transform="translate(147 29) scale(0.78)"
        fill="var(--color-accent-contrast)"
      />
    </svg>
  );
}

/**
 * The mark beside the anomaly card's status line.
 *
 * Two shapes for the two answers the analysis can give about a window: a warning triangle where it
 * sits outside its usual spread, a settled check where it sits inside one. Shape, not only colour —
 * the tones either side of it are warning-orange and neutral, and a reader who cannot separate them
 * still has two different drawings.
 *
 * Decorative: the state is written in words on the same line, which is what a screen reader gets.
 */
export function StatusMark({ tone }: { readonly tone: "flag" | "calm" }): ReactNode {
  return (
    <span className={styles.anomalyMark} data-tone={tone} aria-hidden="true">
      <svg
        className={styles.markSvg}
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {tone === "flag" ? (
          <>
            <path d="M12 4.2 21 19.6H3L12 4.2Z" />
            <path d="M12 10.4v3.6" />
            <path d="M12 16.9h.01" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="8.4" />
            <path d="m8.4 12.2 2.6 2.6 4.6-5.2" />
          </>
        )}
      </svg>
    </span>
  );
}
