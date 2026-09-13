/**
 * Plan & Usage — task 34.10.
 *
 * What is asserted is what `specs/web-ui` requires of the view and what the artifact's refusals
 * require of it: the person's own plan name, consumption against allowance per dimension and each
 * window's reset time; no other person's usage, no cross-user total; and none of the billing,
 * export or infrastructure content `docs/design/screens.md` §5 refuses.
 *
 * The last group is the one worth having. A screen built from an artifact drifts toward the
 * artifact, and the fields it draws — a subscription id, a card ending in four digits, an upgrade
 * button — are the ones a reviewer would read as a commercial relationship Weathra does not have.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import type { UsageResponse } from "@/lib/api/schema";
import { createQueryClient } from "@/lib/query/provider";

import { PlanUsage } from "./plan-usage";

const FREE: UsageResponse = {
  user_id: "00000000-0000-4000-8000-000000000001",
  plan_code: "free",
  plan_name: "Free",
  internal: false,
  dimensions: [
    {
      dimension: "requests_per_day",
      window: "day",
      allowance: 30,
      consumed: 12,
      remaining: 18,
      resets_at: "2026-09-11T00:00:00Z",
    },
    {
      dimension: "tokens_per_month",
      window: "month",
      allowance: 100000,
      consumed: 25000,
      remaining: 75000,
      resets_at: "2026-10-01T00:00:00Z",
    },
    {
      dimension: "concurrent_runs",
      window: "concurrent",
      allowance: 2,
      consumed: 0,
      remaining: 2,
      resets_at: null,
    },
  ],
  recent: { days: 7, calls: 41, failures: 2, total_tokens: 31925 },
};

const TIERS = {
  default_plan: "free",
  self_service: true,
  assignment_note: "Pricing is not published, and changing tier does not charge your account.",
  count: 3,
  plans: [
    {
      plan_code: "free",
      model_tier: "economy",
      display_name: "Free",
      rank: 1,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: 30 }],
    },
    {
      plan_code: "pro",
      model_tier: "standard",
      display_name: "Pro",
      rank: 2,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: 300 }],
    },
    {
      plan_code: "premium",
      model_tier: "frontier",
      display_name: "Premium",
      rank: 3,
      allowances: [{ dimension: "requests_per_day", window: "day", allowance: 1000 }],
    },
  ],
};

/** The same account on a different tier, so a *current* assertion means something. */
function on(plan_code: string, plan_name: string, allowance = 30): UsageResponse {
  return {
    ...FREE,
    plan_code,
    plan_name,
    dimensions: FREE.dimensions.map((dimension) =>
      dimension.dimension === "requests_per_day"
        ? { ...dimension, allowance, remaining: Math.max(0, allowance - dimension.consumed) }
        : dimension,
    ),
  };
}

interface Harness {
  readonly api: ApiClient;
  readonly choosePlan: ReturnType<typeof vi.fn>;
}

/**
 * A client whose `usage()` answers with whatever the last accepted plan change produced.
 *
 * The point of most cases below is that the screen re-reads rather than patching what it drew, so
 * the fake has to be able to *disagree* with the mutation's own response. It cannot if `usage()`
 * returns a constant.
 */
function harness(
  usage: UsageResponse | Error = FREE,
  options: { readonly failure?: Error } = {},
): Harness {
  let current = usage;
  const choosePlan = vi.fn((request: { plan_code: string }) => {
    if (options.failure) return Promise.reject(options.failure);
    const names: Record<string, [string, number]> = {
      free: ["Free", 30],
      pro: ["Pro", 300],
      premium: ["Premium", 1000],
    };
    const [name, allowance] = names[request.plan_code] ?? [request.plan_code, 30];
    current = on(request.plan_code, name, allowance);
    return Promise.resolve(current);
  });
  return {
    choosePlan,
    api: {
      usage: vi.fn(() =>
        current instanceof Error ? Promise.reject(current) : Promise.resolve(current),
      ),
      plans: vi.fn(() => Promise.resolve(TIERS)),
      choosePlan,
    } as unknown as ApiClient,
  };
}

function client(usage: UsageResponse | Error = FREE): ApiClient {
  return harness(usage).api;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <PlanUsage />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the person's own plan", () => {
  it("names the tier in effect once, at the top, and marks it as current", async () => {
    mount(client());
    const panel = (await screen.findByRole("heading", { name: "Current tier" })).closest(
      "section",
    )!;

    expect(within(panel).getByText("Free")).toBeInTheDocument();
    expect(within(panel).getByText("Current")).toBeInTheDocument();
    // The other two tiers are compared below, not offered here: one place to change plan.
    expect(within(panel).queryByText("Pro")).toBeNull();
    expect(within(panel).queryByText("Premium")).toBeNull();
    // The retired tier is unwritable in the database and unnameable here.
    expect(screen.queryByText(/\bplus\b/i)).toBeNull();
  });

  it("describes the tier from its own configured allowances, and names its model class", async () => {
    mount(client(on("pro", "Pro", 300)));
    // The description needs `/plans`, which lands after the usage read the panel first draws from.
    // ("Standard model" also names Pro's column in the comparison, so this waits on the sentence.)
    await screen.findByText(/Standard model, where Free uses the economy model/);
    const panel = screen.getByRole("heading", { name: "Current tier" }).closest("section")!;

    expect(within(panel).getByText("Pro")).toBeInTheDocument();
    // Derived, not written: the model class is what changes between these two tiers, so that is
    // what the sentence says — and it says it in the backend's own product vocabulary.
    expect(
      within(panel).getByText(/Standard model, where Free uses the economy model/),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Standard model")).toBeInTheDocument();
    // A product-level class, never a gateway identifier.
    expect(panel.textContent ?? "").not.toMatch(/\//);
  });

  it("points at the plans rather than at who administers them", async () => {
    // This said "Plan changes are made by a Weathra administrator. There is no self-service
    // checkout." — true, and a description of Weathra's internal process on a customer's account
    // page. The boundary is still stated, in the Billing card, where it belongs.
    mount(client());
    await screen.findByText(/Change tier in/);

    expect(screen.queryByText(/administrator/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade now/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /upgrade/i })).toBeNull();
  });
});

describe("consumption against allowance", () => {
  it("shows each dimension's used, allowance and remaining", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Allowances" });

    // Each dimension is named. "Requests per day" also names the reset row and the tile note, so
    // the row is found by its own list item rather than by the first match of the label.
    for (const label of ["Requests per day", "Tokens per month", "Concurrent runs"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    /*
     * The row carries the artifact's four figures: the consumed value at metric size, the
     * allowance it is against with its unit, the share, and the consumed/remaining pair beneath
     * the bar. Asserted as facts rather than as one sentence, because the composition changed to
     * `10-plan-usage.png`'s and the information is what has to survive that, not the phrasing.
     */
    const rows = screen.getAllByRole("listitem");
    const requests = rows.find((row) => /Remaining: 18/.test(row.textContent ?? ""));
    expect(requests, "no allowance row for requests_per_day").toBeDefined();

    const row = requests as HTMLElement;
    expect(within(row).getByText("12")).toBeInTheDocument();
    expect(within(row).getByText(/\/ 30 req/)).toBeInTheDocument();
    expect(within(row).getByText("40% used")).toBeInTheDocument();
    expect(within(row).getByText("Consumed: 12")).toBeInTheDocument();
  });

  it("states each window's reset instant", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Reset windows" });

    // Two windowed dimensions are scheduled; concurrency has no window and is not given a
    // fabricated one — it falls as soon as a run finishes, which is not a date.
    const resets = screen.getByRole("heading", { name: "Reset windows" }).closest("section")!;
    const scheduled = within(resets)
      .getAllByRole("listitem")
      .filter((row) => /Sep|Oct/.test(row.textContent ?? ""));
    expect(scheduled).toHaveLength(2);
    expect(scheduled.some((row) => /Concurrent runs/.test(row.textContent ?? ""))).toBe(false);
  });

  it("reports a token count the gateway did not send as unreported, never as zero", async () => {
    mount(client({ ...FREE, recent: { days: 7, calls: 3, failures: 0, total_tokens: null } }));
    await screen.findByRole("heading", { name: "Plan & Usage" });

    expect(screen.getByText("Not reported by the gateway")).toBeInTheDocument();
  });

  it("says unlimited where a plan sets no allowance, rather than showing a full bar", async () => {
    mount(
      client({
        ...FREE,
        dimensions: [
          {
            dimension: "requests_per_day",
            window: "day",
            allowance: null,
            consumed: 900,
            remaining: null,
            resets_at: null,
          },
        ],
      }),
    );
    await screen.findByRole("heading", { name: "Allowances" });

    // The consumed figure keeps its prominence; what is absent is a bar, because a share of an
    // unlimited allowance is not a quantity and a full one would claim exhaustion.
    expect(screen.getByText(/unlimited on your plan/i)).toBeInTheDocument();
    expect(screen.getByText("900")).toBeInTheDocument();
    expect(screen.queryByText(/% used/)).toBeNull();
  });

  it("points at a dimension close to its allowance", async () => {
    mount(
      client({
        ...FREE,
        dimensions: [
          {
            dimension: "requests_per_day",
            window: "day",
            allowance: 30,
            consumed: 29,
            remaining: 1,
            resets_at: "2026-09-11T00:00:00Z",
          },
        ],
      }),
    );
    expect(await screen.findByText("Approaching a limit")).toBeInTheDocument();
    expect(screen.getByText("Nearly used")).toBeInTheDocument();
  });

  it("says an internal account's calls are not spending the plan's allowances", async () => {
    mount(client({ ...FREE, internal: true }));
    await screen.findByText(/accounted as internal usage/);
  });
});

describe("what the screen never shows", () => {
  it("carries none of the billing, export or infrastructure content the artifact draws", async () => {
    const { container } = mount(client());
    await screen.findByRole("heading", { name: "Allowances" });
    const text = container.textContent ?? "";

    for (const refused of [
      "Subscription ID",
      "WX-PRO",
      "Billing interval",
      "Next billing date",
      "Payment method",
      "Visa",
      "Manage Payment",
      "Download Invoices",
      "Enterprise Authorized",
      "Vector Storage",
      "Clear Node Cache",
      "API Rate Limiters",
      "Recalculate Attribution",
      "Usage Export",
      "ENCRYPTION",
    ]) {
      expect(text, `the screen mentions ${refused}`).not.toContain(refused);
    }
  });

  it("shows nobody else's usage and no cross-user total", async () => {
    const api = client();
    const { container } = mount(api);
    await screen.findByRole("heading", { name: "Allowances" });

    // The endpoint takes no argument that could ask about another person, and the screen sends none.
    expect(api.usage).toHaveBeenCalledWith();
    expect(container.textContent).not.toMatch(/across (all )?users|per-user|total users/i);
  });
});

describe("the states", () => {
  it("says it is loading before the answer arrives", () => {
    mount(client());
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("offers a retry when the read fails", async () => {
    // A 4xx, so the query layer treats it as an answer: a 5xx would still be retrying here.
    mount(client(new ApiError(403, { code: "forbidden", message: "Not permitted." })));

    expect(await screen.findByText("Your plan is not available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("comparing tiers, changing plan, and what billing may claim", () => {
  it("compares the tiers on figures the database holds, not on promises", async () => {
    mount(client());
    const table = await screen.findByRole("table");

    // Every column is a configured tier and every cell an allowance, so nothing here is a claim
    // about a capability no row supports.
    expect(within(table).getByText("Daily questions")).toBeInTheDocument();
    // The difference a bigger number cannot express: which class of model answers.
    expect(within(table).getByText("Answers with")).toBeInTheDocument();
    expect(within(table).getByText("Economy model")).toBeInTheDocument();
    expect(within(table).getByText("Frontier model")).toBeInTheDocument();
    expect(within(table).getByText("30")).toBeInTheDocument();
    expect(within(table).getByText("300")).toBeInTheDocument();
    expect(within(table).getByText("1,000")).toBeInTheDocument();
  });

  it("offers the change in exactly one place, the comparison it belongs to", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Compare plans" });

    // One working control per tier the account is not on, and no second list repeating them.
    expect(screen.getAllByRole("button", { name: /^Choose / })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Choose Pro" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose Premium" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: /Change your plan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose Free" })).toBeNull();
  });

  it("leaves the controls inert and says why when the backend withholds self-selection", async () => {
    const api = {
      usage: vi.fn(() => Promise.resolve(FREE)),
      plans: vi.fn(() => Promise.resolve({ ...TIERS, self_service: false })),
      choosePlan: vi.fn(),
    } as unknown as ApiClient;
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    expect(screen.getByRole("button", { name: "Choose Pro" })).toBeDisabled();
    expect(api.choosePlan).not.toHaveBeenCalled();
  });

  it("states the billing position plainly and invents none of it", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Billing" });

    const billing = screen.getByRole("heading", { name: "Billing" }).closest("section")!;
    expect(within(billing).getByText(/does not charge your account/)).toBeInTheDocument();
    expect(within(billing).getByText(/no payment method on this account/)).toBeInTheDocument();
    // Said once on the page, not in two cards saying the same thing.
    expect(screen.getAllByText(/does not charge your account/)).toHaveLength(1);

    // The artifact's commercial furniture, none of which Weathra has. Asserted as *controls and
    // values*, not as words: the copy above says "no invoices" on purpose, and a test forbidding
    // the word would push the screen toward saying nothing rather than saying where it stands.
    for (const forbidden of [/download invoices/i, /manage payment/i, /upgrade plan/i]) {
      expect(screen.queryByRole("button", { name: forbidden })).toBeNull();
      expect(screen.queryByRole("link", { name: forbidden })).toBeNull();
    }
    for (const fabricated of [/ending in \d/i, /next billing date/i, /subscription id/i, /WX-/]) {
      expect(screen.queryByText(fabricated)).toBeNull();
    }
  });
});

/*
 * Changing tier, which is what this screen exists to let somebody do and what it could not do
 * before 2026-09-13. The defect was three layers deep — the backend reported `self_service: false`,
 * `checkoutFor` turned that into `unavailable`, and the button rendered disabled with no handler —
 * so these cases assert the *whole* path each time: the request that goes out, the screen that
 * re-reads, and the figures that follow.
 */
describe("changing tier", () => {
  it("asks before it acts, and does nothing until the second press", async () => {
    const person = userEvent.setup();
    const { api, choosePlan } = harness();
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Pro" }));
    expect(choosePlan).not.toHaveBeenCalled();

    const prompt = screen.getByRole("group", { name: "Change plan to Pro?" });
    expect(within(prompt).getByText(/allowances update immediately/i)).toBeInTheDocument();
    expect(within(prompt).getByText(/No payment will be charged/i)).toBeInTheDocument();

    await person.click(within(prompt).getByRole("button", { name: "Change to Pro" }));
    expect(choosePlan).toHaveBeenCalledWith({ plan_code: "pro" });
  });

  it("cancels without a request, and leaves the tier where it was", async () => {
    const person = userEvent.setup();
    const { api, choosePlan } = harness();
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Premium" }));
    await person.click(screen.getByRole("button", { name: "Cancel" }));

    expect(choosePlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: /Change plan/ })).toBeNull();
    const panel = screen.getByRole("heading", { name: "Current tier" }).closest("section")!;
    expect(within(panel).getByText("Free")).toBeInTheDocument();
  });

  it("moves the current badge, the header and every allowance figure without a reload", async () => {
    const person = userEvent.setup();
    const { api } = harness();
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    // Before: Free's 30 a day, 12 used, 18 left.
    expect(screen.getByRole("heading", { name: "Current tier" })).toBeInTheDocument();
    expect(await screen.findByText("18")).toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "Choose Premium" }));
    await person.click(screen.getByRole("button", { name: "Change to Premium" }));

    // After: the screen re-read `/me/usage` and drew Premium's 1000 a day against the same 12.
    await screen.findByText("Plan changed to Premium.");
    const panel = screen.getByRole("heading", { name: "Current tier" }).closest("section")!;
    expect(within(panel).getByText("Premium")).toBeInTheDocument();
    expect(within(panel).getByText("Current")).toBeInTheDocument();
    expect(await screen.findByText("988")).toBeInTheDocument();

    const rows = screen.getAllByRole("listitem");
    const requests = rows.find((row) => /Remaining: 988/.test(row.textContent ?? ""));
    expect(requests, "the allowance row did not follow the tier").toBeDefined();
    expect(within(requests as HTMLElement).getByText(/\/ 1,000 req/)).toBeInTheDocument();
    expect(within(requests as HTMLElement).getByText("1% used")).toBeInTheDocument();

    // The tier that is now current is no longer something to choose, and Free is.
    expect(screen.queryByRole("button", { name: "Choose Premium" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose Free" })).toBeEnabled();
  });

  it("keeps consumption when moving down, and says so rather than resetting it", async () => {
    const person = userEvent.setup();
    // 12 used against Premium's 1000. Moving to Free's 30 leaves 12 used and 18 left — the same 12.
    const { api } = harness(on("premium", "Premium", 1000));
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Free" }));
    await person.click(screen.getByRole("button", { name: "Change to Free" }));
    await screen.findByText("Plan changed to Free.");

    const rows = await screen.findAllByRole("listitem");
    const requests = rows.find((row) => /Remaining: 18/.test(row.textContent ?? ""));
    expect(requests, "the downgrade did not recompute against the smaller allowance").toBeDefined();
    // Consumption is what happened; the tier is what may happen next. The first is untouched.
    expect(within(requests as HTMLElement).getByText("12")).toBeInTheDocument();
    expect(within(requests as HTMLElement).getByText("Consumed: 12")).toBeInTheDocument();
  });

  it("warns that a smaller tier is smaller, before the press that applies it", async () => {
    const person = userEvent.setup();
    mount(harness(on("premium", "Premium", 1000)).api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Free" }));
    expect(screen.getByText(/allows less than your current one/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing you have already used is removed/i)).toBeInTheDocument();
  });

  it("reports a refusal with the backend's own reason, and claims nothing happened", async () => {
    const person = userEvent.setup();
    const failure = new ApiError(422, {
      code: "validation_failed",
      message: "That tier is not one Weathra offers.",
    });
    const { api } = harness(FREE, { failure });
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Pro" }));
    await person.click(screen.getByRole("button", { name: "Change to Pro" }));

    await screen.findByText(/Could not change plan/);
    expect(screen.getByText(/That tier is not one Weathra offers/)).toBeInTheDocument();
    // Nothing optimistic: the tier on the screen is still the one the backend last confirmed.
    const panel = screen.getByRole("heading", { name: "Current tier" }).closest("section")!;
    expect(within(panel).getByText("Free")).toBeInTheDocument();
    expect(screen.queryByText(/Plan changed to/)).toBeNull();
  });

  it("survives a reload, because the tier is server state rather than a remembered press", async () => {
    const person = userEvent.setup();
    const { api } = harness();
    const view = mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    await person.click(screen.getByRole("button", { name: "Choose Pro" }));
    await person.click(screen.getByRole("button", { name: "Change to Pro" }));
    await screen.findByText("Plan changed to Pro.");

    // A fresh mount with a fresh query cache — every figure comes from `/me/usage` again.
    view.unmount();
    mount(api);
    const panel = (await screen.findByRole("heading", { name: "Current tier" })).closest(
      "section",
    )!;
    expect(within(panel).getByText("Pro")).toBeInTheDocument();
  });

  it("is operable from the keyboard alone, prompt included", async () => {
    const person = userEvent.setup();
    const { api, choosePlan } = harness();
    mount(api);
    await screen.findByRole("heading", { name: "Compare plans" });

    const choose = screen.getByRole("button", { name: "Choose Pro" });
    choose.focus();
    await person.keyboard("{Enter}");

    // Focus moves into the prompt, so its warning is encountered rather than tabbed past.
    const prompt = screen.getByRole("group", { name: "Change plan to Pro?" });
    expect(prompt).toHaveFocus();

    await person.tab();
    expect(screen.getByRole("button", { name: "Change to Pro" })).toHaveFocus();
    await person.keyboard("{Enter}");
    expect(choosePlan).toHaveBeenCalledWith({ plan_code: "pro" });
  });
});
