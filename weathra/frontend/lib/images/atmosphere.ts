/**
 * The credential-free fallback that still looks like a product: an atmospheric skyline drawn from
 * the place's own name.
 *
 * # Why this exists
 *
 * The image chain is provider photograph → committed photograph → drawn artwork, and the last tier
 * is the one that must never fail. It used to be eight hand-drawn SVGs plus `generic.svg` for
 * everything else, which is fine for a demo of eight cities and wrong for a product: a customer
 * who saves Lisbon, Osaka or Nairobi got the *same* picture as a customer who saved Reykjavík, and
 * a hero band repeating one stock drawing across every unlisted place reads as a missing asset.
 * Weathra resolves any location Open-Meteo can geocode, so the last tier has to cover any location
 * too.
 *
 * # What it draws
 *
 * A night skyline: a graded sky, a horizon glow, two depth-separated rows of buildings, a scatter
 * of windows, and a moon or stars. Every one of those is a function of the place's key — so
 * Lisbon and Osaka look different from each other, and Lisbon looks the same on every render, on
 * every machine, and in every capture. That last property is what makes this usable as fidelity
 * evidence at all; a random image would make each screenshot unreproducible.
 *
 * **It is decoration and it says so.** No shape here encodes a temperature, a condition or a
 * skyline anyone would recognise: the buildings are not Lisbon's buildings. The `alt` text calls it
 * generated artwork, which is the honest description, and `location-image.tsx` is what applies it.
 * A caption reading "Lisbon at dusk" over a generated drawing would be a small lie told to exactly
 * the people who cannot check it.
 *
 * # Why a data URI rather than a file
 *
 * There is nothing to cache and nothing to deploy: the markup is derived from the name in a few
 * microseconds, and a file per city is a build step that would have to enumerate cities — the
 * problem this replaces. It also renders on the very first paint, with no request, which is what
 * keeps the hero band from flashing an empty frame before a photograph arrives.
 *
 * # The palette
 *
 * Hues come from a fixed set in the Midnight Intelligence family rather than from the whole wheel.
 * A free-running hue would eventually hand some city a lime or magenta sky and break the set's
 * coherence — `design-system.md` is about the product reading as one thing, and a decorative
 * fallback is not exempt from that.
 */

/** A 32-bit hash of the key. Deterministic, and the only source of variation in the drawing. */
function hashOf(key: string): number {
  // FNV-1a. Chosen for being short and stable rather than for collision resistance: two cities
  // hashing alike get the same drawing, which is a cosmetic coincidence and not a defect.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast, fully deterministic generator. Same seed, same sequence, always. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The night-sky hues a generated place may get.
 *
 * Petrol through indigo to violet, in ten-degree steps. Eight rather than six because with six a
 * pair of cities on one screen shared a hue often enough to look like a mistake; the step is small
 * enough that all eight still sit in the same family as the product's own surfaces, so a wall of
 * saved-location cards reads as one set even though no two are the same picture.
 *
 * The range stops at 266. Past it the horizon glow turns magenta, which is outside the set — the
 * first version of this ran to 268 and gave São Paulo a hot pink skyline.
 */
const HUES = [196, 206, 216, 226, 236, 246, 256, 266] as const;

const WIDTH = 1200;
const HEIGHT = 600;

export interface Atmosphere {
  /** The finished SVG as a data URI, ready for an `img` `src`. */
  readonly url: string;
  /** The hue it was drawn in. Exposed for tests rather than for callers. */
  readonly hue: number;
}

/**
 * The atmospheric drawing for a place key.
 *
 * `key` is `locationKey(displayName)` — the name's first segment, lowercased and slugified — so a
 * place whose country name varies with the resolver's locale still draws the same picture.
 */
export function atmosphereFor(key: string): Atmosphere {
  const seed = hashOf(key || "generic");
  const next = randomFrom(seed);

  const hue = HUES[seed % HUES.length]!;
  const skyTop = `hsl(${hue} 42% 9%)`;
  const skyMid = `hsl(${hue} 38% 15%)`;
  // The warm shift toward the horizon is small on purpose: +14 and +26 took the top of the hue
  // range into magenta. Saturation drops with it, so a glow reads as light rather than as paint.
  const horizon = `hsl(${(hue + 8) % 360} 44% 25%)`;
  const glow = `hsl(${(hue + 16) % 360} 52% 44%)`;
  const far = `hsl(${hue} 32% 12%)`;
  const near = `hsl(${hue} 36% 8%)`;
  const lit = `hsl(${(hue + 20) % 360} 68% 70%)`;

  // The horizon sits low, so the hero's overlay text has sky behind it rather than rooftops.
  const skyline = Math.round(HEIGHT * 0.62);

  /** One row of buildings as a single path. One path per row keeps the markup small. */
  const row = (baseline: number, minHeight: number, maxHeight: number, step: number): string => {
    const parts: string[] = [`M0 ${HEIGHT}`, `L0 ${baseline}`];
    let x = 0;
    while (x < WIDTH) {
      const width = Math.round(step * (0.55 + next() * 0.9));
      const height = Math.round(minHeight + next() * (maxHeight - minHeight));
      const top = baseline - height;
      parts.push(`L${x} ${top}`);
      // A few buildings get a setback, which is what stops the row reading as a bar chart.
      if (next() > 0.72) {
        const inset = Math.round(width * 0.3);
        parts.push(`L${x + inset} ${top}`, `L${x + inset} ${top - Math.round(height * 0.18)}`);
        parts.push(`L${x + width - inset} ${top - Math.round(height * 0.18)}`);
        parts.push(`L${x + width - inset} ${top}`);
      }
      parts.push(`L${x + width} ${top}`, `L${x + width} ${baseline}`);
      x += width;
    }
    parts.push(`L${WIDTH} ${HEIGHT}`, "Z");
    return parts.join(" ");
  };

  const farRow = row(skyline + 26, 70, 210, 96);
  const nearRow = row(HEIGHT, 90, 260, 74);

  // Windows on the near row only: a lit window in the far row would contradict its own distance.
  const windows: string[] = [];
  const windowCount = 44 + Math.floor(next() * 26);
  for (let index = 0; index < windowCount; index += 1) {
    const x = Math.round(next() * WIDTH);
    const y = Math.round(skyline + 30 + next() * (HEIGHT - skyline - 60));
    windows.push(`<rect x="${x}" y="${y}" width="3" height="6" opacity="${(0.25 + next() * 0.5).toFixed(2)}"/>`);
  }

  // A moon, or a scatter of stars. One or the other, decided by the seed.
  const hasMoon = next() > 0.45;
  const sky: string[] = [];
  if (hasMoon) {
    const moonX = Math.round(140 + next() * (WIDTH - 280));
    const moonY = Math.round(90 + next() * 110);
    const moonR = Math.round(22 + next() * 16);
    sky.push(`<circle cx="${moonX}" cy="${moonY}" r="${moonR}" fill="${lit}" opacity="0.28"/>`);
    sky.push(`<circle cx="${moonX}" cy="${moonY}" r="${Math.round(moonR * 0.62)}" fill="${lit}" opacity="0.5"/>`);
  }
  const starCount = hasMoon ? 26 : 64;
  for (let index = 0; index < starCount; index += 1) {
    const x = Math.round(next() * WIDTH);
    const y = Math.round(next() * skyline * 0.8);
    sky.push(
      `<circle cx="${x}" cy="${y}" r="${(next() * 1.3 + 0.4).toFixed(1)}" fill="#fff" opacity="${(0.12 + next() * 0.4).toFixed(2)}"/>`,
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice">` +
    "<defs>" +
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${skyTop}"/>` +
    `<stop offset="0.55" stop-color="${skyMid}"/>` +
    `<stop offset="1" stop-color="${horizon}"/>` +
    "</linearGradient>" +
    `<radialGradient id="g" cx="50%" cy="${Math.round((skyline / HEIGHT) * 100)}%" r="62%">` +
    `<stop offset="0" stop-color="${glow}" stop-opacity="0.42"/>` +
    `<stop offset="1" stop-color="${glow}" stop-opacity="0"/>` +
    "</radialGradient>" +
    "</defs>" +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#s)"/>` +
    sky.join("") +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>` +
    `<path d="${farRow}" fill="${far}" opacity="0.85"/>` +
    `<path d="${nearRow}" fill="${near}"/>` +
    `<g fill="${lit}">${windows.join("")}</g>` +
    "</svg>";

  // `encodeURIComponent` rather than base64: it keeps the markup legible in devtools, and an SVG
  // data URI must have its `#` and `<` escaped either way.
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, hue };
}
