/**
 * The product-copy guard — the sweep, kept.
 *
 * The artifacts describe an infrastructure Weathra does not own: sensor networks and station
 * identifiers, neural agents, named meteorological institutions, flight telemetry, continuous
 * monitoring. Every screen's build refused those, one screen at a time, and `screens.md` §5 records
 * each refusal. What was missing was anything stopping the next screen from re-introducing one — a
 * label copied from a mockup reads as plausible product copy long after the pass that refused it.
 *
 * So the sweep is a test. It reads shipped frontend source, strips comments, and fails on a phrase
 * that would be a claim Weathra cannot support. Comments are stripped because most of these words
 * appear in this codebase deliberately: the refusals are documented beside the code that makes
 * them, and a scan that could not tell a refusal from a claim would push the reasoning out of the
 * source to keep itself green.
 *
 * **What this does not police.** Whether a panel is well written, and whether an artifact's *label*
 * may be kept over an unfilled meter — `design-system.md` records that decision, and the two on the
 * Dashboard and Historical screens say in the same breath that Weathra computes no such figure.
 * The rule here is narrower and absolute: these particular nouns are not Weathra's, in any tense.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/** Vitest runs from the frontend package root, which is where the scanned directories live. */
const ROOT = process.cwd();

/**
 * Comments removed, so a documented refusal is not read as the thing it refuses.
 *
 * The line-comment rule ignores `//` preceded by a colon, which is what keeps a URL in a string
 * from truncating the rest of the file and hiding whatever follows it.
 */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
}

/**
 * Phrases that cannot be true of Weathra, whatever surrounds them.
 *
 * Each is something an artifact draws. Weathra reads one weather provider and one model gateway;
 * it owns no instrument, trains no model, integrates with no institution, and runs nothing on a
 * timer — so none of these can appear in a rendered string, and a negated form ("no sensor network
 * exists") belongs in a comment rather than on screen.
 */
const UNSUPPORTABLE = [
  "sensor network",
  "sensor node",
  "station id",
  "neural agent",
  "neural network",
  "neural model",
  "ECMWF",
  "NASA",
  "WMO",
  "flight telemetry",
  "24/7",
  "real-time monitoring",
  "AI-powered",
  "state-of-the-art",
  "proprietary",
  "guaranteed",
] as const;

/**
 * The Visily fidelity-mode modules, and they are the only exclusion.
 *
 * These transcribe the mockups on purpose, so a rendered screen can be photographed beside one, and
 * each says so at the top of its own file. None of them reaches production: `usingVisilyFixtures()`
 * gates every one of them and `lib/fixtures/fixtures.test.ts` is what holds that gate shut. So the
 * phrases they carry are the artifact's, quoted — not Weathra's, claimed.
 *
 * The list is written out rather than matched by a `fixture-` prefix on purpose. A pattern would
 * mean this rule could be escaped by naming a file well, which is the one thing an exclusion must
 * not allow; a name added here is a line in a diff somebody has to justify.
 */
const EXCLUDED = [
  "lib/fixtures/visily.ts",
  "components/analyst/fixture-analyst.tsx",
  "components/auth/fixture-auth.tsx",
  "components/compare/fixture-compare.tsx",
  "components/dashboard/fixture-dashboard.tsx",
  "components/evidence/fixture-evidence.tsx",
  "components/historical/fixture-historical.tsx",
  "components/locations/fixture-locations.tsx",
  "components/settings/fixture-settings.tsx",
];

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

function shippedSources(): string[] {
  return ["components", "app", "lib"]
    .flatMap((directory) => walk(join(ROOT, directory)))
    .map((path) => relative(ROOT, path).split(sep).join("/"))
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path))
    .filter((path) => !EXCLUDED.includes(path));
}

describe("the comment stripper", () => {
  it("removes a block comment and keeps the code after it", () => {
    expect(withoutComments("/* neural agent */ const a = 1;")).toContain("const a = 1;");
    expect(withoutComments("/* neural agent */ const a = 1;")).not.toContain("neural agent");
  });

  it("removes a line comment", () => {
    expect(withoutComments("const a = 1; // sensor network")).not.toContain("sensor network");
  });

  it("does not treat a URL as the start of a comment", () => {
    // Without the lookbehind this line would swallow everything after `https:` and the scan would
    // pass by reading less of the file, which is the failure mode of a scanner.
    const source = 'const url = "https://example.test/x"; const claim = "sensor network";';
    expect(withoutComments(source)).toContain("sensor network");
  });
});

describe("shipped product copy", () => {
  it("scans a real number of files, so it cannot pass vacuously", () => {
    const files = shippedSources();
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true);
  });

  it.each(UNSUPPORTABLE)("claims no %s", (phrase) => {
    const offenders = shippedSources().filter((path) =>
      withoutComments(readFileSync(join(ROOT, path), "utf8"))
        .toLowerCase()
        .includes(phrase.toLowerCase()),
    );

    expect(offenders, `"${phrase}" appears in shipped source outside a comment`).toEqual([]);
  });
});


describe("the exclusion list", () => {
  it("names only files that exist and are gated by the fixture switch", () => {
    for (const path of EXCLUDED) {
      const source = readFileSync(join(ROOT, path), "utf8");
      // Either it is the fixture module itself, or it imports the gate that keeps it out of
      // production. A file that does neither has been excluded on its name alone.
      const gated =
        path === "lib/fixtures/visily.ts" ||
        source.includes("usingVisilyFixtures") ||
        source.includes("@/lib/fixtures/visily");
      expect(gated, `${path} is excluded but is not a fixture module`).toBe(true);
    }
  });
});
