/**
 * The administrative policy confirmation surface — the `specs/web-ui` requirement, exercised.
 *
 * Five things are asserted here and each is a requirement rather than a preference:
 *
 * 1. The recorded evidence is what appears, per candidate, with an unevidenced candidate marked as
 *    unevidenced and never as failed.
 * 2. The confirm control sends the *stored* order and the *selected* run — the exact body, checked
 *    field by field, because a promotion citing the wrong run is worse than one citing none.
 * 3. The token is the client's business. The panel never reads a session, never renders a
 *    credential, and the request it makes is the client's own.
 * 4. A 403 is a not-permitted state and nothing is rendered behind it.
 * 5. A promotion-gate refusal is shown as itself, naming the criteria the backend named, and is
 *    not dressed as a validation error or a server fault.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError, BackendUnreachable, type ApiClient } from "@/lib/api/client";
import type { PolicyRecord } from "@/lib/api/schema";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

import { ModelPolicyPanel } from "./model-policy";

const RUN_ID = "9b5849dd-b798-4dc8-b04f-a8e6c0874e1a";
const EVALUATION_ID = "de0d3f67-75d8-45f8-a7e0-53360e7dd553";

const FREE_DEFAULT: PolicyRecord = {
  policy_id: "free_default",
  display_name: "Free default",
  candidate_catalog_keys: ["economy-free-primary", "economy-free-secondary"],
  applicable_call_roles: ["routing", "synthesis"],
  eligibility: "public",
  fallback_policy_id: null,
  failover_enabled: true,
};

const OBSERVATIONS = {
  "economy-free-primary": {
    gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
    dataset_version: "1.0.0",
    passed: true,
    recorded_at: "2026-09-10T09:38:49Z",
    criteria: {
      structured_json_reliability: true,
      groundedness: true,
      latency: { overall_median_ms: 15815.05, overall_p95_ms: 15815.34 },
      planning: { tool_selection_accuracy: 1, plan_correctness: null, multi_step_cases: 0 },
      cost: { currency: "USD", is_estimate: true, estimated_total: null },
      promotion_blockers: [],
      measured: {
        structured_json_reliability: {
          decisions: 5,
          first_attempt_valid_rate: 1,
          mean_attempts_to_valid: 1,
        },
        groundedness: {
          groundedness: 1,
          hallucination_rate: 0,
          unsupported_weather_claim_rate: 0,
        },
      },
    },
  },
  // `economy-free-secondary` is deliberately absent: the provider rate-limited it before any case
  // ran, so the backend holds no evaluation for it — the case the surface must not misreport.
};

const RUN = {
  id: RUN_ID,
  initiated_by: "68853521-1ff1-45d3-b095-c437dc12eab1",
  candidate_catalog_keys: ["economy-free-primary", "economy-free-secondary"],
  dataset_version: "1.0.0",
  question: null,
  catalog_state: {},
  commit_sha: "db49a7d",
  status: "partial",
  started_at: "2026-09-10T09:36:35Z",
  completed_at: "2026-09-10T09:38:49Z",
  results: [
    ...["a", "b", "c", "d", "e"].map((id) => ({
      catalog_key: "economy-free-primary",
      gateway_model: "nvidia/nemotron-3-super-120b-a12b:free",
      case_id: id,
      succeeded: true,
      evaluation_id: EVALUATION_ID,
    })),
    ...["a", "b", "c", "d", "e"].map((id) => ({
      catalog_key: "economy-free-secondary",
      gateway_model: "nex-agi/nex-n2.5-mini:free",
      case_id: id,
      succeeded: false,
      evaluation_id: null,
    })),
  ],
};

const AUDIT_ENTRY = {
  acting_principal: "e7b66ef2-5bc6-4100-92cf-7c27cecdf63e",
  action: "policy_edit",
  subject_kind: "model_policy",
  subject_id: "free_default",
  before: { candidate_catalog_keys: FREE_DEFAULT.candidate_catalog_keys },
  after: { candidate_catalog_keys: FREE_DEFAULT.candidate_catalog_keys },
  cited_comparison_run_ids: [RUN_ID],
  created_at: "2026-09-10T12:00:00Z",
};

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    adminPolicies: vi.fn().mockResolvedValue({ count: 1, policies: [FREE_DEFAULT] }),
    adminCatalog: vi.fn().mockResolvedValue({ count: 2, entries: [], observations: OBSERVATIONS }),
    adminComparisons: vi.fn().mockResolvedValue({ count: 1, runs: [RUN] }),
    adminComparison: vi.fn().mockResolvedValue({ run: RUN, partial: true, completed_cells: [] }),
    confirmPolicyCandidates: vi.fn().mockResolvedValue(FREE_DEFAULT),
    adminPolicyAudit: vi
      .fn()
      .mockResolvedValue({ policy_id: "free_default", count: 1, entries: [AUDIT_ENTRY] }),
    ...overrides,
  } as unknown as ApiClient;
}

function mount(api: ApiClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={api}>
        <ModelPolicyPanel />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

/** The candidate's own block, so an assertion about one cannot be satisfied by the other. */
function candidate(name: string): HTMLElement {
  const key = screen.getByText(name);
  const item = key.closest("li");
  if (item === null) throw new Error(`no candidate block for ${name}`);
  return item;
}

describe("the recorded evidence", () => {
  it("shows the run being cited, with its status and what it covered", async () => {
    mount(client());

    // The run identifier appears in the run facts and again beside the candidate it scored, so
    // this asks for at least one rather than exactly one.
    expect((await screen.findAllByText(RUN_ID)).length).toBeGreaterThan(0);
    expect(screen.getByText("partial")).toBeInTheDocument();
    expect(screen.getByText("db49a7d")).toBeInTheDocument();
    expect(screen.getByText(/one or more candidates produced no evaluation/)).toBeInTheDocument();
  });

  it("shows the evidenced candidate's five criteria as the backend recorded them", async () => {
    mount(client());
    // Wait for the comparison read, not merely for the policy read: the candidate block exists as
    // soon as the policy resolves, and asserting then would measure an empty run.
    await screen.findByText("5 of 5 cases scored in the selected run.");
    const primary = within(candidate("economy-free-primary"));

    expect(primary.getByText("Evidenced — both gates passed")).toBeInTheDocument();

    for (const criterion of [
      "Structured JSON reliability",
      "Groundedness",
      "Latency",
      "Tool and planning quality",
      "Cost",
    ]) {
      expect(primary.getByText(criterion)).toBeInTheDocument();
    }

    expect(primary.getByText(/1.00 valid on the first attempt over 5/)).toBeInTheDocument();
    expect(primary.getByText(/groundedness 1.00/)).toBeInTheDocument();
    expect(primary.getByText(/No cost reported by the gateway/)).toBeInTheDocument();
  });

  it("marks the unscored candidate unevidenced, and never as having failed", async () => {
    mount(client());
    await screen.findByText("0 of 5 cases scored in the selected run.");
    const secondary = within(candidate("economy-free-secondary"));

    expect(secondary.getByText("Unevidenced")).toBeInTheDocument();
    expect(secondary.getByText(/it has not been shown anything/)).toBeInTheDocument();
    expect(secondary.queryByText("Failed a gating criterion")).toBeNull();
    expect(secondary.queryByText(/^fail$/)).toBeNull();
  });

  it("offers the run as citable for the candidate it scored, and not for the other", async () => {
    mount(client());
    await screen.findByText("5 of 5 cases scored in the selected run.");

    expect(within(candidate("economy-free-primary")).getByText(/Citable from this run/)).toBeInTheDocument();
    expect(within(candidate("economy-free-secondary")).queryByText(/Citable from this run/)).toBeNull();
  });
});

describe("the confirmation", () => {
  it("sends the stored order and the selected run, and nothing else", async () => {
    const confirmPolicyCandidates = vi.fn().mockResolvedValue(FREE_DEFAULT);
    mount(client({ confirmPolicyCandidates }));

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    await waitFor(() => expect(confirmPolicyCandidates).toHaveBeenCalledTimes(1));
    expect(confirmPolicyCandidates).toHaveBeenCalledWith("free_default", {
      candidate_catalog_keys: ["economy-free-primary", "economy-free-secondary"],
      cited_comparison_run_ids: [RUN_ID],
    });
    // The gate override is not sent at all, rather than sent as false: the surface has no business
    // asking for it, and `extra="forbid"` on the backend means an absent field is the honest one.
    const body = confirmPolicyCandidates.mock.calls[0]?.[1];
    expect(Object.keys((body ?? {}) as object)).toEqual([
      "candidate_catalog_keys",
      "cited_comparison_run_ids",
    ]);
  });

  it("states an unchanged order as a confirmation rather than a reorder", async () => {
    mount(client());
    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    const outcome = within(await screen.findByRole("status"));
    expect(outcome.getByText("Candidate order confirmed")).toBeInTheDocument();
    expect(outcome.getByText(/not a reordering/)).toBeInTheDocument();
  });

  it("reads the audit record back and shows what it recorded", async () => {
    const adminPolicyAudit = vi
      .fn()
      .mockResolvedValue({ policy_id: "free_default", count: 1, entries: [AUDIT_ENTRY] });
    mount(client({ adminPolicyAudit }));

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    await waitFor(() => expect(adminPolicyAudit).toHaveBeenCalledWith("free_default", 5));
    const outcome = within(await screen.findByRole("status"));
    expect(outcome.getByText("policy_edit")).toBeInTheDocument();
    expect(outcome.getAllByText(RUN_ID).length).toBeGreaterThan(0);
  });

  it("does not read the audit trail until the backend has confirmed the write", async () => {
    const adminPolicyAudit = vi.fn().mockResolvedValue({ policy_id: "x", count: 0, entries: [] });
    mount(client({ adminPolicyAudit }));
    await screen.findByRole("button", { name: "Confirm candidate order" });

    expect(adminPolicyAudit).not.toHaveBeenCalled();
  });

  it("makes one request per press, however many times the control is pressed", async () => {
    // Held open by hand rather than by a timer: a timed promise makes this a race between the
    // second click and React's flush, which is a flake rather than a test of the guard.
    let release: (policy: typeof FREE_DEFAULT) => void = () => {};
    const confirmPolicyCandidates = vi.fn(
      () => new Promise<typeof FREE_DEFAULT>((resolve) => (release = resolve)),
    );
    mount(client({ confirmPolicyCandidates }));

    const control = await screen.findByRole("button", { name: "Confirm candidate order" });
    await userEvent.click(control);
    await waitFor(() => expect(confirmPolicyCandidates).toHaveBeenCalledTimes(1));
    await userEvent.click(control);

    release(FREE_DEFAULT);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expect(confirmPolicyCandidates).toHaveBeenCalledTimes(1);
  });
});

describe("the refusals", () => {
  it("shows a not-permitted state for an authenticated principal without the role", async () => {
    const forbidden = new ApiError(403, {
      code: "forbidden",
      message: "This operation requires an administrative principal.",
    });
    mount(
      client({
        adminPolicies: vi.fn().mockRejectedValue(forbidden),
        adminCatalog: vi.fn().mockRejectedValue(forbidden),
        adminComparisons: vi.fn().mockRejectedValue(forbidden),
      }),
    );

    const refusal = within(await screen.findByRole("alert"));
    expect(refusal.getByText("Not permitted")).toBeInTheDocument();
    expect(refusal.getByText(/signing in again will not change that/)).toBeInTheDocument();

    // And nothing behind it: no policy, no candidate, no comparison, no audit content.
    expect(screen.queryByText("free_default")).toBeNull();
    expect(screen.queryByText("economy-free-primary")).toBeNull();
    expect(screen.queryByText(RUN_ID)).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm candidate order" })).toBeNull();
  });

  it("shows a promotion-gate refusal as itself, naming the criteria the backend named", async () => {
    mount(
      client({
        confirmPolicyCandidates: vi.fn().mockRejectedValue(
          new ApiError(400, {
            code: "validation_failed",
            message:
              "A candidate that failed a gating criterion is not promoted on cost or latency alone.",
            details: {
              field: "candidate_catalog_keys",
              failed_criteria: { "economy-free-secondary": ["groundedness"] },
              gating_criteria: ["structured_json_reliability", "groundedness"],
            },
          }),
        ),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    const refusal = within(await screen.findByRole("alert"));
    expect(refusal.getByText("Refused by the promotion gate")).toBeInTheDocument();
    expect(refusal.getByText(/failed groundedness/)).toBeInTheDocument();
    expect(refusal.getByText(/not made from this screen/)).toBeInTheDocument();
    expect(screen.queryByText("Candidate order confirmed")).toBeNull();
  });

  it("shows an unexpected backend failure as a retryable error, not as a refusal", async () => {
    mount(
      client({
        confirmPolicyCandidates: vi.fn().mockRejectedValue(
          new ApiError(500, { code: "unexpected_response", message: "Weathra could not do that." }),
        ),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    // A 5xx is worth another attempt, so it is titled as one and offers the retry. The two
    // refusals below are answers, and neither is offered a retry.
    expect(await screen.findByText("That change did not go through")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Refused by the promotion gate")).toBeNull();
    expect(screen.queryByText("Not permitted")).toBeNull();
  });
});

describe("a transient failure", () => {
  it("offers a retry, and the retry re-sends the same confirmation", async () => {
    const confirmPolicyCandidates = vi
      .fn()
      .mockRejectedValueOnce(new BackendUnreachable(new Error("connection dropped")))
      .mockResolvedValueOnce(FREE_DEFAULT);
    mount(client({ confirmPolicyCandidates }));

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));
    // Reloading the page was the only way back before this: an unreachable backend is not an
    // answer, and the one screen a person arrives at having decided to make a change is the worst
    // place to lose the change to a blip.
    const again = await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(again);

    await waitFor(() => expect(confirmPolicyCandidates).toHaveBeenCalledTimes(2));
    expect(confirmPolicyCandidates.mock.calls[0]).toEqual(confirmPolicyCandidates.mock.calls[1]);
    expect(await screen.findByText("Candidate order confirmed")).toBeInTheDocument();
  });

  it("says a failed audit read-back rather than reading it back for ever", async () => {
    mount(
      client({
        // A 4xx, so the query layer treats it as an answer and does not retry — an unreachable
        // backend would still be retrying while this assertion ran, which is a different state.
        adminPolicyAudit: vi
          .fn()
          .mockRejectedValue(
            new ApiError(404, { code: "not_found", message: "No such policy." }),
          ),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Confirm candidate order" }));

    const outcome = within(await screen.findByRole("status"));
    expect(outcome.getByText("Candidate order confirmed")).toBeInTheDocument();
    expect(outcome.getByText(/audit entry could not be read back/)).toBeInTheDocument();
    expect(outcome.queryByText(/Reading the audit record back/)).toBeNull();
  });
});

describe("what the surface never shows", () => {
  it("renders no credential, and asks for none", async () => {
    const api = client();
    const { container } = mount(api);
    await screen.findByText("5 of 5 cases scored in the selected run.");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Bearer/i);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/); // a JWT's own prefix
    expect(text).not.toMatch(/service[_ -]?role/i);
    expect(text).not.toMatch(/SUPABASE|OPENROUTER|DATABASE_URL/);
    // The panel holds no session code of its own: the token is added by the API client, once.
    expect(Object.keys(api)).not.toContain("accessToken");
  });
});
