/**
 * `/auth/confirm` — the returning-link handler, task 20.6.
 *
 * The second of verification's two entry paths (`docs/authentication.md`): the code typed into the
 * Verify Email screen is the first, and this is the link from the same email. **One verification
 * concept, one handler.** The password-recovery link comes back through here too, for the same
 * reason — it is the same act with a different destination, and a second callback architecture
 * would be a second place for the token handling to be wrong.
 *
 * Everything about this route is a consequence of one fact: it is a URL an attacker can construct
 * and a stranger can be made to follow.
 *
 * - **Every parameter is validated before it is used.** The link type goes through an allow-list,
 *   so a link cannot ask the handler to complete a flow it did not mean to. The destination goes
 *   through `safeDestination`, so a link cannot turn this route — which people reach from their
 *   email client, already primed to trust it — into an open redirect.
 * - **The exchange happens server-side, against the request's cookies.** `supabaseServerClient()`
 *   is the same cookie-bound client every server component uses (design.md decision 18), so the
 *   session Supabase issues is written where the middleware and the next render will find it.
 * - **A completed exchange is not yet a success.** The handler reads back the session *and* asks
 *   Supabase who it belongs to, and for a verification link it additionally requires that Supabase
 *   considers the address confirmed. A session that arrives without confirmation is signed out
 *   rather than kept: `specs/authentication` says an unverified account holds no session usable
 *   against protected features, and this is the one route where such a session could appear.
 * - **The redirect carries no secret.** The token hash, the authorization code, and anything else
 *   the link arrived with are dropped; what leaves is a Weathra-chosen marker and, on a refusal, a
 *   Weathra-chosen reason code. That also keeps the token out of the next page's `Referer`, out of
 *   the browser's history, and out of any screenshot of the address bar.
 * - **Nothing is logged.** Not the token, not the code, not the session, not the provider's error.
 *
 * The screens themselves are elsewhere and stay there: success lands on the Verify Email screen's
 * own success state (task 20.5), a refusal lands on that screen's own link-refused state, and the
 * recovery link lands on Reset Password (task 20.8). This route renders nothing.
 */

import { type NextRequest, NextResponse } from "next/server";

import { isExpiredOrUnknownCode } from "@/components/auth/failures";
import {
  LINK_REFUSAL_PARAMETERS,
  callbackLinkType,
  isConfirmedUser,
  isRecoveryLink,
  readLinkRefusal,
  type CallbackLinkType,
  type LinkRefusal,
} from "@/lib/auth/verification";
import {
  COMPLETED_PARAMETER,
  COMPLETED_RECOVERY,
  COMPLETED_VERIFICATION,
  DESTINATION_PARAMETER,
  RESET_PASSWORD_PATH,
  VERIFY_EMAIL_PATH,
  safeDestination,
} from "@/lib/routes";
import { supabaseServerClient } from "@/lib/supabase/server";

/** Where a flow's outcome is shown. Neither screen is built here; both already exist as routes. */
function screenFor(recovery: boolean): string {
  return recovery ? RESET_PASSWORD_PATH : VERIFY_EMAIL_PATH;
}

/**
 * A redirect built on this request's own origin.
 *
 * Cloning `nextUrl` rather than assembling a string is what keeps the destination on this site: the
 * pathname and the query are replaced, and the origin is never taken from anything the link said.
 */
function redirectTo(
  request: NextRequest,
  pathname: string,
  parameters: Record<string, string>,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return NextResponse.redirect(url);
}

/** The success landing: the marker naming the flow, and the destination if one survived validation. */
function completed(
  request: NextRequest,
  recovery: boolean,
  destination: string | null,
): NextResponse {
  return redirectTo(request, screenFor(recovery), {
    [COMPLETED_PARAMETER]: recovery ? COMPLETED_RECOVERY : COMPLETED_VERIFICATION,
    ...(destination ? { [DESTINATION_PARAMETER]: destination } : {}),
  });
}

/**
 * The refusal landing.
 *
 * The reason is one of two Weathra-chosen codes, which the screen reads back into its own wording.
 * The provider's message never travels, so it can never be rendered.
 */
function refused(
  request: NextRequest,
  recovery: boolean,
  refusal: LinkRefusal,
  destination: string | null,
): NextResponse {
  return redirectTo(request, screenFor(recovery), {
    ...LINK_REFUSAL_PARAMETERS[refusal],
    ...(destination ? { [DESTINATION_PARAMETER]: destination } : {}),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;

  const type: CallbackLinkType | null = callbackLinkType(parameters.get("type"));
  const recovery = isRecoveryLink(type);
  const destination = safeDestination(parameters.get(DESTINATION_PARAMETER));

  // The provider refused the link before it ever reached us, and said so in the URL.
  const reported = readLinkRefusal(parameters);
  if (reported) return refused(request, recovery, reported, destination);

  const tokenHash = parameters.get("token_hash");
  const code = parameters.get("code");

  // Malformed or missing: a token hash without a type it is allowed to complete, a type without a
  // token, or neither. Nothing is sent to the provider — there is nothing to send.
  if (!((tokenHash && type) || code)) return refused(request, recovery, "invalid", destination);

  try {
    const client = await supabaseServerClient();

    const { data, error } =
      tokenHash && type
        ? await client.auth.verifyOtp({ token_hash: tokenHash, type })
        : await client.auth.exchangeCodeForSession(code as string);

    if (error) {
      // The provider answers an expired token and a token it has already consumed with the same
      // refusal, so a link followed twice lands here as an expired one. That is the provider's
      // resolution, not a distinction thrown away: both offer the same way forward.
      return refused(
        request,
        recovery,
        isExpiredOrUnknownCode(error) ? "expired" : "invalid",
        destination,
      );
    }

    // Ask Supabase who this is rather than trusting what came back: `getUser()` validates the token
    // with the provider, and it reads the cookies the exchange just wrote — so a session that failed
    // to establish is caught here rather than becoming a success the next request disagrees with.
    const {
      data: { user },
    } = await client.auth.getUser();

    if (!data?.session || !user) return refused(request, recovery, "invalid", destination);

    if (!recovery && !isConfirmedUser(user)) {
      // A session for an address the provider has not confirmed is not a session Weathra keeps.
      await client.auth.signOut();
      return refused(request, recovery, "invalid", destination);
    }

    return completed(request, recovery, destination);
  } catch {
    // A transport failure or a provider that answered with something unexpected. Still not a place
    // to say anything about the account, and still not a place to write the token down.
    return refused(request, recovery, "invalid", destination);
  }
}
