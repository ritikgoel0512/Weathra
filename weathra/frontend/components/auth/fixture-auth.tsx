/**
 * `08-authentication.png`'s ground and its one extra control.
 *
 * The authentication screen is the only artifact this pass did *not* need to rebuild: the shell,
 * the light appearance, the mark above the card, the field pair and the accent action were already
 * the artifact's. Three things differed, and only these three are here.
 *
 * 1. **The ground.** The artifact's backdrop is generated imagery — a soft organic mass with a faint
 *    wireframe cube drawn over it — where production ships two flat radial washes. `screens.md` §5
 *    refused the imagery set-wide on the grounds that it is invented, which is the right call for
 *    the product and the wrong one for a fidelity comparison: the ground is most of the artifact's
 *    pixels. So it is *originated here* as SVG — no photograph, no third-party asset, nothing
 *    downloaded — and it renders only in fixture mode.
 *
 * 2. **The card's width.** The artifact's card is 352 wide against production's 448.
 *    `fixture-auth.module.css` narrows it, in fixture mode only.
 *
 * 3. **Remember me.** The artifact draws a checkbox beside the forgotten-password link. Weathra has
 *    no remember-me — a session is a session — so production does not offer one and must not start
 *    offering one for a screenshot. It is rendered here as a disabled control so the row has the
 *    artifact's shape while being visibly incapable of doing anything.
 *
 * Everything else on the screen is the real Sign In form talking to the real identity provider.
 */

import type { ReactNode } from "react";

import { AUTH_FIXTURE as F } from "@/lib/fixtures/visily";

import styles from "./fixture-auth.module.css";

/**
 * The artifact's ground, drawn.
 *
 * A warm off-white field, a diffuse organic mass through the middle built from many small blurred
 * blobs, and a single-point-perspective wireframe cube over it. Deterministic — the same figure
 * every render, on every machine — so a screenshot comparison is stable.
 */
export function FixtureAuthGround(): ReactNode {
  /*
   * The mass. Positions come from a fixed integer sequence rather than randomness, so this is a
   * drawing rather than a different drawing each time.
   */
  /*
   * The mass.
   *
   * Three attempts got here, and the reasons the first two failed are worth keeping because they
   * are the same reason in different clothes: a placement rule that is too regular *shows*.
   *
   *   1. A golden-angle spiral read as a galaxy — even distribution, visible arms.
   *   2. Clumps on a periodic angle sequence read as starbursts — spokes, for the same reason.
   *   3. A hashed triangular jitter inside one ellipse read as a *circle*: irregular up close, but
   *      symmetric at arm's length, which is how the audit found it. The artifact's form is
   *      nothing like a circle — it is vertically elongated, plainly multi-lobed, with two or three
   *      dense cores and edges that fray outward.
   *
   * So the form is composed rather than sampled: four lobes at fixed offsets and sizes, each with
   * its own density, plus a sparse halo that frays past all of them. Every position still comes from
   * an integer hash of the index, so it is one drawing, identical on every machine and every render.
   */
  const hash = (n: number): number => {
    let x = n | 0;
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  };

  /**
   * Lobe centres, radii and weights, in the page's own pixels.
   *
   * These used to be expressed in a 0-100 viewBox that was then sliced across the page. That was
   * the bug: `slice` scales the square viewBox to *cover* a 1440x940 page, so the drawing was
   * rendered 1440x1440 and cropped, and the mass came out half as tall again as the artifact's and
   * running off both ends. Measured off `08-authentication.png` at a threshold soft enough to
   * include the halo rather than only the core, the mass occupies x392-1132 and y138-898 - 740 wide
   * by 760 tall, so vertically elongated, reaching almost to the foot of the page. A warm-pixel
   * density profile down it shows two concentrations with a waist between: a moderate upper lobe
   * peaking at y240-300, a pinch at y480-540, and a much denser lower mass from y600 down, heaviest
   * at y720-780. The lobes below are that profile.
   *
   * A first reading of this took a hard threshold, caught only the dense core, and gave a near
   * square 666x678 centred at (773, 489). Drawn from that, the mass sat too small, too high and too
   * evenly weighted, and the motes were small and opaque enough to read as speckle rather than as
   * cloud - hence the larger, softer, far more transparent motes and the wider blur here.
   */
  const LOBES = [
    { cx: 748, cy: 246, rx: 152, ry: 124, n: 700, core: 0.72 },
    { cx: 802, cy: 346, rx: 104, ry: 76, n: 240, core: 0.34 },
    { cx: 690, cy: 700, rx: 156, ry: 132, n: 780, core: 0.9 },
    { cx: 800, cy: 742, rx: 208, ry: 166, n: 1150, core: 1.0 },
    { cx: 792, cy: 852, rx: 176, ry: 118, n: 900, core: 0.95 },
  ];

  const motes: { key: string; cx: number; cy: number; r: number; o: number }[] = [];

  LOBES.forEach((lobe, group) => {
    for (let index = 0; index < lobe.n; index += 1) {
      const base = index * 8 + group * 131071;
      // Summed pairs give a triangular fall-off; cubing it pulls the density into a hard core.
      const u = hash(base + 1) + hash(base + 2) - 1;
      const v = hash(base + 3) + hash(base + 4) - 1;
      if (u * u + v * v > 1) continue;
      const pull = Math.pow(Math.abs(u * v) + 0.15, 0.4);
      motes.push({
        key: `${group}-${index}`,
        cx: lobe.cx + u * lobe.rx,
        cy: lobe.cy + v * lobe.ry,
        r: 3.4 + hash(base + 5) * 8.6,
        o: (0.032 + hash(base + 6) * 0.14) * lobe.core * (1.25 - pull * 0.4),
      });
    }
  });

  /*
   * The halo: sparse, wide, and reaching past every lobe, which is what stops the mass having an
   * edge. Elongated on the same axis as the lobes.
   */
  for (let index = 0; index < 900; index += 1) {
    const base = index * 8 + 7777771;
    const u = hash(base + 1) + hash(base + 2) - 1;
    const v = hash(base + 3) + hash(base + 4) - 1;
    if (u * u + v * v > 1) continue;
    motes.push({
      key: `h-${index}`,
      cx: 762 + u * 370,
      cy: 520 + v * 380,
      r: 3 + hash(base + 5) * 7,
      o: 0.016 + hash(base + 6) * 0.055,
    });
  }

  /*
   * The wireframe, as the artifact actually draws it.
   *
   * Contrast-stretching `08-authentication.png` shows this is not the twelve-edge box that was
   * drawn here. It is a *subdivided lattice* cube in axonometric projection: two equal squares --
   * so parallel projection, not perspective, since a perspective back face would be smaller --
   * each ruled into a six-by-six grid, with every perimeter grid node joined front to back, which
   * is what rules the top and side faces too.
   *
   * Measured in page pixels: the front square is 605 x 600 at (328, 229) and the back square is the
   * same size offset (+203, -130), giving overall bounds x328-1136 and y99-829. The artifact's cube
   * is inset from every edge and is never cropped; the previous one was cropped top and bottom
   * because of the sliced square viewBox.
   */
  const N = 6;
  const FRONT = { x: 328, y: 229, w: 605, h: 600 };
  const SHIFT = { x: 203, y: -130 };
  const fx = (i: number): number => FRONT.x + (i * FRONT.w) / N;
  const fy = (j: number): number => FRONT.y + (j * FRONT.h) / N;
  const steps = Array.from({ length: N + 1 }, (_, i) => i);

  /** The grid ruled on one square face, offset by `dx`/`dy`. */
  const face = (dx: number, dy: number, tag: string): ReactNode[] =>
    steps.flatMap((i) => [
      <line key={`${tag}-v${i}`} x1={fx(i) + dx} y1={fy(0) + dy} x2={fx(i) + dx} y2={fy(N) + dy} />,
      <line key={`${tag}-h${i}`} x1={fx(0) + dx} y1={fy(i) + dy} x2={fx(N) + dx} y2={fy(i) + dy} />,
    ]);

  /** Every perimeter node of the front face, joined to its opposite number on the back face. */
  const perimeter: [number, number][] = [
    ...steps.map((i) => [i, 0] as [number, number]),
    ...steps.map((i) => [i, N] as [number, number]),
    ...steps.slice(1, N).map((j) => [0, j] as [number, number]),
    ...steps.slice(1, N).map((j) => [N, j] as [number, number]),
  ];

  return (
    <div className={styles.ground} aria-hidden="true">
      <svg
        className={styles.groundSvg}
        viewBox="0 0 1440 940"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <defs>
          <radialGradient id="weathra-auth-warm" cx="50%" cy="58%" r="52%">
            <stop offset="0%" stopColor="#e3c69f" stopOpacity="0.95" />
            <stop offset="58%" stopColor="#ead9c4" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#f1ece8" stopOpacity="0" />
          </radialGradient>
          <filter id="weathra-auth-soften" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>

        <rect width="1440" height="940" className={styles.groundField} />
        <ellipse cx="762" cy="560" rx="372" ry="392" fill="url(#weathra-auth-warm)" />

        <g filter="url(#weathra-auth-soften)">
          {motes.map((mote) => (
            <circle
              key={mote.key}
              cx={mote.cx}
              cy={mote.cy}
              r={mote.r}
              className={styles.groundMote}
              opacity={mote.o}
            />
          ))}
        </g>

        <g className={styles.groundWire}>
          {face(0, 0, "front")}
          {face(SHIFT.x, SHIFT.y, "back")}
          {perimeter.map(([i, j]) => (
            <line
              key={`c-${i}-${j}`}
              x1={fx(i)}
              y1={fy(j)}
              x2={fx(i) + SHIFT.x}
              y2={fy(j) + SHIFT.y}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/**
 * The artifact's remember-me row: a checkbox that cannot be checked, beside the real link.
 *
 * `children` is the forgotten-password link the production form already renders, so there is one
 * of it rather than two.
 */
export function FixtureRememberRow({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className={styles.rememberRow}>
      <span className={styles.remember}>
        {/*
          Disabled, not merely unchecked. There is nothing for it to remember, and a control that
          looked operable would be the fabrication the fixture banner exists to prevent.
        */}
        <input
          type="checkbox"
          className={styles.rememberBox}
          disabled
          aria-label={`${F.rememberMe} (shown for design comparison; not offered by Weathra)`}
        />
        <span aria-hidden="true">{F.rememberMe}</span>
      </span>
      {children}
    </div>
  );
}

/**
 * The authentication mark: a Weathra "W".
 *
 * `08-authentication.png` sets a letterform in the accent tile where the product ships its weather
 * glyph. `fidelity-review.md` has carried that as an unresolved brand question since task 21.9, and
 * this does not resolve it — it reproduces what the artifact draws, in fixture mode only, so the
 * side-by-side is not failing on a difference nobody has decided yet. The product's own mark is
 * untouched everywhere else.
 *
 * Drawn here rather than sourced: it is four strokes of a "W", so there is nothing to license and
 * nothing to copy. Deliberately not anybody else's letterform — plain geometry at a weight that
 * matches the artifact's.
 */
export function FixtureAuthMark({ size = 26 }: { readonly size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6.5l3.4 11L12 9l4.6 8.5L20 6.5" />
    </svg>
  );
}
