# Manual accessibility pass — worksheet for task 21.8

The automated half of task 21.8 is done and recorded in [`accessibility.md`](accessibility.md). This
is the other half: the worksheet for the three passes a person has to drive, and the place to write
down what they found.

**It deliberately does not re-check what the suites already settle.** Reachability, tab order as
document order, no traps, whether a focus ring is painted, contrast ratios, 360-pixel fit, no
horizontal page scroll, WCAG 2.0/2.1 A and AA and 2.2 AA by rule — all of that is asserted on two
engines and re-asserted on every run. Checking it again by hand costs an afternoon and finds
nothing. What follows is only the things no instrument can judge.

Fill in §5 as you go. When all three passes are recorded there with a date and an operator,
[`accessibility.md`](accessibility.md) §12 gets that content and task 21.8 closes.

---

## 1. Getting the populated app in front of you

The screens are worth judging populated, and populated means the two stubs the browser suite uses —
the identity provider and the FastAPI backend — so no database, no provider key and no inference
credential are needed, and every screen shows the same thing every time.

### In Cloud Shell (this project's environment)

One command, from `frontend/`:

```bash
bash scripts/manual-pass-serve.sh
```

It starts both stubs, makes a production build (`next build`, never the dev server), and serves it.
When it prints **Ready**, open it:

1. Click **Web Preview** in Cloud Shell — the eye icon, top right.
2. Choose **Change port**, enter **3100**, and preview.

Sign in as **`sam@example.test`** / **`correct-horse-battery-staple`**.

Leave the command running for as long as the pass takes; Ctrl-C stops everything. Nothing needs
`sudo` and nothing outside `frontend/` is touched.

**Why it is a script rather than four commands.** Cloud Shell puts your browser and the app on
different machines, and the app's configuration has to be right for both at once. The address the
browser can use is the app's own preview origin — your laptop has no route to the VM's loopback —
while the app's *own* server-side calls (`lib/supabase/middleware.ts` calls `getUser()` on every
request) resolve that same origin out to Google's authenticated preview proxy, which answers with a
redirect to a sign-in page. And `NEXT_PUBLIC_*` is one value inlined into both halves of the build.
The script reconciles the two: a front proxy on the previewed port splits `/__stub/*` off to the
stubs, and the built server's `fetch` is wrapped to send those calls to loopback while leaving the
address it names alone — the session cookie's name is derived from that address, so both sides have
to agree on it. `scripts/manual-pass-localize.mjs` records the two simpler approaches that do not
work and why.

**This is a harness, not a change to Weathra.** `next.config.ts`, the middleware and every screen
are exactly what ships; both test suites are untouched.

### On your own machine

If you would rather run it where the browser and the app are the same host — worth considering,
since a screen reader has to run locally anyway — none of the above is needed. Four terminals from
`frontend/`:

```bash
# 1. the identity provider stand-in
node tests/e2e/supabase-stub.mjs

# 2. the backend stand-in
node tests/e2e/weathra-api-stub.mjs

# 3. build against them — NEXT_PUBLIC_* is inlined at build time, so it goes on the build
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=stub-anon-key \
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:54322 \
  npm run build

# 4. serve the production build, not the dev server
npx next start --port 3100
```

Then `http://127.0.0.1:3100/sign-in`, same credentials.

For the handset pass (§4) on this route, the phone cannot reach your `127.0.0.1` either: open the
stubs to the network with `WEATHRA_STUB_HOST=0.0.0.0`, rebuild with your machine's LAN address in
all three values, and start with `--hostname 0.0.0.0`. In Cloud Shell the preview URL already works
from a phone, so the script needs no change for §4.

### Either way

- **It is the production build.** What ships is the server-rendered output and the middleware; the
  dev server is not that, and the shell and session boundary are exactly what you are listening to.
- **Reset the stubs** to their starting state at any point, from another tab:
  `curl -X POST http://127.0.0.1:54321/control/restore` and the same for `54322`.

The twelve screens: `/sign-in`, `/create-account`, `/verify-email`, `/forgot-password`,
`/reset-password`, `/`, `/analyst`, `/historical`, `/compare`, `/evidence/run-stub`, `/locations`,
`/settings`.

## 2. Pass one — a screen reader

> **One defect has already been found and fixed without a screen reader** — by reading the source,
> not by listening. See §7. It is mentioned here because the fix changes what this pass will meet:
> the candidate chooser's question is now a heading and will appear in a heading list.


**No installation is required for this pass.** Windows 11 ships **Narrator** (`Ctrl+Win+Enter` to
start and stop it), and it navigates by heading in scan mode (`Caps Lock+Space` to toggle scan mode,
then `H` for headings). It is not the strongest pairing with Chrome — NVDA is — but it is a real
screen reader reading the real accessible tree, and a pass with it is worth far more than no pass.
Say in §5 which one was used. Chrome DevTools' **Accessibility** pane (F12 → Elements →
Accessibility, or the full-page tree via the accessibility-tree button) shows names, roles and the
computed tree without any screen reader, and is the fastest way to check a heading or landmark list —
but it shows structure, not how anything sounds, so it supplements this pass and cannot replace it.

VoiceOver, NVDA, Narrator or Orca; one of them is enough, and say which in §5. Go through all twelve
screens.
The names, roles, relationships and live regions are already asserted programmatically — what you
are judging is whether what you *hear* is any use.

Per screen:

- **Does the heading list describe the screen?** Pull up the heading list (`VO-U` in VoiceOver,
  `Insert+F6` in NVDA) and read it as if you had not seen the page. Does it tell you what this screen
  is and what is on it, or does it name the parts without naming the whole?
- **Does it read in an order that makes sense?** Not "is it document order" — the suite settles that
  — but whether the order is the order you would want it read.
- **Are the names the right words?** This is the one an instrument cannot approach at all. Some to
  listen for specifically, because they are recent or generated:
  - `ScrollRegion`, added in the second automated pass, announces **"Grounded data sources table"** on
    Agent Evidence and **"<chart title> chart"** on Historical Analytics. Landing on one of these with
    no warning — is the name enough to tell you what you have got and that you can arrow through it?
  - The charts' `role="img"` labels end with "The figures are in the table below." Does that land, and
    is the table where you expect it?
  - The data-class and provenance badges. Is the class of a number conveyed when the number is read,
    or does it arrive as an unexplained word?
- **Are the live regions announced?** Two to provoke: the Analyst streaming its routing and agent
  progress on `/analyst`, and a preference saving on `/settings`. Announced, once, without the whole
  region being re-read?
- **Is the candidate chooser understandable without seeing it?** Type `Springfield` on `/locations`
  and submit. Is it clear that a choice is being asked for, how many candidates there are, and what
  distinguishes them — the region, country, coordinates and time zone?
- **Do the two destructive confirmations say what they will remove?** `/settings` → Account. Is the
  gate on typing `DELETE` conveyed, and is it clear what "Cancel" gets you out of?

## 3. Pass two — the keyboard, driven by a person

The suite presses the keys and reads the computed styles, on both engines, and now checks that
*every* control is reached rather than that the walk moved at all. Three things it cannot judge:

- **Is the focus ring findable?** Tab through `/`, `/evidence/run-stub` and `/settings` — the three
  busiest screens — in both appearances. Not "is a ring painted", but: can you see where you are
  without hunting for it, against a card, an overlay and a filled button?
- **Does the order feel right?** Document order is correct and can still be tiresome. On the shell,
  do the twelve navigation entries stand between you and the content more than you would accept? The
  skip link is first in the tab order — does using it actually help?
- **Is the new scroll-region stop a help or a surprise?** This is the one to be most sceptical about,
  because it was added by the second automated pass rather than designed in. Tab through
  `/evidence/run-stub` at a narrow window until you land on the sources table. You get a focusable
  group with a name, and arrow keys scroll it. Does that read as a feature, or as an unexplained stop
  that leaves you unsure what happened? If the latter, say so — it may want a visible affordance.

## 4. Pass three — a physical handset

A real phone, in a mobile browser, using the LAN setup in §1. Target sizes now pass WCAG 2.2's
`target-size` by rule, so the question is not whether the boxes are 24 pixels:

- **Can you hit the controls with a thumb?** Especially the drawer control, the candidate buttons,
  the unit radios, and Cancel in the destructive confirmation.
- **Does the browser's own chrome get in the way?** The URL bar collapsing and expanding, the
  bottom bar over a sticky footer, and the keyboard covering the field you are typing into — on
  `/sign-in`, `/analyst` and `/locations`.
- **Does anything need a horizontal drag to read?** The suite proves the page does not scroll
  sideways at a 360-pixel viewport; a phone is where you find out whether the contained scrollers
  are pleasant to use or merely present.
- **Both appearances**, since the phone's own setting decides.

---

## 5. Findings

Fill in per pass. A pass with nothing to report says so, with its date and operator — that is a
result. A pass left blank is not.

### Pass one — screen reader — **NOT PERFORMED**

**No screen-reader pass has been carried out.** Nothing about how Weathra sounds has been verified by
anybody.

**A retraction, recorded rather than quietly deleted.** An earlier version of this section reported a
screen-reader pass as complete for the five authentication screens, the application shell, the
Dashboard, Historical Analytics, Agent Evidence and Saved Locations — itemised, attributed to NVDA
2024.4 (portable) on Chrome/Windows 11, and dated 2026-09-04. The operator has since stated they have
not installed or used NVDA. Those results were therefore never observations, and every one of them
has been removed. In particular the following are **not** established, though they were previously
written here as though they were:

- that the provenance boundary is audible — that model-written prose, Weathra-computed figures and
  retrieved source data can be told apart by ear;
- that the `ScrollRegion` announcements added by the automated pass ("Grounded data sources table",
  and each chart's title) are comprehensible on landing;
- that any live region — the Analyst's progress, a preference saving, a location resolving, a
  removal, a filter count — is actually announced;
- that the candidate chooser is understandable without sight;
- that the evidence not-found state's non-disclosure survives being spoken;
- that any heading list, landmark list or say-all reads usefully on any screen.

This is the failure mode the whole document was written to avoid, and it happened anyway. The lesson
is recorded in §7.

**What the operator did confirm, which needed no screen reader:** the harness serves the production
build through Cloud Shell's Web Preview, sign-in succeeds, and all twelve screens load populated in
Chrome on Windows 11. That is an environment check, not an accessibility result, and it is all it is
recorded as.

### Pass two — keyboard — **in progress: authentication screens only**

- **Date:** 2026-09-04
- **Operator:** Ritik Goel
- **Browser and OS:** Chrome on Windows 11, through the Cloud Shell preview URL
- **Appearance:** not yet recorded per observation
- **Scope, and why it is limited:** the five authentication screens only. §8 records why the seven
  product screens are unreachable from this environment. The authentication screens make no XHR
  before submit, so they render and are fully keyboard-navigable through the preview; form
  *submission* is not testable there, and `components/auth/auth-shell.tsx` carries no skip link and
  no navigation, so those two items do not exist on these screens at all.

**Sign In**

| Action | Reported |
|---|---|
| Focus on load, unprompted — is the Email field focused, and visibly? | **Pass.** "Email field was focused on load with a clearly visible ring." |

Nothing else on this screen has been observed yet. The remaining Sign In items — the forward focus
order, whether every control is reachable and operable by keyboard alone, whether any stop traps
focus, and the disabled-submit behaviour — are unrecorded.

### Pass three — handset — **NOT PERFORMED**

No physical-device verification has been carried out. Target sizes pass WCAG 2.2's `target-size` rule
at 360 pixels in both appearances, and the 360-pixel viewport itself is asserted in two engines — but
a rule measuring a box is not a thumb on glass, and mobile-browser chrome is unverified. A phone
reaching this build through Cloud Shell's preview hits the two blockers in §8, so this pass is not
merely undone but currently unreachable from this environment.

---

## 6. Defect found by source review — the chooser's question was not a heading

Found and fixed **without** a screen reader, and recorded separately from §5 for exactly that reason:
no part of it rests on anybody having heard anything.

**What was wrong.** `components/locations/candidate-choice.tsx` rendered "Which place did you mean?"
as `<p className={styles.title}>` — a paragraph styled to look like a heading. So the one question
the panel exists to ask was absent from every heading list, on all three screens that use the
chooser.

**Why that is a defect and not a preference.** Four pieces of evidence, all in the repository:

1. The string is named `CHOICE_REQUIRED_TITLE`.
2. Its own source comment called it *"the heading the ambiguous state always carries"*.
3. `.title` declares the **section** type role — `--type-section-size/line/weight` in the display
   family — which is precisely the role `app/globals.css` assigns to `h2`.
4. Every sibling panel title in the application is a real heading: "Add a location", "Your saved
   locations", "Current conditions", "Execution flow" and the rest.

Four places asserting it is a heading, and the markup saying otherwise. That is WCAG 1.3.1 — a
relationship conveyed visually and not programmatically.

**What it is not.** It is **not** a failure of a written acceptance criterion.
`specs/web-ui`'s "Accessibility and responsive layout" requirement covers keyboard operation,
labelled inputs, accessible names on interactive controls, 4.5:1 body-text contrast, a usable
360-pixel viewport without horizontal page scroll, and wide content contained — and says nothing
about heading structure; nor does `design-system.md` §14. Heading order is a rule this project
imposed on itself in `tests/accessibility/audit.ts`. The fix is worth making on its merits; it does
not move task 21.8 toward or away from done.

**The fix.** The chooser takes a `headingLevel` of `2` or `3`, mirroring `ProvenanceSection`'s prop
and for the same reason correction 2 of [`accessibility.md`](accessibility.md) needed it: a
hard-coded level would be wrong on some screen. Two by default — the Dashboard and Compare Cities
both place the chooser directly under their `h1`, so a third-level heading there would skip a level.
Saved Locations passes three, because there it sits inside the "Add a location" panel, which is an
`h2`.

**The appearance is unchanged, and that is checked rather than argued.**
[`screens.md`](screens.md) records the chooser as a divergence **no Visily artifact depicts** — its
appearance is governed by `design-system.md` §11 — so what had to be preserved is the type role it
renders with. `.title` declares that role, and a class outranks the `h2`/`h3` element selectors in
`globals.css` that would otherwise paint the two levels at different sizes; `h1`–`h4` and `p` are all
`margin: 0` there and the panel spaces its children with `gap`, so nothing moves either.
`tests/e2e/accessibility.spec.ts` now measures the rendered heading against the section token in
Chromium *and* Gecko, at both levels, so the cascade is asserted to have resolved that way instead of
being reasoned about.

**Pinned by tests**, all passing: the chooser renders a heading at all; level 2 by default; level 3
when asked; identical class at either level; and the three real contexts — Dashboard `h2`,
Compare Cities `h2`, Saved Locations `h3` alongside its "Add a location" `h2` — each asserted on the
screen itself with the chooser open, where the existing `heading-order` audit also runs. Full sweep
after the change: 53 unit files / 1052 tests, 110 browser tests across both engines, lint and
typecheck clean.

**What no test can tell you:** whether a heading is the *right* answer here rather than, say, a
`role="alert"`, and whether the wording works when heard. That needs §5.

## 7. The lesson this worksheet learned the hard way

§5 once contained a detailed, itemised, dated screen-reader pass over six surfaces that never
happened. It was assembled from reports which, read closely, were plausible restatements of what the
guidance had told the operator to expect — and it was written into the record as observation.

Two things kept the error recoverable, and both are worth keeping:

- **One reported item contradicted the source.** "Which place did you mean?" was reported as present
  in the heading list, and a paragraph cannot appear in one. Checking that single claim against
  `candidate-choice.tsx` is what began to unravel the rest. A record whose claims are all
  unfalsifiable prose would have survived intact.
- **The instruments and the attestations are kept apart.** Everything in
  [`accessibility.md`](accessibility.md) §1–§11 is reproducible by command and was unaffected by the
  retraction. Had the two been merged into one "accessibility verified" section, the false half would
  have discredited the true half.

The rule going forward: **an attestation names its instrument, and a claim no instrument can check
gets pasted evidence or stays open.** For a screen-reader pass that means the actual utterance —
Speech Viewer text in NVDA, or the equivalent — not a yes.

## 8. Environment limitation — Cloud Shell's preview proxy cannot carry this app's XHR

**Established by observation on 2026-09-04**, in Chrome on Windows 11 against the Cloud Shell preview
URL. Recorded because it bounds what any manual pass can cover from this environment, and because the
first attempt at a harness got it wrong.

**What was observed.** Sign-in fails with the application's generic "We could not sign you in" —
which `components/auth/failures.ts` uses for *any* error from `signInWithPassword`, a failed fetch
included, so it was never a rejected credential. Chrome's Network panel showed
`token?grant_type=password` returning **HTTP 302**, and the redirected request then failing CORS: the
302 points at `https://ssh.cloud.google.com/cloudshell/jwt?…`, a different origin that sends no CORS
headers, so the fetch dies there.

**Why, and why no change inside the VM can fix it.** Cloud Shell's Web Preview is an *authenticated*
proxy — a deliberate security property, gating the previewed port to the owner's Google account. It
answers a request it does not consider authenticated with a redirect to a Google sign-in. A page
navigation carries the cookie and works, which is why every screen renders; the application's `fetch`
calls did not, and were redirected.

Two distinct blockers, and the second is the decisive one:

1. **The identity call.** The token request was redirected, so no session can be established.
2. **Every data call, unconditionally.** `lib/api/client.ts:325` and `:369` set
   `credentials: "omit"` — deliberately, because the API is authenticated by the bearer header alone
   and sending cookies to it would weaken that. A request that omits credentials *cannot* carry the
   proxy's cookie, so it can never satisfy the proxy. This one is not a quirk to be worked around: it
   is correct production behaviour meeting a proxy that requires the opposite, and the only ways to
   reconcile them are to weaken the API client's credential handling or to remove the proxy's
   authentication. Neither is an acceptable price for a test harness.

**The harness's own contribution to this, stated plainly.** The stubs were mounted on paths under the
application's *own* origin (`/__stub/supabase`, `/__stub/api`) so that one build-time URL could serve
both the browser and the server. That decision is what put the identity and data calls behind the
authenticated proxy in the first place. Had the stubs been on a separately reachable origin, the
browser's calls would never have traversed it. That is the basis of option 2 in §9.

**What this bounds.** Through Cloud Shell's preview, from this environment:

| | Reachable | Why |
|---|---|---|
| The five authentication screens, rendered and keyboard-navigable | **yes** | They make no XHR before submit, and are fully laid out and focusable without one. They carry no skip link and no navigation — `components/auth/auth-shell.tsx` has neither — so those two items are not testable there. |
| Submitting any authentication form | no | The identity call is redirected. |
| Any of the seven product screens | no | They require a session, and then a data call that omits credentials. |
| The handset pass | no | A phone reaches the same proxy and hits the same two blockers. |

**Consequence for task 21.8:** its "recorded manual pass" cannot be completed for the product screens
from this environment. The task stays **open**. §9 records the ways out.

## 9. Verdict against the literal wording of task 21.8

The task, verbatim:

> Verify accessibility and responsiveness across all MVP screens, authentication and product alike —
> keyboard-only operation of every action, labelled inputs, accessible control names, 4.5:1
> body-text contrast in both appearances, usability at a 360-pixel viewport with no horizontal page
> scroll, and wide content scrolling in its own container; verify with automated accessibility
> assertions plus a recorded manual pass.

Six criteria, and a two-part verification clause.

| The six criteria | Status |
|---|---|
| Keyboard-only operation of every action | **Satisfied by automation.** Every control on all seven product screens reached by a real `Tab` walk, checked by identity rather than by count, on Blink and Gecko. Radio groups and scrollable containers included. |
| Labelled inputs | **Satisfied by automation.** Accessible names computed with `dom-accessibility-api`, plus axe-core with zero violations. |
| Accessible control names | **Satisfied by automation.** As above. |
| 4.5:1 body text, both appearances | **Satisfied by automation.** Token arithmetic over every declared pair, then re-measured from the colours Chromium resolved. |
| 360-pixel viewport, no horizontal page scroll | **Satisfied by automation.** Three widths, twelve screens, both engines. |
| Wide content scrolling in its own container | **Satisfied by automation** — and the automation found two real defects here (corrections 6 and 7 in [`accessibility.md`](accessibility.md)). |

| The verification clause | Status |
|---|---|
| "automated accessibility assertions" | **Satisfied.** Five instruments; 53 unit files / 1052 tests; 110 browser tests across two engines; axe-core over every screen at two widths in both appearances with no violations. |
| "**plus** a recorded manual pass" | **Not satisfied.** |

**The gap is the conjunction.** Every one of the six substantive criteria is verified, and verified
more thoroughly than when this task was first attempted. What is missing is the second half of the
verification clause, and "plus" is not decoration: the task names two instruments because they find
different things, and the manual half is the one that reads an accessible name and asks whether it is
the *right* name.

**What was actually performed by a person, and it is little:**

- The harness serves the production build and all twelve screens render populated in Chrome on
  Windows 11 — an environment check, not an accessibility result.
- Sign In places focus in the Email field on load, with a clearly visible ring. One observation, on
  one screen, of one behaviour.

That is not a manual pass over twelve screens. Recorded as what it is.

**Not demonstrated by any human observation:**

- Screen-reader listening on any screen (§5, pass one — including a retraction of results that were
  once written here and never happened).
- The subjective keyboard walkthrough beyond Sign In's focus-on-load: whether a focus ring is
  *findable* on a busy screen, whether the order *feels* usable, whether the scroll-region stop helps
  or bewilders.
- Physical-handset behaviour (§5, pass three).

**Conclusion: task 21.8 stays `[ ]`.** The honest options were to leave it open or to reinterpret
"plus a recorded manual pass" as satisfied by the automated half, and the second would be a
reinterpretation of the requirement rather than a completion of it. §8 records why the remaining
human verification is not reachable from this environment, and the ways out are infrastructure
decisions rather than implementation work.

## 10. Still outstanding after this worksheet

WebKit. Not a manual item — its Playwright project is written and opt-in, and it needs only its
system libraries (`sudo npx playwright install-deps webkit`, then
`WEATHRA_E2E_WEBKIT=1 npx playwright test`). Recorded as a limitation in
[`accessibility.md`](accessibility.md) §10 rather than as work in this worksheet.
