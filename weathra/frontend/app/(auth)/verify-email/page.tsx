/**
 * `/verify-email` — the Verify Email screen, and the route the whole verification flow converges on.
 *
 * Three ways in, one screen: an account just created (task 20.4), a sign-in by an account the
 * provider has not confirmed (task 20.7), and the link from the verification email followed back
 * here. `lib/routes.ts` names the path, and both forms already redirect to it — this is the screen
 * they were redirecting to.
 *
 * A server component, and its job before rendering is to read the URL, because everything in it
 * arrived from outside:
 *
 * - **The address** is echoed back only when it looks like an address at all. It is not a
 *   disclosure — it is the value this flow carried here, shown so a person knows which inbox to
 *   open — but a query parameter rendered into the page is still a query parameter, so it is
 *   checked rather than trusted.
 * - **The destination** goes through `safeDestination`, which refuses anything that is not a path
 *   on this origin. The form checks it again.
 * - **The link's type** goes through an allow-list: a returning link may complete an email
 *   confirmation and nothing else.
 * - **A refusal the provider already made** — a link it would not accept — arrives as `error` and
 *   `error_code`, and becomes the screen's initial state rather than a blank form.
 * - **The returning-link handler's marker** (`/auth/confirm`, task 20.6) says a link was just
 *   completed. It is not taken as proof of anything: the page resolves the session *server-side*
 *   and shows the success state only if Supabase says the address is confirmed. A marker without
 *   such a session — a stale bookmark, a URL somebody typed — is treated as a refused link.
 *
 * That is the whole of the returning link's landing: one screen, one success state, whether the
 * person typed the code or followed the link.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { VerifyEmailForm, type VerificationLink } from "@/components/auth/verify-email-form";
import styles from "@/components/auth/auth.module.css";
import { looksLikeAnAddress } from "@/lib/auth/email";
import { isConfirmedUser, readLinkRefusal, verificationLinkType } from "@/lib/auth/verification";
import {
  COMPLETED_PARAMETER,
  COMPLETED_VERIFICATION,
  DESTINATION_PARAMETER,
  SIGN_IN_PATH,
  safeDestination,
} from "@/lib/routes";
import { currentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Verify your email" };

type SearchParameters = Record<string, string | string[] | undefined>;

/** A query parameter as one value: a repeated parameter is read as its first occurrence. */
function one(parameters: SearchParameters, name: string): string | undefined {
  const value = parameters[name];
  return Array.isArray(value) ? value[0] : value;
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  readonly searchParams?: Promise<SearchParameters>;
}): Promise<ReactNode> {
  const parameters = (await searchParams) ?? {};

  const candidate = one(parameters, "email")?.trim();
  const email = candidate && looksLikeAnAddress(candidate) ? candidate : null;

  const destination = safeDestination(one(parameters, DESTINATION_PARAMETER));

  const tokenHash = one(parameters, "token_hash");
  const type = verificationLinkType(one(parameters, "type"));
  const link: VerificationLink | null = tokenHash && type ? { tokenHash, type } : null;

  const refusal = readLinkRefusal(
    new URLSearchParams(
      Object.entries(parameters).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value] as [string, string]] : [],
      ),
    ),
  );

  // The returning-link handler says it completed a verification. Ask Supabase whether that is true
  // before showing anybody a success state — `currentUser()` validates the session's token with the
  // provider rather than reading the cookie's contents, so the marker decides nothing on its own.
  const claimsCompletion = one(parameters, COMPLETED_PARAMETER) === COMPLETED_VERIFICATION;
  const confirmed = claimsCompletion && isConfirmedUser(await currentUser());

  return (
    <AuthShell
      title="Verify your email"
      subtitle="One more step before Weathra can sign you in."
      footer={
        <>
          Already verified?{" "}
          <Link className={styles.link} href={SIGN_IN_PATH}>
            Sign in
          </Link>
        </>
      }
    >
      <VerifyEmailForm
        email={email}
        destination={destination}
        link={link}
        confirmed={confirmed}
        // A completion claim the session does not support is a link that no longer works.
        linkRefusal={refusal ?? (claimsCompletion && !confirmed ? "invalid" : null)}
      />
    </AuthShell>
  );
}
