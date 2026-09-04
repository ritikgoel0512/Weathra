/**
 * The password rules, in one place.
 *
 * `specs/authentication` requires that the rules be **stated to the person before submission** and
 * that a rejected password be "reported with the rule it failed" — but it deliberately does not fix
 * what the rules *are*, and no numeric policy existed anywhere in this repository before this
 * module. So these are recorded implementation decisions, documented in `docs/authentication.md`,
 * and the minimum length is mirrored in the Supabase project's own setting
 * (`docs/deployment.md`, *Required Supabase configuration*). That mirroring is the point: if the
 * provider were stricter than this list, a password this screen accepted would be refused *after*
 * submission — which is precisely the "revealed by a rejection" behaviour the spec forbids.
 *
 * **Length, not composition.** There is no "must contain a symbol" rule. Current guidance
 * (NIST SP 800-63B) is that composition rules push people towards predictable substitutions and
 * reuse while adding little entropy, and length is what actually helps. Weathra holds no password
 * material to make an opinion about anyway — Supabase Auth owns credentials entirely.
 *
 * The maximum is not arbitrary either: the provider hashes with bcrypt, which ignores anything past
 * 72 bytes, so a longer passphrase would be silently truncated. Saying so is better than accepting
 * a passphrase and using part of it.
 *
 * A rule is a label and a predicate, so the screen can state them, mark which are met as a person
 * types, and name the one that failed — all from the same declaration.
 */

/** The floor. Mirrored in the Supabase project's minimum-password-length setting. */
export const PASSWORD_MINIMUM_LENGTH = 12;

/** bcrypt's limit, past which the provider would ignore the rest. */
export const PASSWORD_MAXIMUM_LENGTH = 72;

export interface PasswordRule {
  readonly id: string;
  /** Stated before submission, and used verbatim when this is the rule that failed. */
  readonly label: string;
  readonly satisfied: (password: string, email?: string) => boolean;
}

/** The local part of an address, lowercased — or null when there is nothing usable to compare. */
function localPart(email: string | undefined): string | null {
  if (!email) return null;
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  // Below three characters a "not your email" rule starts rejecting reasonable passwords for
  // containing a two-letter sequence, which helps nobody.
  return local.length >= 3 ? local : null;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MINIMUM_LENGTH} characters`,
    satisfied: (password) => password.length >= PASSWORD_MINIMUM_LENGTH,
  },
  {
    id: "maximum",
    label: `No more than ${PASSWORD_MAXIMUM_LENGTH} characters`,
    satisfied: (password) => password.length <= PASSWORD_MAXIMUM_LENGTH,
  },
  {
    id: "not-email",
    label: "Not your email address",
    satisfied: (password, email) => {
      const local = localPart(email);
      if (!local) return true;
      const lowered = password.toLowerCase();
      return !lowered.includes(local) && lowered !== email?.trim().toLowerCase();
    },
  },
];

/** The rules this password does not meet, in the order they are stated. */
export function unmetPasswordRules(
  password: string,
  email?: string,
): readonly PasswordRule[] {
  return PASSWORD_RULES.filter((rule) => !rule.satisfied(password, email));
}

/** Whether every rule is met. */
export function passwordMeetsRules(password: string, email?: string): boolean {
  return unmetPasswordRules(password, email).length === 0;
}

/**
 * The message for a password that failed, naming the rule.
 *
 * One rule per message — the first unmet one. A list of everything wrong at once reads as a
 * scolding, and fixing the first usually fixes the rest.
 */
export function passwordFailureMessage(
  password: string,
  email?: string,
): string | undefined {
  const [failed] = unmetPasswordRules(password, email);
  if (!failed) return undefined;
  return `${failed.label}. Your password does not meet this rule yet.`;
}
