/**
 * Types for `dom-accessibility-api`, which ships them but does not map them in its `exports`.
 *
 * The package is already in the tree — Testing Library computes `getByRole`'s accessible names with
 * it — and it carries `dist/index.d.ts`, but its `package.json` `exports` block lists only `import`
 * and `require`, so `moduleResolution: "bundler"` cannot reach the declarations. Rather than loosen
 * the project's resolution or vendor the algorithm, the two functions the audit uses are declared
 * here, with the signatures the shipped declarations give them.
 *
 * Deliberately narrow: if the audit ever needs more of the API, the declaration grows deliberately
 * rather than the whole module becoming `any`.
 */
declare module "dom-accessibility-api" {
  export function computeAccessibleName(element: Element): string;
  export function computeAccessibleDescription(element: Element): string;
}
