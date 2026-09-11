/**
 * The plan step — task 34.21.
 *
 * Two things are worth asserting, and the second is the one that matters.
 *
 * The tiers come from the backend: their names, their order and their allowances are rows, so a
 * fourth tier appearing in the database appears here and a price written into the frontend cannot.
 *
 * And **nothing on the screen claims to sell anything.** Weathra has no payment integration, so a
 * card offering to buy a tier, or a Free card claiming to have activated one, would describe a
 * commercial relationship and a write that do not exist. The backend states that in the contract
 * through `self_service`, and the screen is held to it here.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import type { PlansResponse } from "@/lib/api/schema";
import { createQueryClient } from "@/lib/query/provider";

import { PlanChoice } from "./plan-choice";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("email=sam%40example.test"),
}));

const PLANS: PlansResponse = {
  count: 3,
  default_plan: "free",
  self_service: false,
  assignment_note:
    "Free is what every new account is on. Pro and Premium are assigned by Weathra rather than bought here.",
  plans: [
    {
      plan_code: "free",
      display_name: "Free",
      rank: 0,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: 30 }],
    },
    {
      plan_code: "pro",
      display_name: "Pro",
      rank: 1,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: 300 }],
    },
    {
      plan_code: "premium",
      display_name: "Premium",
      rank: 2,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: null }],
    },
  ],
};

function client(plans: PlansResponse | Error = PLANS): ApiClient {
  return {
    plans: vi.fn(() => (plans instanceof Error ? Promise.reject(plans) : Promise.resolve(plans))),
  } as unknown as ApiClient;
}

function mount(api: ApiClient = client()) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <PlanChoice />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the tiers", () => {
  it("shows the three the backend returned, in its order", async () => {
    mount();
    expect(await screen.findByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Premium")).toBeInTheDocument();
  });

  it("names no tier the backend did not send", async () => {
    mount();
    await screen.findByText("Free");
    // The retired tier, asserted by name because its absence is a product decision rather than an
    // accident of this fixture.
    expect(screen.queryByText(/plus/i)).toBeNull();
  });

  it("reads each allowance off the response, and calls an absent cap unlimited", async () => {
    mount();

    /*
     * Each allowance is now a `Meter` — the measure and window name it, the figure is printed
     * beside the bar — rather than one "Requests: 30 a day" line. The assertion is the same
     * question asked of the new shape: the figures are the backend's, and an absent cap reads as
     * unlimited rather than as zero or as a missing value.
     */
    const bars = await screen.findAllByRole("meter", { name: "Requests a day" });
    expect(bars.map((bar) => bar.getAttribute("aria-valuetext"))).toEqual([
      "30",
      "300",
      "Unlimited",
    ]);
  });

  it("draws each tier's allowance against the highest tier's, so the bars compare", async () => {
    mount();

    const bars = await screen.findAllByRole("meter", { name: "Requests a day" });
    // 30 against the 300 ceiling, then the ceiling itself, then an uncapped tier at full track.
    expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["10", "100", "100"]);
  });
});

describe("what the screen does not claim", () => {
  it("marks the default tier as the one the account is already on, with nothing to activate", async () => {
    mount();
    expect(await screen.findByText("Current plan")).toBeInTheDocument();
    expect(screen.getByText(/Every new account starts here/)).toBeInTheDocument();
  });

  it("offers no purchase, no checkout and no upgrade", async () => {
    mount();
    await screen.findByText("Free");
    for (const forbidden of [/buy/i, /checkout/i, /pay/i, /card/i, /subscribe/i, /upgrade now/i]) {
      expect(screen.queryByRole("button", { name: forbidden })).toBeNull();
    }
  });

  it("chooses a paid tier the way a product does, and says what that does and does not do", async () => {
    // The previous interaction was "Ask about Pro" → "Requested", which is truthful and reads as an
    // internal approval queue. The truth is unchanged; only the way it is said is.
    const person = userEvent.setup();
    mount();
    await person.click(await screen.findByRole("button", { name: "Choose Pro" }));

    expect(screen.getByRole("button", { name: "Selected" })).toBeInTheDocument();
    expect(screen.getByText("Pro selected")).toBeInTheDocument();
    expect(screen.getByText(/Paid checkout is not enabled yet/)).toBeInTheDocument();
    // The commercial boundary is stated, and no entitlement is implied.
    expect(screen.getByText(/stays on Free/)).toBeInTheDocument();
  });

  it("names the chosen tier on the step's primary action", async () => {
    const person = userEvent.setup();
    mount();
    await screen.findByText("Free");
    expect(screen.getByRole("link", { name: "Continue" })).toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "Choose Premium" }));
    expect(screen.getByRole("link", { name: "Continue with Premium" })).toBeInTheDocument();
  });

  it("carries the address forward so verification does not ask for it again", async () => {
    mount();
    const onwards = await screen.findByRole("link", { name: "Continue" });
    expect(onwards).toHaveAttribute("href", "/verify-email?email=sam%40example.test");
  });
});

describe("when the tiers cannot be read", () => {
  it("still lets somebody continue, because the account already exists", async () => {
    mount(client(new Error("network")));
    // The query layer retries a network failure before it settles, so this waits for the settled
    // state rather than the first render.
    const onwards = await screen.findByRole(
      "link",
      { name: "Continue to verification" },
      { timeout: 5000 },
    );
    expect(onwards).toHaveAttribute("href", "/verify-email?email=sam%40example.test");
  });
});
