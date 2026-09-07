/**
 * Generate the location artwork the Dashboard hero and the Compare banners sit on.
 *
 * `01-dashboard.png` opens on a photograph of a city at dusk, and `04-compare-cities.png` gives
 * each compared city a photographic strip. Those regions were the largest visual difference between
 * the running product and the artifacts, and the obvious fix — download photographs — is the one
 * thing this repository should not do: a third-party image carries a licence, and asserting one is
 * cleared for the owner's use is not a call an implementation pass gets to make.
 *
 * So the artwork is **originated here** instead. Every asset this writes is drawn from scratch by
 * this script: a sky gradient, an atmospheric glow, layered skyline silhouettes and a haze band.
 * There is no third-party material, no licence question, and nothing for anybody to place by hand.
 *
 * **It is decorative and says so.** The skylines are generic massing, not portraits of real
 * buildings; `LocationImage` labels them as generated artwork rather than describing a photographed
 * scene. Nothing in an asset encodes a temperature, a condition or any other measurement — the
 * figures on these screens come from the backend and are drawn as text over the top, never baked
 * into an image where nothing could check them.
 *
 * **The output is deterministic.** Every value derives from a hash of the city's own name, so the
 * same place gets the same skyline on every machine and every run, and regenerating produces no
 * diff. Adding a city is one line in `CITIES`.
 *
 *     node scripts/generate-location-art.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "locations");

/**
 * The places with their own artwork.
 *
 * `slug` must match `slugForLocation()` in `components/ui/location-image.tsx`. `generic` is the
 * fallback every unlisted place resolves to, so a city nobody has drawn still gets a skyline rather
 * than an empty frame.
 */
const CITIES = [
  { slug: "generic", name: "Weathra" },
  { slug: "berlin", name: "Berlin" },
  { slug: "munich", name: "Munich" },
  { slug: "hamburg", name: "Hamburg" },
  { slug: "tokyo", name: "Tokyo" },
  { slug: "london", name: "London" },
  { slug: "new-york", name: "New York" },
  { slug: "paris", name: "Paris" },
  { slug: "springfield", name: "Springfield" },
];

/** A small deterministic hash, so a name always produces the same skyline. */
function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** A seeded generator, so every draw below is reproducible from the name alone. */
function random(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const WIDTH = 1600;
const HEIGHT = 500;

/**
 * One layer of skyline: a run of rectangular masses along the base.
 *
 * Deliberately plain massing. A recognisable landmark would be a claim about a place, and these are
 * atmospheric grounds for a readout rather than depictions of anywhere in particular. What the
 * layers *do* carry is aerial perspective — a far layer is lighter and hazier than a near one,
 * which is what makes a drawn skyline read as depth rather than as a bar chart.
 */
function skyline(next, { baseline, minHeight, maxHeight, fill, windows, domes = 0 }) {
  const parts = [];
  let x = -40;
  while (x < WIDTH + 40) {
    const width = 40 + Math.floor(next() * 90);
    const height = minHeight + Math.floor(next() * (maxHeight - minHeight));
    const y = baseline - height;
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height + 80}" fill="${fill}"/>`);

    // A spire on a few of them, so the run has a silhouette rather than a flat top.
    if (next() > 0.84) {
      const mast = x + width / 2;
      parts.push(
        `<rect x="${(mast - 2).toFixed(1)}" y="${y - 52}" width="4" height="52" fill="${fill}"/>`,
      );
    }

    // A dome on a couple of masses per layer. The artifacts' skylines have curved roofs in them,
    // and a run of pure boxes is the thing that most gives a generated skyline away.
    if (domes > 0 && next() > 1 - domes) {
      const cx = (x + width / 2).toFixed(1);
      const r = Math.min(width / 2, 26).toFixed(1);
      parts.push(`<circle cx="${cx}" cy="${y}" r="${r}" fill="${fill}"/>`);
      parts.push(
        `<rect x="${(Number(cx) - 2).toFixed(1)}" y="${(y - Number(r) - 22).toFixed(1)}" width="4" height="24" fill="${fill}"/>`,
      );
    }

    if (windows) {
      for (let wy = y + 16; wy < baseline - 12; wy += 20) {
        for (let wx = x + 10; wx < x + width - 10; wx += 17) {
          if (next() > 0.58) {
            const glow = (0.14 + next() * 0.42).toFixed(2);
            parts.push(
              `<rect x="${wx}" y="${wy}" width="4" height="7" fill="#ffe4b8" opacity="${glow}"/>`,
            );
          }
        }
      }
    }
    x += width + 5 + Math.floor(next() * 16);
  }
  return parts.join("");
}

/**
 * The one tall tower each composition is built around.
 *
 * Every city artifact in the set has a single dominant vertical with a bulge partway up, and
 * without one the massing reads as a wall. It is generic geometry — a shaft, a sphere, a mast — and
 * names nothing: the same three primitives appear on towers in dozens of cities.
 */
function tower(x, { baseTop, fill, accent }) {
  const sphereY = baseTop - 210;
  return [
    `<rect x="${(x - 7).toFixed(1)}" y="${baseTop - 300}" width="14" height="330" fill="${fill}"/>`,
    `<circle cx="${x.toFixed(1)}" cy="${sphereY}" r="30" fill="${fill}"/>`,
    `<circle cx="${(x - 9).toFixed(1)}" cy="${sphereY - 8}" r="19" fill="${accent}" opacity="0.30"/>`,
    `<rect x="${(x - 2).toFixed(1)}" y="${baseTop - 384}" width="4" height="86" fill="${fill}"/>`,
    `<circle cx="${x.toFixed(1)}" cy="${baseTop - 390}" r="3.4" fill="#ff8f7a" opacity="0.85"/>`,
  ].join("");
}

/**
 * A soft cloud band.
 *
 * Built from overlapping ellipses rather than a filter, so the output stays a small static file that
 * renders identically everywhere — an SVG blur is the one thing in here that browsers disagree on.
 */
function clouds(next, { y, spread, fill, opacity, count }) {
  return Array.from({ length: count }, () => {
    const cx = (next() * WIDTH).toFixed(0);
    const cy = (y + (next() - 0.5) * spread).toFixed(0);
    const rx = (180 + next() * 320).toFixed(0);
    const ry = (9 + next() * 17).toFixed(0);
    const o = (opacity * (0.5 + next() * 0.5)).toFixed(3);
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="${o}"/>`;
  }).join("");
}

/**
 * One city's artwork.
 *
 * The palette is the correction this pass made: the first version sat in a narrow dark blue-teal
 * band, and the approved artifacts are a *dusk* — a mauve sky over a warm horizon, with the city as
 * a mid-tone mass rather than a black one. Comparing the two side by side, the rendered hero read
 * as a night shot of a different place. Hue still derives from the name, so cities stay distinct,
 * but the value range and the warm horizon are fixed for the whole set.
 */
function artFor(city) {
  const seed = hash(city.name);
  const next = random(seed);

  // Sky hue in the mauve/indigo band the artifacts use; the warm horizon is fixed.
  const hue = 236 + (seed % 34);
  const sunX = 68 + Math.floor(next() * 22);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="presentation">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 26% 26%)"/>
      <stop offset="40%" stop-color="hsl(${hue - 6} 24% 33%)"/>
      <stop offset="74%" stop-color="hsl(${hue - 34} 26% 44%)"/>
      <stop offset="100%" stop-color="hsl(28 34% 52%)"/>
    </linearGradient>
    <radialGradient id="sun" cx="${sunX}%" cy="88%" r="52%">
      <stop offset="0%" stop-color="hsl(32 88% 74%)" stop-opacity="0.85"/>
      <stop offset="42%" stop-color="hsl(24 74% 62%)" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="hsl(20 60% 50%)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(30 40% 62%)" stop-opacity="0"/>
      <stop offset="100%" stop-color="hsl(28 42% 60%)" stop-opacity="0.30"/>
    </linearGradient>
    <linearGradient id="sink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 30% 10%)" stop-opacity="0"/>
      <stop offset="100%" stop-color="hsl(${hue} 34% 7%)" stop-opacity="0.72"/>
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sun)"/>

  <!-- two cloud decks, the upper one cooler and the lower one lit from the horizon -->
  ${clouds(next, { y: 88, spread: 150, fill: `hsl(${hue - 12} 22% 64%)`, opacity: 0.26, count: 26 })}
  ${clouds(next, { y: 216, spread: 110, fill: "hsl(26 46% 78%)", opacity: 0.2, count: 20 })}

  ${Array.from({ length: 42 }, () => {
    const x = (next() * WIDTH).toFixed(0);
    const y = (next() * HEIGHT * 0.34).toFixed(0);
    const r = (next() * 1.0 + 0.3).toFixed(2);
    const o = (next() * 0.34 + 0.08).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#f4ecff" opacity="${o}"/>`;
  }).join("")}

  <!-- three skyline layers, far to near, lightening into the haze as they recede -->
  <g opacity="0.48">${skyline(next, { baseline: 368, minHeight: 46, maxHeight: 118, fill: `hsl(${hue - 18} 20% 44%)`, windows: false, domes: 0.1 })}</g>
  <g opacity="0.86">${skyline(next, { baseline: 408, minHeight: 78, maxHeight: 186, fill: `hsl(${hue - 22} 24% 22%)`, windows: true, domes: 0.14 })}</g>
  <g>${tower(WIDTH * (0.34 + (seed % 23) / 100), { baseTop: 430, fill: `hsl(${hue - 26} 24% 19%)`, accent: "hsl(30 80% 70%)" })}</g>
  <g>${skyline(next, { baseline: 470, minHeight: 62, maxHeight: 152, fill: `hsl(${hue - 30} 30% 10%)`, windows: true, domes: 0.12 })}</g>

  <rect y="260" width="${WIDTH}" height="150" fill="url(#haze)"/>
  <rect y="330" width="${WIDTH}" height="170" fill="url(#sink)"/>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const city of CITIES) {
  writeFileSync(join(OUT, `${city.slug}.svg`), artFor(city), "utf8");
  process.stdout.write(`wrote ${city.slug}.svg\n`);
}
