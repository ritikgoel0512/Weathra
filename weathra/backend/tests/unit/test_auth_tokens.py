"""Task 4.2 — token validation, every case, with no network access.

The key pair is minted locally and its public half is what the JWKS cache serves, so every
assertion here is about Weathra's own logic rather than about Supabase being reachable. The
in-memory transport raises on any request other than the key-set URL, so an accidental outbound
call fails the test.
"""

from __future__ import annotations

import time

import httpx
import pytest

from tests.auth_support import USER_A, USER_B, TokenFactory, settings_for, validator_for
from weathra.auth.jwks import JwksCache
from weathra.auth.tokens import ACCEPTED_ALGORITHMS, TokenValidator
from weathra.domain.errors import (
    AuthenticationFailed,
    EmailNotVerified,
    SigningKeysUnavailable,
    TokenAudienceInvalid,
    TokenExpired,
    TokenIssuerInvalid,
    TokenMalformed,
    TokenSignatureInvalid,
    TokenUnknownKey,
)


@pytest.fixture
def validator(token_factory: TokenFactory) -> TokenValidator:
    return validator_for(token_factory)


# --------------------------------------------------------------------------- the valid case


async def test_a_valid_token_yields_its_subject(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    principal = await validator.validate(token_factory.valid())
    assert principal.user_id == USER_A
    assert principal.email == f"{USER_A[:8]}@example.test"
    assert principal.email_verified is True


async def test_the_acting_identity_equals_the_tokens_subject(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    for subject in (USER_A, USER_B):
        principal = await validator.validate(token_factory.valid(subject=subject))
        assert principal.user_id == subject


async def test_a_validated_principal_carries_no_token_material(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    token = token_factory.valid()
    principal = await validator.validate(token)
    assert token not in principal.model_dump_json()
    assert token not in repr(principal)


async def test_a_token_within_the_skew_leeway_is_accepted(token_factory: TokenFactory) -> None:
    """A small clock drift must not reject a whole fleet of valid users."""
    settings = settings_for(token_factory, supabase_jwt_leeway_seconds=30)
    validator = validator_for(token_factory, settings=settings)
    now = int(time.time())
    just_expired = token_factory.valid(issued_at=now - 70, expires_in=60)  # expired 10s ago
    principal = await validator.validate(just_expired)
    assert principal.user_id == USER_A


# --------------------------------------------------------------------------- rejections


async def test_an_expired_token_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenExpired) as caught:
        await validator.validate(token_factory.expired())
    assert caught.value.code == "token_expired"


async def test_a_wrong_issuer_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenIssuerInvalid):
        await validator.validate(token_factory.wrong_issuer())


async def test_a_wrong_audience_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenAudienceInvalid):
        await validator.validate(token_factory.wrong_audience())


async def test_a_bad_signature_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    """Signed by a key nobody published, while naming a key id that is published."""
    with pytest.raises(TokenSignatureInvalid):
        await validator.validate(token_factory.bad_signature())


async def test_an_unknown_key_id_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenUnknownKey):
        await validator.validate(token_factory.unknown_key_id())


@pytest.mark.parametrize(
    "credential",
    ["", "   ", "not-a-token", "a.b", "eyJhbGciOiJSUzI1NiJ9", "....", "eyJhbGciOiJSUzI1NiJ9.x.y"],
    ids=["empty", "blank", "plain-text", "two-segments", "one-segment", "dots", "garbage-payload"],
)
async def test_a_malformed_credential_is_rejected(
    validator: TokenValidator, credential: str
) -> None:
    with pytest.raises(TokenMalformed):
        await validator.validate(credential)


async def test_a_truncated_token_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenMalformed):
        await validator.validate(token_factory.truncated())


async def test_an_unverified_email_claim_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    """Defence in depth: with confirmation required, such a token should not exist at all."""
    with pytest.raises(EmailNotVerified) as caught:
        await validator.validate(token_factory.unverified_email())
    assert caught.value.code == "email_not_verified"


async def test_a_token_with_no_subject_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenMalformed) as caught:
        await validator.validate(token_factory.no_subject())
    assert caught.value.details.get("claim") == "sub"


async def test_a_token_with_no_expiry_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    """A token that never expires is not a session."""
    with pytest.raises(TokenMalformed) as caught:
        await validator.validate(token_factory.no_expiry())
    assert caught.value.details.get("claim") == "exp"


async def test_a_token_with_no_key_id_is_rejected(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    with pytest.raises(TokenMalformed, match="names no signing key"):
        await validator.validate(token_factory.no_key_id())


async def test_an_unsigned_token_is_rejected_before_the_key_set_is_consulted(
    token_factory: TokenFactory,
) -> None:
    """`alg: none` is the classic. It must not even reach the key lookup."""
    fetches: list[str] = []
    settings = settings_for(token_factory)

    def handler(request: httpx.Request) -> httpx.Response:
        fetches.append(str(request.url))
        return httpx.Response(200, json=token_factory.jwks_document())

    validator = TokenValidator(
        settings=settings,
        jwks=JwksCache(
            jwks_url=settings.jwks_url,
            ttl_seconds=600,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        ),
    )

    with pytest.raises(TokenMalformed, match="algorithm"):
        await validator.validate(token_factory.unsigned())
    assert fetches == [], "an unsigned token reached the key set"


async def test_a_shared_secret_algorithm_is_not_accepted() -> None:
    """HS256 would mean Weathra held signing material. It is refused by not being listed."""
    assert "HS256" not in ACCEPTED_ALGORITHMS
    assert "none" not in ACCEPTED_ALGORITHMS
    assert all(alg.startswith(("RS", "ES")) for alg in ACCEPTED_ALGORITHMS)


# --------------------------------------------------------------------------- distinguishability


async def test_every_rejection_carries_a_distinct_code(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    """specs/http-api: an expired token's code is distinguishable from a malformed one's."""
    cases = {
        "expired": token_factory.expired(),
        "issuer": token_factory.wrong_issuer(),
        "audience": token_factory.wrong_audience(),
        "signature": token_factory.bad_signature(),
        "unknown-key": token_factory.unknown_key_id(),
        "malformed": token_factory.malformed(),
        "unverified": token_factory.unverified_email(),
    }

    codes: dict[str, str] = {}
    for label, credential in cases.items():
        with pytest.raises(AuthenticationFailed) as caught:
            await validator.validate(credential)
        codes[label] = caught.value.code

    assert len(set(codes.values())) == len(codes), codes


async def test_no_rejection_message_or_detail_carries_the_token(
    validator: TokenValidator, token_factory: TokenFactory
) -> None:
    """specs/authentication: the failure is recorded without logging the token."""
    for credential in (
        token_factory.expired(),
        token_factory.wrong_issuer(),
        token_factory.bad_signature(),
        token_factory.unknown_key_id(),
        token_factory.unverified_email(),
    ):
        with pytest.raises(AuthenticationFailed) as caught:
            await validator.validate(credential)
        rendered = caught.value.message + str(caught.value.details)
        assert credential not in rendered
        # Not even a fragment: the payload segment is the part that carries claims.
        assert credential.split(".")[1] not in rendered


async def test_a_key_set_outage_is_not_reported_as_a_bad_token(
    token_factory: TokenFactory,
) -> None:
    """The credential may be perfectly good; the fault is ours, and the code says so."""
    settings = settings_for(token_factory)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    validator = TokenValidator(
        settings=settings,
        jwks=JwksCache(
            jwks_url=settings.jwks_url,
            ttl_seconds=600,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        ),
    )

    with pytest.raises(SigningKeysUnavailable) as caught:
        await validator.validate(token_factory.valid())
    assert not isinstance(caught.value, AuthenticationFailed)


# --------------------------------------------------------------------------- no network


async def test_validation_makes_no_call_beyond_the_key_set(
    token_factory: TokenFactory,
) -> None:
    fetches: list[str] = []
    from tests.auth_support import seeded_cache

    settings = settings_for(token_factory)
    validator = TokenValidator(
        settings=settings,
        jwks=seeded_cache(token_factory, settings=settings, fetch_recorder=fetches),
    )

    for _ in range(5):
        await validator.validate(token_factory.valid())

    assert fetches == [settings.jwks_url], (
        "validation called something other than the key set, or called it per request"
    )
