# City imagery

The Dashboard hero (`docs/design/screens/01-dashboard.png`) and the Compare Cities banners
(`04-compare-cities.png`) are built on a photograph of the place they are showing. This is how that
photograph is obtained, and what happens when there isn't one.

Saved Locations (`06-saved-locations.png`) deliberately has **no** imagery — the approved artifact
draws typographic cards, and `components/ui/location-imagery.test.tsx` asserts that no imagery
appears there.

## The chain

One place, three tiers, first one that answers wins:

| Tier | Source | Needs |
| --- | --- | --- |
| 1 | A provider photograph, from Pexels or Unsplash | a credential (below) |
| 2 | A photograph committed to `frontend/public/locations/photos/<key>.jpg` | a licensed file |
| 3a | Hand-drawn artwork in `frontend/public/locations/<key>.svg`, for the eight places that have it | nothing |
| 3b | An atmosphere drawn from the place's own name, `frontend/lib/images/atmosphere.ts` | nothing |

Tier 3 cannot fail, so **every screen always renders**. A provider outage, a rate limit, a revoked
key, a place nobody has a photograph of — each falls through, and the layout does not move, because
every tier returns the same shape into a frame whose height is fixed by its aspect ratio before
anything loads.

### Tier 3b, and why it replaced one shared image

Tier 3 used to be the eight hand-drawn files plus `generic.svg` for everything else. That is a
reasonable demo of eight cities and the wrong shape for a product: Weathra resolves **any** location
Open-Meteo can geocode, so "not one of the eight" is the normal case for a real customer, and a hero
band repeating one stock drawing across every place they save reads as a missing asset rather than
as a deliberate fallback.

So an unlisted place now gets an atmosphere derived from its own key — a graded night sky, a horizon
glow, two depth-separated rows of buildings, lit windows, and a moon or stars, every one of them a
function of the name. Four properties, each asserted in `lib/images/atmosphere.test.ts`:

* **It always answers.** Any key, including an empty one.
* **It answers the same way twice.** Seeded only by the key — never the clock, never `Math.random`.
  This is what makes a capture of a hero band reproducible; a random drawing would make every
  screenshot differ from the last and none of them evidence.
* **It answers differently for different places.** Lisbon and Osaka are not the same picture.
* **It stays in the palette.** Eight hues from petrol to muted violet, so a screen of location cards
  reads as one set. The range stops short of magenta: the first version ran ten degrees further and
  gave São Paulo a hot pink sky.

It is a **data URI**, not a file: there is nothing to deploy, nothing to cache, and it renders on
the first paint with no request, which is what keeps the hero from flashing an empty frame. A file
per city would need a build step that enumerates cities, which is the problem this removes.

It is **decoration and says so**. No shape encodes a temperature, a condition or a real skyline —
the buildings are not Lisbon's buildings — and the `alt` text reads "shown as generated decorative
artwork". `generic.svg` stays on disk as the `<img>`'s own `onerror` target, for the one case a data
URI cannot cover: a browser that refuses to render it.

`<key>` is `locationKey(displayName)` from `frontend/lib/images/locations.ts`: the place name's
first segment, lower-cased, accents folded, non-letters collapsed to hyphens. `Berlin, Germany` →
`berlin`. Keying on the first segment only is deliberate — the resolver's country suffix varies with
locale, and keying on the whole string would make `Berlin, Germany` and `Berlin, DE` two places.

## Configuring a provider

Both supported providers authenticate with a secret. Set these in the **frontend deployment's
injected server environment** — Vercel's project environment variables (the route handler that reads
them runs server-side, not in the browser) — or a shell export for local work:

```
CITY_IMAGE_PROVIDER=pexels        # or `unsplash`, or unset for no provider
PEXELS_API_KEY=…                  # when pexels
UNSPLASH_ACCESS_KEY=…             # when unsplash
```

Unset is a supported configuration, not a broken one: the chain simply starts at tier 2.

### Not in a `frontend/.env*` file, including `.env.local`

`scripts/secret-containment.ts` names both keys in `SECRET_NAMES`, so either one written into any
`frontend/.env*` file is a containment **failure**, not a warning — and so is either one carrying a
`NEXT_PUBLIC_` prefix. That is deliberate. `.env.local` is gitignored today, but a secret in a
dotfile inside a public repository is one `git add -f` away from being published, and the frontend
environment's whole invariant is that it holds nothing that would matter if it leaked.

An injected deployment variable is not a file, so it is never scanned. For local work, export it
for the one command that needs it:

```
CITY_IMAGE_PROVIDER=pexels PEXELS_API_KEY=… npm run dev
```

`CITY_IMAGE_PROVIDER` on its own is not a secret — it is a provider name — but it is only useful
alongside a key, so it is set the same way.

### Why these are not in `.env.example`

`frontend/.env.example` documents the frontend environment, and that file's invariant is that
everything in it is public — a `NEXT_PUBLIC_` value ships in the browser bundle, so the file is
written on the assumption that anything named there may as well be. `PEXELS_API_KEY` is a secret,
so documenting it there would be wrong, and `scripts/secret-containment.ts` now names it outright:
adding it to that file fails the check rather than merely warning. That check is doing its job;
this file is where the names live instead.

### Why they may never be `NEXT_PUBLIC_`

A `NEXT_PUBLIC_` variable is inlined into the client bundle. A provider key there would be readable
by every visitor and usable until it was rotated. Three things keep that from happening:

1. **`frontend/lib/images/provider.server.ts` refuses to load in a browser.** It throws at module
   load if `window` exists, so an accidental import from a client component fails loudly on first
   render rather than shipping a key-shaped string. (Next's usual instrument here is
   `import "server-only"`, which would make it a *build* error instead — strictly better, and not
   used because that package is not a dependency of this project.)
2. **`scripts/secret-containment.test.ts`** fails the build if either key's value appears in client
   output. That checks the outcome rather than the intent.
3. **`frontend/lib/images/provider.test.ts`** greps the frontend and asserts no file other than the
   server module and its own test names either variable.

The browser never talks to the provider. It asks `frontend/app/api/location-image/route.ts`, which
asks the server module, and receives a resolved URL plus a description — never the key, never the
provider's endpoint.

## Committing photographs instead

Drop licensed files into `frontend/public/locations/photos/` as `<key>.jpg` (`.jpeg`, `.webp`,
`.avif` and `.png` also work). Nothing else is needed for the product.

For the **fidelity fixtures** also add each key to `FIXTURE_PHOTO_MANIFEST` in
`frontend/lib/fixtures/visily.ts`. `lib/images/locations.test.ts` asserts that manifest and that
directory agree, so a claimed photograph that is not committed fails rather than silently 404ing
during a capture.

That directory is empty in this repository. A city photograph carries a licence, and asserting a
particular file is cleared for the owner's use is not a call an implementation pass gets to make —
so the chain falls through to the artwork, which is originated here and carries no licence
question. The consequence is worth stating plainly: **until a provider is configured or files are
committed, the Dashboard hero and the Compare banners show generated artwork, not photography.**

## Determinism

A screenshot comparison is worthless if the picture changes between runs.

- **Fixture mode resolves nothing.** `LocationImage` reads a fixed table and stops, so a capture run
  makes no third-party request and works offline. The five cities the approved screens need —
  `berlin`, `munich`, `tokyo`, `new-york`, `london` — are all in it.
- **The provider's result is chosen, not taken.** Results are sorted by a stable id and indexed by a
  hash of the place's key, so the same place gets the same photograph from the same result set even
  if the provider reorders them. Taking `results[0]` would give a different picture on a different
  day.
- **One request per place per process.** The resolved answer is cached in memory for six hours. No
  Supabase persistence — that is deliberately out of scope.

## Caching

In-process, in `provider.server.ts`, plus `cache-control: public, max-age=3600,
stale-while-revalidate=86400` on the endpoint. So a hero renders from one provider request rather
than one per viewer, and a capture over four viewport widths is one request per place rather than
four.

## Adding a screen that needs imagery

Use `LocationImage`. It is the only component that decides where a location's image comes from, and
`components/ui/location-imagery.test.tsx` asserts that no screen writes a city URL of its own.

```tsx
<LocationImage
  displayName={location.display_name}
  latitude={location.latitude}
  longitude={location.longitude}
  variant="hero"        // or "banner"
  scrim="strong"        // "soft" where the image should read through
>
  {/* whatever sits on the image */}
</LocationImage>
```

It handles the loading state, the error fallback, the scrim, the accessible alt text, and the fixed
aspect ratio that keeps the layout from shifting. The `alt` text describes whichever tier actually
answered — a provider photograph as photographed, the generated artwork as generated artwork —
because an `alt` reading "Berlin at dusk" over a drawing is a small lie told to exactly the people
who cannot check it.
