/**
 * The location-image contract.
 *
 * Two kinds of assertion here, and the second is the one that matters:
 *
 *   1. that the key derivation and the fallback behave;
 *   2. that the three lists which have to agree — the artwork the generator draws, the keys this
 *      module claims are drawn, and the photographs the fixtures claim are committed — actually do,
 *      read off disk rather than taken on trust. Every one of those has drifted before.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DRAWN_LOCATIONS, generatedImageFor, locationKey } from "./locations";

const ROOT = process.cwd();

describe("locationKey", () => {
  it("drops the administrative tail, so one place is one key", () => {
    // The resolver's locale varies; the key must not.
    expect(locationKey("Berlin, Germany")).toBe("berlin");
    expect(locationKey("Berlin, DE")).toBe("berlin");
    expect(locationKey("Berlin")).toBe("berlin");
  });

  it("folds accents and collapses punctuation", () => {
    expect(locationKey("Zürich, Switzerland")).toBe("zurich");
    expect(locationKey("New York, USA")).toBe("new-york");
    expect(locationKey("Washington, D.C.")).toBe("washington");
  });

  it("never yields a leading or trailing hyphen", () => {
    expect(locationKey("  —Paris—  ")).toBe("paris");
  });
});

describe("the generated fallback", () => {
  it("is the tier that cannot fail: a place with artwork gets its own", () => {
    const image = generatedImageFor("Tokyo, Japan");
    expect(image.url).toBe("/locations/tokyo.svg");
    expect(image.source).toBe("generated");
  });

  it("gives an unlisted place an atmosphere of its own, not one shared with every other", () => {
    /*
     * The property that replaced `generic.svg`, and the one worth guarding: Weathra resolves any
     * location the geocoder knows, so "unlisted" is the normal case for a real customer. One
     * shared drawing across every place they save reads as a missing asset.
     */
    const ouagadougou = generatedImageFor("Ouagadougou, Burkina Faso");
    const reykjavik = generatedImageFor("Reykjavík, Iceland");

    expect(ouagadougou.url).toMatch(/^data:image\/svg\+xml/);
    expect(ouagadougou.url).not.toBe(reykjavik.url);
  });

  it("draws the same place the same way every time, so a capture is reproducible", () => {
    // Without this the screenshots would differ run to run and none of them would be evidence.
    expect(generatedImageFor("Osaka, Japan").url).toBe(generatedImageFor("Osaka, Japan").url);
  });

  it("ignores the part of the name that varies with the resolver's locale", () => {
    // `locationKey` keeps the first segment only, so a country rendered "Germany" or "DE" is the
    // same place and gets the same drawing.
    expect(generatedImageFor("Lisbon, Portugal").url).toBe(generatedImageFor("Lisbon, PT").url);
  });

  it("describes itself as artwork, never as a photograph of the place", () => {
    const image = generatedImageFor("Berlin, Germany");
    expect(image.description).toMatch(/generated/i);
    expect(image.description).not.toMatch(/photograph/i);
  });
});

describe("the lists that have to agree", () => {
  it("claims exactly the artwork the generator writes", () => {
    // The generator is the authority; this reads its own CITIES table rather than a duplicate.
    const generator = readFileSync(join(ROOT, "scripts/generate-location-art.mjs"), "utf8");
    const block = generator.slice(generator.indexOf("const CITIES"), generator.indexOf("];", generator.indexOf("const CITIES")));
    const slugs = [...block.matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((match) => match[1]);

    expect(slugs.length).toBeGreaterThan(1);
    // `generic` is the fallback, not a place, so it is not in DRAWN_LOCATIONS.
    expect(slugs).toContain("generic");
    expect([...DRAWN_LOCATIONS].sort()).toEqual(slugs.filter((slug) => slug !== "generic").sort());
  });

  it("has an asset on disk for every key it claims", () => {
    const present = new Set(
      readdirSync(join(ROOT, "public/locations"))
        .filter((name) => name.endsWith(".svg"))
        .map((name) => name.replace(/\.svg$/, "")),
    );
    for (const key of DRAWN_LOCATIONS) expect(present, `no artwork for ${key}`).toContain(key);
    expect(present, "no generic fallback artwork").toContain("generic");
  });

  it("does not claim a committed photograph that is absent", () => {
    // The fixtures' manifest and `public/locations/photos/` must agree, or fixture mode points a
    // capture at a 404 and silently falls back — which is exactly the drift this catches.
    const fixtures = readFileSync(join(ROOT, "lib/fixtures/visily.ts"), "utf8");
    const block = fixtures.slice(
      fixtures.indexOf("const FIXTURE_PHOTO_MANIFEST"),
      fixtures.indexOf("];", fixtures.indexOf("const FIXTURE_PHOTO_MANIFEST")),
    );
    const claimed = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);

    const onDisk = readdirSync(join(ROOT, "public/locations/photos")).filter((name) =>
      /\.(jpe?g|webp|avif|png)$/i.test(name),
    );
    const keys = new Set(onDisk.map((name) => name.replace(/\.[^.]+$/, "")));

    for (const key of claimed) {
      expect(keys, `FIXTURE_PHOTO_MANIFEST claims ${key} but no file is committed`).toContain(key);
    }
  });
});
