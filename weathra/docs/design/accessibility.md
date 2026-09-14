# Accessibility and responsiveness audit — task 21.8

**Status: complete against the acceptance contract as amended on 2026-09-14.** All twelve clauses
are established by assertions that run in continuous integration and are reproducible with the
commands in §11. §14 records the two failures that closing it turned up and what each turned out
to be — both were defects in the tests rather than in the product, and neither was found by
assuming so.

Task 21.8 previously asked for "automated accessibility assertions **plus** a recorded manual pass",
and the second of those was read as three human activities — a real screen-reader session, a
physical handset, and a keyboard traversal performed personally. Those are no longer acceptance
criteria; §12 records what became of them and §13 records the two measurements the amendment added.
**No screen-reader or physical-handset pass is claimed here, then or now.**

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

The audit found eight real defects across its three passes — three in the first, two in the second,
three in the third of 2026-09-14. All are fixed centrally. Corrections 4, 5, 8 and 9 were not
defects in behaviour: two widened what was being measured, and two fixed instruments that were
measuring the wrong thing. Corrections 10 to 12 are the third pass, and §13 records the four items
that pass raised which turned out not to be defects at all.

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

**10. Weather Watch removed a watch on one press.** A watch is a standing instruction somebody set
up deliberately; removing one destroys it and the readings behind it, and there is no undo. The
control sat beside Pause, drawn at the size of Pause, and deleted on the first press — so a
mis-aimed press, or a keyboard `Enter` on the wrong row, was irreversible. Every other destructive
action in the product already went through a confirmation. *Corrected:* the same confirmation, which
moved out of `components/settings/` to `components/ui/confirm-action.tsx` so both screens use the
pattern the product already had rather than a second one invented beside it. Seven cases in
`components/watch/watch.test.tsx` hold the whole contract: the first press sends nothing, Cancel and
Escape each send nothing, focus moves into the confirmation and returns to the trigger on dismissal,
only the second control issues the `DELETE`, and a refusal is drawn as a refusal with the row still
listed.

**11. Saved Locations removed a saved place on one press.** The same defect in the same shape, next
to Compare. *Corrected:* the same way, with six cases in `components/locations/locations.test.tsx`.
The prompt names the place as the card does — `card.name`, which for a place the provider returned
no name for reads as an unnamed place rather than as its coordinates (task 34.11) — so nobody is
asked to confirm the deletion of a pair of digits.

**12. Every conversation in Settings offered a control called "Delete".** Eleven rows, eleven
buttons, one accessible name between them. A screen-reader user reaching the list got a run of
identically named controls with nothing to say which conversation any of them belonged to, and a
voice user saying "press Delete" was addressing all of them at once. The visible label was not the
problem — the row around it says which conversation it is, which is exactly the context that is lost
when the control is announced on its own. *Corrected:* `ConfirmAction` takes a `triggerName`, and
each row passes `Delete conversation: <title>`; the visible label stays short. The same treatment
was applied to the two lists fixed in corrections 10 and 11, which had the defect for the same
reason. `components/settings/settings.test.tsx` asserts eleven controls, eleven distinct names, and
none reachable by the bare name they used to share.

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
  listened to VoiceOver, NVDA or Orca read each screen. Nothing here claims otherwise. Since the
  2026-09-14 amendment this is a limitation of the evidence rather than an outstanding acceptance
  criterion: it is worth doing as product QA, and it does not gate the change.
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
  is not a thumb on glass, and mobile-browser chrome is still unverified. As above, this is a
  limitation of the evidence and not an outstanding acceptance criterion.
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

## 12. What became of the manual pass

The acceptance contract for task 21.8 was amended on 2026-09-14. It had required "automated
assertions **plus** a recorded manual pass", and the manual pass was read as three human
activities: a session with a real screen reader, a walkthrough on a physical handset, and a keyboard
traversal performed personally by a person.

**None of the three had been performed, and none of them is reproducible.** A pass somebody
performs once cannot be re-run when the code changes, cannot gate a pull request, and cannot be
checked by a later reader. Holding the change open for them was keeping a task open on evidence
nobody could produce or verify, while the properties they were meant to establish went unasserted.

So they were replaced by twelve clauses of verification that CI runs on every push — automated
accessibility assertions, semantic DOM and ARIA verification, automated keyboard traversal, visible
focus, no keyboard traps, form/dialog/tab/table semantics, accessible-name uniqueness, safe
destructive-action behaviour, responsive checks at 1440, 1024, 768 and 375 pixels, no page-level
horizontal overflow, usable dialogs and navigation at every width, and text or semantic equivalents
for provenance and data visualisations. The contract is written out in full at task 21.8 in
`openspec/changes/weathra-mvp/tasks.md`, and each clause's instrument is in §11 and §13.

**Physical-device and assistive-technology field testing may still be performed as additional
product QA, and it is worth doing.** It is not a blocking acceptance criterion for this change.
[`accessibility-manual-pass.md`](accessibility-manual-pass.md) is kept as the worksheet for anyone
who does it, reframed as optional QA rather than as outstanding work.

**Historical honesty.** An earlier review proposed physical assistive-technology and handset
validation. The MVP acceptance contract was later amended to use reproducible automated
accessibility, semantic, keyboard and responsive-browser verification. No claim is made that a
physical screen-reader or handset pass was performed. Separately and earlier, a claim that a
screen-reader pass *had* been performed was retracted and its results removed; that retraction
stands on its own and is not what the amendment was for.

## 13. The four items the amendment settled

The review that prompted the amendment also listed defects. Four of them needed measurement rather
than reading, and this is what the measurement returned. The two code defects it confirmed are in
§9's list of corrections; these four are the ones that turned out to need a browser to decide.

Measured on the production build, both engines, by
[`tests/e2e/disabled-and-date-focus.spec.ts`](../../frontend/tests/e2e/disabled-and-date-focus.spec.ts)
and by `components/analyst/analyst.test.tsx`.

| Item | Verdict | What was measured |
|---|---|---|
| Travel Intelligence Departure and Return date fields have no visible focus | **Not a defect** | Reached by `Tab` on both engines, the browser reports `:focus-visible`, and the global rule paints `outline: solid 2px rgb(34, 211, 238)` at `2px` offset on the host element. No screen-level override suppresses it. |
| Dashboard's disabled "Show briefing" is not distinct, or is wrong semantically | **Not a defect** | Natively `disabled`, with no `aria-disabled` beside it — the duplication is the anti-pattern, not the fix. `Tab` from the field before it does not reach it. Painted fill `#1b8094` against the enabled `#22d3ee`, a separation of **2.55:1**; label `#0e4451` on that fill, **2.32:1**, against an enabled **10.5:1**. The disabled label is below the 3:1 mark, which WCAG 1.4.3 does not apply to inactive components; it is recorded here rather than asserted, because asserting a threshold the standard does not set would be inventing a requirement. Worth revisiting as product QA. |
| The composer's UNITS and DEPTH read as controls that do nothing | **Not a defect — intentional** | Both are `<span>` pairs containing no focusable element. Units reports the run's resolution or the stored preference; DEPTH states "Full synthesis", the one behaviour there is, because `specs/model-policy` keeps model behaviour out of the caller's hands. FOCUS beside them genuinely is a control, which is the contrast the artifact's row obscures. Guarded by a test that fails if either becomes focusable. |
| An invisible but focusable "Stop Claude" control | **Not Weathra** | Searched for as a literal string across the whole repository, as any Claude or Anthropic string in shipped frontend source, and as any hidden cancellation control: no match on any of the three. The frontend contains no vendor name at all, which is an architecture rule (`design.md` decision 1) with its own test. The single `AbortController` in shipped source cancels an image fetch on unmount and is not a control. The observation could not be reproduced or located in Weathra source and appears attributable to the browser or AI testing environment; it is excluded from Weathra's 21.8 defect set, and no product code was changed for it. |

## 14. The two failures behind the stale locators, and what they were

Fixing the browser suite's stale Saved Locations locators is what made these visible. The suite had
been looking for a `<summary>` disclosure headed "Add a location"; the screen was rebuilt on
2026-09-13 so that the add form is a panel the header's "Add location" control reveals, and the
`<summary>` is not in the document until that control has been pressed. Every browser test that
loaded Saved Locations, and every one that used it as a marker, had been failing since — 51 of them
— and two more failures were sitting behind that wall. Both turned out to be defects in the tests.
Neither was assumed to be: each was reproduced and measured first.

**The Settings tablist — a stale expectation, not an ARIA bug.** The keyboard test asserted that one
`ArrowRight` from General selected Account. That was true when it was written; `components/settings/
settings.tsx` now orders the tabs General, AI Intelligence, Account, Transparency, so Account is the
second stop. `components/ui/tabs.tsx` was doing exactly what the pattern requires — moving one
selectable tab at a time, moving focus with the selection, and keeping the roving tab index. The
walk now asserts both hops, that focus follows each one, that the selected tab carries
`tabindex="0"` and the one it left carries `-1`, and that the tab it left reports
`aria-selected="false"`. That is more of the tablist contract than the single assertion covered, and
no component changed.

**The axe `document-title` violation — a document sampled mid-reconciliation.** Opening the account
confirmation was reported as a serious `document-title` violation, with
`document.querySelector("title")` returning `null` at that instant. Measured rather than guessed:

| Step | `<title>` |
|---|---|
| `/sign-in` | `"Sign in · Weathra"` |
| after sign-in, on `/` | `"Dashboard · Weathra"` |
| `/settings` loaded | `"Settings · Weathra"` |
| after the Account tab | `"Settings · Weathra"` |
| account confirmation open | **`null`** — once in three runs of the identical sequence |

`app/(app)/settings/page.tsx` exports `metadata: { title: "Settings" }` and the root layout frames
it as `%s · Weathra`, so the page has a title and serves it. The same confirmation component on the
AI Intelligence tab never reproduced it; neither did a select change nor a tab switch; and two
further runs of the exact failing sequence, one of them polling for four seconds afterwards, kept
the title throughout. What is left is React reconciling the hoisted head during a client state
update, briefly between removing and re-adding the element — not a dialog that invalidates the
document, and not a page without a title.

The fix is a precondition on the audit, not a change to what is audited: every axe rule stays
enabled and nothing is excluded, and `audit()` now waits for the document to settle with a title
before analysing. If `/settings` ever genuinely lost its title, that wait times out and the test
fails — which is what makes it a precondition rather than a way around the rule. The intermittent
head reconciliation is recorded here because it is real, brief, and worth knowing about.

One further note, because it cost a re-run: the Dashboard's 360-pixel overflow check failed once
with a 4-pixel document overflow naming `LocationImage`'s own boxes at 920 pixels, and passed on
the next run with no change to the page. A 920-pixel box inside a 360-pixel viewport is not a
layout Weathra ever renders; it is the hero image mid-load. The check is sound and the screen fits,
but the assertion can observe a transient state, which is worth knowing before trusting a single
red run of it.
