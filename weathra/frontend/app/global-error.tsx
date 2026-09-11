"use client";

/**
 * The last boundary: a failure in the root layout itself, which no segment boundary can catch.
 *
 * It replaces the whole document — Next.js requires it to render its own `<html>` and `<body>`,
 * because the layout that would have provided them is the thing that failed. That also means it
 * cannot use the fonts or the design tokens, both of which are loaded by that layout, so the styles
 * here are inline and deliberately self-sufficient.
 *
 * It should never be reached. It exists so that "Application error: a client-side exception has
 * occurred" is not what a person sees if it ever is.
 */

import { useEffect, type ReactNode } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  useEffect(() => {
    console.error("Weathra failed to start", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b1020",
          color: "#e8edf7",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
        }}
      >
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.75rem" }}>Weathra did not start</h1>
          <p style={{ margin: "0 0 1.5rem", lineHeight: 1.6, color: "#aab6cf" }}>
            Something failed before any screen could render. Nothing was changed, and trying again
            usually resolves it.
          </p>
          {error.digest ? (
            <p style={{ margin: "0 0 1.5rem", fontSize: "0.8125rem", color: "#7c8aa5" }}>
              Reference {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              padding: "0.625rem 1.25rem",
              borderRadius: "0.5rem",
              border: "1px solid #3d4b6b",
              background: "#1b2540",
              color: "#e8edf7",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
