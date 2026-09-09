# Agents and orchestration

Weathra answers a question by running a small graph over four specialized agents. The shape of that
graph follows from one decision, and everything else in this document is a consequence of it.

## The decision: the graph executes tools; the model proposes and explains

The language model does two things, and neither of them is calculation:

1. **It proposes a plan** — which capabilities the question needs, in what order, and why —
   returned as JSON validated against a closed schema.
2. **It writes the prose** — from the findings the graph computed and handed it, and from nothing
   else.

Everything between those two steps is code: resolving the location and the window, calling tools,
computing statistics, assembling attribution, verifying the answer against the data.

**Why not let the model call tools?** Native tool-calling would put the model in charge of *when*
and *with what arguments*, and every figure in the answer would then depend on the model having
asked correctly. Weathra's requirement is the opposite: a figure has to trace back to a recorded
tool call with recorded arguments and a recorded result. With the graph executing, the evidence
record is a byproduct of how the run works rather than something the model can forget to produce.

It also makes the system model-agnostic. Routing needs a JSON object, not a vendor's function-call
protocol, so a model that cannot do tool-calling reliably — including a free tier — still routes,
and a model swap is configuration (`LLM_MODEL`) rather than an integration.

## The run

```
                      question, principal, thread
                                  │
                                  ▼
                        ┌───────────────────┐
                        │ route             │  supervisor: the model proposes a plan
                        │ (supervisor)      │  → capabilities, order, reason
                        └─────────┬─────────┘
                                  │ out of scope? → decline, retrieve nothing
                                  ▼
                        ┌───────────────────┐
                        │ resolve           │  location, window, units, thread references
                        │                   │  → ambiguous? ask, retrieve nothing
                        └─────────┬─────────┘
                                  ▼
                        ┌───────────────────┐
                        │ execute           │  the plan's steps, in dependency-ordered
                        │ (capability nodes)│  groups; independent steps run concurrently
                        └─────────┬─────────┘
                                  │ budget exhausted? → partial, and say so
                                  ▼
                        ┌───────────────────┐
                        │ synthesize        │  the model writes prose from the findings
                        │ (+ safety stance) │
                        └─────────┬─────────┘
                                  ▼
                        ┌───────────────────┐
                        │ finish            │  grounding audit, uncertainty, envelope,
                        │                   │  evidence record
                        └───────────────────┘
```

**Why an explicit sequence rather than a LangGraph node graph.** The stages are strictly ordered and
the only branching is "stop early" — declined, needs clarification, out of budget. Expressing that
as a node graph with conditional edges would add a layer of indirection over a sequence that reads
as one function, and would make the concurrent execution of an independent group harder to see, not
easier. LangGraph is used for what it is good at here: the checkpointer that persists
conversational state across turns.

## The four capabilities

The catalogue is a closed enum — `forecast`, `historical`, `analytics`, `rag` — and that enum *is*
the guard: a routing plan naming anything else fails schema validation, the model is told the four
valid names, and nothing executes. A capability cannot be requested into existence by a
persuasively-worded plan.

| Agent | What it does | How it gets data |
|---|---|---|
| **forecast** | Current conditions and forecast windows | `weather_current`, `weather_forecast` |
| **historical** | Archive retrieval, period comparison, baseline comparison | `weather_history`, then `weather_statistics` for the headline figures |
| **analytics** | Descriptive statistics, distribution, trend, anomaly, thresholds | `weather_statistics`, `weather_anomaly`, over a series a prior step retrieved |
| **rag** | Weather concepts and terminology from the knowledge corpus | pgvector retrieval, threshold-gated |

Two agents frame the run and are not capabilities: **supervisor** routes, **synthesis** writes.
All six appear in the evidence record with their status and timing.

**Analytics cannot retrieve.** The statistics and anomaly tools take a series as an argument and
have no provider and no way to fetch one, so analytics runs over points a retrieval step already
put in the state. That makes "the model interprets but never calculates" structural: there is no
path by which the analytics capability could obtain a number nobody retrieved.

## Routing, and what happens when it fails

Three outcomes, in order of preference:

1. **A valid plan** — recorded with `routing_source = "model"` and the model's own reason.
2. **An invalid plan, corrected on retry** — the validation error is sent back to the model with
   its own reply, bounded by `LLM_JSON_MAX_ATTEMPTS`. An out-of-catalogue capability lands here.
3. **Repeated failure, or no model configured at all** — a deterministic keyword router runs and
   the record says `deterministic_fallback`. The person still gets an answer; the reader is told
   how it was routed.

**The scope cross-check runs one way only.** A model that declares a plainly meteorological
question out of scope is overridden. A model that declares a question *in* scope is never
overridden by a keyword list — "Berlin for two days?" contains no weather word at all and is
obviously a forecast question. The asymmetry follows from which error costs more: a false "in
scope" spends one retrieval and the synthesis prompt still confines the answer, while a false "out
of scope" refuses a question Weathra could have answered.

## Resolution: asking rather than assuming

Before anything is retrieved, the run resolves what the question is *about*: the location (through
the geocoder, or from thread memory when the question says "there"), the window, and the unit
system (the request's, then the person's preference, then the default).

When a location matches several places and nothing chooses between them, the run **asks** and
retrieves nothing. Same for a reference — "compare it with last year" with no prior location in the
thread. A guess here would produce a fully attributed, entirely confident answer about the wrong
city, which is worse than a question.

## Budgets

Two bounds, both from configuration: `AGENT_MAX_STEPS` and `AGENT_WALL_CLOCK_BUDGET_SECONDS`. The
wall-clock bound measures real elapsed time from the moment the run starts. When either is
exhausted the run stops, answers with what it has, and marks the envelope partial with the reason —
a partial answer that says it is partial, never a truncated one that looks complete.

The wall-clock budget sits below the access token's lifetime, which is what keeps a long stream
from outliving its authorization.

## Grounding: three layers, honestly bounded

1. **The prompt.** Synthesis is given the findings and instructed to use no figure that is not
   among them, to name the place and period, and to say plainly what could not be answered.
2. **A hard guard.** If nothing was retrieved, no prose is produced at all — the answer states that
   there is nothing to report. This layer cannot be talked out of it.
3. **An audit.** Every figure in the prose is checked against the retrieved and computed values. An
   ungrounded figure is *reported* in the grounding report, and the report travels with the answer.

The audit reports rather than silently rewrites, and it does not accept unit conversions: 8.5 °C
and 47.3 °F are the same temperature, but accepting the conversion would make almost any plausible
number "grounded" and the layer would stop catching anything. The limits are documented in
[`privacy-ethics.md`](privacy-ethics.md) rather than overstated here.

## The safety stance

Weathra positions itself as an analyst, not a forecaster, and refers severe weather to the official
national meteorological service. The severity guard checks the *field names* of what was retrieved:
no measure Weathra normalizes describes severity, so any answer that would characterise conditions
as dangerous is accompanied by the referral. `specs/safety-grounding` is the requirement;
[`privacy-ethics.md`](privacy-ethics.md) is the discussion.

## The evidence record

Every agent run produces one, owned by the acting user, holding: the routing reason and its source,
each agent's status and duration, every tool call with its arguments, every tool result, the
analytics methods and point counts, the anomaly and trend reports, the knowledge citations, the
attributions, the data classes, the grounding report, the total duration, the steps used, and the
partial reason if there was one.

`GET /api/v1/evidence/{id}` returns it — to its owner. Another person's identifier gets the same
not-found treatment as an identifier that never existed, because "this exists but is not yours"
tells a stranger something.

## The LLM boundary

One Protocol with two methods:

```python
async def complete(self, *, system: str, messages) -> Completion
async def complete_json[Schema](self, *, system: str, messages, schema: type[Schema]) -> Schema
```

`complete_json` prompts and validates, sending a validation failure back with the model's own reply
on retry. Tool-calling is deliberately absent from the contract — the graph executes tools, so a
client only has to produce text and structured objects. `openrouter.py` is the gateway
implementation, `fake.py` the offline one, and the evaluation harness has a third that states the
findings it was handed.

`/ask` and `/stream` construct the client lazily, which is why the backend starts and serves every
other capability with no inference credential configured at all.

## The production Analyst failure of 2026-09-08, and what is actually known about it

Recorded because the first diagnosis was wrong, the wrong answer was expensive, and the cost of a
second wrong one is another rotation of a credential that may never have been at fault.

**What was seen.** A signed-in visitor on the Analyst screen was told: *"The inference provider
rejected the configured credential. Check OPENROUTER_API_KEY."* Two defects, not one, and neither
was the key. The message was an operator's checklist read out to a customer, fixed in `e151490`.
And `401` and `403` were collapsed into a single `AgentNotConfigured`, so a gateway that had
**accepted** the credential and then refused the request was reported as a credential that was
rejected — fixed in `eded048`, where a 403 raises `ProviderUnavailable` and records `provider_error`
in the evidence, because "nobody configured this" is a false statement about a deployment whose key
the gateway just accepted. `Settings` also normalises the credential's packaging — surrounding
whitespace and a copied `Bearer ` prefix — at the boundary every consumer reads it from, because
each of those produces a 401 indistinguishable from a wrong key.

**The classification, as of 2026-09-09: `UNRESOLVED_FROM_AVAILABLE_NON-CREDENTIALLED_EVIDENCE`.**

Not `AUTH_INVALID`. The only reason that word was ever attached to this incident is the error
mapping that has since been corrected, and a classification inherited from a defect is not evidence.

Two classes are ruled out by direct, non-credentialled probes:

| Class | Evidence |
|---|---|
| `AUTH_INVALID` | `GET https://openrouter.ai/api/v1/key` → **200**, no limit, usage 0 |
| `MODEL_UNAVAILABLE` | the configured model is in the public catalog, and a completion on it → **200** in ~0.5 s |

The configured model is read from the deployed service itself, without a session:
`GET /api/v1/ready` names it under `inference_provider`. It is **not** set in `render.yaml` —
production runs the `llm_model` default in `config.py`, which is the same model task 22.10 was run
against.

**Why it stops there, and why that is the right place to stop.** Production's own outbound call
cannot be observed from outside: `/agent/ask` and `/agent/stream` are authenticated by design, and
reading the service's logs or authenticating as any user needs a credential this project will not
spend on a diagnosis. The remaining classes — `RATE_LIMITED`, `QUOTA_EXHAUSTED`,
`PROVIDER_CAPACITY`, `TIMEOUT`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `OTHER_PROVIDER_ERROR` — are
not separable without it.

They do not need to be. Since `eded048` the backend records the class itself: the log line names
which status arrived, and the evidence record carries `not_configured` or `provider_error`
accordingly. **The next naturally occurring signed-in Analyst request classifies this**, at no cost
and with no credential spent. Until one happens, the honest entry is the one above, and this
unresolved diagnostic blocks nothing: the credential is not to be replaced, the model is not to be
changed to make a test pass, and no other work waits on it.
