/**
 * The report's numeric formatting — now `lib/format/figures.ts`, and re-exported here.
 *
 * It moved when the Scenario Lab needed the same standard. A screen's view model is the wrong home
 * for the primitive every other screen has to import in order to round a number, and the Lab
 * importing `lib/report/*` to format a wind speed would have been a dependency between two products
 * that share nothing but arithmetic.
 */

export {
  formatFigureFor,
  formatMeasured,
  formatProse,
  formatSigma,
  placesFor,
  roundTo,
  signedOf,
  toneOf,
} from "@/lib/format/figures";
