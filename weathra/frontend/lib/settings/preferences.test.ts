/**
 * The preference form's logic — task 21.6's verification of what a save actually sends.
 *
 * The assertions that matter here are about *absence*: that an untouched field is not in the
 * request, that a save with nothing to save is not a request at all, and that emptying the default
 * location is expressed as the clear flag rather than as an empty string. `specs/memory` forbids
 * persisting a preference the person did not explicitly choose, and a form that PUT all three
 * fields on every save would record two choices nobody made.
 */

import { describe, expect, it } from "vitest";

import type { Location, PreferenceView } from "@/lib/api/schema";

import {
  HORIZON_DAY_CHOICES,
  MAXIMUM_HORIZON_DAYS,
  UNIT_OPTIONS,
  defaultLocationChoices,
  draftFrom,
  horizonChoicesFor,
  horizonError,
  horizonLabel,
  isDirty,
  sourceNote,
  sourceOf,
  unitLabel,
  updateFrom,
} from "./preferences";

const BERLIN = {
  display_name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
  region: "Berlin",
  country: "Germany",
  country_code: "DE",
} as Location;

const TOKYO = {
  display_name: "Tokyo",
  latitude: 35.6895,
  longitude: 139.6917,
  timezone: "Asia/Tokyo",
  region: "Tokyo",
  country: "Japan",
  country_code: "JP",
} as Location;

function view(overrides: Partial<PreferenceView> = {}): PreferenceView {
  return {
    unit_system: "metric",
    forecast_horizon_days: 7,
    default_location: BERLIN,
    sources: { unit_system: "chosen", forecast_horizon_days: "default", default_location: "chosen" },
    ...overrides,
  } as PreferenceView;
}

describe("draftFrom", () => {
  it("opens on exactly what the backend reports, with the default location canonically named", () => {
    expect(draftFrom(view())).toEqual({
      unitSystem: "metric",
      horizonDays: 7,
      defaultLocation: "Berlin, Berlin, DE",
    });
  });

  it("shows no default location as no default location, never as a placeholder", () => {
    expect(draftFrom(view({ default_location: null })).defaultLocation).toBe("");
  });
});

describe("updateFrom", () => {
  it("is null when nothing changed, so a save with nothing to save makes no request", () => {
    expect(updateFrom(draftFrom(view()), view())).toBeNull();
  });

  it("carries only the field that changed", () => {
    const draft = { ...draftFrom(view()), unitSystem: "imperial" as const };
    expect(updateFrom(draft, view())).toEqual({ unit_system: "imperial" });
  });

  it("carries the horizon alone when only the horizon changed", () => {
    const draft = { ...draftFrom(view()), horizonDays: 10 };
    expect(updateFrom(draft, view())).toEqual({ forecast_horizon_days: 10 });
  });

  it("sends the canonical name when the default location changed", () => {
    const draft = { ...draftFrom(view()), defaultLocation: "Tokyo, Tokyo, JP" };
    expect(updateFrom(draft, view())).toEqual({ default_location: "Tokyo, Tokyo, JP" });
  });

  it("expresses removing the default as the clear flag, not as an empty name", () => {
    const draft = { ...draftFrom(view()), defaultLocation: "" };
    expect(updateFrom(draft, view())).toEqual({ clear_default_location: true });
  });

  it("carries every field that changed, and none that did not", () => {
    const draft = { unitSystem: "imperial" as const, horizonDays: 3, defaultLocation: "Tokyo, Tokyo, JP" };
    expect(updateFrom(draft, view())).toEqual({
      unit_system: "imperial",
      forecast_horizon_days: 3,
      default_location: "Tokyo, Tokyo, JP",
    });
  });

  it("ignores surrounding whitespace rather than treating it as a change", () => {
    const draft = { ...draftFrom(view()), defaultLocation: "  Berlin, Berlin, DE  " };
    expect(updateFrom(draft, view())).toBeNull();
  });
});

describe("isDirty", () => {
  it("is false for an untouched form and true for a changed one", () => {
    expect(isDirty(draftFrom(view()), view())).toBe(false);
    expect(isDirty({ ...draftFrom(view()), horizonDays: 5 }, view())).toBe(true);
  });
});

describe("horizonError", () => {
  it("accepts the backend's own range", () => {
    expect(horizonError(1)).toBeNull();
    expect(horizonError(MAXIMUM_HORIZON_DAYS)).toBeNull();
  });

  it("refuses a value the backend would refuse, naming the range", () => {
    expect(horizonError(0)).toMatch(/1 to 16 days/);
    expect(horizonError(17)).toMatch(/1 to 16 days/);
    expect(horizonError(2.5)).toBe("Choose a whole number of days.");
  });
});

describe("horizonChoicesFor", () => {
  it("offers the documented choices", () => {
    expect(horizonChoicesFor(7)).toEqual([...HORIZON_DAY_CHOICES]);
  });

  it("includes a stored horizon that is not one of them, so saving cannot change it silently", () => {
    expect(horizonChoicesFor(8)).toContain(8);
    expect(horizonChoicesFor(8)).toEqual([1, 3, 5, 7, 8, 10, 14, 16]);
  });

  it("does not offer a value outside the backend's range", () => {
    expect(horizonChoicesFor(40)).toEqual([...HORIZON_DAY_CHOICES]);
  });
});

describe("defaultLocationChoices", () => {
  it("offers the saved locations by their canonical names", () => {
    expect(defaultLocationChoices([BERLIN, TOKYO], null)).toEqual([
      { value: "Berlin, Berlin, DE", label: "Berlin, Berlin, DE" },
      { value: "Tokyo, Tokyo, JP", label: "Tokyo, Tokyo, JP" },
    ]);
  });

  it("keeps a stored default that is not among the saved places", () => {
    const choices = defaultLocationChoices([TOKYO], BERLIN);
    expect(choices.map((choice) => choice.value)).toEqual(["Berlin, Berlin, DE", "Tokyo, Tokyo, JP"]);
  });

  it("lists a place once when it is both saved and the default", () => {
    expect(defaultLocationChoices([BERLIN], BERLIN)).toHaveLength(1);
  });
});

describe("sources", () => {
  it("reports whether each value was chosen or assumed", () => {
    expect(sourceOf(view(), "unit_system")).toBe("chosen");
    expect(sourceOf(view(), "forecast_horizon_days")).toBe("default");
    expect(sourceOf(view(), "nothing_named_this")).toBeNull();
  });

  it("says plainly that a default is not a decision the person made", () => {
    expect(sourceNote("default")).toMatch(/you have not chosen this/i);
    expect(sourceNote("chosen")).toBe("Your choice.");
    expect(sourceNote(null)).toMatch(/did not report/i);
  });
});

describe("labels", () => {
  it("names both unit systems with the units they mean", () => {
    expect(UNIT_OPTIONS.map((option) => option.value)).toEqual(["metric", "imperial"]);
    expect(unitLabel("imperial")).toBe("Imperial");
    expect(UNIT_OPTIONS[0]?.detail).toBe("Celsius, km/h, mm");
  });

  it("says one day rather than 1 days", () => {
    expect(horizonLabel(1)).toBe("1 day");
    expect(horizonLabel(7)).toBe("7 days");
  });
});
