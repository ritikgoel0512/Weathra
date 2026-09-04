"use client";

/**
 * `ScrollRegion` — wide content that scrolls in its own container, reachable by keyboard.
 *
 * `specs/web-ui` asks for two things that meet in this one element: content wider than the viewport
 * must scroll inside its own container rather than moving the page, *and* everything must be
 * operable from the keyboard. A plain `overflow-x: auto` div satisfies the first and quietly breaks
 * the second — a pointer can drag it, a trackpad can swipe it, and somebody on a keyboard alone
 * cannot reach it at all, so the columns past the right edge are simply unavailable to them. That is
 * WCAG 2.1.1, and axe-core's `scrollable-region-focusable` names it exactly.
 *
 * So the container becomes a tab stop — but only while it actually has something to scroll. That
 * condition is the whole reason this is a component rather than a `tabIndex={0}` typed in three
 * places: whether a table is wider than its container is not a fact about the markup, it is a fact
 * about the viewport, the font and the data, and it changes when any of them do. The evidence
 * sources table overflows at 360 pixels and fits at 1440. A hard-coded tab stop would be right in
 * the first case and, in the second, an empty stop between the heading and the content that a
 * keyboard user has to pass through for nothing.
 *
 * Measured with a `ResizeObserver` on the container and its content, because both sides of the
 * comparison move: the container with the viewport, the content with the data.
 *
 * When it is scrollable it is also *named* — a focusable region a screen reader announces as
 * "group" and nothing else tells you what you have landed on. `role="group"` rather than `region`
 * deliberately: these sit inside panels that are already landmarks, and a second landmark inside
 * each would add rows to a landmark list without adding places worth navigating to.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ScrollRegionProps {
  /**
   * What this region holds, said the way it would be announced on focus — "Grounded data sources
   * table", not "scroll area". The word "scrollable" is not part of it: the role and the platform
   * convey that, and repeating it in the name is the kind of thing that makes a screen reader read
   * "scrollable scrollable region".
   */
  readonly label: string;
  /** The module class carrying this screen's own layout for the container. */
  readonly className?: string;
  readonly children: ReactNode;
}

export function ScrollRegion({ label, className, children }: ScrollRegionProps): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;

    /**
     * Both axes, because a container that scrolls at all needs reaching.
     *
     * `overflow-x: auto` is only half a declaration: CSS computes the other axis from `visible` to
     * `auto`, so a container asked to scroll horizontally will also scroll vertically the moment
     * its content is a few pixels too tall. Measuring only the width would call such a container
     * unscrollable while the browser scrolled it, which is exactly the state that leaves content
     * unreachable — and it is the state Historical Analytics was in.
     *
     * A pixel of tolerance in each direction, because a sub-pixel layout rounds and one pixel is
     * not content anybody needs to scroll to.
     */
    const measure = (): void => {
      setScrollable(
        element.scrollWidth - element.clientWidth > 1 ||
          element.scrollHeight - element.clientHeight > 1,
      );
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    // Both sides of the comparison: the container as the viewport changes, and the content as the
    // data does.
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      ref={container}
      className={className}
      // Only while there is something to scroll — see the note above.
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? "group" : undefined}
      aria-label={scrollable ? label : undefined}
      // For the browser suite, which asserts the tab stop appears exactly when the overflow does.
      data-scrollable={scrollable ? "true" : "false"}
    >
      {children}
    </div>
  );
}
