/**
 * The accessibility audit, as a function a test can run over any rendered surface — task 21.8.
 *
 * `specs/web-ui` asks for four things of every MVP screen, authentication and product alike: every
 * action reachable by keyboard, every input labelled, every interactive control carrying an
 * accessible name, and body text at 4.5:1 in both appearances. The last is arithmetic over the
 * tokens and lives in `contrast.ts`. The first three are properties of rendered markup, and this is
 * where they become assertions rather than a review somebody remembers to do.
 *
 * **Why not a scanner.** An off-the-shelf engine would add a dependency to check a handful of rules
 * that matter here, and would report a hundred that do not — and a suite that reports noise is a
 * suite people stop reading. What is checked below is exactly the requirement text, plus the four
 * structural hazards that would silently break the wiring the primitives already do correctly
 * (`aria-describedby` on a field's error, `aria-controls` on the drawer and the tabs). The
 * accessible name is computed by `dom-accessibility-api` — the same implementation Testing Library
 * uses for `getByRole`, already in the tree — so a name asserted here is the name a browser
 * computes rather than a guess about which attribute wins.
 *
 * **What it cannot see, and what covers that instead.** jsdom has no layout and no cascade, so this
 * function can say nothing about focus *visibility*, about contrast as rendered, or about a
 * 360-pixel viewport. Those are browser facts and are verified in the browser
 * (`tests/e2e/accessibility.spec.ts`) and against the tokens (`lib/design/contrast.test.ts`).
 * Nothing here is presented as covering them.
 *
 * It lives under `tests/` rather than `lib/`: it is verification infrastructure, and application
 * code must not be able to import it into a browser bundle.
 */

import { computeAccessibleName } from "dom-accessibility-api";

/** One thing that is wrong, named by the rule it breaks. */
export interface AccessibilityFinding {
  readonly rule: string;
  readonly detail: string;
}

/**
 * Everything a person can reach with the keyboard.
 *
 * `[tabindex]` is included so a deliberately focusable non-interactive element — the main region
 * the skip link targets — is audited too, and `summary` because a disclosure is a control.
 */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
].join(",");

const FORM_CONTROL_SELECTOR = "input:not([type='hidden']),select,textarea";

/** A short, recognisable description of an element, for a failure message somebody has to act on. */
function describe(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parts = [tag];
  const type = element.getAttribute("type");
  if (type) parts.push(`type=${type}`);
  const name = element.getAttribute("name");
  if (name) parts.push(`name=${name}`);
  const role = element.getAttribute("role");
  if (role) parts.push(`role=${role}`);
  const text = element.textContent?.trim().slice(0, 40);
  if (text) parts.push(`“${text}”`);
  return parts.join(" ");
}

/**
 * Whether the element is hidden from everybody, and so not a control anybody has to reach.
 *
 * `hidden`, `aria-hidden` and an inactive tab panel all qualify. Deliberately *not* checked by
 * computed style: jsdom applies no stylesheet, so every element would read as visible and a check
 * that leant on it would be theatre.
 */
function isHidden(element: Element): boolean {
  let node: Element | null = element;
  while (node !== null) {
    if (node.hasAttribute("hidden")) return true;
    if (node.getAttribute("aria-hidden") === "true") return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Elements that carry a tab stop and are not hidden — the set keyboard operation must cover.
 *
 * `disabled` is excluded: a disabled control is deliberately not reachable, and every screen here
 * disables a submit whose form is not ready. `aria-disabled` is *not* excluded, because that
 * attribute leaves an element focusable on purpose.
 */
export function interactiveElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(
    (element) =>
      !isHidden(element) &&
      element.getAttribute("tabindex") !== "-1" &&
      !element.hasAttribute("disabled"),
  );
}

/* --------------------------------------------------------------------- the rules */

/**
 * Every interactive control carries an accessible name.
 *
 * The requirement verbatim. A control with no name is announced as "button" — which is the state a
 * screen reader user cannot act on, and the one an icon-only control falls into by default.
 */
function namedControls(root: ParentNode): AccessibilityFinding[] {
  return interactiveElements(root)
    .filter((element) => computeAccessibleName(element).trim() === "")
    .map((element) => ({
      rule: "named-controls",
      detail: `no accessible name: ${describe(element)}`,
    }));
}

/**
 * Every input is labelled.
 *
 * Separate from the rule above even though it overlaps it, because the requirement names it
 * separately and because the failure is different: an unnamed *button* is unusable, an unnamed
 * *field* is unusable **and** its value is unverifiable.
 */
function labelledInputs(root: ParentNode): AccessibilityFinding[] {
  return [...root.querySelectorAll<HTMLElement>(FORM_CONTROL_SELECTOR)]
    .filter((element) => !isHidden(element))
    .filter((element) => computeAccessibleName(element).trim() === "")
    .map((element) => ({
      rule: "labelled-inputs",
      detail: `unlabelled form control: ${describe(element)}`,
    }));
}

/**
 * No positive `tabindex`.
 *
 * A positive value lifts an element out of document order and in front of everything with 0, so one
 * of them anywhere makes the whole page's tab order something nobody can predict from reading it.
 * Document order is the only tab order that stays correct as a screen changes.
 */
function documentTabOrder(root: ParentNode): AccessibilityFinding[] {
  return [...root.querySelectorAll<HTMLElement>("[tabindex]")]
    .filter((element) => Number(element.getAttribute("tabindex")) > 0)
    .map((element) => ({
      rule: "document-tab-order",
      detail: `positive tabindex takes this out of document order: ${describe(element)}`,
    }));
}

/**
 * Nothing focusable inside an `aria-hidden` subtree.
 *
 * The one combination that is unambiguously broken: the control is reachable by Tab and absent from
 * the accessibility tree, so a screen reader user lands somewhere that announces nothing at all.
 */
function noFocusableWhenHidden(root: ParentNode): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  for (const hidden of root.querySelectorAll("[aria-hidden='true']")) {
    for (const element of hidden.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
      if (element.getAttribute("tabindex") === "-1") continue;
      findings.push({
        rule: "no-focusable-when-hidden",
        detail: `focusable inside aria-hidden: ${describe(element)}`,
      });
    }
  }
  return findings;
}

/**
 * Headings descend one level at a time, and none is empty.
 *
 * A skipped level is what turns a heading list — the way most screen-reader users navigate a page —
 * into a structure that misdescribes the screen. The first heading in a *fragment* is not required
 * to be an `h1`, because a screen renders inside the shell.
 */
function headingOrder(root: ParentNode): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  let previous: number | null = null;

  for (const heading of root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
    if (isHidden(heading)) continue;
    const level = Number(heading.tagName.slice(1));

    if (heading.textContent?.trim() === "") {
      findings.push({ rule: "heading-not-empty", detail: `empty ${heading.tagName}` });
    }
    if (previous !== null && level > previous + 1) {
      findings.push({
        rule: "heading-order",
        detail: `h${previous} is followed by h${level}: “${heading.textContent?.trim().slice(0, 40)}”`,
      });
    }
    previous = level;
  }
  return findings;
}

/**
 * Every `aria-controls`, `aria-labelledby` and `aria-describedby` points at something that exists.
 *
 * A dangling reference fails silently and completely: the description simply is not announced, and
 * nothing on screen looks wrong. This is the rule that keeps `Field`'s description-and-error wiring
 * honest as screens compose it.
 */
function ariaReferencesResolve(root: ParentNode, document: Document): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  for (const attribute of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      const value = element.getAttribute(attribute) ?? "";
      for (const id of value.split(/\s+/).filter(Boolean)) {
        if (document.getElementById(id) === null) {
          findings.push({
            rule: "aria-references-resolve",
            detail: `${attribute}="${id}" points at nothing: ${describe(element)}`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * No duplicated `id`.
 *
 * Not a style rule here: every ARIA relationship above is resolved by id, and a duplicate silently
 * sends one of them to the wrong element.
 */
function uniqueIds(root: ParentNode): AccessibilityFinding[] {
  const seen = new Map<string, number>();
  for (const element of root.querySelectorAll("[id]")) {
    const id = element.getAttribute("id") ?? "";
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ rule: "unique-ids", detail: `id "${id}" appears ${count} times` }));
}

/**
 * Every data table names its columns with scoped header cells.
 *
 * The evidence record's sources table and the comparison figures are the wide content
 * `specs/web-ui` requires to scroll in its own container; a table read cell by cell without column
 * names is data nobody can reassemble.
 */
function tableHeaders(root: ParentNode): AccessibilityFinding[] {
  return [...root.querySelectorAll("table")]
    .filter((table) => table.querySelectorAll("th[scope]").length === 0)
    .map(() => ({
      rule: "table-headers",
      detail: "a table has no scoped header cells",
    }));
}

/* ------------------------------------------------------------------- the audit */

/**
 * Every finding in a rendered surface, in rule order.
 *
 * `document` is taken as an argument rather than reached for, so the ARIA references of a fragment
 * are resolved against the document it was actually rendered into.
 */
export function auditAccessibility(root: HTMLElement, document: Document): AccessibilityFinding[] {
  return [
    ...namedControls(root),
    ...labelledInputs(root),
    ...documentTabOrder(root),
    ...noFocusableWhenHidden(root),
    ...headingOrder(root),
    ...ariaReferencesResolve(root, document),
    ...uniqueIds(root),
    ...tableHeaders(root),
  ];
}

/** The findings as lines, for a failure message that says what to fix rather than a count. */
export function formatFindings(findings: readonly AccessibilityFinding[]): string {
  return findings.map((finding) => `  [${finding.rule}] ${finding.detail}`).join("\n");
}
