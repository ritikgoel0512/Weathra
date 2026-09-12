/**
 * Agent Evidence with no run selected.
 *
 * The case this file exists for: `/evidence` used to render every panel a record has, unpopulated,
 * so a person with stored runs saw what a person with none saw. These assert the three states the
 * listing actually has, and that a run's places are named rather than plotted.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { EvidenceLog } from "./evidence-log";

const RECORDS = {
  limit: 20,
  returned: 2,
  records: [
    {
      id: "run-1",
      created_at: "2026-09-04T06:15:05Z",
      question: "What should I expect over the next few days?",
      answer_preview: "Berlin is running warmer than usual this week.",
      duration_ms: 4210,
      partial: false,
      weather_provider: "open-meteo",
      llm_model: "a-model",
      steps: 6,
      locations: ["Berlin, Germany"],
    },
    {
      id: "run-2",
      created_at: "2026-09-03T18:42:11Z",
      question: "How does this week compare with last year?",
      answer_preview: null,
      duration_ms: 900,
      partial: true,
      weather_provider: "open-meteo",
      llm_model: "a-model",
      steps: 4,
      locations: ["Munich, Germany"],
    },
  ],
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    evidenceRecords: vi.fn().mockResolvedValue(RECORDS),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <EvidenceLog />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe("the evidence log", () => {
  it("lists the runs a person has, each opening its own record", async () => {
    mount(client());

    const list = await screen.findByRole("region", { name: "Recent runs" });
    const links = within(list).getAllByRole("link");

    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/evidence/run-1");
    expect(links[1]).toHaveAttribute("href", "/evidence/run-2");
    expect(within(list).getByText(/next few days/)).toBeInTheDocument();
  });

  it("names the places a run resolved, and never their coordinates", async () => {
    mount(client());
    const list = await screen.findByRole("region", { name: "Recent runs" });

    expect(within(list).getByText("Berlin, Germany")).toBeInTheDocument();
    expect(within(list).getByText("Munich, Germany")).toBeInTheDocument();
    // A coordinate pair is internal metadata here as it is everywhere else in Weathra.
    expect(list.textContent).not.toMatch(/\d+\.\d+°\s*[NSEW]|\d{2}\.\d{3,}/);
  });

  it("marks a partial run, so an incomplete record is not read as a complete one", async () => {
    mount(client());
    const list = await screen.findByRole("region", { name: "Recent runs" });

    expect(within(list).getByText("Partial")).toBeInTheDocument();
  });

  it("says where a run comes from when there are none, rather than reading as a failure", async () => {
    mount(
      client({
        evidenceRecords: vi.fn().mockResolvedValue({ limit: 20, returned: 0, records: [] }),
      }),
    );

    expect(await screen.findByText("No evidence records yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AI Weather Analyst/ })).toBeInTheDocument();
    /*
     * And it is honest about which surfaces produce one. Only a question through the orchestrator
     * stores a run; the deterministic screens show their workings on their own pages. Implying
     * otherwise would leave a reader waiting for records that are never coming.
     */
    expect(screen.getByText(/run no agent, so they produce no record here/i)).toBeInTheDocument();
  });

  it("states that a record is readable only by the account that produced it", async () => {
    mount(client());
    expect(
      await screen.findByText(/readable only by the account that created it/i),
    ).toBeInTheDocument();
  });

  it("offers a retry when the listing could not be read", async () => {
    mount(
      client({
        evidenceRecords: vi.fn().mockRejectedValue(
          new ApiError(503, { code: "database_unavailable", message: "No." }),
        ),
      }),
    );

    expect(
      await screen.findByText("Your evidence records could not be read", undefined, {
        timeout: 5_000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
