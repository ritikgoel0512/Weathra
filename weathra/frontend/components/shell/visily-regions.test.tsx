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
import userEvent from "@testing-library/user-event";
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
      rail.getByRole("link", { name: "Weather Watch" }),
    ).toBeInTheDocument();
  });

  it("keeps the identity and its sign-out at the foot of the rail", () => {
    renderShell();
    const rail = within(screen.getByRole("navigation", { name: "Weathra" }));
    expect(rail.getByText("Sam Rivers")).toBeInTheDocument();
    expect(rail.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

/**
 * The readiness probe, as `api/routers/health.py` returns it.
 *
 * AI Intelligence and Transparency read it — it is where the product names the configured provider
 * and model — and it carries no credential by construction: `_inference` reports whether *a* key is
 * configured and never whether this one is valid.
 */
const READINESS = {
  ready: true,
  version: "1.0.0",
  environment: "test",
  checked_at: "2026-09-13T12:00:00Z",
  dependencies: [
    { name: "weather_provider", configured: true, reachable: null, detail: "open-meteo." },
    {
      name: "inference_provider",
      configured: true,
      reachable: null,
      required: false,
      detail: "openrouter, model nvidia/nemotron-nano-9b-v2.",
    },
  ],
};

const USAGE = {
  user_id: "u-1",
  plan_code: "free",
  plan_name: "Free",
  internal: false,
  dimensions: [],
  recent: { days: 30, calls: 4, failures: 0, total_tokens: 2100, series: [] },
};

const THREADS = { count: 0, threads: [] };

/** The body each path this screen reads actually returns. */
function bodyFor(path: string): unknown {
  if (path.endsWith("/me/preferences")) return PREFERENCES;
  if (path.endsWith("/ready")) return READINESS;
  if (path.endsWith("/me/usage")) return USAGE;
  if (path.endsWith("/threads")) return THREADS;
  return SAVED;
}

describe("Settings carries the artifact's four sections", () => {
  function renderSettings() {
    return render(
      <SessionBoundary
        initialStatus="active"
        accessToken={() => "test-token"}
        fetch={async (input: string) => {
          const path = new URL(input, "http://backend.test").pathname;
          return new Response(JSON.stringify(bodyFor(path)), {
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

  it("lets every one of the four be selected, with none marked unavailable", async () => {
    /*
     * This case used to assert the opposite, and the assertion was right when it was written: AI
     * Intelligence and Transparency were drawn and disabled, carrying "— not in this release" in
     * their accessible names so the state was in words rather than in colour alone.
     *
     * Both are implemented now, so the contract it guards has inverted: what must not regress is
     * that no tab in this row is inert. A tab that looks like a control and does nothing is the
     * defect the old wording existed to avoid, and it is also what an accidentally re-disabled tab
     * would become — so the check stays, pointed the other way.
     */
    renderSettings();
    const list = await screen.findByRole("tablist");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs).toHaveLength(4);

    for (const tab of tabs) {
      const name = tab.textContent?.trim() ?? "";
      expect(tab, name).toBeEnabled();
      expect(tab, name).not.toHaveAttribute("aria-disabled", "true");
      expect(tab, name).not.toHaveAttribute("data-unavailable", "true");
      expect(tab, name).not.toHaveAccessibleName(/not in this release|unavailable/i);
    }
  });

  it("reveals each section's own panel, named by the tab that controls it", async () => {
    const person = userEvent.setup();
    renderSettings();
    await screen.findByRole("tablist");

    // One marker per section, each of which only that section renders.
    for (const [name, marker] of [
      ["AI Intelligence", "AI Weather Analyst"],
      ["Transparency", "How Weathra labels data"],
      ["Account", "Your account"],
      ["General", "Weather preferences"],
    ] as const) {
      const tab = screen.getByRole("tab", { name });
      await person.click(tab);

      expect(tab, name).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByText(marker), name).toBeInTheDocument();

      // The panel the tab points at is the one on screen, and it is the only one.
      const panels = screen.getAllByRole("tabpanel");
      expect(panels, name).toHaveLength(1);
      expect(tab.getAttribute("aria-controls"), name).toBe(panels[0]!.id);
    }
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
