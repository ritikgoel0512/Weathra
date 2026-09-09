"""The FastAPI dependencies that produce the acting identity.

Two variants, and the difference is the whole point:

* ``require_principal`` — protected routes. No valid token, no request.
* ``optional_principal`` — public routes that *apply* preferences when a caller happens to be
  signed in, without requiring one. A public weather endpoint reads no user-owned record beyond
  the caller's own preferences, and serves an anonymous caller the documented defaults.

Identity comes from the validated token and nothing else. A ``X-Weathra-Profile-Id`` header, a
``user_id`` query parameter, a ``user`` field in a body — all of them are, at best, untrusted
parameters, and none is consulted here. That is not an accident of implementation: the previous
design had an opaque profile id alongside tokens and it was removed entirely, because two identity
paths mean two authorization paths and a standing risk that a handler reads the wrong one
(design.md decision 4).

An authentication failure is logged with its reason and never with the credential.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, Request

from weathra.auth.rls import session_for
from weathra.auth.roles import is_administrative
from weathra.auth.tokens import TokenValidator
from weathra.domain.errors import (
    AuthenticationFailed,
    AuthorizationFailed,
    SigningKeysUnavailable,
    TokenMalformed,
    TokenMissing,
)
from weathra.domain.identity import Principal

__all__ = [
    "IDENTITY_ASSERTING_HEADERS",
    "AdministrativePrincipal",
    "IsAdministrative",
    "OptionalPrincipal",
    "RequiredPrincipal",
    "acting_role",
    "bearer_token",
    "get_token_validator",
    "optional_principal",
    "require_principal",
]

logger = logging.getLogger("weathra.auth")

# Headers a client might use to assert an identity. Listed so the "ignored as identity" rule can be
# asserted by a test against a real list rather than one example.
IDENTITY_ASSERTING_HEADERS = (
    "X-Weathra-Profile-Id",
    "X-Weathra-User-Id",
    "X-User-Id",
    "X-Profile-Id",
    "X-Thread-Id",
    "X-Session-Id",
)

_BEARER_PREFIX = "bearer "


def get_token_validator(request: Request) -> TokenValidator:
    """The process-wide validator, held by the application lifespan."""
    validator = getattr(request.app.state, "token_validator", None)
    if not isinstance(validator, TokenValidator):
        raise SigningKeysUnavailable(
            "Token validation is not configured on this application instance."
        )
    return validator


def bearer_token(request: Request) -> str | None:
    """The credential from the ``Authorization`` header, or ``None`` when there is none.

    Only the ``Bearer`` scheme is accepted. Another scheme is a malformed credential rather than an
    absent one, so a client using Basic auth gets a reason instead of a bare 401.
    """
    header = request.headers.get("Authorization")
    if not header:
        return None

    value = header.strip()
    if not value.lower().startswith(_BEARER_PREFIX):
        raise TokenMalformed(
            "The Authorization header must use the Bearer scheme with a Supabase access token."
        )
    return value[len(_BEARER_PREFIX) :].strip() or None


async def require_principal(
    request: Request,
    validator: Annotated[TokenValidator, Depends(get_token_validator)],
) -> Principal:
    """The acting user for a protected route."""
    token = bearer_token(request)
    if token is None:
        raise TokenMissing(
            "This endpoint requires a signed-in user. Present a Supabase access token as a "
            "Bearer token in the Authorization header."
        )

    try:
        principal = await validator.validate(token)
    except AuthenticationFailed as failure:
        # The reason, never the token. `redaction.RedactingFilter` is the backstop; this is the
        # design — nothing here has the credential to log.
        logger.info(
            "authentication failed: %s (%s) on %s",
            failure.code,
            failure.message,
            request.url.path,
        )
        raise

    return principal


async def optional_principal(
    request: Request,
    validator: Annotated[TokenValidator, Depends(get_token_validator)],
) -> Principal | None:
    """The acting user for a public route, when there is one.

    A *present but invalid* credential still fails. Treating a bad token as anonymous would let an
    expired session silently fall back to the defaults, and a person would see wrong units rather
    than being told to sign in again.
    """
    token = bearer_token(request)
    if token is None:
        return None

    try:
        return await validator.validate(token)
    except AuthenticationFailed as failure:
        logger.info(
            "authentication failed on a public route: %s (%s) on %s",
            failure.code,
            failure.message,
            request.url.path,
        )
        raise


async def acting_role(
    request: Request,
    principal: Annotated[Principal | None, Depends(optional_principal)],
) -> bool:
    """Whether the acting principal holds the administrative role, resolved once per request.

    Read from ``admin_roles`` on the request-scoped session, which is safe and scoped: the owner
    policy means the query can only see the acting subject's own row (`0011`). No claim, no
    header, no body field contributes — `specs/authentication` requires an asserted role to be
    *ignored*, and the only thing this reads from the token is the subject it was validated for.

    A boolean rather than a principal, so it can be depended on by routes that are not themselves
    administrative — the quota gate and the model resolver both need the answer, and both need it
    to be the *same* answer as the one an administrative route would get.
    """
    engines = getattr(request.app.state, "engines", None)
    if principal is None or engines is None:
        return False
    async with session_for(engines, principal) as session:
        return await is_administrative(session, principal)


async def require_administrator(
    principal: Annotated[Principal, Depends(require_principal)],
    administrative: Annotated[bool, Depends(acting_role)],
) -> Principal:
    """The acting user for an administrative route, or a refusal.

    Two dependencies deep on purpose: an unauthenticated caller is refused by
    ``require_principal`` as 401 before this is reached, and an authenticated one without the role
    is refused here as 403. A caller cannot tell the two apart by accident, and neither refusal
    says anything about what the endpoint would have returned.

    The message names no capability. `specs/authentication` requires the refusal to disclose
    nothing about the endpoint's contents, and "you may not administer the model catalog" would be
    a sentence about the model catalog.
    """
    if not administrative:
        logger.info("administrative access refused for %s", principal)
        raise AuthorizationFailed("This operation requires an administrative principal.")
    return principal


RequiredPrincipal = Annotated[Principal, Depends(require_principal)]
OptionalPrincipal = Annotated[Principal | None, Depends(optional_principal)]
IsAdministrative = Annotated[bool, Depends(acting_role)]
AdministrativePrincipal = Annotated[Principal, Depends(require_administrator)]
