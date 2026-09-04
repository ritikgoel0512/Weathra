/**
 * Resolving what somebody typed into one canonical place — task 21.7.
 *
 * There is exactly one geocoder in Weathra and it is behind the backend: `GET
 * /api/v1/locations/resolve` (`specs/location-resolution`, `specs/http-api`). This module is the one
 * place in the frontend that calls it, and the one place that decides what its answer *means*.
 * Nothing here searches, ranks, matches, or infers a coordinate; every location that reaches a
 * screen came out of that response verbatim.
 *
 * **The contract has four distinct answers and this keeps them four.** A `200` carrying
 * `kind: "resolved"` is one place. A `200` carrying `kind: "ambiguous"` is several, with the
 * candidates and the backend's own message. A `404 location_not_found` is *no* place — and
 * `specs/location-resolution` forbids substituting a nearest or partial match for it. Anything else
 * is a failure of the request, not a fact about the name. Collapsing any pair of these is how a
 * screen ends up either picking a place for somebody or telling them a real city does not exist.
 *
 * **`resolved` is the only state that unblocks data.** `blocksData` is what every location-entry
 * surface gates on, so "show no weather until a candidate is chosen" is one predicate rather than a
 * rule each screen has to remember. An ambiguous answer therefore cannot reach a weather request:
 * there is no location in that state to make one with.
 *
 * **A stale answer is discarded, not shown.** `resolveLocationEntry` is a plain async call, so the
 * caller owns ordering; `useLocationResolution` (the single-entry hook) numbers its requests and
 * drops any answer that is not the newest. Presenting the candidates for a name somebody has
 * already replaced would be the same mistake as presenting the weather for one.
 */

import type { ApiClient } from "@/lib/api/client";
import type { AmbiguousResponse, Location, ResolvedResponse } from "@/lib/api/schema";
import { describeFailure, type ViewFailure } from "@/lib/query/state";

import { coordinatesOf, qualifiedName } from "./place";

/** The backend's code for a name that matches no known place. Mirrors `weathra/domain/errors.py`. */
export const LOCATION_NOT_FOUND_CODE = "location_not_found";

/**
 * Where one location entry stands.
 *
 * Six states, because the contract distinguishes them and a person needs them distinguished: they
 * have not asked yet, Weathra is asking, it is one place, it is several, it is none, or the request
 * itself did not complete.
 */
export type LocationResolution =
  | { readonly kind: "unresolved" }
  | { readonly kind: "resolving"; readonly query: string }
  | {
      readonly kind: "resolved";
      readonly query: string;
      /** The canonical location the backend returned. Never assembled here. */
      readonly location: Location;
      /** True when the person chose it from an ambiguous set rather than it being the only match. */
      readonly chosen: boolean;
    }
  | {
      readonly kind: "ambiguous";
      readonly query: string;
      /** The candidates the backend returned, in its order. Never re-ranked, never trimmed. */
      readonly candidates: readonly Location[];
      /** The backend's own sentence about the ambiguity. */
      readonly message: string;
    }
  | { readonly kind: "not-found"; readonly query: string; readonly message: string }
  | { readonly kind: "failed"; readonly query: string; readonly failure: ViewFailure };

/** Nothing entered yet. */
export const UNRESOLVED: LocationResolution = { kind: "unresolved" };

/**
 * A location already known to be canonical, as a resolved state.
 *
 * For a place that came out of the backend as a saved location or a stored default: it was resolved
 * when it was saved, so re-resolving its name would be asking a question already answered — and
 * asking it again could turn a place somebody has into an ambiguity they have to re-choose.
 */
export function alreadyResolved(location: Location): LocationResolution {
  return { kind: "resolved", query: qualifiedName(location), location, chosen: false };
}

/**
 * A candidate the person picked out of an ambiguous answer.
 *
 * `chosen: true` records that a person decided, rather than the name having had one match. The
 * location is the backend's object, passed through unchanged.
 */
export function chosenResolution(query: string, location: Location): LocationResolution {
  return { kind: "resolved", query, location, chosen: true };
}

/** The backend's answer, as one of the states. The `kind` discriminator decides; nothing is guessed. */
export function resolutionOf(
  query: string,
  response: ResolvedResponse | AmbiguousResponse,
): LocationResolution {
  // Read through an explicit cast rather than as a discriminated union: the generated types mark
  // `kind` optional, because the backend supplies it as a model default, so TypeScript cannot use
  // it to narrow. The field is still the authority — the two responses are told apart by it and by
  // nothing else, as `specs/http-api` requires.
  const kind = (response as { readonly kind?: string }).kind;

  if (kind === "ambiguous") {
    const ambiguous = response as AmbiguousResponse;
    return {
      kind: "ambiguous",
      query,
      candidates: ambiguous.candidates,
      message: ambiguous.message,
    };
  }

  const resolved = response as ResolvedResponse;
  return { kind: "resolved", query, location: resolved.location, chosen: false };
}

/**
 * A thrown failure, as one of the states.
 *
 * Only `location_not_found` becomes "no such place". Everything else — a 500, an unreachable
 * backend, a validation refusal — stays a failure, because telling somebody their city does not
 * exist when the request simply did not complete is a lie the interface would be telling on the
 * backend's behalf.
 */
export function resolutionOfFailure(query: string, error: unknown): LocationResolution {
  const failure = describeFailure(error);
  if (failure.code === LOCATION_NOT_FOUND_CODE) {
    return { kind: "not-found", query, message: failure.message };
  }
  return { kind: "failed", query, failure };
}

/**
 * Resolve one entry through the documented endpoint.
 *
 * The single call site. A 401 propagates as `SessionExpired` from the client, which the shared
 * session boundary turns into the expired-session state — so it is deliberately *not* caught into a
 * `failed` state here beyond what `describeFailure` reports, and the screen it would have been
 * shown on is replaced before it renders.
 */
export async function resolveLocationEntry(
  client: ApiClient,
  query: string,
): Promise<LocationResolution> {
  const asked = query.trim();
  try {
    return resolutionOf(asked, await client.resolveLocation({ query: asked }));
  } catch (error) {
    return resolutionOfFailure(asked, error);
  }
}

/* ------------------------------------------------------------------ predicates */

/** The canonical location an entry settled on, or null while it has not settled on one. */
export function resolvedLocation(resolution: LocationResolution): Location | null {
  return resolution.kind === "resolved" ? resolution.location : null;
}

/**
 * Whether location-dependent data must be withheld.
 *
 * True for every state but `resolved`. This is the data gate `specs/web-ui` requires: an ambiguous
 * entry shows candidates and no weather, and an unentered, pending, unknown or failed one has no
 * place to show weather *for*.
 */
export function blocksData(resolution: LocationResolution): boolean {
  return resolution.kind !== "resolved";
}

/** Whether the entry is waiting for the person to choose between candidates. */
export function awaitsChoice(resolution: LocationResolution): boolean {
  return resolution.kind === "ambiguous";
}

/* ----------------------------------------------------------------- candidates */

/**
 * A stable key for a candidate, from the coordinates the backend supplied.
 *
 * The same coordinate-derived identity the backend's own saved-location store de-duplicates on, so
 * two candidates that are the same point are the same key and two that are not, are not.
 */
export function candidateKey(location: Location): string {
  return `${location.latitude},${location.longitude}`;
}

/**
 * What distinguishes one candidate from another, using only fields the response supplied.
 *
 * Region and country first, because `specs/location-resolution` requires each candidate to carry
 * enough detail to be told apart "including region and country where known" — and then the
 * coordinates and the timezone, which always are. A field the backend did not send produces no
 * entry rather than a blank or a placeholder.
 */
export function candidateDetail(location: Location): string[] {
  const detail: string[] = [];

  const area = [location.region, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (area.length > 0) detail.push(area.join(", "));
  else if (location.country_code) detail.push(location.country_code);

  detail.push(coordinatesOf(location));
  detail.push(location.timezone);

  if (typeof location.elevation_metres === "number") {
    detail.push(`${Math.round(location.elevation_metres)} m elevation`);
  }
  return detail;
}
