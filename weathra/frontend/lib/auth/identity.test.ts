/**
 * Who the shell says is signed in.
 *
 * The failure this guards against is a *plausible* lie: a display name assembled from an address,
 * an initial guessed from an empty string, or the mockups' persona surviving into the product. So
 * the precedence is pinned, and the empty cases are pinned too — including the one where the
 * session carries no name and no address at all.
 */

import type { User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { identityFrom } from "./identity";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-09-03T00:00:00.000Z",
    ...overrides,
  } as User;
}

describe("identityFrom", () => {
  it("prefers the name the person set", () => {
    const identity = identityFrom(
      user({ email: "sam@example.test", user_metadata: { full_name: "Sam Okafor" } }),
    );
    expect(identity.name).toBe("Sam Okafor");
    expect(identity.email).toBe("sam@example.test");
    expect(identity.monogram).toBe("S");
    expect(identity.known).toBe(true);
  });

  it("accepts the other name field Supabase may carry", () => {
    expect(identityFrom(user({ user_metadata: { name: "Ada" } })).name).toBe("Ada");
  });

  it("falls back to the address, and does not then repeat it underneath", () => {
    const identity = identityFrom(user({ email: "sam@example.test" }));
    expect(identity.name).toBe("sam@example.test");
    expect(identity.email).toBeNull();
    expect(identity.monogram).toBe("S");
  });

  it("does not invent a name out of an address", () => {
    // "sam@example.test" does not become "Sam" — Weathra does not know that is their name.
    expect(identityFrom(user({ email: "sam@example.test" })).name).not.toBe("Sam");
  });

  it("ignores a blank or non-string name", () => {
    expect(
      identityFrom(user({ email: "sam@example.test", user_metadata: { full_name: "   " } })).name,
    ).toBe("sam@example.test");
    expect(
      identityFrom(user({ email: "sam@example.test", user_metadata: { full_name: 42 } })).name,
    ).toBe("sam@example.test");
  });

  it("says plainly when a real session identifies nobody", () => {
    const identity = identityFrom(user());
    expect(identity.name).toBe("Signed in");
    expect(identity.email).toBeNull();
    expect(identity.monogram).toBe("•");
    expect(identity.known).toBe(true);
  });

  it("says plainly when there is no session", () => {
    const identity = identityFrom(null);
    expect(identity.name).toBe("Not signed in");
    expect(identity.known).toBe(false);
    expect(identity.monogram).toBe("•");
  });

  it("takes a monogram from a name in any script, and never from punctuation", () => {
    expect(identityFrom(user({ user_metadata: { full_name: "ada lovelace" } })).monogram).toBe("A");
    expect(identityFrom(user({ user_metadata: { full_name: "Ökarin" } })).monogram).toBe("Ö");
    expect(identityFrom(user({ user_metadata: { full_name: "日野" } })).monogram).toBe("日");
    expect(identityFrom(user({ user_metadata: { full_name: "-- ?" } })).monogram).toBe("•");
  });
});
