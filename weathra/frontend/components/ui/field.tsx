"use client";

/**
 * The label, description and error scaffolding every form control shares.
 *
 * `specs/web-ui` requires every input to be labelled, and `specs/authentication` requires password
 * rules to be *stated before submission* rather than revealed by a rejection — so a description
 * slot that is wired to the control by `aria-describedby` is part of the primitive, not an extra a
 * screen adds. The wiring is the whole reason this exists: a visible label sitting next to an
 * input is not a label, and a red sentence under it is not an error a screen reader will find.
 *
 * The control itself is passed in through a render prop, so `Input` and `Select` share this frame
 * without either one inheriting the other's element.
 */

import { useId, type ReactNode } from "react";

import styles from "./primitives.module.css";

/** What the frame hands the control so the two are wired together. */
export interface FieldControl {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": true | undefined;
}

export interface FieldProps {
  readonly label: string;
  /** Stated before submission — rules, units, or what the value is used for. */
  readonly description?: string;
  /** The failure for this field. Its presence marks the control invalid. */
  readonly error?: string;
  readonly id?: string;
  readonly children: (control: FieldControl) => ReactNode;
}

export function Field({ label, description, error, id, children }: FieldProps): ReactNode {
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={controlId}>
        {label}
      </label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {description ? (
        <p className={styles.fieldDescription} id={descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className={styles.fieldError} id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
