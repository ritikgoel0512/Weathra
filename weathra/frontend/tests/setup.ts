import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * `ResizeObserver`, which jsdom does not implement.
 *
 * Recharts' `ResponsiveContainer` measures its parent through it, so without this every chart
 * throws on mount. A browser-API shim, not a stand-in for anything of Weathra's: it observes
 * nothing and reports nothing, which under jsdom — where every element measures zero — is exactly
 * what a real one would do. The charts' *figures* are asserted through the table each one ships,
 * so nothing about their correctness rests on a measured layout.
 */
if (!("ResizeObserver" in globalThis)) {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
}

afterEach(() => {
  cleanup();
});
