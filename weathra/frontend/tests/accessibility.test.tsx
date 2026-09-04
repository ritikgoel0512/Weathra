/**
 * The accessibility audit across every MVP screen — task 21.8's automated half.
 *
 * `specs/web-ui` requires keyboard operation of every action, a label on every input and an
 * accessible name on every interactive control, across authentication and product screens alike.
 * This renders each of them — the real screens, through the real API client and the real session
 * boundary, populated from `tests/fixtures/backend.ts` — and runs `auditAccessibility` over what
 * came out. A screen is audited in the states a person actually meets: populated, and where the
 * screen has one, its chooser, its confirmation, and its error.
 *
 * **What this half cannot see.** jsdom has no layout and no cascade. It cannot tell whether a focus
 * ring is visible, whether text meets its contrast as rendered, or whether a page overflows at 360
 * pixels. Those are browser facts: the tokens are checked arithmetically in
 * `lib/design/contrast.test.ts`, the stylesheets structurally in `tests/design-rules.test.ts`, and
 * the rendered result in a real Chromium at three viewports in `tests/e2e/accessibility.spec.ts`.
 * Nothing here is offered as covering them.
 */

import { render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { Analyst } from "@/components/analyst/analyst";
import { CompareCities } from "@/components/compare/compare";
import { Dashboard } from "@/components/dashboard/dashboard";
import { AgentEvidence } from "@/components/evidence/evidence";
import { HistoricalAnalytics } from "@/components/historical/historical";
import { CandidateChoice, CHOICE_REQUIRED_TITLE } from "@/components/locations/candidate-choice";
import { SavedLocations } from "@/components/locations/locations";
import { SessionExpiredState } from "@/components/session/session-expired";
import { Settings } from "@/components/settings/settings";
import { AppShell } from "@/components/shell/app-shell";
import { auditAccessibility, formatFindings, interactiveElements } from "./accessibility/audit";
import { SessionBoundary } from "@/lib/session/provider";

import { BACKEND_FIXTURES, SPRINGFIELD_IL, SPRINGFIELD_MO } from "./fixtures/backend";

vi.mock("@/lib/supabase/browser", () => ({
  browserAccessToken: async () => "test-access-token",
  supabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: async () => ({ data: { session: null, user: null }, error: null }),
      signUp: async () => ({ data: { session: null, user: null }, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: { user: null }, error: null }),
      resend: async () => ({ data: {}, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth/sign-out", () => ({ signOut: async () => {} }));

/**
 * The server-resolved session, for the two authentication screens that read it.
 *
 * Verify Email's success state and Reset Password both ask Supabase server-side before they show
 * anything — which is the right behaviour and is covered by their own suites. Here they are stood
 * in for so the *rendered markup* can be audited without a request scope.
 */
vi.mock("@/lib/supabase/server", () => ({
  currentUser: async () => ({
    id: "1",
    email: "person@example.test",
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
  }),
  supabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

/* --------------------------------------------------------------------- harness */

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

/** Every screen's reads answered from the shared fixture map; anything unmodelled fails loudly. */
function backend(overrides: Readonly<Record<string, unknown>> = {}) {
  return vi.fn(async (input: string, _init?: RequestInit) => {
    const path = new URL(input).pathname;
    const body = path in overrides ? overrides[path] : BACKEND_FIXTURES[path];
    if (body === undefined) {
      return jsonResponse(404, {
        error: { code: "route_not_found", message: `No fixture for ${path}`, details: null, request_id: "r" },
      });
    }
    return jsonResponse(200, body);
  }) as unknown as Mock;
}

function mount(ui: React.ReactNode): RenderResult {
  return render(
    <SessionBoundary initialStatus="active" accessToken={() => "t"} fetch={(input, init) => fetchMock(input, init)}>
      {ui}
    </SessionBoundary>,
  );
}

/**
 * The audit, as an assertion.
 *
 * Failures are printed as lines naming the rule and the element, because "3 findings" is not
 * something anybody can act on.
 */
function expectAccessible(container: HTMLElement): void {
  const findings = auditAccessibility(container, document);
  expect(findings, `accessibility findings:\n${formatFindings(findings)}`).toEqual([]);
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key";
  fetchMock = backend();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/* ------------------------------------------------------ authentication screens */

describe("the authentication screens", () => {
  const screens: readonly [string, () => Promise<React.ReactNode>][] = [
    ["Sign In", async () => (await import("@/app/(auth)/sign-in/page")).default({ searchParams: Promise.resolve({}) })],
    ["Create Account", async () => (await import("@/app/(auth)/create-account/page")).default()],
    ["Verify Email", async () => (await import("@/app/(auth)/verify-email/page")).default({ searchParams: Promise.resolve({}) })],
    ["Verify Email, just confirmed", async () => (await import("@/app/(auth)/verify-email/page")).default({ searchParams: Promise.resolve({ completed: "verification" }) })],
    ["Forgot Password", async () => (await import("@/app/(auth)/forgot-password/page")).default()],
    ["Reset Password", async () => (await import("@/app/(auth)/reset-password/page")).default({ searchParams: Promise.resolve({ completed: "recovery" }) })],
  ];

  for (const [name, load] of screens) {
    it(`${name} labels every input and names every control`, async () => {
      const { container } = render(await load());
      expectAccessible(container);
      // Every screen offers at least one thing to do, and it is reachable.
      expect(interactiveElements(container).length).toBeGreaterThan(0);
    });
  }
});

/* ------------------------------------------------------------ product screens */

describe("the Dashboard", () => {
  it("labels every input and names every control, populated", async () => {
    const { container } = mount(<Dashboard />);
    await screen.findByRole("region", { name: "Current conditions" });
    expectAccessible(container);
  });

  it("stays accessible while it is asking which place was meant", async () => {
    const person = userEvent.setup();
    const { container } = mount(<Dashboard />);
    await screen.findByRole("region", { name: "Current conditions" });

    await person.type(screen.getByLabelText("Brief me on a place"), "Springfield");
    await person.click(screen.getByRole("button", { name: "Show briefing" }));
    await screen.findByRole("group", { name: "Places matching what you entered" });

    expectAccessible(container);
    // The question is reachable from a heading list, at the level this screen needs: the chooser
    // sits directly under the h1, before any section, so a third-level heading here would skip one.
    expect(
      screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE, level: 2 }),
    ).toBeInTheDocument();
  });

  it("stays accessible in its error state", async () => {
    fetchMock = backend({
      "/api/v1/me/preferences": undefined,
    });
    const { container } = mount(<Dashboard />);
    await screen.findByRole("alert");
    expectAccessible(container);
  });
});

describe("the AI Weather Analyst", () => {
  it("labels its composer and names every control", async () => {
    const { container } = mount(<Analyst />);
    await screen.findByLabelText("Your weather question");
    expectAccessible(container);
  });

  it("stays accessible with an answer on screen, progress list and all", async () => {
    const { AnswerView, RunProgress } = await import("@/components/analyst/sections");
    const envelope = (BACKEND_FIXTURES["/api/v1/evidence/run-audit"] as {
      envelope: Record<string, unknown>;
      evidence: Record<string, unknown>;
    });

    const { container } = render(
      <div>
        <h1>AI Weather Analyst</h1>
        <RunProgress
          streaming={false}
          steps={[
            {
              id: "1",
              kind: "agent",
              label: "Forecast agent",
              detail: "Retrieved the window.",
              status: "succeeded",
              durationMs: 840,
              agent: "forecast",
            },
          ]}
        />
        <AnswerView
          answer={{ ...envelope.envelope, evidence: envelope.evidence } as never}
          evidenceId="run-audit"
        />
      </div>,
    );

    expectAccessible(container);
  });
});

describe("Historical Analytics", () => {
  it("labels every control, populated, including the charts' figure tables", async () => {
    const { container } = mount(<HistoricalAnalytics />);
    await screen.findByRole("region", { name: "Recorded observations" });
    expectAccessible(container);
  });
});

describe("Compare Cities", () => {
  it("labels every row and names every control", async () => {
    const { container } = mount(<CompareCities />);
    await screen.findByLabelText("Location 1");
    expectAccessible(container);
  });

  it("stays accessible with a ranking on screen", async () => {
    fetchMock = backend({
      "/api/v1/locations/resolve": {
        kind: "resolved",
        query: "Munich",
        location: { ...SPRINGFIELD_MO, display_name: "Munich" },
      },
    });
    const { container } = mount(<CompareCities />);
    await screen.findByLabelText("Location 1");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByRole("region", { name: "Ranked by warmest" });
    expectAccessible(container);
  });

  it("stays accessible while a row is asking which place was meant", async () => {
    const { container } = mount(<CompareCities />);
    await screen.findByLabelText("Location 1");

    const person = userEvent.setup();
    await person.clear(screen.getByLabelText("Location 2"));
    await person.type(screen.getByLabelText("Location 2"), "Springfield");
    await person.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByRole("group", { name: "Places matching location 2" });

    expectAccessible(container);
    // Like the Dashboard, Compare Cities places the chooser under its h1 with no section heading in
    // between, so this one is second-level too. Its group label is what tells several rows apart.
    expect(
      screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE, level: 2 }),
    ).toBeInTheDocument();
  });
});

describe("Agent Evidence", () => {
  it("labels every control and gives its tables scoped headers", async () => {
    const { container } = mount(<AgentEvidence evidenceId="run-audit" />);
    await screen.findByRole("region", { name: "Execution flow" });
    expectAccessible(container);
  });

  it("stays accessible in its not-found state", async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse(404, {
        error: {
          code: "evidence_not_found",
          message: "No evidence record with that identifier.",
          details: null,
          request_id: "r",
        },
      }),
    ) as unknown as Mock;

    const { container } = mount(<AgentEvidence evidenceId="nope" />);
    await screen.findByText("No evidence record with that identifier");
    expectAccessible(container);
  });
});

describe("Saved Locations", () => {
  it("labels every input and names every control, populated", async () => {
    const { container } = mount(<SavedLocations />);
    await screen.findByRole("region", { name: "Your saved locations" });
    expectAccessible(container);
  });

  it("stays accessible while it is asking which place was meant", async () => {
    const person = userEvent.setup();
    const { container } = mount(<SavedLocations />);
    await screen.findByRole("region", { name: "Your saved locations" });

    await person.type(screen.getByLabelText("Place"), "Springfield");
    await person.click(screen.getByRole("button", { name: "Save location" }));
    await screen.findByRole("group", { name: "Places matching what you entered" });

    expectAccessible(container);
    // Nested inside this screen's own "Add a location" panel, which is an h2 — so here the question
    // is a third-level heading, and a second-level one would misdescribe the panel it belongs to.
    expect(
      screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE, level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add a location", level: 2 })).toBeInTheDocument();
  });

  it("stays accessible with an empty list", async () => {
    fetchMock = backend({ "/api/v1/me/locations": { count: 0, limit: 20, locations: [] } });
    const { container } = mount(<SavedLocations />);
    await screen.findByText("You have not saved any locations yet");
    expectAccessible(container);
  });
});

describe("Settings", () => {
  it("labels every preference control", async () => {
    const { container } = mount(<Settings signOutControl={<button type="button">Sign out</button>} />);
    await screen.findByRole("form", { name: "Your Weathra preferences" });
    expectAccessible(container);
  });

  it("stays accessible on the Account tab, and inside both confirmations", async () => {
    const person = userEvent.setup();
    const { container } = mount(
      <Settings signOutControl={<button type="button">Sign out</button>} />,
    );
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    await person.click(screen.getByRole("tab", { name: "Account" }));
    await screen.findByRole("region", { name: "Conversation memory" });
    expectAccessible(container);

    // Both destructive confirmations, which are the screens' only dialog-shaped surfaces.
    await person.click(screen.getByRole("button", { name: "Delete this conversation" }));
    await person.click(screen.getByRole("button", { name: "Delete my Weathra data" }));
    expect(
      screen.getByRole("group", { name: "Delete every Weathra record belonging to you?" }),
    ).toBeInTheDocument();
    expectAccessible(container);
  });
});

describe("every product screen names itself", () => {
  /**
   * One top-level heading per screen — task 21.8.
   *
   * The Dashboard had none: its sections carried headings and the page they belonged to did not, so
   * a heading-list navigation of `/` described the parts without naming the whole. Asserted here so
   * a screen added later cannot ship without one.
   */
  const screens: readonly [string, string, () => React.ReactNode][] = [
    ["Dashboard", "Dashboard", () => <Dashboard />],
    ["AI Weather Analyst", "AI Weather Analyst", () => <Analyst />],
    ["Historical Analytics", "Historical Analytics", () => <HistoricalAnalytics />],
    ["Compare Cities", "Compare Cities", () => <CompareCities />],
    ["Agent Evidence", "Agent evidence", () => <AgentEvidence evidenceId="run-audit" />],
    ["Saved Locations", "Saved Locations", () => <SavedLocations />],
    ["Settings", "Settings", () => <Settings />],
  ];

  for (const [name, heading, build] of screens) {
    it(`${name} carries exactly one h1`, async () => {
      const view = mount(build());
      const found = await screen.findByRole("heading", { level: 1 });
      expect(found).toHaveTextContent(heading);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      view.unmount();
    });
  }
});

/* ---------------------------------------------------------- shared surfaces */

describe("the shared surfaces", () => {
  it("names every control in the application shell, including the drawer control", () => {
    const { container } = render(
      <AppShell
        identity={{ name: "person@example.test", email: "person@example.test", monogram: "P", known: true }}
        signOutControl={<button type="button">Sign out</button>}
      >
        <h1>A screen</h1>
      </AppShell>,
    );

    expectAccessible(container);
    // The icon-only-looking drawer control carries a real name, and the navigation is a landmark.
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Weathra" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
  });

  it("conveys the current navigation entry without relying on colour", () => {
    render(
      <AppShell identity={{ name: "p", email: "p@example.test", monogram: "P", known: true }}>
        <h1>A screen</h1>
      </AppShell>,
    );

    // `usePathname` is mocked to "/", so the Dashboard entry is the current one.
    const current = screen.getByRole("link", { name: /Dashboard/ });
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("names the control in the expired-session state and moves focus to it", async () => {
    const { container } = render(<SessionExpiredState />);
    expectAccessible(container);

    const action = screen.getByRole("link", { name: "Sign in again" });
    await waitFor(() => expect(action).toHaveFocus());
    // The state announces itself: it replaced the screen somebody was reading.
    expect(screen.getByRole("alert")).toHaveTextContent("Your session has expired");
  });

  it("names every candidate in the chooser and preselects none", () => {
    const { container } = render(
      <CandidateChoice
        resolution={{
          kind: "ambiguous",
          query: "Springfield",
          candidates: [SPRINGFIELD_IL, SPRINGFIELD_MO],
          message: "'Springfield' matches more than one place.",
        }}
        onChoose={() => {}}
        label="Places matching what you entered"
      />,
    );

    expectAccessible(container);
    // The question this panel exists to ask is a heading, so a heading list reaches it. It was a
    // styled paragraph until task 21.8's manual pass found it by ear.
    expect(screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Places matching what you entered" });
    const candidates = within(group).getAllByRole("button");
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate).toHaveAccessibleName();
      expect(candidate).not.toHaveFocus();
    }
  });
});

/* -------------------------------------------------------------- keyboard reach */

describe("keyboard-only operation", () => {
  /**
   * Every control on a screen is reachable in document order.
   *
   * Tab order is asserted as *document order* rather than by pressing Tab through every control:
   * jsdom's Tab is Testing Library's own implementation of the same rule, so walking the interactive
   * elements and confirming each accepts focus in that order tests the property without testing the
   * simulation. That no control is skipped is the `named-controls` and `document-tab-order` rules
   * above; that focus is *visible* is asserted in a browser.
   */
  function expectReachableInOrder(container: HTMLElement): void {
    const controls = interactiveElements(container);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  }

  it("reaches every control on the Dashboard", async () => {
    const { container } = mount(<Dashboard />);
    await screen.findByRole("region", { name: "Current conditions" });
    expectReachableInOrder(container);
  });

  it("reaches every control on Compare Cities", async () => {
    const { container } = mount(<CompareCities />);
    await screen.findByLabelText("Location 1");
    expectReachableInOrder(container);
  });

  it("reaches every control on Agent Evidence, including its disclosures", async () => {
    const { container } = mount(<AgentEvidence evidenceId="run-audit" />);
    await screen.findByRole("region", { name: "Execution flow" });
    expectReachableInOrder(container);
  });

  it("reaches every control on Settings", async () => {
    const { container } = mount(
      <Settings signOutControl={<button type="button">Sign out</button>} />,
    );
    await screen.findByRole("form", { name: "Your Weathra preferences" });
    expectReachableInOrder(container);
  });

  it("reaches every control on Saved Locations and Historical Analytics", async () => {
    const saved = mount(<SavedLocations />);
    await screen.findByRole("region", { name: "Your saved locations" });
    expectReachableInOrder(saved.container);
    saved.unmount();

    const historical = mount(<HistoricalAnalytics />);
    await screen.findByRole("region", { name: "Recorded observations" });
    expectReachableInOrder(historical.container);
  });

  it("submits the Analyst from the keyboard alone, and moves the tabs with the arrow keys", async () => {
    const person = userEvent.setup();
    mount(<Settings signOutControl={<button type="button">Sign out</button>} />);
    await screen.findByRole("form", { name: "Your Weathra preferences" });

    // A tablist is one tab stop, and the arrow keys move within it.
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    await person.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");
    await person.keyboard("{ArrowLeft}");
    expect(general).toHaveAttribute("aria-selected", "true");
  });

  it("closes the navigation drawer with Escape, and leaves focus somewhere real", async () => {
    const person = userEvent.setup();
    render(
      <AppShell identity={{ name: "p", email: "p@example.test", monogram: "P", known: true }}>
        <h1>A screen</h1>
      </AppShell>,
    );

    const control = screen.getByRole("button", { name: "Menu" });
    await person.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");

    await person.keyboard("{Escape}");
    expect(control).toHaveAttribute("aria-expanded", "false");
    // Not a trap: the control that opened it is still where focus can be, and is still named.
    expect(control).toHaveAccessibleName("Menu");
  });

  it("chooses a candidate with Enter, from the keyboard alone", async () => {
    const person = userEvent.setup();
    mount(<SavedLocations />);
    await screen.findByRole("region", { name: "Your saved locations" });

    await person.type(screen.getByLabelText("Place"), "Springfield");
    await person.click(screen.getByRole("button", { name: "Save location" }));
    const group = await screen.findByRole("group", { name: "Places matching what you entered" });

    const candidates = within(group).getAllByRole("button");
    candidates[0]!.focus();
    await person.keyboard("{Enter}");

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [string, RequestInit][]).some(
          ([, init]) => (init?.method ?? "GET") === "POST",
        ),
      ).toBe(true),
    );
  });
});
