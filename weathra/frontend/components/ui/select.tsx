"use client";

/**
 * The select: a labelled native `<select>`.
 *
 * Native deliberately. A custom listbox has to reimplement typeahead, touch behaviour and the
 * platform's own picker, and `specs/web-ui` requires every action to be reachable by keyboard
 * alone — which the native element gives correctly on every platform, for free.
 *
 * What is *not* native is the button the platform paints on it. The runtime fidelity audit of
 * 2026-09-08 recorded it as finding 7.2: the operating system's own dropdown chrome, on a screen
 * where every other control is Weathra's. The element and its behaviour are untouched; the wrapper
 * below draws the chevron in the palette's own colour, and a forced-colours mode gets the
 * platform's back.
 *
 * Options may be passed as data or as children; the data form is what a preference control wants,
 * since a unit or horizon choice is a list, not markup.
 */

import type { ReactNode, SelectHTMLAttributes } from "react";

import { Field } from "./field";
import styles from "./primitives.module.css";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "id" | "aria-invalid"> {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly id?: string;
  readonly options?: readonly SelectOption[];
}

export function Select({
  label,
  description,
  error,
  id,
  options,
  children,
  ...rest
}: SelectProps): ReactNode {
  return (
    <Field label={label} description={description} error={error} id={id}>
      {(control) => (
        <span className={styles.controlChevron}>
          <select className={styles.control} {...control} {...rest}>
            {options
              ? options.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))
              : children}
          </select>
        </span>
      )}
    </Field>
  );
}
