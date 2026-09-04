/**
 * What counts as an email address on the way in.
 *
 * Deliberately loose: something before an "@", something after it, no spaces. Supabase Auth is the
 * authority on what a deliverable address is, and a clever client-side pattern's only achievement
 * is rejecting somebody whose perfectly valid address it had not heard of.
 *
 * Shared rather than copied, because the screens that ask for an address (Create Account) and the
 * screens that *display one back* (Verify Email) must agree: the second uses it to decide whether a
 * value arriving in the URL is safe to echo at all.
 */

export function looksLikeAnAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}
