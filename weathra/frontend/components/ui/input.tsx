"use client";

/**
 * The text input: a labelled control, with its description and error wired to it.
 *
 * `trailing` puts a control inside the field's frame — a password visibility toggle, a unit
 * switch. It sits *outside* the `<input>` in the DOM so it stays a real button with its own
 * accessible name, and the frame is what makes the pair read as one control.
 */

import type { InputHTMLAttributes, ReactNode } from "react";

import { Field } from "./field";
import styles from "./primitives.module.css";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "aria-invalid"> {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly id?: string;
  /** A control shown at the end of the field, inside its frame. */
  readonly trailing?: ReactNode;
}

export function Input({
  label,
  description,
  error,
  id,
  trailing,
  ...rest
}: InputProps): ReactNode {
  return (
    <Field label={label} description={description} error={error} id={id}>
      {(control) =>
        trailing ? (
          <span className={styles.controlFrame} data-invalid={error ? "true" : undefined}>
            <input className={styles.controlBare} {...control} {...rest} />
            {trailing}
          </span>
        ) : (
          <input className={styles.control} {...control} {...rest} />
        )
      }
    </Field>
  );
}
