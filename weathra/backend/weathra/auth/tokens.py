"""Token validation: the only place an identity is established.

Every check ``specs/authentication`` names happens here — signature against the project's published
keys, issuer, audience, and expiry with a small clock-skew leeway — and the result is a
``Principal`` or a coded failure. Nothing else in Weathra turns a credential into an identity, and
no header, query parameter, or body field is ever consulted.

Failures are deliberately distinguishable by code: an expired session is a different thing from a
malformed credential, and a systemic rejection (a key rotation the cache missed, a clock drift)
should be diagnosable from the logs. Those logs record the *reason* and never the token — see
``auth/redaction.py``.
"""

from __future__ import annotations

import jwt

from weathra.auth.jwks import JwksCache
from weathra.config import Settings
from weathra.domain.errors import (
    EmailNotVerified,
    TokenAudienceInvalid,
    TokenExpired,
    TokenIssuerInvalid,
    TokenMalformed,
    TokenSignatureInvalid,
)
from weathra.domain.identity import Principal

__all__ = ["ACCEPTED_ALGORITHMS", "TokenValidator"]

# Asymmetric only. A shared-secret algorithm would mean Weathra held signing material, and the
# `none` algorithm would mean it held none at all — both are refused by not being listed.
ACCEPTED_ALGORITHMS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512")


class TokenValidator:
    """Validates a Supabase access token and produces the acting ``Principal``."""

    def __init__(self, *, settings: Settings, jwks: JwksCache) -> None:
        self._issuer = settings.jwt_issuer
        self._audience = settings.supabase_jwt_audience
        self._leeway = settings.supabase_jwt_leeway_seconds
        self._jwks = jwks

    async def validate(self, token: str) -> Principal:
        """Validate a bearer token and return its subject as a ``Principal``.

        Raises a subclass of ``AuthenticationFailed``; never returns a partially trusted result.
        """
        if not token or not token.strip():
            raise TokenMalformed("The bearer credential is empty.")

        key_id = self._key_id(token)
        # A missing or rotated-away key id raises TokenUnknownKey from the cache, and a fetch
        # failure raises SigningKeysUnavailable — a dependency problem, not a bad credential.
        key = await self._jwks.key_for(key_id)

        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=list(ACCEPTED_ALGORITHMS),
                issuer=self._issuer,
                audience=self._audience,
                leeway=self._leeway,
                options={
                    "require": ["exp", "sub", "aud", "iss"],
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_aud": True,
                    "verify_iss": True,
                },
            )
        except jwt.ExpiredSignatureError as exc:
            raise TokenExpired("The access token has expired. Sign in again to continue.") from exc
        except jwt.InvalidIssuerError as exc:
            raise TokenIssuerInvalid("The access token was issued by another project.") from exc
        except jwt.InvalidAudienceError as exc:
            raise TokenAudienceInvalid("The access token was issued for another audience.") from exc
        except jwt.InvalidSignatureError as exc:
            raise TokenSignatureInvalid("The access token's signature did not verify.") from exc
        except jwt.MissingRequiredClaimError as exc:
            raise TokenMalformed(
                f"The access token is missing its {exc.claim!r} claim.",
                details={"claim": exc.claim},
            ) from exc
        except jwt.PyJWTError as exc:
            # Everything left — a mangled payload, an unsupported algorithm, a bad `nbf` — is a
            # malformed credential rather than an expired session.
            raise TokenMalformed("The access token could not be read.") from exc

        principal = Principal.from_claims(claims)

        # Defence in depth. With email confirmation required on the project, an unverified account
        # has no access token at all, so this should be unreachable — it is rejected anyway.
        if not principal.email_verified:
            raise EmailNotVerified(
                "This account's email address has not been confirmed yet.",
            )

        return principal

    @staticmethod
    def _key_id(token: str) -> str:
        """The key id from the token's header, read without trusting anything in it."""
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise TokenMalformed("The bearer credential is not a well-formed token.") from exc

        key_id = header.get("kid")
        if not isinstance(key_id, str) or not key_id:
            raise TokenMalformed("The access token's header names no signing key.")

        algorithm = header.get("alg")
        if algorithm not in ACCEPTED_ALGORITHMS:
            # Caught here as well as by `decode`, so an `alg: none` or `HS256` token is refused
            # before the key set is even consulted.
            raise TokenMalformed(
                "The access token is signed with an algorithm Weathra does not accept.",
                details={"algorithm": algorithm if isinstance(algorithm, str) else None},
            )
        return key_id
