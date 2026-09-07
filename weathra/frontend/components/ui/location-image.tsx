"use client";

/**
 * The photographic region `01-dashboard.png` and `04-compare-cities.png` are built on.
 *
 * The Dashboard opens on a wide photograph of the briefed city under a dark gradient, and each
 * compared city gets a banner of the same treatment. This is that frame, and the *only* place in
 * the application that decides where a location's image comes from — no component holds a city
 * URL, and adding a screen that needs one means using this, not writing another lookup.
 *
 * # Where the image comes from
 *
 * It asks `/api/location-image`, which walks three tiers server-side and always answers:
 *
 *   1. a photograph from a configured provider (Pexels or Unsplash),
 *   2. a photograph committed under `public/locations/photos/`,
 *   3. the artwork this repository draws, in `public/locations/`.
 *
 * The credential for tier 1 never reaches the browser — `lib/images/provider.server.ts` is
 * `server-only`, so importing it from here would fail the build rather than leak. What arrives is a
 * URL, a description and which tier produced it.
 *
 * **Tier 3 is drawn first, not last.** The generated artwork is rendered immediately from the
 * place's name, and a resolved photograph replaces it when the request answers. So there is no
 * empty frame, no spinner in the hero, and no reflow: the frame's height comes from its aspect
 * ratio, which is fixed before anything loads. If the request fails, or a photograph 404s after
 * resolving, the artwork stays — which is why this component has an error state that looks like
 * nothing happening.
 *
 * # The alt text tells the truth about which tier it got
 *
 * A provider photograph is described as photographed; the generated artwork is described as
 * generated artwork. An `alt` reading "Berlin at dusk" over a drawing is a small lie told to
 * exactly the people who cannot check it. No asset encodes a temperature or a condition — every
 * figure on these screens is drawn as text from the backend, never baked into an image.
 *
 * # Fidelity fixtures
 *
 * In fixture mode the resolution is skipped entirely and the image comes from a fixed table, so a
 * screenshot comparison is reproducible: the same city is the same picture on every capture, and no
 * third-party request happens during a capture run at all.
 *
 * The overlay is a slot rather than a fixed set of fields — the Dashboard puts a full readout in
 * it, a comparison card a name and a badge — and both keep the artifacts' geometry: a fixed aspect
 * ratio, `object-fit: cover`, and a gradient heavy enough where text sits.
 */

import { useEffect, useState, type ReactNode } from "react";

import {
  generatedImageFor,
  locationImageQuery,
  locationKey,
  type LocationImageSource,
  type ResolvedLocationImage,
} from "@/lib/images/locations";
import { FIXTURE_LOCATION_IMAGES, usingVisilyFixtures } from "@/lib/fixtures/visily";

import styles from "./primitives.module.css";

/**
 * The file name a location maps to.
 *
 * Retained as a named export because callers and tests use it; it now delegates to `locationKey`,
 * so there is one definition of what a place's key is rather than two that could drift.
 */
export function slugForLocation(displayName: string): string {
  return locationKey(displayName);
}

/**
 * A stable hue for a place, from its coordinates.
 *
 * Deterministic on purpose: the same city is the same colour on every screen and every reload, so
 * the field reads as belonging to that place rather than as decoration that reshuffles.
 */
function fieldFor(latitude: number | null, longitude: number | null): string {
  const seed = Math.abs(Math.round((latitude ?? 0) * 7 + (longitude ?? 0) * 13));
  return `${seed % 360}deg`;
}

export interface LocationImageProps {
  /** The backend's canonical name for the place. Also the alt text's subject. */
  readonly displayName: string;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  /** `hero` is the Dashboard's wide band; `banner` is a comparison card's strip. */
  readonly variant?: "hero" | "banner";
  /**
   * How heavily to darken the image under the overlay.
   *
   * `strong` is the default and the only thing production uses: heavy enough at the foot for a
   * readout to clear 4.5:1 over any image. `soft` is the artifacts' lighter wash, where the
   * photograph reads through and the only text over it is a name and a badge.
   */
  readonly scrim?: "strong" | "soft";
  /** What sits on the image: the readout, the name, a badge. */
  readonly children?: ReactNode;
}

export function LocationImage({
  displayName,
  latitude = null,
  longitude = null,
  variant = "hero",
  scrim = "strong",
  children,
}: LocationImageProps): ReactNode {
  /*
   * The starting image is the one that cannot fail, so the first paint is already correct-shaped
   * and correctly described. Everything after this is an upgrade, never a requirement.
   */
  const fallback = generatedImageFor(displayName);
  const fixtures = usingVisilyFixtures();
  const fixed = fixtures ? FIXTURE_LOCATION_IMAGES[locationKey(displayName)] : undefined;

  const [image, setImage] = useState<ResolvedLocationImage>(fixed ?? fallback);
  /** Set when the resolved URL itself fails to load, which sends us back to the artwork. */
  const [broken, setBroken] = useState(false);
  /** Only ever true in production mode; fixture mode resolves nothing. */
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Fixture mode is a fixed table: no request, so a capture run is reproducible and offline.
    if (fixtures) {
      setImage(fixed ?? generatedImageFor(displayName));
      setBroken(false);
      return;
    }

    const controller = new AbortController();
    let live = true;
    setBroken(false);
    setLoading(true);

    void (async () => {
      try {
        const response = await fetch(locationImageQuery(displayName), {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const resolved = (await response.json()) as ResolvedLocationImage;
        if (live && resolved.url) setImage(resolved);
      } catch {
        // Aborted, offline, or a malformed answer. The artwork already on screen stays.
      } finally {
        if (live) setLoading(false);
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, [displayName, fixtures, fixed]);

  const shown: ResolvedLocationImage = broken ? generatedImageFor(displayName) : image;
  const source: LocationImageSource = broken ? "generated" : shown.source;

  return (
    <div
      className={styles.locationImage}
      data-variant={variant}
      data-source={source}
      data-loading={loading ? "true" : undefined}
      style={{ ["--field-angle" as string]: fieldFor(latitude, longitude) }}
    >
      {/*
        The token-built field, underneath everything. It is what shows in the instant before the
        artwork paints and behind a transparent edge, so the frame is never the page's background.
      */}
      <div className={styles.locationField} aria-hidden="true" />

      {/*
        A plain `img` rather than `next/image`: tier 1 returns an arbitrary third-party URL, which
        the optimiser would need a `remotePatterns` entry per provider to accept, and tiers 2 and 3
        are static files at a size this layout already fixes. `onError` is what lets the fallback
        exist at all.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.locationPhoto}
        src={shown.url}
        alt={shown.description}
        /*
         * `width`/`height` when the provider reports them, so the intrinsic ratio is known — but
         * the frame's own `aspect-ratio` is what fixes the height, so neither their presence nor
         * their absence can move the layout.
         */
        width={shown.width}
        height={shown.height}
        onError={() => setBroken(true)}
        loading={variant === "hero" ? "eager" : "lazy"}
        decoding="async"
      />

      <div className={styles.locationScrim} data-scrim={scrim} aria-hidden="true" />
      {children ? <div className={styles.locationOverlay}>{children}</div> : null}

      {/*
        The photographer's credit, where the licence asks for one. Small, in the corner, and only
        present when the provider named someone.
      */}
      {shown.credit && !broken ? (
        <p className={styles.locationCredit}>
          {shown.credit.url ? (
            <a href={shown.credit.url} rel="noreferrer nofollow" target="_blank">
              {shown.credit.name}
            </a>
          ) : (
            shown.credit.name
          )}
        </p>
      ) : null}
    </div>
  );
}
