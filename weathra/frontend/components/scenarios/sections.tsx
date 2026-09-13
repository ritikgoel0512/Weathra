"use client";

/**
 * The Weather Scenario Lab's regions, against `docs/design/screens/13-weather-scenario-lab.png`.
 *
 * The artifact is a workspace: a header carrying the run controls, an assumptions rail of sliders,
 * a baseline card against a calculated card, one plot, four delta tiles, an interpretation with its
 * key deltas and two derived signals, an archive block, and a disclaimer. The screen before this
 * was four number inputs, one chart of the scenario against a flat line, and three cards of prose.
 *
 * Three rules hold across everything below.
 *
 * **The class badge tells the truth about what produced the content.** SIMULATED sits on the
 * scenario side of every pair, FORECAST on the baseline side, ANALYTICS on the computed blocks, and
 * HISTORICAL on the archive one. The interpretation carries ANALYTICS and not AI INTERPRETATION,
 * because no language model is called anywhere on this screen — the endpoint's own contract refuses
 * to spend an allowance on a slider movement.
 *
 * **The sliders are the interaction and the numbers follow them.** Each carries a range input, a
 * live signed readout and a baseline reference; typing is still available through the number field
 * beside it for anybody who wants an exact figure.
 *
 * **A region the run did not produce is not drawn.** The archive block is absent where the archive
 * could not serve the window; the key-delta bars are absent where nothing was supposed.
 */

import type { ChangeEvent, ReactNode } from "react";

import { PlaceChooser } from "@/components/locations/place-chooser";
import { Badge, Button, formatInstant } from "@/components/ui";
import type { Location } from "@/lib/api/schema";
import { friendlyName } from "@/lib/locations/place";
import {
  ASSUMPTION_CONTROLS,
  formatAssumption,
  type AssumptionKey,
  type AssumptionValues,
  type BaselineCard,
  type BasisRow,
  type HistoricalView,
  type ImpactCard,
  type KeyDelta,
  type LabFigure,
} from "@/lib/scenarios/view-model";

import { LabIcon, type LabIconName } from "./icons";
import styles from "./scenarios.module.css";

/* ------------------------------------------------------------------- region */

/** One region of the lab, at one of the artifact's two card weights. */
export function Region({
  id,
  title,
  icon,
  subtitle,
  badges,
  level = "panel",
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly icon?: LabIconName;
  readonly subtitle?: ReactNode;
  readonly badges?: ReactNode;
  readonly level?: "lead" | "panel";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={styles.region} data-level={level} aria-labelledby={id}>
      <div className={styles.regionHead}>
        <div className={styles.regionHeadings}>
          <h2 className={styles.regionTitle} id={id}>
            {icon ? (
              <span className={styles.regionIcon}>
                <LabIcon name={icon} size={15} />
              </span>
            ) : null}
            {title}
          </h2>
          {subtitle ? <p className={styles.regionSubtitle}>{subtitle}</p> : null}
        </div>
        {badges ? <div className={styles.regionAside}>{badges}</div> : null}
      </div>
      <div className={styles.regionBody}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- header */

/**
 * The lab's own header band, with the two controls that drive the whole screen.
 *
 * The artifact puts RESET TO BASELINE and RUN SCENARIO here rather than inside the assumptions
 * card, and that placement is the right one: they act on the run, not on one panel, and every
 * result below changes when either is pressed.
 *
 * **No session id.** The artifact prints `SESSION: LAB-X-DELTA-09`. Weathra stores no lab session
 * and issues no identifier for one, so the slot is empty rather than filled with a plausible
 * string.
 */
export function LabHeader({
  location,
  chooser,
  onRun,
  onReset,
  busy,
  dirty,
}: {
  readonly location: Location;
  readonly chooser: ReactNode;
  readonly onRun: () => void;
  readonly onReset: () => void;
  readonly busy: boolean;
  /** Whether the controls hold anything not yet run. */
  readonly dirty: boolean;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.headerKicker}>
          <Badge tone="quota">Simulated</Badge>
          <span className={styles.headerPlace}>{friendlyName(location)}</span>
        </div>
        <h1 className={styles.title}>Weather Scenario Lab</h1>
        <p className={styles.lede}>
          A sandbox for testing hypothetical atmospheric shifts against a real retrieved forecast,
          and reading what they do to it.
        </p>
      </div>

      <div className={styles.headerControls}>
        <details className={styles.placeControl}>
          <summary className={styles.placeSummary}>
            <span className={styles.placeName}>{friendlyName(location)}</span>
            <span className={styles.placeHint}>Change place</span>
          </summary>
          {chooser}
        </details>

        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={onReset} disabled={busy}>
            Reset to baseline
          </Button>
          <Button variant="primary" busy={busy} onClick={onRun}>
            {busy ? "Running…" : "Run scenario"}
          </Button>
        </div>
        {dirty ? <p className={styles.headerHint}>Assumptions changed — run to apply.</p> : null}
      </div>
    </header>
  );
}

/* -------------------------------------------------------------- assumptions */

/**
 * The artifact's assumptions rail: one slider per adjustable quantity, with its signed readout.
 *
 * A slider rather than a text field because the question this screen asks is "what if it were a bit
 * warmer" and a number input makes a person answer it in exact decimals before they can see
 * anything. The number field stays beside each slider — same value, same bounds — so an exact
 * figure is still typeable, and the range input carries the keyboard interaction a slider is
 * supposed to have.
 */
export function AssumptionRail({
  values,
  onChange,
  baseline,
}: {
  readonly values: AssumptionValues;
  readonly onChange: (key: AssumptionKey, value: number) => void;
  /** The retrieved mean of each measure, so a shift is read against something. */
  readonly baseline: Readonly<Record<string, string | null>>;
}): ReactNode {
  const change = (key: AssumptionKey) => (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (Number.isFinite(next)) onChange(key, next);
  };

  return (
    <div className={styles.rail}>
      {ASSUMPTION_CONTROLS.map((control) => {
        const value = values[control.key];
        const reference = baseline[control.measure];

        return (
          <div className={styles.control} key={control.key}>
            <div className={styles.controlHead}>
              <label className={styles.controlLabel} htmlFor={`assumption-${control.key}`}>
                {control.label}
              </label>
              <output className={styles.controlValue} data-tone={value === 0 ? "flat" : "set"}>
                {formatAssumption(control.key, value)}
              </output>
            </div>

            <input
              className={styles.slider}
              id={`assumption-${control.key}`}
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              onChange={change(control.key)}
            />

            <div className={styles.controlFoot}>
              <span>
                {control.min}
                {control.unit}
              </span>
              <span className={styles.controlBaseline}>
                {reference ? `Baseline ${reference}` : "No baseline reported"}
              </span>
              <span>
                +{control.max}
                {control.unit}
              </span>
            </div>

            {/* The exact figure, for anybody who wants one. Same bounds, same state. */}
            <input
              className={styles.controlNumber}
              type="number"
              aria-label={`${control.label}, exact value in ${control.unit}`}
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              onChange={change(control.key)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The artifact's "INFERENCE CONFIDENCE" bar, as the four things that are present or not.
 *
 * There is no inference and no confidence to report — the transformation is exact arithmetic, so a
 * percentage there would measure nothing. What a reader needs before trusting a run is which of its
 * inputs arrived, and each row here has a yes or a no behind it.
 */
export function ScenarioBasis({ rows }: { readonly rows: readonly BasisRow[] }): ReactNode {
  if (rows.length === 0) return null;

  return (
    <div className={styles.basis}>
      <p className={styles.basisTitle}>Scenario basis</p>
      <ul className={styles.basisList}>
        {rows.map((row) => (
          <li className={styles.basisRow} key={row.label} data-complete={row.complete}>
            <LabIcon name={row.complete ? "check" : "warning"} size={13} />
            <span className={styles.basisLabel}>{row.label}</span>
            <span className={styles.basisValue}>{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------- baseline / impact */

/** The two headline cards: what Weathra starts from, and what the assumptions make of it. */
export function ResultCard({
  card,
  variant,
  retrievedAt,
}: {
  readonly card: BaselineCard | ImpactCard;
  readonly variant: "baseline" | "scenario";
  readonly retrievedAt?: string | null;
}): ReactNode {
  const delta = "delta" in card ? card.delta : null;
  const tone = "tone" in card ? card.tone : "flat";

  return (
    <div className={styles.result} data-variant={variant}>
      <div className={styles.resultHead}>
        <p className={styles.resultReadout}>
          {card.headline ?? "—"}
          {card.headlineUnit ? (
            <span className={styles.resultUnit}>{card.headlineUnit}</span>
          ) : null}
        </p>
        {delta ? (
          <span className={styles.resultDelta} data-tone={tone}>
            {delta}
          </span>
        ) : null}
      </div>
      <p className={styles.resultCaption}>{card.caption}</p>

      {card.supporting.length > 0 ? (
        <dl className={styles.resultFigures}>
          {card.supporting.map((figure) => (
            <div className={styles.resultFigure} key={figure.key}>
              <dt>{figure.label}</dt>
              <dd>
                {figure.value}
                {figure.note ? (
                  <span className={styles.resultFigureNote} data-tone={figure.tone ?? "flat"}>
                    {figure.note}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {card.provider ? (
        <p className={styles.resultSource}>
          {variant === "baseline" ? `Retrieved from ${card.provider}` : "Computed by Weathra"}
          {retrievedAt ? ` · ${formatInstant(retrievedAt)}` : ""}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- delta tiles */

/** The artifact's four delta tiles, always four, one per adjustable quantity. */
export function DeltaStrip({ tiles }: { readonly tiles: readonly LabFigure[] }): ReactNode {
  if (tiles.length === 0) return null;

  return (
    <ul className={styles.deltas}>
      {tiles.map((tile) => (
        <li className={styles.delta} key={tile.key}>
          <span className={styles.deltaLabel}>{tile.label}</span>
          <span className={styles.deltaValue} data-tone={tile.tone ?? "flat"}>
            {tile.value}
          </span>
          {tile.note ? <span className={styles.deltaNote}>{tile.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------- interpretation */

/** The lab's reading of its own run, with the movements it was read from beside it. */
export function Interpretation({
  sentences,
  keyDeltas,
  risk,
  sensitivity,
}: {
  readonly sentences: readonly string[];
  readonly keyDeltas: readonly KeyDelta[];
  readonly risk: { readonly label: string; readonly detail: string } | null;
  readonly sensitivity: { readonly label: string; readonly detail: string } | null;
}): ReactNode {
  return (
    <div className={styles.interpretation}>
      <div className={styles.interpretationMain}>
        {sentences.map((sentence) => (
          <p className={styles.interpretationLine} key={sentence}>
            {sentence}
          </p>
        ))}

        <div className={styles.signals}>
          {risk ? (
            <div className={styles.signal} data-kind="risk">
              <span className={styles.signalLabel}>Primary signal</span>
              <span className={styles.signalValue}>{risk.label}</span>
              <span className={styles.signalDetail}>{risk.detail}</span>
            </div>
          ) : null}
          {sensitivity ? (
            <div className={styles.signal} data-kind="sensitivity">
              <span className={styles.signalLabel}>Scenario sensitivity</span>
              <span className={styles.signalValue}>{sensitivity.label}</span>
              <span className={styles.signalDetail}>{sensitivity.detail}</span>
            </div>
          ) : null}
        </div>
      </div>

      {keyDeltas.length > 0 ? (
        <aside className={styles.keyDeltas} aria-label="Key what-if deltas">
          <p className={styles.keyDeltasTitle}>Key what-if deltas</p>
          {keyDeltas.map((delta) => (
            <div className={styles.keyDelta} key={delta.key}>
              <span className={styles.keyDeltaLabel}>{delta.label}</span>
              <span className={styles.keyDeltaValue} data-tone={delta.tone ?? "flat"}>
                {delta.value}
              </span>
              {/*
                A bar length, not a statistic: this movement against the largest in the run. The
                figure it encodes is written under it so the bar is never the only carrier.
              */}
              <span className={styles.keyDeltaTrack} aria-hidden="true">
                <span
                  className={styles.keyDeltaFill}
                  style={{ inlineSize: `${Math.round(delta.share * 100)}%` }}
                />
              </span>
              <span className={styles.keyDeltaNote}>{delta.note}</span>
            </div>
          ))}
        </aside>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- the archive */

/** The archive block: the scenario placed against the years behind this calendar window. */
export function HistoricalCorrelation({
  view,
}: {
  readonly view: HistoricalView;
}): ReactNode {
  return (
    <div className={styles.historical}>
      <div className={styles.historicalMain}>
        <p className={styles.historicalHeadline}>{view.headline}</p>

        <dl className={styles.historicalFigures}>
          {view.figures.map((figure) => (
            <div className={styles.historicalFigure} key={figure.key}>
              <dt>{figure.label}</dt>
              <dd data-tone={figure.tone ?? "flat"}>{figure.value}</dd>
              {figure.note ? <p className={styles.historicalNote}>{figure.note}</p> : null}
            </div>
          ))}
        </dl>

        {view.analog ? (
          <div className={styles.analog}>
            <span className={styles.analogLabel}>{view.analog.label}</span>
            <span className={styles.analogValue}>{view.analog.value}</span>
            <span className={styles.analogNote}>{view.analog.note}</span>
          </div>
        ) : null}
      </div>

      <aside className={styles.evidence} aria-label="Evidence context">
        <p className={styles.evidenceTitle}>
          <LabIcon name="archive" size={14} />
          Evidence context
        </p>
        <ul className={styles.evidenceList}>
          <li>
            <span>Archive</span>
            <span>{view.provider ?? "Not reported"}</span>
          </li>
          <li>
            <span>Years compared</span>
            <span>{view.years}</span>
          </li>
          <li>
            <span>Window</span>
            <span>{view.labelling}</span>
          </li>
        </ul>
        <p className={styles.evidenceMethod}>{view.method}</p>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------- the footer */

/** The artifact's disclaimer strip, kept to what it is for. */
export function AnalyticalDisclaimer({ text }: { readonly text: string }): ReactNode {
  return (
    <footer className={styles.disclaimer}>
      <LabIcon name="warning" size={15} />
      <div>
        <p className={styles.disclaimerTitle}>Analytical disclaimer</p>
        <p className={styles.disclaimerText}>{text}</p>
      </div>
    </footer>
  );
}

/** How the transformation works, behind one control rather than in a card of its own. */
export function HowThisWorks({ methods }: { readonly methods: readonly string[] }): ReactNode {
  return (
    <details className={styles.howItWorks}>
      <summary className={styles.howItWorksSummary}>How this simulation works</summary>
      <div className={styles.howItWorksBody}>
        <p className={styles.quiet}>
          Weathra retrieves a real forecast, then applies each stated assumption to every hour of it
          — adding a quantity, or scaling one by a percentage. A physical bound is respected and the
          hours that reached one are counted rather than absorbed. Nothing models the atmosphere.
        </p>
        {methods.length > 0 ? (
          <ul className={styles.methodList}>
            {methods.map((method) => (
              <li key={method}>{method}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/* ---------------------------------------------------------- shared controls */

/** The screen's place control, so both branches of the screen use the same one. */
export function LabPlaceChooser({
  location,
  usingDefault,
  hasDefault,
  onChoose,
}: {
  readonly location: Location | null;
  readonly usingDefault: boolean;
  readonly hasDefault: boolean;
  readonly onChoose: (location: Location | null) => void;
}): ReactNode {
  return (
    <PlaceChooser
      summary="Experiment on another place"
      label="Experiment on a place"
      description="Weathra resolves the name before it retrieves anything. Leave it empty to use your default location."
      current={location}
      usingDefault={usingDefault}
      hasDefault={hasDefault}
      onChoose={onChoose}
    />
  );
}
