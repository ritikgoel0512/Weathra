/**
 * The protected layout — task 20.12.
 *
 * Every screen in the `(app)` route group renders inside this, and this resolves the session
 * *server-side* before any of it renders. That ordering is the whole point (design.md decision 18):
 * a client-side check renders the shell first and empties it out afterwards, which is the flash of
 * protected content `specs/web-ui` forbids.
 *
 * **Two gates, deliberately.** `middleware.ts` already redirects an unauthenticated request for
 * this group, so the redirect below is not the primary gate — it is the one that still holds if the
 * matcher is ever narrowed, if a route is added outside it, or if a future refactor moves the
 * boundary. Neither gate is authorization: the backend validates the bearer token on every call,
 * and `specs/web-ui` is explicit that the backend remains authoritative.
 *
 * The middleware handles the destination-preserving redirect. This one, reached only when the
 * middleware did not run, sends the person to sign-in plainly rather than reconstructing a
 * destination it cannot see from a layout.
 *
 * Inside the shell, `SessionBoundary` (task 20.9) carries the session for the *client* half: the
 * query cache, the API client, the 401 interceptor, and the expired-session state. It is seeded
 * `active` because the line above has already validated the session with Supabase — which is why
 * no screen in this group ever renders a pending state it does not need, and why there is nothing
 * to flash.
 */

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { SignOutForm } from "@/components/shell/sign-out-form";
import { identityFrom } from "@/lib/auth/identity";
import { SIGN_IN_PATH } from "@/lib/routes";
import { SessionBoundary } from "@/lib/session/provider";
import { currentUser } from "@/lib/supabase/server";

export default async function ProtectedLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  // `getUser()` under the hood: the token is validated with Supabase rather than decoded from a
  // cookie, so a tampered cookie cannot render the shell.
  const user = await currentUser();
  if (!user) {
    redirect(SIGN_IN_PATH);
  }

  return (
    <AppShell identity={identityFrom(user)} signOutControl={<SignOutForm />}>
      <SessionBoundary initialStatus="active">{children}</SessionBoundary>
    </AppShell>
  );
}
