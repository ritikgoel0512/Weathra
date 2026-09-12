# The satellite observation source

Weathra's satellite capability retrieves **observational imagery**, not a forecast and not a
measurement. This document records which service it retrieves from, why that one, and what the
choice costs — so the next person can re-open the decision against evidence rather than taste.

## Chosen source

**NASA Global Imagery Browse Services (GIBS)**, `https://gibs.earthdata.nasa.gov`, through its
OGC **WMS** endpoint (`/wms/epsg4326/best/wms.cgi`).

Product: **`VIIRS_NOAA20_CorrectedReflectance_TrueColor`** — the corrected-reflectance true-colour
daily composite from the VIIRS instrument on NOAA-20, which is the standard near-real-time
observational imagery product and the one NASA Worldview itself opens on.

## Why

Four candidates were checked against the same questions — reachability without a credential,
coverage, freshness, metadata, format, licence, and whether programmatic use is maintainable.

| Candidate | Auth | Coverage | Freshness | Verdict |
|---|---|---|---|---|
| **NASA GIBS** | none | **global** | daily composite, ~3 h latency after an overpass | **chosen** |
| EUMETSAT EUMETView WMS | none | Europe, Africa, Atlantic | 15 min (geostationary) | runner-up — see below |
| EUMETSAT Data Store / Data Tailor | **API key** | Europe, Africa | 15 min | rejected: needs a new secret |
| NOAA NESDIS STAR image CDN | none | Americas only | 10 min | rejected: no Europe, no product metadata, static file naming rather than a service contract |

All four were probed for reachability from this deployment on 2026-09-12. GIBS returned its
WMTS capabilities document (HTTP 200, 5.3 MB) and EUMETView its WMS capabilities (HTTP 200,
282 KB); both are genuinely open. The NOAA CDN path redirected rather than serving.

**GIBS wins on coverage, and coverage is what decides it.** EUMETView is fresher over Europe —
fifteen minutes against roughly a day — and if Weathra were a Europe-only product it would be the
right answer. It is not: Weathra resolves any place a geocoder returns, and the saved-locations
fixture alone spans Berlin, London, Tokyo and New York. A capability that answers "not available"
for three of four demo cities is worse than a slower one that answers everywhere. GIBS advertises
`-180 -90` to `180 90` on this layer and returns imagery for all of them.

The secondary reasons: GIBS is an OGC service with a declared time dimension per layer, so "which
observation is this?" is answered by the contract rather than by parsing a filename; it publishes a
capabilities document that names every layer, its formats and its available dates; and it is a
long-lived NASA EOSDIS service rather than a convenience endpoint.

**Not chosen for how it looks.** True colour is the product a person can actually check a claim
against — cloud is visible in it — and it is the layer NASA documents as the near-real-time default.
Nothing here renders a false-colour composite because it is striking.

## Coverage

Global, on the chosen layer. The adapter requests a square bounding box centred on the resolved
location, so the observation covers the wider region around a place rather than a point — that is a
property of satellite imagery and is stated in the contract as `coverage_note` rather than implied.

## Data and product used

One `GetMap` request per observation:

```
GET /wms/epsg4326/best/wms.cgi
  ?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap
  &LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor
  &CRS=EPSG:4326&BBOX=<south,west,north,east>
  &WIDTH=640&HEIGHT=640&FORMAT=image/jpeg&TIME=<UTC date>
```

What comes back is a JPEG. **That is all that comes back**: no cloud fraction, no temperature, no
precipitation, no classification. The normalized `SatelliteObservation` therefore carries the
product, the observation date, the coverage box, the provider, the attribution and the image
reference — and no meteorological figure, because the source supplies none.

## Freshness

The layer is a **daily composite** built from that UTC day's daytime overpass, published roughly
three hours after the overpass. Two consequences, both handled rather than hidden:

* The observation is up to about a day old. The contract states `observed_date` and the answer says
  which day it is; nothing describes it as current conditions.
* **A composite for the current UTC day does not cover every longitude yet.** Probed on
  2026-09-12 at 07:49 UTC, the Berlin box returned 2.7 KB for that day and 91.5 KB for the day
  before — the provider answers with an essentially empty image where the day's composite has not
  reached that area. The adapter therefore asks for the current UTC day and, if the response is
  below `MINIMUM_IMAGE_BYTES`, asks once for the day before and reports which day it used.

That byte check is a fact about **whether the provider returned imagery**, not about what the
imagery shows. Weathra does not look at the pixels — see *No vision* below.

## Authentication

**None.** No key, no token, no registration, no new secret in any environment. This was a
requirement rather than a preference, and it is why the EUMETSAT Data Store was rejected despite
being the better instrument over Europe.

## Attribution and licence

NASA GIBS imagery is openly available, and NASA asks for acknowledgement. The exact string is
carried in the domain model as a constant and travels with every observation into the evidence
record and the API response:

> We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services
> (GIBS), part of NASA's Earth Observing System Data and Information System (EOSDIS).

Any surface that displays the imagery displays that line with it.

## Known limitations

* **Daily, not live.** Fifteen-minute geostationary imagery exists for the Americas
  (`GOES-East/West_ABI_GeoColor`) and Asia-Pacific (`Himawari_AHI_*`) *in GIBS itself* — but not for
  Europe, which has no Meteosat layer there. Selecting a geostationary layer where the resolved
  location has one is the obvious extension and is deliberately not in this pass.
* **Daylight only.** A true-colour composite has nothing to show on the night side. The observation
  is still reported with its date; it is not presented as a reading.
* **No numbers.** This source cannot answer "how much cloud" or "will it rain". Those questions
  belong to the forecast, current and analytics capabilities, and the satellite capability does not
  pretend otherwise.
* **Region, not point.** The image covers a box around the place, not the place.

## No vision

Weathra retrieves and displays this imagery. **It does not interpret it.** No vision-capable model
is in the pipeline, nothing here classifies a pixel, and no code path derives cloud, storm or front
from the image. The language model is given the observation's *metadata* — provider, product, date,
coverage — and never the image, so it has nothing to describe even if asked to.

What Weathra may truthfully say: *the latest available satellite imagery for this region is from
11 September 2026, from NASA GIBS.* What it may not say, and what the synthesis prompt and the
grounding tests both forbid: that the image shows a front, a low, convection, or how much it rained.

## Fallback behaviour

Satellite is optional and never load-bearing:

* the provider being unreachable, slow, or answering with an error is recorded as a failed step, and
  the forecast, current, historical, analytics and knowledge capabilities answer as they would have;
* a run that the person explicitly asked for satellite evidence says plainly that it could not be
  retrieved, rather than answering as though it had been;
* no substitute imagery, cached-as-live imagery, or generated imagery is ever produced.
