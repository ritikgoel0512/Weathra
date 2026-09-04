"use client";

/**
 * The expired-session state — task 20.9, and the one screen a person sees when their session runs
 * out mid-use.
 *
 * `specs/web-ui` asks for three things at once here, and each is a line below: say that the session
 * expired rather than presenting an authentication failure as a data or server error; keep the
 * person's place well enough to return them to it; and offer the way back.
 *
 * **The provider is never quoted.** Not its message, not its status, not its error code. A session
 * ending is a fact about Weathra, and the sentence is Weathra's.
 *
 * **The destination comes from the address bar, and is validated anyway.** `expiredSignInPath` runs
 * it through `safeDestination`, so the one function in the application that turns a current
 * location into a redirect target cannot be talked into pointing off this origin.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { DEFAULT_PROTECTED_PATH, expiredSignInPath } from "@/lib/routes";

import styles from "./session.module.css";

export function SessionExpiredState(): ReactNode {
  const pathname = usePathname();

  /**
   * Where they were, query string included — which `usePathname` does not carry, and which is often
   * the whole of the place worth keeping: a comparison, a date range, a chosen city.
   *
   * Read once, when this mounts. It is only ever mounted in the browser (the server-resolved status
   * is `active` or `pending`, never `expired`), and the `usePathname` fallback is what makes the
   * component safe to render anywhere regardless.
   */
  const [destination] = useState(() =>
    typeof window === "undefined"
      ? expiredSignInPath(pathname ?? DEFAULT_PROTECTED_PATH)
      : expiredSignInPath(window.location.pathname, window.location.search),
  );

  const action = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // The content behind this is gone; leaving focus where it was would leave a keyboard or screen
    // reader user tabbing through nothing.
    action.current?.focus();
  }, []);

  return (
    <div className={styles.panel} role="alert">
      <p className={styles.title}>Your session has expired</p>
      <p className={styles.body}>
        Sign in again to carry on where you left off. Nothing you saved has been lost.
      </p>
      <Link ref={action} className={styles.action} href={destination}>
        Sign in again
      </Link>
    </div>
  );
}
