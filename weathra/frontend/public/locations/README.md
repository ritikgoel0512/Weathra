# Location artwork

`01-dashboard.png` opens on a photographic hero, and `04-compare-cities.png` gives each compared
city a photographic banner. `components/ui/location-image.tsx` renders those regions, and the files
here are what it draws.

## These are generated, not photographs

Every `.svg` here is produced by `scripts/generate-location-art.mjs` and committed:

    node scripts/generate-location-art.mjs

It draws each one from scratch — a sky gradient, an atmospheric glow, three layers of skyline
massing with lit windows, and a haze band. There is no third-party material in this directory and
nothing was downloaded, because a photograph carries a licence and choosing one on the repository
owner's behalf is not a decision an implementation pass should make silently.

Output is deterministic: every value derives from a hash of the city's name, so the same place
produces the same skyline on every machine and regenerating leaves no diff.

## What they are, and are not

- **Decorative.** The skylines are generic massing, not depictions of real buildings. `LocationImage`
  labels them as generated artwork rather than describing a photographed scene.
- **Free of measurements.** No asset encodes a temperature, a condition or any other figure. Every
  number on these screens is text drawn from the backend over the top, where the provenance
  machinery can label it.

## Adding a place

Add a `{ slug, name }` entry to `CITIES` in the generator and re-run it, then add the slug to
`DRAWN` in `components/ui/location-image.tsx`. The slug must match what `slugForLocation()` produces
from the backend's canonical name — `Berlin, Germany` → `berlin`.

Any location without its own file falls back to `generic.svg`, and if that fails to load the
component paints a token-built atmospheric field. The region is never empty.

## Where a real photograph comes from

As of **2026-09-11** the artwork here is the *last* of four tiers rather than the usual outcome.
`lib/images/provider.server.ts` walks them in order and always answers:

1. **A configured provider** — Pexels or Unsplash, if `CITY_IMAGE_PROVIDER` and its key are set.
   Both are free and both want an account, which is why they are not the only route.
2. **A photograph committed here**, under `photos/<slug>.<jpg|jpeg|webp|avif|png>`. A deliberate
   choice for a particular place beats anything looked up, so this tier sits above the next one.
3. **Wikimedia Commons**, with no credential of any kind. The English Wikipedia article's lead image
   for the place, through the action API, with the photographer and the licence read out of the
   file's own metadata and rendered in the corner of the hero. A file whose metadata names no
   licence is refused rather than shown. Set `CITY_IMAGE_COMMONS=off` to skip this tier.
4. **The artwork in this directory**, which needs nothing and cannot fail.

Tier 3 is what changed the Dashboard from a drawing to a photograph in an unconfigured deployment,
which is what the customer-level fidelity review of 2026-09-11 asked for. It is also the tier that
carries an obligation: CC-BY and CC-BY-SA are the common Commons licences, and the credit line the
component renders is how that obligation is met. Neither the photographer's name nor the licence is
ever composed in code — both come back from the API or the photograph is not used.

## Replacing the artwork with your own photograph

Drop `<slug>.jpg` into `photos/`. Landscape, at least 1600px wide, and remember the component
applies a dark scrim from the foot upward — the sky belongs in the top third of the frame.
