"use client";

/**
 * One hook every data-reading screen uses, so every screen gets the same four states and the same
 * retry (task 20.13).
 *
 * The retry re-runs the request in place. `specs/web-ui` requires a person to be able to retry
 * *without reloading the page*, which is not a detail: a reload loses the question they typed, the
 * comparison they built, and the place they had chosen.
 */

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ApiClient } from "@/lib/api/client";
import { useApiClient } from "@/lib/api/context";

import { isSubmitting, viewStateFrom, type ViewState } from "./state";

export interface UseApiQueryOptions<Data> {
  /** Identifies the request in the cache. Include every input the request depends on. */
  readonly key: QueryKey;
  readonly request: (client: ApiClient) => Promise<Data>;
  /**
   * Whether a successful answer is nevertheless empty — no saved locations, no candidates, no
   * matching days. Only the view knows what empty means for it.
   */
  readonly isEmpty?: (data: Data) => boolean;
  /** Hold the request until an input exists. A disabled query stays in its loading state. */
  readonly enabled?: boolean;
}

export interface UseApiQueryResult<Data> {
  readonly state: ViewState<Data>;
  /** Run the request again, in place. */
  readonly retry: () => void;
  /** Whether a request is in flight, so a submit control can be disabled. */
  readonly busy: boolean;
}

export function useApiQuery<Data>({
  key,
  request,
  isEmpty,
  enabled = true,
}: UseApiQueryOptions<Data>): UseApiQueryResult<Data> {
  const client = useApiClient();

  const query = useQuery({
    queryKey: key,
    queryFn: () => request(client),
    enabled,
  });

  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    state: viewStateFrom(
      { data: query.data, error: query.error, isPending: query.isPending, isFetching: query.isFetching },
      isEmpty,
    ),
    retry,
    busy: isSubmitting({
      data: query.data,
      error: query.error,
      isPending: query.isPending && enabled,
      isFetching: query.isFetching,
    }),
  };
}
