/**
 * Task 20.13: every view gets the same four states, and a retry that does not reload the page.
 *
 * These are component tests, driven through a screen-shaped consumer, because that is where the
 * convention either holds or does not: a unit test of the mapper would pass while a hook that
 * never left its loading state shipped.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ApiError, SessionExpired, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { ViewStateSwitch } from "@/components/view-state";

import { useApiQuery } from "./hooks";
import { createQueryClient, shouldRetry } from "./provider";
import { describeFailure, isSubmitting, viewStateFrom } from "./state";

/** A client with one stubbed method; everything else is absent and unused. */
function clientWith(savedLocations: Mock): ApiClient {
  return { savedLocations } as unknown as ApiClient;
}

/** A screen-shaped consumer: one query, four branches, one retry control. */
function SavedLocations({ empty }: { empty?: boolean } = {}) {
  const { state, retry, busy } = useApiQuery({
    key: ["saved-locations"],
    request: (client) => client.savedLocations(),
    isEmpty: empty === true ? () => true : undefined,
  });

  return (
    <div>
      <ViewStateSwitch
        state={state}
        retry={retry}
        loading={() => <p role="status">Loading your places…</p>}
        empty={() => <p>No saved places yet.</p>}
        error={(failure, again) => (
          <div>
            <p role="alert">{failure.message}</p>
            {failure.requestId !== null && <p>Reference {failure.requestId}</p>}
            <button onClick={again}>Try again</button>
          </div>
        )}
        ready={(data) => <p>{data.count} saved</p>}
      />
      <button disabled={busy}>Refresh</button>
    </div>
  );
}

function mount(client: ApiClient, ui = <SavedLocations />) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={client}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the four states", () => {
  it("shows loading while the request is in flight, and disables the submit control", async () => {
    let release: (value: unknown) => void = () => {};
    const savedLocations = vi.fn(() => new Promise((resolve) => (release = resolve)));
    mount(clientWith(savedLocations));

    expect(screen.getByRole("status")).toHaveTextContent("Loading your places…");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();

    release({ locations: [], count: 2, limit: 20 });
    await waitFor(() => expect(screen.getByText("2 saved")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("shows the ready state with the answer", async () => {
    mount(clientWith(vi.fn().mockResolvedValue({ locations: [], count: 3, limit: 20 })));

    expect(await screen.findByText("3 saved")).toBeInTheDocument();
  });

  it("shows the empty state rather than presenting nothing as an answer", async () => {
    mount(
      clientWith(vi.fn().mockResolvedValue({ locations: [], count: 0, limit: 20 })),
      <SavedLocations empty />,
    );

    expect(await screen.findByText("No saved places yet.")).toBeInTheDocument();
    expect(screen.queryByText("0 saved")).not.toBeInTheDocument();
  });

  it("shows the backend's own message on failure, with its request id", async () => {
    const failure = new ApiError(503, {
      code: "provider_unavailable",
      message: "Open-Meteo did not answer in time.",
      request_id: "req-77",
    });
    mount(clientWith(vi.fn().mockRejectedValue(failure)));

    // A 503 is retried once before the view is told, so the alert arrives after the backoff —
    // which is the behaviour the retry policy is *for*, and worth waiting through here.
    expect(
      await screen.findByRole("alert", {}, { timeout: 5000 }),
    ).toHaveTextContent("Open-Meteo did not answer in time.");
    expect(screen.getByText("Reference req-77")).toBeInTheDocument();
  });
});

describe("a retry after a failed request", () => {
  it("re-runs the request in place, with no page reload", async () => {
    const savedLocations = vi
      .fn()
      // A refused request, so there is exactly one attempt and the failure is on screen at once.
      // The manual retry is `refetch`, independent of the automatic policy.
      .mockRejectedValueOnce(
        new ApiError(400, { code: "validation_failed", message: "Something went wrong." }),
      )
      .mockResolvedValue({ locations: [], count: 1, limit: 20 });

    mount(clientWith(savedLocations));

    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("1 saved")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Two calls, one component instance: the retry re-ran the request rather than remounting.
    expect(savedLocations).toHaveBeenCalledTimes(2);
  });

  it("leaves the failure on screen when the retry fails again", async () => {
    const savedLocations = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, { code: "validation_failed", message: "Still failing." }),
      );

    mount(clientWith(savedLocations));
    expect(await screen.findByRole("alert")).toHaveTextContent("Still failing.");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(savedLocations).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Still failing.");
  });
});

describe("the retry policy", () => {
  it("does not retry a request the backend refused", () => {
    // A 4xx is a decision. Retrying delays the message the person needs and reloads the provider
    // behind it for nothing.
    expect(shouldRetry(0, new ApiError(404, { code: "location_not_found", message: "No." }))).toBe(
      false,
    );
    expect(shouldRetry(0, new ApiError(422, { code: "validation_failed", message: "No." }))).toBe(
      false,
    );
  });

  it("never retries an authentication failure, which the session layer is handling", () => {
    expect(shouldRetry(0, new SessionExpired({ code: "unauthenticated", message: "No." }))).toBe(
      false,
    );
  });

  it("retries an unreachable backend and a server fault, once", () => {
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(0, new ApiError(503, { code: "x", message: "y" }))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, { code: "x", message: "y" }))).toBe(false);
  });
});

describe("the state mapper", () => {
  it("prefers a failure over stale data, so a view never shows both", () => {
    const state = viewStateFrom({
      data: { count: 1 },
      error: new Error("gone"),
      isPending: false,
    });

    expect(state.kind).toBe("error");
  });

  it("treats a query with no data yet as loading, not as empty", () => {
    expect(viewStateFrom({ data: undefined, error: null, isPending: true }).kind).toBe("loading");
  });

  it("describes a failure that carries no message at all", () => {
    const failure = describeFailure(null);

    expect(failure.message).toBe("Weathra could not complete that request.");
    expect(failure.code).toBeNull();
    expect(failure.retryable).toBe(true);
  });

  it("marks a refused request as not worth retrying", () => {
    expect(
      describeFailure(new ApiError(400, { code: "validation_failed", message: "Two needed." }))
        .retryable,
    ).toBe(false);
  });

  it("counts a refetch over existing data as still in flight", () => {
    // The case where a submit control looks safe to press again and is not.
    expect(isSubmitting({ data: { count: 1 }, error: null, isPending: false, isFetching: true }))
      .toBe(true);
  });
});
