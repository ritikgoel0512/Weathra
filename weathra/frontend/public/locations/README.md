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

## Replacing them with photographs

Drop `<slug>.jpg` in and change the extension in `LocationImage`. Landscape, at least 1600px wide,
and remember the component applies a dark scrim from the foot upward — the sky belongs in the top
third of the frame.
