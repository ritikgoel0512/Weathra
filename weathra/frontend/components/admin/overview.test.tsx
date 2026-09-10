/**
 * Admin Model & AI Usage — the dashboard, task 34.18.
 *
 * Two kinds of assertion, and the second is the one worth having.
 *
 * The first is that the figures are the recorded ones: totals folded from the groups, the split
 * between product and internal traffic kept rather than merged, failures counted where they
 * happened. The second is about the nulls, which is where a dashboard built from an artifact goes
 * wrong. `total_tokens` and `estimated_cost_total` are nullable — the gateway does not always
 * report usage, and a call priced before the catalog knew a price carries no cost — and rendering
 * either as `0` would draw "free and silent" where the truth is "not reported". A screen an
 * operator makes spending decisions from must not do that, so each null is asserted as its own
 * sentence rather than as a number.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import type { CatalogListResponse, UsageSummaryResponse } from "@/lib/api/schema";
import { createQueryClient } from "@/lib/query/provider";

import { AdminOverview } from "./overview";

const USAGE: UsageSummaryResponse = {
  grouped_by: "model",
  window: { start: "2026-08-11T00:00:00Z", end: "2026-09-10T00:00:00Z" },
  groups: [
    {
      group: "vendor/one",
      is_internal: false,
      calls: 120,
      failures: 3,
      prompt_tokens: 40000,
      completion_tokens: 8000,
      total_tokens: 48000,
      estimated_cost_total: "1.2500",
      latency_p50_ms: 900,
      latency_p95_ms: 2400,
    },
    {
      group: "vendor/two",
      is_internal: true,
      calls: 30,
      failures: 0,
      prompt_tokens: null,
      completion_tokens: null,
      // The gateway reported no usage for these calls, and no price was recorded.
      total_tokens: null,
      estimated_cost_total: null,
      latency_p50_ms: 1500,
      latency_p95_ms: 3000,
    },
  ],
};

const CATALOG: CatalogListResponse = {
  count: 1,
  entries: [
    {
      catalog_key: "standard-general",
      display_name: "Standard general",
      gateway_model: "vendor/one",
      gateway_provider: "vendor",
      capability_roles: ["routing"],
      capability_tier: "standard",
      context_window: 128000,
      input_price_per_million: "0.1500",
      output_price_per_million: "0.6000",
      price_currency: "USD",
      pricing_recorded_on: "2026-09-01",
      is_free_tier: false,
      status: "enabled",
      supports_structured_output: true,
    },
  ],
  observations: {
    "standard-general": {
      gateway_model: "vendor/one",
      dataset_version: "v1",
      passed: true,
      recorded_at: "2026-09-09T10:00:00Z",
    },
  },
};

function client(
  usage: UsageSummaryResponse | Error = USAGE,
  catalog: CatalogListResponse | Error = CATALOG,
): ApiClient {
  const answer = <T,>(value: T | Error) => () =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    adminUsage: vi.fn(answer(usage)),
    adminCatalog: vi.fn(answer(catalog)),
  } as unknown as ApiClient;
}

function mount(api: ApiClient = client()) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <AdminOverview />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the estate's figures", () => {
  it("totals calls across product and internal traffic", async () => {
    mount();
    expect(await screen.findByText("150")).toBeInTheDocument();
  });

  it("keeps product and internal calls apart rather than merging them", async () => {
    mount();
    // The region exists before its figures do, so the wait is on the data rather than the panel.
    await screen.findByText("150");
    const split = screen.getByRole("region", { name: "Product and internal" });
    expect(within(split).getByText("120")).toBeInTheDocument();
    expect(within(split).getByText("30")).toBeInTheDocument();
  });

  it("reports the failure rate with the counts it came from", async () => {
    mount();
    // 3 of 150.
    expect(await screen.findByText("2.00%")).toBeInTheDocument();
    expect(screen.getByText("3 of 150 calls")).toBeInTheDocument();
  });

  it("names the period the figures cover", async () => {
    mount();
    expect(await screen.findByText(/11 Aug\s*–\s*10 Sep/)).toBeInTheDocument();
  });

  it("calls the highest per-group p50 what it is, and not the estate's median", async () => {
    mount();
    expect(await screen.findByText("1500 ms")).toBeInTheDocument();
    expect(screen.getByText(/highest per-group p50, not the estate's/)).toBeInTheDocument();
  });
});

describe("what was not reported", () => {
  it("says how many groups reported tokens when only some did", async () => {
    mount();
    // The figure appears in the KPI and again in the table row it came from, so this reads the KPI.
    const note = await screen.findByText("1 of 2 groups reported");
    expect(within(note.parentElement as HTMLElement).getByText("48,000")).toBeInTheDocument();
  });

  it("draws no cost or token figure at all when nothing reported one", async () => {
    const silent: UsageSummaryResponse = {
      ...USAGE,
      groups: USAGE.groups.map((group) => ({
        ...group,
        total_tokens: null,
        estimated_cost_total: null,
      })),
    };
    mount(client(silent));

    const notReported = await screen.findAllByText("Not reported");
    // Tokens and estimated cost, neither of them zero.
    expect(notReported.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("0.00")).toBeNull();
  });

  it("always calls the cost an estimate rather than a bill", async () => {
    mount();
    expect(await screen.findByText("1.25")).toBeInTheDocument();
    expect(screen.getByText("an estimate, never a billed amount")).toBeInTheDocument();
  });
});

describe("the catalog", () => {
  it("renders the recorded entries and the lab's last verdict", async () => {
    mount();
    expect(await screen.findByText("Standard general")).toBeInTheDocument();
    expect(screen.getByText("standard-general")).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
  });

  it("says 'never' for an entry the lab has not evaluated", async () => {
    mount(client(USAGE, { ...CATALOG, observations: {} }));
    expect(await screen.findByText("never")).toBeInTheDocument();
  });
});

describe("a caller without the role", () => {
  const forbidden = new ApiError(403, {
    code: "forbidden",
    message: "This operation requires an administrative principal.",
  });

  it("is refused, and is not invited to try the same question again", async () => {
    mount(client(forbidden, forbidden));

    const refusals = await screen.findAllByText("Not permitted");
    expect(refusals.length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    // And no figure is drawn behind the refusal.
    expect(screen.queryByRole("table")).toBeNull();
  });
});
