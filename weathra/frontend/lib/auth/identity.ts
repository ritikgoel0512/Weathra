/**
 * Who is signed in, as the shell shows it.
 *
 * `specs/web-ui` requires the persistent navigation to identify the signed-in person. The only
 * identity Weathra has on the frontend is what the validated session carries — an address, and
 * whatever name the person gave Supabase — so that is what is shown. The approved artifacts show a
 * persona ("Dr. Aris Thorne", "Lead Meteorologist"); `docs/design/screens.md` §5 records it as
 * mockup content, and none of it is implemented. There is no invented name, no title, and no role
 * label here.
 *
 * Pure, and separate from the component that renders it, because the interesting part is the
 * *precedence*: which of several possibly-empty fields is the person's name, and what is shown
 * when none of them is set.
 */

import type { User } from "@supabase/supabase-js";

export interface Identity {
  /** The best name the session carries. Never a placeholder person. */
  readonly name: string;
  /** The address, shown as the second line when it is not already the name. */
  readonly email: string | null;
  /** One character for the avatar. */
  readonly monogram: string;
  /** Whether anything at all identified them, so the shell can be honest when nothing did. */
  readonly known: boolean;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function monogramOf(name: string | null): string {
  const first = name?.match(/[\p{L}\p{N}]/u)?.[0];
  // A bullet rather than a letter guessed from an empty string: an avatar showing the wrong
  // initial is a small lie about who is signed in.
  return first ? first.toUpperCase() : "•";
}

/**
 * The identity for a Supabase user.
 *
 * Precedence: the name the person set, then the address. `user_metadata` is self-asserted profile
 * data, which is fine for a display name and is why nothing else is read from it — it is not
 * evidence of anything, and authorization never consults it (`specs/authentication`: the role and
 * the plan are server-held, never client-asserted).
 */
export function identityFrom(user: User | null): Identity {
  if (!user) {
    return { name: "Not signed in", email: null, monogram: "•", known: false };
  }

  const metadata: Record<string, unknown> = user.user_metadata ?? {};
  const declared = trimmed(metadata["full_name"]) ?? trimmed(metadata["name"]);
  const email = trimmed(user.email);
  const name = declared ?? email;

  return {
    // With neither a name nor an address, the session is still real — say so plainly rather than
    // inventing something to fill the line.
    name: name ?? "Signed in",
    email: declared ? email : null,
    monogram: monogramOf(name),
    known: true,
  };
}
