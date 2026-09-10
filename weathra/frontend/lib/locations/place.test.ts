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
  UNNAMED_PLACE,
  coordinatesOf,
  friendlyName,
  isCoordinateName,
  isSamePlace,
  isUnnamedPlace,
  matchesFilter,
  placeKey,
  placeLabel,
  qualifiedName,
  savedLocationDisplay,
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
    // The readable name, not the geocoder's round-trip form.
    expect(savedLocationLabel(record({ label: "   " }))).toBe("Berlin, Germany");
    expect(savedLocationLabel(record({ label: null }))).toBe("Berlin, Germany");
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

describe("a saved place with no name of its own", () => {
  function saved(location: Partial<Location>, label: string | null = null): SavedLocationRecord {
    return {
      id: "s-1",
      label,
      location: {
        display_name: "x",
        latitude: 0,
        longitude: 0,
        timezone: "UTC",
        ...location,
      },
    } as SavedLocationRecord;
  }

  it("is recognised wherever in the world it is, from the shape of its name", () => {
    // Deliberately three unrelated points on three continents: the rule is about the *shape* of
    // the stored name, so nothing here depends on which city it happens to be near.
    for (const { lat, lon } of [
      { lat: 48.1374, lon: 11.5755 },
      { lat: 28.4595, lon: 77.0266 },
      { lat: -33.8688, lon: 151.2093 },
    ]) {
      const record = saved({
        display_name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        latitude: lat,
        longitude: lon,
      });
      expect(isUnnamedPlace(record)).toBe(true);
      expect(savedLocationDisplay(record)).toBe(UNNAMED_PLACE);
    }
  });

  it("is named once the person has labelled it, without the coordinates coming back", () => {
    const record = saved(
      { display_name: "28.4595, 77.0266", latitude: 28.4595, longitude: 77.0266 },
      "Office",
    );
    expect(isUnnamedPlace(record)).toBe(false);
    expect(savedLocationDisplay(record)).toBe("Office");
  });

  it("leaves a properly named place alone, whatever it is called", () => {
    for (const name of ["Gurugram", "Munich", "Reykjavík", "São Paulo", "Ōsaka"]) {
      const record = saved({ display_name: name, country_code: "XX" });
      expect(isUnnamedPlace(record), name).toBe(false);
      expect(savedLocationDisplay(record)).toContain(name);
    }
  });

  it("keeps the coordinates as what they are: where the place is, not what it is called", () => {
    const record = saved({
      display_name: "-33.8688, 151.2093",
      latitude: -33.8688,
      longitude: 151.2093,
    });
    // The display name stops being digits; the coordinates remain available as metadata.
    expect(savedLocationDisplay(record)).toBe(UNNAMED_PLACE);
    expect(coordinatesOf(record.location)).toContain("-33.8688");
  });
});

describe("the name a person reads", () => {
  const place = (overrides: Partial<Location>): Location =>
    ({
      display_name: "Berlin",
      latitude: 52.52,
      longitude: 13.405,
      timezone: "Europe/Berlin",
      ...overrides,
    }) as Location;

  it("spells the country out and drops a region that repeats the city", () => {
    expect(friendlyName(place({ region: "Berlin", country: "Germany", country_code: "DE" }))).toBe(
      "Berlin, Germany",
    );
  });

  it("keeps a region that says something the city does not", () => {
    expect(
      friendlyName(
        place({ display_name: "Yamunanagar", region: "Haryana", country: "India", country_code: "IN" }),
      ),
    ).toBe("Yamunanagar, Haryana, India");
  });

  it("works for arbitrary places worldwide, naming no city in the implementation", () => {
    expect(friendlyName(place({ display_name: "Tokyo", region: "Tokyo", country: "Japan" }))).toBe(
      "Tokyo, Japan",
    );
    expect(
      friendlyName(place({ display_name: "Dubai", region: "Dubai", country: "United Arab Emirates" })),
    ).toBe("Dubai, United Arab Emirates");
  });

  it("falls back to the country code when the provider reported no country name", () => {
    expect(friendlyName(place({ country_code: "DE" }))).toBe("Berlin, DE");
  });

  it("is the city alone when the provider reported nothing else", () => {
    expect(friendlyName(place({}))).toBe("Berlin");
  });
});

describe("a name that already carries its own qualifiers", () => {
  /*
   * Geocoders disagree about what `display_name` holds. Open-Meteo's search returns the plain city
   * and puts the country in its own field; other sources — and our own older saved rows — return
   * "Berlin, Germany" in the name. Appending the country to the second produced
   * "Berlin, Germany, Germany" on three screens before this was fixed.
   */
  it("does not repeat a country the name already states", () => {
    expect(
      friendlyName({
        display_name: "Berlin, Germany",
        latitude: 52.52,
        longitude: 13.405,
        timezone: "Europe/Berlin",
        country: "Germany",
      }),
    ).toBe("Berlin, Germany");
  });

  it("still composes a name from the fields when the name is the city alone", () => {
    expect(
      friendlyName({
        display_name: "Berlin",
        latitude: 52.52,
        longitude: 13.405,
        timezone: "Europe/Berlin",
        region: "Berlin",
        country: "Germany",
      }),
    ).toBe("Berlin, Germany");
  });

  it("compares case-insensitively, because a provider's casing is not a fact", () => {
    expect(
      friendlyName({
        display_name: "Munich, GERMANY",
        latitude: 48.14,
        longitude: 11.58,
        timezone: "Europe/Berlin",
        country: "Germany",
      }),
    ).toBe("Munich, GERMANY");
  });
});

describe("placeLabel", () => {
  const point = {
    display_name: "48.1374, 11.5755",
    latitude: 48.1374,
    longitude: 11.5755,
    timezone: "Europe/Berlin",
  };

  it("never shows a coordinate pair as a place name", () => {
    // The production bug this exists for: Historical Analytics titled its screen "48.1374, 11.5755".
    expect(placeLabel(point)).toBe(UNNAMED_PLACE);
  });

  it("names a place that has a name", () => {
    expect(
      placeLabel({ ...point, display_name: "Munich", country: "Germany" }),
    ).toBe("Munich, Germany");
  });

  it("is null for no place at all, so a caller can fall back to its own words", () => {
    expect(placeLabel(null)).toBeNull();
    expect(placeLabel(undefined)).toBeNull();
  });
});
