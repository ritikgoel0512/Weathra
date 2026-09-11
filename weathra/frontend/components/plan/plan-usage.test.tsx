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

function client(usage: UsageResponse | Error = FREE): ApiClient {
  return {
    usage: vi.fn(() => (usage instanceof Error ? Promise.reject(usage) : Promise.resolve(usage))),
  } as unknown as ApiClient;
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
  it("names the plan in effect and marks it among the three canonical tiers", async () => {
    mount(client());
    await screen.findByRole("heading", { name: "Plan & Usage" });

    // "Free" appears twice on purpose — as the plan badge and as the current tier in the list.
    expect(screen.getAllByText("Free").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Premium")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    // The retired tier is unwritable in the database and unnameable here.
    expect(screen.queryByText(/plus/i)).toBeNull();
  });

  it("says plan changes are administrative rather than offering a checkout", async () => {
    mount(client());
    await screen.findByText(/Plan changes are made by a Weathra administrator/);

    expect(screen.getByText(/no self-service checkout/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
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
    const scheduled = screen
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
