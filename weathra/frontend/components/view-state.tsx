/**
 * The four-state branch, as one component.
 *
 * Every MVP view renders through this, and it carries no styling of its own — the appearance of a
 * loading, empty, or error state belongs to the design system (group 19, applied in tasks 20.3 and
 * 20.15), and a placeholder look invented here would be the "generic generated styling" the spec
 * explicitly rules out.
 *
 * What it does carry is the *obligation*: all four branches are required props, so a screen cannot
 * quietly omit the empty state and render nothing at all — which is the failure `specs/web-ui`
 * names when it forbids showing an empty result as though it were an answer.
 */

import type { ReactNode } from "react";

import type { ViewFailure, ViewState } from "@/lib/query/state";

export interface ViewStateSwitchProps<Data> {
  readonly state: ViewState<Data>;
  readonly loading: () => ReactNode;
  readonly empty: () => ReactNode;
  readonly error: (failure: ViewFailure, retry: () => void) => ReactNode;
  readonly ready: (data: Data) => ReactNode;
  /** Runs the request again in place. Passed to the error branch. */
  readonly retry?: () => void;
}

export function ViewStateSwitch<Data>({
  state,
  loading,
  empty,
  error,
  ready,
  retry = () => {},
}: ViewStateSwitchProps<Data>): ReactNode {
  switch (state.kind) {
    case "loading":
      return loading();
    case "empty":
      return empty();
    case "error":
      return error(state.failure, retry);
    case "ready":
      return ready(state.data);
  }
}
