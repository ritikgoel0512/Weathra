/**
 * The Supabase client for client components.
 *
 * Reads only the public configuration — the project URL and the public client key — which is the
 * whole of what design.md decision 19 allows a browser to hold. Nothing here can read a
 * server-side secret: `publicEnv` exposes none, and ESLint's `no-restricted-syntax` rule refuses a
 * non-`NEXT_PUBLIC_` read anywhere under `frontend/`.
 *
 * Cookies, not `localStorage`. `createBrowserClient` from `@supabase/ssr` stores the session in
 * cookies so the *server* can see it: Next.js middleware gates a protected route before the screen
 * renders, and it can only do that if the session travels with the request. A client-only session
 * would force a flash of protected shell, which `specs/web-ui` forbids outright.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env";

/**
 * The browser's Supabase client.
 *
 * `createBrowserClient` returns the same instance for the same configuration, so calling this from
 * several components does not create competing session listeners.
 */
export function supabaseBrowserClient(): SupabaseClient {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}

/**
 * The access token for the current session, or null.
 *
 * `getSession()` returns the stored session and refreshes it when the access token has expired but
 * the refresh token has not, so asking for the token per request — which the API client does — is
 * what keeps a long session working rather than failing quietly halfway through.
 */
export async function browserAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabaseBrowserClient().auth.getSession();
  return session?.access_token ?? null;
}
