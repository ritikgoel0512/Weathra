/**
 * The four states every view is in, and the one place a query result becomes one of them.
 *
 * `specs/web-ui` requires each view to distinguish *four* things: a request in flight, nothing to
 * show yet, a failure, and an answer — and specifically forbids showing an empty result as though
 * it were a successful answer. Left to each screen, that becomes four subtly different sets of
 * conditionals and a dashboard that renders "0 locations" as a briefing.
 *
 * So the mapping happens here, once, and a screen renders one branch per state.
 *
 * **Empty is decided by the view, not by the query.** An empty forecast is a failure of coverage;
 * an empty saved-locations list is a normal first day. Only the view knows which, so `isEmpty` is
 * its argument.
 */

/** A failure a view can show and retry. */
export interface ViewFailure {
  /** The backend's own message, which the spec requires the view to display. */
  readonly message: string;
  /** The backend's stable error code, when it sent one. */
  readonly code: string | null;
  /** The request id, for a report that can be traced. */
  readonly requestId: string | null;
  /** Whether retrying could plausibly succeed — a network failure, not a rejected request. */
  readonly retryable: boolean;
  readonly error: unknown;
}

export type ViewState<Data> =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly failure: ViewFailure }
  | { readonly kind: "ready"; readonly data: Data };

/** What `viewStateFrom` needs from a query result, which is what TanStack Query provides. */
export interface QueryLike<Data> {
  readonly data: Data | undefined;
  readonly error: unknown;
  readonly isPending: boolean;
  readonly isFetching?: boolean;
}

interface DescribedError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly requestId?: unknown;
  readonly status?: unknown;
  readonly name?: unknown;
}

/**
 * A thrown value described for a person.
 *
 * The client's `ApiError` carries the backend's message, code, and request id, and this reads them
 * structurally rather than by `instanceof`: a value that arrives through a React Query cache, a
 * serialized boundary, or a test's fake still describes the same failure, and a check that
 * insisted on the class would fall back to "something went wrong" for all of them.
 */
export function describeFailure(error: unknown): ViewFailure {
  const described = (error ?? {}) as DescribedError;
  const message =
    typeof described.message === "string" && described.message !== ""
      ? described.message
      : "Weathra could not complete that request.";
  const code = typeof described.code === "string" ? described.code : null;
  const requestId = typeof described.requestId === "string" ? described.requestId : null;
  const status = typeof described.status === "number" ? described.status : null;

  // A 4xx is an answer: the request was understood and refused, and repeating it unchanged gets
  // the same refusal. A network failure or a 5xx is worth another attempt.
  const retryable = status === null ? true : status >= 500 || status === 408 || status === 429;

  return { message, code, requestId, retryable, error };
}

/** One query result as one of the four states. */
export function viewStateFrom<Data>(
  query: QueryLike<Data>,
  isEmpty: (data: Data) => boolean = () => false,
): ViewState<Data> {
  if (query.error !== null && query.error !== undefined) {
    return { kind: "error", failure: describeFailure(query.error) };
  }
  if (query.isPending || query.data === undefined) {
    return { kind: "loading" };
  }
  if (isEmpty(query.data)) {
    return { kind: "empty" };
  }
  return { kind: "ready", data: query.data };
}

/**
 * Whether a submit control must be disabled.
 *
 * The spec requires an in-flight request to disable its own submit so the same request is not
 * issued twice. `isFetching` rather than `isPending`: a refetch over data already on screen is
 * still in flight, and it is exactly the case where the control looks safe to press again.
 */
export function isSubmitting(query: QueryLike<unknown>): boolean {
  return query.isPending || query.isFetching === true;
}
