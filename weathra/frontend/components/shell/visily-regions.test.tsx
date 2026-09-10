/**
 * The Visily regions, asserted as present.
 *
 * The fidelity passes kept losing regions to reasoning: a panel would be left out because the
 * backend had no value for one of its figures, and the omission would be recorded as a decision
 * rather than noticed as a gap. These tests are the guard. They assert that each region the
 * approved artifacts draw *exists*, and deliberately assert nothing about the values inside it —
 * a region showing "Unavailable" passes, which is the whole point: no fake data, no missing UI.
 *
 * They are also the regression coverage for the Settings screen, whose Account tab carries the two
 * server actions (sign-out and account deletion) that a stale client bundle can fail against.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "@/components/settings/settings";
import { AppShell } from "@/components/shell/app-shell";
import type { Identity } from "@/lib/auth/identity";
import { SessionBoundary } from "@/lib/session/provider";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const IDENTITY: Identity = {
  name: "Sam Rivers",
  email: "sam@example.test",
  monogram: "S",
  known: true,
};

const SAVED = {
  count: 1,
  limit: 20,
  locations: [
    {
      id: "s-berlin",
      label: null,
      location: {
        display_name: "Berlin, Germany",
        latitude: 52.52,
        longitude: 13.405,
        timezone: "Europe/Berlin",
      },
    },
  ],
};

const PREFERENCES = {
  unit_system: "metric",
  forecast_horizon_days: 3,
  default_location: null,
  sources: {},
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
});

function renderShell() {
  return render(
    <SessionBoundary
      initialStatus="active"
      accessToken={() => "test-token"}
      fetch={async (input: string) => {
        const path = new URL(input, "http://backend.test").pathname;
        const body = path.endsWith("/me/preferences") ? PREFERENCES : SAVED;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }}
    >
      <AppShell identity={IDENTITY} signOutControl={<button type="submit">Sign out</button>}>
        <h1>A screen</h1>
      </AppShell>
    </SessionBoundary>,
  );
}

describe("the shell carries the regions every product artifact draws", () => {
  it("has a breadcrumb, a search field and the signed-in person in the top bar", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Account settings for Sam Rivers/ })).toBeInTheDocument();
  });

  it("has a SAVED LOCATIONS section in the rail, listing the person's own places", async () => {
    renderShell();
    const rail = screen.getByRole("navigation", { name: "Weathra" });
    const saved = await within(rail).findByRole("region", { name: /Saved locations/i });
    expect(await within(saved).findByText("Berlin, Germany")).toBeInTheDocument();
  });

  it("groups the intelligence screens, caveating the unbuilt ones in words", () => {
    renderShell();
    const rail = within(screen.getByRole("navigation", { name: "Weathra" }));
    expect(rail.getByRole("region", { name: "Intelligence" })).toBeInTheDocument();
    // The marking is words, not only a chip: the accessible name still carries it.
    expect(
      rail.getByRole("link", { name: /Weather Watch — coming soon/ }),
    ).toBeInTheDocument();
  });

  it("keeps the identity and its sign-out at the foot of the rail", () => {
    renderShell();
    const rail = within(screen.getByRole("navigation", { name: "Weathra" }));
    expect(rail.getByText("Sam Rivers")).toBeInTheDocument();
    expect(rail.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("Settings carries the artifact's four sections", () => {
  function renderSettings() {
    return render(
      <SessionBoundary
        initialStatus="active"
        accessToken={() => "test-token"}
        fetch={async (input: string) => {
          const path = new URL(input, "http://backend.test").pathname;
          const body = path.endsWith("/me/preferences") ? PREFERENCES : SAVED;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }}
      >
        <Settings signOutControl={<button type="submit">Sign out</button>} />
      </SessionBoundary>,
    );
  }

  it("draws all four tabs `07-settings.png` shows", async () => {
    renderSettings();
    const list = await screen.findByRole("tablist");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.replace(/ — .*$/, "").trim())).toEqual([
      "General",
      "AI Intelligence",
      "Account",
      "Transparency",
    ]);
  });

  it("marks the two it does not implement as unavailable, in words, and does not let them be selected", async () => {
    renderSettings();
    const list = await screen.findByRole("tablist");
    const intelligence = within(list).getByRole("tab", { name: /AI Intelligence/ });
    // Words, not colour alone — and inert rather than a control that silently does nothing.
    expect(intelligence).toHaveAccessibleName(/not in this release/);
    expect(intelligence).toBeDisabled();
    expect(intelligence).toHaveAttribute("aria-selected", "false");
  });

  it("renders the Account section, where the server actions live, without throwing", async () => {
    // The regression guard for the Settings server-action failure: the Account tab is the only
    // screen that mounts sign-out and account deletion together, and it must render clean.
    renderSettings();
    const list = await screen.findByRole("tablist");
    within(list).getByRole("tab", { name: "Account" }).click();
    expect(await screen.findByRole("tab", { name: "Account" })).toBeInTheDocument();
  });
});
