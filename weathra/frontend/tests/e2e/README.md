# Playwright flows

Browser-level verification. Vitest is configured to exclude this directory; run it with
`npm run test:e2e`.

Everything here drives the **real production build** (`next build` then `next start`) so the
middleware, the server-resolved layout and the cookie session are the ones that ship. Two processes
are stood in for, both on the far side of a boundary Weathra already has:

| Stub | Stands in for | Control routes |
|---|---|---|
| `supabase-stub.mjs` | Supabase Auth (`NEXT_PUBLIC_SUPABASE_URL`) | `/control/expire`, `/control/restore`, `/control/health` |
| `weathra-api-stub.mjs` | the FastAPI backend (`NEXT_PUBLIC_API_BASE_URL`) | `/control/revoke`, `/control/restore`, `/control/requests`, `/control/health` |

Driving them independently is the point: a session the *provider* stops recognising is a middleware
redirect, and a 401 from the *backend* while the provider still recognises the session is the
in-place expired-session state. They are different mechanisms and `protected-route.spec.ts` proves
each separately.

- **`protected-route.spec.ts`** — task 18.10: the destination-preserving redirect, the authenticated
  render, no flash of protected content, and a 401 from the API producing the expired-session state
  rather than a data error.
- **`accessibility.spec.ts`** — task 21.8, the part of accessibility that only a browser can settle:
  whether a page scrolls sideways at 360 pixels, whether a focus ring is actually painted, whether
  every control is reached by a real `Tab`, and whether wide content scrolls in its own container and
  that container can be reached. jsdom has no layout and no cascade, so a component test claiming any
  of these would be claiming what it cannot see.
- **`axe.spec.ts`** — task 21.8's rule-based half: axe-core over every MVP screen at 360 and 1440
  pixels in both appearances, plus the candidate chooser, the destructive confirmation and the open
  drawer. WCAG 2.0/2.1 A and AA plus 2.2 AA (for `target-size`); `best-practice` is deliberately off.

## Engines

Two projects, `chromium` (Blink) and `firefox` (Gecko), both running everything — a focus ring, a
`:focus-visible` decision and a reflow are the engine's behaviour rather than Weathra's, and the
second engine caught a test that was passing on Blink for a reason Gecko does not share (see
correction 8 in [`docs/design/accessibility.md`](../../../docs/design/accessibility.md)).

WebKit is a third project behind an opt-in. Its binary installs with
`npx playwright install webkit`, but launching it needs system libraries only root can install
(`sudo npx playwright install-deps webkit`); rather than fail for everyone who has not done that,
run it with `WEATHRA_E2E_WEBKIT=1 npx playwright test` once they are present.

- **`flows.spec.ts`** — task 21.10's four product flows: sign up through verification into the
  product; ask a question then open its evidence; save a location then see the unit preference
  applied; and an expired session routed to sign-in. Each drives the real build and asserts
  user-visible outcomes; `beforeEach` restores both stubs and clears cookies, so no flow inherits
  another's account, thread, saved location, preference or evidence record.

## What the stubs model, and why it is not a convenience API

The two stand-ins answer the **production** contracts, so a flow that passes here would pass against
the real services:

| Contract | Where it comes from |
|---|---|
| `POST /auth/v1/signup` returning a user and **no session**, `POST /auth/v1/verify` issuing one on the right code and `otp_expired` otherwise, `POST /auth/v1/resend` | GoTrue's own paths, methods and error codes, as `@supabase/auth-js` calls them |
| The eight-event SSE vocabulary — `routing`, `agent_start`, `agent_end`, `tool_start`, `tool_end`, `answer_delta`, `final`, `error` — one named event and one JSON data line per block, every payload carrying a monotonic `sequence` from 1 and a `request_id` | `backend/weathra/api/streaming.py`, event for event. The sequence matters as much as the names: `hooks/use-agent-stream.ts` reports a *gap* if the numbers are not contiguous |
| `text/event-stream` with `no-cache, no-transform`, `keep-alive` and `X-Accel-Buffering: no` | the same headers `sse_headers()` sends |
| Evidence by identifier, served only at the id the stream's `final` event returned | `specs/http-api`: one evidence endpoint, a record by its id, and none enumerating a person's runs |
| `GET`/`POST /api/v1/me/locations`, `DELETE .../{saved_id}`, `GET`/`PUT`/`DELETE /api/v1/me/preferences`, with `PreferenceUpdate` and `SavedLocationRecord`'s `created_now` | `backend/openapi.json` |
| Weather reads answered in the unit system the request asked for | the real backend converts, and a stub that always answered in Celsius would let a saved preference "pass" while nothing was applied |

Two deliberate properties of the doubles worth knowing:

- **The resolver is ambiguous only where a name really is.** "Springfield" returns two candidates —
  which is what the 21.7 and accessibility specs drive the chooser with — and any other name
  resolves. A geocoder does not find two places for every name, and one that did would make an
  unambiguous save untestable.
- **No credential is checked and no token is signed.** The identity stub accepts any password; the
  backend stub accepts any non-empty bearer. They are boundaries, not security.

Nothing outstanding: task group 21's browser coverage is complete. Task 21.8's *manual*
accessibility pass remains open and is tracked in
[`docs/design/accessibility-manual-pass.md`](../../../docs/design/accessibility-manual-pass.md),
which is a human activity rather than a suite.
