/**
 * The preference form's logic, away from its markup — task 21.6.
 *
 * Settings is a form over three durable preferences: the unit system, the default forecast horizon,
 * and the default location. `specs/memory` is specific about what that means, and each rule below
 * is one of its sentences rather than a convenience:
 *
 * **Nothing is inferred.** `updateFrom` sends only the fields the person actually changed. A form
 * that PUT all three on every save would record two choices somebody never made, and
 * "preferences SHALL NOT be inferred from behavior without an explicit choice" is exactly about the
 * difference between a value being *shown* and a value being *chosen*.
 *
 * **Clearing is a different request from setting.** The backend's update model distinguishes an
 * omitted field (leave it), a value (choose it) and a `clear_*` flag (back to the documented
 * default). Emptying the default-location control means the third, and expressing it any other way
 * would make "I no longer want a default" impossible to say.
 *
 * **A default is labelled as a default.** The backend reports, per field, whether the person chose
 * the value or Weathra assumed it. `sourceNote` is what puts that on screen, because a value shown
 * identically either way tells somebody they made a decision they never made.
 *
 * It marks only the values that are *not* the person's. The runtime fidelity audit of 2026-09-08
 * recorded "Your choice." under every control as finding 7.3, and it was three repetitions of the
 * unremarkable case crowding out the one that matters. The form states the rule once — an unmarked
 * control holds the person's own choice — so the distinction survives and only the exception is
 * printed. `PREFERENCE_SOURCE_RULE` is that sentence, kept here beside the notes it explains.
 *
 * The horizon bound is the backend's own — `PreferenceUpdate.forecast_horizon_days` is `ge=1, le=16`
 * — restated here so an out-of-range entry is refused before a request is spent on it, not instead
 * of the backend refusing it.
 */

import type { Location, PreferenceSource, PreferenceUpdate, PreferenceView, UnitSystem } from "@/lib/api/schema";
import { friendlyName, isSamePlace, placeKey, sendableName } from "@/lib/locations/place";

/* ---------------------------------------------------------------------- units */

export interface UnitOption {
  readonly value: UnitSystem;
  readonly label: string;
  /** The units themselves, so the choice is concrete rather than a word. */
  readonly detail: string;
}

/**
 * The two unit systems, with what each actually means.
 *
 * The artifact's own copy: "Metric (Celsius, km/h, mm)" and "Imperial (Fahrenheit, mph, in)". These
 * are the units the backend expresses figures in under each system, not a claim about anything the
 * frontend converts — nothing here converts a value.
 */
export const UNIT_OPTIONS: readonly UnitOption[] = [
  { value: "metric", label: "Metric", detail: "Celsius, km/h, mm" },
  { value: "imperial", label: "Imperial", detail: "Fahrenheit, mph, in" },
];

export function unitLabel(units: UnitSystem): string {
  return UNIT_OPTIONS.find((option) => option.value === units)?.label ?? units;
}

/* -------------------------------------------------------------------- horizon */

/** The backend's own bounds on `forecast_horizon_days`. */
export const MINIMUM_HORIZON_DAYS = 1;
export const MAXIMUM_HORIZON_DAYS = 16;

/** The horizons offered as choices. Any value within the bounds is still accepted. */
export const HORIZON_DAY_CHOICES: readonly number[] = [1, 3, 5, 7, 10, 14, 16];

/**
 * The horizons to offer, including whatever is currently set.
 *
 * A person whose stored horizon is 8 days must see 8 days selected rather than the control quietly
 * showing 7 and a save then changing a preference they did not touch.
 */
export function horizonChoicesFor(current: number): number[] {
  const choices = new Set<number>(HORIZON_DAY_CHOICES);
  if (Number.isInteger(current) && current >= MINIMUM_HORIZON_DAYS && current <= MAXIMUM_HORIZON_DAYS) {
    choices.add(current);
  }
  return [...choices].sort((left, right) => left - right);
}

export function horizonLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/* ---------------------------------------------------------------------- draft */

/**
 * The form's working copy of the preferences.
 *
 * `defaultLocation` holds the *location*, not its name, and that is the fix for a bug that made
 * every coordinate-saved place unusable as a default. A location resolved from coordinates is
 * called `"48.1374, 11.5755"` — the backend's own coordinate label, because Open-Meteo has no
 * reverse geocoding and `resolve_coordinates` always labels a place with its coordinates. Sending
 * that display name back as `default_location` asked the geocoder for a *city* of that name, and
 * it answered, correctly, "No location matches '48.1374, 11.5755'."
 *
 * Holding the location means the identity never has to survive a round trip through prose:
 * coordinates go back, and the backend re-resolves the same place — with its timezone and its
 * identifier — without consulting a name at all.
 */
export interface PreferenceDraft {
  readonly unitSystem: UnitSystem;
  readonly horizonDays: number;
  /** The chosen default location, or `null` for no default. */
  readonly defaultLocation: Location | null;
}

/** The draft a form opens with: exactly what the backend reports, with nothing filled in. */
export function draftFrom(view: PreferenceView): PreferenceDraft {
  return {
    unitSystem: view.unit_system,
    horizonDays: view.forecast_horizon_days,
    defaultLocation: view.default_location ?? null,
  };
}

/** Whether the draft differs from what is stored. */
export function isDirty(draft: PreferenceDraft, view: PreferenceView): boolean {
  const stored = draftFrom(view);
  return (
    draft.unitSystem !== stored.unitSystem ||
    draft.horizonDays !== stored.horizonDays ||
    !samePlaceOrBothUnset(draft.defaultLocation, stored.defaultLocation)
  );
}

/** Two default-location choices being the same decision, including "no default" twice over. */
function samePlaceOrBothUnset(left: Location | null, right: Location | null): boolean {
  if (left === null || right === null) return left === right;
  return isSamePlace(left, right);
}

/**
 * The update to send, carrying only what changed — or `null` when nothing did.
 *
 * `null` is the whole point: a save with nothing to save makes no request, so the person is never
 * told a preference was recorded when none was.
 */
export function updateFrom(draft: PreferenceDraft, view: PreferenceView): PreferenceUpdate | null {
  const stored = draftFrom(view);
  const update: {
    unit_system?: UnitSystem;
    forecast_horizon_days?: number;
    default_location?: string;
    latitude?: number;
    longitude?: number;
    clear_default_location?: boolean;
  } = {};

  if (draft.unitSystem !== stored.unitSystem) update.unit_system = draft.unitSystem;
  if (draft.horizonDays !== stored.horizonDays) update.forecast_horizon_days = draft.horizonDays;

  if (!samePlaceOrBothUnset(draft.defaultLocation, stored.defaultLocation)) {
    if (draft.defaultLocation === null) update.clear_default_location = true;
    else {
      // The coordinates always, and the name when the place has one. The coordinates pin which
      // candidate this is, so no ambiguity reappears; the name is what the backend can then store,
      // because a stored default is read back as a place name later and coordinates alone cannot
      // produce one — which is how a default came to read "48.1374, 11.5755".
      //
      // A coordinate-named place sends no name at all, which is the earlier fix on this line kept
      // intact: sending "48.1374, 11.5755" as a name asks the backend to geocode a city that does
      // not exist.
      const name = sendableName(draft.defaultLocation);
      if (name !== null) update.default_location = name;
      update.latitude = draft.defaultLocation.latitude;
      update.longitude = draft.defaultLocation.longitude;
    }
  }

  return Object.keys(update).length === 0 ? null : update;
}

/** Why a horizon cannot be sent, or null when it can. */
export function horizonError(days: number): string | null {
  if (!Number.isInteger(days)) return "Choose a whole number of days.";
  if (days < MINIMUM_HORIZON_DAYS || days > MAXIMUM_HORIZON_DAYS) {
    return `Weathra's forecast horizon runs from ${MINIMUM_HORIZON_DAYS} to ${MAXIMUM_HORIZON_DAYS} days.`;
  }
  return null;
}

/* -------------------------------------------------------------------- sources */

/** Whether the person chose this field's value or Weathra applied its documented default. */
export function sourceOf(view: PreferenceView, field: string): PreferenceSource | null {
  const source = view.sources?.[field];
  return source === "chosen" || source === "default" ? source : null;
}

/**
 * The rule the form states once, so an unmarked control is not an unexplained one.
 *
 * Load-bearing: without it, "no note" would be indistinguishable from "Weathra did not say", and
 * the guarantee `specs/memory` asks for is precisely that the two are never confused.
 */
export const PREFERENCE_SOURCE_RULE =
  "Each control below holds your own choice unless it says otherwise.";

/**
 * The sentence a field carries so a default is never mistaken for a decision, or `null` where the
 * value is the person's own and `PREFERENCE_SOURCE_RULE` has already said so.
 */
export function sourceNote(source: PreferenceSource | null): string | null {
  if (source === "chosen") return null;
  if (source === "default") return "Weathra's documented default — you have not chosen this.";
  return "Weathra did not report whether this is your choice or its default.";
}

/**
 * The saved locations offered as the default, with the stored default included.
 *
 * A default that is not among the saved locations is still the default, and dropping it from the
 * list would make opening Settings and saving anything silently clear it.
 */
export function defaultLocationChoices(
  saved: readonly Location[],
  current: Location | null | undefined,
): { value: string; label: string; location: Location }[] {
  const seen = new Set<string>();
  const choices: { value: string; label: string; location: Location }[] = [];

  for (const place of [...(current ? [current] : []), ...saved]) {
    // Keyed by where the place is, not by what it is called: two saved places can share a
    // display name, and a place whose only name is its coordinates has no other key. This is the
    // same identity the backend derives `Location.identifier` from.
    const value = placeKey(place);
    if (seen.has(value)) continue;
    seen.add(value);
    // Named for a person: the choice reads "Berlin, Germany", not the geocoder's round-trip form.
    choices.push({ value, label: friendlyName(place), location: place });
  }
  return choices;
}

/** The choice a select's value names, or null for "no default". */
export function choiceFor(
  choices: readonly { value: string; location: Location }[],
  value: string,
): Location | null {
  return choices.find((choice) => choice.value === value)?.location ?? null;
}
