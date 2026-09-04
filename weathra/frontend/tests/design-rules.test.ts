/**
 * The stylesheet rules the design system states, asserted over the stylesheets — task 21.8.
 *
 * Three of task 21.8's criteria are properties of CSS rather than of markup, and two of those can be
 * settled without a browser by reading the stylesheets themselves. That is worth doing here as well
 * as in Chromium, because a static rule names the file and the selector that broke it, where a
 * browser assertion says only that something overflowed.
 *
 * - **`docs/design/design-system.md` §14: "a visible focus indicator … never `outline: none`".**
 *   Removing the outline is legitimate *when a focus treatment replaces it*; removing it and
 *   replacing it with nothing is the single most common way a product becomes unusable by keyboard,
 *   and it is invisible to everybody who uses a mouse.
 * - **§13's three shell tiers.** The breakpoints are a recorded design decision, so a fourth one
 *   appearing in the shell is a decision nobody wrote down.
 * - **The 360-pixel floor.** Nothing may pin the page wider than the viewport. A fixed pixel width
 *   on a layout container is how that happens, so the containers declare `min-width: 0` and no
 *   layout rule declares a width the viewport cannot honour.
 *
 * What is deliberately *not* asserted here is whether the rendered page overflows: that depends on
 * content, fonts and the cascade, and it is verified in a real Chromium at three viewports in
 * `tests/e2e/accessibility.spec.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Every stylesheet the application ships, as `[path, text]`. */
function stylesheets(): [string, string][] {
  const found: [string, string][] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".css")) found.push([path, readFileSync(path, "utf8")]);
    }
  };

  for (const root of ["app", "components"]) walk(root);
  return found;
}

/** A stylesheet with its comments removed, so an audit reads declarations rather than prose. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `selector { body }` block in a stylesheet, flattened. */
function rules(source: string): { selector: string; body: string }[] {
  const text = withoutComments(source);
  const found: { selector: string; body: string }[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim().split("\n").at(-1)?.trim() ?? "";
    found.push({ selector, body: match[2] ?? "" });
  }
  return found;
}

const SHEETS = stylesheets();

describe("the stylesheets exist and are read", () => {
  it("finds every stylesheet the application ships", () => {
    // A guard on the walker itself: an audit over zero files passes vacuously.
    expect(SHEETS.length).toBeGreaterThan(10);
    expect(SHEETS.map(([path]) => path)).toContain(join("app", "globals.css"));
    expect(SHEETS.map(([path]) => path)).toContain(
      join("components", "ui", "primitives.module.css"),
    );
  });
});

describe("the focus indicator is never simply removed", () => {
  it("pairs every `outline: none` with a focus treatment in the same rule", () => {
    const offenders: string[] = [];

    for (const [path, text] of SHEETS) {
      for (const { selector, body } of rules(text)) {
        if (!/outline:\s*none/.test(body)) continue;
        // A replacement treatment: the design system's focus shadow, an outline offset, or an
        // explicit border change. Anything else leaves the control with no visible focus at all.
        const replaced = /box-shadow:/.test(body) || /outline-offset:/.test(body) || /border-color:/.test(body);
        if (!replaced) offenders.push(`${path} → ${selector}`);
      }
    }

    expect(offenders, `\`outline: none\` with no focus treatment:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("uses the design system's own focus shadow rather than a locally invented ring", () => {
    const rings: string[] = [];

    for (const [path, text] of SHEETS) {
      for (const { selector, body } of rules(text)) {
        if (!/:focus-visible/.test(selector)) continue;
        if (!/box-shadow:/.test(body)) continue;
        if (/var\(--shadow-focus\)/.test(body)) continue;
        rings.push(`${path} → ${selector}`);
      }
    }

    expect(rings, `focus rings not using --shadow-focus:\n${rings.join("\n")}`).toEqual([]);
  });

  it("gives everything focusable a visible ring, once, globally", () => {
    // One `:focus-visible` rule on the document rather than one per component: a primitive that
    // forgot its own would otherwise have no indicator at all, which is the failure this system is
    // built to make unreachable.
    const [, globals] = SHEETS.find(([path]) => path.endsWith("globals.css")) ?? ["", ""];
    const rule = rules(globals).find(({ selector }) => selector === ":focus-visible");

    expect(rule, "globals.css declares no :focus-visible rule").toBeDefined();
    expect(rule?.body).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(rule?.body).toMatch(/outline-offset:/);
  });
});

describe("the brand mark's accent tile", () => {
  /**
   * Task 21.9 found the mark drawn as a bare glyph where all eight approved artifacts show it
   * inside a filled accent tile. The tile was added; this keeps the pairing honest if it is ever
   * restyled.
   *
   * The pairing is the point rather than the tile: an accent ground needs `accent-contrast` on it,
   * which is the same combination the primary button uses and the reason it reads in both
   * appearances. A glyph left at `accent` would be accent on accent — invisible.
   */
  it("pairs the accent ground with accent-contrast wherever it is declared", () => {
    const declarations = stylesheets().flatMap(([path, text]) =>
      rules(text)
        .filter((rule) => /\.brandMark\b/.test(rule.selector))
        .map((rule) => ({ path, ...rule })),
    );

    // Both shells declare it — the authentication shell and the application shell.
    expect(declarations.length).toBeGreaterThanOrEqual(2);

    for (const declaration of declarations) {
      expect(
        /background:\s*var\(--color-accent\)/.test(declaration.body),
        `${declaration.path} does not give the brand tile the accent ground`,
      ).toBe(true);
      expect(
        /color:\s*var\(--color-accent-contrast\)/.test(declaration.body),
        `${declaration.path} does not put accent-contrast on the accent ground`,
      ).toBe(true);
    }
  });
});

describe("the recorded responsive tiers", () => {
  it("declares exactly the three shell tiers of design-system.md §13", () => {
    const [, shell] = SHEETS.find(([path]) => path.endsWith("shell.module.css")) ?? ["", ""];
    const queries = [...withoutComments(shell).matchAll(/@media\s*([^{]+)\{/g)].map((match) =>
      (match[1] ?? "").replace(/\s+/g, " ").trim(),
    );

    expect(queries).toContain("(min-width: 1280px)");
    expect(queries).toContain("(min-width: 768px) and (max-width: 1279px)");
    expect(queries).toContain("(max-width: 767px)");
    // No fourth tier invented in the shell.
    const tiers = queries.filter((query) => /min-width|max-width/.test(query));
    for (const tier of tiers) {
      expect(tier).toMatch(/1280px|1279px|767px|768px/);
    }
  });

  it("keeps every breakpoint in the application at or above the 360-pixel floor", () => {
    const widths: number[] = [];
    for (const [, text] of SHEETS) {
      for (const match of withoutComments(text).matchAll(/@media[^{]*?(\d+)px/g)) {
        widths.push(Number(match[1]));
      }
    }
    expect(widths.length).toBeGreaterThan(0);
    // A breakpoint below the floor would describe a viewport Weathra does not claim to support.
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(360);
  });
});

describe("nothing pins the page wider than the viewport", () => {
  it("never sets `overflow-x` on the document or the body", () => {
    const [, globals] = SHEETS.find(([path]) => path.endsWith("globals.css")) ?? ["", ""];
    for (const { selector, body } of rules(globals)) {
      if (!/^(html|body|html,\s*body|:root)$/.test(selector)) continue;
      // Hiding the page's own overflow would *conceal* a layout that does not fit rather than fix
      // it, and would take the content that overflowed out of reach entirely.
      expect(body).not.toMatch(/overflow-x:\s*(hidden|scroll)/);
    }
  });

  it("declares no fixed pixel width a 360-pixel viewport could not honour", () => {
    const offenders: string[] = [];

    for (const [path, text] of SHEETS) {
      for (const { selector, body } of rules(text)) {
        for (const match of body.matchAll(/(?<!min-|max-)\bwidth:\s*(\d+)px/g)) {
          const width = Number(match[1]);
          if (width > 360) offenders.push(`${path} → ${selector}: width ${width}px`);
        }
        // A `min-width` larger than the floor is the other way a page is pinned open.
        for (const match of body.matchAll(/\bmin-width:\s*(\d+)px/g)) {
          const width = Number(match[1]);
          if (width > 360) offenders.push(`${path} → ${selector}: min-width ${width}px`);
        }
      }
    }

    expect(offenders, `widths a 360px viewport cannot honour:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("scrolls wide content inside its own container, not the page", () => {
    // The two surfaces with content wider than a phone: the evidence sources table and the
    // comparison figures. `specs/web-ui` requires each to scroll within its own container.
    const containers: string[] = [];
    for (const [path, text] of SHEETS) {
      for (const { selector, body } of rules(text)) {
        if (/overflow-x:\s*auto/.test(body)) containers.push(`${path} → ${selector}`);
      }
    }
    expect(containers.length).toBeGreaterThan(0);
    expect(containers.some((entry) => entry.includes("evidence"))).toBe(true);
  });
});

describe("grid and flex containers can shrink", () => {
  it("declares `min-width: 0` in every stylesheet that lays out a grid", () => {
    // The default `min-width: auto` on a grid or flex item is what makes one long word, one wide
    // table or one un-breakable identifier push a whole page sideways. A stylesheet that lays out
    // columns must say its items may shrink; one that stacks a single column — the authentication
    // card, for instance — has nothing to shrink and is not required to.
    const offenders: string[] = [];

    for (const [path, text] of SHEETS) {
      const declarations = withoutComments(text);
      if (!/grid-template-columns/.test(declarations)) continue;
      if (/min-width:\s*0/.test(declarations)) continue;
      offenders.push(path);
    }

    expect(
      offenders,
      `stylesheets laying out a grid without a shrinkable item:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
