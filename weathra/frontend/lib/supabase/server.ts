/**
 * The Supabase client for server components, server actions, and route handlers.
 *
 * Reads the request's cookies through `next/headers`, so a server-rendered protected layout can
 * resolve the session *before* it renders — the mechanism that keeps protected content from
 * flashing (design.md decision 18).
 *
 * `cookies()` is asynchronous in Next 15, so this factory is too.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { publicEnv } from "@/lib/env";

/** A Supabase client bound to the current request's cookies. */
export async function supabaseServerClient(): Promise<SupabaseClient> {
  const store = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(updates: { name: string; value: string; options: CookieOptions }[]) {
        // A server *component* renders after the response headers are settled, so writing a cookie
        // from one throws. That is not an error worth surfacing: `middleware.ts` refreshes the
        // session on every request, so the write this call would have made has already happened
        // where it is legal. Swallowing it here is what the Supabase SSR guidance prescribes, and
        // the alternative — every server component wrapping its session read in a try — puts the
        // same swallow in fifty places.
        try {
          for (const { name, value, options } of updates) {
            store.set(name, value, options);
          }
        } catch {
          // Written by the middleware instead.
        }
      },
    },
  });
}

/**
 * The signed-in user for the current request, or null.
 *
 * `getUser()` rather than `getSession()`: it validates the token against Supabase rather than
 * trusting whatever the cookie decodes to, which is what makes it safe to base a server-side
 * routing decision on. The backend still validates the bearer token on every call — the frontend's
 * answer here is never the authority (`specs/web-ui`: "the backend remains authoritative").
 */
export async function currentUser(): Promise<User | null> {
  const client = await supabaseServerClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  return user;
}
