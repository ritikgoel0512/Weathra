"use client";

/**
 * The confirmation step a destructive action goes through — task 21.6.
 *
 * Two things are destroyed from Settings, and `specs/web-ui` and
 * `docs/design/design-system.md` §10 ask for different strengths of confirmation for them:
 * session-memory deletion carries "a confirmation step", and account-data deletion carries "an
 * explicit confirmation step". Both are here, and the difference is one prop.
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
 * it succeeded is the caller's mutation state, read from the backend's own response.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui";

import styles from "./settings.module.css";

export interface ConfirmActionProps {
  /** The trigger's label — what the person is about to start. */
  readonly trigger: string;
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

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
      if (!next) setTyped("");
    },
    [onOpenChange],
  );

  useEffect(() => {
    // The panel is the whole point of the step; moving focus into it is what makes a keyboard or
    // screen-reader user encounter the warning rather than the control past it.
    if (open) panel.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }

  const satisfied = typedConfirmation === undefined || typed.trim() === typedConfirmation;

  return (
    <div className={styles.confirm} role="group" aria-label={title} ref={panel} tabIndex={-1}>
      <p className={styles.confirmTitle}>{title}</p>
      <div className={styles.body}>{children}</div>

      {typedConfirmation === undefined ? null : (
        <label className={styles.setting}>
          <span className={styles.noteStrong}>
            Type {typedConfirmation} to confirm
          </span>
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
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
