/**
 * `ScrollRegion` — the tab stop appears exactly when there is something to scroll.
 *
 * Both branches matter and neither is the default. A region that is never focusable leaves the
 * columns past its right edge unreachable to a keyboard, which is the defect this primitive exists
 * to fix; a region that is *always* focusable puts an empty stop in the tab order of every screen
 * that happens to fit, which is a smaller version of the same disrespect for somebody's time.
 *
 * jsdom reports `scrollWidth` and `clientWidth` as 0 for everything, so the overflow is the one
 * thing here that has to be stood in for — it is a layout measurement and jsdom does no layout. The
 * numbers are set on the element the component measures, which is the same value the component
 * reads in a browser; that the *real* measurement produces a tab stop is asserted in
 * `tests/e2e/accessibility.spec.ts` against Chromium and Gecko, where the layout is real.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScrollRegion } from "./scroll-region";

/**
 * Make the next rendered element measure as overflowing, or as fitting.
 *
 * Defined on `HTMLElement.prototype` because the component reads the properties off the node it
 * holds a ref to, and jsdom's own definitions are non-configurable own properties of the prototype.
 */
function measureAs(overflow: { scroll: number; client: number }): () => void {
  const scrollWidth = vi
    .spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockReturnValue(overflow.scroll);
  const clientWidth = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockReturnValue(overflow.client);
  return () => {
    scrollWidth.mockRestore();
    clientWidth.mockRestore();
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScrollRegion", () => {
  it("is a named, focusable group when its content is wider than it is", () => {
    const restore = measureAs({ scroll: 900, client: 360 });
    render(
      <ScrollRegion label="Grounded data sources table">
        <table>
          <tbody>
            <tr>
              <td>Open-Meteo</td>
            </tr>
          </tbody>
        </table>
      </ScrollRegion>,
    );

    const region = screen.getByRole("group", { name: "Grounded data sources table" });
    // A keyboard can reach it, which is what makes the content past the right edge available.
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.dataset.scrollable).toBe("true");
    restore();
  });

  it("is not a tab stop at all when the content fits", () => {
    const restore = measureAs({ scroll: 360, client: 360 });
    render(
      <ScrollRegion label="Grounded data sources table">
        <p>Short enough</p>
      </ScrollRegion>,
    );

    expect(screen.queryByRole("group")).toBeNull();
    const region = screen.getByText("Short enough").parentElement;
    expect(region).not.toHaveAttribute("tabindex");
    expect(region).not.toHaveAttribute("aria-label");
    expect(region?.dataset.scrollable).toBe("false");
    restore();
  });

  it("treats a sub-pixel difference as fitting rather than as a stop worth taking", () => {
    // A rounded layout can leave a pixel behind; a pixel is not content anybody scrolls to.
    const restore = measureAs({ scroll: 361, client: 360 });
    render(
      <ScrollRegion label="Grounded data sources table">
        <p>Rounded</p>
      </ScrollRegion>,
    );

    expect(screen.queryByRole("group")).toBeNull();
    restore();
  });

  it("is a focusable group when its content is taller than it is", () => {
    // `overflow-x: auto` computes the other axis to `auto`, so a few pixels too tall is a scrollable
    // region too — and just as unreachable. This is the state Historical Analytics' charts were in.
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(266);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(260);
    const restore = measureAs({ scroll: 360, client: 360 });

    render(
      <ScrollRegion label="Recorded temperature chart">
        <p>Six pixels too tall</p>
      </ScrollRegion>,
    );

    expect(screen.getByRole("group", { name: "Recorded temperature chart" })).toHaveAttribute(
      "tabindex",
      "0",
    );

    restore();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it("keeps the screen's own layout class either way", () => {
    const restore = measureAs({ scroll: 900, client: 360 });
    render(
      <ScrollRegion label="Recorded temperature chart" className="tableScroll">
        <p>Wide</p>
      </ScrollRegion>,
    );

    expect(screen.getByRole("group")).toHaveClass("tableScroll");
    restore();
  });

  it("re-measures when the container is resized", () => {
    // The condition is not a fact about the markup: the same table overflows at 360 pixels and fits
    // at 1440, so the component observes rather than deciding once.
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class RecordingObserver implements ResizeObserver {
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect = disconnect;
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;

    const restore = measureAs({ scroll: 900, client: 360 });
    const { unmount } = render(
      <ScrollRegion label="Recorded temperature chart">
        <p>Wide</p>
      </ScrollRegion>,
    );

    // Both sides of the comparison: the container as the viewport changes, the content as the data
    // does.
    expect(observed.length).toBeGreaterThanOrEqual(2);
    unmount();
    expect(disconnect).toHaveBeenCalled();

    restore();
    globalThis.ResizeObserver = original;
  });
});
