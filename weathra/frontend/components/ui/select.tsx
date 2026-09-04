"use client";

/**
 * The select: a labelled native `<select>`.
 *
 * Native deliberately. A custom listbox has to reimplement typeahead, touch behaviour and the
 * platform's own picker, and `specs/web-ui` requires every action to be reachable by keyboard
 * alone — which the native element gives correctly on every platform, for free.
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
        <select className={styles.control} {...control} {...rest}>
          {options
            ? options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))
            : children}
        </select>
      )}
    </Field>
  );
}
