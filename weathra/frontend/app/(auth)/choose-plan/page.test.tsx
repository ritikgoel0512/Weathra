/**
 * `/choose-plan` — the route a new account is redirected to, through the page component.
 *
 * This file exists because of a production defect, and its shape follows from it. Creating an
 * account in production landed on `/choose-plan?email=…` and rendered Next.js's bare "Application
 * error: a client-side exception has occurred": the page mounted `PlanChoice`, `PlanChoice` called
 * `useApiQuery`, and nothing in the `(auth)` group provided the API client or the query cache that
 * hook needs — `SessionBoundary` mounts both, and it only wraps `(app)`. The first test below is
 * that crash, which is why it renders the *page*, not the component: a test that supplied a
 * provider itself would have passed against the broken build.
 *
 * The rest are the states this screen can actually be reached in. A person who has just handed over
 * an address is owed a way forward from every one of them, so each asserts the onward link as well
 * as the absence of a crash.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "@/lib/api/client";
import type { PlansResponse } from "@/lib/api/schema";
import { VERIFY_EMAIL_PATH } from "@/lib/routes";

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
}));

/**
 * The anonymous client the page builds for itself, replaced.
 *
 * `PublicDataBoundary` creates one through `createApiClient()`, which reads the public environment.
 * Intercepting it here keeps the test off the network while leaving the page's own wiring — the
 * part that was broken — exactly as it ships.
 */
const plans = vi.fn<() => Promise<PlansResponse>>();

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    createApiClient: () => ({ plans: () => plans() }) as unknown as ApiClient,
  };
});

/** `/plans` as production answers it: three tiers, Free the default, no self-service. */
function catalogue(): PlansResponse {
  return {
    count: 3,
    default_plan: "free",
    self_service: false,
    assignment_note: "Pro and Premium are assigned by Weathra rather than bought here.",
    plans: [
      {
        plan_code: "free",
        display_name: "Free",
        rank: 0,
        allowances: [
          { dimension: "concurrent_runs", window: "concurrent", allowance: 1 },
          { dimension: "requests_per_day", window: "day", allowance: 25 },
          { dimension: "tokens_per_month", window: "month", allowance: 500_000 },
        ],
      },
      {
        plan_code: "pro",
        display_name: "Pro",
        rank: 1,
        allowances: [
          { dimension: "concurrent_runs", window: "concurrent", allowance: 3 },
          { dimension: "requests_per_day", window: "day", allowance: 250 },
          { dimension: "tokens_per_month", window: "month", allowance: 8_000_000 },
        ],
      },
      {
        plan_code: "premium",
        display_name: "Premium",
        rank: 2,
        allowances: [
          { dimension: "concurrent_runs", window: "concurrent", allowance: 6 },
          { dimension: "requests_per_day", window: "day", allowance: 1_000 },
          { dimension: "tokens_per_month", window: "month", allowance: 40_000_000 },
        ],
      },
    ],
  } as PlansResponse;
}

const { default: ChoosePlanPage } = await import("./page");

/** The onward control, which must exist in every state this screen can be in. */
function onwardLink(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`a[href^="${VERIFY_EMAIL_PATH}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams("email=sam@example.test");
  plans.mockResolvedValue(catalogue());
  window.localStorage.clear();
});

describe("the signup crash", () => {
  it("renders the tiers instead of throwing, with no provider supplied by the test", async () => {
    // The regression itself. Before the fix this threw "useApiClient was called outside an
    // <ApiProvider>", which production renders as the bare application-error screen.
    render(<ChoosePlanPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Free" })).toBeTruthy();
    });
    expect(screen.getByRole("heading", { name: "Pro" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Premium" })).toBeTruthy();
  });
});

describe("the address in the query string", () => {
  it("carries a valid address to verification", async () => {
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Free" });

    expect(onwardLink()?.getAttribute("href")).toBe(
      `${VERIFY_EMAIL_PATH}?email=sam%40example.test`,
    );
  });

  it("still renders and still offers a way on when the parameter is missing", async () => {
    search = new URLSearchParams();
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Free" });

    // No address to prefill, so verification asks for one rather than the screen refusing.
    expect(onwardLink()?.getAttribute("href")).toBe(VERIFY_EMAIL_PATH);
  });

  it("drops a malformed address rather than carrying it or failing", async () => {
    search = new URLSearchParams("email=not-an-address");
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Free" });

    expect(onwardLink()?.getAttribute("href")).toBe(VERIFY_EMAIL_PATH);
  });
});

describe("what the backend answers", () => {
  it("shows the loading state while the tiers are being read", async () => {
    plans.mockReturnValue(new Promise(() => {}));
    render(<ChoosePlanPage />);

    expect(await screen.findByText("Reading the plans")).toBeTruthy();
  });

  it("keeps the way forward open when the tiers cannot be read", async () => {
    plans.mockRejectedValue(new Error("backend unreachable"));
    render(<ChoosePlanPage />);

    // `shouldRetry` gives an unreachable backend one more attempt before the view is told, so this
    // state arrives a retry-delay later than the others.
    expect(await screen.findByText("Plans unavailable", {}, { timeout: 5_000 })).toBeTruthy();
    expect(onwardLink()).not.toBeNull();
  });

  it("explains an empty catalogue rather than drawing a blank screen", async () => {
    plans.mockResolvedValue({ ...catalogue(), count: 0, plans: [] });
    render(<ChoosePlanPage />);

    expect(await screen.findByText(/No tiers are published right now/)).toBeTruthy();
    expect(onwardLink()).not.toBeNull();
  });

  it("survives an envelope whose plans field is not an array", async () => {
    // Not a shape the contract allows — which is the point. A malformed answer must not be the
    // difference between an onboarding screen and an application-error screen.
    plans.mockResolvedValue({ plans: null } as unknown as PlansResponse);
    render(<ChoosePlanPage />);

    expect(await screen.findByText(/No tiers are published right now/)).toBeTruthy();
  });

  it("survives a tier whose allowances are missing", async () => {
    const broken = catalogue();
    plans.mockResolvedValue({
      ...broken,
      plans: [{ ...broken.plans[0], allowances: undefined }],
    } as unknown as PlansResponse);
    render(<ChoosePlanPage />);

    expect(await screen.findByRole("heading", { name: "Free" })).toBeTruthy();
    expect(screen.getByText(/No allowance is configured/)).toBeTruthy();
  });
});

describe("what the tiers show", () => {
  it("draws each allowance as a figure from the backend, with a bar beside it", async () => {
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Free" });

    const premium = document.querySelector<HTMLElement>('[data-plan="premium"]')!;
    // The real row from `usage_limits`, not a number written into the frontend.
    expect(within(premium).getByText("1,000")).toBeTruthy();
    expect(within(premium).getByText("40,000,000")).toBeTruthy();

    // Premium holds the highest request allowance, so its bar is the full track.
    const requests = within(premium).getByRole("meter", { name: /Requests a day/ });
    expect(requests.getAttribute("aria-valuenow")).toBe("100");

    // Free's is the same figure drawn against that ceiling: 25 of 1,000.
    const free = document.querySelector<HTMLElement>('[data-plan="free"]')!;
    expect(
      within(free).getByRole("meter", { name: /Requests a day/ }).getAttribute("aria-valuenow"),
    ).toBe("3");
  });

  it("marks the default tier as the one the account is already on", async () => {
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Free" });

    const free = document.querySelector<HTMLElement>('[data-plan="free"]')!;
    expect(within(free).getByText("Your plan")).toBeTruthy();
    // Nothing to activate, so no control claiming to.
    expect(within(free).queryByRole("button")).toBeNull();
  });

  it("records a request for a higher tier without claiming it was granted", async () => {
    render(<ChoosePlanPage />);
    await screen.findByRole("heading", { name: "Pro" });

    const pro = document.querySelector<HTMLElement>('[data-plan="pro"]')!;
    const ask = within(pro).getByRole("button", { name: "Ask about Pro" });
    await userEvent.click(ask);

    expect(within(pro).getByRole("button", { name: "Requested" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(pro.getAttribute("data-chosen")).toBe("true");
    expect(window.localStorage.getItem("weathra.requested-plan")).toBe("pro");
  });
});
