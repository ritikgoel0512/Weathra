"use client";

/**
 * The place a screen has already resolved, made available to everything it renders.
 *
 * **Why this exists.** A screen resolves `Munich` once, gets `Munich, Bavaria, Germany` back, and
 * then asks for current conditions, the forecast, the analysis, the changes and the baseline by
 * *coordinate* — because a coordinate is unambiguous, and re-sending a typed name would be asking
 * the geocoder to agree with itself on every request. The backend, handed a coordinate, has no name
 * to return: Open-Meteo geocodes names to points and not the reverse, so it names the point after
 * itself. Every card then derived its own label from its own response and printed `Unnamed place`
 * under a header that said `Munich, Bavaria, Germany`.
 *
 * Threading the resolved location through nine attribution builders would have worked and would
 * have been forgotten by the tenth. The identity of the place a screen is about is *ambient to that
 * screen*, so it is provided once at the top and read where a name is needed.
 *
 * **It never overrides a name a response actually carries.** `resolvedPlaceLabel` prefers the
 * response's own name and falls back to this one only for a place that reported no name *and* is
 * the same place by coordinate. A screen showing two places — a comparison — provides nothing, and
 * every card keeps naming itself.
 */

import { createContext, useContext, type ReactNode } from "react";

import { resolvedPlaceLabel } from "@/lib/locations/place";
import type { Location } from "@/lib/api/schema";

const ResolvedPlace = createContext<Location | null>(null);

export function ResolvedPlaceProvider({
  location,
  children,
}: {
  readonly location: Location | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ResolvedPlace.Provider value={location}>{children}</ResolvedPlace.Provider>
  );
}

/** The place this screen resolved, or `null` where a screen is not about one place. */
export function useResolvedPlace(): Location | null {
  return useContext(ResolvedPlace);
}

/**
 * Name a place, preferring its own name and falling back to the one this screen resolved.
 *
 * The hook every attribution line and card header should use instead of `placeLabel`, which cannot
 * see the context and will therefore keep answering `Unnamed place` for a coordinate request.
 */
export function usePlaceName(
  location: Location | null | undefined,
): string | null {
  return resolvedPlaceLabel(location, useResolvedPlace());
}
