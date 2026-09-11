/**
 * Naming a resolved place, the way the backend names it — task 21.6.
 *
 * Two screens need this and they must agree. Saved Locations shows a person their places, and
 * Settings has to *send one back* as the default: `PreferenceUpdate.default_location` is a place
 * name that the backend resolves canonically before storing, because a preference holding raw query
 * text would silently change meaning when a geocoder's ranking changed.
 *
 * That makes the exact string matter. `display_name` alone is "Berlin" — and "Berlin" is ambiguous,
 * so sending it back could be refused for a place the person already has saved. The backend's own
 * `Location.qualified_name` appends whatever distinguishes it, and its geocoder reads the part after
 * the first comma as a region-and-country qualifier. So `qualifiedName` reproduces that shape
 * exactly: a location the backend produced round-trips to the same location.
 *
 * Nothing here invents a name. A location with no region and no country is its display name and
 * nothing more.
 */

import type { Location, SavedLocationRecord } from "@/lib/api/schema";

/**
 * The display name with whatever qualifies it: `Springfield, Illinois, US`.
 *
 * Mirrors `Location.qualified_name` in `weathra/domain/location.py` — display name, region, then
 * the country code in preference to the country, joined by commas.
 */
export function qualifiedName(location: Location): string {
  const parts = [location.display_name, location.region, location.country_code || location.country];
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/**
 * The name a person reads: `Berlin, Germany`, `Yamunanagar, Haryana, India`.
 *
 * Distinct from `qualifiedName`, and the two must not be confused. That one round-trips to the
 * geocoder, so it uses the country *code* and repeats the region even when the region is the city —
 * which is why a saved Berlin read "Berlin, Berlin, DE" on screen. This one is for reading: the
 * country is spelled out, and the region appears only when it says something the city does not.
 *
 * Nothing is invented. A place whose provider reported no country is its city, and a place with no
 * name at all is handled a level up by `savedLocationDisplay`.
 */
export function friendlyName(location: Location): string {
  const city = location.display_name?.trim() ?? "";
  const region = location.region?.trim() ?? "";
  const country = location.country?.trim() || location.country_code?.trim() || "";

  // A part the name already contains is not added again. Three redundancies are possible and all
  // three have been seen: a region that repeats the city (Berlin is in Berlin), a region equal to
  // the country, and a `display_name` that is already qualified — some geocoders return
  // "Berlin, Germany" where others return "Berlin", and appending the country to the first gives
  // "Berlin, Germany, Germany". Comparing against the parts already assembled covers all three.
  const parts = [city];
  const carries = (part: string): boolean =>
    parts.some((existing) => existing.toLowerCase().split(/,\s*/).includes(part.toLowerCase()));

  if (region && region !== country && !carries(region)) parts.push(region);
  if (country && !carries(country)) parts.push(country);

  return parts.join(", ");
}

/**
 * The name to show a customer for a place, wherever a place is named on screen.
 *
 * `friendlyName` spelled out, with one guard in front of it: a provider that reported no name for a
 * point gives back its coordinates as the `display_name`, and `48.1374, 11.5755` is a fact about a
 * pin rather than a name for a place. Showing it in an attribution line, a run's focus or a
 * comparison card reads as a developer's value leaking into the product.
 *
 * So a coordinate-named place is named `Unnamed place` here and its coordinates stay where they
 * belong — in the metadata the request carries. `savedLocationDisplay` does the same job for a
 * saved record, which additionally has a label the person may have typed; this one is for a place
 * that arrives inside a weather or agent response and has no label of its own.
 */
export function placeLabel(location: Location | null | undefined): string | null {
  if (!location) return null;
  const name = location.display_name?.trim() ?? "";
  if (name === "" || isCoordinateName(name)) return UNNAMED_PLACE;
  return friendlyName(location);
}

/**
 * The best name available for a place, given one the screen has already resolved.
 *
 * **The bug this exists to stop.** A screen resolves `Munich` once, gets back
 * `Munich, Bavaria, Germany`, and then makes every other request for that place by *coordinate* —
 * because a coordinate is unambiguous and re-sending a typed name would be asking the geocoder to
 * agree with itself. The backend, handed a coordinate, has no name to return: Open-Meteo geocodes
 * names to points and not the reverse, so it names the point after itself. Each card then derived
 * its own label from its own response, `placeLabel` correctly refused to print `48.1374, 11.5755`
 * as a name, and a Dashboard whose header said **Munich, Bavaria, Germany** carried cards reading
 * **Unnamed place**. Nothing was wrong with the data and nothing was wrong with `placeLabel`: the
 * identity was known by the caller and thrown away at the request boundary.
 *
 * So the name is resolved *here*, once, rather than re-derived per card. When a response names its
 * own place, that name wins — it is the one the data actually came with. When it does not, and the
 * place it describes is the one the screen resolved, the resolved name is used: identical
 * coordinates are the same place, which is the rule `placeKey` and the backend's saved-location
 * store already de-duplicate on. When the two are different places, `known` is ignored rather than
 * borrowed, because labelling one place with another's name is the confident wrong answer.
 *
 * This is deliberately not a backend change. The backend is not withholding the name; it does not
 * have one, and giving it one would mean either reverse-geocoding a point (which the provider
 * cannot do) or trusting a name the caller typed (which would let an ambiguous entry name a
 * coordinate it does not belong to).
 */
export function resolvedPlaceLabel(
  location: Location | null | undefined,
  known: Location | null | undefined,
): string | null {
  const own = placeLabel(location);
  if (own !== null && own !== UNNAMED_PLACE) return own;
  if (location && known && isSamePlace(location, known)) {
    const better = placeLabel(known);
    if (better !== null && better !== UNNAMED_PLACE) return better;
  }
  return own;
}

/**
 * A stable key for a place, from its coordinates.
 *
 * The same distinction the backend's saved-location store de-duplicates on: a place is where it is,
 * not how it was spelled. Used for React keys and for telling "this is already the default" from
 * "this is a different place with a similar name".
 */
export function placeKey(location: Location): string {
  return `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
}

/** Whether two resolved locations are the same place. */
export function isSamePlace(left: Location | null | undefined, right: Location | null | undefined): boolean {
  if (!left || !right) return false;
  return placeKey(left) === placeKey(right);
}

/** What a saved location is called: the person's own label, or the canonical name. */
export function savedLocationLabel(record: SavedLocationRecord): string {
  return record.label?.trim() || friendlyName(record.location);
}

/** What an unnamed place is called on screen, until somebody names it. */
export const UNNAMED_PLACE = "Unnamed place";

/**
 * Whether a saved place has no name a person would recognise.
 *
 * True only for a row with no label of its own *and* a canonical name that is its own coordinates.
 * Those rows exist because a save used to send coordinates alone and the backend names a point
 * after itself — Open-Meteo has no reverse-geocoding endpoint, so there was nothing else to call
 * it. New saves carry the resolved name; these are the ones already stored.
 *
 * They are not repaired automatically, and the reason is worth stating rather than leaving as an
 * omission: naming a point requires knowing what is near it, the geocoder resolves names to
 * coordinates and not the reverse, and the only name-shaped field a coordinate lookup returns is a
 * timezone — whose city can be a thousand kilometres away. Deriving "Kolkata" for a place in
 * Gurugram would be the confident wrong answer this refuses to give. So the person names it, and
 * the product asks rather than leaving a coordinate string as the name of somewhere they saved.
 */
export function isUnnamedPlace(record: SavedLocationRecord): boolean {
  const own = record.label?.trim() ?? "";
  return own === "" && isCoordinateName(record.location.display_name ?? "");
}

/**
 * What to show as a saved place's name, with an unnamed one said rather than shown as digits.
 *
 * The coordinates do not disappear — they stay on the card as what they are, which is metadata
 * about where the place is rather than what it is called.
 */
export function savedLocationDisplay(record: SavedLocationRecord): string {
  return isUnnamedPlace(record) ? UNNAMED_PLACE : savedLocationLabel(record);
}

/**
 * Whether a saved location matches what somebody typed into the filter.
 *
 * A filter over what is already on screen — it makes no request and resolves nothing. Matching is
 * case-insensitive across the label and every part of the canonical name, because somebody
 * filtering for "germany" means the country even though the card leads with the city.
 */
export function matchesFilter(record: SavedLocationRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  const haystack = [
    record.label,
    record.location.display_name,
    record.location.region,
    record.location.country,
    record.location.country_code,
    record.location.timezone,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .map((part) => part.toLowerCase());

  return haystack.some((part) => part.includes(needle));
}

/** Coordinates as text, at the precision the backend resolved them to. Never rounded up. */
export function coordinatesOf(location: Location): string {
  return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}

/**
 * Whether a place's only name is its own coordinates.
 *
 * The backend names a point after its latitude and longitude when it has nothing else to call it —
 * Open-Meteo has no reverse-geocoding endpoint, so `resolve_coordinates` produces `48.1374,
 * 11.5755`. That string is a name in the type and not one in the product, and the difference
 * decides what a save may send: a real name plus its coordinates lets the backend store the
 * canonical place, while sending *this* as a name asks it to geocode a city that does not exist.
 *
 * Matched on the shape the backend actually formats — two fixed-point numbers, comma-separated —
 * rather than on a flag, because the flag would have to survive every round trip through the API
 * and this does not have to survive anything.
 */
export function isCoordinateName(name: string): boolean {
  return /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(name);
}

/**
 * The name a save may send for a place, or null when it has none worth sending.
 *
 * `display_name` rather than `qualifiedName`: the backend resolves this through its geocoder's
 * search, which indexes the plain name, and the coordinates sent alongside are what choose between
 * that name's candidates. Null for a coordinate-named place, so the save falls back to the
 * coordinates-only path that has always worked for it.
 */
export function sendableName(location: Location): string | null {
  const name = location.display_name?.trim() ?? "";
  return name === "" || isCoordinateName(name) ? null : name;
}
