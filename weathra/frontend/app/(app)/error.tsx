"use client";

/**
 * The `(app)` group's error boundary — the same guarantee the `(auth)` group gets, for the
 * protected screens.
 *
 * A screen that throws while rendering is not an API failure: the query layer already turns those
 * into `ErrorState` in place, with a retry and a request id. What reaches *here* is the other kind
 * — a component that could not render at all — and without a boundary Next.js answers that with the
 * bare "Application error" screen, which loses the navigation along with the message.
 *
 * `reset()` re-renders the segment without a reload, so a person keeps the shell around them and
 * the rest of their session.
 */

import { useEffect, type ReactNode } from "react";

import { ErrorState } from "@/components/ui";

export default function AppError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  useEffect(() => {
    console.error("Screen failed to render", error);
  }, [error]);

  return (
    <ErrorState
      title="This screen did not load"
      failure={{
        message:
          "Something on this screen failed to render. Your session is still active and nothing was changed.",
        requestId: error.digest ?? null,
      }}
      onRetry={reset}
      retryLabel="Try again"
    />
  );
}
