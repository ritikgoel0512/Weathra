"use client";

/**
 * The confirmation step a destructive action goes through — task 21.6, widened in task 21.8.
 *
 * `specs/web-ui` and `docs/design/design-system.md` §10 ask for different strengths of confirmation
 * for different losses: session-memory deletion carries "a confirmation step", and account-data
 * deletion carries "an explicit confirmation step". Both are here, and the difference is one prop.
 *
 * **The action is never one press.** The trigger opens a panel that says, in plain words, what will
 * be removed and what will not; the removal itself is a second, separately labelled control. There
 * is no `window.confirm`: it cannot be styled, cannot be read by the tests, and gives a person no
 * room to state what the operation actually does.
 *
 * **`typedConfirmation` is the explicit form.** Where it is set, the confirm control stays disabled
 * until the person has typed the word exactly. That is the difference between a press somebody
 * meant and a press that happened, and it is reserved for the action that cannot be undone.
 *
 * **Nothing is announced as done here.** This component runs the action and reports `busy`; whether
 * it succeeded is the caller's mutation state, read from the backend's own response. A failure
 * therefore cannot surface as a success: this component never says anything about the outcome.
 *
 * ---
 *
 * Three things changed in task 21.8, when this moved out of `components/settings/` so that Weather
 * Watch and Saved Locations — both of which deleted a record on a single press — could use the
 * pattern the product already had rather than a second one invented beside it.
 *
 * **The panel is an `alertdialog`.** It was `role="group"`, which names a grouping but says nothing
 * about the answer it is waiting for. `alertdialog` is the WAI-ARIA pattern for exactly this: a
 * dialog interrupting to confirm a consequential action, named by its question and described by the
 * text that says what will be lost. The name comes from `aria-labelledby` on the question rather
 * than a duplicated `aria-label`, so the heading a sighted person reads is the name everybody gets.
 *
 * **Escape cancels.** Without it the only way out of an opened confirmation was to find the Cancel
 * control, which is a keyboard trap in everything but the technical sense. Escape closes the panel
 * and mutates nothing — it is Cancel, reached by the key people already press.
 *
 * **Focus comes back.** Opening moves focus into the panel, which is what makes a keyboard user
 * meet the warning rather than tab past it. Closing puts focus back on the trigger that opened it,
 * guarded on focus actually being inside the panel so a close from elsewhere does not snatch it —
 * the same rule the shell's drawer follows (`components/shell/app-shell.tsx`).
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "./button";

import styles from "./confirm-action.module.css";

export interface ConfirmActionProps {
  /** The trigger's label — what the person is about to start. */
  readonly trigger: string;
  /**
   * The trigger's accessible name, where the visible label is not distinct on its own.
   *
   * A list of rows each offering "Delete" gives a screen-reader or voice user a page of identically
   * named controls with no way to tell which is which. Where that happens the row passes the name
   * that says *which* — "Delete conversation: Berlin this week" — and the visible label stays short.
   * Omitted where the visible label is already unique on the screen.
   */
  readonly triggerName?: string;
  /** The confirmation panel's heading, phrased as the question it is. */
  readonly title: string;
  /** What will be removed, and what will not. Shown before anything can be pressed. */
  readonly children: ReactNode;
  /** The label on the control that actually does it. */
  readonly confirmLabel: string;
  /** What the person must type first. Omitted for a single-step confirmation. */
  readonly typedConfirmation?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  /** Closes the panel from outside — after the action completed, for instance. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function ConfirmAction({
  trigger,
  triggerName,
  title,
  children,
  confirmLabel,
  typedConfirmation,
  busy = false,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
}: ConfirmActionProps): ReactNode {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [typed, setTyped] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
      if (!next) setTyped("");
    },
    [onOpenChange],
  );

  /**
   * Close, and put focus back where it came from.
   *
   * The restore cannot happen here: closing unmounts the panel and mounts the trigger, so at this
   * point `triggerButton` still holds the element from the last time the trigger was on screen and
   * focusing it would focus a detached node. The flag is read by the effect below, which runs after
   * React has put the new trigger in the document.
   *
   * Guarded on focus actually being inside the panel: a close driven by the caller — the mutation
   * finished, say — should not pull focus away from wherever the person has since moved.
   */
  const restore = useRef(false);

  const dismiss = useCallback(() => {
    const active = document.activeElement;
    restore.current = Boolean(active instanceof Node && panel.current?.contains(active));
    setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    // The panel is the whole point of the step; moving focus into it is what makes a keyboard or
    // screen-reader user encounter the warning rather than the control past it.
    if (open) {
      panel.current?.focus();
      return;
    }
    if (!restore.current) return;
    restore.current = false;
    triggerButton.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <Button
        ref={triggerButton}
        variant="danger"
        size="sm"
        aria-label={triggerName}
        onClick={() => setOpen(true)}
      >
        {trigger}
      </Button>
    );
  }

  const satisfied = typedConfirmation === undefined || typed.trim() === typedConfirmation;

  return (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      ref={panel}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Escape is Cancel reached by the key people already press. It closes and mutates nothing —
        // and it stops there, so a confirmation inside the shell's drawer does not also close that.
        if (event.key !== "Escape" || busy) return;
        event.stopPropagation();
        dismiss();
      }}
    >
      <p className={styles.confirmTitle} id={titleId}>
        {title}
      </p>
      <div className={styles.body} id={bodyId}>
        {children}
      </div>

      {typedConfirmation === undefined ? null : (
        <label className={styles.typed}>
          <span className={styles.typedLabel}>Type {typedConfirmation} to confirm</span>
          <input
            className={styles.field}
            type="text"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}

      <div className={styles.actions}>
        <Button
          variant="danger"
          size="sm"
          busy={busy}
          disabled={!satisfied}
          onClick={() => {
            if (!satisfied || busy) return;
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
