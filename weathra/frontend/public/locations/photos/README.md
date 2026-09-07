# Committed location photographs

Tier 2 of the location-image chain (`lib/images/provider.server.ts`). Drop a licensed photograph
here as `<key>.jpg` — `.jpeg`, `.webp`, `.avif` and `.png` are also accepted — and both the product
and the fidelity fixtures will use it in place of the generated artwork, with no component change.

`<key>` is `locationKey(displayName)` from `lib/images/locations.ts`: the place name's first
segment, lower-cased, accents folded, non-letters collapsed to hyphens. `Berlin, Germany` →
`berlin.jpg`; `New York, USA` → `new-york.jpg`.

## Why this directory is empty

A city photograph carries a licence, and asserting that a particular file is cleared for the
owner's use is not a call an implementation pass gets to make. So nothing is committed here, and
the chain falls through to the artwork this repository draws itself. That is a working state, not a
broken one — every screen renders.

To get photographs onto the screens, either:

- **configure a provider** — `CITY_IMAGE_PROVIDER=pexels` with `PEXELS_API_KEY`, or
  `CITY_IMAGE_PROVIDER=unsplash` with `UNSPLASH_ACCESS_KEY`. These are secrets and are
  deliberately **not** documented in `.env.example`, whose invariant is that everything in it is
  public; `docs/city-imagery.md` is where the names and the server-side placement live. Or
- **commit files here**, and for the fidelity fixtures also add each key to
  `FIXTURE_PHOTO_MANIFEST` in `lib/fixtures/visily.ts`, so a capture stays deterministic.

## What the fixtures need

`docs/design/screens/01-dashboard.png` and `04-compare-cities.png` are the two artifacts built on
photography. The keys they use are `berlin`, `munich`, `tokyo`, `new-york` and `london`.
