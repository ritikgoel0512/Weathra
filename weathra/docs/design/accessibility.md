# Accessibility and responsiveness audit — task 21.8

**Status: the automated and browser-level verification is complete on two engines; the human manual
pass is outstanding.** See §12. Task 21.8 asks for "automated accessibility assertions **plus** a
recorded manual pass", and the second of those is a human driving the screens — which is not
something this record can honestly claim on somebody's behalf. Everything else below was
demonstrated and is reproducible with the commands in §11.

The pass over every MVP screen, authentication and product alike, against the four things
[`specs/web-ui`](../../openspec/changes/weathra-mvp/specs/web-ui/spec.md) requires: keyboard
operation of every action, a label on every input and an accessible name on every interactive
control, body text at 4.5:1 in both appearances, and usability at a 360-pixel viewport with no
horizontal page scroll and wide content scrolling in its own container.

**Date:** 2026-09-04 · **Build audited:** the production build (`next build`, then `next start`),
not the dev server · **Browsers:** Chromium 1234 (Blink) and Firefox 153 (Gecko), both via
Playwright 1.62.1, dark and light appearance.

This record was written in two passes on the same day. The first covered one engine with
hand-written assertions; the second added axe-core, added Gecko, and is where corrections 6 to 9
came from. The findings of both are folded in below rather than kept as a diary — but the second
pass is the reason §9 has nine entries and not five, and the reason §10 no longer lists a single
browser engine as a limitation.

## 1. How each criterion was verified

Five instruments, because the criteria are facts about different things. Nothing below is claimed by
an instrument that cannot see it.

The fifth is axe-core, and it is there because the other four share a blind spot. A hand-written
assertion checks what somebody thought to check; its gap is by definition the thing nobody thought
of. axe-core runs the other way — a maintained corpus of rules against the rendered page — and
neither subsumes the other. A rule engine cannot know that Weathra must not preselect a location
candidate; a hand-written suite did not think to ask whether the container it was so pleased to have
made scrollable could be reached by a keyboard at all. That question is where corrections 6 and 7
came from.

| Criterion | Verified by | Where |
|---|---|---|
| Labelled inputs, named controls, heading structure, ARIA wiring | Accessible names computed with `dom-accessibility-api` — the implementation Testing Library itself uses — over each screen rendered through the real API client and session boundary | `frontend/tests/accessibility.test.tsx`, `frontend/tests/accessibility/audit.ts` |
| Keyboard reach, tab order, no traps, Escape, visible focus **as painted** | Real `Tab`/`Enter`/`Escape`/arrow keys in Chromium against the production build, reading `:focus-visible` and the computed outline and shadow | `frontend/tests/e2e/accessibility.spec.ts` |
| 4.5:1 body text in both appearances | WCAG arithmetic over every declared token pair, in both palettes; then re-measured in the browser from the colours Chromium resolved | `frontend/lib/design/tokens.test.ts`, `frontend/lib/design/contrast.ts`, and the browser spec |
| 360-pixel viewport, no page scroll, wide content contained | `documentElement.scrollWidth` against `clientWidth` in Chromium at 360, 900 and 1440 pixels, on all twelve screens, with every overflowing element reported by name | `frontend/tests/e2e/accessibility.spec.ts` |
| Never `outline: none` without a replacement; the three recorded tiers; no width the floor cannot honour | Static rules read over the shipped stylesheets | `frontend/tests/design-rules.test.ts` |
| WCAG 2.0 and 2.1 at A and AA, plus WCAG 2.2 AA (which is where `target-size` lives) — by rule rather than by hand, on every screen, at 360 and 1440 pixels, in both appearances, and in the three interactive states | axe-core 4.13 against the production build in both engines | `frontend/tests/e2e/axe.spec.ts` |

`best-practice` rules are deliberately **not** enabled: they are advice rather than the standard,
and folding them in would mean the suite failed for reasons `specs/web-ui` does not ask for.

**No screenshot comparison.** A pixel diff fails on a font hint and passes on a keyboard trap.

## 2. Screens audited

All twelve MVP screens, plus the shared surfaces. Each product screen was audited **populated**, and
in the additional states a person actually meets where it has them.

| Screen | Keyboard | Names & semantics | Focus visible | 360px, no page scroll | Reflow |
|---|---|---|---|---|---|
| Sign In | pass | pass | pass (dark + light) | pass | pass |
| Create Account | pass | pass | pass | pass | pass |
| Verify Email (entry and just-confirmed) | pass | pass | pass | pass | pass |
| Forgot Password | pass | pass | pass | pass | pass |
| Reset Password (recovery session) | pass | pass | pass | pass | pass |
| Dashboard (populated, chooser, error) | pass | pass *(after correction 1)* | pass | pass | pass |
| AI Weather Analyst (composer and answered) | pass | pass *(after correction 2)* | pass | pass | pass |
| Historical Analytics (populated, charts) | pass | pass *(after correction 2)* | pass | pass | pass |
| Compare Cities (form, ranking, chooser) | pass | pass *(after correction 2)* | pass | pass | pass |
| Agent Evidence (populated, not-found) | pass | pass | pass | pass | pass |
| Saved Locations (populated, empty, chooser) | pass | pass | pass | pass | pass |
| Settings (both tabs, both confirmations) | pass | pass *(after correction 2)* | pass | pass | pass |

Shared surfaces: the application shell and its navigation, the expired-session state, the location
candidate chooser, the provenance and data-class primitives, the two destructive confirmations, and
the loading, empty and error states — all pass.

Every row above holds **on both engines**, and every screen additionally reports no axe-core
violation at 360 and 1440 pixels in both appearances. The `*(after correction n)*` notes name the
defect the audit found on that screen and fixed; §9 has the detail.

## 3. Keyboard-only result

- **Every control is reachable — each one, by name.** On each of the seven product screens every
  control a keyboard can reach is stamped with an identity before the walk, and the forward `Tab`
  walk must report every one of those stamps back. That is stronger than what the first pass
  asserted, which was that the walk visited *more than one* distinct element — true, and a good deal
  weaker than the claim this section was making. Counting distinct stops would not do either: two
  candidate buttons are indistinguishable by tag, id and class, so a walk that hit one twice and the
  other never would have looked complete. Disabled controls are correctly *not* tab stops. A trap is
  a walk that never leaves one element, and none does.
- **A radio group is one tab stop, and the arrow keys move within it** — Settings' unit choice is
  entered with `Tab` and changed with `ArrowRight`, with the preference actually taking effect, which
  is the behaviour that makes the single stop correct rather than a loss.
- **A scrollable container is reachable while it scrolls.** The evidence sources table is reached by
  `Tab` and moved with `ArrowRight`; see correction 6.
- **Sign-in completes with the keyboard alone** — the form autofocuses the email field, so a person
  arriving with a keyboard types straight into it, `Tab`s to the password and presses `Enter` — and
  lands on the briefing. On both engines; see correction 8, which is about how this was being tested
  rather than about the screen.
- **Tab order is document order.** No positive `tabindex` exists anywhere in the application.
- **Escape closes the navigation drawer**, and the control that opened it keeps its name and remains
  where focus can return to.
- **The tablist in Settings is one tab stop**, with `ArrowLeft`/`ArrowRight` moving the selection —
  so twelve controls do not stand between the heading and the first setting.
- **The skip link works**: first in the tab order, and `Enter` moves focus to `#weathra-main`
  rather than only scrolling the viewport.
- **A location candidate is chosen with `Enter`** after being reached by `Tab`, and the save goes
  through.
- **The destructive confirmation is fully operable**: the confirm control stays disabled until
  `DELETE` is typed, and Cancel is reachable and gets out of it without deleting anything.

## 4. Accessible names and semantics

- Every input on every screen resolves a non-empty accessible name.
- Every interactive control resolves one, the drawer control included — it carries a visible
  "Menu" label beside its icon rather than relying on the icon.
- Navigation is a `<nav aria-label="Weathra">` landmark, and the current entry carries
  `aria-current="page"` — so the current screen is conveyed without relying on colour.
- Every `aria-controls`, `aria-labelledby` and `aria-describedby` resolves to an element that
  exists, and no `id` is duplicated. This is what keeps `Field`'s description-and-error wiring real
  as screens compose it.
- No focusable element sits inside an `aria-hidden` subtree.
- Every data table declares scoped header cells.
- Headings descend one level at a time on every screen, and each screen carries exactly one `h1`.

## 5. Contrast

Every declared token pair passes at its stated minimum **in both appearances**, and the audit
widened the declared set (correction 4 in §9). Body text on the tightest pairing measures:

| Pairing | Dark | Light |
|---|---|---|
| `text-muted` on `status-quota-surface` | 6.52:1 | 4.99:1 |
| `text-muted` on `status-error-surface` | 6.75:1 | 5.18:1 |
| `accent` on `status-quota-surface` | 9.31:1 | 5.21:1 |
| `accent` on `surface-inset` | 10.86:1 | 5.49:1 |

Re-measured in the browser on the signed-in Dashboard — the screen heading, its muted subtitle and
the navigation's current entry — all above 4.5:1 in both appearances, from the colours Chromium
actually resolved.

## 6. Responsiveness

- **No page scrolls sideways** on any of the twelve screens at 360, 900 or 1440 pixels. Measured on
  `documentElement` and on `body`, with one pixel of tolerance for sub-pixel rounding.
- **The three recorded tiers of [`design-system.md`](design-system.md) §13 hold**: the drawer and
  its labelled control below 768 pixels, with the navigation's twelve entries taken out of the tab
  order by `visibility: hidden` rather than left focusable off-screen; the navigation present and
  the drawer control absent at 900 and 1440.
- **Content reflows rather than shrinking.** The evidence record's execution column is under half
  the desktop width at 1440 and over 300 pixels wide at 360, and the body type never drops below
  14 pixels.
- **Wide content is contained, and the container is reachable.** The evidence sources table is wider
  than a 360-pixel viewport, its own container carries `overflow-x: auto`, and the page still does
  not move — and that container is a named, focusable group that an arrow key scrolls, for as long
  as it has something to scroll. Correction 6 is why the second half of that sentence is there.
- **Nothing is hidden to make it fit.** At 360 pixels the candidate chooser shows both candidates
  with their region, country, coordinates and time zone.

## 7. Charts

Historical Analytics and Compare Cities remain understandable without the charts. Each chart carries
an accessible name describing what it shows and ships the figures it draws as a table beside it, so
every plotted value is available as text; nothing depends on hover to disclose a value, as §14
requires. No chart data was added or fabricated for this audit — the figure tables are the ones
tasks 21.3 and 21.4 already shipped, and the audit asserts their headers are scoped.

The charts were also where correction 7 was found: six pixels of each plot were being clipped and
were reachable only by scrolling a region nothing could focus.

## 8. The candidate chooser (task 21.7)

Audited explicitly, since it is the newest interactive surface:

- Each candidate is a real `<button>` — reachable with `Tab`, activated with `Enter` or `Space` on
  every platform — inside a named group, so several choosers on one screen are told apart.
- **Nothing is preselected**, focused or otherwise nudged: the first result is exactly the one
  Weathra must not choose on somebody's behalf.
- Each candidate is distinguished by the region, country, coordinates and time zone the *response*
  supplied, with no placeholder where a field was absent.
- Its focus indicator is the design system's shadow, verified as painted after a real `Tab`.
- At 360 pixels it fits, with both candidates and all their detail visible.
- Its location-resolution behaviour was not altered by this task.

## 9. Defects found, and the corrections made

The audit found five real defects across its two passes — three in the first, two in the second.
All are fixed centrally. Corrections 4, 5, 8 and 9 were not defects in behaviour: two widened what
was being measured, and two fixed instruments that were measuring the wrong thing.

**1. The Dashboard had no `h1`.** Every other MVP screen carried one; the Dashboard's sections had
headings and the page they belong to did not, so a heading-list navigation of `/` — the way most
screen-reader users move around a page — described the parts without naming the whole, and the
screen had no accessible name in that structure at all. *Corrected:* the Dashboard now carries its
own heading and subtitle, and `tests/accessibility.test.tsx` asserts exactly one `h1` on every
product screen so a screen added later cannot ship without one.

**2. Skipped heading levels on four screens.** `ProvenanceSection` and `InterpretationPanel` — the
task-20.15 provenance primitives — rendered their titles as `h3` unconditionally. On Agent Evidence
that is right, because they sit inside that screen's own `h2` panels; on the Dashboard, the Analyst,
Historical Analytics, Compare Cities and Settings they sat directly under the screen's `h1`, so the
heading list jumped `h1 → h3` and misdescribed every one of those screens. *Corrected:* both
primitives take a `headingLevel` (`2` by default, `3` where they nest), Agent Evidence passes `3`,
and Settings' own section headings and the Analyst's progress and resolved-context headings became
`h2`. The heading-order rule in the audit now fails the build if a level is skipped again.

**3. `html { overflow-x: hidden }` concealed the requirement instead of meeting it.** The page-level
clamp had two effects, both wrong: content that *did* overflow became unreachable rather than
scrollable, which is precisely the "solve responsiveness by hiding information" the requirement
rules out; and it made the requirement unverifiable, because a browser then reports no overflow
whether or not the layout fits. *Corrected:* the clamp is removed, and the twelve screens are
asserted to fit in a real Chromium at all three widths — which they do, unclamped. A static rule
now fails if `overflow-x` is reintroduced on `html` or `body`.

Two further corrections came out of the audit without being defects in behaviour:

**4. Contrast coverage was narrower than the palette in use.** The four status-tinted grounds carry
prose — the candidate chooser asks its question on the caution ground and the two destructive
confirmations state what they will remove on the error ground — and the accent is a ghost control's
label on those grounds and on the inset and overlay surfaces. None of those pairings was in the
declared set, so all of them were unmeasured. Each was measured by hand (all pass, worst case
4.99:1) and then added to `CONTRAST_REQUIREMENTS`, so they are measured on every run rather than
having held once in September.

**5. The saved-location confirmation read a response field unguarded.** `qualifiedName(saved.location)`
would take the screen down if the create response were ever shaped unexpectedly. Guarded.

### The second pass

**6. Three scrollable containers were unreachable from the keyboard.** The two historical charts and
the evidence sources table. This is the requirement in §13 turning on itself: "wide content scrolls
inside its own container" was satisfied by an `overflow-x: auto` div, which a pointer can drag, a
trackpad can swipe — and a keyboard cannot reach at all. Everything past the right edge of that
table was simply unavailable to anybody not using a mouse, which is WCAG 2.1.1 and the reason the
first pass could report both "wide content is contained" and "every control is reachable" while a
person on a keyboard could not read the fifth column. *Corrected* with a primitive rather than three
`tabIndex={0}`s, because the condition is not a fact about the markup: whether a table is wider than
its container depends on the viewport, the font and the data, and the same table overflows at 360
pixels and fits at 1440. `components/ui/scroll-region.tsx` measures its own overflow with a
`ResizeObserver` and becomes a named, focusable group exactly while there is something to scroll —
so a keyboard reaches it when it matters, and no screen that fits gains an empty stop between its
heading and its content. `.weathra-scroll-x`, which the design system had declared and nothing used,
is what the primitive now carries.

**7. Both historical charts clipped six pixels of themselves, into a region nothing could reach.**
Found by the same axe rule, at desktop width, and a genuinely two-part defect. `<svg>` is
inline-level by default, so each plot's chart sat on a text baseline and its line box kept descender
space below it — six pixels past the plot's fixed 260-pixel height. That alone would be cosmetic;
what made it a defect is that `overflow-x: auto` computes the *other* axis from `visible` to `auto`,
so the container asked only to scroll sideways became vertically scrollable, and those six pixels of
chart were reachable only by scrolling a region that was not a tab stop. *Corrected:* the plot's
`<svg>` is `display: block`, which has no line box, so there is nothing to clip and nothing to
scroll; and `ScrollRegion` now measures **both** axes, so a container that scrolls in either
direction is reachable. The browser suite asserts no chart overflows its own height at 1440.

**8. The keyboard sign-in test was passing for a reason that did not hold on a second engine.** Not
a defect in Weathra — the screen was always right — but the assertion was not testing what it said.
It pressed `Tab` and walked until it found the email field, which meant tabbing *away* from a field
the form had already autofocused and relying on the walk wrapping around the end of the document to
come back to it. Headless Blink wraps, through `body`; headless Gecko holds the last element,
because a real Firefox wraps out through browser chrome that a headless one does not have. So the
walk found the email field in one engine and a trailing link in the other, typed the password into
nothing, and pressed `Enter` on "Create account". *Corrected:* the test asserts the thing that is
actually true and actually the requirement — the email field holds focus on arrival, so sign-in
needs no leading `Tab` at all — and then walks forward from there. Verified on both engines.

**9. The reachability instrument was counting controls that are not there.** Two, on every screen
with the shell: above 768 pixels the mobile header is `display: none`, and its drawer control and
brand link generate no boxes and are correctly not tab stops — but the filter read
`getComputedStyle(element).display`, which is the element's *own* computed value and is unaffected
by a hidden ancestor. It also counted every radio in a group as its own stop, where the browser
natively makes a group one stop and moves within it by arrow key. Neither mattered while the
assertion was only "more than one distinct stop"; both would have reported correct behaviour as a
defect once the assertion became "all of them". *Corrected:* a control counts when it generates a
box, and a radio group contributes the one stop the browser gives it — with the arrow-key behaviour
that justifies that asserted separately, in §3.

## 10. Genuine limitations of this pass

Recorded rather than glossed, because a pass that overstates itself is worse than no pass.

- **Two engines of three.** Blink and Gecko both run the whole browser suite, and the second engine
  earned its place immediately — correction 8 is a test that passed on Blink for a reason Gecko does
  not share. WebKit is still unverified. Its binary is downloaded by `npx playwright install webkit`
  but will not launch here without a set of system libraries only root can install
  (`sudo npx playwright install-deps webkit`), so rather than fail for everyone who has not done
  that, it is a third Playwright project behind an opt-in: once the libraries are present,
  `WEATHRA_E2E_WEBKIT=1 npx playwright test` runs the whole suite on it with no further change. A
  focus or layout difference specific to WebKit would not have been caught.
- **No screen-reader pass.** The names, roles, relationships and live regions are asserted
  programmatically — now by two instruments rather than one — which is still not the same as having
  listened to VoiceOver, NVDA or Orca read each screen. Nothing here claims otherwise.
- **A rule engine is not an audit.** axe-core covers a good deal of WCAG automatically and, by its
  own maintainers' estimate, cannot decide most of it: whether an accessible name is *accurate*,
  whether a reading order makes sense, whether an error message says what to do. Those need §12.
- **`:focus-visible` is the browser's decision, not Weathra's.** The focus assertion requires an
  indicator wherever Chromium reports visible focus. Two cases are outside that: focus moved by
  script, and a composite control such as `input[type=date]`, where the ring is drawn on a segment
  inside the control's shadow tree. In neither case does Weathra's stylesheet decide whether a ring
  appears, so requiring one of *our* rules there would assert the wrong thing. Every stop that the
  browser does call visible focus is asserted, and each screen is required to have produced at
  least one, so the check cannot pass vacuously.
- **No physical device.** 360 pixels was verified as a viewport size, not on a handset. Touch target
  sizes are now checked by rule — `target-size` is the WCAG 2.2 AA criterion and it is in the enabled
  tag set, and no screen violates it at 360 pixels in either appearance — but a rule measuring a box
  is not a thumb on glass, and mobile-browser chrome is still unverified.
- **The two boundaries beyond Weathra are stood in for** — the identity provider and the FastAPI
  backend — as task 18.10 established. Everything on Weathra's side of them is the real
  production build.

## 11. Where the evidence lives

All commands run from `frontend/`.

| Evidence | Command | Result |
|---|---|---|
| Markup audit over all twelve screens and the shared surfaces | `npm test` | 53 files, 1048 tests pass |
| Browser accessibility and responsiveness, both engines | `npx playwright test tests/e2e/accessibility.spec.ts` | 46 tests pass (23 per engine) |
| axe-core over every screen, both appearances, 360 and 1440, plus the interactive states | `npx playwright test tests/e2e/axe.spec.ts` | 22 tests pass (11 per engine), no violations |
| Whole browser suite, including task 18.10's | `npx playwright test` | 106 tests pass (53 per engine) |
| Token contrast in both appearances | `npm test` (`lib/design/tokens.test.ts`) | 28 tests pass |
| Stylesheet rules | `npm test` (`tests/design-rules.test.ts`) | 10 tests pass |
| Markup audit alone | `npm test` (`tests/accessibility.test.tsx`) | 41 tests pass |
| The scrollable-container primitive | `npm test` (`components/ui/scroll-region.test.tsx`) | 6 tests pass |
| Types and lint | `npm run typecheck && npm run lint` | clean |

WebKit, once its system libraries are installed: `WEATHRA_E2E_WEBKIT=1 npx playwright test`.

## 12. The manual pass — outstanding

Task 21.8 asks for automated assertions **plus a recorded manual pass**, and the two are named
separately because they find different things. The automated half is done; the manual half is not,
and this section says exactly what it needs rather than recording it as though it had happened.

The second pass closed one of the four the first pass listed — the engine — and narrowed a second.
Three remain, and every one of them needs a person.

**The worksheet for them is [`accessibility-manual-pass.md`](accessibility-manual-pass.md)**: how to
get the populated production build in front of you, what to judge on each of the three passes —
deliberately excluding everything the suites already settle — and where to write down what you
found. Its §5 is what this section becomes once it is filled in.

**A retraction.** On 2026-09-04 this section and the worksheet's §5 briefly recorded a screen-reader
pass over six surfaces as complete, itemised and attributed to NVDA 2024.4. The operator has since
stated they had not installed or used NVDA, and all of it has been removed; the worksheet's §5 and §7
record what was withdrawn and why. **No screen-reader pass has been performed.** Nothing in §1–§11
above was affected — every claim there is produced by a command and reproducible — which is the
reason this record keeps its instruments and its attestations in separate sections.

**And an environment limitation, established by observation.** Cloud Shell's Web Preview is an
authenticated proxy, and it redirects the application's `fetch` calls (HTTP 302 to a Google sign-in,
then a CORS failure on the cross-origin redirect) while letting page navigations through. So no
authenticated screen is reachable from that environment: the identity call is redirected, and every
data call sets `credentials: "omit"` by design and therefore can never carry the proxy's cookie. The
manual pass cannot be completed for the product screens from Cloud Shell's preview, and task 21.8
stays open on that basis. The worksheet's §8 has the evidence and §9 the ways out.

One defect *was* found in that exchange, by reading the source rather than by listening: the
candidate chooser's question was a styled paragraph and not a heading, so it appeared in no heading
list. It is fixed, pinned by tests in both engines, and written up in the worksheet's §6 — including
why it is a genuine WCAG 1.3.1 defect and why it is nonetheless **not** one of this task's written
acceptance criteria.

1. **A screen-reader pass over all twelve screens.** With VoiceOver, NVDA or Orca: does each screen
   read in an order that makes sense, does the heading list describe it, are the live regions
   announced when the Analyst streams and when a preference saves, and is the candidate chooser
   understandable without seeing it? Two instruments now assert the names, roles, relationships and
   live regions programmatically; nobody has listened to them. This is also where the accessible
   *names* get judged rather than merely counted — `ScrollRegion` announces "Grounded data sources
   table" and the charts announce their titles, and whether those are the right words to hear on
   landing is not something either instrument can tell you.
2. **A keyboard pass driven by a person.** The browser suite presses the keys and reads the computed
   styles, which settles reachability, trapping and whether a ring is painted — and now settles that
   *every* control is reached, on two engines, rather than that the walk moved at all. What it
   cannot judge is whether the ring is *findable* on a busy screen, whether the order feels right
   rather than merely being document order, or whether the new scroll-region stop is a help or a
   surprise when you meet it with no warning.
3. **A 360-pixel pass on a physical handset**, in a mobile browser with its own chrome. The viewport
   size is verified and target sizes now pass WCAG 2.2's `target-size` by rule; real-device
   behaviour and an actual thumb are not.

**Closed since the first pass:** a second browser engine. Gecko runs the whole suite alongside
Blink, and it paid for itself on the first run — correction 8 is an assertion that passed on Blink
for a reason Gecko does not share. WebKit remains outstanding as a *limitation* (§10) rather than as
work: the project is written and opt-in, and needs only its system libraries.

Until the three above are done and recorded here with their date, their operator and their findings,
task 21.8 stays open. Nothing above should be read as covering them.
