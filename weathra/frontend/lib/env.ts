/**
 * The only configuration the frontend reads. Everything here is public by design and ships in the
 * browser bundle; a server-side secret must never appear in this file or anywhere under frontend/.
 *
 * See design.md decision 19 and frontend/.env.example.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy frontend/.env.example to frontend/.env.local and fill it in.`,
    );
  }
  return value;
}

export const publicEnv = {
  /** Supabase project URL. */
  get supabaseUrl(): string {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  /** Supabase public client key. Carries no privilege beyond an anonymous or signed-in caller's. */
  get supabaseAnonKey(): string {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  /** Weathra backend base URL. Changing it retargets the frontend with no code change. */
  get apiBaseUrl(): string {
    return required("NEXT_PUBLIC_API_BASE_URL", process.env.NEXT_PUBLIC_API_BASE_URL);
  },
} as const;
