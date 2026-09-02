"use client";

/**
 * The shared query layer: one `QueryClient` for the application, configured once.
 *
 * TanStack Query owns REST fetching, caching, and the state machine every view branches on
 * (design.md decision 18). What matters here is the retry policy, because the default one is wrong
 * for this API in two ways:
 *
 * **A refused request is not retried.** The backend's 4xx answers are decisions — an unresolvable
 * place, a range outside coverage, a comparison with one city. Retrying three times changes
 * nothing, delays the message the person needs to read by several seconds, and multiplies load on
 * the provider behind it.
 *
 * **A 401 is never retried.** It is an authentication event: the session layer clears state and
 * routes to sign-in (`specs/web-ui`), and a retry would race that.
 *
 * A network failure or a 5xx *is* retried once, briefly — that is the case where trying again is
 * the whole remedy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/** How many times a failure of each kind is retried before the view is told. */
const MAX_RETRIES = 1;

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** Whether another attempt could plausibly answer differently. */
export function shouldRetry(attempt: number, error: unknown): boolean {
  if (attempt >= MAX_RETRIES) return false;
  const status = statusOf(error);
  if (status === null) return true; // unreachable backend: the one failure a retry usually fixes
  if (status === 401 || status === 403) return false;
  return status >= 500 || status === 408 || status === 429;
}

/** A `QueryClient` configured for Weathra's API. Exported for tests and server-side prefetching. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        // Weather moves, but not between two renders of the same screen. A minute of freshness
        // keeps navigation instant without showing yesterday's conditions.
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // Held in state so a re-render never swaps the client and discards the cache with it.
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
