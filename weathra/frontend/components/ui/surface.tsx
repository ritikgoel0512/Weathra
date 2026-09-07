/**
 * Surfaces and cards — the frame everything else sits in.
 *
 * `docs/design/design-system.md` §4 fixes the hierarchy: a shell holds a page, a page holds cards,
 * and a card holds one subject with its title, its data-class badge, its body, and an attribution
 * footer. §6 makes the footer non-optional in a data-bearing card, which is why `CardFooter` exists
 * as a named slot rather than as "whatever the screen puts at the bottom".
 *
 * The four surface levels are the step of lightness the approved artifacts are built on. A screen
 * picks a level, never a colour.
 */

import type { ReactNode } from "react";

import styles from "./primitives.module.css";

/** The four levels of `docs/design/design-system.md` §1. */
export type SurfaceLevel = "base" | "raised" | "overlay" | "inset";

export interface SurfaceProps {
  readonly level?: SurfaceLevel;
  readonly className?: string;
  readonly children?: ReactNode;
  /** For a region a screen reader should announce, e.g. an overlay. */
  readonly role?: string;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}

export function Surface({
  level = "raised",
  className,
  children,
  ...rest
}: SurfaceProps): ReactNode {
  return (
    <div
      className={className ? `${styles.surface} ${className}` : styles.surface}
      data-level={level}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardProps {
  readonly children?: ReactNode;
  readonly className?: string;
  /**
   * The id of the element naming this card, so the card is a labelled region rather than an
   * anonymous box in the accessibility tree. `CardHeader` generates one when given `titleId`.
   */
  readonly "aria-labelledby"?: string;
}

export function Card({ children, className, ...rest }: CardProps): ReactNode {
  const classes = [styles.surface, styles.card, className].filter(Boolean).join(" ");
  return (
    <section className={classes} data-level="raised" {...rest}>
      {children}
    </section>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly subtitle?: ReactNode;
  /** The data-class badge, where the card carries one. */
  readonly badge?: ReactNode;
  /** Controls belonging to this card only. A screen's primary action does not live here. */
  readonly actions?: ReactNode;
  /**
   * The heading level the title renders at. Three by default, which is right for a card nested
   * inside a screen's own `h2` panel — and wrong for one sitting directly under the screen's `h1`,
   * where it skips a level. Same parameter, and same reason, as `ProvenanceSection`'s: a heading
   * level is a fact about where a region sits rather than about what it is
   * (`docs/design/accessibility.md` §9).
   */
  readonly headingLevel?: 2 | 3;
}

export function CardHeader({
  title,
  titleId,
  subtitle,
  badge,
  actions,
  headingLevel = 3,
}: CardHeaderProps): ReactNode {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={styles.cardHeader}>
      <div className={styles.cardHeadings}>
        <Heading className={styles.cardTitle} id={titleId}>
          {title}
        </Heading>
        {subtitle ? <p className={styles.cardSubtitle}>{subtitle}</p> : null}
      </div>
      {badge || actions ? (
        <div className={styles.cardHeaderAside}>
          {badge}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactNode {
  const classes = className ? `${styles.cardBody} ${className}` : styles.cardBody;
  return <div className={classes}>{children}</div>;
}

/**
 * The footer a data-bearing card puts its provenance in.
 *
 * The attribution, timestamp and uncertainty *components* are task 20.15; this is the slot they go
 * in, styled as meta text that wraps rather than truncates — because when space runs out,
 * provenance is not the thing that gets dropped.
 */
export function CardFooter({ children }: { readonly children?: ReactNode }): ReactNode {
  return <div className={styles.cardFooter}>{children}</div>;
}
