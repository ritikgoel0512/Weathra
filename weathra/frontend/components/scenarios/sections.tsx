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
 * signed readout that is itself the precision field, and the retrieved figure the shift is read
 * against — so an exact value is still typeable without a second form field appearing beside it.
 *
 * **A baseline run says it is one.** With nothing supposed, the calculated card, the plot, the four
 * tiles, the reading and the archive block all describe the retrieved forecast; each of them names
 * that state rather than dressing an unchanged figure as a simulated one.
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
  type BaselineReference,
  type BasisRow,
  type HistoricalView,
  type ImpactCard,
  type KeyDelta,
  type LabFigure,
  type LabSignals,
  type Reading,
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
 * anything. The range input carries the keyboard interaction a slider is supposed to have.
 *
 * **The readout is the precision control.** The exact figure used to be typed into a bordered
 * number field parked under the slider, which read as an unrelated form field stapled to the
 * control — two places showing one value, and the prominent one not the editable one. The signed
 * readout in the head row *is* the input now: the sign and the unit sit in the same chip beside it,
 * so `+2.5 °C` is both what a person reads and what a person types into. The slider keeps its own
 * label; the field carries its own, naming the unit it wants.
 *
 * **Under the track sits what the shift is measured against** — the range at each end and the
 * retrieved figure between them. Where the provider reported nothing for a measure the line is
 * simply absent: "No baseline reported" over a baseline that arrived is worse than no line at all,
 * and that is exactly what this rail used to print on every opening run.
 */
export function AssumptionRail({
  values,
  onChange,
  baseline,
}: {
  readonly values: AssumptionValues;
  readonly onChange: (key: AssumptionKey, value: number) => void;
  /** The retrieved figure behind each measure, so a shift is read against something. */
  readonly baseline: Readonly<Record<string, BaselineReference | null>>;
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
        const tone = value === 0 ? "flat" : "set";

        return (
          <div className={styles.control} key={control.key}>
            <div className={styles.controlHead}>
              <label className={styles.controlLabel} htmlFor={`assumption-${control.key}`}>
                {control.label}
              </label>

              {/* The signed value, and the field that sets it, as one thing rather than two. */}
              <span className={styles.controlField} data-tone={tone}>
                <span className={styles.controlSign} aria-hidden="true">
                  {value > 0 ? "+" : ""}
                </span>
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
                <span className={styles.controlUnit} aria-hidden="true">
                  {control.unit}
                </span>
              </span>
            </div>

            {/*
              `aria-valuetext` rather than a second live readout beside the field: a slider
              announcing "2.5" is announcing a number without a unit or a sign, and an `<output>`
              carrying the signed string would be a live region duplicating what the field beside
              it already announces on every keystroke.
            */}
            <input
              className={styles.slider}
              id={`assumption-${control.key}`}
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              aria-valuetext={formatAssumption(control.key, value)}
              onChange={change(control.key)}
            />

            <div className={styles.controlFoot}>
              <span>
                {control.min}
                {control.unit}
              </span>
              {/* No line at all where the provider reported nothing — never a claim of absence. */}
              {reference ? (
                <span className={styles.controlBaseline}>
                  {reference.label} {reference.value}
                </span>
              ) : null}
              <span>
                +{control.max}
                {control.unit}
              </span>
            </div>
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

/**
 * The lab's reading of its own run, with the movements it was read from beside it.
 *
 * The two signals are always drawn, because "which signal" and "how sensitive" are questions the
 * screen answers in both states — `Baseline` and `Not evaluated` at rest, the backend's own labels
 * after a run. A signal with no figures behind it carries no detail line rather than a sentence
 * restating the paragraph above it.
 *
 * The footnote is what a scenario is *not*. It is secondary copy and sits as secondary copy: at
 * baseline it would otherwise be half the block.
 */
export function Interpretation({
  reading,
  keyDeltas,
  signals,
}: {
  readonly reading: Reading;
  readonly keyDeltas: readonly KeyDelta[];
  readonly signals: LabSignals;
}): ReactNode {
  return (
    <div className={styles.interpretation}>
      <div className={styles.interpretationMain}>
        {reading.sentences.map((sentence) => (
          <p className={styles.interpretationLine} key={sentence}>
            {sentence}
          </p>
        ))}

        <div className={styles.signals}>
          {signals.risk ? (
            <div className={styles.signal} data-kind="risk">
              <span className={styles.signalLabel}>Primary signal</span>
              <span className={styles.signalValue}>{signals.risk.label}</span>
              {signals.risk.detail ? (
                <span className={styles.signalDetail}>{signals.risk.detail}</span>
              ) : null}
            </div>
          ) : null}
          {signals.sensitivity ? (
            <div className={styles.signal} data-kind="sensitivity">
              <span className={styles.signalLabel}>Scenario sensitivity</span>
              <span className={styles.signalValue}>{signals.sensitivity.label}</span>
              {signals.sensitivity.detail ? (
                <span className={styles.signalDetail}>{signals.sensitivity.detail}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className={styles.interpretationFootnote}>{reading.footnote}</p>
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

/**
 * What the screen says when nothing has been supposed: the scenario *is* the baseline.
 *
 * Without it, a person landing on the lab reads four panels of real figures under a SIMULATED
 * header and has to work out for themselves whether the scenario failed to draw or simply has
 * nothing to draw yet. One line settles it, and it is the line every panel below then elaborates.
 */
export function BaselineNotice({ location }: { readonly location: Location }): ReactNode {
  return (
    <p className={styles.baselineNotice} role="status">
      <LabIcon name="check" size={15} />
      <span>
        <strong className={styles.baselineNoticeLead}>Scenario = baseline.</strong> No assumptions
        are applied, so every panel below is the retrieved forecast for {friendlyName(location)}.
        Move an assumption and run the scenario to make the two diverge.
      </span>
    </p>
  );
}

/**
 * The compact intro the lab opens on before it has a place.
 *
 * It used to draw three full-size empty panels under the chooser — an assumptions card, a plot
 * frame and an archive frame, all of them blank — which is a screen pretending to be loaded. What a
 * person needs here is one sentence about what the lab does and the control that starts it.
 */
export function LabIntroduction({ chooser }: { readonly chooser: ReactNode }): ReactNode {
  return (
    <section className={styles.intro} aria-labelledby="lab-intro-title">
      <div className={styles.introText}>
        <div className={styles.headerKicker}>
          <Badge tone="quota">Simulated</Badge>
        </div>
        <h1 className={styles.title} id="lab-intro-title">
          Weather Scenario Lab
        </h1>
        <p className={styles.lede}>
          Suppose it were warmer, wetter, more humid or windier. The lab applies your assumption to
          a real retrieved forecast for one place and reads what it does — hour by hour, as four
          deltas, and against the archived years for the same calendar window.
        </p>
        <p className={styles.introNote}>
          Name a place to begin, or set a default in Settings and every screen opens on it. Nothing
          is retrieved until one resolves.
        </p>
      </div>
      <div className={styles.introChooser}>{chooser}</div>
    </section>
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
        {/* What was placed, named for the state the run is in, then the backend's own sentence. */}
        {view.lead ? <p className={styles.historicalLead}>{view.lead}</p> : null}
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
