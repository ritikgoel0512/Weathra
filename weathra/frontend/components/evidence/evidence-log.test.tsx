/**
 * Agent Evidence with no run selected.
 *
 * The case this file exists for: `/evidence` used to render every panel a record has, unpopulated,
 * so a person with stored runs saw what a person with none saw. These assert the three states the
 * listing actually has, and that a run's places are named rather than plotted.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** The page renders a record inline, so the client has to be able to serve one. */
const RECORD = {
  id: "run-1",
  request_id: "req-1",
  thread_id: null,
  question: "What should I expect over the next few days?",
  answer_prose: "Berlin is running warmer than usual this week.",
  envelope: {},
  evidence: {},
  llm_provider: "a-gateway",
  llm_model: "a-model",
  weather_provider: "open-meteo",
  duration_ms: 4210,
  partial: false,
  created_at: "2026-09-04T06:15:05Z",
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    evidenceRecords: vi.fn().mockResolvedValue(RECORDS),
    evidence: vi.fn().mockResolvedValue(RECORD),
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
  it("opens on a record rather than on an index", async () => {
    const evidence = vi.fn().mockResolvedValue(RECORD);
    mount(client({ evidence }));

    /*
     * `05-agent-evidence.png` is a populated trace, and a list is not one. The newest run is
     * fetched and rendered underneath the switcher, so the page a person meets is an execution.
     */
    await vi.waitFor(() => expect(evidence).toHaveBeenCalledWith("run-1"));
    expect(
      await screen.findByRole("link", { name: "Open this run on its own page" }),
    ).toHaveAttribute("href", "/evidence/run-1");
  });

  it("opens on the newest run by its timestamp, not on whichever row arrived first", async () => {
    /*
     * The backend orders newest first and this screen orders again, because "which run does the
     * evidence log open on" must not be a property of a row order decided at the other end of the
     * system. A listing that arrived oldest-first would otherwise pin the page to an old record —
     * the exact complaint that sent this screen back for a rebuild.
     */
    const evidence = vi.fn().mockResolvedValue(RECORD);
    const oldestFirst = {
      ...RECORDS,
      records: [...RECORDS.records].reverse(),
    };
    mount(client({ evidence, evidenceRecords: vi.fn().mockResolvedValue(oldestFirst) }));

    await vi.waitFor(() => expect(evidence).toHaveBeenCalledWith("run-1"));
    expect(evidence).not.toHaveBeenCalledWith("run-2");
  });

  it("offers every run as a switch, and shows the one selected", async () => {
    const evidence = vi.fn().mockResolvedValue(RECORD);
    mount(client({ evidence }));

    // Folded by default: the record is the page's subject, and choosing which one is a control.
    const switcher = await screen.findByText("Run");
    await userEvent.click(switcher);
    const chips = screen
      .getAllByRole("button")
      .filter((element) => element.hasAttribute("aria-pressed"));
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
    expect(chips[1]).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chips[1] as HTMLElement);
    await vi.waitFor(() => expect(evidence).toHaveBeenCalledWith("run-2"));
  });

  it("names the places a run resolved, and never their coordinates", async () => {
    const { container } = mount(client());
    await userEvent.click(await screen.findByText("Run"));

    expect(screen.getByText("Berlin, Germany")).toBeInTheDocument();
    expect(screen.getByText("Munich, Germany")).toBeInTheDocument();
    // A coordinate pair is internal metadata here as it is everywhere else in Weathra.
    expect(container.textContent).not.toMatch(/\d+\.\d+°\s*[NSEW]|\d{2}\.\d{3,}/);
  });

  it("marks a partial run, so an incomplete record is not read as a complete one", async () => {
    mount(client());
    await userEvent.click(await screen.findByText("Run"));

    expect(screen.getByText("Partial")).toBeInTheDocument();
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
      await screen.findByText(/readable only by the account that produced them/i),
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
