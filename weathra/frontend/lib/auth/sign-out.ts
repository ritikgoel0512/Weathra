"use server";

/**
 * Sign out, as a server action.
 *
 * A server action rather than a click handler, for two reasons that both come from the locked
 * architecture. The session lives in cookies so the server can read it (design.md decision 18), so
 * *clearing* it is a server-side cookie write — legal in an action, silently swallowed in a server
 * component. And an action posted by a form works with no JavaScript at all, which means the one
 * control a person needs when something has gone wrong is the one control that cannot be broken by
 * a failed bundle.
 *
 * Supabase Auth remains the sole identity provider: this asks it to revoke the session and then
 * sends the person to sign-in. Nothing here writes, signs, or clears a token of its own.
 *
 * The session is revoked **globally**: every refresh token for the account, not only this
 * browser's. Signing out is what a person does on a shared or lost machine, and a sign-out that
 * left a refresh token alive somewhere else would not be one.
 *
 * The client half of the session — the query cache and the API client — lives inside
 * `SessionBoundary` inside the protected layout (task 20.9), so this navigation unmounts it. One
 * person's answers do not survive into the next person's sign-in on the same machine.
 */

import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/routes";
import { supabaseServerClient } from "@/lib/supabase/server";

export async function signOut(): Promise<void> {
  const client = await supabaseServerClient();
  try {
    await client.auth.signOut({ scope: "global" });
  } catch {
    try {
      // The provider could not be told. Clear this browser's session anyway — through Supabase,
      // which owns the cookies; Weathra still writes no session state of its own.
      await client.auth.signOut({ scope: "local" });
    } catch {
      // And even that is allowed to fail — for the reason immediately below.
    }
    // Swallowed on purpose, and this is the only place in Weathra where that is the right answer.
    // Sign-out is what a person reaches for when something is wrong; leaving them on a protected
    // screen because the identity provider was unreachable would strand them there. The session
    // cookies are cleared either way, and the next request's middleware routes them here again.
  }

  redirect(SIGN_IN_PATH);
}
