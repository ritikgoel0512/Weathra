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

/* ---------------------------------------------------------------- wikimedia commons
 *
 * The keyless tier, and the reason a deployed Weathra can show a real photograph without anybody
 * signing up for anything.
 *
 * Pexels and Unsplash are both free, and both want a key. That made real city photography a
 * configuration step, and an unconfigured deployment — which is what production has been — fell
 * straight through to drawn artwork. The fidelity review of 2026-09-11 called that what it is: a
 * functional fallback that does not look like the approved screen.
 *
 * Wikimedia's action API needs no credential and no account, and it carries the two things that
 * make using an image lawful rather than convenient: the photographer's name and the licence, in
 * the file's own metadata. Both are read from the response and rendered on the image. Neither is
 * ever composed here, and a file whose metadata names no licence is refused rather than shown — an
 * unattributed photograph on a product screen is the one outcome worse than a drawing.
 *
 *   1. `prop=pageimages` on the English Wikipedia article named by the place's own locality gives
 *      the lead image, which for a city is its skyline or a montage of it.
 *   2. Where that article has no lead image, a search for the *whole* place name, taking the
 *      highest-ranked result whose title begins with the locality. See `searchLeadImage`.
 *   3. `prop=imageinfo&iiprop=extmetadata` on the file gives the artist, the licence and a
 *      thumbnail at a width this layout can use rather than the 5000-pixel original.
 *
 * Two requests per place per process — three where step 1 finds nothing — behind the same cache as
 * every other tier. Set `CITY_IMAGE_COMMONS=off` to skip it: a deployment that would rather show
 * artwork than reach a third party on a page load can, and the chain continues to the next tier.
 */

const COMMONS_ENDPOINT = "https://en.wikipedia.org/w/api.php";

/**
 * The identifier Wikimedia's terms of use ask an API client to send.
 *
 * A real contact is what the policy asks for; this names the project and the repository, which is
 * the honest version of that for an open-source application with no single operator.
 */
const COMMONS_AGENT = "Weathra/1.0 (weather briefing application; https://github.com/weathra)";

function commonsEnabled(): boolean {
  return (process.env.CITY_IMAGE_COMMONS ?? "").trim().toLowerCase() !== "off";
}

/** Wikimedia returns `extmetadata` values as HTML fragments. This is the plain text in them. */
function plainText(html: string | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * The photographer's name out of Commons' `Artist` field.
 *
 * The field is free-form wiki markup and a derived file carries its whole provenance chain in it:
 * Berlin's lead image returns "File:Museumsinsel Berlin Juli 2021 1 (cropped).jpg : Kasa Fue
 * derivative work: Georgfotoart". A credit line reading that is not a credit, so the chain is
 * reduced to the person it ends on — which is who made the file being shown — and a name too long
 * to be one is refused rather than truncated into something that misattributes.
 */
function artistName(html: string | undefined): string | null {
  const text = plainText(html);
  if (!text) return null;

  // The last link in a derivation chain is the author of the derived file, which is this one.
  const derived = text.split(/derivative work\s*:/i).at(-1)?.trim() ?? text;
  // A leading "File:… .jpg :" is the source file's title, not a person.
  const named = derived.replace(/^File:.*?\.(?:jpe?g|png|webp|svg)\s*:?\s*/i, "").trim();

  return named.length > 0 && named.length <= 120 ? named : null;
}

/** File types a hero band can actually display. A video or a PDF is not a photograph of a city. */
const COMMONS_IMAGE = /\.(jpe?g|png|webp)$/i;

interface CommonsExtMetadata {
  readonly [field: string]: { readonly value?: string } | undefined;
}

async function commonsJson(parameters: Record<string, string>): Promise<unknown | null> {
  const query = new URLSearchParams({ format: "json", formatversion: "2", ...parameters });
  const response = await fetch(`${COMMONS_ENDPOINT}?${query.toString()}`, {
    headers: { "user-agent": COMMONS_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  return response.ok ? ((await response.json()) as unknown) : null;
}

/**
 * A freely licensed photograph of a place, or null.
 *
 * Null for every ordinary disappointment: no article, an article with no lead image, a lead image
 * that is a map or a coat of arms in a format this cannot show, or metadata with no licence in it.
 * The caller treats all of them the same way — it moves to the next tier.
 */
/** A lead image this frame can actually draw, or null. Shared by both title strategies. */
function drawableSource(source: string | undefined): string | null {
  if (!source) return null;
  try {
    return COMMONS_IMAGE.test(new URL(source).pathname) ? source : null;
  } catch {
    return null;
  }
}

/**
 * The lead image of the article a locality names, where that article has one.
 *
 * The direct hit, and the one almost every place takes: "Berlin", "London", "Munich" and "Tokyo"
 * are each the title of their own city's article.
 */
async function exactLeadImage(place: string): Promise<string | null> {
  const page = (await commonsJson({
    action: "query",
    prop: "pageimages",
    piprop: "original",
    titles: place,
    redirects: "1",
  })) as { query?: { pages?: readonly { original?: { source?: string } }[] } } | null;

  return drawableSource(page?.query?.pages?.[0]?.original?.source);
}

/**
 * The lead image of the best-ranked article a *search* for the whole place name finds.
 *
 * **Why this step exists.** The article a locality names is not always the article about the
 * locality. "New York" is a broad-concept page with no lead image at all — the city is at "New York
 * City" — so the resolver's single attempt found nothing and every New Yorker got drawn artwork
 * while London, Berlin, Munich and Tokyo got photographs. That is not a New York problem; it is
 * every place whose bare name is ambiguous on Wikipedia, and a map of exceptions would be a map of
 * exceptions.
 *
 * So the fallback is the same question asked the way a person would ask it: search for the place as
 * the backend names it — locality, region, country — and take the first result that is *about* the
 * locality. Two filters decide that, and both are general:
 *
 * * **The title must begin with the locality.** This is what separates "New York City" and
 *   "Springfield, Illinois" from "Theme from New York, New York" and "University of Illinois
 *   Springfield", which is what an unfiltered search returns first.
 * * **The lead image must be a photograph this frame can draw.** A flag or a logo is an `.svg` and
 *   is refused by the same rule the direct path uses — which is also what stops "New York Giants"
 *   from ever being the answer.
 *
 * Results are taken in the search's own ranking (`index`), not in the order the object happens to
 * list them. Nothing here is specific to a city, a country or a naming convention.
 */
async function searchLeadImage(displayName: string, place: string): Promise<string | null> {
  const found = (await commonsJson({
    action: "query",
    generator: "search",
    gsrsearch: displayName,
    gsrlimit: "6",
    // Articles only: a category or a template is not a place.
    gsrnamespace: "0",
    prop: "pageimages",
    piprop: "original",
  })) as {
    query?: {
      pages?: readonly { index?: number; title?: string; original?: { source?: string } }[];
    };
  } | null;

  const ranked = [...(found?.query?.pages ?? [])].sort(
    (one, other) => (one.index ?? 99) - (other.index ?? 99),
  );
  const wanted = place.toLowerCase();

  for (const page of ranked) {
    if (!(page.title ?? "").toLowerCase().startsWith(wanted)) continue;
    const source = drawableSource(page.original?.source);
    if (source) return source;
  }
  return null;
}

async function fromCommons(displayName: string): Promise<ResolvedLocationImage | null> {
  const place = (displayName.split(",")[0] ?? displayName).trim();
  if (place.length === 0) return null;

  // The article the locality names, and — only where that has no lead image — a search for it.
  const original =
    (await exactLeadImage(place)) ?? (await searchLeadImage(displayName, place));
  if (!original) return null;

  // `…/commons/f/f7/Museumsinsel_Berlin.jpg` → `File:Museumsinsel Berlin.jpg`, which is the title
  // the metadata request takes. Decoded, because the path is percent-encoded and the title is not.
  const file = decodeURIComponent(new URL(original).pathname.split("/").pop() ?? "");
  if (file.length === 0) return null;

  const info = (await commonsJson({
    action: "query",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1600",
    titles: `File:${file.replace(/_/g, " ")}`,
  })) as {
    query?: {
      pages?: readonly {
        imageinfo?: readonly {
          thumburl?: string;
          thumbwidth?: number;
          thumbheight?: number;
          extmetadata?: CommonsExtMetadata;
        }[];
      }[];
    };
  } | null;

  const image = info?.query?.pages?.[0]?.imageinfo?.[0];
  const url = image?.thumburl;
  const metadata = image?.extmetadata;
  if (!url || !metadata) return null;

  /*
   * The licence decides whether this may be shown at all. Commons is overwhelmingly free, but it
   * does hold non-free files under exemptions, and "probably free" is not a standard to put a
   * third party's photograph on a product screen by. No licence named, no photograph.
   */
  const licence = plainText(metadata.LicenseShortName?.value);
  if (!licence || /fair use|non-free/i.test(licence)) return null;

  const artist = artistName(metadata.Artist?.value);
  const description = plainText(metadata.ImageDescription?.value);

  return {
    url,
    /*
     * The file's own description where it has one, because it describes what is actually in the
     * frame. Where it has none, this says a photograph of the place was found — which is what is
     * known, and no more.
     */
    description: description ?? `${displayName}, photographed`,
    source: "commons",
    // Only ever the metadata's own artist. A file that names none is credited to nobody rather
    // than to "Wikimedia Commons", which did not take the picture.
    credit: artist
      ? {
          name: artist,
          url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
          licence,
          licenceUrl: plainText(metadata.LicenseUrl?.value) ?? undefined,
        }
      : undefined,
    width: image.thumbwidth,
    height: image.thumbheight,
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

  /*
   * The keyless photograph, after the two curated tiers and before the drawing. A committed file
   * beats it because somebody chose that file for this place; a network lookup that nobody chose
   * is still a real photograph and is far better than artwork, which is the whole point of the
   * tier. See `fromCommons` for what it refuses.
   */
  if (commonsEnabled()) {
    try {
      const image = await fromCommons(displayName);
      if (image) {
        resolved.set(key, { at: Date.now(), image });
        return image;
      }
    } catch {
      // No article, no network, a slow response, a shape that changed. All the same here.
    }
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
