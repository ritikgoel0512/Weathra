/**
 * The location-image model: what a resolved image is, and how a place becomes a stable key.
 *
 * Shared by the client component and the server provider, so it holds no secret and imports
 * nothing server-only. The provider itself is `provider.server.ts`.
 */

import { atmosphereFor } from "./atmosphere";

/** How the image on screen was obtained. Reported so a reviewer is never guessing. */
export type LocationImageSource =
  /** A photograph from the configured third-party provider. */
  | "provider"
  /** A photograph committed to `public/locations/photos/`, used when no provider is configured. */
  | "local"
  /**
   * A freely licensed photograph from Wikimedia Commons, resolved without any credential.
   *
   * Its own tier rather than `provider` because the licence obliges us differently: Commons files
   * are CC-BY or CC-BY-SA far more often than not, so the photographer's name and the licence are
   * rendered on the image. Both come from the file's own metadata — neither is ever composed here.
   */
  | "commons"
  /** The deterministic artwork this repository draws. Always available. */
  | "generated";

export interface ResolvedLocationImage {
  /** Where the browser fetches the image from. */
  readonly url: string;
  /**
   * What the image actually shows, for the `alt` text.
   *
   * Deliberately not "a photo of Berlin": a provider result is a photograph *someone took* in or
   * near a place, and the generated fallback is not a photograph of anywhere. Each source describes
   * itself honestly, because an `alt` that overclaims is a small lie in an accessible name.
   */
  readonly description: string;
  readonly source: LocationImageSource;
  /**
   * Who took it, when the source says, and under what licence.
   *
   * Every field is the source's own: a photographer's name is what the provider or the file's
   * metadata returned, and `licence` is the licence that metadata names. Nothing here is inferred
   * from anything else — an image whose source named no photographer carries no credit at all,
   * which is the only honest rendering of "we do not know".
   */
  readonly credit?: {
    readonly name: string;
    readonly url?: string;
    /** `CC BY-SA 4.0`, as the file's own metadata states it. Never assumed from the host. */
    readonly licence?: string;
    readonly licenceUrl?: string;
  };
  /** Native pixel size, when known. Lets a caller size an `<img>` and avoid a reflow. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * The stable key for a place.
 *
 * Everything downstream — the local photo lookup, the generated artwork's filename, the provider
 * cache — is keyed on this, so the same place resolves to the same image on every render, every
 * machine and every capture. Derived from the name's first segment only: the backend's
 * `display_name` carries a country that varies with the resolver's locale, and keying on it would
 * make "Berlin, Germany" and "Berlin, DE" two different places.
 */
export function locationKey(displayName: string): string {
  const head = displayName.split(",")[0] ?? displayName;
  return head
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The places whose hand-drawn artwork exists in `public/locations/`.
 *
 * These are *preferred* over the procedural drawing, not required by it: a place not listed here
 * gets an atmosphere drawn from its own name rather than a shared `generic.svg`. Kept in step with
 * `CITIES` in `scripts/generate-location-art.mjs` by `lib/images/locations.test.ts`, which reads
 * both rather than trusting this comment.
 */
export const DRAWN_LOCATIONS: ReadonlySet<string> = new Set([
  "berlin",
  "munich",
  "hamburg",
  "tokyo",
  "london",
  "new-york",
  "paris",
  "springfield",
]);

/**
 * The generated artwork for a place. The last resort, and the one that cannot fail.
 *
 * Two tiers inside this one. A place with hand-drawn artwork committed for it gets that, because
 * it is better than anything derived from a string. Everything else gets an atmosphere drawn from
 * the place's own key — see `atmosphere.ts`.
 *
 * **What that replaced, and why.** Every unlisted place used to get `generic.svg`: one identical
 * drawing shared by Lisbon, Osaka, Nairobi and Reykjavík alike. Weathra resolves any location
 * Open-Meteo can geocode, so "unlisted" is the normal case for a real customer, and a hero band
 * repeating one stock picture across every place they save reads as a missing asset rather than as
 * a deliberate fallback. The procedural drawing is per-place, deterministic, needs no credential
 * and needs no asset committed for it.
 *
 * `generic.svg` stays on disk as the `<img>`'s own `onerror` target — the one case a data URI
 * cannot cover is a browser that refuses to render it.
 */
export function generatedImageFor(displayName: string): ResolvedLocationImage {
  const key = locationKey(displayName);
  const url = DRAWN_LOCATIONS.has(key) ? `/locations/${key}.svg` : atmosphereFor(key).url;
  return {
    url,
    // Says what it is. It is not a photograph and does not claim to depict this place.
    description: `${displayName}, shown as generated decorative artwork`,
    source: "generated",
  };
}

/** The endpoint the client asks. One place, so no component holds a provider URL. */
export const LOCATION_IMAGE_ENDPOINT = "/api/location-image";

/** The query the endpoint takes. */
export function locationImageQuery(displayName: string): string {
  return `${LOCATION_IMAGE_ENDPOINT}?place=${encodeURIComponent(displayName)}`;
}
