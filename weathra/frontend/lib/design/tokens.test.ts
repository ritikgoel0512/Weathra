/**
 * Task 20.3's verification: the tokens match the recorded design system, and contrast meets 4.5:1
 * in both appearances.
 *
 * Three correspondences are asserted, because the design system exists in three places and any
 * two of them agreeing is not enough:
 *
 * 1. **The record** — `docs/design/design-system.md` fixes the roles, the type roles, the spacing
 *    scale, the five data classes and the responsive floor. A role recorded there and absent from
 *    the code means the approved system is not the implemented one.
 * 2. **The stylesheet** — `app/globals.css` is what the browser reads. A value changed in
 *    `tokens.ts` and not in the CSS ships a palette the application does not use.
 * 3. **WCAG** — every declared pair, in both appearances, at its stated minimum.
 *
 * The pairs themselves live in `tokens.ts` as data with a reason attached, so a failure here names
 * the obligation rather than two hex strings.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrastRatio, hueSeparation, roundRatio } from "./contrast";
import {
  APPEARANCES,
  COLOR_TOKENS,
  COLOR_TOKEN_NAMES,
  CONTRAST_REQUIREMENTS,
  DATA_CLASS_NAMES,
  LAYOUT,
  MOTION,
  RADII,
  SHADOWS,
  SPACING_SCALE,
  TYPE_ROLES,
  cssVariableName,
} from "./tokens";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const RECORD = read("../../../docs/design/design-system.md");
const GLOBALS = read("../../app/globals.css");
const PRIMITIVES = read("../../components/ui/primitives.module.css");

/** The text of one numbered section of the design record. */
function section(number: number): string {
  const pattern = new RegExp(`\\n## ${number}\\. [\\s\\S]*?(?=\\n## \\d+\\. |$)`);
  const match = pattern.exec(RECORD);
  if (!match) throw new Error(`the design record has no section ${number}`);
  return match[0];
}

/** A stylesheet with its comments removed, so a rule about CSS is not asserted against prose. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of one CSS block, as a name-to-value map. */
function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    if (name && value) found.set(name, value.trim());
  }
  return found;
}

function cssBlock(pattern: RegExp): Map<string, string> {
  const match = pattern.exec(GLOBALS);
  if (!match?.[1]) throw new Error(`globals.css has no block matching ${pattern}`);
  return declarations(match[1]);
}

/** `:root` at the top level: the dark appearance, which is the default. */
const DARK_BLOCK = cssBlock(/^:root \{([\s\S]*?)\n\}/m);

/** The `[data-appearance="light"]` block: the authentication shell's appearance. */
const LIGHT_BLOCK = cssBlock(/^\[data-appearance="light"\] \{([\s\S]*?)\n\}/m);

const BLOCKS = { dark: DARK_BLOCK, light: LIGHT_BLOCK } as const;

// ---------------------------------------------------------------- the recorded design system

describe("the tokens match the recorded design system", () => {
  it("implements every colour role §1 records", () => {
    const recorded = new Set<string>();
    for (const line of section(1).split("\n")) {
      if (!line.startsWith("| `")) continue;
      const [firstColumn] = line.slice(1).split("|");
      for (const [, token] of (firstColumn ?? "").matchAll(/`([a-z][a-z0-9-]*)`/g)) {
        if (token) recorded.add(token);
      }
    }

    expect(recorded.size).toBeGreaterThanOrEqual(20);
    for (const role of recorded) {
      expect(COLOR_TOKEN_NAMES).toContain(role);
    }
  });

  it("carries the Midnight Intelligence direction: a dark ground with a cyan accent", () => {
    // The ground is darker than the panels above it, and the ground is genuinely dark rather than
    // a pale surface with dark text on it — the direction all eight artifacts are built on.
    const darkness = (token: "surface-base" | "surface-raised") =>
      roundRatio(contrastRatio(COLOR_TOKENS.dark[token], "#ffffff"));
    expect(darkness("surface-base")).toBeGreaterThan(darkness("surface-raised"));
    expect(darkness("surface-base")).toBeGreaterThan(15);

    // Cyan: the accent's blue and green channels lead its red one in both appearances.
    for (const appearance of APPEARANCES) {
      const accent = COLOR_TOKENS[appearance]["accent"];
      const red = Number.parseInt(accent.slice(1, 3), 16);
      const green = Number.parseInt(accent.slice(3, 5), 16);
      const blue = Number.parseInt(accent.slice(5, 7), 16);
      expect(green).toBeGreaterThan(red);
      expect(blue).toBeGreaterThan(red);
    }
  });

  it("implements every type role §2 records, with the recorded face", () => {
    const recorded = section(2);
    // The record's roles, and the implementation entries that carry each one.
    const mapping: Readonly<Record<string, readonly (keyof typeof TYPE_ROLES)[]>> = {
      Display: ["display"],
      Heading: ["heading", "section", "card"],
      Body: ["body"],
      UI: ["ui"],
      Label: ["label"],
      Meta: ["meta"],
    };

    for (const [role, implemented] of Object.entries(mapping)) {
      expect(recorded).toContain(`| ${role} |`);
      for (const key of implemented) {
        expect(TYPE_ROLES[key]).toBeDefined();
      }
    }

    // Plus Jakarta Sans for display and heading; Inter for body, UI, label and meta.
    expect(TYPE_ROLES.display.face).toBe("display");
    expect(TYPE_ROLES.heading.face).toBe("display");
    expect(TYPE_ROLES.section.face).toBe("display");
    expect(TYPE_ROLES.card.face).toBe("display");
    for (const key of ["body", "ui", "label", "meta"] as const) {
      expect(TYPE_ROLES[key].face).toBe("body");
    }
    expect(TYPE_ROLES.label.transform).toBe("uppercase");
    expect(TYPE_ROLES.label.tracking).toBeTruthy();

    // The record names both faces, and the stylesheet loads exactly those two.
    expect(recorded).toContain("Plus Jakarta Sans");
    expect(recorded).toContain("Inter");
    expect(GLOBALS).toContain('"Plus Jakarta Sans"');
    expect(GLOBALS).toContain("Inter");

    // The Numeric role is tabular figures rather than a size, applied where figures are shown.
    expect(recorded).toContain("tabular numerals");
    expect(PRIMITIVES).toContain("font-variant-numeric: tabular-nums");
  });

  it("implements the spacing scale §3 records, in order", () => {
    expect(section(3)).toContain(SPACING_SCALE.join(", "));
    expect([...SPACING_SCALE]).toEqual([...SPACING_SCALE].sort((one, other) => one - other));
    SPACING_SCALE.forEach((value, index) => {
      expect(DARK_BLOCK.get(`--space-${index + 1}`)).toBe(`${value}px`);
    });
  });

  it("implements the five data classes §9 records, and no sixth", () => {
    const recorded = section(9);
    expect(DATA_CLASS_NAMES).toHaveLength(5);
    for (const label of ["OBSERVED", "FORECAST", "HISTORICAL", "ANALYTICS", "AI INTERPRETATION"]) {
      expect(recorded).toContain(`**${label}**`);
    }
    for (const name of DATA_CLASS_NAMES) {
      expect(COLOR_TOKEN_NAMES).toContain(`class-${name}`);
      expect(COLOR_TOKEN_NAMES).toContain(`class-${name}-surface`);
    }
  });

  it("implements the responsive foundations §13 records", () => {
    const recorded = section(13);
    expect(recorded).toContain(`${LAYOUT.wide}px`);
    expect(recorded).toContain(`${LAYOUT.compact}px`);
    expect(recorded).toContain(`**${LAYOUT.minimumViewport}-pixel**`);
    expect(LAYOUT.minimumViewport).toBeLessThan(LAYOUT.compact);
    expect(LAYOUT.compact).toBeLessThan(LAYOUT.wide);
  });
});

// ---------------------------------------------------------------- the stylesheet

describe("the stylesheet declares exactly the tokens", () => {
  it.each(APPEARANCES)("%s declares every colour token with the token's value", (appearance) => {
    const block = BLOCKS[appearance];
    for (const token of COLOR_TOKEN_NAMES) {
      const variable = cssVariableName(token);
      expect(block.get(variable), `${variable} is missing from the ${appearance} block`).toBe(
        COLOR_TOKENS[appearance][token],
      );
    }
  });

  it.each(APPEARANCES)("%s declares no colour the tokens do not know about", (appearance) => {
    const declared = [...BLOCKS[appearance].keys()].filter((name) => name.startsWith("--color-"));
    const known = COLOR_TOKEN_NAMES.map(cssVariableName);
    for (const name of declared) {
      expect(known).toContain(name);
    }
    expect(declared).toHaveLength(COLOR_TOKEN_NAMES.length);
  });

  it("declares the radii, shadows, layout and motion tokens", () => {
    for (const [name, value] of Object.entries(RADII)) {
      expect(DARK_BLOCK.get(`--radius-${name}`)).toBe(value);
    }
    for (const [name, value] of Object.entries(SHADOWS)) {
      expect(DARK_BLOCK.get(`--shadow-${name}`)).toBe(value);
    }
    expect(DARK_BLOCK.get("--layout-navigation-width")).toBe(`${LAYOUT.navigationWidth}px`);
    expect(DARK_BLOCK.get("--layout-navigation-collapsed-width")).toBe(
      `${LAYOUT.navigationCollapsedWidth}px`,
    );
    expect(DARK_BLOCK.get("--layout-content-maximum")).toBe(`${LAYOUT.contentMaximum}px`);
    expect(DARK_BLOCK.get("--duration-fast")).toBe(MOTION.fast);
    expect(DARK_BLOCK.get("--duration-base")).toBe(MOTION.base);
    expect(DARK_BLOCK.get("--easing")).toBe(MOTION.easing);
  });

  it("selects the appearance by screen, never by the visitor's system", () => {
    // The product is Midnight Intelligence on `:root`; the authentication shell opts into light,
    // because `08-authentication.png` is the one artifact rendered there. What must never come
    // back is `prefers-color-scheme`: it handed the whole product to the operating system, and an
    // operator whose machine reported light was served a Dashboard matching no product artifact.
    expect(DARK_BLOCK.get("color-scheme")).toBeUndefined();
    expect(GLOBALS).toMatch(/:root \{\n {2}color-scheme: dark;/);
    // `declarations()` reads custom properties only, so this one is checked in the raw text.
    expect(GLOBALS).toMatch(/\[data-appearance="light"\] \{\n {2}color-scheme: light;/);
    expect(GLOBALS).not.toMatch(/@media \([^)]*prefers-color-scheme[^)]*\) \{/);
    expect(APPEARANCES).toEqual(["dark", "light"]);
  });

  it("scopes the light appearance to the authentication group and nothing else", () => {
    // A second appearance is only safe while exactly one place opts into it. If a product screen
    // ever takes `data-appearance`, the Dashboard can go pale again without a test noticing.
    const optIns = [...GLOBALS.matchAll(/\[data-appearance="([a-z]+)"\]/g)].map((m) => m[1]);
    expect(new Set(optIns)).toEqual(new Set(["light"]));
  });
});

describe("the primitive layer references tokens rather than values", () => {
  it("holds no literal colour", () => {
    expect(PRIMITIVES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(PRIMITIVES).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it("holds no literal font family", () => {
    for (const [, value] of PRIMITIVES.matchAll(/font-family:\s*([^;]+);/g)) {
      expect(value?.trim()).toMatch(/^var\(--family-(display|body)\)$/);
    }
  });

  it("references only colour tokens that exist", () => {
    const known = new Set(COLOR_TOKEN_NAMES.map(cssVariableName));
    const referenced = [...PRIMITIVES.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map(
      ([, name]) => name,
    );
    expect(referenced.length).toBeGreaterThan(20);
    for (const name of referenced) {
      expect(known, `${name} is referenced but not declared`).toContain(name);
    }
  });
});

// ---------------------------------------------------------------- accessibility

describe("contrast meets its minimum in both appearances", () => {
  it.each(APPEARANCES)("%s", (appearance) => {
    const palette = COLOR_TOKENS[appearance];
    const failures: string[] = [];

    for (const requirement of CONTRAST_REQUIREMENTS) {
      const ratio = roundRatio(
        contrastRatio(palette[requirement.foreground], palette[requirement.background]),
      );
      if (ratio < requirement.minimum) {
        failures.push(
          `${requirement.foreground} on ${requirement.background} is ${ratio}:1, ` +
            `below ${requirement.minimum}:1 — ${requirement.because}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("checks body text against every surface it can sit on", () => {
    const textPairs = CONTRAST_REQUIREMENTS.filter(
      (requirement) => requirement.foreground === "text-primary",
    );
    expect(textPairs.map((pair) => pair.background)).toEqual([
      "surface-base",
      "surface-raised",
      "surface-overlay",
      "surface-inset",
      // Task 20.15: the AI-interpretation panel is a tinted ground that carries prose, so it is a
      // surface body text sits on and belongs in this inventory.
      "class-interpretation-surface",
      // Task 21.8's audit: the four status grounds carry prose too. The candidate chooser asks its
      // question on the caution ground and the two destructive confirmations state what they will
      // remove on the error ground, so body text sits on all four and each is measured.
      "status-error-surface",
      "status-warning-surface",
      "status-ok-surface",
      "status-quota-surface",
    ]);
    for (const pair of textPairs) {
      expect(pair.minimum).toBe(4.5);
    }
  });
});

describe("the data classes stay distinguishable", () => {
  it.each(APPEARANCES)("%s gives each class its own colour", (appearance) => {
    const palette = COLOR_TOKENS[appearance];
    const values = DATA_CLASS_NAMES.map((name) => palette[`class-${name}`]);
    expect(new Set(values).size).toBe(DATA_CLASS_NAMES.length);

    // Separation is a hue question, not a contrast one: two badge colours of different hue and
    // similar lightness sit at about 1:1, so a ratio between them would say nothing. 25 degrees
    // is the floor — below it a reader is separating two shades of one colour.
    for (let one = 0; one < values.length; one += 1) {
      for (let other = one + 1; other < values.length; other += 1) {
        const first = values[one];
        const second = values[other];
        if (!first || !second) throw new Error("a data class has no colour");
        expect(
          Math.round(hueSeparation(first, second)),
          `${DATA_CLASS_NAMES[one]} and ${DATA_CLASS_NAMES[other]} are too close in hue`,
        ).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it.each(APPEARANCES)("%s keeps the quota state out of the error hue", (appearance) => {
    // The design record is explicit: an exhausted allowance is not a failure, so it may not be a
    // shade of the failure colour.
    const palette = COLOR_TOKENS[appearance];
    expect(palette["status-quota"]).not.toBe(palette["status-error"]);
    expect(Math.round(hueSeparation(palette["status-quota"], palette["status-error"]))).toBeGreaterThanOrEqual(
      25,
    );
  });

  it("never leaves hue as the only carrier", () => {
    // Every class states itself in words, and the interpretation class additionally takes a
    // distinct edge treatment — the two nearest hues in the set are the pair that separates.
    expect(PRIMITIVES).toContain('.badge[data-class="interpretation"]');
    expect(section(9)).toContain("AI INTERPRETATION");
    expect(PRIMITIVES).toContain("text-transform: uppercase");
  });
});

describe("the stylesheet keeps its accessibility obligations", () => {
  it("gives focus a visible indicator and never removes one", () => {
    expect(GLOBALS).toContain(":focus-visible");
    expect(GLOBALS).toMatch(/:focus-visible \{[\s\S]*?outline: 2px solid var\(--color-accent\)/);
    expect(withoutComments(GLOBALS)).not.toMatch(/outline:\s*(none|0)\b/);
    expect(withoutComments(PRIMITIVES)).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it("honours a request for reduced motion", () => {
    expect(GLOBALS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(PRIMITIVES).toContain("@media (prefers-reduced-motion: reduce)");
    // The skeleton's shimmer is removed rather than shortened.
    expect(PRIMITIVES).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.skeleton \{\s*animation: none/);
  });

  it("holds the 360-pixel floor by refusing horizontal page scroll", () => {
    expect(GLOBALS).toMatch(/html \{[\s\S]*?overflow-x: hidden/);
    expect(GLOBALS).toContain(".weathra-scroll-x");
  });

  it("offers a visually hidden utility for announcements", () => {
    expect(GLOBALS).toContain(".weathra-visually-hidden");
    expect(GLOBALS).toMatch(/\.weathra-visually-hidden \{[\s\S]*?clip-path: inset\(50%\)/);
  });
});
