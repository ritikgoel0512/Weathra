"use client";

/**
 * Tabs, with the keyboard behaviour the pattern actually requires.
 *
 * A tablist is not a row of buttons: only the selected tab is in the tab order, and Left/Right,
 * Home and End move the selection within the list. `specs/web-ui` requires every action to be
 * reachable by keyboard alone, and a row of eight focusable buttons makes a person press Tab eight
 * times to get past a settings header.
 *
 * Controlled by design. The active tab is state a screen owns — Settings may put it in the URL so
 * a section is linkable — and a component holding it internally would take that away.
 */

import { useCallback, useId, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "@/components/shell/icons";
import type { IconName } from "@/lib/navigation";

import styles from "./primitives.module.css";

export interface TabDescriptor {
  readonly id: string;
  readonly label: string;
  /**
   * A section the artifact draws that this build does not implement.
   *
   * `07-settings.png` shows four tabs; two of them — AI Intelligence and Transparency — have
   * nothing behind them (`docs/design/screens.md` §8: model selection is not caller-selectable, and
   * transparency is the labelling on every screen rather than a page). Dropping them changed the
   * tab row's composition; presenting them as working would advertise sections that do not exist.
   * So they are drawn, disabled, and say why in words rather than by colour alone.
   */
  readonly unavailable?: string;
  /**
   * The glyph the artifact draws on this tab, where it draws one.
   *
   * Optional: a tablist with no artifact behind it should not have to invent icons. The icon is
   * `aria-hidden` — the label beside it is the accessible name — so adding one changes nothing a
   * screen reader hears. Finding 7.4 of the runtime fidelity audit of 2026-09-08.
   */
  readonly icon?: IconName;
}

export interface TabsProps {
  readonly tabs: readonly TabDescriptor[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
  /** Names the tablist for a screen reader — "Settings sections", not "Tabs". */
  readonly label: string;
  /** Shared prefix for the tab and panel ids, so `TabPanel` can be given the same one. */
  readonly idPrefix?: string;
}

export function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

export function tabPanelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

export function Tabs({ tabs, activeId, onChange, label, idPrefix }: TabsProps): ReactNode {
  const generated = useId();
  const prefix = idPrefix ?? generated;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = tabs.findIndex((tab) => tab.id === activeId);
      if (index < 0) return;

      // Arrow keys skip the sections that are drawn but not implemented: a roving tab index that
      // stopped on a disabled tab would strand a keyboard user on a control that does nothing.
      const selectable = tabs.filter((tab) => !tab.unavailable);
      const here = selectable.findIndex((tab) => tab.id === activeId);
      if (here < 0 || selectable.length === 0) return;

      let next: number | null = null;
      if (event.key === "ArrowRight") next = (here + 1) % selectable.length;
      else if (event.key === "ArrowLeft") next = (here - 1 + selectable.length) % selectable.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = selectable.length - 1;
      if (next === null) return;

      const target = selectable[next];
      if (!target) return;
      event.preventDefault();
      onChange(target.id);
      document.getElementById(tabId(prefix, target.id))?.focus();
    },
    [activeId, onChange, prefix, tabs],
  );

  return (
    <div className={styles.tablist} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        if (tab.unavailable) {
          return (
            /*
              The marking rides on `aria-label` rather than a visually-hidden span. The span was
              absolutely positioned with no positioned ancestor inside the scrolling tab row, so it
              escaped the row's clipping and pushed the page open by 70 pixels at 360 — the
              horizontal page scroll `specs/web-ui` rules out. A label carries the same words to the
              same readers and occupies no space at all.
            */
            <button
              key={tab.id}
              className={styles.tab}
              id={tabId(prefix, tab.id)}
              type="button"
              role="tab"
              aria-selected={false}
              aria-disabled="true"
              aria-label={`${tab.label} — ${tab.unavailable}`}
              data-unavailable="true"
              tabIndex={-1}
              disabled
            >
              {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
              {tab.label}
            </button>
          );
        }
        return (
          <button
            key={tab.id}
            className={styles.tab}
            id={tabId(prefix, tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(prefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  readonly id: string;
  readonly activeId: string;
  readonly idPrefix: string;
  readonly children?: ReactNode;
}

export function TabPanel({ id, activeId, idPrefix, children }: TabPanelProps): ReactNode {
  const active = id === activeId;
  return (
    <div
      className={styles.tabPanel}
      id={tabPanelId(idPrefix, id)}
      role="tabpanel"
      aria-labelledby={tabId(idPrefix, id)}
      hidden={!active}
      tabIndex={0}
    >
      {active ? children : null}
    </div>
  );
}
