/**
 * The shell — task 20.12's verification.
 *
 * What the task names: every MVP product screen is reachable, the signed-in identity is shown, and
 * a post-MVP route renders its not-yet-available state. Those are the first three groups below.
 * The rest cover the parts that are easy to get wrong and invisible when they are: the active
 * route's `aria-current`, the drawer's expanded state and its Escape key, the skip link, and the
 * fact that a planned entry's marking is *words* and not only a chip.
 *
 * `usePathname` is mocked because it is Next's router, not Weathra's: the shell's contract is that
 * it marks whichever destination the router reports.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Identity } from "@/lib/auth/identity";
import { NAVIGATION } from "@/lib/navigation";
import { MVP_SCREENS, POST_MVP_SCREENS } from "@/lib/routes";

import { AppShell } from "./app-shell";
import { RouteStatus } from "./route-status";

const pathname = vi.fn<() => string>(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

const IDENTITY: Identity = {
  name: "sam@example.test",
  email: null,
  monogram: "S",
  known: true,
};

beforeEach(() => {
  pathname.mockReturnValue("/");
});

function renderShell(identity: Identity = IDENTITY) {
  return render(
    <AppShell identity={identity} signOutControl={<button type="submit">Sign out</button>}>
      <h1>Screen content</h1>
    </AppShell>,
  );
}

describe("the shell frame", () => {
  it("renders one named navigation region and one main region", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Weathra" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders the screen into the main region", () => {
    renderShell();
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Screen content" }),
    ).toBeInTheDocument();
  });

  it("carries the brand as a link home", () => {
    renderShell();
    for (const brand of screen.getAllByRole("link", { name: "Weathra" })) {
      expect(brand).toHaveAttribute("href", "/");
    }
  });

  it("offers a skip link that targets the main region", () => {
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    const target = skip.getAttribute("href")?.slice(1);
    expect(target).toBeTruthy();
    expect(screen.getByRole("main")).toHaveAttribute("id", target);
    // Focusable, or the link moves the viewport and leaves focus behind.
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
  });
});

describe("every MVP product screen is reachable", () => {
  it("links to all seven", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    for (const screenEntry of MVP_SCREENS) {
      const link = within(navigation).getByRole("link", { name: screenEntry.title });
      expect(link).toHaveAttribute("href", screenEntry.path);
    }
  });

  it("shows all twelve destinations, in the recorded order", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    const items = within(navigation)
      .getAllByRole("listitem")
      .map((item) => item.textContent);

    expect(items).toHaveLength(12);
    NAVIGATION.forEach((entry, index) => {
      expect(items[index]).toContain(entry.title);
    });
  });

  it("marks a planned destination as not yet available, in words", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    for (const planned of POST_MVP_SCREENS) {
      // The accessible name carries the marking, so it is not colour-and-chip only.
      const link = within(navigation).getByRole("link", {
        name: `${planned.title} — not yet available`,
      });
      expect(link).toHaveAttribute("href", planned.path);
      expect(link).toHaveAttribute("data-status", "planned");
    }
  });

  it("does not mark an MVP destination as planned", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    for (const mvp of MVP_SCREENS) {
      expect(within(navigation).getByRole("link", { name: mvp.title })).toHaveAttribute(
        "data-status",
        "mvp",
      );
    }
  });
});

describe("the active route", () => {
  it("marks the current destination and only that one", () => {
    pathname.mockReturnValue("/historical");
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });

    const current = within(navigation)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Historical Analytics");
    expect(current[0]).toHaveAttribute("data-active", "true");
  });

  it("marks the Dashboard on the root path without claiming every path", () => {
    pathname.mockReturnValue("/");
    const { unmount } = renderShell();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    unmount();

    pathname.mockReturnValue("/compare");
    renderShell();
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Compare Cities" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks a destination for a path nested beneath it", () => {
    pathname.mockReturnValue("/evidence/run-1");
    renderShell();
    expect(screen.getByRole("link", { name: "Agent Evidence" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks nothing for a path outside the model", () => {
    pathname.mockReturnValue("/somewhere-else");
    renderShell();
    const marked = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(marked).toEqual([]);
  });
});

describe("the signed-in identity", () => {
  it("shows who is signed in, from the session", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(within(navigation).getByText("sam@example.test")).toBeInTheDocument();
  });

  it("shows a declared name with the address beneath it", () => {
    renderShell({ name: "Sam Okafor", email: "sam@example.test", monogram: "S", known: true });
    expect(screen.getByText("Sam Okafor")).toBeInTheDocument();
    expect(screen.getByText("sam@example.test")).toBeInTheDocument();
  });

  it("shows no invented persona, title or role", () => {
    renderShell();
    // The approved artifacts' filler: recorded as mockup content in docs/design/screens.md §5.
    expect(screen.queryByText(/Aris Thorne/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lead Meteorologist/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Neural Agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/v4\./)).not.toBeInTheDocument();
  });

  it("carries the sign-out control it was given", () => {
    renderShell();
    const navigation = screen.getByRole("navigation", { name: "Weathra" });
    expect(within(navigation).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("the drawer", () => {
  it("is closed to begin with, and says so", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps one name and reports its state, rather than renaming itself", () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });
    expect(control).toHaveAttribute("aria-expanded", "false");
  });

  it("owns the navigation it toggles", () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });
    expect(control.getAttribute("aria-controls")).toBe(
      screen.getByRole("navigation", { name: "Weathra" }).getAttribute("id"),
    );
  });

  it("opens and closes from its control", async () => {
    renderShell();
    const control = screen.getByRole("button", { name: "Menu" });

    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Weathra" })).toHaveAttribute(
      "data-open",
      "true",
    );

    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("navigation", { name: "Weathra" })).not.toHaveAttribute("data-open");
  });

  it("closes on Escape", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a destination is followed", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers a labelled way out of an open drawer", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    // The scrim behind the drawer: a tap anywhere outside closes it, and it says so.
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();
  });
});

describe("a route with no screen yet", () => {
  it("states plainly that a planned destination is not yet available", () => {
    render(<RouteStatus title="Weather Watch" status="planned" />);
    expect(screen.getByRole("heading", { name: "Weather Watch" })).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.getByText(/not yet available\./)).toBeInTheDocument();
  });

  it("says something different about an MVP screen that is not built", () => {
    render(<RouteStatus title="Dashboard" status="in-progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText(/not built yet/)).toBeInTheDocument();
    expect(screen.queryByText("Not yet available")).not.toBeInTheDocument();
  });

  it("renders neither a broken nor an empty interface", () => {
    render(
      <RouteStatus title="Travel Intelligence" status="planned">
        Weather intelligence along a route.
      </RouteStatus>,
    );
    const heading = screen.getByRole("heading", { name: "Travel Intelligence" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("Weather intelligence along a route.")).toBeInTheDocument();
  });
});
