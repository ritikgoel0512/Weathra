/**
 * Naming a resolved place — task 21.6's verification of the one string that has to round-trip.
 *
 * `qualifiedName` is not cosmetic: Settings sends it back to the backend as the default location,
 * and the backend re-resolves it. So what is asserted here is that it reproduces the backend's own
 * `Location.qualified_name` shape — display name, region, then the country *code* in preference to
 * the country name — which is the form its geocoder reads as a qualifier.
 */

import { describe, expect, it } from "vitest";

import type { Location, SavedLocationRecord } from "@/lib/api/schema";

import {
  coordinatesOf,
  isSamePlace,
  matchesFilter,
  placeKey,
  qualifiedName,
  savedLocationLabel,
} from "./place";

function place(overrides: Partial<Location> = {}): Location {
  return {
    display_name: "Berlin",
    latitude: 52.52,
    longitude: 13.405,
    timezone: "Europe/Berlin",
    region: "Berlin",
    country: "Germany",
    country_code: "DE",
    ...overrides,
  } as Location;
}

function record(overrides: Partial<SavedLocationRecord> = {}): SavedLocationRecord {
  return { id: "s1", location: place(), label: null, ...overrides } as SavedLocationRecord;
}

describe("qualifiedName", () => {
  it("reproduces the backend's shape: name, region, country code", () => {
    expect(qualifiedName(place())).toBe("Berlin, Berlin, DE");
  });

  it("prefers the country code over the country name, as the backend does", () => {
    expect(qualifiedName(place({ country_code: "US", country: "United States", region: "Illinois", display_name: "Springfield" }))).toBe(
      "Springfield, Illinois, US",
    );
  });

  it("falls back to the country name when there is no code", () => {
    expect(qualifiedName(place({ country_code: null }))).toBe("Berlin, Berlin, Germany");
  });

  it("invents no qualifier for a place that has none", () => {
    expect(qualifiedName(place({ region: null, country: null, country_code: null }))).toBe("Berlin");
  });
});

describe("placeKey and isSamePlace", () => {
  it("identifies a place by where it is, not by how it was spelled", () => {
    expect(placeKey(place())).toBe(placeKey(place({ display_name: "berlin", region: null })));
    expect(isSamePlace(place(), place({ display_name: "BERLIN" }))).toBe(true);
  });

  it("treats two different places as different", () => {
    expect(isSamePlace(place(), place({ latitude: 48.14, longitude: 11.58 }))).toBe(false);
  });

  it("is false when either side is absent", () => {
    expect(isSamePlace(place(), null)).toBe(false);
    expect(isSamePlace(undefined, place())).toBe(false);
  });
});

describe("savedLocationLabel", () => {
  it("uses the person's own name for it when they gave one", () => {
    expect(savedLocationLabel(record({ label: "Home" }))).toBe("Home");
  });

  it("falls back to the canonical name, never to a blank", () => {
    expect(savedLocationLabel(record({ label: "   " }))).toBe("Berlin, Berlin, DE");
    expect(savedLocationLabel(record({ label: null }))).toBe("Berlin, Berlin, DE");
  });
});

describe("matchesFilter", () => {
  it("matches every part of the name, case-insensitively", () => {
    expect(matchesFilter(record(), "berl")).toBe(true);
    expect(matchesFilter(record(), "GERMANY")).toBe(true);
    expect(matchesFilter(record(), "de")).toBe(true);
    expect(matchesFilter(record({ label: "Home" }), "hom")).toBe(true);
  });

  it("keeps everything for an empty filter and drops what does not match", () => {
    expect(matchesFilter(record(), "")).toBe(true);
    expect(matchesFilter(record(), "   ")).toBe(true);
    expect(matchesFilter(record(), "tokyo")).toBe(false);
  });
});

describe("coordinatesOf", () => {
  it("shows the coordinates the backend resolved, without inventing precision", () => {
    expect(coordinatesOf(place())).toBe("52.5200, 13.4050");
  });
});
