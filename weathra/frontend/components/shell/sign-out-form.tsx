/**
 * The sign-out control.
 *
 * A form posting to the server action, so it works without JavaScript and the session cookies are
 * cleared where clearing them is legal. Rendered on the server and passed into the shell as a
 * prop — the shell is a client component because of the drawer, and an action must not be reached
 * through it.
 */

import type { ReactNode } from "react";

import { signOut } from "@/lib/auth/sign-out";

import { Button } from "@/components/ui";

export function SignOutForm(): ReactNode {
  return (
    <form action={signOut}>
      <Button type="submit" variant="secondary" size="sm" fullWidth>
        Sign out
      </Button>
    </form>
  );
}
