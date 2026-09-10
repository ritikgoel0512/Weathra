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
  isCoordinateName,
  isSamePlace,
  matchesFilter,
  placeKey,
  qualifiedName,
  savedLocationLabel,
  sendableName,
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

describe("a place whose only name is its coordinates", () => {
  const named: Location = {
    display_name: "Munich",
    latitude: 48.13743,
    longitude: 11.57549,
    timezone: "Europe/Berlin",
    country: "Germany",
  };
  const unnamed: Location = {
    display_name: "48.1374, 11.5755",
    latitude: 48.13743,
    longitude: 11.57549,
    timezone: "Europe/Berlin",
  };

  it("is recognised by the shape the backend formats", () => {
    expect(isCoordinateName("48.1374, 11.5755")).toBe(true);
    expect(isCoordinateName("-33.8688, 151.2093")).toBe(true);
    expect(isCoordinateName(" 0, 0 ")).toBe(true);
    expect(isCoordinateName("Munich")).toBe(false);
    expect(isCoordinateName("Munich, Germany")).toBe(false);
    // Not a coordinate pair: a real place name that merely contains a number.
    expect(isCoordinateName("Kirkjubæjarklaustur 2")).toBe(false);
  });

  it("sends no name, so the backend is never asked to geocode a coordinate string", () => {
    // The regression this guards is a bug this line has already had: sending
    // "48.1374, 11.5755" as a place name failed with "No location matches …", and a place
    // Weathra had itself resolved could not become the default it was offered as.
    expect(sendableName(unnamed)).toBeNull();
  });

  it("sends the name for a place that has one", () => {
    expect(sendableName(named)).toBe("Munich");
  });
});
