/**
 * The location-image endpoint — the browser's only route to a city photograph.
 *
 * The client component asks here with a place name; this asks
 * `lib/images/provider.server.ts`, which walks provider → local → generated and always answers.
 * The provider's credential and endpoint stay on this side of the boundary: the browser learns a
 * URL to fetch and nothing else about how it was obtained.
 *
 * It answers with the *metadata*, not the bytes. Proxying the image itself would put every hero on
 * this application's own bandwidth and lose the CDN the provider already has, for no gain — the
 * URL is public once resolved, and the key never travels with it.
 *
 * **Behind the session gate, like everything else.** An earlier version of this comment claimed the
 * opposite — that `middleware.ts` matches pages rather than `/api` — and that is simply wrong:
 * `lib/routes.ts` is protected-by-default and the matcher excludes only the build output, the
 * favicon and image files, so a request here without a session is redirected to sign-in like any
 * other path. Verified against the running harness rather than assumed.
 *
 * That is the right posture and costs nothing: every screen that shows location imagery is itself
 * protected, and the authentication screen does not use `LocationImage` — `08-authentication.png`
 * has no city photograph on it.
 */

import { NextResponse } from "next/server";

import { generatedImageFor } from "@/lib/images/locations";
import { providerConfigured, resolveLocationImage } from "@/lib/images/provider.server";

/** Node, not edge: tier 2 reads the filesystem for a committed photograph. */
export const runtime = "nodejs";

/**
 * Cached at the edge for an hour and served stale for a day while revalidating.
 *
 * A city's photograph does not change, and the alternative — a provider request per viewer — is
 * both slower and a good way to meet a rate limit.
 */
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

export async function GET(request: Request): Promise<NextResponse> {
  const place = new URL(request.url).searchParams.get("place")?.trim();

  // No place is a client bug, not a server error: answer with the generic artwork so the frame
  // still fills, and say what happened.
  if (!place || place.length === 0 || place.length > 120) {
    return NextResponse.json(
      { ...generatedImageFor("This location"), reason: "no usable place given" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const image = await resolveLocationImage(place);

  return NextResponse.json(
    {
      ...image,
      /*
       * Why this tier, so a reviewer comparing against an artifact is never left guessing whether
       * they are looking at a photograph or at artwork. It says whether a provider was configured,
       * never what it is or what its key is.
       */
      providerConfigured: providerConfigured(),
    },
    { headers: { "cache-control": CACHE_CONTROL } },
  );
}
