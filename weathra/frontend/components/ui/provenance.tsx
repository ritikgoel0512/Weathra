/**
 * The provenance primitives — task 20.15.
 *
 * `specs/web-ui` requires four things of every weather-bearing surface, and this file is where each
 * becomes a component rather than an instruction a screen has to remember:
 *
 * - every figure carries its **data class** (the badge, task 20.3);
 * - every screen shows its **source provider, location, period, and retrieval time**;
 * - every forecast figure shows its **uncertainty**;
 * - **AI interpretation is visually distinguishable from retrieved data**.
 *
 * Everything here is presentational and honest by construction. Three rules shaped the API:
 *
 * **No component invents a source.** There is no default provider, no placeholder station, no
 * fallback model name. Attribution renders what it is given; given nothing, it says the field was
 * not reported. `docs/design/design-system.md` §15 records that the mock provider names and station
 * identifiers in the Visily artifacts are mockup filler and are not implemented, and the way to
 * keep that true is for the primitive to have nothing to fall back on.
 *
 * **No component invents precision.** `UncertaintyIndicator` takes a band and the basis for it, and
 * `basis` is required — confidence without its basis is exactly the overstatement `specs/web-ui`
 * forbids. It renders no interval, no percentage, and no ± figure, because Weathra has none to
 * render: when the provider supplies no spread, the component says so instead of deriving one.
 *
 * **The model's language never presents a measurement.** `InterpretationPanel` is its own region
 * with its own badge and a fixed sentence saying what it is; it takes prose and nothing numeric,
 * and it sits beside figures rather than around them. `ProvenanceSection` puts the tier on the DOM
 * so retrieved data, deterministic analytics, and model-written language are three separated
 * regions rather than three paragraphs that happen to look different.
 *
 * The appearance is entirely the task 20.3 tokens; no colour, size, or spacing is written here.
 */

import type { ReactNode } from "react";

import {
  isInterpretation,
  tierOf,
  type ConfidenceLevel,
  type ProvenanceTier,
} from "@/lib/design/data-class";
import type { DataClassName } from "@/lib/design/tokens";

import { DataClassBadge } from "./badge";
import styles from "./primitives.module.css";

/* ------------------------------------------------------------------ formatting */

/**
 * An instant, rendered in UTC.
 *
 * Deliberately not locale-formatted: a retrieval time is provenance, and provenance that reads
 * differently depending on who is looking at it is worse evidence than a plain, stated zone. The
 * machine-readable original goes in the `<time>` element's `dateTime` regardless.
 */
export function formatInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

/**
 * A local timestamp as the backend already resolved it, trimmed to minutes.
 *
 * Read as text rather than through `Date` on purpose. The backend resolves a period into the
 * *location's* timezone; parsing it would re-express it in the reader's, which would quietly show
 * somebody in Sydney a Berlin window shifted by nine hours and call it the period covered.
 */
export function formatLocalStamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : null;
}

/* ---------------------------------------------------------------- attribution */

/** The period a surface covers, as the backend resolved it in the location's own timezone. */
export interface AttributionPeriod {
  readonly start: string;
  readonly end: string;
  /** The IANA identifier the bounds are in. Shown so the window is not read in the wrong zone. */
  readonly timezone?: string | null;
}

/** Where the figures on a surface came from. Every field is reported, never assumed. */
export interface Attribution {
  /** The provider the backend actually used. No default: an unreported source says so. */
  readonly provider?: string | null;
  readonly location?: string | null;
  readonly retrievedAt?: string | null;
  readonly period?: AttributionPeriod | null;
  /** The unit system the figures are expressed in. */
  readonly units?: string | null;
  /** Whether this came from Weathra's cache rather than the provider just now. */
  readonly fromCache?: boolean;
}

/** What is shown for a field the backend did not report. Never a plausible-looking stand-in. */
export const NOT_REPORTED = "not reported";

/**
 * What a language-model run's own record can be attributed to.
 *
 * Deliberately **not** an `Attribution`: it carries no location, no period and no unit system,
 * because a run has none of those and the type is where that is enforced. Passing one is a
 * compile error rather than a footer that reads "Location: not reported" about a paragraph.
 */
export interface RunAttribution {
  /** The inference gateway the backend reported. No default. */
  readonly provider?: string | null;
  /** The model identifier the backend reported. No default. */
  readonly model?: string | null;
  /** When the run finished, as the backend recorded it. */
  readonly completedAt?: string | null;
}

export type AttributionFooterProps = {
  /** Extra provenance a screen owns — an analytics method, a knowledge citation count. */
  readonly children?: ReactNode;
} & (
  | {
      /**
       * The default, and what every weather-bearing surface uses. All four fields are rendered,
       * `not reported` where the backend reported none — `specs/web-ui`'s standing requirement.
       */
      readonly scope?: "weather";
      readonly attribution: Attribution;
    }
  | {
      /**
       * A surface that bears no weather value: the language-model run's own record, and in this
       * change nothing else.
       *
       * Finding 2.11 of the runtime fidelity audit of 2026-09-08: the Analyst's run footer printed
       * "Location: not reported · Period: not reported" under an answer to a question that named
       * no place and covered no window — four weather provenance fields describing something that
       * is not weather, two of which could never be anything but unreported.
       *
       * `specs/web-ui` now states the distinction: a surface bearing no weather value may not
       * display a weather provenance field that does not apply to it, as a value *or* as
       * unreported, and must still identify the model and gateway. The weather-bearing guarantee
       * is untouched and is not reachable from here — a `RunAttribution` has no location, period
       * or unit field to omit, so this variant cannot be pointed at a weather surface to quietly
       * drop its four fields.
       */
      readonly scope: "model-run";
      readonly attribution: RunAttribution;
    }
);

/**
 * The attribution footer.
 *
 * A description list, because that is what this is: named provenance fields and their values, which
 * a screen reader can then navigate as pairs rather than as a run-on line of separators.
 */
export function AttributionFooter(props: AttributionFooterProps): ReactNode {
  const { children } = props;

  if (props.scope === "model-run") {
    return <RunFooter attribution={props.attribution}>{children}</RunFooter>;
  }

  const { provider, location, retrievedAt, period, units, fromCache } = props.attribution;

  const retrieved = formatInstant(retrievedAt);
  const start = formatLocalStamp(period?.start);
  const end = formatLocalStamp(period?.end);

  return (
    <footer className={styles.attribution} data-attribution="true">
      <dl className={styles.attributionList}>
        <div className={styles.attributionItem}>
          <dt className={styles.attributionTerm}>Source</dt>
          <dd className={styles.attributionValue}>{provider?.trim() || NOT_REPORTED}</dd>
        </div>

        <div className={styles.attributionItem}>
          <dt className={styles.attributionTerm}>Location</dt>
          <dd className={styles.attributionValue}>{location?.trim() || NOT_REPORTED}</dd>
        </div>

        <div className={styles.attributionItem}>
          <dt className={styles.attributionTerm}>Period</dt>
          <dd className={styles.attributionValue}>
            {start && end ? (
              <>
                {start} to {end}
                {period?.timezone ? ` (${period.timezone})` : null}
              </>
            ) : (
              NOT_REPORTED
            )}
          </dd>
        </div>

        <div className={styles.attributionItem}>
          <dt className={styles.attributionTerm}>Retrieved</dt>
          <dd className={styles.attributionValue}>
            {retrieved && retrievedAt ? (
              <time dateTime={retrievedAt}>{retrieved}</time>
            ) : (
              NOT_REPORTED
            )}
            {/* Stated, not hidden: a cached figure was not fetched from the provider just now. */}
            {fromCache ? <span className={styles.attributionNote}> · from Weathra&rsquo;s cache</span> : null}
          </dd>
        </div>

        {units ? (
          <div className={styles.attributionItem}>
            <dt className={styles.attributionTerm}>Units</dt>
            <dd className={styles.attributionValue}>{units}</dd>
          </div>
        ) : null}
      </dl>

      {children ? <div className={styles.attributionExtra}>{children}</div> : null}
    </footer>
  );
}

/**
 * The run footer: what produced this, and when it finished.
 *
 * The same element, the same description list and the same styling as the weather footer, so the
 * two read as one primitive with two applicable field sets rather than as two components. What
 * differs is only which rows exist, and a row exists only where the backend reported the thing it
 * names — a run whose gateway went unreported carries no Produced-by row at all, because "not
 * reported" here would be the same fabrication in quieter clothes.
 *
 * `data-attribution-scope` is on the element so the distinction is assertable without depending on
 * which rows a particular run happened to fill.
 */
function RunFooter({
  attribution,
  children,
}: {
  readonly attribution: RunAttribution;
  readonly children?: ReactNode;
}): ReactNode {
  const { provider, model, completedAt } = attribution;

  const producedBy = [provider?.trim(), model?.trim()].filter(Boolean).join(" · ");
  const completed = formatInstant(completedAt);

  return (
    <footer
      className={styles.attribution}
      data-attribution="true"
      data-attribution-scope="model-run"
    >
      <dl className={styles.attributionList}>
        {producedBy ? (
          <div className={styles.attributionItem}>
            <dt className={styles.attributionTerm}>Produced by</dt>
            <dd className={styles.attributionValue}>{producedBy}</dd>
          </div>
        ) : null}

        {completed && completedAt ? (
          <div className={styles.attributionItem}>
            <dt className={styles.attributionTerm}>Completed</dt>
            <dd className={styles.attributionValue}>
              <time dateTime={completedAt}>{completed}</time>
            </dd>
          </div>
        ) : null}
      </dl>

      {children ? <div className={styles.attributionExtra}>{children}</div> : null}
    </footer>
  );
}

/* ---------------------------------------------------------------- uncertainty */

/** The word each band announces itself with. Colour is never the only carrier. */
export const CONFIDENCE_LABELS: Readonly<Record<ConfidenceLevel, string>> = {
  high: "HIGH CONFIDENCE",
  moderate: "MODERATE CONFIDENCE",
  low: "LOW CONFIDENCE",
};

/** Said when the provider supplies no spread — stated rather than filled in with an estimate. */
export const NO_SPREAD_AVAILABLE =
  "This provider supplies no forecast spread for this figure, so none is shown.";

export interface UncertaintyIndicatorProps {
  readonly confidence: ConfidenceLevel;
  /**
   * What the confidence rests on, in the backend's own words. **Required**: `specs/web-ui` asks for
   * confidence to be presented with its basis and neither omitted nor overstated, and a band on its
   * own is the overstatement.
   */
  readonly basis: string;
  /** How far into the horizon this figure sits. Shown only when the backend measured it. */
  readonly hoursAhead?: number | null;
  /** False when the provider supplies no spread. Undefined means the backend did not say. */
  readonly spreadAvailable?: boolean | null;
}

/**
 * The uncertainty indicator that travels with a forecast figure.
 *
 * Three named bands, no percentage and no interval. Weathra reads one provider's output; a number
 * here would be meteorological precision it does not have, and `docs/design/design-system.md` §9
 * requires confidence to be presented with its basis rather than dressed up.
 */
export function UncertaintyIndicator({
  confidence,
  basis,
  hoursAhead,
  spreadAvailable,
}: UncertaintyIndicatorProps): ReactNode {
  return (
    <div className={styles.uncertainty} data-confidence={confidence} data-uncertainty="true">
      <p className={styles.uncertaintyHeader}>
        <span className={styles.badge} data-confidence={confidence}>
          {CONFIDENCE_LABELS[confidence]}
        </span>
        {typeof hoursAhead === "number" ? (
          <span className={styles.uncertaintyHorizon}>
            {hoursAhead} h into the forecast horizon
          </span>
        ) : null}
      </p>

      <p className={styles.uncertaintyBasis}>{basis}</p>

      {spreadAvailable === false ? (
        <p className={styles.uncertaintyBasis}>{NO_SPREAD_AVAILABLE}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- method notes */

/** The fixed opening of every analytics provenance line. */
export const COMPUTED_BY_WEATHRA = "Computed by Weathra, deterministically, from retrieved values.";

export interface MethodNoteProps {
  /** How it was computed, in the analytics engine's own words. */
  readonly method: string;
  readonly pointsUsed?: number | null;
  /** Points left out because the value was absent — never zeroed, so never silently included. */
  readonly pointsExcluded?: number | null;
  readonly unit?: string | null;
  /** Why the statistic was not computable. Shown instead of a figure, never alongside a made-up one. */
  readonly reason?: string | null;
}

/**
 * The provenance line an ANALYTICS figure carries.
 *
 * It names the method, because §9 requires the method that produced a computed figure to be named,
 * and it says plainly that Weathra computed it — which is the sentence that keeps a reader from
 * assuming the language model did.
 *
 * **Why it discloses rather than declaims.** The runtime audit of 2026-09-08 photographed the
 * Historical Analytics baseline column with eight of these stacked in it, each three lines long and
 * each opening with the same emphasised sentence. The words were all true and all required; the
 * composition was a log file. So the load-bearing half — *Weathra computed this, and here is the
 * method* — stays on the face of the line, and the arithmetic behind it (points used, points
 * excluded, unit, and the full deterministic sentence) moves inside a `<details>` on the same line.
 * Nothing is removed: every word that was on the screen is still on the screen, one disclosure
 * away, and `reason` never moves, because a figure that could not be computed has to say so where
 * the figure would have been.
 */
export function MethodNote({
  method,
  pointsUsed,
  pointsExcluded,
  unit,
  reason,
}: MethodNoteProps): ReactNode {
  return (
    <div className={styles.methodNote} data-method-note="true">
      <details className={styles.methodDetails}>
        <summary className={styles.methodSummary}>
          <span className={styles.methodStatement}>Computed by Weathra</span>
          <span className={styles.methodMethod}>Method: {method}.</span>
        </summary>

        <p className={styles.methodBody}>
          <span>{COMPUTED_BY_WEATHRA}</span>
          {typeof pointsUsed === "number" ? <span> {pointsUsed} points used.</span> : null}
          {typeof pointsExcluded === "number" && pointsExcluded > 0 ? (
            <span> {pointsExcluded} excluded as absent.</span>
          ) : null}
          {unit ? <span> Unit: {unit}.</span> : null}
        </p>
      </details>

      {reason ? <p className={styles.methodReason}>Not computable: {reason}.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- interpretation */

/**
 * The sentence every interpretation panel carries, unchangeable by the screen showing it.
 *
 * The one claim the interface must never let slip is that a language model produced a
 * measurement. Making this a constant rather than a prop is what stops a screen softening it.
 */
export const INTERPRETATION_BOUNDARY =
  "Written by a language model about the figures shown. It produced no measurement, forecast, or statistic.";

export interface InterpretationPanelProps {
  /** The model's prose. Text only — figures belong to the retrieved and computed regions. */
  readonly children: ReactNode;
  readonly title?: string;
  /**
   * The heading level for the panel's title — task 21.8.
   *
   * A region's heading level is a fact about where it sits, not about what it is: this panel is a
   * second-level section of a screen whose title is the `h1`, and a *third*-level one on Agent
   * Evidence, where it sits inside that screen's `h2` panels. A skipped level misdescribes the
   * screen to the heading list most screen-reader users navigate by, so the level is a parameter
   * rather than a constant. Two is the common case and the default.
   */
  readonly headingLevel?: 2 | 3;
  /** The gateway the backend actually used, if it reported one. No default. */
  readonly provider?: string | null;
  /** The model identifier the backend actually reported. No default. */
  readonly model?: string | null;
  readonly footer?: ReactNode;
  /**
   * How much of the page the prose is entitled to.
   *
   * `lead` sets it one step above body, for the screen whose whole purpose is that paragraph — the
   * Analyst's answer. `panel` is the default, for an interpretation that sits beside figures a
   * person came for instead. It changes the prose size and nothing else: the badge, the boundary
   * sentence, the model attribution and the region are identical, because those are what make this
   * a distinguishable interpretation rather than a styled quote.
   */
  readonly prominence?: "panel" | "lead";
}

/**
 * The AI-interpretation panel.
 *
 * Its own region, its own badge, its own treatment, and the boundary sentence above the prose — the
 * four things that together make it "visually distinguishable from retrieved data" as
 * `specs/web-ui` requires. `data-interpretation` is on the element so a test, and task 21.9's
 * review against the artifacts, can assert the distinction without depending on a generated class
 * name.
 */
export function InterpretationPanel({
  children,
  title = "AI interpretation",
  provider,
  model,
  footer,
  headingLevel = 2,
  prominence = "panel",
}: InterpretationPanelProps): ReactNode {
  const attributed = [provider?.trim(), model?.trim()].filter(Boolean).join(" · ");
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section
      className={styles.interpretation}
      data-class="interpretation"
      data-tier="interpretation"
      data-interpretation="true"
      aria-label={title}
    >
      <header className={styles.interpretationHeader}>
        <DataClassBadge dataClass="interpretation" />
        <Heading className={styles.interpretationTitle}>{title}</Heading>
      </header>

      <p className={styles.interpretationBoundary}>{INTERPRETATION_BOUNDARY}</p>

      <div className={styles.interpretationBody} data-prominence={prominence}>
        {children}
      </div>

      {/* Only what the backend reported. Nothing is filled in when it reported nothing. */}
      {attributed ? <p className={styles.interpretationModel}>Model: {attributed}</p> : null}
      {footer ? <div className={styles.interpretationFooter}>{footer}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------- sections */

export interface ProvenanceSectionProps {
  readonly dataClass: DataClassName;
  /** Names the region, so it is a landmark rather than a box. */
  readonly title: string;
  readonly children: ReactNode;
  readonly attribution?: Attribution | null;
  readonly footer?: ReactNode;
  /** See `InterpretationPanelProps.headingLevel` — task 21.8. Two by default. */
  readonly headingLevel?: 2 | 3;
  /**
   * How the region is presented. `panel` is the default card; `hero` is the wide leading band the
   * Dashboard artifact opens with. It changes the frame only — the badge, the heading and the
   * attribution footer are identical, because those are what make the region a provenance region
   * rather than a decoration, and a variant that could drop them would not be a variant.
   */
  readonly variant?: "panel" | "hero";
}

/**
 * A region of one data class, carrying its badge and its attribution.
 *
 * This is the explicit separation between the three tiers. `data-tier` on the wrapper makes it
 * structural: a screen showing retrieved figures, a computed statistic, and the model's reading of
 * both renders three regions, and neither the markup nor the appearance lets one flow into the
 * next. An interpretation class routes to `InterpretationPanel`, so there is exactly one treatment
 * for the model's language however a screen asks for it.
 */
export function ProvenanceSection({
  dataClass,
  title,
  children,
  attribution,
  footer,
  headingLevel = 2,
  variant = "panel",
}: ProvenanceSectionProps): ReactNode {
  if (isInterpretation(dataClass)) {
    return (
      <InterpretationPanel title={title} footer={footer} headingLevel={headingLevel}>
        {children}
      </InterpretationPanel>
    );
  }

  const tier: ProvenanceTier = tierOf(dataClass);
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section
      className={styles.provenanceSection}
      data-class={dataClass}
      data-tier={tier}
      data-variant={variant}
      aria-label={title}
    >
      <header className={styles.provenanceHeader}>
        <DataClassBadge dataClass={dataClass} />
        <Heading className={styles.provenanceTitle}>{title}</Heading>
      </header>

      <div className={styles.provenanceBody}>{children}</div>

      {attribution ? <AttributionFooter attribution={attribution} /> : null}
      {footer ? <div className={styles.provenanceFooter}>{footer}</div> : null}
    </section>
  );
}
