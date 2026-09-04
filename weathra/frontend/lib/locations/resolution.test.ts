/**
 * Reading the location-resolution contract — task 21.7's verification of the state machine.
 *
 * Four answers, kept four. The assertions here are mostly about *not* collapsing them: that an
 * ambiguous 200 never yields a location, that a 404 for an unknown name never yields a candidate,
 * that a 500 is never reported as "no such place", and that only a resolved answer unblocks data.
 * Every one of those is a way the interface could otherwise pick a place for somebody or deny that
 * a real one exists.
 */

import { describe, expect, it, vi } from "vitest";

import { ApiError, BackendUnreachable, type ApiClient } from "@/lib/api/client";
import type { AmbiguousResponse, Location, ResolvedResponse } from "@/lib/api/schema";

import {
  alreadyResolved,
  awaitsChoice,
  blocksData,
  candidateDetail,
  candidateKey,
  chosenResolution,
  resolutionOf,
  resolutionOfFailure,
  resolvedLocation,
  resolveLocationEntry,
  UNRESOLVED,
} from "./resolution";

function place(overrides: Partial<Location> = {}): Location {
  return {
    display_name: "Springfield",
    latitude: 39.8017,
    longitude: -89.6437,
    timezone: "America/Chicago",
    region: "Illinois",
    country: "United States",
    country_code: "US",
    ...overrides,
  } as Location;
}

const ILLINOIS = place();
const MISSOURI = place({
  latitude: 37.2153,
  longitude: -93.2982,
  region: "Missouri",
});

const AMBIGUOUS = {
  kind: "ambiguous",
  query: "Springfield",
  candidates: [ILLINOIS, MISSOURI],
  message: "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US.",
} as unknown as AmbiguousResponse;

const RESOLVED = {
  kind: "resolved",
  query: "Reykjavik",
  location: place({ display_name: "Reykjavík", region: null, country: "Iceland", country_code: "IS" }),
} as unknown as ResolvedResponse;

describe("resolutionOf", () => {
  it("reads a single match as resolved, carrying the backend's own location", () => {
    const resolution = resolutionOf("Reykjavik", RESOLVED);
    expect(resolution.kind).toBe("resolved");
    expect(resolvedLocation(resolution)).toBe(RESOLVED.location);
    expect(resolution.kind === "resolved" && resolution.chosen).toBe(false);
  });

  it("reads several matches as ambiguous, with the candidates and the backend's message", () => {
    const resolution = resolutionOf("Springfield", AMBIGUOUS);
    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.kind === "ambiguous" && resolution.candidates).toEqual([ILLINOIS, MISSOURI]);
    expect(resolution.kind === "ambiguous" && resolution.message).toContain("more than one place");
  });

  it("yields no location at all for an ambiguous answer", () => {
    // The gate is structural: there is nothing in this state to make a weather request with.
    expect(resolvedLocation(resolutionOf("Springfield", AMBIGUOUS))).toBeNull();
  });

  it("keeps the candidates in the backend's order and does not trim them", () => {
    const resolution = resolutionOf("Springfield", AMBIGUOUS);
    expect(resolution.kind === "ambiguous" && resolution.candidates[0]).toBe(ILLINOIS);
    expect(resolution.kind === "ambiguous" && resolution.candidates).toHaveLength(2);
  });
});

describe("resolutionOfFailure", () => {
  it("reads the backend's not-found code as no such place, with its message", () => {
    const resolution = resolutionOfFailure(
      "Zzzz",
      new ApiError(404, { code: "location_not_found", message: "No location matches 'Zzzz'." }),
    );
    expect(resolution.kind).toBe("not-found");
    expect(resolution.kind === "not-found" && resolution.message).toBe("No location matches 'Zzzz'.");
  });

  it("never reports no such place for a failure that is not one", () => {
    for (const error of [
      new ApiError(500, { code: "internal_error", message: "Weathra could not look that up." }),
      new ApiError(400, { code: "validation_failed", message: "That query is too long." }),
      new BackendUnreachable(new Error("offline")),
    ]) {
      const resolution = resolutionOfFailure("Berlin", error);
      expect(resolution.kind).toBe("failed");
    }
  });

  it("carries the backend's own message and request id into the failure", () => {
    const resolution = resolutionOfFailure(
      "Berlin",
      new ApiError(500, {
        code: "internal_error",
        message: "The geocoder did not answer.",
        request_id: "req-9",
      }),
    );
    expect(resolution.kind === "failed" && resolution.failure.message).toBe(
      "The geocoder did not answer.",
    );
    expect(resolution.kind === "failed" && resolution.failure.requestId).toBe("req-9");
  });
});

describe("resolveLocationEntry", () => {
  it("asks the one documented resolution endpoint and nothing else", async () => {
    const resolveLocation = vi.fn(async () => RESOLVED);
    const resolution = await resolveLocationEntry(
      { resolveLocation } as unknown as ApiClient,
      "  Reykjavik  ",
    );

    expect(resolveLocation).toHaveBeenCalledTimes(1);
    expect(resolveLocation).toHaveBeenCalledWith({ query: "Reykjavik" });
    expect(resolution.kind).toBe("resolved");
  });

  it("turns a thrown failure into a state rather than letting it escape", async () => {
    const resolveLocation = vi.fn(async () => {
      throw new ApiError(404, { code: "location_not_found", message: "No location matches that." });
    });
    const resolution = await resolveLocationEntry(
      { resolveLocation } as unknown as ApiClient,
      "Zzzz",
    );
    expect(resolution.kind).toBe("not-found");
  });
});

describe("the data gate", () => {
  it("blocks everything but a resolved place", () => {
    expect(blocksData(UNRESOLVED)).toBe(true);
    expect(blocksData({ kind: "resolving", query: "x" })).toBe(true);
    expect(blocksData(resolutionOf("Springfield", AMBIGUOUS))).toBe(true);
    expect(blocksData({ kind: "not-found", query: "x", message: "m" })).toBe(true);
    expect(
      blocksData(
        resolutionOfFailure("x", new ApiError(500, { code: "internal_error", message: "m" })),
      ),
    ).toBe(true);

    expect(blocksData(resolutionOf("Reykjavik", RESOLVED))).toBe(false);
  });

  it("says only the ambiguous state is waiting on a choice", () => {
    expect(awaitsChoice(resolutionOf("Springfield", AMBIGUOUS))).toBe(true);
    expect(awaitsChoice(resolutionOf("Reykjavik", RESOLVED))).toBe(false);
    expect(awaitsChoice({ kind: "not-found", query: "x", message: "m" })).toBe(false);
  });
});

describe("recording a place", () => {
  it("marks a candidate the person pressed as chosen, unchanged", () => {
    const resolution = chosenResolution("Springfield", MISSOURI);
    expect(resolution.kind).toBe("resolved");
    expect(resolvedLocation(resolution)).toBe(MISSOURI);
    expect(resolution.kind === "resolved" && resolution.chosen).toBe(true);
  });

  it("adopts an already-canonical place without marking it a choice", () => {
    const resolution = alreadyResolved(ILLINOIS);
    expect(resolvedLocation(resolution)).toBe(ILLINOIS);
    expect(resolution.kind === "resolved" && resolution.chosen).toBe(false);
    expect(resolution.kind === "resolved" && resolution.query).toBe("Springfield, Illinois, US");
  });
});

describe("candidates", () => {
  it("keys a candidate by where it is, so two candidates are never the same key", () => {
    expect(candidateKey(ILLINOIS)).not.toBe(candidateKey(MISSOURI));
    expect(candidateKey(ILLINOIS)).toBe("39.8017,-89.6437");
  });

  it("shows the region, country, coordinates and time zone the response supplied", () => {
    expect(candidateDetail(ILLINOIS)).toEqual([
      "Illinois, United States",
      "39.8017, -89.6437",
      "America/Chicago",
    ]);
  });

  it("fabricates nothing for a candidate the response described less fully", () => {
    const sparse = place({ region: null, country: null, country_code: null });
    expect(candidateDetail(sparse)).toEqual(["39.8017, -89.6437", "America/Chicago"]);
  });

  it("falls back to the country code when there is no region or country name", () => {
    const coded = place({ region: null, country: null, country_code: "US" });
    expect(candidateDetail(coded)[0]).toBe("US");
  });

  it("includes an elevation only when the response carried one", () => {
    expect(candidateDetail(place({ elevation_metres: 187.4 }))).toContain("187 m elevation");
    expect(candidateDetail(ILLINOIS).some((part) => part.includes("elevation"))).toBe(false);
  });
});
