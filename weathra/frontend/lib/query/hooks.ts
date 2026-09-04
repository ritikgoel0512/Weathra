"use client";

/**
 * One hook every data-reading screen uses, so every screen gets the same four states and the same
 * retry (task 20.13).
 *
 * The retry re-runs the request in place. `specs/web-ui` requires a person to be able to retry
 * *without reloading the page*, which is not a detail: a reload loses the question they typed, the
 * comparison they built, and the place they had chosen.
 */

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ApiClient } from "@/lib/api/client";
import { useApiClient } from "@/lib/api/context";

import { describeFailure, isSubmitting, viewStateFrom, type ViewFailure, type ViewState } from "./state";

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

/* ------------------------------------------------------------------ writing */

/**
 * The four states a write is in, and the one place a mutation result becomes one of them.
 *
 * The state machine is the honesty requirement rather than a convenience. `saved` is reachable
 * only from the resolved promise, so a control cannot report success before the backend has
 * confirmed the write — which is exactly what "avoid fake success states" means for a preference
 * form, and what makes the difference between "your units are imperial" and "we sent that".
 */
export type WriteState<Data> =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly data: Data }
  | { readonly kind: "error"; readonly failure: ViewFailure };

export interface UseApiMutationOptions<Input, Data> {
  readonly run: (client: ApiClient, input: Input) => Promise<Data>;
  /**
   * Cached reads this write makes wrong.
   *
   * Named keys rather than a blanket clear: a preference change must reach the Dashboard's read of
   * the same preferences, and must *not* discard the forecast a person is looking at.
   */
  readonly invalidates?: readonly QueryKey[];
  /** Runs after the backend confirmed the write, with what it returned. */
  readonly onDone?: (data: Data) => void;
}

export interface UseApiMutationResult<Input, Data> {
  readonly state: WriteState<Data>;
  readonly submit: (input: Input) => void;
  /** True while the write is in flight, so its control disables itself. */
  readonly busy: boolean;
  /** Back to `idle` — for dismissing a confirmation or clearing a failed attempt. */
  readonly reset: () => void;
}

export function useApiMutation<Input, Data>({
  run,
  invalidates = [],
  onDone,
}: UseApiMutationOptions<Input, Data>): UseApiMutationResult<Input, Data> {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: Input) => run(client, input),
    onSuccess: async (data) => {
      // Invalidated *after* the backend confirmed, never before: an optimistic invalidation would
      // refetch the old value and present it as the new one.
      await Promise.all(invalidates.map((key) => queryClient.invalidateQueries({ queryKey: key })));
      onDone?.(data);
    },
  });

  const { mutate, reset } = mutation;

  const submit = useCallback(
    (input: Input) => {
      // A second press while the first is in flight is not a second request.
      if (mutation.isPending) return;
      mutate(input);
    },
    [mutate, mutation.isPending],
  );

  const state: WriteState<Data> = mutation.isPending
    ? { kind: "saving" }
    : mutation.error !== null && mutation.error !== undefined
      ? { kind: "error", failure: describeFailure(mutation.error) }
      : mutation.isSuccess
        ? { kind: "saved", data: mutation.data }
        : { kind: "idle" };

  return { state, submit, busy: mutation.isPending, reset };
}
