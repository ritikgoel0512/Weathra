"use client";

/**
 * The Saved Locations workspace's panels — `docs/design/screens/06-saved-locations.png`.
 *
 * The artifact is a multi-location weather workspace: a header carrying search and one primary
 * action, a grid of weather cards, a cross-location summary against a comparison rail, and the
 * allowance as a strip. What was here before was a list of records — a name, a timezone, a
 * coordinates disclosure, Open and Remove — with the allowance as the page's largest panel.
 *
 * Three rules hold across everything below.
 *
 * **A place is named, never plotted.** The canonical resolved name is the identity on every card,
 * and coordinates appear nowhere as a place's name.
 *
 * **A reading that did not arrive is said, not hidden.** A provider failure costs a card its
 * weather and never the card itself, because a place vanishing from this screen would read as a
 * saved location having been lost.
 *
 * **Nothing is padded.** A panel with nothing to say says so in one line, and none of the
 * artifact's invented apparatus appears anywhere: no workspace id, no grounding nodes, no telemetry
 * sync, no sensor calibration, no model consensus, no compliance lock.
 */

import type { ReactNode } from "react";

import { Badge, Button, Input, WeatherIcon } from "@/components/ui";
import {
  agoOf,
  type AttentionItem,
  type ComparisonView,
  type OverviewFact,
  type UsageFigure,
  type WorkspaceCard,
} from "@/lib/locations/workspace";

import { PlaceIcon, type PlaceIconName } from "./workspace-icons";
import styles from "./workspace.module.css";

/* ------------------------------------------------------------------- header */

/** The band across the top: what this screen is, how to find a place, and how to add one. */
export function WorkspaceHeader({
  query,
  onQuery,
  onAdd,
  saved,
  limit,
  atLimit,
}: {
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly onAdd: () => void;
  readonly saved: number;
  readonly limit: number;
  readonly atLimit: boolean;
}): ReactNode {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.headerKicker}>
          <Badge tone="ok">Observed</Badge>
          <span className={styles.headerCount}>
            {saved} of {limit} saved
          </span>
        </div>
        <h1 className={styles.title}>Saved Locations</h1>
        <p className={styles.lede}>
          Monitor the weather across the places you care about, and open deeper analysis when
          needed.
        </p>
      </div>

      {/*
        One toolbar row. The field's own label is the control's accessible name and is not drawn —
        the placeholder says the same words, and a stacked label pushed the header a third taller
        for a word already on screen twice.
      */}
      <div className={styles.toolbar}>
        {/*
          A filter over what is already saved, never a geocoder. Typing a city nobody has saved
          finds nothing here and is supposed to: adding a place is the button beside it, and one
          field that sometimes searched the world and sometimes searched a list would be the worse
          of the two controls in both directions.
        */}
        <div className={styles.search}>
          <Input
            label="Search saved locations"
            name="filter"
            type="search"
            value={query}
            placeholder="Search saved locations…"
            autoComplete="off"
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
        <Button variant="primary" onClick={onAdd} disabled={atLimit}>
          Add location
        </Button>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- attention */

/** Drawn only when something is actually wrong. Absent is the ordinary state. */
export function AttentionStrip({ items }: { readonly items: readonly AttentionItem[] }): ReactNode {
  if (items.length === 0) return null;

  return (
    <ul className={styles.attention} aria-label="Saved locations wanting attention">
      {items.map((item) => (
        <li className={styles.attentionItem} key={`${item.kind}-${item.saved_id}`} data-tone={item.tone}>
          <PlaceIcon name={item.tone === "watch" ? "alert" : "unavailable"} size={15} />
          <span className={styles.attentionName}>{item.name}</span>
          <span className={styles.attentionDetail}>{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- the cards */

/**
 * One saved place, as a weather card rather than as a record.
 *
 * The hierarchy is the artifact's: provenance and watches along the top, the place's identity, the
 * temperature at readout weight with its condition beside it, the measures as labelled boxes, and
 * one primary way onward. The destructive control is the smallest thing on the card and sits behind
 * the same row as Compare, because a Remove drawn like a navigation control gets pressed by mistake.
 */
export function PlaceCard({
  card,
  now,
  onOpen,
  onCompare,
  onRemove,
  removing,
}: {
  readonly card: WorkspaceCard;
  readonly now: Date;
  readonly onOpen: () => void;
  readonly onCompare: () => void;
  readonly onRemove: () => void;
  readonly removing: boolean;
}): ReactNode {
  return (
    <li className={styles.card} data-unavailable={card.unavailable !== null}>
      <div className={styles.cardTop}>
        <span className={styles.cardProvenance}>
          {card.unavailable === null ? (
            <>
              <Badge tone="ok">Observed</Badge>
              <span className={styles.cardAge}>{agoOf(card.observedAt, now)}</span>
            </>
          ) : (
            <span className={styles.cardAge}>
              {card.observedAt === null ? "No reading yet" : `Last read ${agoOf(card.observedAt, now)}`}
            </span>
          )}
        </span>
        <span className={styles.cardFlags}>
          {card.isDefault ? <span className={styles.flag} data-kind="default">Default</span> : null}
          {card.watchCount > 0 ? (
            <span className={styles.flag} data-kind={card.metWatchCount > 0 ? "met" : "watching"}>
              {card.watchCount} watch{card.watchCount === 1 ? "" : "es"}
            </span>
          ) : null}
        </span>
      </div>

      <div className={styles.cardIdentity}>
        <p className={styles.cardName}>{card.name}</p>
        {card.qualifier ? <p className={styles.cardQualifier}>{card.qualifier}</p> : null}
      </div>

      {card.unavailable === null ? (
        <>
          <div className={styles.cardReadout}>
            <p className={styles.cardTemperature}>{card.temperature ?? "—"}</p>
            {card.condition ? (
              <p className={styles.cardCondition}>
                <WeatherIcon condition={card.condition} size={20} />
                {card.condition.label}
              </p>
            ) : null}
          </div>

          {card.metrics.length > 0 ? (
            <dl className={styles.chips}>
              {card.metrics.map((metric) => (
                <div className={styles.chip} key={metric.key}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        /*
          The card keeps its place, its watches and its actions. Only the weather is missing, and
          the sentence says which of the two it is — a provider that could not be reached is a fact
          about Weathra, not about the sky over that city.
        */
        <p className={styles.cardUnavailable}>
          <PlaceIcon name="unavailable" size={15} />
          Weather unavailable. Weathra could not retrieve the current conditions for this place.
        </p>
      )}

      <div className={styles.cardFoot}>
        <Button size="sm" variant="primary" onClick={onOpen}>
          View analytics →
        </Button>
        <span className={styles.cardSecondary}>
          <Button size="sm" onClick={onCompare}>
            Compare
          </Button>
          <Button size="sm" busy={removing} onClick={onRemove}>
            Remove
          </Button>
        </span>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------- the overview */

/** The cross-location summary. Deterministic facts, and one line where there is nothing to say. */
export function MultiLocationOverview({
  facts,
  summary,
  single,
}: {
  readonly facts: readonly OverviewFact[];
  /** One assembled sentence about the figures below it. Never a model's prose. */
  readonly summary: string | null;
  /** The card that is on screen when only one place is saved, so the panel is still useful. */
  readonly single: WorkspaceCard | null;
}): ReactNode {
  if (facts.length > 0) {
    return (
      <>
        {summary ? <p className={styles.summary}>{summary}</p> : null}
        <dl className={styles.facts}>
        {facts.map((fact) => (
          <div className={styles.fact} key={fact.key}>
            <dt>{fact.label}</dt>
            <dd>
              {fact.value}
              {fact.note ? <span className={styles.factNote}>{fact.note}</span> : null}
            </dd>
          </div>
          ))}
        </dl>
      </>
    );
  }

  return (
    <div className={styles.singleOverview}>
      {single ? (
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Saved place</dt>
            <dd>
              {single.name}
              {single.qualifier ? <span className={styles.factNote}>{single.qualifier}</span> : null}
            </dd>
          </div>
          {single.temperature ? (
            <div className={styles.fact}>
              <dt>Current temperature</dt>
              <dd>
                {single.temperature}
                {single.condition ? (
                  <span className={styles.factNote}>{single.condition.label}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {single.metrics.map((metric) => (
            <div className={styles.fact} key={metric.key}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className={styles.quiet}>
        Save another location to unlock cross-location comparison — warmest, coolest, the spread
        between them, and which of them is reporting rain.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------- the comparison */

/**
 * The rail: two saved places side by side across every measure both reported, and the way into
 * Compare Cities.
 *
 * A preview rather than a second Compare Cities. That screen ranks places against a criterion over
 * a window; this answers "how do these two differ right now" from a retrieval the page already
 * made, and hands off for anything more.
 */
export function LocationComparison({
  view,
  onCompare,
  onAdd,
}: {
  readonly view: ComparisonView | null;
  readonly onCompare: () => void;
  readonly onAdd: () => void;
}): ReactNode {
  if (view === null) {
    return (
      <>
        <p className={styles.quiet}>
          Save another location to compare conditions side by side — temperature, precipitation,
          humidity and wind, from the readings this page already has.
        </p>
        <div className={styles.railActions}>
          <Button size="sm" variant="primary" onClick={onAdd}>
            Add another location
          </Button>
          <Button size="sm" onClick={onCompare}>
            Open Compare Cities
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={styles.comparisonHead}>
        <span className={styles.comparisonPlace}>{view.leftName}</span>
        <span className={styles.comparisonPlace}>{view.rightName}</span>
      </div>
      {view.basis ? <p className={styles.quiet}>{view.basis}</p> : null}

      <dl className={styles.comparison}>
        {view.rows.map((row) => (
          <div className={styles.comparisonRow} key={row.key}>
            <dt>{row.label}</dt>
            <dd>
              <span className={styles.comparisonValue}>{row.left ?? "Not reported"}</span>
              <span className={styles.comparisonValue}>{row.right ?? "Not reported"}</span>
              {row.difference ? (
                <span className={styles.comparisonDifference}>Δ {row.difference}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <Button size="sm" onClick={onCompare}>
        Open Compare Cities
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- the usage */

/** The allowance, as a strip. Real, and never the page's subject. */
export function UsageStrip({
  figures,
  share,
}: {
  readonly figures: readonly UsageFigure[];
  readonly share: number;
}): ReactNode {
  return (
    <section className={styles.usage} aria-label="Saved location usage">
      <div className={styles.usageBar} aria-hidden="true">
        <span className={styles.usageFill} style={{ inlineSize: `${Math.round(share * 100)}%` }} />
      </div>
      <ul className={styles.usageFigures}>
        {figures.map((figure) => (
          <li className={styles.usageFigure} key={figure.key}>
            <span className={styles.usageLabel}>{figure.label}</span>
            <span className={styles.usageValue}>{figure.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ region */

/** One panel of the workspace, at one of the two card weights the artifact uses. */
export function Panel({
  id,
  title,
  icon,
  subtitle,
  aside,
  level = "panel",
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly icon?: PlaceIconName;
  readonly subtitle?: ReactNode;
  readonly aside?: ReactNode;
  readonly level?: "lead" | "panel";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={styles.panel} data-level={level} aria-labelledby={id}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadings}>
          <h2 className={styles.panelTitle} id={id}>
            {icon ? (
              <span className={styles.panelIcon}>
                <PlaceIcon name={icon} size={15} />
              </span>
            ) : null}
            {title}
          </h2>
          {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
        </div>
        {aside ? <div className={styles.panelAside}>{aside}</div> : null}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}
