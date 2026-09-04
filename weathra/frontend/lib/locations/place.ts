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
  return record.label?.trim() || qualifiedName(record.location);
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
