/**
 * WCAG relative luminance and contrast ratio, over the design system's own token values.
 *
 * `specs/web-ui` requires body text to meet 4.5:1 in both appearances, and `docs/design/` requires
 * that the check be made against the design system's tokens rather than per component. A ratio
 * asserted in a review comment rots the first time a token moves, so the arithmetic lives here and
 * a test walks every declared pair.
 *
 * The formulas are WCAG 2.1's: linearize each sRGB channel, weight them, and compare the lighter
 * and darker luminances. Nothing here knows about React.
 */

/** A colour as its three sRGB channels, each 0–255. */
export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const HEX_PATTERN = /^#([0-9a-f]{6})$/i;

/**
 * A `#rrggbb` string as channels.
 *
 * Deliberately strict: three-digit shorthand and an alpha channel are both refused, because a
 * token with alpha cannot be contrast-checked without knowing what is behind it, and silently
 * accepting one would produce a ratio that means nothing. Tokens that need a tint declare the
 * blended value instead.
 */
export function parseHex(value: string): Rgb {
  const match = HEX_PATTERN.exec(value.trim());
  if (!match?.[1]) {
    throw new Error(`not a six-digit hex colour: ${value}`);
  }
  const digits = Number.parseInt(match[1], 16);
  return {
    red: (digits >> 16) & 0xff,
    green: (digits >> 8) & 0xff,
    blue: digits & 0xff,
  };
}

function channelLuminance(channel: number): number {
  const proportion = channel / 255;
  return proportion <= 0.03928
    ? proportion / 12.92
    : Math.pow((proportion + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 for black and 1 for white. */
export function relativeLuminance(colour: string | Rgb): number {
  const { red, green, blue } = typeof colour === "string" ? parseHex(colour) : colour;
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  );
}

/**
 * The WCAG contrast ratio between two colours, from 1:1 to 21:1.
 *
 * Order does not matter — the lighter colour is found rather than assumed, so a foreground and a
 * background can be passed either way round.
 */
export function contrastRatio(one: string | Rgb, other: string | Rgb): number {
  const first = relativeLuminance(one);
  const second = relativeLuminance(other);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The colour's hue in degrees, 0–360.
 *
 * Here because the five data classes have to stay *distinguishable*, and a contrast ratio cannot
 * say whether they are: two colours of different hue and similar lightness sit at about 1:1, which
 * is why a ratio between two badge colours means nothing. Hue separation is the property that does
 * mean something, and `tokens.test.ts` asserts a floor on it.
 *
 * Grey has no hue; it returns 0.
 */
export function hueDegrees(colour: string | Rgb): number {
  const { red, green, blue } = typeof colour === "string" ? parseHex(colour) : colour;
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return 0;

  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;

  return ((hue * 60) % 360 + 360) % 360;
}

/** The shorter way round a colour wheel between two hues, 0–180 degrees. */
export function hueSeparation(one: string | Rgb, other: string | Rgb): number {
  const difference = Math.abs(hueDegrees(one) - hueDegrees(other));
  return Math.min(difference, 360 - difference);
}

/** The ratio rounded the way a report quotes it, so a near-miss reads as a near-miss. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
