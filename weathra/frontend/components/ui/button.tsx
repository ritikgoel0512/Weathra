"use client";

/**
 * The button.
 *
 * Two things here are requirements rather than styling. First, `type` defaults to `"button"`: a
 * bare `<button>` inside a form submits it, and a "Retry" or "Add" control that silently submits
 * the form around it is a bug that only shows up in the browser. Second, `busy` disables the
 * control *and* announces it — `specs/web-ui` requires an in-flight request to disable its submit
 * control so the same request is not issued twice, and that obligation belongs to the button
 * rather than to each screen remembering it.
 *
 * The accent is the primary variant's background, with `accent-contrast` as its label colour. The
 * approved authentication artifact shows white on cyan, which measures about 1.9:1 — below the
 * 4.5:1 `specs/web-ui` requires — so the implementation uses the near-black label instead. That
 * divergence is recorded in `docs/design/screens.md` §8.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./primitives.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  /** A request this control started is in flight: it is disabled and announced as busy. */
  readonly busy?: boolean;
  readonly children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  fullWidth = false,
  busy = false,
  disabled = false,
  type = "button",
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      className={styles.button}
      type={type}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}
