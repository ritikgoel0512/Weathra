/**
 * The city-image provider — server-only, because the credential is a secret.
 *
 * # The chain
 *
 * A place resolves through three tiers, in order, and the first one that answers wins:
 *
 *   1. **provider** — a photograph from Pexels or Unsplash, if a key is configured.
 *   2. **local** — a photograph committed under `public/locations/photos/<key>.jpg`, if one is.
 *   3. **generated** — the artwork `scripts/generate-location-art.mjs` draws. Always present.
 *
 * The last tier cannot fail, so the screen always renders. A provider outage, a rate limit, a
 * revoked key, a place nobody has a photograph of — each falls through to the next tier and the
 * layout does not move, because every tier returns the same shape into the same fixed frame.
 *
 * # Why this is server-only, and how that is enforced
 *
 * Three things, of decreasing strength, because no one of them is enough on its own:
 *
 *   1. **A load-time guard.** The `assertServer()` call below throws the moment this module is
 *      evaluated anywhere with a `window`. Next's usual instrument here is `import "server-only"`,
 *      which turns a client import into a *build* error rather than a runtime one — strictly
 *      better, and not used, because that package is not a dependency of this project and adding
 *      one to buy a guard this file can write in four lines is not a trade worth making. The
 *      difference is honest and worth knowing: a mistake surfaces here on first render rather than
 *      at build time.
 *   2. **A bundle assertion.** `scripts/secret-containment.test.ts` fails the build if either key's
 *      value appears in client output. That checks the outcome rather than the intent.
 *   3. **A test that this is the only reader.** `provider.test.ts` greps the frontend and asserts
 *      no other file names either key.
 *
 * The eslint exemption that lets this file read a non-public variable is a promise; those three are
 * enforcement. The browser never sees the key, never sees the provider's endpoint, and never talks
 * to the provider — it asks `app/api/location-image/route.ts`, which asks this.
 *
 * Both supported providers require a secret. Neither key may be given a `NEXT_PUBLIC_` name; the
 * bundle assertion in `scripts/secret-containment.test.ts` fails the build if either string appears
 * in client output.
 *
 * # Configuration
 *
 *     CITY_IMAGE_PROVIDER=pexels        # or `unsplash`, or unset/`none` for no provider
 *     PEXELS_API_KEY=…                  # when pexels
 *     UNSPLASH_ACCESS_KEY=…             # when unsplash
 *
 * Unset is a supported configuration, not a broken one: the chain simply starts at tier 2.
 *
 * # Determinism
 *
 * A screenshot comparison is worthless if the picture changes between runs, so the provider's
 * result is *chosen*, not taken. The query is fixed per place, the results are sorted by id, and
 * the selection is an index derived from a hash of the place's own key — so the same place gets the
 * same photograph from the same result set every time. See `pick()`.
 */

import {
  DRAWN_LOCATIONS,
  generatedImageFor,
  locationKey,
  type ResolvedLocationImage,
} from "./locations";

/* ---------------------------------------------------------------- the boundary */

/**
 * Refuse to exist in a browser.
 *
 * Evaluated once, at module load, so an accidental import from a client component fails on first
 * render with a message that names the cause — rather than shipping a key-shaped string into a
 * bundle and being discovered later.
 */
function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "lib/images/provider.server.ts is server-only and was imported into the browser. " +
        "Client code should call /api/location-image instead — see components/ui/location-image.tsx.",
    );
  }
}

assertServer();

/* ---------------------------------------------------------------- configuration */

type ProviderName = "pexels" | "unsplash" | "none";

function providerName(): ProviderName {
  const configured = (process.env.CITY_IMAGE_PROVIDER ?? "").trim().toLowerCase();
  if (configured === "pexels" || configured === "unsplash") return configured;
  return "none";
}

function credential(provider: ProviderName): string | null {
  const key =
    provider === "pexels"
      ? process.env.PEXELS_API_KEY
      : provider === "unsplash"
        ? process.env.UNSPLASH_ACCESS_KEY
        : undefined;
  const trimmed = key?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether a provider is usable at all.
 *
 * Exported so the route handler can answer "why am I looking at artwork?" without a network call,
 * and so a test can assert the no-credential path without unsetting anything globally.
 */
export function providerConfigured(): boolean {
  const provider = providerName();
  return provider !== "none" && credential(provider) !== null;
}

/* ---------------------------------------------------------------- local photographs
 *
 * `public/locations/photos/<key>.jpg` is checked at request time rather than at import, because a
 * photograph may be added to the directory without restarting anything. The result is remembered,
 * so it is one `stat` per place per process rather than one per render.
 */

const localChecked = new Map<string, ResolvedLocationImage | null>();

async function localPhoto(key: string, displayName: string): Promise<ResolvedLocationImage | null> {
  const remembered = localChecked.get(key);
  if (remembered !== undefined) return remembered;

  let found: ResolvedLocationImage | null = null;
  try {
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const extension of ["jpg", "jpeg", "webp", "avif", "png"]) {
      const relative = `locations/photos/${key}.${extension}`;
      try {
        await access(join(process.cwd(), "public", relative));
        found = {
          url: `/${relative}`,
          description: `${displayName}, photographed`,
          source: "local",
        };
        break;
      } catch {
        // Not this extension. Try the next.
      }
    }
  } catch {
    // No filesystem (an edge runtime, say). Tier 2 is simply unavailable there.
    found = null;
  }

  localChecked.set(key, found);
  return found;
}

/* ---------------------------------------------------------------- deterministic selection */

/** The same small hash the artwork generator uses, so a place's choices agree across the codebase. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/**
 * Choose one result, reproducibly.
 *
 * Sorting first is the part that matters: a provider is free to return the same photographs in a
 * different order, and taking `results[0]` would then give a different picture on a different day.
 * Sorted by a stable id and indexed by a hash of the place, the choice is a pure function of the
 * place and the result *set*.
 */
function pick<T extends { id: string }>(results: readonly T[], key: string): T | null {
  if (results.length === 0) return null;
  const ordered = [...results].sort((one, other) => one.id.localeCompare(other.id));
  return ordered[hash(key) % ordered.length] ?? null;
}

/* ---------------------------------------------------------------- the providers */

/** How long a resolved result is trusted. Long, because a city's photograph is not news. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  readonly at: number;
  readonly image: ResolvedLocationImage;
}

/**
 * The in-process cache.
 *
 * Deliberately in memory and deliberately not in Supabase — this task does not persist images.
 * It exists so that rendering the Dashboard twice is one provider request, not two, and so that a
 * capture run over four viewport widths is one request per place rather than four.
 */
const resolved = new Map<string, CacheEntry>();

async function fromPexels(
  key: string,
  displayName: string,
  token: string,
): Promise<ResolvedLocationImage | null> {
  const place = displayName.split(",")[0] ?? displayName;
  const query = encodeURIComponent(`${place} city skyline`);
  const response = await fetch(
    `https://api.pexels.com/v1/search?query=${query}&orientation=landscape&per_page=15`,
    { headers: { Authorization: token }, signal: AbortSignal.timeout(6000) },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as {
    photos?: readonly {
      id: number;
      alt?: string;
      photographer?: string;
      photographer_url?: string;
      width?: number;
      height?: number;
      src?: { landscape?: string; large2x?: string; large?: string };
    }[];
  };

  const chosen = pick(
    (body.photos ?? []).map((photo) => ({ ...photo, id: String(photo.id) })),
    key,
  );
  const url = chosen?.src?.large2x ?? chosen?.src?.landscape ?? chosen?.src?.large;
  if (!chosen || !url) return null;

  return {
    url,
    description: chosen.alt?.trim() || `${displayName}, photographed`,
    source: "provider",
    credit: chosen.photographer
      ? { name: chosen.photographer, url: chosen.photographer_url }
      : undefined,
    width: chosen.width,
    height: chosen.height,
  };
}

async function fromUnsplash(
  key: string,
  displayName: string,
  token: string,
): Promise<ResolvedLocationImage | null> {
  const place = displayName.split(",")[0] ?? displayName;
  const query = encodeURIComponent(`${place} city skyline`);
  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${query}&orientation=landscape&per_page=15`,
    {
      headers: { Authorization: `Client-ID ${token}` },
      signal: AbortSignal.timeout(6000),
    },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as {
    results?: readonly {
      id: string;
      alt_description?: string | null;
      width?: number;
      height?: number;
      urls?: { regular?: string; full?: string };
      user?: { name?: string; links?: { html?: string } };
    }[];
  };

  const chosen = pick(body.results ?? [], key);
  const url = chosen?.urls?.regular ?? chosen?.urls?.full;
  if (!chosen || !url) return null;

  return {
    url,
    description: chosen.alt_description?.trim() || `${displayName}, photographed`,
    source: "provider",
    // Unsplash's licence asks for the photographer to be credited.
    credit: chosen.user?.name
      ? { name: chosen.user.name, url: chosen.user.links?.html }
      : undefined,
    width: chosen.width,
    height: chosen.height,
  };
}

/* ---------------------------------------------------------------- the chain */

/**
 * Resolve one place to an image, through the whole chain.
 *
 * Never throws and never returns null: the generated tier is a local file this repository draws, so
 * there is always an answer. A provider failure is logged once at the boundary and then forgotten —
 * an image is not worth an error state on a weather screen.
 */
export async function resolveLocationImage(displayName: string): Promise<ResolvedLocationImage> {
  const key = locationKey(displayName);

  const cached = resolved.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.image;

  const provider = providerName();
  const token = credential(provider);

  if (provider !== "none" && token) {
    try {
      const image =
        provider === "pexels"
          ? await fromPexels(key, displayName, token)
          : await fromUnsplash(key, displayName, token);
      if (image) {
        resolved.set(key, { at: Date.now(), image });
        return image;
      }
    } catch {
      // Unreachable provider, timeout, rate limit, malformed body — all the same to the caller.
    }
  }

  const local = await localPhoto(key, displayName);
  if (local) {
    resolved.set(key, { at: Date.now(), image: local });
    return local;
  }

  const generated = generatedImageFor(displayName);
  // Cached too, so a place with no photograph does not re-walk the chain on every render.
  resolved.set(key, { at: Date.now(), image: generated });
  return generated;
}

/** Whether this place has artwork of its own, for the tests that keep the two lists in step. */
export function hasDrawnArtwork(displayName: string): boolean {
  return DRAWN_LOCATIONS.has(locationKey(displayName));
}

/** Clears the cache. Tests only — nothing in the application calls it. */
export function resetLocationImageCache(): void {
  resolved.clear();
  localChecked.clear();
}
