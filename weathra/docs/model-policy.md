# Model policy

Which model serves a request, who decides, and what happens when nothing can.

Weathra chooses a model in exactly one place — `entitlements/resolver.py` — and everything above it
asks for a **call role** and receives a client. No supervisor, node, route, or caller names a model.
This document is the resolution order that place implements, stated so that a reader can predict
the answer for a given plan and call role without reading the code, and can say what happens when
there is no answer.

Configuration lives in [`configuration.md`](configuration.md); the authorization model for the
tables named here is in [`authentication.md`](authentication.md). This document is about the
decision.

**Status: IMPLEMENTED.** Groups 26 to 32. The policies, the catalog, the plan mappings and the
allowances are database rows; the administrative API over them is live. The two screens that would
*show* this — Admin Model & AI Usage, and Plan & Usage — are designed-but-unbuilt and are recorded
as such in [`roadmap.md`](roadmap.md).

## The three nouns

| | What it is | Where it lives |
|---|---|---|
| **Catalog entry** | One model Weathra is allowed to use at all, under a stable internal key. Carries the gateway provider and the gateway's own model string, the call roles it can serve, its tier, its context window, its price, and whether it is enabled | `model_catalog` |
| **Policy** | A named, ordered list of candidate catalog keys, the call roles it applies to, who may resolve it, its declared fallback, and whether failover is permitted | `model_policies` |
| **Plan** | A user-facing tier that maps each call role onto a policy | `subscription_plans`, with a person's assignment in `user_plans` |

**A vendor model string appears in a catalog row and nowhere else.** Policies reference catalog
*keys*; so do plan mappings, quota rules, agents, nodes, routes, evaluation cases, and every
user-facing string. A test asserts it over the whole repository (task 27.4), because the moment
behaviour is selected by a vendor's model name, changing models becomes a code change.

## The call roles

Three, and a catalog entry declares which it can serve.

| Role | What makes the call |
|---|---|
| `routing` | The supervisor's structured routing decision — which capabilities this question needs |
| `synthesis` | The prose answer, written over figures code has already computed |
| `lab` | A model comparison. Never a product request |

A plan may map the two product roles to **different** policies, and a single run resolves each role
against its own mapping.

## The resolution order

Five steps, in this order, and the order is the security argument.

1. **Principal to plan.** From `user_plans`, keyed by the subject of the validated token. No row
   means Free. A caller with no token is Free and can never be anything else.
2. **Plan and role to policy.** From `subscription_plans`. A policy's own *eligibility* is checked
   here, before the mapping is honoured — so an administrative or internal policy is not granted by
   a plan row that happens to name it.
3. **Policy to the first available candidate.** Walk the policy's declared candidate order and take
   the first entry that is present in the catalog, enabled, and fit for the role. Every skip is
   appended to the recorded reason.
4. **Nothing available, so the fallback chain** — below.
5. **Still nothing** raises `NoEligibleModel`.

An administrative override is checked against the catalog **before all of this** and is a shortcut
through steps 2 to 4. It is never a shortcut past step 1's identity, and never past the allowlist.

Every resolution carries a human-readable `reason` recording the walk it took, and that reason is
written into the evidence record and onto the usage event. "Why did this caller get that model" is
answerable from the record, without re-running a resolution against catalog state that has since
moved on.

## The shipped catalog

Four entries, seeded by migration `0008` and administrable at runtime. Prices are per million
tokens in USD, recorded on 2026-09-09; they are copied onto each usage event so a re-pricing never
rewrites history.

| Catalog key | Tier | Roles | Input | Output | Free tier |
|---|---|---|---|---|---|
| `economy-free-primary` | economy | routing, synthesis, lab | 0 | 0 | yes |
| `economy-free-secondary` | economy | routing, synthesis, lab | 0 | 0 | yes |
| `standard-general` | standard | routing, synthesis, lab | 0.037 | 0.170 | no |
| `frontier-reasoning` | frontier | routing, synthesis, lab | 0.625 | 3.125 | no |

## The shipped policies

| Policy | Candidates, in declared order | Roles | Who may resolve it | Declared fallback | Failover |
|---|---|---|---|---|---|
| `free_default` | `economy-free-primary`, `economy-free-secondary` | routing, synthesis | anyone, including an unauthenticated call | — | yes |
| `balanced` | `standard-general`, `economy-free-primary` | routing, synthesis | by plan mapping | `free_default` | yes |
| `high_reasoning` | `frontier-reasoning`, `standard-general` | routing, synthesis | by plan mapping | `balanced` | yes |
| `admin_experimental` | `frontier-reasoning`, `standard-general`, `economy-free-primary` | routing, synthesis, lab | an administrative principal only | — | yes |
| `evaluation_fixed` | `economy-free-primary` | routing, synthesis | the internal evaluation subject only | — | **no** |

`high_reasoning` falls back **down** to `balanced`, and `balanced` down to `free_default`. Never
upward: an outage must not become a free upgrade, and the resolver refuses a fallback above the
caller's own plan rank whatever a policy declares.

## The plan mapping

| Plan | Rank | `routing` | `synthesis` |
|---|---:|---|---|
| Free | 0 | `free_default` | `free_default` |
| Pro | 1 | `balanced` | `balanced` |
| Premium | 2 | `high_reasoning` | `high_reasoning` |

`free`, `pro` and `premium` are the canonical plan codes and the only ones the table's own check
constraint accepts. There is no `plus`.

**This mapping is data.** Re-pointing Pro at `high_reasoning` is an administrative write —
`PUT /api/v1/admin/plans/{plan_code}/policies` — that takes effect for subsequent requests with no
code change and no redeployment.

## Predicting the answer

Everything above resolves to one table. With the seeded state and every catalog entry enabled:

| Caller | Role | Resolves | Serving model |
|---|---|---|---|
| no token | routing or synthesis | `free_default` | `economy-free-primary` |
| Free plan | routing or synthesis | `free_default` | `economy-free-primary` |
| Pro plan | routing or synthesis | `balanced` | `standard-general` |
| Premium plan | routing or synthesis | `high_reasoning` | `frontier-reasoning` |
| administrator, no override | as their plan | as their plan | as their plan |
| administrator naming a model | any | the override | the named entry, if enabled |
| a live evaluation run | routing and synthesis | `evaluation_fixed` | `economy-free-primary` |

**Worked example — a Premium caller's synthesis call with `frontier-reasoning` disabled.** Step 1
reads `premium`. Step 2 maps synthesis to `high_reasoning`, which is plan-eligible. Step 3 walks its
candidates: `frontier-reasoning` is skipped as disabled, and `standard-general` is enabled and fit,
so it wins. The recorded reason names the skip. Nothing fell back — the policy's own second
candidate answered.

**Worked example — the same call with both of that policy's candidates disabled.** Step 3 finds
nothing, so the chain runs: the declared fallback `balanced` is attempted, its first candidate
`standard-general` is disabled too, its second is `economy-free-primary`, which is enabled — so a
Premium caller is served the economy model, the resolution is marked as having fallen back, and the
reason states every skip on the way. The answer's figures, attribution, grounding and evidence are
unchanged; only the prose and the recorded model identity differ.

## Entitlement is derived, never asserted

The effective plan comes from backend state keyed by the token subject. A plan, policy identifier,
model identifier, allowance, or entitlement **presented by a caller** does not grant access, raise
an allowance, or change which model serves a request — it is ignored. A caller bypassing the
frontend gets the same outcome as one using it, because hiding a control was never the mechanism.

`resolve` has no `plan` parameter and no `model` parameter, and a test asserts that: the absence of
the field is the guarantee, since a resolver that accepted one could be made to honour it later.

`admin_experimental` is gated on the **administrative role**, held as backend state in `admin_roles`
and never granted by a body field, query parameter, header, cookie, or token claim. A plan row
naming `admin_experimental` does not resolve it for a caller without the role.

## The administrative override, and its bound

An administrator may name a model for their own request. Three properties bound it:

* **The catalog is the allowlist.** The named key must be present *and* enabled. Absent is refused
  as `absent`, disabled is refused as `disabled` — two different situations for the person reading
  the error, and neither reaches the gateway.
* **It is validated against the database, not the snapshot.** A deliberate act must not rest on a
  cached allowlist up to one TTL old, or an administrator could disable a model and still select
  it.
* **It applies to the overriding principal's own run and nothing else.** A concurrent request from
  anybody else resolves exactly as it would have. The resolution records who overrode it.

A non-administrative caller's override field is **ignored and the request continues**. It is not
refused, because refusing would disclose which models exist above the caller's tier.

## The fallback chain

Entered only when step 3 found no available candidate. Each rung is re-checked for eligibility and
for the caller's entitlement ceiling, because a chain that skipped those checks would undo step 2.

1. **The policy's declared fallback**, if it has one and it is not above the caller's plan rank.
2. **The plan's own default policy for that role** — the mapping, tried again in case the first
   attempt was through a declared fallback.
3. **The `free_default` floor.** Every tier is entitled to Free's policy, so a plan whose own
   mapping is unusable lands here rather than skipping straight to configuration.
4. **`LLM_MODEL`, validated against the catalog.** Recorded as `__fallback_config__` — *not* as a
   policy resolution, so no aggregate ever reports configuration as entitlement.
5. **`NoEligibleModel`.** A configuration error. No answer is produced from an unentitled model and
   no figure is invented; the caller receives an error naming the plan and the role, and the
   deterministic weather surfaces go on working.

## What happens when nothing is available

Three different situations, kept distinguishable on purpose:

| Situation | What the caller gets | What the record says |
|---|---|---|
| Every candidate disabled or absent, and no rung of the chain resolves | An error, not an invented answer | `NoEligibleModel` with the plan, the role, and the walk |
| Every eligible candidate *fails at the gateway* | The deterministic answer, with its figures, attribution and grounding unchanged, reporting that no model served it | Every attempt, with its selected model, outcome and reason |
| The policy store itself is unreadable | The configured model serves the call | `__fallback_config__`, and "resolution could not be performed" — never a pretence that a policy was consulted |

## The role of `LLM_MODEL`

`LLM_MODEL` is **the development and administrative fallback, and nothing else.** It is the fourth
rung of the chain above, it is validated against the catalog like anything else — configuration does
not outrank the allowlist — and a resolution that used it is recorded as a configured fallback
rather than as a policy.

`LLM_SINGLE_MODEL_MODE` bypasses resolution entirely and serves `LLM_MODEL` for every call. It is
for local and CI runs; the settings validator **refuses to start** a deployed backend that has it
set.

What `LLM_MODEL` is *not*: what serves a resolved call. It used to be, by accident — see the note at
the end of this document.

## The catalog staleness window: a disable is not instant

Each process holds one snapshot of the catalog, the policies and the plans, refreshed on the first
read after `MODEL_CATALOG_CACHE_TTL_SECONDS` (default **60**). On the hot path a resolution issues
no query at all while the snapshot is fresh.

**So an administrator disabling a model may see it serve for up to that long**, on each instance
that has not yet refreshed. That is the documented cost of the cache and it is stated rather than
implied:

* the bound is the TTL, and it is a setting, and `0` reads every time;
* the guarantee is "within the window", not "immediately";
* **an administrative override and a lab selection do not read the snapshot at all.** They validate
  against the database, so a deliberate act is never allowed to act on a stale allowlist.

If a disable must bind everywhere at once, the mechanism is to set the TTL to `0` and accept a query
per resolution. There is no invalidation protocol between instances, deliberately: one would be a
distributed-cache problem bought to shorten a 60-second window.

## Runtime failover

A resolved call that fails at the gateway may be retried against the **same policy's** remaining
enabled candidates, in declared order.

**Entered only for infrastructure failure**: a model reported unavailable, a gateway error, a
timeout, a network failure.

**Never entered for:**

* **A gateway rate limit** where the candidates share a gateway account — another candidate on the
  same account would be rate-limited too. The call is retried against the same model within a
  bounded wait, then reported as a rate limit.
* **Output quality.** A model whose output fails schema validation after the permitted retries is
  not replaced. The run continues by the deterministic path and the failure is recorded as a
  *quality* outcome, which is the thing the evaluation dataset exists to measure.

**Bounded** by `LLM_FAILOVER_MAX_MODELS` (default **2**, counting the first), and never escalating
above the caller's entitlement: a Free caller's failover never reaches a Pro or Premium candidate,
even when one is available and theirs are not.

Every attempt is recorded with its selected model, its served model where the gateway reported one,
its outcome and its reason — so a run that failed over says so, and names both models.

## The pinned evaluation policy

`evaluation_fixed` has exactly one candidate, no declared fallback, and failover off. A live
evaluation run resolves through it and **does not read the evaluation test user's plan** — the
entry point takes no principal at all, so there is nothing for a plan to be read from.

The reason is comparability: a change to a plan, a policy, or a candidate pool must not change what
an evaluation run measures. A provider failure during a run therefore **aborts the run** rather than
substituting a candidate, because a run that measured a second model while claiming the first would
be worse than a run that failed.

A model *comparison* pins each candidate the same way — one pinned run per model, the candidate
named by catalog key and validated against the database — and records the resolution as
`__lab_comparison__`, since a pinned candidate did not resolve a policy. Details in
[`evaluation.md`](evaluation.md).

## What the policy layer may never affect

A policy record carries no field capable of disabling grounding, attribution, data-class labelling,
or evidence capture, and a test asserts that. Two policies resolving two different models over the
same fixture data produce identical tool selection, identical figures, an equally complete evidence
record, identical grounding outcomes and the same stream event sequence — differing only in prose
and in the recorded model identity. Model choice is a choice about who writes the sentence, never
about what the sentence is allowed to claim.

## A defect worth recording

Until the group 34 close-out, the policy layer decided and was not obeyed. `LLMProvider.get()` — the credential
guard the agent route calls first, so that "no key configured" is a clear 503 — cached the
`LLM_MODEL` client in the same slot the offline test override writes, and the broker treated that
slot as *a client somebody chose deliberately*. So on the request path every resolution was recorded
and none was honoured: `LLM_MODEL` served every call while the evidence record, the usage event and
the response envelope all named the resolved catalog entry.

It is recorded here rather than only in a commit message because it is the exact failure this
document would otherwise help somebody assume away: the resolution being *recorded* is not the same
property as the resolution being *served*, and the two are now separately tested.
