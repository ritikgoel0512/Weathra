/**
 * The pure verification rules — task 20.5.
 *
 * The screen's tests cover what a person sees; these cover the two pieces of logic that would be
 * hard to see there: the split between an incorrect and an expired code, which the provider does
 * not make for us, and the reading of a returning link's parameters, which arrive from outside.
 */

import { describe, expect, it } from "vitest";

import {
  classifyCodeFailure,
  isExpiredOrUnknownCode,
  resendRateLimitedMessage,
  resendWaitSeconds,
} from "@/components/auth/failures";
import {
  LINK_REFUSAL_PARAMETERS,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_LIFETIME_MS,
  callbackLinkType,
  isConfirmedUser,
  isRecoveryLink,
  normalizeVerificationCode,
  readLinkRefusal,
  verificationCodeFormatError,
  verificationLinkType,
} from "@/lib/auth/verification";

describe("normalizing what a person typed", () => {
  it("keeps the digits and drops everything else", () => {
    expect(normalizeVerificationCode("12 34-56")).toBe("123456");
    expect(normalizeVerificationCode("Your code is 123456.")).toBe("123456");
  });

  it("never accepts more than the code's length", () => {
    expect(normalizeVerificationCode("1234567890")).toHaveLength(VERIFICATION_CODE_LENGTH);
  });
});

describe("the code's shape", () => {
  it("states the rule for an empty entry and names the shortfall for a partial one", () => {
    expect(verificationCodeFormatError("")).toMatch(/enter the 6-digit code/i);
    expect(verificationCodeFormatError("123")).toMatch(/6 digits/);
  });

  it("has no complaint about a full code", () => {
    expect(verificationCodeFormatError("123456")).toBeUndefined();
  });
});

describe("reading a refusal about a code", () => {
  const merged = { code: "otp_expired", message: "Token has expired or is invalid", status: 403 };
  const now = 1_757_000_000_000;
  const options = { now, lifetimeMs: VERIFICATION_CODE_LIFETIME_MS };

  it("recognises the provider's merged expired-or-unknown answer", () => {
    expect(isExpiredOrUnknownCode(merged)).toBe(true);
    expect(isExpiredOrUnknownCode({ code: "validation_failed" })).toBe(false);
  });

  it("calls a merged refusal incorrect while the code is still within its lifetime", () => {
    expect(classifyCodeFailure(merged, { ...options, sentAt: now - 60_000 })).toBe("incorrect");
  });

  it("calls the same refusal expired once the code has outlived it", () => {
    expect(
      classifyCodeFailure(merged, {
        ...options,
        sentAt: now - VERIFICATION_CODE_LIFETIME_MS - 1,
      }),
    ).toBe("expired");
  });

  it("reports a rate limit as a rate limit rather than as a judgement about the code", () => {
    expect(
      classifyCodeFailure({ status: 429, message: "rate limited" }, { ...options, sentAt: now }),
    ).toBe("rate_limited");
  });

  it("reports a provider fault as unavailable rather than as a wrong code", () => {
    expect(
      classifyCodeFailure({ status: 503, message: "upstream" }, { ...options, sentAt: now }),
    ).toBe("unavailable");
  });

  it("reports anything else about the code as incorrect", () => {
    expect(
      classifyCodeFailure(
        { status: 422, code: "validation_failed", message: "Invalid token" },
        { ...options, sentAt: now },
      ),
    ).toBe("incorrect");
  });
});

describe("what a rate-limited resend must state", () => {
  it("takes only the number of seconds out of the provider's message", () => {
    expect(
      resendWaitSeconds({
        message: "For security purposes, you can only request this after 55 seconds.",
      }),
    ).toBe(55);
  });

  it("has no number when the provider gave none", () => {
    expect(resendWaitSeconds({ message: "Request rate limit reached" })).toBeNull();
    expect(resendWaitSeconds({})).toBeNull();
  });

  it("states the wait in Weathra's words, singular and plural", () => {
    expect(resendRateLimitedMessage(55)).toBe("Too many requests. You can ask for a new code in 55 seconds.");
    expect(resendRateLimitedMessage(1)).toContain("1 second.");
    expect(resendRateLimitedMessage(null)).toMatch(/wait a moment/i);
  });
});

describe("a returning link's parameters", () => {
  it("completes only the types this screen is for", () => {
    expect(verificationLinkType("signup")).toBe("signup");
    expect(verificationLinkType("email")).toBe("email");
    // A link may not talk this screen into completing a password recovery or an address change.
    expect(verificationLinkType("recovery")).toBeNull();
    expect(verificationLinkType("email_change")).toBeNull();
    expect(verificationLinkType(undefined)).toBeNull();
  });

  it("reads an expired link, an otherwise-refused link, and a clean URL", () => {
    expect(readLinkRefusal(new URLSearchParams("error=access_denied&error_code=otp_expired"))).toBe(
      "expired",
    );
    expect(readLinkRefusal(new URLSearchParams("error=server_error"))).toBe("invalid");
    expect(readLinkRefusal(new URLSearchParams("email=sam%40example.test"))).toBeNull();
  });
});

describe("the returning-link handler's own allow-list", () => {
  it("completes email confirmation and password recovery, and nothing else", () => {
    expect(callbackLinkType("signup")).toBe("signup");
    expect(callbackLinkType("email")).toBe("email");
    expect(callbackLinkType("recovery")).toBe("recovery");
    for (const rejected of ["email_change", "invite", "magiclink", "../signup", "", undefined]) {
      expect(callbackLinkType(rejected), String(rejected)).toBeNull();
    }
  });

  it("tells the recovery link apart from an email confirmation", () => {
    expect(isRecoveryLink("recovery")).toBe(true);
    expect(isRecoveryLink("signup")).toBe(false);
    expect(isRecoveryLink(null)).toBe(false);
  });

  it("is narrower than the screen's, which completes no recovery at all", () => {
    // The screen types a code for its own address; recovery belongs to the handler and to Reset
    // Password, never to the verification form.
    expect(verificationLinkType("recovery")).toBeNull();
  });

  it("hands the screen back Weathra's own refusal codes, never the provider's", () => {
    expect(readLinkRefusal(new URLSearchParams(LINK_REFUSAL_PARAMETERS.expired))).toBe("expired");
    expect(readLinkRefusal(new URLSearchParams(LINK_REFUSAL_PARAMETERS.invalid))).toBe("invalid");
  });
});

describe("what counts as a confirmed address", () => {
  it("reads it from Supabase's user and from nowhere else", () => {
    expect(isConfirmedUser({ email_confirmed_at: "2026-09-04T00:00:00.000Z" })).toBe(true);
    expect(isConfirmedUser({ confirmed_at: "2026-09-04T00:00:00.000Z" })).toBe(true);
    expect(isConfirmedUser({ email_confirmed_at: null, confirmed_at: null })).toBe(false);
    expect(isConfirmedUser(null)).toBe(false);
    expect(isConfirmedUser(undefined)).toBe(false);
  });
});
