/**
 * The Weathra design tokens — task 20.3, the code side of `docs/design/design-system.md`.
 *
 * The design record fixes the *direction*: the Midnight Intelligence dark palette with a single
 * cyan accent, Plus Jakarta Sans for display and heading type with Inter for body and UI, a 4-pixel
 * spacing scale, and five visually distinct data classes. It deliberately does not fix literal
 * colour values, and the approved Visily exports are rendered PNGs — a pixel sampled from one is a
 * compression artefact of a mockup, not an approved token. So the concrete values below are
 * *implementation decisions*, made from the recorded direction and recorded as such in
 * `docs/design/tokens.md`.
 *
 * **This module is the single source of truth.** `app/globals.css` declares the same values as CSS
 * custom properties because that is what a stylesheet can read, and a test asserts the two agree —
 * the same correspondence discipline the backend's documentation tests use. Components never hard
 * code a colour; they reference `var(--color-…)`.
 *
 * Nothing here is derived from the mockups' sample content: no provider, station, agent version, or
 * operational control from those images has any representation in the design system.
 */

/**
 * The two appearances, and the rule that decides between them.
 *
 * **Neither is chosen by the visitor's system.** A `prefers-color-scheme: light` override used to
 * serve the light palette for the whole product, which meant an operator whose system reported
 * light saw a Dashboard matching none of the seven product artifacts. That override is gone.
 *
 * What replaces it is the division the artifacts themselves draw. The seven product screens are
 * Midnight Intelligence, and that is `:root`. `08-authentication.png` — the approved shell for all
 * eight authentication screens — is rendered light, so the `(auth)` route group opts into it with
 * `data-appearance="light"` on its own element. The appearance is a property of *which screen you
 * are on*, which is what the artifacts specify, rather than of the machine it was opened on, which
 * none of them mention.
 */
export type Appearance = "dark" | "light";

export const APPEARANCES: readonly Appearance[] = ["dark", "light"];

/**
 * Every colour token, in the order `docs/design/design-system.md` §1 lists the roles it fixes,
 * followed by the implementation tokens that section's roles imply.
 */
export const COLOR_TOKEN_NAMES = [
  // Surfaces — §1
  "surface-base",
  "surface-raised",
  "surface-overlay",
  "surface-inset",
  // Edges — §1
  "border-subtle",
  "border-strong",
  // Text hierarchy — §1
  "text-primary",
  "text-secondary",
  "text-muted",
  // The single accent — §1
  "accent",
  "accent-strong",
  "accent-muted",
  "accent-contrast",
  // The five data classes — §1 and §9, each with the tinted surface its badge sits on
  "class-observed",
  "class-observed-surface",
  "class-forecast",
  "class-forecast-surface",
  "class-historical",
  "class-historical-surface",
  "class-analytics",
  "class-analytics-surface",
  "class-interpretation",
  "class-interpretation-surface",
  // Status — §1
  "status-error",
  "status-error-surface",
  "status-error-solid",
  "status-error-on-solid",
  "status-warning",
  "status-warning-surface",
  "status-ok",
  "status-ok-surface",
  "status-quota",
  "status-quota-surface",
] as const;

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

type Palette = Readonly<Record<ColorTokenName, string>>;

/**
 * Midnight Intelligence, dark-first.
 *
 * The ground is near-black with a blue cast rather than pure black: the approved artifacts show
 * panels lifting off the ground by a step of lightness, and pure black leaves nowhere below the
 * lowest surface to put an inset well.
 */
const DARK: Palette = {
  "surface-base": "#05080c",
  "surface-raised": "#0b121b",
  "surface-overlay": "#121b26",
  "surface-inset": "#070c12",

  "border-subtle": "#1b2634",
  "border-strong": "#4e6a86",

  "text-primary": "#e9eff6",
  "text-secondary": "#aebccb",
  "text-muted": "#93a3b3",

  "accent": "#22d3ee",
  "accent-strong": "#67e8f9",
  "accent-muted": "#0e7490",
  "accent-contrast": "#04121a",

  "class-observed": "#34d399",
  "class-observed-surface": "#0a2a22",
  "class-forecast": "#7cb2ff",
  "class-forecast-surface": "#0d1c33",
  "class-historical": "#fbbf24",
  "class-historical-surface": "#2b2008",
  "class-analytics": "#a78bfa",
  "class-analytics-surface": "#1c1633",
  "class-interpretation": "#e879f9",
  "class-interpretation-surface": "#2a1030",

  "status-error": "#f87171",
  "status-error-surface": "#2c1214",
  "status-error-solid": "#d40924",
  "status-error-on-solid": "#ffffff",
  "status-warning": "#fb923c",
  "status-warning-surface": "#2b1a0b",
  "status-ok": "#4ade80",
  "status-ok-surface": "#0c2a17",
  "status-quota": "#c4b5fd",
  "status-quota-surface": "#1d1a33",
};

/**
 * The light appearance: the authentication shell, and nothing else.
 *
 * Same roles, same hue families, inverted surface ramp. Each hue is darkened until it carries the
 * same 4.5:1 obligation against a light surface that its dark counterpart carries against a dark
 * one — which is why these are not the dark values with the ramp flipped.
 */
const LIGHT: Palette = {
  "surface-base": "#f4f7fa",
  "surface-raised": "#ffffff",
  "surface-overlay": "#ffffff",
  "surface-inset": "#eef2f7",

  "border-subtle": "#dbe2ea",
  "border-strong": "#7d8ea0",

  "text-primary": "#0b141d",
  "text-secondary": "#3c4c5c",
  "text-muted": "#546678",

  "accent": "#0b6a83",
  "accent-strong": "#08505f",
  "accent-muted": "#0891b2",
  "accent-contrast": "#ffffff",

  "class-observed": "#046c4e",
  "class-observed-surface": "#e6f6ef",
  "class-forecast": "#1d4ed8",
  "class-forecast-surface": "#e8eefc",
  "class-historical": "#8a4b04",
  "class-historical-surface": "#fdf2e0",
  "class-analytics": "#6d28d9",
  "class-analytics-surface": "#f0eafd",
  "class-interpretation": "#a21caf",
  "class-interpretation-surface": "#fbeaf9",

  "status-error": "#b42318",
  "status-error-surface": "#fdeceb",
  "status-error-solid": "#c00d24",
  "status-error-on-solid": "#ffffff",
  "status-warning": "#b54708",
  "status-warning-surface": "#fdf0e3",
  "status-ok": "#136f35",
  "status-ok-surface": "#e7f6ec",
  "status-quota": "#5b21b6",
  "status-quota-surface": "#efe9fb",
};

export const COLOR_TOKENS: Readonly<Record<Appearance, Palette>> = { dark: DARK, light: LIGHT };

/** The CSS custom-property name a token is declared under. */
export function cssVariableName(token: ColorTokenName): string {
  return `--color-${token}`;
}

/** A token as the `var()` reference a component writes. */
export function colorVar(token: ColorTokenName): string {
  return `var(${cssVariableName(token)})`;
}

/**
 * The contrast obligations, as data rather than as assertions in a test.
 *
 * WCAG sets 4.5:1 for body text and 3:1 for large text and for the boundary of a user-interface
 * component. Both minima appear below with the reason each pair exists, so a token change that
 * breaks a pair fails with the *purpose* named rather than with two hex strings.
 */
export interface ContrastRequirement {
  readonly foreground: ColorTokenName;
  readonly background: ColorTokenName;
  readonly minimum: number;
  readonly because: string;
}

const TEXT_SURFACES: readonly ColorTokenName[] = [
  "surface-base",
  "surface-raised",
  "surface-overlay",
  "surface-inset",
];

const DATA_CLASSES = [
  "observed",
  "forecast",
  "historical",
  "analytics",
  "interpretation",
] as const;

export type DataClassName = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_NAMES: readonly DataClassName[] = DATA_CLASSES;

const STATUSES = ["error", "warning", "ok", "quota"] as const;

export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  /*
   * The urgent destructive action.
   *
   * `status-error` is a *text* colour, light enough to read as words on a dark ground, and filling
   * a button with it gives the soft coral this had rather than the saturated red the approved
   * screens draw. `status-error-solid` is that fill, and it exists as its own role because the two
   * jobs have opposite contrast requirements: one has to be light against the page, the other dark
   * enough to carry a white label. This pair is what makes the second true.
   */
  {
    foreground: "status-error-on-solid",
    background: "status-error-solid",
    minimum: 4.5,
    because: "the urgent action's label is read on its fill",
  },
  ...TEXT_SURFACES.map((background) => ({
    foreground: "text-primary" as const,
    background,
    minimum: 4.5,
    because: "primary text carries values and prose on every surface",
  })),
  ...TEXT_SURFACES.map((background) => ({
    foreground: "text-secondary" as const,
    background,
    minimum: 4.5,
    because: "labels and secondary text are body text, not decoration",
  })),
  ...TEXT_SURFACES.map((background) => ({
    foreground: "text-muted" as const,
    background,
    minimum: 4.5,
    because: "attribution, timestamps and provenance are the last thing that may become unreadable",
  })),
  {
    foreground: "accent",
    background: "surface-base",
    minimum: 4.5,
    because: "the accent is used as link and active-navigation text",
  },
  {
    foreground: "accent",
    background: "surface-raised",
    minimum: 4.5,
    because: "the accent is used as text inside cards",
  },
  {
    foreground: "accent-contrast",
    background: "accent",
    minimum: 4.5,
    because: "the label of the primary action sits on the accent",
  },
  {
    foreground: "border-strong",
    background: "surface-base",
    minimum: 3,
    because: "the focus and selection boundary is a user-interface component",
  },
  ...DATA_CLASSES.map((name) => ({
    foreground: `class-${name}` as ColorTokenName,
    background: `class-${name}-surface` as ColorTokenName,
    minimum: 4.5,
    because: `the ${name.toUpperCase()} badge label sits on its own tinted surface`,
  })),
  ...DATA_CLASSES.map((name) => ({
    foreground: `class-${name}` as ColorTokenName,
    background: "surface-raised" as const,
    minimum: 3,
    because: `the ${name} class colour is also a chart series and a card accent`,
  })),
  ...STATUSES.map((name) => ({
    foreground: `status-${name}` as ColorTokenName,
    background: `status-${name}-surface` as ColorTokenName,
    minimum: 4.5,
    because: `the ${name} state's text sits on its own tinted surface`,
  })),
  ...STATUSES.map((name) => ({
    foreground: `status-${name}` as ColorTokenName,
    background: "surface-raised" as const,
    minimum: 4.5,
    because: `the ${name} state is also stated in text on a card`,
  })),
  // The provenance layer, task 20.15. The AI-interpretation panel is the one tinted surface that
  // carries real prose rather than a badge, so all three text roles sit on it.
  ...(["text-primary", "text-secondary", "text-muted"] as const).map((foreground) => ({
    foreground,
    background: "class-interpretation-surface" as const,
    minimum: 4.5,
    because: "the interpretation panel carries prose and its attribution on its own tinted ground",
  })),
  {
    foreground: "class-analytics",
    background: "surface-inset",
    minimum: 4.5,
    because: "the analytics colour opens the method note as text, not as a chart accent",
  },
  // Task 21.8's audit. Every pairing below is one the MVP screens actually render and the table
  // above did not name — so each was measured by hand once and is now measured on every run,
  // which is the difference between a ratio that held in September and one that keeps holding.
  ...(["text-primary", "text-secondary", "text-muted"] as const).flatMap((foreground) =>
    STATUSES.map((status) => ({
      foreground,
      background: `status-${status}-surface` as ColorTokenName,
      minimum: 4.5,
      // The candidate chooser sits on the caution ground and the destructive confirmations on the
      // error ground, and both carry prose, a heading and their provenance rather than a badge.
      because: `the ${status} panel carries body text on its own tinted ground`,
    })),
  ),
  ...STATUSES.map((status) => ({
    foreground: "accent" as const,
    background: `status-${status}-surface` as ColorTokenName,
    minimum: 4.5,
    because: `a ghost control's label is accent text inside the ${status} panel`,
  })),
  {
    foreground: "accent",
    background: "surface-inset",
    minimum: 4.5,
    because: "the accent badge and a ghost control's label sit on an inset panel",
  },
  {
    foreground: "accent",
    background: "surface-overlay",
    minimum: 4.5,
    because: "a ghost control takes the overlay ground on hover and keeps its accent label",
  },
];

/**
 * Typography. Two faces, seven roles, and no role borrowing another's face.
 *
 * The numeric role is not a size — it is `font-variant-numeric: tabular-nums` on the UI face, so a
 * column of figures in a comparison table or a period delta does not wobble as digits change.
 */
export const TYPE_FACES = {
  display: "var(--font-display), 'Plus Jakarta Sans', system-ui, sans-serif",
  body: "var(--font-body), Inter, system-ui, sans-serif",
} as const;

export interface TypeRole {
  readonly face: keyof typeof TYPE_FACES;
  readonly size: string;
  readonly lineHeight: string;
  readonly weight: number;
  readonly tracking?: string;
  readonly transform?: "uppercase";
}

export const TYPE_ROLES = {
  display: { face: "display", size: "2rem", lineHeight: "1.15", weight: 600 },
  heading: { face: "display", size: "1.5rem", lineHeight: "1.2", weight: 600 },
  section: { face: "display", size: "1.125rem", lineHeight: "1.3", weight: 600 },
  card: { face: "display", size: "0.9375rem", lineHeight: "1.35", weight: 600 },
  body: { face: "body", size: "0.9375rem", lineHeight: "1.55", weight: 400 },
  ui: { face: "body", size: "0.875rem", lineHeight: "1.4", weight: 500 },
  label: {
    face: "body",
    size: "0.6875rem",
    lineHeight: "1.2",
    weight: 600,
    tracking: "0.08em",
    transform: "uppercase",
  },
  meta: { face: "body", size: "0.75rem", lineHeight: "1.45", weight: 400 },
} as const satisfies Readonly<Record<string, TypeRole>>;

/** The 4-pixel scale of `docs/design/design-system.md` §3, in the order it records. */
export const SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48] as const;

/** Corner radii, from a badge to an overlay. */
export const RADII = {
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  pill: "999px",
} as const;

/**
 * Elevation. Two shadows and a focus ring, because a premium analytical surface reads as flat
 * panels separated by a step of lightness rather than as a stack of drop shadows.
 */
export const SHADOWS = {
  raised: "0 1px 2px rgb(0 0 0 / 0.28)",
  overlay: "0 16px 40px rgb(0 0 0 / 0.45)",
  focus: "0 0 0 2px var(--color-surface-base), 0 0 0 4px var(--color-accent)",
} as const;

/** The responsive foundations of `docs/design/design-system.md` §13. */
export const LAYOUT = {
  /** The narrowest viewport that must remain usable, with no horizontal page scroll. */
  minimumViewport: 360,
  /** Below this the navigation is a drawer and content is one column. */
  compact: 768,
  /** At and above this the navigation is full width and the card grid is multi-column. */
  wide: 1280,
  /** The persistent navigation's width when it is full, and when it is collapsed to icons. */
  navigationWidth: 248,
  navigationCollapsedWidth: 64,
  /** The widest a page's content grows before it stops, so a line of prose stays readable. */
  contentMaximum: 1440,
} as const;

/** Motion. Short, and absent entirely under `prefers-reduced-motion`. */
export const MOTION = {
  fast: "120ms",
  base: "200ms",
  easing: "cubic-bezier(0.2, 0, 0.2, 1)",
} as const;
