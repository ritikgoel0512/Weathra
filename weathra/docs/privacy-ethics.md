# Privacy, honesty, and the limits of what Weathra claims

Weathra's central claim is that an answer can be traced to the data behind it. This document is
where that claim is stated precisely enough to be checked — including where it stops.

## Nothing is fabricated

**Every weather value comes from a provider or from a computation over provider data.** There is no
path by which a number reaches an answer otherwise:

- The analytics functions are pure functions over normalized series — no clock, no I/O, no
  configuration — so the same series always produces the same figures.
- The statistics and anomaly tools take a series as an *argument*. They have no provider and no way
  to fetch one, so the analytics capability cannot obtain a number nobody retrieved.
- A statistic that cannot be computed comes back with **no value and a reason**. Never a zero.
- An absent value in a series stays absent: excluded from the computation, and counted in the
  exclusions the result reports.

The model is asked for two things, neither of them arithmetic: a routing plan, and prose over
findings the graph computed and handed it. It is never the thing that calculates.

## Five data classes, never conflated

| Class | Means |
|---|---|
| `current` | Observed conditions now |
| `forecast` | A model's projection of conditions ahead |
| `historical_observation` | What was recorded in the past |
| `computed_statistic` | Derived by Weathra from one of the above, with its method stated |
| `ai_interpretation` | Language a model wrote |

Every value carries its class through the whole stack — tool result, API payload, and screen — and
the classes are never mixed in one figure. A forecast presented as an observation is a different
claim about the world, and a computed mean presented as a measurement hides the fact that a method
was chosen.

`ai_interpretation` is visually distinguishable in the interface from retrieved data, because the
distinction a reader most needs is between what was measured and what was said about it.

## Attribution on every weather answer

Every answer containing weather data carries **the provider, the location, the period covered, and
the retrieval time** — assembled by code, never by a model. A model that wrote its own attribution
would be a model that could get it wrong.

For a computed figure, attribution extends to the method and the point count: "mean of 168 hourly
values" is checkable in a way that "the average" is not. For a knowledge answer, the citations name
the document, its topic, and the chunk position.

## Uncertainty

A forecast figure is displayed with an uncertainty indication. Weathra states plainly that
confidence falls with distance into the horizon, and its uncertainty statement says what basis it
has:

- **What it can say honestly.** The horizon, how far ahead the figure is, and — where the provider
  supplies the necessary fields — the spread.
- **What it does not claim.** Weathra runs one provider in the MVP, so it has no multi-provider
  consensus and its uncertainty statement says so rather than implying a confidence interval it
  cannot compute. Multi-provider consensus is on the roadmap; presenting a single provider's output
  as consensus would be the kind of claim this document exists to prevent.

## Weathra is not a forecaster

Weathra analyses forecasts that meteorological services produce. It does not produce them, and it
positions itself that way in the interface rather than in a footnote — the phrasing is in
`agents/safety.py`, applied to answers rather than left to the model's discretion.

### It is not a replacement for official warnings

For severe or dangerous weather, Weathra refers people to their official national meteorological
service. Every answer that touches on hazardous conditions carries that referral.

### No unsupported severe-weather claims

An answer may not assert that conditions will be severe or dangerous unless the retrieved data
carries a field supporting that characterisation.

**And here is the honest part: no measure Weathra currently normalizes describes severity.** There
is no warning field, no alert level, no hazard classification in the provider data. So the guard
fires on *every* answer that would make such a claim — the referral is the answer, not a hedge
appended to one. The guard checks the field names actually present in what was retrieved, so if a
severity field is added later the behaviour changes for the right reason rather than because
somebody edited a prompt.

A referral is not a claim. "Check your official authority for warnings" asserts nothing about
conditions, and the evaluation metric that counts unsupported claims looks for an assertion rather
than for the word "severe".

## Grounding: three layers, and what each cannot do

1. **The prompt.** Synthesis is given the findings and instructed to use no figure that is not
   among them, to name the place and period, and to say plainly what could not be answered.
   *Limit:* a prompt is an instruction, not an enforcement.
2. **A hard guard.** If nothing was retrieved, no prose is produced at all — the answer says there
   is nothing to report. *This layer cannot be talked out of it*, which is why it exists separately
   from the prompt.
3. **An audit.** Every figure in the prose is checked against the retrieved and computed values, and
   the grounding report travels with the answer, naming the figures it checked and any it could not
   ground.

**The audit reports rather than silently rewrites.** An answer whose figures cannot all be grounded
is surfaced as such, because quietly deleting a sentence would hide a failure that somebody needs to
see.

**It does not accept unit conversions.** 8.5 °C and 47.3 °F are the same temperature, and an audit
that accepted the conversion would accept almost any plausible number as "grounded" — 47.3 is a
believable Fahrenheit figure, and so is 8.5 as a Celsius one, and once both directions and several
units are permitted the check stops catching anything. So the audit compares figures as stated,
and the layer keeps its teeth at the cost of occasionally flagging a legitimate conversion.

**What none of the three can do:** verify a *qualitative* claim. "It will feel unpleasant" contains
no figure. The layers bound the numbers, the safety stance bounds the severity claims, and prose
judgement in between is not something this system claims to verify.

## Unavailable data is stated, never substituted

When data cannot be retrieved, the answer states the **specific** reason — the location could not be
resolved, the period is outside coverage, the provider failed, the measure was not supplied — and
substitutes nothing: not another period, not another location, not another provider, and not the
model's own knowledge.

Partial availability is reported precisely: what was retrieved, and what was not. A run that ran out
of its budget answers with what it has and marks the envelope partial with the reason. A partial
answer that says it is partial is useful; a truncated one that looks complete is worse than nothing.

An ambiguous location is **asked about** rather than guessed. A guess produces a fully attributed,
entirely confident answer about the wrong city.

## What is persisted, and for how long

| Data | Why it exists | Retention |
|---|---|---|
| Profile (`profiles`) | Something for Weathra's own tables to hang ownership from | Until the person deletes their data |
| Preferences | Unit system, forecast horizon, default location — explicitly chosen, non-sensitive | Until deleted or reset |
| Saved locations | Places the person chose to save, bounded by `SAVED_LOCATIONS_LIMIT` | Until removed |
| Threads and checkpoints | Bounded conversational context, so a follow-up can say "there" | `THREAD_RETENTION_DAYS` (30 by default) after last activity |
| Evidence records (`agent_runs`) | The record behind each answer, which is the product's central promise | Until the person deletes their data |
| Forecast snapshots | *What changed?* needs the previous snapshot. Location-keyed, no user reference | `SNAPSHOT_RETENTION_DAYS` (90 by default) |
| Knowledge corpus | The documents a concept answer cites. Shared, read-only | Version-controlled |
| Evaluation records | Acceptance runs. Operational, not user data | Kept |
| Plan and policy records | Which tiers exist, which models are allowed, which candidates each policy declares, what each tier allows. Operational, not user data | Kept |
| Plan assignment (`user_plans`) | Which tier a person is on, so entitlement is a backend fact rather than a client claim | Until the person deletes their data |
| Usage counters | How much of a windowed allowance a subject has consumed, so a limit can be enforced before a call rather than apologised for after | `LLM_USAGE_RETENTION_DAYS` after the window closes |
| LLM usage events | One metadata row per language model call — model, policy, plan, role, tokens, estimated cost, latency, outcome. **No prompt, completion or retrieved text** | `LLM_USAGE_RETENTION_DAYS`, and removed with the person's data |
| Model evaluations and comparisons | Which model scored what, on which dataset, at which commit. Operational, not user data | Kept |
| Administrative audit | Who changed which operational record, and from what to what | Kept |

**Nothing else.** No arbitrary conversation content beyond the bounded thread retention, no
behavioural profile, no analytics on what people ask.

### Usage measurement holds no conversation content

The per-call usage record exists so that model choice, cost and quota enforcement are factual
rather than anecdotal. It deliberately holds only metadata: which catalog entry and gateway model
served the call, which policy resolved it, which plan and call role it was made under, the token
counts, an estimated cost, the latency, and whether it succeeded. It holds **no prompt, no
completion, and no retrieved passage** — which is what makes an administrative total across
accounts safe, because a table with no content in it cannot disclose content. Where diagnosing a
failure needs more than metadata, the row points at the agent run whose evidence record already has
its own ownership and its own retention, rather than copying anything into telemetry.

Internal work — evaluation runs, model comparisons, administrative activity — is recorded against a
reserved internal subject and is never counted against anyone's plan. Estimated cost is exactly
that: an estimate computed from recorded token counts and the catalog price of the day, labelled as
an estimate wherever it appears, and never presented as an amount owed. Weathra performs no payment
processing and stores no payment details.

## Where credentials and contact data live

**In Supabase Auth, and nowhere else.** Weathra's application tables reference a person only by
their authentication subject. They hold no password, no token, and no contact detail beyond the
address the validated token already carries.

**No credential reaches a log, an error body, a tool result, or an evidence record.** A redaction
pass is applied on the way out, a token validation failure is logged with its *reason* and never
with the token, a 500 logs the detail and returns only a code and a request id, and the evaluation
run record holds its test user's access token in a field that does not serialize. `/ready` names
which configuration variable is missing and never its value — that a variable is required is
documentation; its contents are not.

The service-role key bypasses every Row Level Security policy, which is why the settings validator
refuses to start a request-serving process that has it and why CI asserts it appears in neither the
frontend environment nor the built bundle. See [`authentication.md`](authentication.md).

## Deleting your data

Two levels, both available to the person themselves, and both confirmed rather than silent:

- **A thread** — `DELETE /api/v1/threads/{id}` removes the thread and its checkpoints. Checkpoints
  first: a checkpoint whose thread row is gone is unreachable garbage.
- **Everything** — `DELETE /api/v1/me/data` removes the profile, preferences, saved locations,
  threads, checkpoints, and evidence records, and answers with **the count removed per table**, so
  the person sees what happened instead of being told "done".

The Supabase Auth account is deleted in Supabase, which owns it. Retention also runs on a schedule
(`weathra-retention`, under the privileged connection) against the configured windows, so a thread
nobody deletes still expires.

Nothing here requires a support request. A person can see their data, ask what it was used for
(the evidence record answers that per question), and remove it.
