"use client";

/**
 * One location entry's resolution, for a surface that has one — task 21.7.
 *
 * The Dashboard and Saved Locations each take a single place, so each gets one of these. Compare
 * Cities takes several and drives `resolveLocationEntry` directly per row, because a hook per row
 * cannot exist when the number of rows is what a person is editing.
 *
 * What the hook adds over the plain call is ordering. A person types "Springfield", waits, then
 * replaces it with "Berlin" and asks again; the first answer can still arrive afterwards. Numbering
 * the requests and dropping every answer that is not the newest is what stops the candidates for a
 * name somebody has already abandoned appearing as the answer to the one they are waiting on —
 * which is the same class of mistake as showing stale weather, and matters more here because those
 * candidates are a control somebody is about to press.
 *
 * Nothing here holds a location it was not given. `choose` takes a candidate *from the response*
 * and records it; there is no path by which a coordinate could be assembled locally.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useApiClient } from "@/lib/api/context";
import type { Location } from "@/lib/api/schema";
import {
  alreadyResolved,
  resolveLocationEntry,
  UNRESOLVED,
  type LocationResolution,
} from "@/lib/locations/resolution";

export interface UseLocationResolutionResult {
  readonly resolution: LocationResolution;
  /** Ask the backend about a name. Returns the state it settled in. */
  readonly resolve: (query: string) => Promise<LocationResolution>;
  /** Record a candidate the person chose from an ambiguous answer. */
  readonly choose: (location: Location) => void;
  /** Back to unresolved — for clearing the field, or dismissing a chooser. */
  readonly clear: () => void;
  /** Adopt a location already known to be canonical, without asking again. */
  readonly adopt: (location: Location) => void;
  readonly busy: boolean;
}

export function useLocationResolution(
  initial: Location | null = null,
): UseLocationResolutionResult {
  const client = useApiClient();
  const [resolution, setResolution] = useState<LocationResolution>(() =>
    initial === null ? UNRESOLVED : alreadyResolved(initial),
  );

  /** The newest request. An answer carrying an older number is discarded. */
  const generation = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const resolve = useCallback(
    async (query: string): Promise<LocationResolution> => {
      const asked = query.trim();
      if (asked === "") {
        setResolution(UNRESOLVED);
        return UNRESOLVED;
      }

      generation.current += 1;
      const mine = generation.current;
      setResolution({ kind: "resolving", query: asked });

      const settled = await resolveLocationEntry(client, asked);
      // Superseded, or the surface is gone. The answer is dropped, never rendered.
      if (!live.current || mine !== generation.current) return settled;

      setResolution(settled);
      return settled;
    },
    [client],
  );

  const choose = useCallback((location: Location) => {
    setResolution((current) => ({
      kind: "resolved",
      query: current.kind === "unresolved" ? location.display_name : current.query,
      location,
      chosen: true,
    }));
  }, []);

  const adopt = useCallback((location: Location) => {
    generation.current += 1;
    setResolution(alreadyResolved(location));
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    setResolution(UNRESOLVED);
  }, []);

  return {
    resolution,
    resolve,
    choose,
    clear,
    adopt,
    busy: resolution.kind === "resolving",
  };
}
