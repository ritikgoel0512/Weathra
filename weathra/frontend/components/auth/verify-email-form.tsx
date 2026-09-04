"use client";

/**
 * The Verify Email screen's form — task 20.5.
 *
 * One verification concept, two entry paths (`docs/authentication.md`): the code from the *Confirm
 * signup* email typed in here, or the link from that same email followed back to this screen. Both
 * end in the same call to Supabase's `verifyOtp` and the same success state, because they are the
 * same act — the difference is only whether the one-time token was typed or carried in a URL.
 *
 * The rules below are requirements rather than choices:
 *
 * **Nothing here decides that anybody is verified.** There is no local flag, no verification token,
 * and no verification store. The screen calls the provider, and then reads the *session and the
 * confirmed address the provider gave back*; an outcome without both is not a success, and a
 * session for an address the provider has not confirmed is signed out rather than used. That is
 * `specs/authentication`'s "an unverified account SHALL NOT receive an authenticated session
 * usable against protected Weathra features", implemented as a structural property rather than a
 * check somebody has to remember.
 *
 * **Incorrect and expired are different states.** GoTrue answers both with the same refusal, so the
 * split is made here — see `VERIFICATION_CODE_LIFETIME_MS` for how, and for what it costs.
 *
 * **The provider's own words are never shown.** Not its error messages, not its status codes. The
 * one thing read out of a provider message is the *number* of seconds a rate limit asks for, which
 * `specs/authentication` requires the refusal to state.
 *
 * **The address is shown, not disclosed.** It is the value this flow already carried here — from
 * the account the person just created, or from the sign-in they just attempted — echoed back so
 * they can see which inbox to open. It says nothing about whether an account exists, which is why
 * the resend confirmation is phrased conditionally.
 *
 * Nothing here logs. Not the code, not the token from the link, not the session, not the provider's
 * error.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button, Input } from "@/components/ui";
import {
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_LIFETIME_MS,
  VERIFICATION_CODE_RULE,
  isConfirmedUser,
  normalizeVerificationCode,
  readLinkRefusal,
  verificationCodeFormatError,
  type LinkRefusal,
  type VerificationLinkType,
} from "@/lib/auth/verification";
import { CREATE_ACCOUNT_PATH, DEFAULT_PROTECTED_PATH, safeDestination } from "@/lib/routes";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

import styles from "./auth.module.css";
import {
  CODE_EXPIRED,
  CODE_INCORRECT,
  LINK_EXPIRED,
  LINK_INVALID,
  RESEND_CONFIRMED,
  RESEND_FAILED,
  TOO_MANY_ATTEMPTS,
  VERIFICATION_FAILED,
  classifyCodeFailure,
  isExpiredOrUnknownCode,
  isRateLimited,
  resendRateLimitedMessage,
  resendWaitSeconds,
} from "./failures";

/** The one-time token a returning verification link carries, straight out of the URL. */
export interface VerificationLink {
  readonly tokenHash: string;
  readonly type: VerificationLinkType;
}

export interface VerifyEmailFormProps {
  /** The address this flow already knows about, or null when it arrived without one. */
  readonly email?: string | null;
  /** Where to go once verified, already validated server-side. Re-validated here regardless. */
  readonly destination?: string | null;
  /** Present when the person arrived by following the link rather than by typing the code. */
  readonly link?: VerificationLink | null;
  /** A link the provider already refused, reported by redirecting back here with it. */
  readonly linkRefusal?: LinkRefusal | null;
  /**
   * The returning-link handler has already completed verification, and the *server* has confirmed
   * it against Supabase (task 20.6). Not a flag anybody can set from the outside: the page resolves
   * the session server-side before passing it, so this arrives already checked.
   */
  readonly confirmed?: boolean;
  /**
   * When the code being entered was sent. Defaults to the moment this screen was reached — which
   * is when the account was created, or when a sign-in routed an unverified account here — and is
   * reset by a successful resend.
   */
  readonly codeSentAt?: number;
}

function refusalMessage(refusal: LinkRefusal | null | undefined): string | null {
  if (refusal === "expired") return LINK_EXPIRED;
  if (refusal === "invalid") return LINK_INVALID;
  return null;
}

/** Which request is in flight. One at a time: the actions conflict, so they exclude each other. */
type Pending = "code" | "link" | "resend" | null;

export function VerifyEmailForm({
  email,
  destination,
  link,
  linkRefusal,
  confirmed = false,
  codeSentAt,
}: VerifyEmailFormProps): ReactNode {
  const router = useRouter();

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending>(link ? "link" : null);
  // The returning-link handler's outcome, already validated against Supabase by the server, is
  // where this starts when a link brought the person here. Nothing on the client sets it otherwise.
  const [verified, setVerified] = useState(confirmed);
  const [failure, setFailure] = useState<string | null>(() => refusalMessage(linkRefusal));
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const [sentAt, setSentAt] = useState(() => codeSentAt ?? Date.now());

  const target = safeDestination(destination) ?? DEFAULT_PROTECTED_PATH;

  /**
   * Read the outcome of a `verifyOtp` call, and admit only a confirmed one.
   *
   * The provider returning no error is not enough: what makes somebody verified is a session
   * *and* a confirmed address on the user it belongs to. Anything else is discarded — including a
   * session, which is signed out rather than left in the cookie jar.
   */
  const admit = useCallback(
    async (data: {
      session?: unknown;
      user?: { email_confirmed_at?: string | null; confirmed_at?: string | null } | null;
    } | null): Promise<boolean> => {
      if (data?.session && isConfirmedUser(data.user)) {
        setVerified(true);
        return true;
      }
      if (data?.session) await supabaseBrowserClient().auth.signOut();
      return false;
    },
    [],
  );

  /** The returning-link path: complete verification with no further entry. */
  const attempted = useRef(false);
  useEffect(() => {
    if (!link || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        const { data, error } = await supabaseBrowserClient().auth.verifyOtp({
          token_hash: link.tokenHash,
          type: link.type,
        });
        if (error) {
          // A link is either good or it is not — there is no "retype it" for a token that arrived
          // in a URL — so the refusal is reported as a link refusal, and the code entry below is
          // left ready as the way forward.
          if (isRateLimited(error)) setFailure(TOO_MANY_ATTEMPTS);
          else setFailure(isExpiredOrUnknownCode(error) ? LINK_EXPIRED : LINK_INVALID);
          setPending(null);
          return;
        }
        if (!(await admit(data))) {
          setFailure(LINK_INVALID);
          setPending(null);
          return;
        }
        setPending(null);
      } catch {
        setFailure(VERIFICATION_FAILED);
        setPending(null);
      }
    })();
  }, [admit, link]);

  /**
   * The other half of the returning-link path: a provider that refuses a link redirects back with
   * the reason, and puts it in the URL *fragment* for some flows — which a server component cannot
   * see. So the fragment is read here, and only when the server did not already find the reason.
   */
  useEffect(() => {
    if (link || linkRefusal) return;
    const fragment = window.location.hash;
    if (!fragment) return;
    const found = readLinkRefusal(new URLSearchParams(fragment.slice(1)));
    if (found) setFailure(refusalMessage(found));
  }, [link, linkRefusal]);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending || !email) return;

      const format = verificationCodeFormatError(code);
      setCodeError(format);
      setFailure(null);
      setResendConfirmed(false);
      // A code that is not six digits is not sent anywhere: there is nothing for the provider to
      // judge, and a rate limit spent on a typo is a rate limit the real code cannot have.
      if (format) return;

      setPending("code");
      try {
        const { data, error } = await supabaseBrowserClient().auth.verifyOtp({
          email,
          token: code,
          type: "signup",
        });

        if (error) {
          switch (
            classifyCodeFailure(error, {
              sentAt,
              now: Date.now(),
              lifetimeMs: VERIFICATION_CODE_LIFETIME_MS,
            })
          ) {
            case "expired":
              setFailure(CODE_EXPIRED);
              break;
            case "rate_limited":
              setFailure(TOO_MANY_ATTEMPTS);
              break;
            case "unavailable":
              setFailure(VERIFICATION_FAILED);
              break;
            default:
              setFailure(CODE_INCORRECT);
          }
          setPending(null);
          return;
        }

        if (!(await admit(data))) {
          setFailure(VERIFICATION_FAILED);
          setPending(null);
        }
      } catch {
        // A transport failure, not a judgement about the code.
        setFailure(VERIFICATION_FAILED);
        setPending(null);
      }
    },
    [admit, code, email, pending, sentAt],
  );

  const onResend = useCallback(async () => {
    if (pending || !email) return;
    setFailure(null);
    setResendConfirmed(false);
    setPending("resend");
    try {
      const { error } = await supabaseBrowserClient().auth.resend({ type: "signup", email });
      if (error) {
        setFailure(
          isRateLimited(error)
            ? resendRateLimitedMessage(resendWaitSeconds(error))
            : RESEND_FAILED,
        );
        setPending(null);
        return;
      }
      // The code being entered is now the new one, which is what the expired/incorrect split reads.
      setSentAt(Date.now());
      setCode("");
      setCodeError(undefined);
      setResendConfirmed(true);
      setPending(null);
    } catch {
      setFailure(RESEND_FAILED);
      setPending(null);
    }
  }, [email, pending]);

  const onContinue = useCallback(() => {
    router.replace(target);
    // The session now exists in cookies; this is what makes the server see it.
    router.refresh();
  }, [router, target]);

  if (verified) {
    return (
      <div className={styles.form}>
        <div className={styles.success} role="status" aria-live="polite">
          <p className={styles.successTitle}>Email verified</p>
          <p>Your address is confirmed and you are signed in.</p>
        </div>
        <Button variant="primary" fullWidth autoFocus onClick={onContinue}>
          Continue to Weathra
        </Button>
      </div>
    );
  }

  const liveMessage =
    pending === "link"
      ? "Completing verification from your email link…"
      : pending === "code"
        ? "Verifying your code…"
        : pending === "resend"
          ? "Sending a new code…"
          : resendConfirmed
            ? RESEND_CONFIRMED
            : "";

  return (
    <div className={styles.form}>
      {/*
        One polite live region, always in the DOM so a later change is announced rather than being
        an element that appears. `:empty` hides it while there is nothing to say.
      */}
      <p className={styles.status} role="status" aria-live="polite">
        {liveMessage}
      </p>

      {/* One error channel, so a person is never hunting for which of two red boxes moved. */}
      {failure ? (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      ) : null}

      {email ? (
        <>
          <p className={styles.notice}>
            We sent a {VERIFICATION_CODE_LENGTH}-digit verification code to{" "}
            <strong className={styles.noticeStrong}>{email}</strong>. Enter it below, or follow the
            link in the same email.
          </p>

          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <Input
              label="Verification code"
              name="code"
              // A numeric keypad on a phone, and the browser's own one-time-code autofill — which
              // on iOS and Android offers the code straight from the message.
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={VERIFICATION_CODE_LENGTH}
              autoFocus
              required
              value={code}
              error={codeError}
              description={VERIFICATION_CODE_RULE}
              disabled={pending !== null}
              onChange={(event) => setCode(normalizeVerificationCode(event.target.value))}
            />

            <Button type="submit" variant="primary" fullWidth busy={pending === "code"} disabled={pending !== null}>
              {pending === "code" ? "Verifying…" : "Verify email"}
            </Button>
          </form>

          <div className={styles.resend}>
            <span>Didn&rsquo;t get the email?</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResend}
              busy={pending === "resend"}
              disabled={pending !== null}
            >
              {pending === "resend" ? "Sending…" : "Resend code"}
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.notice}>
          We don&rsquo;t know which address to verify. Sign in, or create your account, and we will
          send a new verification code.
        </p>
      )}

      <p className={styles.aside}>
        <Link className={styles.link} href={CREATE_ACCOUNT_PATH}>
          Use a different email address
        </Link>
      </p>
    </div>
  );
}
